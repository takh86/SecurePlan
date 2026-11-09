/**
 * SP-19 backend-backed acceptance: real Chrome -> built/dev React frontend -> NestJS -> verified disposable PostgreSQL 17.
 * Identities and prerequisite rows are written by SQL on the verified target; planning, cancellation, offer and
 * withdrawal writes use real HTTP as the actual accounts. Evidence contains statuses, codes, counts, timestamps and
 * screenshots of synthetic data only: no passwords, tokens, cookies or raw session material.
 *
 * Requires: DATABASE_URL + SECUREPLAN_TEST_TARGET_RECEIPT (verified by scripts/disposable-test-target.mjs),
 * SECUREPLAN_PLAYWRIGHT_MODULE (path to a Playwright index module), SECUREPLAN_BROWSER_OUTPUT_DIR,
 * and a running backend (SECUREPLAN_BACKEND_ORIGIN) plus frontend origin (SECUREPLAN_ORIGIN).
 */
import assert from 'node:assert/strict';
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
// Per-run tag: account e-mails are unique, and the disposable database may be reused for a re-run.
const runTag = randomBytes(3).toString('hex');
const email = (label) => `${label}-${runTag}@example.invalid`;
const ids = Object.fromEntries(['companyA', 'companyB', 'adminA', 'demoAdminA', 'accE1', 'accE2', 'accE3', 'accB', 'adminB', 'e1', 'e2', 'e3', 'eB', 'projNord', 'projSued', 'projB', 'planNord', 'planSued', 'planB'].map((k) => [k, uid()]));

const report = { startedAt: new Date().toISOString(), target: { containerRun: verified.runId ?? null, cluster: verified.cluster }, origin, http: [], pg: [], results: [], pageErrors: 0, consoleErrors: [] };
const log = (...args) => console.log(...args);

// ---------------------------------------------------------------- HTTP as real accounts
async function actorFor(label, accountId) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'de-DE', timezoneId: 'America/Los_Angeles', viewport: { width: 1440, height: 1000 } });
  const r = await ctx.request.post(`${origin}/api/v1/auth/login`, { headers: { Origin: origin, 'Content-Type': 'application/json' }, data: { email: email(label), password } });
  assert.equal(r.status(), 200, `login ${label}`);
  return { label, accountId, ctx, csrf: r.headers()['x-csrf-token'] };
}
async function api(actor, method, path, { body = null, headers = {}, record = true, stage = '' } = {}) {
  const h = { Origin: origin, ...headers };
  if (actor?.csrf && method !== 'GET') h['X-CSRF-Token'] = actor.csrf;
  if (body !== null) h['Content-Type'] = 'application/json';
  const ctx = actor ? actor.ctx : anonCtx;
  const r = await ctx.request.fetch(`${origin}/api/v1${path}`, { method, headers: h, data: body ?? undefined, failOnStatusCode: false });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  const out = { status: r.status(), body: json, cache: r.headers()['cache-control'] ?? null, contentType: r.headers()['content-type'] ?? null };
  if (record) report.http.push({ stage, actor: actor?.label ?? 'anonymous', method, path, status: out.status, code: json?.code ?? null, cache: out.cache, contentType: out.contentType });
  return out;
}
const expectStatus = (res, status, what) => { assert.equal(res.status, status, `${what}: expected ${status}, got ${res.status} ${JSON.stringify(res.body)?.slice(0, 200)}`); return res; };

// ---------------------------------------------------------------- PostgreSQL assertions (read-only queries)
async function q(label, sql, params = []) {
  const { rows } = await pool.query(sql, params);
  report.pg.push({ label, rowCount: rows.length, rows: rows.map((r) => JSON.parse(JSON.stringify(r))) });
  return rows;
}

// ---------------------------------------------------------------- seed (synthetic identities and fixtures)
async function seed() {
  const hash = await hashPassword(password);
  for (const [id, name] of [[ids.companyA, 'SP19 Acceptance A'], [ids.companyB, 'SP19 Acceptance B']])
    await pool.query("INSERT INTO companies(id,name,status,time_zone) VALUES($1,$2,'ACTIVE','Europe/Berlin')", [id, name]);
  const accounts = [
    [ids.adminA, ids.companyA, 'admin-a', 'COMPANY_ADMIN'],
    [ids.demoAdminA, ids.companyA, 'demo-admin-a', 'COMPANY_ADMIN'],
    [ids.accE1, ids.companyA, 'employee-1-a', 'EMPLOYEE'],
    [ids.accE2, ids.companyA, 'employee-2-a', 'EMPLOYEE'],
    [ids.accE3, ids.companyA, 'employee-3-a', 'EMPLOYEE'],
    [ids.adminB, ids.companyB, 'admin-b', 'COMPANY_ADMIN'],
    [ids.accB, ids.companyB, 'employee-b', 'EMPLOYEE'],
  ];
  for (const [id, company, label, role] of accounts)
    await pool.query("INSERT INTO accounts(id,company_id,email,account_scope,role,status,password_hash) VALUES($1,$2,$3,'TENANT',$4,'ACTIVE',$5)", [id, company, email(label), role, hash]);
  const employees = [[ids.e1, ids.companyA, ids.accE1, 'SP19-A1', 'Alpha'], [ids.e2, ids.companyA, ids.accE2, 'SP19-A2', 'Bravo'], [ids.e3, ids.companyA, ids.accE3, 'SP19-A3', 'Charlie'], [ids.eB, ids.companyB, ids.accB, 'SP19-B1', 'Foxtrot']];
  for (const [id, company, account, number, last] of employees)
    await pool.query("INSERT INTO employees(id,company_id,account_id,employee_number,first_name,last_name,shift_eligibility,employment_start) VALUES($1,$2,$3,$4,'Synthetic',$5,'BOTH','2020-01-01')", [id, company, account, number, last]);
  const projects = [[ids.projNord, ids.companyA, 'SP19 Nord'], [ids.projSued, ids.companyA, 'SP19 Süd'], [ids.projB, ids.companyB, 'SP19 Foreign']];
  for (const [id, company, name] of projects) {
    await pool.query("INSERT INTO projects(id,company_id,name,status) VALUES($1,$2,$3,'ACTIVE')", [id, company, name]);
    for (const [kind, start, end] of [['TAG', '06:00', '18:00'], ['NACHT', '18:00', '06:00']])
      await pool.query("INSERT INTO shift_configurations(company_id,project_id,effective_from_month,shift_kind,start_local,end_local) VALUES($1,$2,'2026-12-01',$3,$4,$5)", [company, id, kind, start, end]);
  }
  for (const [company, employee, project, month] of [
    [ids.companyA, ids.e1, ids.projNord, '2026-12-01'], [ids.companyA, ids.e2, ids.projNord, '2026-12-01'], [ids.companyA, ids.e3, ids.projNord, '2026-12-01'],
    [ids.companyA, ids.e1, ids.projSued, '2027-01-01'], [ids.companyA, ids.e2, ids.projSued, '2027-01-01'],
    [ids.companyB, ids.eB, ids.projB, '2026-12-01'],
  ])
    await pool.query("INSERT INTO project_assignments(company_id,employee_id,project_id,planning_month) VALUES($1,$2,$3,$4)", [company, employee, project, month]);
}

// Calendar and plan helpers copied in behaviour from the SP-18 acceptance harness (real HTTP).
async function calendar(admin, project) {
  const path = `/projects/${project}/operating-calendar`;
  const v = expectStatus(await api(admin, 'GET', `${path}?effectiveForMonth=2026-12-01`, { stage: 'setup-calendar' }), 200, 'calendar GET').body;
  expectStatus(await api(admin, 'PATCH', path, { body: { effectiveFromMonth: '2026-12-01', expectedExactVersion: v.exactVersion, expectedEffective: v.effective ? { id: v.effective.id, version: v.effective.version } : null, expectedNextEffectiveFromMonth: v.nextEffectiveFromMonth, operatingWeekdays: [1, 2, 3, 4, 5, 6, 7], bootstrap: false }, stage: 'setup-calendar' }), 200, 'calendar PATCH');
}
const route = (plan, person) => `/monthly-plans/${plan}/employee-months/${person}`;
async function saveDuties(admin, plan, person, dutyByIndex) {
  const current = expectStatus(await api(admin, 'GET', route(plan, person), { stage: 'setup-plan' }), 200, 'employee-month GET').body;
  const days = current.days.map((d, i) => ({ date: d.date, expected: { day: d.day ? { id: d.day.dutyId, version: d.day.version } : null, night: d.night ? { id: d.night.dutyId, version: d.night.version } : null }, desired: dutyByIndex[i] ?? { state: 'OFF' } }));
  expectStatus(await api(admin, 'POST', `${route(plan, person)}/save`, { body: { expectedPlan: { status: current.plan.status, publishedAt: current.plan.publishedAt }, expectedCreationContext: current.creationContextFingerprint, expectedCalendar: current.operatingCalendar.effective ? { id: current.operatingCalendar.effective.id, version: current.operatingCalendar.effective.version } : null, days }, headers: { 'Idempotency-Key': uid() }, stage: 'setup-plan' }), 200, 'employee-month save');
}
const dayIndex = (dayOfMonth) => dayOfMonth - 1;


// ---------------------------------------------------------------- browser and scenario helpers
let browser, anonCtx, uiAdmin, uiPage, actors = {};
const results = [];
async function check(id, description, work) {
  const started = Date.now();
  try {
    await work();
    results.push({ id, description, result: 'PASS', ms: Date.now() - started });
    log(`PASS ${id} ${description}`);
  } catch (error) {
    results.push({ id, description, result: 'FAIL', detail: String(error?.message ?? error).slice(0, 500) });
    log(`FAIL ${id} ${description}: ${String(error?.message ?? error).slice(0, 400)}`);
    if (uiPage) await uiPage.screenshot({ path: resolve(output, `${id}-failure.png`), fullPage: true }).catch(() => {});
  }
}
const shot = (name) => uiPage.screenshot({ path: resolve(output, `${name}.png`), fullPage: true });
async function uiLogin(page, label) {
  await page.goto(`${origin}/`);
  await page.getByRole('heading', { name: 'Anmelden', exact: true }).waitFor();
  await page.getByLabel('E-Mail-Adresse').fill(email(label));
  await page.getByLabel('Passwort', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
}

// ================================================================= main
const { chromium: _c } = { chromium };
browser = await _c.launch({ channel: process.env.SECUREPLAN_BROWSER_CHANNEL ?? 'chrome', headless: true, args: ['--enable-features=BackForwardCache'] });
anonCtx = await browser.newContext({ ignoreHTTPSErrors: true });
let fatal = null;
try {
  await seed();
  report.seeded = { companies: 2, accounts: 7, employees: 4, projects: 3 };

  actors.adminA = await actorFor('admin-a', ids.adminA);
  actors.demoAdminA = await actorFor('demo-admin-a', ids.demoAdminA);
  actors.e1 = await actorFor('employee-1-a', ids.accE1);
  actors.e2 = await actorFor('employee-2-a', ids.accE2);
  actors.e3 = await actorFor('employee-3-a', ids.accE3);
  actors.adminB = await actorFor('admin-b', ids.adminB);
  actors.eB = await actorFor('employee-b', ids.accB);

  // ---- planning setup (real HTTP): operating calendars first, then plans
  await calendar(actors.adminA, ids.projNord);
  await calendar(actors.adminA, ids.projSued);
  await calendar(actors.adminB, ids.projB);
  const planNord = expectStatus(await api(actors.adminA, 'POST', '/monthly-plans', { body: { projectId: ids.projNord, monthStart: '2026-12-01' }, stage: 'setup-plan' }), 201, 'plan Nord').body.id;
  const planSued = expectStatus(await api(actors.adminA, 'POST', '/monthly-plans', { body: { projectId: ids.projSued, monthStart: '2027-01-01' }, stage: 'setup-plan' }), 201, 'plan Süd').body.id;
  const planB = expectStatus(await api(actors.adminB, 'POST', '/monthly-plans', { body: { projectId: ids.projB, monthStart: '2026-12-01' }, stage: 'setup-plan' }), 201, 'plan B').body.id;
  ids.planNord = planNord; ids.planSued = planSued; ids.planB = planB;

  const dutiesFor = (days, state = 'DAY') => Object.fromEntries(days.map((d) => [dayIndex(d), { state, role: 'EMPLOYEE' }]));
  await saveDuties(actors.adminA, planNord, ids.e1, dutiesFor(Array.from({ length: 27 }, (_, i) => i + 1)));
  await saveDuties(actors.adminA, planNord, ids.e2, dutiesFor([30]));
  await saveDuties(actors.adminA, planNord, ids.e3, dutiesFor([6]));
  await saveDuties(actors.adminA, planSued, ids.e2, dutiesFor([10], 'NIGHT'));
  await saveDuties(actors.adminB, planB, ids.eB, dutiesFor([3]));
  for (const [admin, plan] of [[actors.adminA, planNord], [actors.adminA, planSued], [actors.adminB, planB]])
    expectStatus(await api(admin, 'POST', `/monthly-plans/${plan}/publish`, { headers: { 'Idempotency-Key': uid() }, stage: 'setup-publish' }), 200, 'publish');

  // ---- cancellations by the real employees (real HTTP)
  async function ownDuties(actor, month) {
    const r = expectStatus(await api(actor, 'GET', `/me/monthly-plans?monthStart=${month}`, { stage: 'setup-cancel' }), 200, 'own duties');
    return r.body.items[0].duties;
  }
  async function cancel(actor, duty) {
    return api(actor, 'POST', '/cancellation-requests', { body: { assignmentId: duty.assignmentId }, headers: { 'Expected-Version': String(duty.version), 'Idempotency-Key': uid() }, stage: 'setup-cancel' });
  }
  const e1Duties = (await ownDuties(actors.e1, '2026-12-01')).sort((a, b) => a.dutyDate.localeCompare(b.dutyDate));
  const cases = {};
  for (const duty of e1Duties) {
    const r = expectStatus(await cancel(actors.e1, duty), 201, 'E1 cancellation');
    cases[duty.dutyDate] = { cancellation: r.body.id, need: r.body.replacementNeed.id };
  }
  const c3Duty = (await ownDuties(actors.e2, '2027-01-01'))[0];
  const c3 = expectStatus(await cancel(actors.e2, c3Duty), 201, 'E2 Süd cancellation').body;
  const c4Duty = (await ownDuties(actors.e3, '2026-12-01'))[0];
  const c4 = expectStatus(await cancel(actors.e3, c4Duty), 201, 'E3 cancellation').body;
  const cB = expectStatus(await cancel(actors.eB, (await ownDuties(actors.eB, '2026-12-01'))[0]), 201, 'B cancellation').body;
  report.cases = { e1Count: e1Duties.length, c3: { cancellation: c3.id, need: c3.replacementNeed.id }, c4: { cancellation: c4.id, need: c4.replacementNeed.id }, foreign: { cancellation: cB.id, need: cB.replacementNeed.id } };
  const c1 = cases['2026-12-03']; // C1: two offers, one eligible and one made ineligible after submission
  const c2 = cases['2026-12-04']; // C2: one offer withdrawn (NOT_APPLICABLE)
  assert.ok(c1 && c2, 'C1 and C2 exist');
  report.cases.c1 = c1; report.cases.c2 = c2;
  report.cases.totalNord = Object.keys(cases).length;

  // ---- offers by real candidates (real HTTP), then controlled fixtures for eligibility states
  expectStatus(await api(actors.e2, 'POST', `/replacement-needs/${c1.need}/offers`, { headers: { 'Idempotency-Key': uid() }, stage: 'setup-offers' }), 201, 'E2 offer C1');
  expectStatus(await api(actors.e3, 'POST', `/replacement-needs/${c1.need}/offers`, { headers: { 'Idempotency-Key': uid() }, stage: 'setup-offers' }), 201, 'E3 offer C1');
  expectStatus(await api(actors.e3, 'POST', `/replacement-needs/${c2.need}/offers`, { headers: { 'Idempotency-Key': uid() }, stage: 'setup-offers' }), 201, 'E3 offer C2');
  expectStatus(await api(actors.e1, 'POST', `/replacement-needs/${c3.replacementNeed.id}/offers`, { headers: { 'Idempotency-Key': uid() }, stage: 'setup-offers' }), 201, 'E1 offer C3');
  // Controlled fixtures (documented in the report): E3 becomes unavailable on C1's duty day (current eligibility
  // changes after submission); E3's offer on C2 is set to WITHDRAWN to exercise the NOT_APPLICABLE state.
  await pool.query("INSERT INTO employee_availability_days(company_id,employee_id,day,status) VALUES($1,$2,'2026-12-03','SICK')", [ids.companyA, ids.e3]);
  await pool.query("WITH t AS (SELECT clock_timestamp() AS now) UPDATE replacement_offers SET status='WITHDRAWN', decided_at=t.now, updated_at=t.now FROM t WHERE need_id=$1 AND employee_id=$2", [c2.need, ids.e3]);
  await q('offers-after-setup', "SELECT need_id, status, count(*) FROM replacement_offers WHERE company_id=$1 GROUP BY need_id, status ORDER BY 1,2", [ids.companyA]);

  // ---- session for the browser admin (UI login is performed in TEST-01)
  uiAdmin = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'de-DE', timezoneId: 'America/Los_Angeles', viewport: { width: 1440, height: 1000 } });
  uiPage = await uiAdmin.newPage();
  uiPage.on('pageerror', () => { report.pageErrors += 1; });
  uiPage.on('console', (msg) => { if (msg.type() === 'error') report.consoleErrors.push(msg.text().slice(0, 160)); });

  // ================= scenarios
  await check('TEST-01', 'administrator logs in through the real UI, reaches /arbeitsuebersicht, data loads from the backend', async () => {
    await uiLogin(uiPage, 'admin-a');
    await uiPage.getByRole('heading', { level: 1, name: 'Arbeitsübersicht' }).waitFor({ timeout: 20000 });
    await uiPage.getByRole('rowheader', { name: /Synthetic Alpha/ }).first().waitFor();
    const text = await uiPage.locator('body').innerText();
    for (const fragment of ['Demodaten', 'VORSCHAU', 'Alex Beispiel', 'Beispielzeit']) assert.ok(!text.includes(fragment), `preview text ${fragment}`);
    const queueResponse = await api(actors.adminA, 'GET', '/admin/work-queue?page=1&pageSize=25&sortBy=createdAt&sortOrder=asc', { stage: 'TEST-01' });
    expectStatus(queueResponse, 200, 'queue as admin');
    assert.ok(queueResponse.cache?.includes('no-store') && queueResponse.cache.includes('private'), `cache-control ${queueResponse.cache}`);
    await shot('TEST-01-admin-queue-desktop');
  });

  await check('TEST-02', 'queue rows show employee, project, shift, date, statuses and open/eligible counts matching API and PostgreSQL', async () => {
    const api1 = expectStatus(await api(actors.adminA, 'GET', '/admin/work-queue?page=1&pageSize=25&sortBy=createdAt&sortOrder=asc', { stage: 'TEST-02' }), 200, 'queue').body;
    const c1Row = api1.items.find((i) => i.replacementNeedId === c1.need);
    assert.ok(c1Row, 'C1 in API page 1');
    assert.equal(c1Row.openOfferCount, 2); assert.equal(c1Row.eligibleOpenOfferCount, 1);
    const [pg] = await q('TEST-02 open/status for C1', "SELECT count(*) FILTER (WHERE o.status='OPEN')::int AS open, n.status AS need_status, r.status AS request_status FROM replacement_needs n JOIN cancellation_requests r ON r.id=n.cancellation_request_id LEFT JOIN replacement_offers o ON o.need_id=n.id WHERE n.id=$1 GROUP BY n.status, r.status", [c1.need]);
    assert.equal(pg.open, 2, 'PostgreSQL open offers C1');
    await uiPage.goto(`${origin}/arbeitsuebersicht`);
    const row = uiPage.locator('tr', { has: uiPage.locator(`a[href="/arbeitsuebersicht/${c1.need}"]`) });
    await row.waitFor();
    const cells = await row.evaluate((tr) => Object.fromEntries([...tr.querySelectorAll('td')].map((td) => [td.dataset.label, td.textContent.trim()])));
    const apiRow = api1.items.find((i) => i.replacementNeedId === c1.need);
    assert.equal(cells['Offene Angebote'], String(apiRow.openOfferCount), 'open offers shown equal API');
    assert.equal(cells['Aktuell geeignet'], String(apiRow.eligibleOpenOfferCount), 'eligible shown equal API');
    assert.equal(cells['Offene Angebote'], '2');
    assert.equal(cells['Aktuell geeignet'], '1');
    assert.equal(cells['Vorgang'], 'Absage');
    const dienst = await row.locator('td[data-label="Dienst"]').innerText();
    assert.ok(dienst.includes('Tagdienst'), dienst);
    assert.ok(dienst.includes('06:00 – 18:00'), dienst);
    assert.ok(dienst.includes('03.12.2026'), dienst);
    assert.ok(dienst.includes('Zeitzone Europe/Berlin'), dienst);
    report.ui = { ...(report.ui ?? {}), c1Row: cells };
  });

  await check('TEST-02b', 'overnight NIGHT duty shows the saved-zone end date (Berlin) while the browser runs in America/Los_Angeles', async () => {
    await uiPage.goto(`${origin}/arbeitsuebersicht?projectId=${ids.projSued}`);
    const row = uiPage.getByRole('row').filter({ hasText: 'Synthetic Bravo' }).first();
    await row.waitFor();
    const dienst = await row.locator('td[data-label="Dienst"]').innerText();
    assert.ok(dienst.includes('18:00 – 06:00'), dienst);
    assert.ok(dienst.includes('Nachtdienst'), dienst);
    assert.ok(dienst.includes('(Mo, 11.01.2027)'), `overnight end date (saved zone): ${dienst}`);
  });

  await check('TEST-03', 'open case shows ELIGIBLE / INELIGIBLE / NOT_APPLICABLE from the server, separate counts, no decision control', async () => {
    await uiPage.goto(`${origin}/arbeitsuebersicht/${c1.need}`);
    await uiPage.getByRole('heading', { name: 'Vorgangsstatus' }).waitFor();
    const table = uiPage.getByRole('table', { name: 'Eingereichte Ersatzangebote' });
    await table.waitFor();
    const rows = await table.locator('tbody tr').allInnerTexts();
    assert.equal(rows.length, 2, rows.join(' | '));
    assert.ok(rows.some((r) => r.includes('Aktuell geeignet')), 'eligible E2');
    assert.ok(rows.some((r) => r.includes('Aktuell nicht geeignet')), 'ineligible E3 after sick fixture');
    const c2Page = await api(actors.adminA, 'GET', `/replacement-needs/${c2.need}/offers?page=1&pageSize=25`, { stage: 'TEST-03' });
    expectStatus(c2Page, 200, 'C2 offers');
    assert.equal(c2Page.body.items[0].reviewEligibility, 'NOT_APPLICABLE');
    await uiPage.goto(`${origin}/arbeitsuebersicht/${c2.need}`);
    await uiPage.getByRole('table', { name: 'Eingereichte Ersatzangebote' }).waitFor();
    assert.ok((await uiPage.locator('tbody').innerText()).includes('Nicht anwendbar'));
    for (const label of await uiPage.getByRole('button').allInnerTexts()) assert.ok(!/Genehmig|Ablehn|Auswähl|Zuweis|Bestätig|Speicher|Absage/i.test(label), label);
    await shot('TEST-03-case-eligibility');
  });

  await check('TEST-04', 'filters, sorting and pagination use server parameters; refresh keeps URL state', async () => {
    await uiPage.goto(`${origin}/arbeitsuebersicht`);
    await uiPage.getByRole('heading', { name: 'Arbeitsübersicht' }).waitFor();
    await uiPage.getByText('Seite 1 von 2', { exact: true }).waitFor();
    const seen = [];
    uiPage.on('request', (r) => { if (r.url().includes('/admin/work-queue')) seen.push(new URL(r.url()).search); });
    // Count only settled data rows: the list enters its loading state while a new query is pending.
    const dataRows = async (expected, label) => {
      const end = Date.now() + 15000;
      let count = -1;
      while (Date.now() < end) {
        count = (await uiPage.getByRole('row').count()) - 1;
        if (count === expected && !(await uiPage.getByRole('status').filter({ hasText: 'werden geladen' }).count())) return count;
        await new Promise((r) => setTimeout(r, 150));
      }
      assert.fail(`${label}: expected ${expected} data rows, saw ${count}`);
    };
    await uiPage.getByRole('radio', { name: 'Mit aktuell geeigneten Angeboten' }).click();
    await uiPage.waitForURL(/offerPresence=WITH_ELIGIBLE/);
    await dataRows(2, 'eligible-offer filter');
    await uiPage.getByRole('radio', { name: 'Alle offenen Vorgänge' }).click();
    await uiPage.waitForURL((url) => !url.searchParams.has('offerPresence'));
    // Without the offer filter the open set is 28 cases: two pages of 25 and 3.
    await uiPage.getByText('Seite 1 von 2', { exact: true }).waitFor();
    assert.equal(await uiPage.getByRole('radio', { name: 'Alle offenen Vorgänge' }).isChecked(), true, 'radio reflects the cleared filter');
    await uiPage.getByLabel('Sortieren nach').selectOption('dutyDate');
    await uiPage.getByLabel('Reihenfolge').selectOption('desc');
    await uiPage.waitForURL(/sortBy=dutyDate/);
    await uiPage.getByLabel('Vorgangsart').selectOption('CANCELLATION_REQUEST');
    await uiPage.getByLabel('Projekt').selectOption({ label: 'SP19 Süd' });
    await uiPage.waitForURL(new RegExp(`projectId=${ids.projSued}`));
    await dataRows(1, 'project Süd filter');
    await uiPage.getByLabel('Projekt').selectOption({ label: 'Alle Projekte' });
    await uiPage.getByLabel('Vorgangsart').selectOption('');
    await uiPage.getByLabel('Sortieren nach').selectOption('createdAt');
    await uiPage.getByLabel('Reihenfolge').selectOption('asc');
    await uiPage.getByLabel('Dienstmonat').fill('2027-01');
    await uiPage.waitForURL(/month=2027-01/);
    await dataRows(1, 'month filter 2027-01');
    await uiPage.getByLabel('Dienstmonat').fill('');
    await uiPage.getByText('Seite 1 von 2', { exact: true }).waitFor();
    await uiPage.getByRole('button', { name: 'Nächste Seite' }).click();
    await uiPage.getByText('Seite 2 von 2', { exact: true }).waitFor();
    assert.ok(seen.some((s) => s.includes('page=2')), 'page 2 requested from server');
    await uiPage.getByRole('button', { name: 'Vorherige Seite' }).click();
    await uiPage.goto(`${origin}/arbeitsuebersicht?offerPresence=WITH_ELIGIBLE&page=1`);
    await uiPage.reload();
    assert.equal(await uiPage.getByRole('radio', { name: 'Mit aktuell geeigneten Angeboten' }).isChecked(), true, 'URL state after refresh');
    await uiPage.goto(`${origin}/arbeitsuebersicht?page=3`);
    await uiPage.getByText('Diese Seite ist leer').waitFor();
    await uiPage.getByRole('button', { name: 'Zur ersten Seite' }).click();
    await uiPage.getByRole('table').waitFor();
    report.server = { queueRequestsSeen: seen.length };
    await shot('TEST-04-filters');
  });

  await check('TEST-05', 'a case withdrawn by the real employee: refresh shows the authoritative state and it is not pending work', async () => {
    // Sort by duty date so that C4 is guaranteed to be on page one even with 29+ pending cases.
    // Prove the exact case is visible before withdrawal; avoid a vacuous absence assertion later.
    const sortedQueue = `${origin}/arbeitsuebersicht?sortBy=dutyDate&sortOrder=asc`;
    const caseHref = `/arbeitsuebersicht/${c4.replacementNeed.id}`;
    await uiPage.goto(sortedQueue);
    const c4QueueLink = uiPage.locator('a[href="' + caseHref + '"]');
    await c4QueueLink.waitFor({ timeout: 20000 });
    await c4QueueLink.click();
    await uiPage.getByRole('heading', { name: 'Vorgangsstatus' }).waitFor();
    assert.ok(!(await uiPage.locator('body').innerText()).includes('nicht mehr offen'), 'open before withdrawal');
    expectStatus(await api(actors.e3, 'POST', `/cancellation-requests/${c4.id}/withdraw`, { stage: 'TEST-05' }), 200, 'E3 withdraw');
    await q('TEST-05 cancellation status after real withdrawal', 'SELECT status FROM cancellation_requests WHERE id=$1', [c4.id]).then((rows) => assert.equal(rows[0].status, 'WITHDRAWN'));
    await uiPage.getByRole('button', { name: 'Ansicht aktualisieren' }).click();
    await uiPage.getByRole('note').waitFor();
    assert.ok((await uiPage.getByRole('note').innerText()).includes('nicht mehr offen'));
    await uiPage.goto(sortedQueue);
    await uiPage.getByRole('table', { name: 'Offene Absagen und Ersatzbedarfe' }).waitFor();
    await uiPage.getByText('Seite 1 von 2', { exact: true }).waitFor();
    assert.equal(await uiPage.locator('a[href="' + caseHref + '"]').count(), 0,
      'withdrawn case must disappear from the first queue page after refresh');
    const rows = await uiPage.getByRole('row').count();
    assert.ok(rows > 2, 'queue still lists other pending cases');
    const totals = await q('TEST-05 open cancellations after withdrawal', "SELECT count(*)::int AS open FROM cancellation_requests r JOIN replacement_needs n ON n.cancellation_request_id=r.id WHERE r.company_id=$1 AND r.status='OPEN' AND n.status='OPEN'", [ids.companyA]);
    assert.equal(totals[0].open, 28, 'withdrawn case excluded from pending count');
    await shot('TEST-05-after-withdrawal');
  });

  await check('TEST-06a', 'HTTP authorization: EMPLOYEE, anonymous, cross-tenant, invalid and hidden IDs', async () => {
    const e1Queue = expectStatus(await api(actors.e1, 'GET', '/admin/work-queue', { stage: 'TEST-06' }), 403, 'employee queue');
    report.security = { employeeQueueStatus: e1Queue.status, employeeQueueCode: e1Queue.body?.code ?? null };
    const anon = expectStatus(await api(null, 'GET', '/admin/work-queue', { stage: 'TEST-06' }), 401, 'anonymous queue');
    report.security.anonymousStatus = anon.status; report.security.anonymousCode = anon.body?.code ?? null;
    const foreignOffers = expectStatus(await api(actors.adminA, 'GET', `/replacement-needs/${cB.replacementNeed.id}/offers`, { stage: 'TEST-06' }), 404, 'cross-tenant offers');
    const foreignCancel = expectStatus(await api(actors.adminA, 'GET', `/cancellation-requests/${cB.id}`, { stage: 'TEST-06' }), 404, 'cross-tenant cancellation');
    const foreignProject = expectStatus(await api(actors.adminA, 'GET', `/admin/work-queue?projectId=${ids.projB}`, { stage: 'TEST-06' }), 404, 'cross-tenant project filter');
    const badId = await api(actors.adminA, 'GET', '/replacement-needs/not-a-uuid/offers', { stage: 'TEST-06' });
    report.security.crossTenant = { offers: foreignOffers.status, cancellation: foreignCancel.status, projectFilter: foreignProject.status, codes: [foreignOffers.body?.code, foreignCancel.body?.code, foreignProject.body?.code] };
    report.security.malformedId = { status: badId.status, code: badId.body?.code ?? null };
    assert.ok(badId.status >= 400 && badId.status < 500, 'malformed id rejected');
    const bAdminSees = expectStatus(await api(actors.adminB, 'GET', `/replacement-needs/${c1.need}/offers`, { stage: 'TEST-06' }), 404, 'foreign admin reads A case');
    report.security.foreignAdminReadsA = bAdminSees.status;
    await q('no cross-tenant write (foreign company still has exactly one open need)', "SELECT count(*)::int AS open_needs FROM replacement_needs WHERE company_id=$1 AND status='OPEN'", [ids.companyB]);
  });

  await check('TEST-06b', 'UI: EMPLOYEE sees no admin data; foreign and malformed case IDs show safe unavailable states', async () => {
    const e1Ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'de-DE', timezoneId: 'America/Los_Angeles' });
    const e1Page = await e1Ctx.newPage();
    await uiLogin(e1Page, 'employee-1-a');
    // Wait until the employee shell is signed in (the employee landing page), then request the admin route.
    await e1Page.getByRole('navigation', { name: 'Hauptnavigation' }).waitFor({ state: 'attached', timeout: 20000 });
    await e1Page.goto(`${origin}/arbeitsuebersicht`);
    await e1Page.getByRole('heading', { name: 'Kein Zugriff auf diese Ansicht' }).waitFor({ timeout: 20000 });
    assert.equal(await e1Page.getByRole('table').count(), 0);
    await e1Ctx.close();
    await uiPage.goto(`${origin}/arbeitsuebersicht/${cB.replacementNeed.id}`);
    await uiPage.getByRole('alert').filter({ hasText: 'Vorgang nicht verfügbar' }).waitFor();
    assert.ok(!(await uiPage.locator('body').innerText()).includes('Vorgangsstatus'));
    await uiPage.goto(`${origin}/arbeitsuebersicht/not-a-uuid`);
    await uiPage.getByRole('alert').filter({ hasText: 'Vorgang nicht verfügbar' }).waitFor();
    await shot('TEST-06-unavailable-case');
  });

  await check('TEST-06c', 'UI logout ends access; an old cookie gets 401; revoked and expired sessions are rejected by the server', async () => {
    // Browser logout first, while the browser admin session is still valid.
    await uiPage.goto(`${origin}/arbeitsuebersicht`);
    await uiPage.getByRole('heading', { name: 'Arbeitsübersicht' }).waitFor();
    const logoutButton = uiPage.getByRole('button', { name: 'Abmelden', exact: true });
    if (!(await logoutButton.isVisible())) await uiPage.getByRole('button', { name: /Menü/ }).click();
    assert.equal((await uiAdmin.request.get(`${origin}/api/v1/me`, { headers: { Origin: origin } })).status(), 200, 'browser session valid before logout');
    // Keep a copy of the session cookie (value never printed or stored in the report) to replay after logout.
    const savedCookies = (await uiAdmin.cookies(origin)).filter((c) => c.name.includes('secureplan_session'));
    assert.ok(savedCookies.length === 1, 'session cookie present');
    await logoutButton.click();
    await uiPage.getByRole('heading', { name: 'Anmelden', exact: true }).waitFor({ timeout: 20000 });
    assert.equal(await uiPage.getByRole('table').count(), 0, 'no queue after logout');
    // Replay the signed-out cookie from a fresh browser context: the server must reject it.
    const replay = await browser.newContext({ ignoreHTTPSErrors: true });
    await replay.addCookies(savedCookies);
    const afterLogout = await replay.request.get(`${origin}/api/v1/admin/work-queue`, { headers: { Origin: origin }, failOnStatusCode: false });
    report.security.replayAfterLogoutStatus = afterLogout.status();
    const afterLogoutBody = await afterLogout.json().catch(() => null);
    report.security.replayAfterLogoutCode = afterLogoutBody?.code ?? null;
    await replay.close();
    assert.equal(afterLogout.status(), 401, 'replayed signed-out cookie is rejected');
    // Server-side revocation and expiry on a dedicated admin account (its own sessions only).
    const revokedActor = await actorFor('demo-admin-a', ids.demoAdminA);
    expectStatus(await api(revokedActor, 'GET', '/admin/work-queue', { stage: 'TEST-06c' }), 200, 'session before revoke');
    await pool.query("UPDATE sessions SET revoked_at=clock_timestamp() WHERE account_id=$1 AND revoked_at IS NULL", [ids.demoAdminA]);
    const revoked = expectStatus(await api(revokedActor, 'GET', '/admin/work-queue', { stage: 'TEST-06c' }), 401, 'revoked session');
    report.security.revoked = { status: revoked.status, code: revoked.body?.code ?? null };
    const expiredActor = await actorFor('demo-admin-a', ids.demoAdminA);
    // Expiry in the past while satisfying chk_sessions_absolute_expiry (absolute_expires_at > created_at).
    await pool.query("UPDATE sessions SET absolute_expires_at=created_at + interval '1 millisecond' WHERE account_id=$1 AND revoked_at IS NULL", [ids.demoAdminA]);
    const expired = expectStatus(await api(expiredActor, 'GET', '/admin/work-queue', { stage: 'TEST-06c' }), 401, 'expired session');
    report.security.expired = { status: expired.status, code: expired.body?.code ?? null };
  });

  await check('TEST-06d', 'account switch in the same browser: after an employee sign-in, no administrative data is shown', async () => {
    await uiLogin(uiPage, 'employee-1-a');
    await uiPage.getByRole('navigation', { name: 'Hauptnavigation' }).waitFor({ state: 'attached', timeout: 20000 });
    await uiPage.goto(`${origin}/arbeitsuebersicht`);
    await uiPage.getByRole('heading', { name: 'Kein Zugriff auf diese Ansicht' }).waitFor({ timeout: 20000 });
    const text = await uiPage.locator('body').innerText();
    assert.ok(!text.includes('Synthetic Alpha') && !text.includes('Offene Absagen und Ersatzbedarfe'), 'no admin rows after account switch');
    assert.equal(await uiPage.getByRole('table').count(), 0);
    await uiPage.getByRole('button', { name: 'Abmelden', exact: true }).click().catch(async () => {
      await uiPage.getByRole('button', { name: /Menü/ }).click();
      await uiPage.getByRole('button', { name: 'Abmelden', exact: true }).click();
    });
    await uiPage.getByRole('heading', { name: 'Anmelden', exact: true }).waitFor({ timeout: 20000 });
  });

  await check('TEST-07a', 'network interruption shows a safe error; retry recovers with the real backend', async () => {
    await uiLogin(uiPage, 'admin-a');
    await uiPage.getByRole('heading', { name: 'Arbeitsübersicht' }).waitFor({ timeout: 20000 });
    await uiAdmin.setOffline(true);
    await uiPage.getByRole('button', { name: 'Liste aktualisieren' }).click();
    await uiPage.getByRole('alert').filter({ hasText: 'Verbindung fehlgeschlagen' }).waitFor();
    await uiAdmin.setOffline(false);
    await uiPage.getByRole('alert').getByRole('button', { name: 'Erneut versuchen' }).click();
    await uiPage.getByRole('table').waitFor();
  });

  await check('TEST-07b', 'real 403 after a role change: forbidden shown once in the UI, exactly one request, no loop', async () => {
    const demoCtx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'de-DE', timezoneId: 'America/Los_Angeles' });
    const demoPage = await demoCtx.newPage();
    await uiLogin(demoPage, 'demo-admin-a');
    await demoPage.getByRole('heading', { name: 'Arbeitsübersicht' }).waitFor({ timeout: 20000 });
    await demoPage.getByRole('table').waitFor();
    const requests = [];
    demoPage.on('request', (r) => { if (r.url().includes('/admin/work-queue')) requests.push(r.url()); });
    await pool.query("UPDATE accounts SET role='EMPLOYEE' WHERE id=$1", [ids.demoAdminA]);
    await demoPage.getByRole('button', { name: 'Liste aktualisieren' }).click();
    await demoPage.getByRole('alert').filter({ hasText: 'Kein Zugriff' }).waitFor({ timeout: 20000 });
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(requests.length, 1, `requests after 403: ${requests.length}`);
    report.security.demotedRole = { uiRequestsAfter403: requests.length };
    await demoPage.screenshot({ path: resolve(output, 'TEST-07b-forbidden.png'), fullPage: true });
    await pool.query("UPDATE accounts SET role='COMPANY_ADMIN' WHERE id=$1", [ids.demoAdminA]);
    await demoCtx.close();
  });

  await check('TEST-07c', 'pagination beyond the last page and empty company filter (real empty response)', async () => {
    await uiPage.goto(`${origin}/arbeitsuebersicht?month=2030-01`);
    await uiPage.getByText('Keine Vorgänge für diese Auswahl').waitFor();
    await uiPage.goto(`${origin}/arbeitsuebersicht?projectId=${ids.projB}`);
    await uiPage.getByRole('alert').filter({ hasText: 'Projekt nicht verfügbar' }).waitFor();
    await uiPage.getByRole('button', { name: 'Projektfilter entfernen' }).click();
    await uiPage.getByRole('table').waitFor();
  });

  await check('TEST-07d', 'controlled fault injection on the real page: impossible timestamp rejected, no page error', async () => {
    const before = report.pageErrors;
    await uiPage.route('**/api/v1/admin/work-queue?*', async (route) => {
      const real = await route.fetch();
      const body = await real.json();
      body.items[0].createdAt = '2026-13-01T10:00:00.000Z';
      await route.fulfill({ response: real, json: body });
    });
    await uiPage.goto(`${origin}/arbeitsuebersicht`);
    await uiPage.getByRole('alert').filter({ hasText: 'Antwort konnte nicht verarbeitet werden' }).waitFor();
    await uiPage.unroute('**/api/v1/admin/work-queue?*');
    assert.equal(report.pageErrors, before, 'no uncaught page error');
  });

  await check('TEST-08', 'UX: keyboard focus, 390px layout without horizontal overflow, German labels, console without uncaught errors', async () => {
    await uiPage.goto(`${origin}/arbeitsuebersicht`);
    await uiPage.getByRole('table').waitFor();
    await uiPage.getByRole('link', { name: /Vorgang öffnen für Synthetic Alpha/ }).first().focus();
    const focus = await uiPage.evaluate(() => ({ visible: document.activeElement.matches(':focus-visible'), outline: getComputedStyle(document.activeElement).outlineStyle }));
    assert.equal(focus.visible, true); assert.notEqual(focus.outline, 'none');
    await uiPage.setViewportSize({ width: 390, height: 844 });
    await uiPage.reload();
    await uiPage.getByRole('table').waitFor();
    const overflow = await uiPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `overflow ${overflow}px`);
    await shot('TEST-08-mobile-390');
    await uiPage.setViewportSize({ width: 1440, height: 1000 });
    assert.equal(report.pageErrors, 0, 'no uncaught page errors');
  });
} catch (error) {
  fatal = error;
  log('FATAL', String(error?.stack ?? error).slice(0, 800));
} finally {
  report.results = results;
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(output, 'sp19-backend-acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close();
  await pool.end();
  const passed = results.filter((r) => r.result === 'PASS').length;
  log(JSON.stringify({ passed, failed: results.length - passed, fatal: fatal ? String(fatal.message ?? fatal).slice(0, 200) : null }));
  process.exitCode = fatal || results.some((r) => r.result === 'FAIL') ? 1 : 0;
}
