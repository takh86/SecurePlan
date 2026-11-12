/**
 * SP-21 S7 real-browser acceptance (B-01..B-26 of docs/reviews/sp21-s6-closeout.md §7.2).
 *
 * Real Chrome (Playwright, channel "chrome") -> Vite dev frontend -> NestJS backend -> receipt-verified disposable
 * PostgreSQL 17. Identities and prerequisite rows are written by SQL on the verified target only; planning,
 * publication, cancellations and offers use real HTTP as the real synthetic accounts. Every business decision under
 * test is made through the real UI unless the case explicitly sends a request "via devtools" (page-context fetch in
 * the signed-in browser page).
 *
 * Controlled fixtures (documented per case in the report): one offer set to WITHDRAWN (terminal offer, C3T), one
 * SICK availability day (ineligible offer, C3), a session expiry (B-17) and a role downgrade (B-18), all on the
 * verified disposable target only.
 *
 * Evidence contains statuses, codes, counts, versions and booleans only. Idempotency keys, cookies, CSRF tokens,
 * passwords and receipt bodies are compared inside this process and never written out.
 *
 * Requires: DATABASE_URL + SECUREPLAN_TEST_TARGET_RECEIPT (scripts/disposable-test-target.mjs),
 * SECUREPLAN_PLAYWRIGHT_MODULE (Playwright index module), SECUREPLAN_BROWSER_OUTPUT_DIR, SECUREPLAN_ORIGIN,
 * a built backend (apps/backend/dist) running against that target, and the frontend dev server on that origin.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import pg from 'pg';
import { verifyRecordedTestTarget } from './disposable-test-target.mjs';

const verified = await verifyRecordedTestTarget();
const origin = process.env.SECUREPLAN_ORIGIN ?? 'https://localhost:8443';
const output = resolve(process.env.SECUREPLAN_BROWSER_OUTPUT_DIR);
await mkdir(output, { recursive: true });
const { chromium } = await import(pathToFileURL(resolve(process.env.SECUREPLAN_PLAYWRIGHT_MODULE)).href);
const { hashPassword } = await import(pathToFileURL(fileURLToPath(new URL('../apps/backend/dist/auth/password-hasher.js', import.meta.url))).href);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const password = randomBytes(24).toString('base64url');
const uid = () => randomUUID();
const runTag = randomBytes(3).toString('hex');
const email = (label) => `${label}-${runTag}@example.invalid`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// UX-01 (#136) regression: a long project name in the work-queue project filter at 320 px.
const LONG_PROJECT = 'S7 Synthetischer Sicherheitsdienst Flughafen und Veranstaltungsschutz Nordwest Erweiterung';
const ids = Object.fromEntries(['companyA', 'companyB', 'adminA1', 'adminA2', 'adminA3', 'accE1', 'accE2', 'accE3', 'accE4', 'adminB1', 'accB1', 'e1', 'e2', 'e3', 'e4', 'eB1', 'projA', 'projB', 'projLong'].map((k) => [k, uid()]));

const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const DECISION_URL = '**/api/v1/cancellation-requests/*/decision';

const git = (args) => execFileSync('git', args, { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' }).trim();
const report = {
  startedAt: new Date().toISOString(),
  source: { commit: git(['rev-parse', 'HEAD']), trackedTreeClean: git(['status', '--porcelain', '--untracked-files=no']) === '' },
  target: { runId: verified.runId, cluster: verified.cluster, containerIdPrefix: verified.containerId.slice(0, 12) },
  origin, browser: null, http: [], cases: {}, results: [], console: { pageErrors: 0, byCategory: {} }, storage: [],
};
const log = (...args) => console.log(...args);

// ---------------------------------------------------------------- HTTP as real accounts (setup and API-level checks)
let browser, anonCtx;
async function actorFor(label, accountId) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const r = await ctx.request.post(`${origin}/api/v1/auth/login`, { headers: { Origin: origin, 'Content-Type': 'application/json' }, data: { email: email(label), password } });
  assert.equal(r.status(), 200, `login ${label}`);
  return { label, accountId, ctx, csrf: r.headers()['x-csrf-token'] };
}
async function api(actor, method, path, { body = null, headers = {}, stage = '' } = {}) {
  const h = { Origin: origin, ...headers };
  if (actor?.csrf && method !== 'GET') h['X-CSRF-Token'] = actor.csrf;
  if (body !== null) h['Content-Type'] = 'application/json';
  const r = await (actor ? actor.ctx : anonCtx).request.fetch(`${origin}/api/v1${path}`, { method, headers: h, data: body ?? undefined, failOnStatusCode: false });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  report.http.push({ stage, actor: actor?.label ?? 'anonymous', method, path: path.replace(/[0-9a-f-]{36}/g, ':id'), status: r.status(), code: json?.code ?? null });
  return { status: r.status(), body: json, headers: r.headers() };
}
const expectStatus = (res, status, what) => { assert.equal(res.status, status, `${what}: expected ${status}, got ${res.status} ${res.body?.code ?? ''}`); return res; };

/** Same request as "via devtools": a fetch inside the signed-in browser page (its cookie, the browser's Origin). */
async function pageFetch(page, method, path, { body, headers = {} } = {}) {
  return page.evaluate(async ({ method, path, body, headers }) => {
    const me = await fetch('/api/v1/me', { credentials: 'same-origin' });
    const csrf = me.headers.get('X-CSRF-Token');
    const h = { ...headers, 'X-CSRF-Token': csrf ?? '' };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const init = { method, credentials: 'same-origin', headers: h };
    if (body !== undefined) init.body = JSON.stringify(body);
    const r = await fetch(path, init);
    let code = null;
    try { code = (await r.json()).code ?? null; } catch { /* empty */ }
    return { status: r.status, code, meStatus: me.status };
  }, { method, path, body, headers });
}

// ---------------------------------------------------------------- PostgreSQL (read-only snapshots)
const AUDIT_DECISION = "('CANCELLATION_REJECTED','CANCELLATION_APPROVED')";
async function snap(needId) {
  const { rows: [row] } = await pool.query(`
    SELECT r.status AS request, (r.decided_at IS NOT NULL) AS decided, n.status AS need, n.concurrency_version::int AS need_v,
      (n.selected_offer_id IS NOT NULL) AS selected_offer, (n.resolved_at IS NOT NULL) AS resolved,
      d.concurrency_version::int AS duty_v, (d.removed_at IS NULL) AS duty_present, p.status AS plan, a.state AS membership,
      (SELECT count(*)::int FROM plan_assignments x WHERE x.duty_id = d.id AND x.replacement_offer_id IS NOT NULL) AS replacement_memberships,
      (SELECT count(*)::int FROM plan_assignments x WHERE x.duty_id = d.id AND x.state = 'ACTIVE') AS active_members,
      COALESCE((SELECT json_object_agg(status, c ORDER BY status) FROM (SELECT o.status, count(*)::int AS c FROM replacement_offers o WHERE o.need_id = n.id GROUP BY o.status) s), '{}'::json) AS offers,
      (SELECT count(*)::int FROM audit_event e WHERE e.resource_id::text = r.id::text AND e.action IN ${AUDIT_DECISION}) AS decision_events,
      (SELECT count(*)::int FROM audit_event e WHERE e.correlation_id IN (SELECT correlation_id FROM audit_event WHERE resource_id::text = r.id::text AND action IN ${AUDIT_DECISION})) AS decision_audits,
      (SELECT count(*)::int FROM audit_event e WHERE e.resource_id::text = r.id::text AND e.action = 'REPLACEMENT_OFFER_SELECTED') AS selection_events
    FROM replacement_needs n JOIN cancellation_requests r ON r.id = n.cancellation_request_id
    JOIN duties d ON d.id = n.duty_id JOIN monthly_plans p ON p.id = d.monthly_plan_id
    JOIN plan_assignments a ON a.id = r.assignment_id WHERE n.id = $1`, [needId]);
  return row;
}
/** Company-wide decision counters: idempotency rows for the decision operation by state, decision audit rows. */
async function counters(companyId = ids.companyA) {
  const { rows: idem } = await pool.query("SELECT state, count(*)::int AS c FROM idempotency_records WHERE company_id = $1 AND operation = 'DECIDE_CANCELLATION' GROUP BY state ORDER BY state", [companyId]);
  const { rows: [aud] } = await pool.query(`SELECT count(*)::int AS decisions, (SELECT count(*)::int FROM audit_event WHERE company_id = $1) AS all_audits FROM audit_event WHERE company_id = $1 AND action IN ${AUDIT_DECISION}`, [companyId]);
  return { idempotency: Object.fromEntries(idem.map((r) => [r.state, r.c])), decisionAudits: aud.decisions, allAudits: aud.all_audits };
}
const idemTotal = (c) => Object.values(c.idempotency).reduce((a, b) => a + b, 0);
function record(id, key, value) { (report.cases[id] ??= {})[key] = value; }

// ---------------------------------------------------------------- seed (synthetic identities and fixtures)
async function seed() {
  const hash = await hashPassword(password);
  for (const [id, name] of [[ids.companyA, 'S7 Synthetic Tenant A'], [ids.companyB, 'S7 Synthetic Tenant B']])
    await pool.query("INSERT INTO companies(id,name,status,time_zone) VALUES($1,$2,'ACTIVE','Europe/Berlin')", [id, name]);
  const accounts = [
    [ids.adminA1, ids.companyA, 'admin-a1', 'COMPANY_ADMIN'], [ids.adminA2, ids.companyA, 'admin-a2', 'COMPANY_ADMIN'],
    [ids.adminA3, ids.companyA, 'admin-a3-session', 'COMPANY_ADMIN'],
    [ids.accE1, ids.companyA, 'emp-a1', 'EMPLOYEE'], [ids.accE2, ids.companyA, 'emp-a2', 'EMPLOYEE'],
    [ids.accE3, ids.companyA, 'emp-a3', 'EMPLOYEE'], [ids.accE4, ids.companyA, 'emp-a4', 'EMPLOYEE'],
    [ids.adminB1, ids.companyB, 'admin-b1', 'COMPANY_ADMIN'], [ids.accB1, ids.companyB, 'emp-b1', 'EMPLOYEE'],
  ];
  for (const [id, company, label, role] of accounts)
    await pool.query("INSERT INTO accounts(id,company_id,email,account_scope,role,status,password_hash) VALUES($1,$2,$3,'TENANT',$4,'ACTIVE',$5)", [id, company, email(label), role, hash]);
  const employees = [[ids.e1, ids.companyA, ids.accE1, 'S7-A1', 'Alpha'], [ids.e2, ids.companyA, ids.accE2, 'S7-A2', 'Bravo'], [ids.e3, ids.companyA, ids.accE3, 'S7-A3', 'Charlie'], [ids.e4, ids.companyA, ids.accE4, 'S7-A4', 'Delta'], [ids.eB1, ids.companyB, ids.accB1, 'S7-B1', 'Foxtrot']];
  for (const [id, company, account, number, last] of employees)
    await pool.query("INSERT INTO employees(id,company_id,account_id,employee_number,first_name,last_name,shift_eligibility,employment_start) VALUES($1,$2,$3,$4,'Synthetic',$5,'BOTH','2020-01-01')", [id, company, account, number, last]);
  for (const [id, company, name] of [[ids.projA, ids.companyA, 'S7 Objekt A'], [ids.projB, ids.companyB, 'S7 Objekt B'], [ids.projLong, ids.companyA, LONG_PROJECT]]) {
    await pool.query("INSERT INTO projects(id,company_id,name,status) VALUES($1,$2,$3,'ACTIVE')", [id, company, name]);
    for (const [kind, start, end] of [['TAG', '06:00', '18:00'], ['NACHT', '18:00', '06:00']])
      await pool.query("INSERT INTO shift_configurations(company_id,project_id,effective_from_month,shift_kind,start_local,end_local) VALUES($1,$2,'2026-12-01',$3,$4,$5)", [company, id, kind, start, end]);
  }
  for (const [company, employee, project] of [[ids.companyA, ids.e1, ids.projA], [ids.companyA, ids.e2, ids.projA], [ids.companyA, ids.e3, ids.projA], [ids.companyA, ids.e4, ids.projA], [ids.companyB, ids.eB1, ids.projB]])
    await pool.query("INSERT INTO project_assignments(company_id,employee_id,project_id,planning_month) VALUES($1,$2,$3,'2026-12-01')", [company, employee, project]);
}
async function calendar(admin, project) {
  const path = `/projects/${project}/operating-calendar`;
  const v = expectStatus(await api(admin, 'GET', `${path}?effectiveForMonth=2026-12-01`, { stage: 'setup' }), 200, 'calendar GET').body;
  expectStatus(await api(admin, 'PATCH', path, { body: { effectiveFromMonth: '2026-12-01', expectedExactVersion: v.exactVersion, expectedEffective: v.effective ? { id: v.effective.id, version: v.effective.version } : null, expectedNextEffectiveFromMonth: v.nextEffectiveFromMonth, operatingWeekdays: [1, 2, 3, 4, 5, 6, 7], bootstrap: false }, stage: 'setup' }), 200, 'calendar PATCH');
}
const route = (plan, person) => `/monthly-plans/${plan}/employee-months/${person}`;
async function saveDuties(admin, plan, person, dayNumbers) {
  const want = new Set(dayNumbers.map((d) => d - 1));
  const current = expectStatus(await api(admin, 'GET', route(plan, person), { stage: 'setup' }), 200, 'employee-month GET').body;
  const days = current.days.map((d, i) => ({ date: d.date, expected: { day: d.day ? { id: d.day.dutyId, version: d.day.version } : null, night: d.night ? { id: d.night.dutyId, version: d.night.version } : null }, desired: want.has(i) ? { state: 'DAY', role: 'EMPLOYEE' } : { state: 'OFF' } }));
  expectStatus(await api(admin, 'POST', `${route(plan, person)}/save`, { body: { expectedPlan: { status: current.plan.status, publishedAt: current.plan.publishedAt }, expectedCreationContext: current.creationContextFingerprint, expectedCalendar: current.operatingCalendar.effective ? { id: current.operatingCalendar.effective.id, version: current.operatingCalendar.effective.version } : null, days }, headers: { 'Idempotency-Key': uid() }, stage: 'setup' }), 200, 'employee-month save');
}

// ---------------------------------------------------------------- browser helpers
const results = [];
let currentShotPage = null;
async function check(id, description, work) {
  const started = Date.now();
  try {
    await work();
    results.push({ id, description, result: 'PASS', ms: Date.now() - started });
    log(`PASS ${id} ${description}`);
  } catch (error) {
    const detail = String(error?.message ?? error).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id').slice(0, 600);
    results.push({ id, description, result: 'FAIL', detail, ms: Date.now() - started });
    log(`FAIL ${id} ${description}: ${detail}`);
    if (currentShotPage) await currentShotPage.screenshot({ path: resolve(output, `${id}-failure.png`), fullPage: true }).catch(() => {});
  }
}
function categorize(text) {
  const m = /status of (\d{3})/.exec(text);
  if (m) return `http-${m[1]}`;
  if (/net::ERR_[A-Z_]+/.test(text)) return /net::ERR_[A-Z_]+/.exec(text)[0];
  return 'other';
}
const pages = [];
async function newSession(label, { mobile = false } = {}) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'de-DE', timezoneId: 'Europe/Berlin', ...(mobile ? MOBILE : { viewport: DESKTOP }) });
  const page = await ctx.newPage();
  watch(page, label);
  await uiLogin(page, label);
  return { ctx, page };
}
function watch(page, label) {
  pages.push({ page, label });
  page.on('pageerror', () => { report.console.pageErrors += 1; });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const cat = categorize(msg.text());
    report.console.byCategory[cat] = (report.console.byCategory[cat] ?? 0) + 1;
    if (cat === 'other') (report.console.other ??= []).push(msg.text().replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id').slice(0, 160));
  });
  const decisions = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/api\/v1\/cancellation-requests\/[^/]+\/decision$/.test(new URL(req.url()).pathname)) {
      const h = req.headers();
      decisions.push({ at: Date.now(), path: new URL(req.url()).pathname, key: h['idempotency-key'] ?? null, version: h['expected-version'] ?? null, body: req.postData() });
    }
  });
  page.__decisions = decisions;
  return page;
}
async function uiLogin(page, label) {
  await page.goto(`${origin}/`);
  await page.getByRole('heading', { name: 'Anmelden', exact: true }).waitFor({ timeout: 20000 });
  await page.getByLabel('E-Mail-Adresse').fill(email(label));
  await page.getByLabel('Passwort', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
  await page.getByRole('navigation', { name: 'Hauptnavigation', includeHidden: true }).waitFor({ state: 'attached', timeout: 20000 });
}
async function uiLogout(page) {
  const button = page.getByRole('button', { name: 'Abmelden', exact: true });
  if (!(await button.isVisible())) await page.getByRole('button', { name: /Menü/ }).click();
  await button.click();
  await page.getByRole('heading', { name: 'Anmelden', exact: true }).waitFor({ timeout: 20000 });
}
async function openCase(page, needId) {
  await page.goto(`${origin}/arbeitsuebersicht/${needId}`);
  await page.getByRole('heading', { name: 'Vorgangsstatus' }).waitFor({ timeout: 20000 });
}
const panel = (page) => page.getByRole('region', { name: 'Absage ohne Ersatz entscheiden' });
const opener = (page, kind) => panel(page).getByRole('button', { name: kind === 'reject' ? 'Ablehnen' : 'Ohne Ersatz genehmigen', exact: true });
const confirmGroup = (page, kind) => page.getByRole('group', { name: kind === 'reject' ? 'Absage ablehnen?' : 'Absage ohne Ersatz genehmigen?' });
const confirmButton = (page, kind) => confirmGroup(page, kind).getByRole('button', { name: kind === 'reject' ? 'Ablehnung bestätigen' : 'Genehmigung ohne Ersatz bestätigen', exact: true });
const retryButton = (page) => panel(page).getByRole('button', { name: 'Erneut bestätigen', exact: true });
const DONE = { reject: 'Absage abgelehnt.', approve: 'Absage ohne Ersatz genehmigt.' };
const UNCERTAIN = 'Das Ergebnis ist nicht bestätigt.';
async function facts(page) {
  return page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.work-queue__facts > div, .work-queue__counts > div')].map((div) => [div.querySelector('dt')?.textContent.trim(), div.querySelector('dd')?.textContent.trim()])));
}
async function offerStatuses(page) {
  const table = page.getByRole('table', { name: 'Eingereichte Ersatzangebote' });
  if (!(await table.count())) return [];
  return table.locator('tbody td[data-label="Angebotsstatus"]').allInnerTexts();
}
async function shot(page, name) { await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true }); }
async function noHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}
/** Waits until the decision outcome message for `kind` is visible, then until the case reload has settled. */
async function waitDone(page, kind) {
  await panel(page).getByRole('status').filter({ hasText: DONE[kind] }).waitFor({ timeout: 20000 });
  await page.getByRole('heading', { name: 'Vorgangsstatus' }).waitFor();
}
/** Holds the decision response: forwards to the real backend at once, delivers the answer to the page later. */
async function delayDecisions(page, ms) {
  await page.route(DECISION_URL, async (r) => {
    const response = await r.fetch();
    await sleep(ms);
    await r.fulfill({ response }).catch(() => {});
  });
}
/** Expected success result for a decision (closeout §3.3). */
function assertDecided(state, kind, k, { terminal = 0 } = {}) {
  if (kind === 'reject') {
    assert.equal(state.request, 'REJECTED'); assert.equal(state.need, 'CLOSED'); assert.equal(state.membership, 'ACTIVE');
    assert.equal(state.decision_audits, 2 + k, `success audits 2+k=${2 + k}, got ${state.decision_audits}`);
  } else {
    assert.equal(state.request, 'APPROVED'); assert.equal(state.need, 'OPEN_UNFILLED'); assert.notEqual(state.membership, 'ACTIVE');
    assert.equal(state.plan, 'PUBLISHED'); assert.equal(state.duty_present, true); assert.equal(state.selected_offer, false); assert.equal(state.resolved, false);
    assert.equal(state.decision_audits, 4 + k, `success audits 4+k=${4 + k}, got ${state.decision_audits}`);
  }
  assert.equal(state.replacement_memberships, 0, 'no replacement membership');
  assert.equal(state.offers.OPEN ?? 0, 0, 'no OPEN offers left');
  assert.equal(state.offers.NOT_SELECTED ?? 0, k, `k=${k} offers NOT_SELECTED`);
  assert.equal(state.decision_events, 1, 'exactly one decision');
  if (terminal) assert.equal((state.offers.WITHDRAWN ?? 0) + (state.offers.INVALIDATED ?? 0), terminal, 'terminal offers untouched');
}
function assertUnchanged(before, after, what) {
  assert.deepEqual(after, before, `${what}: state changed`);
}

// ================================================================= main
browser = await chromium.launch({ channel: process.env.SECUREPLAN_BROWSER_CHANNEL ?? 'chrome', headless: true });
report.browser = { name: 'Google Chrome (Playwright channel chrome, headless)', version: browser.version(), playwright: process.env.SECUREPLAN_PLAYWRIGHT_VERSION ?? null };
anonCtx = await browser.newContext({ ignoreHTTPSErrors: true });
let fatal = null;
const C = {};
let admin, mobile;
try {
  await seed();
  const a = { a1: await actorFor('admin-a1', ids.adminA1), b1: await actorFor('admin-b1', ids.adminB1) };
  const emp = { e1: await actorFor('emp-a1', ids.accE1), e2: await actorFor('emp-a2', ids.accE2), e3: await actorFor('emp-a3', ids.accE3), e4: await actorFor('emp-a4', ids.accE4), b1: await actorFor('emp-b1', ids.accB1) };

  // ---- planning: tenant A, E1 on Dec 1..26 (one case per day), tenant B, E-B1 on Dec 3. Published.
  await calendar(a.a1, ids.projA);
  await calendar(a.b1, ids.projB);
  const planA = expectStatus(await api(a.a1, 'POST', '/monthly-plans', { body: { projectId: ids.projA, monthStart: '2026-12-01' }, stage: 'setup' }), 201, 'plan A').body.id;
  const planB = expectStatus(await api(a.b1, 'POST', '/monthly-plans', { body: { projectId: ids.projB, monthStart: '2026-12-01' }, stage: 'setup' }), 201, 'plan B').body.id;
  await saveDuties(a.a1, planA, ids.e1, Array.from({ length: 26 }, (_, i) => i + 1));
  await saveDuties(a.b1, planB, ids.eB1, [3]);
  for (const [actor, plan] of [[a.a1, planA], [a.b1, planB]])
    expectStatus(await api(actor, 'POST', `/monthly-plans/${plan}/publish`, { headers: { 'Idempotency-Key': uid() }, stage: 'setup' }), 200, 'publish');

  const ownDuties = async (actor) => expectStatus(await api(actor, 'GET', '/me/monthly-plans?monthStart=2026-12-01', { stage: 'setup' }), 200, 'own duties').body.items[0].duties.sort((x, y) => x.dutyDate.localeCompare(y.dutyDate));
  const cancel = (actor, duty, stage = 'setup') => api(actor, 'POST', '/cancellation-requests', { body: { assignmentId: duty.assignmentId }, headers: { 'Expected-Version': String(duty.version), 'Idempotency-Key': uid() }, stage });
  const e1Duties = await ownDuties(emp.e1);
  assert.equal(e1Duties.length, 26, 'E1 has 26 duties');
  // Day -> case label. Each destructive scenario has its own case.
  const plan = { 1: 'C0', 2: 'C1', 3: 'C3', 4: 'C3T', 5: 'K09', 6: 'R10a', 7: 'R10b', 8: 'D11a', 9: 'D11b', 10: 'S12', 11: 'S13', 12: 'T14', 13: 'V15', 14: 'X17', 15: 'X18', 16: 'F19', 17: 'F20', 18: 'F21', 19: 'F22a', 20: 'F22b', 21: 'F23a', 22: 'F23b', 23: 'SPARE', 24: 'X17b', 25: 'B03', 26: 'L24' };
  for (const duty of e1Duties) {
    const day = Number(duty.dutyDate.slice(8, 10));
    const r = expectStatus(await cancel(emp.e1, duty), 201, `E1 cancellation day ${day}`);
    C[plan[day]] = { request: r.body.id, need: r.body.replacementNeed.id, day, assignmentId: duty.assignmentId };
  }
  const bDuty = (await ownDuties(emp.b1))[0];
  const rB = expectStatus(await cancel(emp.b1, bDuty), 201, 'tenant B cancellation').body;
  C.B = { request: rB.id, need: rB.replacementNeed.id };

  // ---- offers by the real candidates (real HTTP)
  const offer = async (actor, label) => expectStatus(await api(actor, 'POST', `/replacement-needs/${C[label].need}/offers`, { headers: { 'Idempotency-Key': uid() }, stage: 'setup' }), 201, `${actor.label} offer ${label}`);
  const offers = { C1: [emp.e2], C3: [emp.e2, emp.e3, emp.e4], C3T: [emp.e2, emp.e3, emp.e4], K09: [emp.e2], R10a: [emp.e3], D11a: [emp.e2], D11b: [emp.e3], S12: [emp.e2, emp.e3], S13: [emp.e2], T14: [emp.e2], F20: [emp.e3], F22a: [emp.e2], L24: [emp.e2, emp.e3] };
  for (const [label, actors] of Object.entries(offers)) for (const actor of actors) await offer(actor, label);
  // Controlled fixtures: E4 becomes unavailable (SICK) on C3's day -> its offer is currently ineligible;
  // E4's offer on C3T is WITHDRAWN -> a terminal offer that a decision must leave untouched.
  await pool.query("INSERT INTO employee_availability_days(company_id,employee_id,day,status) VALUES($1,$2,'2026-12-03','SICK')", [ids.companyA, ids.e4]);
  await pool.query("WITH t AS (SELECT clock_timestamp() AS now) UPDATE replacement_offers SET status='WITHDRAWN', decided_at=t.now, updated_at=t.now FROM t WHERE need_id=$1 AND employee_id=$2", [C.C3T.need, ids.e4]);
  report.seeded = { companies: 2, accounts: 9, employees: 5, casesTenantA: Object.keys(C).length - 1, casesTenantB: 1, offerFixtures: ['C3: E4 SICK on duty day (ineligible)', 'C3T: E4 offer WITHDRAWN (terminal)'] };
  const c3Offers = await pool.query('SELECT status FROM replacement_offers WHERE need_id=$1', [C.C3.need]);
  assert.equal(c3Offers.rowCount, 3);

  const startCounters = await counters();
  report.baseline = { tenantA: startCounters, tenantB: await counters(ids.companyB) };

  admin = await newSession('admin-a1');
  const page = admin.page;
  currentShotPage = page;

  // ================= S7-1 functional
  await check('B-01', 'COMPANY_ADMIN opens /arbeitsuebersicht then C1: decision panel with both buttons and SP-20 offers', async () => {
    const before = await snap(C.C1.need);
    await page.goto(`${origin}/arbeitsuebersicht?sortBy=dutyDate&sortOrder=asc`);
    await page.getByRole('heading', { level: 1, name: 'Arbeitsübersicht' }).waitFor({ timeout: 20000 });
    await shot(page, 'B-01-queue-desktop');
    await page.locator(`a[href="/arbeitsuebersicht/${C.C1.need}"]`).click();
    await page.getByRole('heading', { name: 'Vorgangsstatus' }).waitFor();
    await panel(page).waitFor();
    await opener(page, 'reject').waitFor(); await opener(page, 'approve').waitFor();
    assert.equal(await opener(page, 'reject').isEnabled(), true);
    assert.equal(await opener(page, 'approve').isEnabled(), true);
    await page.getByRole('region', { name: 'Ersatz auswählen' }).getByRole('button', { name: 'Ersatz auswählen' }).waitFor();
    assert.equal((await offerStatuses(page)).length, 1);
    record('B-01', 'ui', { rejectButton: true, approveButton: true, sp20OfferButton: true, offersListed: 1 });
    await shot(page, 'B-01-case-C1-desktop');
    assertUnchanged(before, await snap(C.C1.need), 'B-01');
  });

  await check('B-02', 'EMPLOYEE: no work queue or decision UI by navigation or URL; no decision request', async () => {
    const e = await newSession('emp-a1');
    await e.page.goto(`${origin}/arbeitsuebersicht`);
    await e.page.getByRole('heading', { name: 'Kein Zugriff auf diese Ansicht' }).waitFor({ timeout: 20000 });
    assert.equal(await e.page.getByRole('table').count(), 0);
    await e.page.goto(`${origin}/arbeitsuebersicht/${C.C1.need}`);
    await e.page.getByRole('heading', { name: 'Kein Zugriff auf diese Ansicht' }).waitFor({ timeout: 20000 });
    assert.equal(await e.page.getByRole('button', { name: /Ablehnen|Ohne Ersatz genehmigen/ }).count(), 0);
    assert.equal(e.page.__decisions.length, 0);
    const nav = await e.page.getByRole('navigation', { name: 'Hauptnavigation' }).innerText().catch(() => '');
    record('B-02', 'ui', { queueRoute: 'Kein Zugriff', caseRoute: 'Kein Zugriff', decisionRequests: 0, navHasArbeitsuebersicht: nav.includes('Arbeitsübersicht') });
    await shot(e.page, 'B-02-employee-forbidden');
    report.__emp = e;
  });

  await check('B-03', 'EMPLOYEE sends the decision POST from the signed-in browser page with valid CSRF: 403 ACTION_FORBIDDEN', async () => {
    const e = report.__emp;
    const before = await snap(C.B03.need); const cBefore = await counters();
    const r1 = await pageFetch(e.page, 'POST', `/api/v1/cancellation-requests/${C.B03.request}/decision`, { body: { decision: 'REJECT' }, headers: { 'Idempotency-Key': uid() } });
    const r2 = await pageFetch(e.page, 'POST', `/api/v1/cancellation-requests/${C.B03.request}/decision`, { body: { decision: 'APPROVE', expectedDutyVersion: before.duty_v }, headers: { 'Idempotency-Key': uid(), 'Expected-Version': String(before.need_v) } });
    record('B-03', 'http', [{ decision: 'REJECT', status: r1.status, code: r1.code }, { decision: 'APPROVE', status: r2.status, code: r2.code }]);
    assert.equal(r1.meStatus, 200);
    assert.equal(r1.status, 403); assert.equal(r1.code, 'ACTION_FORBIDDEN');
    assert.equal(r2.status, 403); assert.equal(r2.code, 'ACTION_FORBIDDEN');
    assertUnchanged(before, await snap(C.B03.need), 'B-03');
    const cAfter = await counters();
    assert.equal(cAfter.decisionAudits, cBefore.decisionAudits);
    record('B-03', 'pg', { unchanged: true, idempotencyRowsDelta: idemTotal(cAfter) - idemTotal(cBefore) });
    await report.__emp.ctx.close(); delete report.__emp;
  });

  await check('B-04', 'REJECT confirm on C3 (2 eligible + 1 ineligible offer): copy, success, case reloads decided, no actions', async () => {
    await openCase(page, C.C3.need);
    const statusesBefore = await offerStatuses(page);
    assert.equal(statusesBefore.length, 3);
    await opener(page, 'reject').click();
    const group = confirmGroup(page, 'reject');
    const copy = await group.innerText();
    for (const fragment of ['Die ursprüngliche Zuordnung bleibt aktiv', 'Der Ersatzbedarf wird geschlossen', 'Offene Angebote, die auf „Nicht ausgewählt“ gesetzt werden: 3', '(davon aktuell geeignet: 2)'])
      assert.ok(copy.includes(fragment), `copy contains "${fragment}"`);
    await shot(page, 'B-04-reject-confirm-desktop');
    await confirmButton(page, 'reject').click();
    await waitDone(page, 'reject');
    await page.getByRole('note').filter({ hasText: 'nicht mehr offen' }).waitFor();
    assert.equal(await page.getByRole('button', { name: /^(Ablehnen|Ohne Ersatz genehmigen|Ersatz auswählen)$/ }).count(), 0, 'no actions left');
    const f = await facts(page);
    const after = await snap(C.C3.need);
    assertDecided(after, 'reject', 3);
    assert.equal(after.need_v, 2, 'need version +1');
    assert.equal(page.__decisions.length, 1);
    const shown = await offerStatuses(page);
    assert.deepEqual(shown, ['Nicht ausgewählt', 'Nicht ausgewählt', 'Nicht ausgewählt']);
    assert.equal(f['Absage'], 'Abgelehnt'); assert.equal(f['Ersatzbedarf'], 'Geschlossen'); assert.equal(f['Ursprüngliche Zuordnung'], 'Aktiv');
    record('B-04', 'ui', { absage: f['Absage'], ersatzbedarf: f['Ersatzbedarf'], zuordnung: f['Ursprüngliche Zuordnung'], offers: shown });
    record('B-04', 'pg', after);
    await shot(page, 'B-04-reject-done-desktop');
  });

  await check('B-05', 'APPROVE without replacement on C0 (0 offers): success, Unbesetzt, stays in work queue', async () => {
    await openCase(page, C.C0.need);
    const before = await snap(C.C0.need);
    await opener(page, 'approve').click();
    const copy = await confirmGroup(page, 'approve').innerText();
    assert.ok(copy.includes('Die ursprüngliche Zuordnung wird entfernt') && copy.includes('„Unbesetzt“'), 'approve copy');
    assert.ok(copy.includes('gesetzt werden: 0'), 'zero offers in copy');
    await confirmButton(page, 'approve').click();
    await waitDone(page, 'approve');
    const after = await snap(C.C0.need);
    assertDecided(after, 'approve', 0);
    assert.equal(after.need_v, before.need_v + 1); assert.equal(after.duty_v, before.duty_v + 1);
    const f = await facts(page);
    assert.equal(f['Absage'], 'Genehmigt'); assert.equal(f['Ersatzbedarf'], 'Unbesetzt'); assert.equal(f['Ursprüngliche Zuordnung'], 'Nicht mehr aktiv');
    assert.equal(await opener(page, 'approve').count(), 0, 'no decision actions');
    await page.goto(`${origin}/arbeitsuebersicht?sortBy=dutyDate&sortOrder=asc`);
    const row = page.getByRole('row').filter({ has: page.locator(`a[href="/arbeitsuebersicht/${C.C0.need}"]`) });
    await row.waitFor();
    const rowText = await row.innerText();
    assert.ok(rowText.includes('Unbesetzt'), `queue row shows Unbesetzt: ${rowText.replace(/\s+/g, ' ').slice(0, 120)}`);
    record('B-05', 'ui', { absage: f['Absage'], ersatzbedarf: f['Ersatzbedarf'], zuordnung: f['Ursprüngliche Zuordnung'], inQueue: true, queueShowsUnbesetzt: true });
    record('B-05', 'pg', { ...after, needVersionDelta: after.need_v - before.need_v, dutyVersionDelta: after.duty_v - before.duty_v });
    await shot(page, 'B-05-approve-queue-desktop');
  });

  await check('B-06', 'APPROVE without replacement on C1 (1 offer): offer Nicht ausgewählt, no replacement assigned', async () => {
    await openCase(page, C.C1.need);
    const before = await snap(C.C1.need);
    await opener(page, 'approve').click();
    await confirmButton(page, 'approve').click();
    await waitDone(page, 'approve');
    const after = await snap(C.C1.need);
    assertDecided(after, 'approve', 1);
    assert.equal(after.duty_v, before.duty_v + 1);
    assert.deepEqual(await offerStatuses(page), ['Nicht ausgewählt']);
    record('B-06', 'pg', after);
  });

  await check('B-07', 'APPROVE on C3T (2 OPEN + 1 terminal): 2 NOT_SELECTED, terminal row identical, 6 audits', async () => {
    const term = async () => (await pool.query("SELECT status, decided_at, updated_at FROM replacement_offers WHERE need_id=$1 AND status IN ('WITHDRAWN','INVALIDATED')", [C.C3T.need])).rows.map((r) => JSON.stringify(r));
    const termBefore = await term();
    assert.equal(termBefore.length, 1);
    await openCase(page, C.C3T.need);
    await opener(page, 'approve').click();
    assert.ok((await confirmGroup(page, 'approve').innerText()).includes('gesetzt werden: 2'));
    await confirmButton(page, 'approve').click();
    await waitDone(page, 'approve');
    const after = await snap(C.C3T.need);
    assertDecided(after, 'approve', 2, { terminal: 1 });
    assert.deepEqual(await term(), termBefore, 'terminal offer row identical');
    const shown = (await offerStatuses(page)).sort();
    assert.deepEqual(shown, ['Nicht ausgewählt', 'Nicht ausgewählt', 'Zurückgezogen']);
    record('B-07', 'pg', { ...after, terminalRowIdentical: true });
    record('B-07', 'ui', { offers: shown });
  });

  await check('B-08', 'Abbrechen and Escape for both confirmations: nothing sent, focus returns to opener', async () => {
    await openCase(page, C.SPARE.need);
    const before = await snap(C.SPARE.need);
    const out = [];
    for (const kind of ['reject', 'approve']) {
      for (const how of ['Abbrechen', 'Escape']) {
        await opener(page, kind).click();
        await confirmGroup(page, kind).waitFor();
        if (how === 'Abbrechen') await confirmGroup(page, kind).getByRole('button', { name: 'Abbrechen' }).click();
        else await page.keyboard.press('Escape');
        await confirmGroup(page, kind).waitFor({ state: 'detached' });
        const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? null);
        out.push({ kind, how, focusReturnedToOpener: focused === (kind === 'reject' ? 'Ablehnen' : 'Ohne Ersatz genehmigen') });
      }
    }
    record('B-08', 'ui', out);
    assert.ok(out.every((o) => o.focusReturnedToOpener), JSON.stringify(out));
    assert.equal(page.__decisions.filter((d) => d.path.includes(C.SPARE.request)).length, 0, 'no decision POST');
    assertUnchanged(before, await snap(C.SPARE.need), 'B-08');
  });

  await check('B-09', 'Keyboard only: Tab to buttons, Enter opens, focus on heading, Tab order, Escape cancels, Enter confirms; ARIA', async () => {
    await openCase(page, C.K09.need);
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    await page.evaluate(() => document.activeElement?.blur());
    let presses = 0; let label = '';
    while (presses < 120) {
      await page.keyboard.press('Tab'); presses += 1;
      label = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
      if (label === 'Ablehnen') break;
    }
    assert.equal(label, 'Ablehnen', 'reached Ablehnen by Tab');
    const ring = await page.evaluate(() => ({ visible: document.activeElement.matches(':focus-visible'), outline: getComputedStyle(document.activeElement).outlineStyle, width: getComputedStyle(document.activeElement).outlineWidth }));
    assert.equal(ring.visible, true); assert.notEqual(ring.outline, 'none');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Ohne Ersatz genehmigen');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');
    await confirmGroup(page, 'reject').waitFor();
    const headingFocused = await page.evaluate(() => document.activeElement?.tagName === 'H3' && document.activeElement.textContent.trim());
    assert.equal(headingFocused, 'Absage ablehnen?');
    const order = [];
    for (let i = 0; i < 2; i += 1) { await page.keyboard.press('Tab'); order.push(await page.evaluate(() => document.activeElement.textContent.trim())); }
    assert.deepEqual(order, ['Ablehnung bestätigen', 'Abbrechen']);
    await page.keyboard.press('Escape');
    await confirmGroup(page, 'reject').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Ablehnen', 'Escape returns focus');
    const sentBefore = page.__decisions.length;
    await page.keyboard.press('Enter');
    await confirmGroup(page, 'reject').waitFor();
    const aria = await panel(page).ariaSnapshot();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await waitDone(page, 'reject');
    const live = await panel(page).getByRole('status').first().evaluate((el) => ({ role: el.getAttribute('role'), text: el.textContent.trim().slice(0, 40) }));
    assert.equal(page.__decisions.length - sentBefore, 1, 'exactly one POST via keyboard');
    assertDecided(await snap(C.K09.need), 'reject', 1);
    record('B-09', 'ui', { tabPressesToOpener: presses, focusVisible: ring.visible, outline: `${ring.outline} ${ring.width}`, headingFocusedOnOpen: true, tabOrderInConfirm: order, escapeReturnsFocus: true, statusRole: live.role, ariaSnapshotConfirm: aria.split('\n').slice(0, 14) });
  });

  // ---- responsive: B-10 (390x844 emulation) and the same flows were already run at 1280x800 in B-04/B-05.
  mobile = await newSession('admin-a1', { mobile: true });
  await check('B-10', '390x844 emulation: REJECT (R10a) and APPROVE (R10b) without horizontal scroll, reachable buttons, wrapped confirmation', async () => {
    const m = mobile.page;
    currentShotPage = m;
    const out = {};
    for (const [label, kind, k] of [['R10a', 'reject', 1], ['R10b', 'approve', 0]]) {
      await openCase(m, C[label].need);
      const scroll0 = await noHorizontalScroll(m);
      await opener(m, kind).scrollIntoViewIfNeeded();
      const ob = await opener(m, kind).boundingBox();
      await opener(m, kind).tap();
      const g = confirmGroup(m, kind);
      await g.waitFor();
      await g.scrollIntoViewIfNeeded();
      const box = await g.evaluate((el) => ({ overflowX: el.scrollWidth - el.clientWidth, right: el.getBoundingClientRect().right, clipped: [...el.querySelectorAll('p,h3,button')].some((n) => n.scrollWidth > n.clientWidth + 1) }));
      const cb = await confirmButton(m, kind).boundingBox();
      const scroll1 = await noHorizontalScroll(m);
      await shot(m, `B-10-${kind}-confirm-mobile-390`);
      await confirmButton(m, kind).tap();
      await waitDone(m, kind);
      const scroll2 = await noHorizontalScroll(m);
      assertDecided(await snap(C[label].need), kind, k);
      await shot(m, `B-10-${kind}-done-mobile-390`);
      out[kind] = { overflowBefore: scroll0, overflowConfirm: scroll1, overflowDone: scroll2, openerInside: ob.x >= 0 && ob.x + ob.width <= 390, confirmInside: cb.x >= 0 && cb.x + cb.width <= 390, confirmBoxOverflowX: box.overflowX, confirmBoxRight: Math.round(box.right), textClipped: box.clipped, minTargetHeight: Math.round(Math.min(ob.height, cb.height)) };
      assert.ok(scroll0 <= 0 && scroll1 <= 0 && scroll2 <= 0, `horizontal overflow ${scroll0}/${scroll1}/${scroll2}`);
      assert.ok(out[kind].openerInside && out[kind].confirmInside, 'buttons inside viewport');
      assert.ok(box.overflowX <= 0 && box.right <= 390 && !box.clipped, 'confirmation wraps without clipping');
    }
    // Desktop reference at 1280x800 for the same layout properties (B-04/B-05 ran there).
    await openCase(page, C.SPARE.need);
    out.desktopOverflow = await noHorizontalScroll(page);
    assert.ok(out.desktopOverflow <= 0);
    record('B-10', 'layout', out);
    currentShotPage = page;
  });

  // ================= S7-2 security and recovery
  await check('B-11', 'Double submit: double-click (D11a) and Enter twice (D11b) send exactly one POST; pending disables buttons', async () => {
    const out = {};
    await delayDecisions(page, 1500);
    // a) double-click
    await openCase(page, C.D11a.need);
    let n0 = page.__decisions.length;
    await opener(page, 'reject').click();
    await confirmButton(page, 'reject').dblclick();
    await panel(page).getByRole('status').filter({ hasText: 'Ablehnung wird gespeichert' }).waitFor();
    const pendingState = { confirmDisabled: await confirmButton(page, 'reject').isDisabled(), cancelDisabled: await confirmGroup(page, 'reject').getByRole('button', { name: 'Abbrechen' }).isDisabled(), selectDisabled: await page.getByRole('region', { name: 'Ersatz auswählen' }).getByRole('button', { name: 'Ersatz auswählen' }).isDisabled() };
    await waitDone(page, 'reject');
    out.dblclick = { posts: page.__decisions.length - n0, pending: pendingState };
    assertDecided(await snap(C.D11a.need), 'reject', 1);
    // b) Enter twice
    await openCase(page, C.D11b.need);
    n0 = page.__decisions.length;
    await opener(page, 'approve').click();
    await confirmButton(page, 'approve').focus();
    await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
    await waitDone(page, 'approve');
    out.enterTwice = { posts: page.__decisions.length - n0 };
    assertDecided(await snap(C.D11b.need), 'approve', 1);
    await page.unroute(DECISION_URL);
    const receipts = await pool.query("SELECT count(*)::int AS c FROM idempotency_records WHERE company_id=$1 AND operation='DECIDE_CANCELLATION' AND state='COMPLETED' AND result_json->'cancellation'->>'id' = ANY($2)", [ids.companyA, [C.D11a.request, C.D11b.request]]).catch(() => ({ rows: [{ c: null }] }));
    out.completedReceiptsForBoth = receipts.rows[0].c;
    record('B-11', 'result', out);
    assert.equal(out.dblclick.posts, 1, `dblclick POSTs ${out.dblclick.posts}`);
    assert.equal(out.enterTwice.posts, 1, `Enter-twice POSTs ${out.enterTwice.posts}`);
    assert.ok(pendingState.confirmDisabled && pendingState.cancelDisabled && pendingState.selectDisabled, JSON.stringify(pendingState));
  });

  await check('B-12', 'SP-20 vs SP-21 in one case (S12): only one confirmation open; pending decision disables selection; one mutation', async () => {
    await openCase(page, C.S12.need);
    const sel = page.getByRole('region', { name: 'Ersatz auswählen' });
    const out = {};
    await sel.getByRole('button', { name: 'Ersatz auswählen' }).first().click();
    await sel.getByRole('group').first().waitFor();
    await opener(page, 'reject').click();
    out.selectThenReject = { selectionConfirmOpen: await sel.getByRole('group').count(), rejectConfirmOpen: await confirmGroup(page, 'reject').count() };
    await confirmGroup(page, 'reject').getByRole('button', { name: 'Abbrechen' }).click();
    await opener(page, 'approve').click();
    await sel.getByRole('button', { name: 'Ersatz auswählen' }).first().click();
    out.approveThenSelect = { approveConfirmOpen: await confirmGroup(page, 'approve').count(), selectionConfirmOpen: await sel.getByRole('group').count() };
    await sel.getByRole('group').getByRole('button', { name: 'Abbrechen' }).click();
    await delayDecisions(page, 2000);
    const selectRequests = [];
    page.on('request', (r) => { if (r.url().endsWith('/selection')) selectRequests.push(1); });
    await opener(page, 'reject').click();
    await confirmButton(page, 'reject').click();
    await panel(page).getByRole('status').filter({ hasText: 'Ablehnung wird gespeichert' }).waitFor();
    const selectButtons = sel.getByRole('button', { name: 'Ersatz auswählen' });
    const n = await selectButtons.count();
    const disabled = [];
    for (let i = 0; i < n; i += 1) disabled.push(await selectButtons.nth(i).isDisabled());
    out.whilePending = { selectButtons: n, allDisabled: disabled.every(Boolean) };
    await selectButtons.first().click({ force: true, timeout: 2000 }).catch(() => {});
    await waitDone(page, 'reject');
    await page.unroute(DECISION_URL);
    out.selectionRequests = selectRequests.length;
    const after = await snap(C.S12.need);
    out.pg = { request: after.request, need: after.need, selectedOffer: after.selected_offer, decisionEvents: after.decision_events, selectionEvents: after.selection_events };
    record('B-12', 'result', out);
    assert.deepEqual(out.selectThenReject, { selectionConfirmOpen: 0, rejectConfirmOpen: 1 });
    assert.deepEqual(out.approveThenSelect, { approveConfirmOpen: 0, selectionConfirmOpen: 1 });
    assert.ok(n > 0 && out.whilePending.allDisabled, 'selection disabled while pending');
    assert.equal(selectRequests.length, 0, 'no selection request');
    assertDecided(after, 'reject', 2);
  });

  await check('B-13', 'Cross-tab race: tab 1 selects (SP-20) on S13, tab 2 APPROVEs with the earlier read: one winner, loser 409 + reload', async () => {
    const tab2 = watch(await admin.ctx.newPage(), 'admin-a1-tab2');
    await openCase(page, C.S13.need);
    await openCase(tab2, C.S13.need);
    await opener(tab2, 'approve').click();
    await confirmGroup(tab2, 'approve').waitFor();
    const sel = page.getByRole('region', { name: 'Ersatz auswählen' });
    await sel.getByRole('button', { name: 'Ersatz auswählen' }).click();
    const selResp = page.waitForResponse((r) => r.url().endsWith('/selection'));
    await sel.getByRole('button', { name: 'Ersatz bestätigen' }).click();
    const s = await selResp;
    await sel.getByRole('status').filter({ hasText: 'Ersatz ausgewählt' }).waitFor();
    const cMid = await counters();
    const decResp = tab2.waitForResponse((r) => r.url().endsWith('/decision'));
    await confirmButton(tab2, 'approve').click();
    const d = await decResp;
    const dCode = (await d.json().catch(() => ({}))).code ?? null;
    const alert = await panel(tab2).getByRole('alert').innerText();
    await tab2.getByRole('heading', { name: 'Vorgangsstatus' }).waitFor();
    await tab2.getByRole('note').filter({ hasText: 'nicht mehr offen' }).waitFor({ timeout: 10000 });
    const f2 = await facts(tab2);
    const after = await snap(C.S13.need); const cAfter = await counters();
    // SP-20 selection itself writes CANCELLATION_APPROVED (with REPLACEMENT_OFFER_SELECTED etc.), so "no SP-21 write" is
    // proven by the SP-21 operation counters, and "one winner" by exactly one approval event on the request.
    const { rows: [selAudit] } = await pool.query("SELECT count(*) FILTER (WHERE action='REPLACEMENT_OFFER_SELECTED')::int AS selected, count(*) FILTER (WHERE action='CANCELLATION_APPROVED')::int AS approved, count(*) FILTER (WHERE action IN ('REPLACEMENT_NEED_OPEN_UNFILLED','CANCELLATION_REJECTED'))::int AS sp21_only FROM audit_event WHERE correlation_id IN (SELECT correlation_id FROM audit_event WHERE resource_id::text=$1)", [C.S13.request]);
    const sp21 = { idempotencyRowsDelta: idemTotal(cAfter) - idemTotal(cMid), allAuditsDelta: cAfter.allAudits - cMid.allAudits };
    record('B-13', 'result', { selection: s.status(), decision: { status: d.status(), code: dCode }, loserAlert: alert.includes('Die Daten wurden neu geladen.'), loserConfirmClosed: (await confirmGroup(tab2, 'approve').count()) === 0, loserView: { absage: f2['Absage'], ersatzbedarf: f2['Ersatzbedarf'] }, pg: { request: after.request, need: after.need, selectedOffer: after.selected_offer, approvalEventsOnRequest: after.decision_events, selectionAudit: selAudit, replacementMemberships: after.replacement_memberships, sp21AttemptDeltas: sp21 } });
    assert.equal(s.status(), 200);
    assert.equal(d.status(), 409);
    assert.ok(alert.includes('Die Daten wurden neu geladen.'));
    assert.equal(after.need, 'RESOLVED'); assert.equal(after.selected_offer, true); assert.equal(after.replacement_memberships, 1);
    assert.equal(after.decision_events, 1, 'exactly one approval (the SP-20 winner)');
    assert.deepEqual(selAudit, { selected: 1, approved: 1, sp21_only: 0 });
    assert.equal(sp21.allAuditsDelta, 0, 'the refused SP-21 attempt wrote no audit');
    await shot(tab2, 'B-13-loser-tab2');
    await tab2.close();
  });

  const a2 = await newSession('admin-a2');
  await check('B-14', 'Two admins on T14: A1 REJECTs, then A2 confirms its earlier APPROVE: 409, confirmation closes, reload', async () => {
    await openCase(page, C.T14.need);
    await openCase(a2.page, C.T14.need);
    await opener(a2.page, 'approve').click();
    await confirmGroup(a2.page, 'approve').waitFor();
    await opener(page, 'reject').click();
    await confirmButton(page, 'reject').click();
    await waitDone(page, 'reject');
    const decResp = a2.page.waitForResponse((r) => r.url().endsWith('/decision'));
    await confirmButton(a2.page, 'approve').click();
    const d = await decResp;
    const code = (await d.json().catch(() => ({}))).code ?? null;
    const alert = await panel(a2.page).getByRole('alert').innerText();
    await a2.page.getByRole('note').filter({ hasText: 'nicht mehr offen' }).waitFor({ timeout: 10000 });
    const after = await snap(C.T14.need);
    record('B-14', 'result', { a2: { status: d.status(), code }, alertText: alert, confirmClosed: (await confirmGroup(a2.page, 'approve').count()) === 0, pg: { request: after.request, need: after.need, decisionEvents: after.decision_events, membership: after.membership } });
    assert.equal(d.status(), 409);
    assert.ok(['CANCELLATION_ALREADY_RESOLVED', 'PLAN_CONCURRENT_MODIFICATION', 'REPLACEMENT_NEED_NOT_OPEN'].includes(code), code);
    assert.equal((await confirmGroup(a2.page, 'approve').count()), 0);
    assertDecided(after, 'reject', 1);
    await shot(a2.page, 'B-14-a2-409');
  });

  await check('B-15', 'Stale duty version (V15): APPROVE confirmation open, duty changed in planning, confirm: 409, no success, reload', async () => {
    await openCase(page, C.V15.need);
    await opener(page, 'approve').click();
    await confirmGroup(page, 'approve').waitFor();
    const before = await snap(C.V15.need);
    const { rows: [duty] } = await pool.query('SELECT d.id, d.monthly_plan_id FROM duties d JOIN replacement_needs n ON n.duty_id=d.id WHERE n.id=$1', [C.V15.need]);
    const entry = expectStatus(await api(a.a1, 'GET', `/monthly-plans/${duty.monthly_plan_id}/entries/${duty.id}`, { stage: 'B-15' }), 200, 'entry GET');
    const lease = expectStatus(await api(a.a1, 'POST', `/monthly-plans/${duty.monthly_plan_id}/entries/${duty.id}/edit-lease`, { stage: 'B-15' }), 200, 'lease').body.leaseToken;
    const members = (entry.body.assignments ?? []).map((m) => ({ employeeId: m.employeeId, dutyRole: m.dutyRole }));
    const patch = await api(a.a1, 'PATCH', `/monthly-plans/${duty.monthly_plan_id}/entries/${duty.id}`, { body: { assignments: [...members, { employeeId: ids.e4, dutyRole: 'EMPLOYEE' }] }, headers: { 'Expected-Version': String(entry.body.version ?? before.duty_v), 'Edit-Lease-Token': lease }, stage: 'B-15' });
    await api(a.a1, 'DELETE', `/monthly-plans/${duty.monthly_plan_id}/entries/${duty.id}/edit-lease`, { headers: { 'Edit-Lease-Token': lease }, stage: 'B-15' });
    const mid = await snap(C.V15.need);
    const decResp = page.waitForResponse((r) => r.url().endsWith('/decision'));
    await confirmButton(page, 'approve').click();
    const d = await decResp;
    const code = (await d.json().catch(() => ({}))).code ?? null;
    const alert = await panel(page).getByRole('alert').innerText();
    await page.getByRole('heading', { name: 'Vorgangsstatus' }).waitFor();
    const after = await snap(C.V15.need);
    const successShown = await panel(page).getByRole('status').filter({ hasText: DONE.approve }).count();
    const reopened = await opener(page, 'approve').isVisible().catch(() => false);
    record('B-15', 'result', { planningEdit: { status: patch.status, code: patch.body?.code ?? null }, dutyVersion: { captured: before.duty_v, afterEdit: mid.duty_v }, decision: { status: d.status(), code }, alertText: alert, successShown, reloadedWithActions: reopened, pg: { request: after.request, need: after.need, needV: after.need_v, decisionEvents: after.decision_events } });
    assert.equal(patch.status, 200, `planning edit ${patch.status} ${patch.body?.code}`);
    assert.equal(mid.duty_v, before.duty_v + 1, 'duty version bumped by planning');
    assert.equal(d.status(), 409);
    assert.ok(['PLAN_CONCURRENT_MODIFICATION', 'RESOURCE_EDIT_LOCKED'].includes(code), code);
    assert.equal(successShown, 0);
    assert.equal(after.request, 'OPEN'); assert.equal(after.decision_events, 0); assert.equal(after.need_v, before.need_v);
  });

  await check('B-16', 'Tenant isolation: A1 opens tenant B case URL and POSTs to tenant B request: 404, no B data, B unchanged', async () => {
    const bBefore = await snap(C.B.need); const cB = await counters(ids.companyB);
    await page.goto(`${origin}/arbeitsuebersicht/${C.B.need}`);
    await page.getByRole('alert').filter({ hasText: 'Vorgang nicht verfügbar' }).waitFor({ timeout: 20000 });
    const text = await page.locator('body').innerText();
    const leaks = ['Foxtrot', 'S7-B1', 'S7 Objekt B'].filter((t) => text.includes(t));
    const r1 = await pageFetch(page, 'POST', `/api/v1/cancellation-requests/${C.B.request}/decision`, { body: { decision: 'REJECT' }, headers: { 'Idempotency-Key': uid() } });
    const r2 = await pageFetch(page, 'POST', `/api/v1/cancellation-requests/${C.B.request}/decision`, { body: { decision: 'APPROVE', expectedDutyVersion: bBefore.duty_v }, headers: { 'Idempotency-Key': uid(), 'Expected-Version': String(bBefore.need_v) } });
    const read = await pageFetch(page, 'GET', `/api/v1/replacement-needs/${C.B.need}/offers`);
    record('B-16', 'result', { uiAlert: 'Vorgang nicht verfügbar', leakedTexts: leaks, reject: r1, approve: r2, offersRead: read, tenantBUnchanged: true });
    assert.equal(leaks.length, 0);
    for (const r of [r1, r2, read]) { assert.equal(r.status, 404); assert.equal(r.code, 'RESOURCE_NOT_FOUND'); }
    assertUnchanged(bBefore, await snap(C.B.need), 'tenant B');
    assert.deepEqual(await counters(ids.companyB), cB);
    await shot(page, 'B-16-foreign-case');
  });

  await check('B-17', 'Session expiry (X17, dedicated admin): confirm after expiry -> 401 -> central sign-out, no loop, no success', async () => {
    const s = await newSession('admin-a3-session');
    await openCase(s.page, C.X17.need);
    await opener(s.page, 'reject').click();
    await confirmGroup(s.page, 'reject').waitFor();
    const before = await snap(C.X17.need);
    // Fixture-only on the verified target: absolute expiry in the past (satisfies absolute_expires_at > created_at).
    await pool.query("UPDATE sessions SET absolute_expires_at = created_at + interval '1 millisecond' WHERE account_id=$1 AND revoked_at IS NULL", [ids.adminA3]);
    const apiCalls = [];
    s.page.on('response', (r) => { if (r.url().includes('/api/v1/')) apiCalls.push(`${r.request().method()} ${new URL(r.url()).pathname.replace(/[0-9a-f-]{36}/g, ':id')} ${r.status()}`); });
    await confirmButton(s.page, 'reject').click();
    await s.page.getByRole('heading', { name: 'Anmelden', exact: true }).waitFor({ timeout: 20000 });
    await sleep(2000);
    const after = await snap(C.X17.need);
    record('B-17', 'expiry', { apiCalls, landedOnLogin: true, successShown: false });
    assert.ok(apiCalls.some((c) => c.startsWith('POST /api/v1/cancellation-requests/:id/decision 401')), apiCalls.join(', '));
    assert.ok(apiCalls.length <= 4, `no request loop (${apiCalls.length})`);
    assertUnchanged(before, after, 'B-17');
    await shot(s.page, 'B-17-login-after-401');
    await s.ctx.close();
    // Variant: sign-out in a second tab of the same browser session while the confirmation is open (X17b).
    const v = await newSession('admin-a3-session');
    await openCase(v.page, C.X17b.need);
    await opener(v.page, 'approve').click();
    await confirmGroup(v.page, 'approve').waitFor();
    const other = watch(await v.ctx.newPage(), 'admin-a3-tab2');
    await other.goto(`${origin}/arbeitsuebersicht`);
    await other.getByRole('heading', { name: 'Arbeitsübersicht' }).waitFor({ timeout: 20000 });
    await uiLogout(other);
    const before2 = await snap(C.X17b.need);
    const decisionsBefore = v.page.__decisions.length;
    // Tab 1 may already have been signed out by the cross-tab session broadcast; if the button is still there, press it.
    await sleep(1000);
    const stillOpen = await confirmButton(v.page, 'approve').isVisible().catch(() => false);
    if (stillOpen) await confirmButton(v.page, 'approve').click();
    await v.page.getByRole('heading', { name: 'Anmelden', exact: true }).waitFor({ timeout: 20000 });
    await sleep(1500);
    record('B-17', 'secondTabSignOut', { confirmationStillVisibleAfterOtherTabSignOut: stillOpen, decisionPostsSent: v.page.__decisions.length - decisionsBefore, landedOnLogin: true });
    assertUnchanged(before2, await snap(C.X17b.need), 'B-17 variant');
    await v.ctx.close();
  });

  await check('B-18', 'Role downgrade of ADMIN-A2 by scoped fixture SQL with confirmation open (X18): 403, fail closed, no loop, zero writes', async () => {
    await openCase(a2.page, C.X18.need);
    await opener(a2.page, 'reject').click();
    await confirmGroup(a2.page, 'reject').waitFor();
    const before = await snap(C.X18.need); const cBefore = await counters();
    const fixture = await pool.query("UPDATE accounts SET role='EMPLOYEE' WHERE id=$1 AND company_id=$2 AND role='COMPANY_ADMIN'", [ids.adminA2, ids.companyA]);
    assert.equal(fixture.rowCount, 1, 'exactly one fixture account downgraded');
    const calls = [];
    a2.page.on('request', (r) => { if (r.url().includes('/api/v1/')) calls.push(`${r.method()} ${new URL(r.url()).pathname.replace(/[0-9a-f-]{36}/g, ':id')}`); });
    const decResp = a2.page.waitForResponse((r) => r.url().endsWith('/decision'));
    await confirmButton(a2.page, 'reject').click();
    const d = await decResp;
    const code = (await d.json().catch(() => ({}))).code ?? null;
    const alert = await panel(a2.page).getByRole('alert').innerText();
    await sleep(2500);
    const after = await snap(C.X18.need); const cAfter = await counters();
    record('B-18', 'result', { fixture: 'UPDATE accounts SET role=EMPLOYEE (1 row, disposable target)', decision: { status: d.status(), code }, alertText: alert, requestsAfterConfirm: calls, successShown: await panel(a2.page).getByRole('status').filter({ hasText: DONE.reject }).count(), pg: { unchanged: JSON.stringify(before) === JSON.stringify(after), decisionAuditsDelta: cAfter.decisionAudits - cBefore.decisionAudits, allAuditsDelta: cAfter.allAudits - cBefore.allAudits } });
    await pool.query("UPDATE accounts SET role='COMPANY_ADMIN' WHERE id=$1 AND company_id=$2", [ids.adminA2, ids.companyA]);
    assert.equal(d.status(), 403); assert.equal(code, 'ACTION_FORBIDDEN');
    assert.ok(alert.includes('Für diese Aktion fehlt die Berechtigung.'));
    assert.equal(calls.length, 1, `no refetch loop: ${calls.join(', ')}`);
    assertUnchanged(before, after, 'B-18');
    assert.equal(cAfter.decisionAudits, cBefore.decisionAudits);
    await shot(a2.page, 'B-18-forbidden');
  });

  await check('B-19', 'Offline before delivery (F19): uncertain state, only Erneut bestätigen; 0 rows; then same-key retry succeeds once', async () => {
    await openCase(page, C.F19.need);
    await opener(page, 'reject').click();
    await confirmGroup(page, 'reject').waitFor();
    const before = await snap(C.F19.need); const cBefore = await counters();
    const n0 = page.__decisions.length;
    await admin.ctx.setOffline(true);
    await confirmButton(page, 'reject').click();
    await panel(page).getByRole('alert').filter({ hasText: UNCERTAIN }).waitFor({ timeout: 15000 });
    const ui = { retryVisible: await retryButton(page).isVisible(), confirmVisible: await confirmButton(page, 'reject').count(), cancelDisabled: await confirmGroup(page, 'reject').getByRole('button', { name: 'Abbrechen' }).isDisabled(), selectButtons: await page.getByRole('region', { name: 'Ersatz auswählen' }).getByRole('button', { name: 'Ersatz auswählen' }).count() };
    await shot(page, 'B-19-uncertain-offline');
    const mid = await snap(C.F19.need); const cMid = await counters();
    await admin.ctx.setOffline(false);
    await retryButton(page).click();
    await waitDone(page, 'reject');
    const [first, second] = page.__decisions.slice(n0);
    const after = await snap(C.F19.need); const cAfter = await counters();
    record('B-19', 'result', { ui, browserAttempts: page.__decisions.length - n0, sameKey: first?.key === second?.key, sameBody: first?.body === second?.body, beforeRetry: { unchanged: JSON.stringify(before) === JSON.stringify(mid), idempotencyRowsDelta: idemTotal(cMid) - idemTotal(cBefore), decisionAuditsDelta: cMid.decisionAudits - cBefore.decisionAudits }, afterRetry: { request: after.request, decisionEvents: after.decision_events, idempotencyRowsDelta: idemTotal(cAfter) - idemTotal(cBefore) } });
    assert.ok(ui.retryVisible && ui.confirmVisible === 0 && ui.cancelDisabled, JSON.stringify(ui));
    assertUnchanged(before, mid, 'B-19 before retry');
    assert.equal(idemTotal(cMid), idemTotal(cBefore), 'no idempotency row for the undelivered key');
    assert.equal(first.key, second.key);
    assertDecided(after, 'reject', 0);
  });

  await check('B-20', 'Lost response after commit (F20): uncertain; DB shows one decision; same-key retry -> 200 Idempotency-Replayed, no new rows', async () => {
    await openCase(page, C.F20.need);
    await opener(page, 'approve').click();
    await confirmGroup(page, 'approve').waitFor();
    const before = await snap(C.F20.need);
    const n0 = page.__decisions.length;
    const proxy = { forwarded: 0, upstreamStatus: null };
    await page.route(DECISION_URL, async (r) => {
      const response = await r.fetch();
      proxy.forwarded += 1; proxy.upstreamStatus = response.status();
      await r.abort('connectionreset');
    });
    await confirmButton(page, 'approve').click();
    await panel(page).getByRole('alert').filter({ hasText: UNCERTAIN }).waitFor({ timeout: 15000 });
    await page.unroute(DECISION_URL);
    const mid = await snap(C.F20.need); const cMid = await counters();
    await shot(page, 'B-20-uncertain-after-commit');
    const replayResp = page.waitForResponse((r) => r.url().endsWith('/decision'));
    await retryButton(page).click();
    const rr = await replayResp;
    await waitDone(page, 'approve');
    const [first, second] = page.__decisions.slice(n0);
    const after = await snap(C.F20.need); const cAfter = await counters();
    record('B-20', 'result', { proxy, retry: { status: rr.status(), replayed: rr.headers()['idempotency-replayed'] ?? null }, sameKey: first.key === second.key, sameBody: first.body === second.body, sameNeedVersion: first.version === second.version, beforeRetry: { request: mid.request, decisionEvents: mid.decision_events, decisionAudits: mid.decision_audits, completedReceipts: cMid.idempotency.COMPLETED ?? 0 }, afterRetry: { unchangedSinceCommit: JSON.stringify(mid) === JSON.stringify(after), completedReceipts: cAfter.idempotency.COMPLETED ?? 0, allAuditsDelta: cAfter.allAudits - cMid.allAudits } });
    assert.equal(proxy.forwarded, 1); assert.equal(proxy.upstreamStatus, 200);
    assertDecided(mid, 'approve', 1);
    assert.equal(before.request, 'OPEN');
    assert.equal(rr.status(), 200); assert.equal(rr.headers()['idempotency-replayed'], 'true');
    assert.ok(first.key === second.key && first.body === second.body && first.version === second.version);
    assertUnchanged(mid, after, 'replay wrote nothing');
    assert.equal(cAfter.allAudits, cMid.allAudits); assert.deepEqual(cAfter.idempotency, cMid.idempotency);
  });

  await check('B-21', 'Synthetic 5xx without forwarding (F21): uncertain, 0 writes; same-key retry decides exactly once (UI handling only)', async () => {
    await openCase(page, C.F21.need);
    await opener(page, 'reject').click();
    const before = await snap(C.F21.need); const cBefore = await counters();
    const n0 = page.__decisions.length;
    let synthesized = 0;
    await page.route(DECISION_URL, async (r) => {
      synthesized += 1;
      await r.fulfill({ status: 503, contentType: 'application/problem+json', body: JSON.stringify({ type: 'about:blank', title: 'Service Unavailable', status: 503, code: 'SERVICE_UNAVAILABLE', correlationId: 'synthetic-s7' }) });
    });
    await confirmButton(page, 'reject').click();
    await panel(page).getByRole('alert').filter({ hasText: UNCERTAIN }).waitFor({ timeout: 15000 });
    await page.unroute(DECISION_URL);
    const mid = await snap(C.F21.need); const cMid = await counters();
    const resp = page.waitForResponse((r) => r.url().endsWith('/decision'));
    await retryButton(page).click();
    const rr = await resp;
    await waitDone(page, 'reject');
    const [first, second] = page.__decisions.slice(n0);
    const after = await snap(C.F21.need);
    record('B-21', 'result', { synthesizedResponses: synthesized, beforeRetry: { unchanged: JSON.stringify(before) === JSON.stringify(mid), idempotencyRowsDelta: idemTotal(cMid) - idemTotal(cBefore) }, retry: { status: rr.status(), replayed: rr.headers()['idempotency-replayed'] ?? null }, sameKey: first.key === second.key, sameBody: first.body === second.body, after: { request: after.request, decisionEvents: after.decision_events } });
    assertUnchanged(before, mid, 'B-21 before retry');
    assert.equal(idemTotal(cMid), idemTotal(cBefore));
    assert.equal(rr.status(), 200); assert.notEqual(rr.headers()['idempotency-replayed'], 'true');
    assert.equal(first.key, second.key);
    assertDecided(after, 'reject', 0);
  });

  await check('B-22', 'Reload with uncertain intent: (a) committed -> decided state, stale request 409; (b) undelivered -> new key decides once', async () => {
    // (a) F22a: APPROVE committed, response lost, then reload.
    await openCase(page, C.F22a.need);
    await opener(page, 'approve').click();
    await page.route(DECISION_URL, async (r) => { await r.fetch(); await r.abort('connectionreset'); });
    await confirmButton(page, 'approve').click();
    await panel(page).getByRole('alert').filter({ hasText: UNCERTAIN }).waitFor({ timeout: 15000 });
    await page.unroute(DECISION_URL);
    const aMid = await snap(C.F22a.need);
    await page.reload();
    await page.getByRole('heading', { name: 'Vorgangsstatus' }).waitFor({ timeout: 20000 });
    const fa = await facts(page);
    const aUi = { absage: fa['Absage'], ersatzbedarf: fa['Ersatzbedarf'], decisionButtons: await page.getByRole('button', { name: /^(Ablehnen|Ohne Ersatz genehmigen|Erneut bestätigen)$/ }).count(), successShown: await page.getByText(DONE.approve).count(), uncertainShown: await page.getByText(UNCERTAIN).count() };
    await shot(page, 'B-22a-after-reload');
    const stale = await pageFetch(page, 'POST', `/api/v1/cancellation-requests/${C.F22a.request}/decision`, { body: { decision: 'REJECT' }, headers: { 'Idempotency-Key': uid() } });
    const aAfter = await snap(C.F22a.need);
    // (b) F22b: offline, uncertain, reload online, fresh confirmation.
    await openCase(page, C.F22b.need);
    await opener(page, 'reject').click();
    const n0 = page.__decisions.length;
    await admin.ctx.setOffline(true);
    await confirmButton(page, 'reject').click();
    await panel(page).getByRole('alert').filter({ hasText: UNCERTAIN }).waitFor({ timeout: 15000 });
    await admin.ctx.setOffline(false);
    const bMid = await snap(C.F22b.need);
    await page.reload();
    await page.getByRole('heading', { name: 'Vorgangsstatus' }).waitFor({ timeout: 20000 });
    const bUi = { openerVisible: await opener(page, 'reject').isVisible(), uncertainShown: await page.getByText(UNCERTAIN).count() };
    await opener(page, 'reject').click();
    await confirmButton(page, 'reject').click();
    await waitDone(page, 'reject');
    const [b1, b2] = page.__decisions.slice(n0);
    const bAfter = await snap(C.F22b.need);
    record('B-22', 'a', { committedBeforeReload: aMid.request, uiAfterReload: aUi, staleRequest: stale, decisionEvents: aAfter.decision_events, unchangedByStale: JSON.stringify(aMid) === JSON.stringify(aAfter) });
    record('B-22', 'b', { beforeReload: { request: bMid.request, decisionEvents: bMid.decision_events }, uiAfterReload: bUi, browserAttempts: page.__decisions.length - n0, newKeyAfterReload: b1.key !== b2.key, after: { request: bAfter.request, decisionEvents: bAfter.decision_events } });
    assertDecided(aMid, 'approve', 1);
    assert.equal(aUi.absage, 'Genehmigt'); assert.equal(aUi.ersatzbedarf, 'Unbesetzt'); assert.equal(aUi.decisionButtons, 0); assert.equal(aUi.successShown, 0); assert.equal(aUi.uncertainShown, 0);
    assert.equal(stale.status, 409); assert.equal(stale.code, 'CANCELLATION_ALREADY_RESOLVED');
    assertUnchanged(aMid, aAfter, 'B-22a stale request');
    assert.equal(bMid.request, 'OPEN'); assert.equal(bMid.decision_events, 0);
    assert.ok(bUi.openerVisible && bUi.uncertainShown === 0);
    assert.notEqual(b1.key, b2.key);
    assertDecided(bAfter, 'reject', 0);
  });

  await check('B-23', 'In-flight switch: late response not shown after case switch (F23a) or account switch (F23b); one decision each', async () => {
    // (a) case switch inside the SPA
    await page.goto(`${origin}/arbeitsuebersicht?sortBy=dutyDate&sortOrder=asc`);
    await page.locator(`a[href="/arbeitsuebersicht/${C.F23a.need}"]`).click();
    await page.getByRole('heading', { name: 'Vorgangsstatus' }).waitFor();
    await delayDecisions(page, 3000);
    await opener(page, 'reject').click();
    await confirmButton(page, 'reject').click();
    await page.getByRole('link', { name: 'Zur Arbeitsübersicht' }).click();
    await page.locator(`a[href="/arbeitsuebersicht/${C.SPARE.need}"]`).click();
    await page.getByRole('heading', { name: 'Vorgangsstatus' }).waitFor();
    await sleep(4500);
    const aUi = { url: new URL(page.url()).pathname.endsWith(C.SPARE.need), lateMessage: await page.getByText(DONE.reject).count(), uncertain: await page.getByText(UNCERTAIN).count(), spareOpenersEnabled: await opener(page, 'reject').isEnabled() };
    await page.unroute(DECISION_URL);
    const aAfter = await snap(C.F23a.need);
    const spare = await snap(C.SPARE.need);
    // (b) sign out and in as another admin while the response is held
    await openCase(page, C.F23b.need);
    await delayDecisions(page, 3000);
    await opener(page, 'approve').click();
    await confirmButton(page, 'approve').click();
    await uiLogout(page);
    await uiLogin(page, 'admin-a2');
    await page.goto(`${origin}/arbeitsuebersicht/${C.SPARE.need}`);
    await page.getByRole('heading', { name: 'Vorgangsstatus' }).waitFor({ timeout: 20000 });
    await sleep(4000);
    const bUi = { lateMessage: await page.getByText(DONE.approve).count(), uncertain: await page.getByText(UNCERTAIN).count() };
    await page.unroute(DECISION_URL);
    const bAfter = await snap(C.F23b.need);
    record('B-23', 'a', { ui: aUi, original: { request: aAfter.request, decisionEvents: aAfter.decision_events }, spareCase: { request: spare.request, decisionEvents: spare.decision_events } });
    record('B-23', 'b', { ui: bUi, original: { request: bAfter.request, decisionEvents: bAfter.decision_events } });
    assert.ok(aUi.url && aUi.lateMessage === 0 && aUi.uncertain === 0 && aUi.spareOpenersEnabled, JSON.stringify(aUi));
    assertDecided(aAfter, 'reject', 0);
    assert.equal(spare.request, 'OPEN'); assert.equal(spare.decision_events, 0);
    assert.equal(bUi.lateMessage, 0); assert.equal(bUi.uncertain, 0);
    assertDecided(bAfter, 'approve', 0);
    // Restore the A1 session in this browser for the remaining cases.
    await uiLogout(page);
    await uiLogin(page, 'admin-a1');
  });

  await check('B-24', 'UI vs PostgreSQL after positive decisions; work-queue list; back-navigation keeps filters', async () => {
    const checks = [];
    for (const [label, kind] of [['C3', 'reject'], ['C0', 'approve'], ['C1', 'approve'], ['C3T', 'approve'], ['K09', 'reject'], ['D11a', 'reject'], ['D11b', 'approve'], ['S12', 'reject'], ['F19', 'reject'], ['F20', 'approve'], ['F21', 'reject'], ['F22a', 'approve'], ['F22b', 'reject'], ['F23a', 'reject'], ['F23b', 'approve']]) {
      await openCase(page, C[label].need);
      const f = await facts(page);
      const s = await snap(C[label].need);
      const shown = await offerStatuses(page);
      const expectedUi = { request: { REJECTED: 'Abgelehnt', APPROVED: 'Genehmigt' }[s.request], need: { CLOSED: 'Geschlossen', OPEN_UNFILLED: 'Unbesetzt' }[s.need], membership: s.membership === 'ACTIVE' ? 'Aktiv' : 'Nicht mehr aktiv' };
      const ok = f['Absage'] === expectedUi.request && f['Ersatzbedarf'] === expectedUi.need && f['Ursprüngliche Zuordnung'] === expectedUi.membership
        && shown.filter((x) => x === 'Nicht ausgewählt').length === (s.offers.NOT_SELECTED ?? 0) && Number(f['Offene Angebote']) === (s.offers.OPEN ?? 0)
        && (kind === 'reject' ? s.request === 'REJECTED' : s.request === 'APPROVED');
      checks.push({ case: label, ok, ui: { absage: f['Absage'], ersatzbedarf: f['Ersatzbedarf'], zuordnung: f['Ursprüngliche Zuordnung'], offeneAngebote: f['Offene Angebote'] }, pg: { request: s.request, need: s.need, membership: s.membership, offers: s.offers } });
    }
    // Queue list vs PostgreSQL: the pending set (OPEN/OPEN plus APPROVED/OPEN_UNFILLED) — compare the visible case ids.
    const { rows } = await pool.query("SELECT n.id FROM replacement_needs n JOIN cancellation_requests r ON r.id=n.cancellation_request_id WHERE r.company_id=$1 AND ((r.status='OPEN' AND n.status='OPEN') OR (r.status='APPROVED' AND n.status='OPEN_UNFILLED'))", [ids.companyA]);
    const filterUrl = `${origin}/arbeitsuebersicht?sortBy=dutyDate&sortOrder=desc&month=2026-12`;
    await page.goto(filterUrl);
    await page.getByRole('table', { name: 'Offene Absagen und Ersatzbedarfe' }).waitFor({ timeout: 20000 });
    const visible = new Set();
    for (let guard = 0; guard < 5; guard += 1) {
      for (const href of await page.locator('a[href^="/arbeitsuebersicht/"]').evaluateAll((as) => as.map((x) => x.getAttribute('href')))) visible.add(href.split('/').pop());
      const next = page.getByRole('button', { name: 'Nächste Seite' });
      if (!(await next.count()) || await next.isDisabled()) break;
      await next.click(); await sleep(800);
    }
    const expected = new Set(rows.map((r) => r.id));
    const queueMatches = expected.size === visible.size && [...expected].every((x) => visible.has(x));
    await page.goto(filterUrl);
    await page.locator(`a[href="/arbeitsuebersicht/${C.L24.need}"]`).click();
    await page.getByRole('heading', { name: 'Vorgangsstatus' }).waitFor();
    await page.getByRole('link', { name: 'Zur Arbeitsübersicht' }).click();
    await page.getByRole('table', { name: 'Offene Absagen und Ersatzbedarfe' }).waitFor();
    // The app canonicalizes parameter order; compare the parameter sets.
    const params = (u) => [...new URL(u).searchParams.entries()].map(([k, v]) => `${k}=${v}`).sort();
    const keepsFilters = JSON.stringify(params(page.url())) === JSON.stringify(params(filterUrl));
    record('B-24', 'result', { caseChecks: checks, queue: { pgPending: expected.size, uiListed: visible.size, matches: queueMatches }, backNavigationKeepsFilters: keepsFilters, backParams: params(page.url()) });
    assert.ok(checks.every((c) => c.ok), JSON.stringify(checks.filter((c) => !c.ok)));
    assert.ok(queueMatches, `queue ${visible.size} vs pg ${expected.size}`);
    assert.ok(keepsFilters, `back navigation params ${params(page.url())}`);
  });

  await check('UX01-320', 'UX-01 regression at 320 px with real data: queue filters with a long project name stay inside the viewport', async () => {
    const narrow = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'de-DE', timezoneId: 'Europe/Berlin', viewport: { width: 320, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const p = watch(await narrow.newPage(), 'admin-a1-320');
    await uiLogin(p, 'admin-a1');
    const measure = () => p.evaluate(() => ({
      viewport: innerWidth, document: document.documentElement.scrollWidth,
      layers: ['.work-queue', '.work-queue__filters', '.work-queue__controls', '.work-queue__controls label', '.work-queue__controls select'].flatMap((sel) =>
        [...document.querySelectorAll(sel)].map((el) => { const r = el.getBoundingClientRect(); return { sel, left: Math.round(r.left), right: Math.round(r.right), overflowX: el.scrollWidth - el.clientWidth }; })),
    }));
    await p.goto(`${origin}/arbeitsuebersicht?sortBy=dutyDate&sortOrder=asc`);
    await p.getByRole('table', { name: 'Offene Absagen und Ersatzbedarfe' }).waitFor({ timeout: 20000 });
    const project = p.getByRole('combobox', { name: 'Projekt', exact: true });
    await project.getByRole('option', { name: LONG_PROJECT, exact: true }).waitFor({ state: 'attached' });
    const populated = await measure();
    await shot(p, 'UX01-320-populated');
    await project.focus();
    await project.selectOption({ label: LONG_PROJECT });
    await p.waitForURL(new RegExp(`projectId=${ids.projLong}`));
    await p.getByText('Keine Vorgänge für diese Auswahl').waitFor({ timeout: 20000 });
    const selected = await measure();
    const keepsName = (await project.locator('option:checked').textContent()) === LONG_PROJECT;
    const focusKept = await project.evaluate((el) => el === document.activeElement);
    await shot(p, 'UX01-320-long-project-selected');
    const inside = (m) => m.document <= 320 && m.layers.every((l) => l.left >= -1 && l.right <= 321);
    record('UX01-320', 'result', { populated: { document: populated.document, layersInside: inside(populated), selectRight: populated.layers.filter((l) => l.sel.endsWith('select')).map((l) => l.right) }, longProjectSelected: { document: selected.document, layersInside: inside(selected), fullNameRetained: keepsName, focusRetained: focusKept, realEmptyResult: true } });
    await narrow.close();
    assert.ok(inside(populated), JSON.stringify(populated));
    assert.ok(inside(selected), JSON.stringify(selected));
    assert.ok(keepsName && focusKept);
  });

  await check('B-26','Resubmission: EMP whose case was REJECTED can cancel again; the APPROVED (removed) membership is refused', async () => {
    const e = await newSession('emp-a1');
    const dutiesNow = await e.page.evaluate(async () => (await (await fetch('/api/v1/me/monthly-plans?monthStart=2026-12-01')).json()).items[0].duties.map((d) => ({ assignmentId: d.assignmentId, version: d.version, dutyDate: d.dutyDate })));
    const rejected = dutiesNow.find((d) => d.assignmentId === C.C3.assignmentId);
    const approvedListed = dutiesNow.some((d) => d.assignmentId === C.C0.assignmentId);
    const { rows: [c0duty] } = await pool.query('SELECT d.concurrency_version::int AS v FROM duties d JOIN replacement_needs n ON n.duty_id=d.id WHERE n.id=$1', [C.C0.need]);
    const r1 = await pageFetch(e.page, 'POST', '/api/v1/cancellation-requests', { body: { assignmentId: C.C3.assignmentId }, headers: { 'Idempotency-Key': uid(), 'Expected-Version': String(rejected?.version) } });
    const r2 = await pageFetch(e.page, 'POST', '/api/v1/cancellation-requests', { body: { assignmentId: C.C0.assignmentId }, headers: { 'Idempotency-Key': uid(), 'Expected-Version': String(c0duty.v) } });
    const { rows: counts } = await pool.query("SELECT assignment_id = $2 AS rejected_assignment, status, count(*)::int AS c FROM cancellation_requests WHERE assignment_id = ANY($1) GROUP BY 1,2 ORDER BY 1,2", [[C.C3.assignmentId, C.C0.assignmentId], C.C3.assignmentId]);
    record('B-26', 'result', { rejectedDutyStillListed: !!rejected, approvedDutyListed: approvedListed, newCancellationAfterReject: r1, retryAfterApprove: r2, pg: counts });
    await e.ctx.close();
    assert.ok(rejected, 'REJECTED duty still in the employee plan');
    assert.equal(r1.status, 201, `resubmission after REJECTED: ${r1.status} ${r1.code}`);
    assert.equal(r2.status, 409, `after APPROVED: ${r2.status} ${r2.code}`);
  });

  await check('B-25', 'Storage: no keys, tokens, receipts or PII in localStorage, sessionStorage or IndexedDB of any open page', async () => {
    const found = [];
    for (const { page: p, label } of pages) {
      if (p.isClosed()) continue;
      const s = await p.evaluate(async () => {
        const dump = (st) => Object.keys(st).map((k) => ({ k, len: (st.getItem(k) ?? '').length, v: st.getItem(k) ?? '' }));
        const idb = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : null;
        return { local: dump(localStorage), session: dump(sessionStorage), idb };
      }).catch(() => null);
      if (!s) continue;
      const suspicious = [...s.local, ...s.session].filter((x) => /[0-9a-f]{8}-[0-9a-f]{4}-|token|csrf|session|idempot|Synthetic|S7-|receipt/i.test(`${x.k} ${x.v}`)).map((x) => x.k);
      found.push({ page: label, localKeys: s.local.map((x) => x.k), sessionKeys: s.session.map((x) => x.k), indexedDb: s.idb, suspicious });
    }
    report.storage = found;
    assert.ok(found.length >= 2, 'inspected pages');
    assert.ok(found.every((f) => f.suspicious.length === 0 && (f.indexedDb ?? []).length === 0), JSON.stringify(found));
  });
} catch (error) {
  fatal = error;
  log('FATAL', String(error?.stack ?? error).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id').slice(0, 1200));
} finally {
  report.results = results;
  report.finishedAt = new Date().toISOString();
  report.end = { tenantA: await counters().catch(() => null), tenantB: await counters(ids.companyB).catch(() => null) };
  delete report.__emp;
  await writeFile(resolve(output, 'sp21-s7-browser-acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close();
  await pool.end();
  const passed = results.filter((r) => r.result === 'PASS').length;
  log(JSON.stringify({ passed, failed: results.length - passed, fatal: fatal ? String(fatal.message ?? fatal).slice(0, 300) : null }));
  process.exitCode = fatal || results.some((r) => r.result === 'FAIL') ? 1 : 0;
}
