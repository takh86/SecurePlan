/** SP-13 First Publish: real Chrome -> built React -> unmodified NestJS -> verified disposable PostgreSQL 17.
 * Playwright is an external, pinned test tool, not an application dependency (as in SP-10/SP-11/SP-12).
 * No mocked API, session injection, TLS bypass, .env fallback or browser storage.
 *
 * Fixture boundary: the harness inserts only PREREQUISITES directly (synthetic companies, accounts,
 * employees, projects, month assignments, shift times, one foreign-tenant plan). Every plan, duty,
 * publication, project deactivation and employee change asserted below is produced through the UI by
 * one of two administrators and read back from PostgreSQL. No publication is ever written by SQL.
 *
 * A1 (migration 0014): every project's operating calendar is configured ONLY through the authenticated
 * admin API (GET, then PATCH with the read's exact/effective/next preconditions and the session's CSRF
 * token, from inside the logged-in page) before any duty exists. No calendar row is ever written by SQL,
 * and no weekday set is a default: each set below is an explicit synthetic example. Groups A1-* execute
 * the I-cases of docs/reviews/sp13-a1-integration-plan.md that need no pre-A1 binary (I7 runs in
 * scripts/sp13-a1-legacy-browser-acceptance.mjs).
 *
 * The proxy observes publish requests (method, path, header presence, body length) and can drop a
 * committed answer (truncated body), refuse to forward a request (502) or fail one plan read (502).
 * It never alters a forwarded request. Idempotency keys stay in memory for hash comparison only.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer as httpServer, request as proxyRequest } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { verifyRecordedTestTarget } from './disposable-test-target.mjs';

// This MUST finish before opening a fixture connection or starting the backend.
const receipt = await verifyRecordedTestTarget();
const root = fileURLToPath(new URL('../', import.meta.url));
const tool = process.env.SECUREPLAN_PLAYWRIGHT_MODULE;
assert.ok(tool, 'Explicit external Playwright module is required');
const { chromium } = await import(pathToFileURL(resolve(tool)).href);
const output = process.env.SECUREPLAN_BROWSER_OUTPUT_DIR;
assert.ok(output, 'An explicit private evidence directory is required');
await mkdir(output, { recursive: true });
const { hashPassword } = await import('../apps/backend/dist/auth/password-hasher.js');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const report = {
  startedAt: new Date().toISOString(),
  cluster: receipt.cluster,
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceDirty: execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim() !== '',
  browser: null,
  results: [],
  pageErrors: [],
  consoleErrors: 0,
  consoleCategories: {},
};

// Synthetic identities (random per run) and data; examples, not business rules.
const ids = {
  company: randomUUID(), foreignCompany: randomUUID(),
  admin: randomUUID(), secondAdmin: randomUUID(), foreignAdmin: randomUUID(),
  alphaAccount: randomUUID(), bravoAccount: randomUUID(), charlieAccount: randomUUID(),
  deltaAccount: randomUUID(), echoAccount: randomUUID(),
  alpha: randomUUID(), bravo: randomUUID(), charlie: randomUUID(), delta: randomUUID(), echo: randomUUID(),
  foreignProject: randomUUID(), foreignPlan: randomUUID(),
};
const PROJECTS = {
  hafen: 'Synthetic Objekt Hafen', nord: 'Synthetic Objekt Nord', sued: 'Synthetic Objekt Süd',
  west: 'Synthetic Objekt West', ost: 'Synthetic Objekt Ost', mitte: 'Synthetic Objekt Mitte',
  kai: 'Synthetic Objekt Kai', werft: 'Synthetic Objekt Werft',
  // A1 groups: starts WITHOUT a calendar (MISSING) on purpose.
  kalender: 'Synthetic Objekt Kalender',
};
/** Explicit synthetic example policy (ISO weekdays, Tuesday-Saturday); not a default or business rule. */
const POLICY = [2, 3, 4, 5, 6];
/** Every calendar write of this run, for the audit totals (codes and outcomes only). */
const calendarWrites = [];
const projectIds = Object.fromEntries(Object.keys(PROJECTS).map((key) => [key, randomUUID()]));
const password = randomBytes(24).toString('base64url');
const email = (label, id) => `browser-${label}-${id}@secureplan.invalid`;
const emails = { admin: email('admin', ids.admin), secondAdmin: email('admin', ids.secondAdmin) };
const FOREIGN_PROJECT = 'Synthetic Fremdmandant Objekt';
const MONTH = '2026-12';
const MONTH_LABEL = 'Dezember 2026';
const TRIGGER = 'Monatsplan veröffentlichen …';
const DIALOG = 'Monatsplan veröffentlichen?';
const SUCCESS = /^Der Monatsplan wurde veröffentlicht\./;

let backend; let frontend; let browser; let page; let other; let seeded = false;
/** Publish requests seen by the proxy; keys only in memory (never written to evidence). */
const proxy = { faultNextPublish: null, failNextPlanRead: false, publishes: [] };
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const sha256 = (value) => createHash('sha256').update(value).digest();

async function step(name, work) {
  try {
    await work();
    report.results.push({ name, result: 'PASS' });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.results.push({ name, result: 'FAIL' });
    throw error;
  }
}

async function freePort() {
  const server = httpServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const value = server.address().port;
  await new Promise((done) => server.close(done));
  return value;
}

// --- PostgreSQL read-back (the only persistence evidence) ---
async function planOf(projectId) {
  const { rows } = await pool.query(
    `SELECT id, status, published_at, published_by_account_id FROM monthly_plans
     WHERE company_id = $1 AND project_id = $2 AND planning_month = $3::date`, [ids.company, projectId, `${MONTH}-01`]);
  return rows[0] ?? null;
}
async function publishAudit(planId) {
  return (await pool.query(
    `SELECT actor_account_id, old_values, new_values FROM audit_event
     WHERE company_id = $1 AND action = 'MONTHLY_PLAN_PUBLISHED' AND resource_type = 'MONTHLY_PLAN' AND resource_id = $2`,
    [ids.company, planId])).rows;
}
async function reservations(planId) {
  return (await pool.query(
    `SELECT actor_account_id, state, key_hash, result_plan_id FROM idempotency_records
     WHERE company_id = $1 AND operation = 'INITIAL_PUBLISH' AND (result_plan_id = $2 OR $2 IS NULL) ORDER BY created_at`,
    [ids.company, planId])).rows;
}
async function liveDuties(planId) {
  return (await pool.query(
    'SELECT id, concurrency_version::text AS version FROM duties WHERE company_id = $1 AND monthly_plan_id = $2 AND removed_at IS NULL ORDER BY id',
    [ids.company, planId])).rows;
}
async function waitFor(check, message, timeout = 20_000) {
  const until = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    assert.ok(Date.now() < until, message);
    await wait(200);
  }
}

// --- Browser helpers ---
function observe(target) {
  target.on('pageerror', () => report.pageErrors.push('Uncaught browser exception'));
  // Only counted by category (HTTP status or net:: code); console text and URLs never enter evidence.
  target.on('console', (message) => {
    if (message.type() !== 'error') return;
    report.consoleErrors += 1;
    const text = message.text();
    const status = /^Failed to load resource: the server responded with a status of (\d{3})\b/.exec(text);
    const network = /^Failed to load resource: (net::[A-Z_]+)/.exec(text);
    const key = status ? `http-${status[1]}` : network ? network[1] : 'other';
    report.consoleCategories[key] = (report.consoleCategories[key] ?? 0) + 1;
  });
  return target;
}
async function login(context, path, address) {
  const opened = observe(await context.newPage());
  await opened.goto(`${origin}${path}`);
  await opened.getByLabel('E-Mail-Adresse').fill(address);
  await opened.getByLabel('Passwort', { exact: true }).fill(password);
  const response = opened.waitForResponse((r) => r.url().endsWith('/api/v1/auth/login') && r.request().method() === 'POST');
  await opened.getByRole('button', { name: 'Anmelden', exact: true }).click();
  assert.equal((await response).status(), 200);
  await opened.getByRole('navigation', { name: 'Hauptnavigation' }).waitFor();
  return opened;
}
const region = (target, name) => target.getByRole('region', { name, exact: true });
const grid = (target) => target.getByRole('grid', { name: `Dienste im ${MONTH_LABEL} nach Person und Tag` });
const cellButton = (target, name) => grid(target).getByRole('button', { name, exact: true });
const trigger = (target) => region(target, 'Planstatus').getByRole('button', { name: TRIGGER, exact: true });
const dialogOf = (target) => target.getByRole('alertdialog', { name: DIALOG });
const alertTitled = (target, title) => target.getByRole('heading', { level: 2, name: title, exact: true });
async function focusIs(locator) { assert.ok(await locator.evaluate((el) => el === document.activeElement), 'focus'); }
async function noHorizontalPageScroll(target) {
  const [scroll, client] = await target.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  assert.ok(scroll <= client + 1, `horizontal page scroll: ${scroll} > ${client}`);
}
const publishesFor = (planId) => proxy.publishes.filter((entry) => entry.planId === planId);

/** Creates the plan of `project` through the month overview (UI) and returns its database row. */
async function createPlan(target, key) {
  await target.goto(`${origin}/monatsplanung?month=${MONTH}`);
  await target.getByRole('button', { name: `Monatsplan für ${PROJECTS[key]}, ${MONTH_LABEL} erstellen …`, exact: true }).click();
  await target.getByRole('button', { name: 'Monatsplan erstellen', exact: true }).click();
  await target.getByRole('heading', { level: 1, name: `${PROJECTS[key]} – ${MONTH_LABEL}` }).waitFor();
  await grid(target).waitFor();
  const row = await planOf(projectIds[key]);
  assert.ok(row && row.status === 'UNPUBLISHED' && row.published_at === null);
  return row;
}
async function openPlan(target, planId) {
  await target.goto(`${origin}/monatsplanung/${planId}`);
  await grid(target).waitFor();
  await waitFor(async () => (await trigger(target).getAttribute('aria-disabled')) === null, 'publish action ready', 10_000);
}
async function openDialog(target) {
  await trigger(target).click();
  const dialog = dialogOf(target);
  await dialog.waitFor();
  return dialog;
}

// --- A1 helpers ---
/**
 * One authenticated API call from inside the logged-in page: same-origin credentials, the browser's
 * own Origin, and the session's CSRF token read from GET /api/v1/me (as the app does after a reload).
 * Only status, the problem `code`, Cache-Control and the parsed body are returned; nothing is logged.
 */
async function adminApi(target, method, path, body = null, extraHeaders = {}) {
  return target.evaluate(async ([verb, url, payload, extra]) => {
    const headers = { ...extra };
    if (verb !== 'GET') {
      const me = await fetch('/api/v1/me', { credentials: 'same-origin', cache: 'no-store' });
      headers['X-CSRF-Token'] = me.headers.get('X-CSRF-Token') ?? '';
    }
    if (payload !== null) headers['Content-Type'] = 'application/json';
    const response = await fetch(url, {
      method: verb, credentials: 'same-origin', cache: 'no-store', headers,
      body: payload === null ? undefined : JSON.stringify(payload),
    });
    let json = null;
    try { json = await response.json(); } catch { /* empty body */ }
    return {
      status: response.status, cacheControl: response.headers.get('cache-control'),
      replayed: response.headers.get('idempotency-replayed'), body: json, code: json && typeof json.code === 'string' ? json.code : null,
    };
  }, [method, path, body, extraHeaders]);
}
const calendarPath = (projectId) => `/api/v1/projects/${projectId}/operating-calendar`;
async function readCalendar(target, projectId, month = `${MONTH}-01`) {
  const read = await adminApi(target, 'GET', `${calendarPath(projectId)}?effectiveForMonth=${month}`);
  assert.equal(read.status, 200, 'calendar read');
  assert.equal(read.cacheControl, 'no-store');
  return read.body;
}
/** PATCH with the given read's preconditions (or explicit stale ones). Records outcome/code for the totals. */
async function patchCalendar(target, key, read, { weekdays, month = `${MONTH}-01`, bootstrap = false, projectId = projectIds[key] }) {
  const answer = await adminApi(target, 'PATCH', calendarPath(projectId), {
    effectiveFromMonth: month,
    expectedExactVersion: read.exactVersion,
    expectedEffective: read.effective ? { id: read.effective.id, version: read.effective.version } : null,
    expectedNextEffectiveFromMonth: read.nextEffectiveFromMonth,
    operatingWeekdays: weekdays,
    bootstrap,
  });
  calendarWrites.push({ key, status: answer.status, outcome: answer.body?.outcome ?? null, code: answer.code });
  assert.equal(answer.cacheControl, 'no-store', 'calendar answers are no-store');
  return answer;
}
/** Explicit configuration of one project for the plan month: GET (must be MISSING), then PATCH. */
async function configureCalendar(target, key, weekdays = POLICY) {
  const read = await readCalendar(target, projectIds[key]);
  assert.deepEqual([read.state, read.effective, read.exactVersion], ['MISSING', null, null], `${key}: no default calendar`);
  const answer = await patchCalendar(target, key, read, { weekdays });
  assert.equal(answer.status, 200, `${key}: calendar PATCH`);
  assert.deepEqual([answer.body.outcome, answer.body.state, answer.body.effective.operatingWeekdays, answer.body.effective.version],
    ['APPLIED', 'CONFIGURED', weekdays, 1]);
  return answer.body;
}
async function calendarRows(projectId) {
  return (await pool.query(
    `SELECT id, to_char(effective_from_month, 'YYYY-MM-DD') AS month, weekday_mask, version::text AS version
     FROM project_operating_calendars WHERE company_id = $1 AND project_id = $2 ORDER BY effective_from_month`,
    [ids.company, projectId])).rows;
}
async function calendarAudits(companyId = ids.company) {
  return (await pool.query(
    `SELECT resource_id, old_values, new_values FROM audit_event
     WHERE company_id = $1 AND action = 'PROJECT_OPERATING_CALENDAR_UPDATED' ORDER BY occurred_at`, [companyId])).rows;
}
async function dutyRows(planId) {
  return (await pool.query(
    `SELECT d.id, to_char(d.duty_date, 'YYYY-MM-DD') AS date, d.shift_kind AS kind, d.concurrency_version::text AS version,
       ARRAY(SELECT pa.employee_id::text || ':' || pa.duty_function FROM plan_assignments pa
             WHERE pa.company_id = d.company_id AND pa.duty_id = d.id AND pa.state = 'ACTIVE' ORDER BY pa.employee_id) AS members
     FROM duties d WHERE d.company_id = $1 AND d.monthly_plan_id = $2 AND d.removed_at IS NULL ORDER BY d.duty_date, d.shift_kind`,
    [ids.company, planId])).rows;
}
/** Closes a focus panel; unsaved input is discarded through the page's own guard. */
async function closePanel(target, panel) {
  if (await panel.count() === 0) return;
  await panel.getByRole('button', { name: 'Schließen', exact: true }).first().click();
  const leave = target.getByRole('button', { name: /^(Eingaben|Änderungen) verwerfen und wechseln$/ });
  if (await leave.waitFor({ timeout: 2000 }).then(() => true, () => false)) await leave.click();
  await panel.waitFor({ state: 'detached' });
}
const closeCreateForm = (target) => closePanel(target, region(target, 'Dienst hinzufügen'));
/** Creates a duty through the "Dienst hinzufügen" form; returns the server's status and problem code. */
async function submitDuty(target, { date, kind, people = [] }) {
  await closeCreateForm(target);
  await target.getByRole('button', { name: 'Dienst hinzufügen', exact: true }).click();
  const form = region(target, 'Dienst hinzufügen');
  await form.getByLabel('Datum').fill(date);
  await form.getByRole('radio', { name: kind === 'DAY' ? 'Tagdienst' : 'Nachtdienst', exact: true }).check();
  for (const person of people) await form.getByRole('checkbox', { name: new RegExp(`^${person} `) }).check();
  const answer = target.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/entries'));
  await form.getByRole('button', { name: 'Dienst anlegen', exact: true }).click();
  const response = await answer;
  const status = response.status();
  const code = status >= 400 ? ((await response.json().catch(() => null))?.code ?? null) : null;
  // A saved duty closes its panel (the notice takes focus); a refusal keeps the form and its input.
  if (status === 201) await form.waitFor({ state: 'detached' });
  return { form, status, code };
}
/** Opens the SP-12 editor of a duty from its day row and waits for the lease. */
async function openEditor(target, dayCell, dayRegion, kindLabel, panelName) {
  await grid(target).getByRole('button', { name: dayCell }).click();
  await region(target, dayRegion).getByRole('button', { name: `${kindLabel} bearbeiten`, exact: true }).click();
  const panel = region(target, panelName);
  await panel.getByText('Für Sie reserviert').waitFor();
  return panel;
}
async function saveEditor(target, panel) {
  const answer = target.waitForResponse((r) => r.request().method() === 'PATCH' && /\/entries\/[^/]+$/.test(new URL(r.url()).pathname));
  await panel.getByRole('button', { name: 'Änderungen speichern', exact: true }).click();
  const response = await answer;
  const status = response.status();
  const code = status >= 400 ? ((await response.json().catch(() => null))?.code ?? null) : null;
  if (status === 200) await panel.waitFor({ state: 'detached' });
  return { status, code };
}
/** The planning alert in a region: German title + outcome sentence, and no person, date or reason in the text. */
async function assertRefusal(container, title, outcome) {
  const heading = container.getByRole('heading', { name: title, exact: true });
  await heading.waitFor();
  const text = (await heading.locator('xpath=ancestor::*[@role="alert"][1]').innerText()).replace(/\s+/g, ' ');
  assert.ok(text.includes(outcome), `${title}: outcome sentence`);
  assert.doesNotMatch(text, /Synthetic|\d{2}\.\d{2}\.\d{4}|krank|urlaub/i, `${title}: privacy-safe`);
}

let origin;
try {
  const backendPort = await freePort();
  const frontendPort = await freePort();
  origin = `https://localhost:${frontendPort}`;
  backend = spawn(process.execPath, ['apps/backend/dist/main.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(backendPort), APP_ORIGIN: origin },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  // Logs are deliberately not copied into evidence (no request or credential logging).
  backend.stdout.resume(); backend.stderr.resume();
  const until = Date.now() + 15_000;
  while (true) {
    if (backend.exitCode !== null) throw new Error('Isolated backend failed to start');
    try { if ((await fetch(`http://127.0.0.1:${backendPort}/api/v1/health/ready`)).status === 200) break; } catch { /* starting */ }
    assert.ok(Date.now() < until, 'Isolated backend readiness timeout');
    await wait(100);
  }
  const dist = resolve(root, 'apps/frontend/dist');
  frontend = httpsServer({
    key: await readFile(resolve(root, 'infra/tls/localhost-key.pem')),
    cert: await readFile(resolve(root, 'infra/tls/localhost.pem')),
  }, async (req, res) => {
    if (req.url.startsWith('/api/')) {
      const publishMatch = req.method === 'POST' ? /^\/api\/v1\/monthly-plans\/([^/]+)\/publish$/.exec(req.url) : null;
      const isPlanRead = req.method === 'GET' && /^\/api\/v1\/monthly-plans\/[^/?]+$/.test(req.url);
      if (isPlanRead && proxy.failNextPlanRead) {
        // One plan read never reaches the server (gateway failure).
        proxy.failNextPlanRead = false;
        res.writeHead(502); res.end();
        return;
      }
      let entry = null;
      if (publishMatch) {
        entry = {
          planId: publishMatch[1],
          key: req.headers['idempotency-key'] ?? null,
          csrf: typeof req.headers['x-csrf-token'] === 'string' && req.headers['x-csrf-token'].length > 0,
          origin: req.headers.origin === origin,
          contentType: req.headers['content-type'] ?? null,
          contentLength: req.headers['content-length'] ?? null,
          transferEncoding: req.headers['transfer-encoding'] ?? null,
          expectedVersion: req.headers['expected-version'] ?? null,
          leaseToken: req.headers['edit-lease-token'] !== undefined,
          bodyBytes: 0,
          forwarded: true,
          status: null,
          replayed: null,
          cacheControl: null,
        };
        proxy.publishes.push(entry);
      }
      const fault = publishMatch ? proxy.faultNextPublish : null;
      if (fault) proxy.faultNextPublish = null;
      if (fault === 'gateway') {
        // The command never reaches the server; the browser sees a 502 without any problem body.
        entry.forwarded = false;
        req.resume();
        req.on('end', () => { res.writeHead(502); res.end(); });
        return;
      }
      const upstream = proxyRequest({
        hostname: '127.0.0.1', port: backendPort, path: req.url, method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${backendPort}` },
      }, (reply) => {
        if (entry) {
          entry.status = reply.statusCode;
          entry.replayed = reply.headers['idempotency-replayed'] ?? null;
          entry.cacheControl = reply.headers['cache-control'] ?? null;
        }
        if (fault === 'truncate') {
          // Real success headers, then a truncated body AFTER PostgreSQL committed:
          // the browser cannot read the answer and must not claim success or failure.
          res.writeHead(reply.statusCode, reply.headers); res.flushHeaders();
          reply.resume(); reply.on('end', () => { res.write('{'); res.destroy(); });
          return;
        }
        res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
      });
      upstream.on('error', () => { res.writeHead(502); res.end(); });
      if (entry) req.on('data', (chunk) => { entry.bodyBytes += chunk.length; });
      req.pipe(upstream);
      return;
    }
    try {
      const pathname = new URL(req.url, origin).pathname;
      const asset = pathname.startsWith('/assets/');
      const file = asset ? resolve(dist, `.${pathname}`) : resolve(dist, 'index.html');
      if (!file.startsWith(`${dist}${sep}`)) throw new Error('Invalid asset path');
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(await readFile(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((done) => frontend.listen(frontendPort, '127.0.0.1', done));
  // The installed, supported Chrome channel with normal certificate validation.
  browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
  report.browser = browser.version();
  const contextOptions = { viewport: { width: 1440, height: 1000 }, locale: 'de-DE', timezoneId: 'Europe/Berlin' };
  const context = await browser.newContext(contextOptions);

  // --- Synthetic prerequisites (direct inserts; never used as persistence evidence) ---
  await verifyRecordedTestTarget();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hash = await hashPassword(password);
    await client.query("INSERT INTO companies(id,name,status,time_zone) VALUES($1,'Synthetic SP-13 Acceptance','ACTIVE','Europe/Berlin')", [ids.company]);
    await client.query("INSERT INTO companies(id,name,status,time_zone) VALUES($1,'Synthetic Foreign Tenant','ACTIVE','Europe/Berlin')", [ids.foreignCompany]);
    const accounts = [
      [ids.admin, ids.company, emails.admin, 'COMPANY_ADMIN'],
      [ids.secondAdmin, ids.company, emails.secondAdmin, 'COMPANY_ADMIN'],
      [ids.foreignAdmin, ids.foreignCompany, email('foreign-admin', ids.foreignAdmin), 'COMPANY_ADMIN'],
      [ids.alphaAccount, ids.company, email('employee', ids.alphaAccount), 'EMPLOYEE'],
      [ids.bravoAccount, ids.company, email('employee', ids.bravoAccount), 'EMPLOYEE'],
      [ids.charlieAccount, ids.company, email('employee', ids.charlieAccount), 'EMPLOYEE'],
      [ids.deltaAccount, ids.company, email('employee', ids.deltaAccount), 'EMPLOYEE'],
      [ids.echoAccount, ids.company, email('employee', ids.echoAccount), 'EMPLOYEE'],
    ];
    for (const [accountId, companyId, address, role] of accounts) {
      await client.query("INSERT INTO accounts(id,company_id,email,account_scope,role,status,password_hash) VALUES($1,$2,$3,'TENANT',$4,'ACTIVE',$5)",
        [accountId, companyId, address, role, hash]);
    }
    const staff = [
      [ids.alpha, ids.alphaAccount, 'SYN-ALPHA', 'Synthetic', 'Alpha', 'BOTH'],
      [ids.bravo, ids.bravoAccount, 'SYN-BRAVO', 'Synthetic', 'Bravo', 'TAG'],
      [ids.charlie, ids.charlieAccount, 'SYN-CHARLIE', 'Synthetic', 'Charlie', 'BOTH'],
      [ids.delta, ids.deltaAccount, 'SYN-DELTA', 'Synthetic', 'Delta', 'BOTH'],
      [ids.echo, ids.echoAccount, 'SYN-ECHO', 'Synthetic', 'Echo', 'BOTH'],
    ];
    for (const [employeeId, accountId, number, first, last, eligibility] of staff) {
      await client.query(
        "INSERT INTO employees(id,company_id,account_id,employee_number,first_name,last_name,shift_eligibility,employment_start) VALUES($1,$2,$3,$4,$5,$6,$7,'2020-01-01')",
        [employeeId, ids.company, accountId, number, first, last, eligibility]);
    }
    for (const [key, name] of Object.entries(PROJECTS)) {
      await client.query("INSERT INTO projects(id,company_id,name,status) VALUES($1,$2,$3,'ACTIVE')", [projectIds[key], ids.company, name]);
      // Example shift times for the plan month (company local time), not business rules.
      for (const [kind, start, end] of [['TAG', '06:00', '18:00'], ['NACHT', '18:00', '06:00']]) {
        await client.query(
          `INSERT INTO shift_configurations(company_id,project_id,effective_from_month,shift_kind,start_local,end_local)
           VALUES($1,$2,$3::date,$4,$5::time,$6::time)`, [ids.company, projectIds[key], `${MONTH}-01`, kind, start, end]);
      }
    }
    await client.query("INSERT INTO projects(id,company_id,name,status) VALUES($1,$2,$3,'ACTIVE')", [ids.foreignProject, ids.foreignCompany, FOREIGN_PROJECT]);
    // One project per person and month (UNIQUE in 0008): Alpha and Bravo at Hafen, Charlie at Werft,
    // Delta and Echo at Kalender (A1 groups).
    for (const [employeeId, projectId] of [[ids.alpha, projectIds.hafen], [ids.bravo, projectIds.hafen], [ids.charlie, projectIds.werft],
      [ids.delta, projectIds.kalender], [ids.echo, projectIds.kalender]]) {
      await client.query('INSERT INTO project_assignments(company_id,employee_id,project_id,planning_month) VALUES($1,$2,$3,$4::date)',
        [ids.company, employeeId, projectId, `${MONTH}-01`]);
    }
    // A plan of ANOTHER tenant, for the isolation check only.
    await client.query('INSERT INTO monthly_plans(id,company_id,project_id,planning_month) VALUES($1,$2,$3,$4::date)',
      [ids.foreignPlan, ids.foreignCompany, ids.foreignProject, `${MONTH}-01`]);
    await client.query('COMMIT');
    seeded = true;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  const foreignBefore = JSON.stringify((await pool.query('SELECT id, status, published_at FROM monthly_plans WHERE company_id = $1', [ids.foreignCompany])).rows);

  const plans = {};
  await step('A1-0 (I0) before any duty: every regression project reads MISSING (no default) and is configured explicitly through the admin API', async () => {
    page = await login(context, `/monatsplanung?month=${MONTH}`, emails.admin);
    for (const key of ['hafen', 'nord', 'sued', 'west', 'ost', 'mitte', 'kai', 'werft']) {
      assert.equal((await calendarRows(projectIds[key])).length, 0, `${key}: no calendar row before the API write`);
      await configureCalendar(page, key);
      const rows = await calendarRows(projectIds[key]);
      assert.deepEqual(rows.map((row) => [row.month, row.weekday_mask, row.version]), [[`${MONTH}-01`, 62, '1']], key);
    }
    assert.equal((await calendarRows(projectIds.kalender)).length, 0, 'the A1 project stays MISSING for now');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM duties WHERE company_id = $1', [ids.company])).rows[0].n, 0,
      'no duty exists before the calendars');
  });

  await step('P01 plan and duties created through the UI; the plan status offers the First Publish action', async () => {
    plans.hafen = (await createPlan(page, 'hafen')).id;
    await cellButton(page, 'Synthetic Alpha, Do., 3. Dezember: frei').click();
    await region(page, 'Synthetic Alpha · Do., 03.12.2026').getByRole('button', { name: 'Tagdienst anlegen', exact: true }).click();
    const form = region(page, 'Dienst hinzufügen');
    await form.getByText('Tagdienst: 06:00 – 18:00').waitFor();
    await form.getByRole('combobox', { name: 'Funktion im Dienst für Synthetic Alpha' }).selectOption({ label: 'Schichtleitung' });
    await form.getByRole('checkbox', { name: /^Synthetic Bravo/ }).check();
    await form.getByRole('button', { name: 'Dienst anlegen', exact: true }).click();
    await page.getByText('Der Tagdienst am Do., 03.12.2026 wurde angelegt.', { exact: true }).waitFor();
    // An unstaffed duty is allowed: no staffing minimum exists.
    await cellButton(page, 'Do., 31. Dezember: kein Tagdienst; kein Nachtdienst').click();
    await region(page, 'Dienste am Do., 31.12.2026').getByRole('button', { name: 'Nachtdienst anlegen', exact: true }).click();
    await region(page, 'Dienst hinzufügen').getByRole('button', { name: 'Dienst anlegen', exact: true }).click();
    await page.getByText('Der Nachtdienst am Do., 31.12.2026 wurde angelegt.', { exact: true }).waitFor();
    assert.equal((await liveDuties(plans.hafen)).length, 2);
    await waitFor(async () => (await trigger(page).getAttribute('aria-disabled')) === null, 'publish action ready');
    assert.equal(await trigger(page).getAttribute('aria-haspopup'), 'dialog');
  });

  await step('P02 unsaved input blocks the action with its reason; no dialog, no request', async () => {
    await region(page, 'Planstatus').waitFor();
    await page.getByRole('button', { name: 'Dienst hinzufügen', exact: true }).click();
    const form = region(page, 'Dienst hinzufügen');
    await form.getByLabel('Datum').fill('2026-12-10');
    await waitFor(async () => (await trigger(page).getAttribute('aria-disabled')) === 'true', 'blocked while input is unsaved');
    const reasonId = await trigger(page).getAttribute('aria-describedby');
    assert.match(await page.locator(`[id="${reasonId}"]`).innerText(), /ungespeicherte Eingaben/);
    // aria-disabled keeps the control focusable; a forced click proves it opens nothing.
    await trigger(page).click({ force: true });
    assert.equal(await dialogOf(page).count(), 0);
    await form.getByRole('button', { name: 'Schließen', exact: true }).click();
    await form.getByRole('button', { name: 'Eingaben verwerfen und wechseln', exact: true }).click();
    await waitFor(async () => (await trigger(page).getAttribute('aria-disabled')) === null, 'unblocked after discarding');
    assert.equal(publishesFor(plans.hafen).length, 0);
  });

  await step('P03 keyboard: Enter opens a real modal alertdialog (page inert, focus on "Abbrechen", Tab stays inside); Escape cancels', async () => {
    await trigger(page).focus();
    await page.keyboard.press('Enter');
    const dialog = dialogOf(page);
    await dialog.waitFor();
    assert.equal(await dialog.evaluate((el) => el.tagName === 'DIALOG' && el.matches(':modal')), true, 'opened with showModal()');
    await focusIs(dialog.getByRole('button', { name: 'Abbrechen', exact: true }));
    assert.match(await dialog.innerText(), new RegExp(`Sie veröffentlichen den Monatsplan ${PROJECTS.hafen} – ${MONTH_LABEL} zum ersten Mal`));
    assert.equal(await dialog.locator('dt', { hasText: 'Dienste' }).locator('xpath=following-sibling::dd').innerText(), '2 (davon 1 ohne Besetzung)');
    assert.equal(await dialog.locator('dt', { hasText: 'Eingeplante Personen' }).locator('xpath=following-sibling::dd').innerText(), '2');
    // Versionless contract: commit-time state, no snapshot promise; no employee view (SP-14) and no notification.
    const wording = (await dialog.innerText()).replace(/\s+/g, ' ');
    assert.match(wording, /Veröffentlicht wird der Stand, der beim Abschluss auf dem Server gespeichert ist\./);
    assert.match(wording, /Dass genau der angezeigte Stand veröffentlicht wird, ist nicht garantiert\./);
    assert.match(wording, /Es wird keine Benachrichtigung versendet\. Mitarbeitende können veröffentlichte Monatspläne in dieser Ausbaustufe noch nicht abrufen\./);
    assert.doesNotMatch(wording, /Mitarbeitende sehen/);
    // The page behind the modal is inert: the back link under the backdrop is not hit.
    const box = await page.getByRole('link', { name: 'Zurück zur Übersicht', exact: true }).boundingBox();
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('a')?.textContent ?? null, [box.x + box.width / 2, box.y + box.height / 2]);
    assert.equal(hit, null, 'background link is not reachable');
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => {
        const active = document.activeElement;
        return active === document.body || active === null || document.querySelector('dialog')?.contains(active) === true;
      });
      assert.ok(inside, 'Tab never reaches the inert page');
    }
    await page.screenshot({ path: resolve(output, 'sp13-publish-dialog-desktop.png') });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await focusIs(trigger(page));
    assert.equal(publishesFor(plans.hafen).length, 0, 'nothing sent');
    assert.equal((await planOf(projectIds.hafen)).status, 'UNPUBLISHED');
  });

  await step('P04 double click on "Jetzt veröffentlichen": exactly one bodyless POST with key + CSRF; PUBLISHED from the answer; one audit', async () => {
    const dialog = await openDialog(page);
    await dialog.getByRole('button', { name: 'Jetzt veröffentlichen', exact: true }).dblclick();
    const notice = page.getByText(SUCCESS);
    await notice.waitFor();
    const sent = publishesFor(plans.hafen);
    assert.equal(sent.length, 1, 'exactly one publish request');
    const [request] = sent;
    assert.match(request.key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(request.csrf && request.origin, 'CSRF token and same Origin');
    assert.equal(request.bodyBytes, 0, 'no body bytes');
    assert.equal(request.contentType, null, 'no Content-Type');
    assert.equal(request.transferEncoding, null);
    assert.ok(request.contentLength === null || request.contentLength === '0');
    assert.equal(request.expectedVersion, null);
    assert.equal(request.leaseToken, false);
    assert.deepEqual([request.status, request.replayed, request.cacheControl], [200, 'false', 'no-store']);
    const row = await planOf(projectIds.hafen);
    assert.equal(row.status, 'PUBLISHED');
    assert.equal(row.published_by_account_id, ids.admin);
    const audit = await publishAudit(plans.hafen);
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0].old_values, { status: 'UNPUBLISHED', publishedAt: null });
    assert.equal(audit[0].new_values.status, 'PUBLISHED');
    const records = await reservations(plans.hafen);
    assert.equal(records.length, 1);
    assert.equal(records[0].state, 'COMPLETED');
    assert.ok(records[0].key_hash.equals(sha256(request.key)), 'only the hash of the browser key is stored');
    await focusIs(page.locator('.planning-publish__outcome'));
    const statusText = (await region(page, 'Planstatus').innerText()).replace(/\s+/g, ' ');
    assert.match(statusText, /Veröffentlicht am .*Änderungen an Diensten gelten sofort, ohne erneutes Veröffentlichen\./);
    assert.match(statusText, /Mitarbeitende können veröffentlichte Monatspläne in dieser Ausbaustufe noch nicht abrufen\./);
    assert.doesNotMatch(statusText, /Mitarbeitende sehen/);
    assert.equal(await trigger(page).count(), 0, 'no re-publish action');
    assert.ok(!(await page.content()).includes(request.key), 'key not in the DOM');
    report.publishedAt = row.published_at.toISOString();
  });

  await step('P05 CR-03: after the First Publish an editor change applies directly; the plan stays PUBLISHED with the same instant', async () => {
    await cellButton(page, 'Synthetic Bravo, Do., 3. Dezember: Tagdienst').click();
    await page.getByRole('region', { name: /03\.12\.2026/ }).getByRole('button', { name: 'Tagdienst bearbeiten', exact: true }).click();
    const panel = region(page, 'Tagdienst am Do., 03.12.2026 bearbeiten');
    await panel.getByText('Für Sie reserviert').waitFor();
    await panel.getByText(/Gespeicherte Änderungen gelten sofort im veröffentlichten Plan/).waitFor();
    await panel.getByRole('checkbox', { name: /^Synthetic Bravo/ }).uncheck();
    await panel.getByRole('button', { name: 'Änderungen speichern', exact: true }).click();
    await page.getByText(/wurden gespeichert\. Der Plan ist veröffentlicht: Die Änderung gilt sofort, ohne erneutes Veröffentlichen\./).waitFor();
    const row = await planOf(projectIds.hafen);
    assert.deepEqual([row.status, row.published_at.toISOString()], ['PUBLISHED', report.publishedAt]);
    assert.equal(publishesFor(plans.hafen).length, 1, 'no second publish');
    assert.equal((await publishAudit(plans.hafen)).length, 1);
  });

  await step('P06 committed but the answer is lost (truncated body): nothing claimed until a GET shows PUBLISHED; one publication', async () => {
    plans.nord = (await createPlan(page, 'nord')).id;
    await openPlan(page, plans.nord);
    const dialog = await openDialog(page);
    proxy.faultNextPublish = 'truncate';
    await dialog.getByRole('button', { name: 'Jetzt veröffentlichen', exact: true }).click();
    await page.getByText(/Das hat das erneute Laden des aktuellen Stands bestätigt\./).waitFor();
    assert.equal(publishesFor(plans.nord).length, 1, 'no automatic resend');
    assert.equal((await planOf(projectIds.nord)).status, 'PUBLISHED');
    assert.equal((await publishAudit(plans.nord)).length, 1);
    assert.match(await region(page, 'Planstatus').innerText(), /Veröffentlicht am/);
  });

  await step('P07 committed, answer lost AND the check read fails: the same key is resent and answered by the server replay', async () => {
    plans.sued = (await createPlan(page, 'sued')).id;
    await openPlan(page, plans.sued);
    const dialog = await openDialog(page);
    proxy.faultNextPublish = 'truncate';
    proxy.failNextPlanRead = true;
    await dialog.getByRole('button', { name: 'Jetzt veröffentlichen', exact: true }).click();
    await dialog.getByRole('heading', { level: 3, name: 'Ergebnis unbekannt', exact: true }).waitFor();
    await focusIs(dialog.getByRole('heading', { level: 3, name: 'Ergebnis unbekannt', exact: true }));
    assert.match(await dialog.innerText(), /Der aktuelle Stand des Plans konnte nicht geladen werden\./);
    assert.match(await region(page, 'Planstatus').innerText(), /Unveröffentlicht/, 'nothing claimed');
    assert.equal((await planOf(projectIds.sued)).status, 'PUBLISHED', 'the server did commit');
    await dialog.getByRole('button', { name: 'Erneut anfragen', exact: true }).click();
    await page.getByText(/erneute Anfrage mit demselben Vorgang bestätigt/).waitFor();
    const [first, second] = publishesFor(plans.sued);
    assert.equal(publishesFor(plans.sued).length, 2);
    assert.equal(second.key, first.key, 'same key');
    assert.deepEqual([second.status, second.replayed], [200, 'true'], 'answered by the replay');
    assert.equal((await publishAudit(plans.sued)).length, 1, 'no second audit');
    assert.equal((await reservations(plans.sued)).length, 1);
  });

  await step('P08 the command never reaches the server (502): outcome open, plan reads UNPUBLISHED; the resend with the same key publishes once', async () => {
    plans.west = (await createPlan(page, 'west')).id;
    await openPlan(page, plans.west);
    const dialog = await openDialog(page);
    proxy.faultNextPublish = 'gateway';
    await dialog.getByRole('button', { name: 'Jetzt veröffentlichen', exact: true }).click();
    await dialog.getByRole('heading', { level: 3, name: 'Ergebnis unbekannt', exact: true }).waitFor();
    assert.match(await dialog.innerText(), /Laut aktuellem Stand ist der Plan noch nicht veröffentlicht\./);
    assert.equal((await planOf(projectIds.west)).status, 'UNPUBLISHED');
    await dialog.getByRole('button', { name: 'Erneut anfragen', exact: true }).click();
    await page.getByText(/erneute Anfrage mit demselben Vorgang bestätigt/).waitFor();
    const [first, second] = publishesFor(plans.west);
    assert.equal(first.forwarded, false);
    assert.equal(second.key, first.key);
    assert.deepEqual([second.status, second.replayed], [200, 'false'], 'the first execution');
    assert.equal((await publishAudit(plans.west)).length, 1);
  });

  const otherContext = await browser.newContext(contextOptions);
  other = await login(otherContext, `/monatsplanung?month=${MONTH}`, emails.secondAdmin);

  await step('P09 another admin adds a duty while the dialog is open: nothing is sent; reload; a new decision publishes', async () => {
    plans.ost = (await createPlan(page, 'ost')).id;
    await openPlan(page, plans.ost);
    const dialog = await openDialog(page);
    assert.equal(await dialog.locator('dt', { hasText: 'Dienste' }).locator('xpath=following-sibling::dd').innerText(), 'keine');
    // Second admin, own browser context: one unstaffed day duty through the UI.
    await other.goto(`${origin}/monatsplanung/${plans.ost}`);
    await cellButton(other, 'Mi., 9. Dezember: kein Tagdienst; kein Nachtdienst').click();
    await region(other, 'Dienste am Mi., 09.12.2026').getByRole('button', { name: 'Tagdienst anlegen', exact: true }).click();
    await region(other, 'Dienst hinzufügen').getByRole('button', { name: 'Dienst anlegen', exact: true }).click();
    await other.getByText('Der Tagdienst am Mi., 09.12.2026 wurde angelegt.', { exact: true }).waitFor();

    await dialog.getByRole('button', { name: 'Jetzt veröffentlichen', exact: true }).click();
    await alertTitled(page, 'Plan wurde inzwischen geändert').waitFor();
    assert.equal(publishesFor(plans.ost).length, 0, 'no command for a stale decision');
    assert.equal((await planOf(projectIds.ost)).status, 'UNPUBLISHED');
    await cellButton(page, 'Mi., 9. Dezember: Tagdienst, ohne Besetzung; kein Nachtdienst').waitFor();
    await waitFor(async () => (await trigger(page).getAttribute('aria-disabled')) === null, 'ready after reload');
    const again = await openDialog(page);
    assert.equal(await again.locator('dt', { hasText: 'Dienste' }).locator('xpath=following-sibling::dd').innerText(), '1 (davon 1 ohne Besetzung)');
    await again.getByRole('button', { name: 'Jetzt veröffentlichen', exact: true }).click();
    await page.getByText(SUCCESS).waitFor();
    assert.equal(publishesFor(plans.ost).length, 1);
    assert.equal((await planOf(projectIds.ost)).status, 'PUBLISHED');
  });

  await step('P10 another admin publishes first: 409 MONTHLY_PLAN_ALREADY_PUBLISHED, reload shows PUBLISHED, no re-publish', async () => {
    plans.mitte = (await createPlan(page, 'mitte')).id;
    await openPlan(page, plans.mitte);
    const dialog = await openDialog(page);
    await openPlan(other, plans.mitte);
    const theirs = await openDialog(other);
    await theirs.getByRole('button', { name: 'Jetzt veröffentlichen', exact: true }).click();
    await other.getByText(SUCCESS).waitFor();
    await dialog.getByRole('button', { name: 'Jetzt veröffentlichen', exact: true }).click();
    await alertTitled(page, 'Bereits veröffentlicht').waitFor();
    await waitFor(async () => /Veröffentlicht am/.test(await region(page, 'Planstatus').innerText()), 'reloaded status');
    assert.equal(await trigger(page).count(), 0);
    const row = await planOf(projectIds.mitte);
    assert.equal(row.published_by_account_id, ids.secondAdmin);
    assert.equal((await publishAudit(plans.mitte)).length, 1);
    const sent = publishesFor(plans.mitte);
    assert.deepEqual(sent.map((entry) => entry.status), [200, 409]);
    assert.notEqual(sent[0].key, sent[1].key);
  });

  await step('P11 another admin deactivates the project meanwhile: 409 PROJECT_INACTIVE; afterwards the action is unavailable', async () => {
    plans.kai = (await createPlan(page, 'kai')).id;
    await openPlan(page, plans.kai);
    const dialog = await openDialog(page);
    await other.goto(`${origin}/projekte/${projectIds.kai}`);
    await other.getByRole('button', { name: 'Projekt auf inaktiv setzen …', exact: true }).click();
    await other.getByRole('button', { name: 'Auf inaktiv setzen', exact: true }).click();
    await other.getByText('Das Projekt ist jetzt inaktiv.').waitFor();
    await dialog.getByRole('button', { name: 'Jetzt veröffentlichen', exact: true }).click();
    await alertTitled(page, 'Projekt ist inaktiv').waitFor();
    await waitFor(async () => (await trigger(page).getAttribute('aria-disabled')) === 'true', 'blocked after reload');
    const reasonId = await trigger(page).getAttribute('aria-describedby');
    assert.match(await page.locator(`[id="${reasonId}"]`).innerText(), /Das Projekt ist inaktiv\./);
    assert.equal((await planOf(projectIds.kai)).status, 'UNPUBLISHED');
    assert.equal((await publishAudit(plans.kai)).length, 0);
    // Reopened later: still unavailable, and a click opens nothing.
    await page.reload();
    await grid(page).waitFor();
    // aria-disabled keeps the control focusable; a forced click proves it opens nothing.
    await trigger(page).click({ force: true });
    assert.equal(await dialogOf(page).count(), 0);
    assert.deepEqual(publishesFor(plans.kai).map((entry) => entry.status), [409]);
  });

  await step('P12 narrow screen (390 px): the dialog fits without page scroll', async () => {
    plans.werft = (await createPlan(page, 'werft')).id;
    await cellButton(page, 'Synthetic Charlie, Do., 31. Dezember: frei').click();
    await region(page, 'Synthetic Charlie · Do., 31.12.2026').getByRole('button', { name: 'Nachtdienst anlegen', exact: true }).click();
    await region(page, 'Dienst hinzufügen').getByRole('button', { name: 'Dienst anlegen', exact: true }).click();
    await page.getByText('Der Nachtdienst am Do., 31.12.2026 wurde angelegt.', { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await openPlan(page, plans.werft);
    const dialog = await openDialog(page);
    const box = await dialog.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390, 'dialog within the viewport width');
    await noHorizontalPageScroll(page);
    await page.screenshot({ path: resolve(output, 'sp13-publish-dialog-390.png') });
    await dialog.getByRole('button', { name: 'Abbrechen', exact: true }).click();
    await page.setViewportSize(contextOptions.viewport);
  });

  await step('P13 another admin makes a member ineligible: the server refuses (409 EMPLOYEE_NOT_ELIGIBLE_FOR_SHIFT); nothing published', async () => {
    await other.goto(`${origin}/mitarbeitende/${ids.charlie}`);
    await other.getByRole('button', { name: 'Stammdaten bearbeiten', exact: true }).click();
    await other.getByRole('group', { name: 'Schicht-Eignung' }).getByRole('radio', { name: 'Tag', exact: true }).check();
    await other.getByRole('button', { name: 'Änderungen speichern', exact: true }).click();
    await other.getByText('Änderungen wurden gespeichert.').waitFor();
    await openPlan(page, plans.werft);
    const dialog = await openDialog(page);
    await dialog.getByRole('button', { name: 'Jetzt veröffentlichen', exact: true }).click();
    await alertTitled(page, 'Nicht für die Dienstart freigegeben').waitFor();
    assert.equal((await planOf(projectIds.werft)).status, 'UNPUBLISHED');
    assert.equal((await publishAudit(plans.werft)).length, 0);
    assert.deepEqual(publishesFor(plans.werft).map((entry) => entry.status), [409]);
    assert.match(await region(page, 'Planstatus').innerText(), /Unveröffentlicht/);
  });

  await step('P14 tenant isolation: a foreign plan is "not found" and offers no publish action; foreign data unchanged', async () => {
    await page.goto(`${origin}/monatsplanung/${ids.foreignPlan}`);
    await page.getByRole('alert').getByText('Nicht gefunden', { exact: true }).waitFor();
    assert.equal(await page.getByText(FOREIGN_PROJECT).count(), 0);
    assert.equal(await page.getByRole('button', { name: TRIGGER }).count(), 0);
    assert.equal(publishesFor(ids.foreignPlan).length, 0);
    assert.equal(JSON.stringify((await pool.query('SELECT id, status, published_at FROM monthly_plans WHERE company_id = $1', [ids.foreignCompany])).rows), foreignBefore);
  });

  await step('P15 totals: one publication + one audit per published plan; only key hashes stored; no page errors', async () => {
    for (const key of ['hafen', 'nord', 'sued', 'west', 'ost', 'mitte']) {
      assert.equal((await planOf(projectIds[key])).status, 'PUBLISHED', key);
      assert.equal((await publishAudit(plans[key])).length, 1, key);
      assert.equal((await reservations(plans[key])).filter((row) => row.state === 'COMPLETED').length, 1, key);
    }
    for (const key of ['kai', 'werft']) assert.equal((await planOf(projectIds[key])).status, 'UNPUBLISHED', key);
    const stored = (await pool.query('SELECT key_hash FROM idempotency_records WHERE company_id = $1', [ids.company])).rows.map((row) => row.key_hash);
    for (const entry of proxy.publishes.filter((item) => item.forwarded && item.key)) {
      assert.ok(stored.some((hash) => hash.equals(sha256(entry.key))), 'every forwarded key exists only as a hash');
    }
    const raw = JSON.stringify((await pool.query('SELECT * FROM idempotency_records WHERE company_id = $1', [ids.company])).rows);
    for (const entry of proxy.publishes) assert.ok(!entry.key || !raw.includes(entry.key), 'no raw key stored');
    assert.deepEqual(report.pageErrors, []);
    // Chrome logs every failed request (the deliberate 401/409/502/truncations above); nothing else.
    assert.equal(report.consoleCategories.other ?? 0, 0, 'no application console errors');
  });

  // ===== A1 + SP-13 combined groups (docs/reviews/sp13-a1-integration-plan.md, I1-I6, I8) =====
  let kalenderRead;
  await step('A1-I1a unconfigured project: calendar GET 200 MISSING, no effective/exact version, no-store; no row exists', async () => {
    kalenderRead = await readCalendar(page, projectIds.kalender);
    assert.deepEqual([kalenderRead.state, kalenderRead.effective, kalenderRead.exactVersion, kalenderRead.nextEffectiveFromMonth],
      ['MISSING', null, null, null]);
    assert.equal((await calendarRows(projectIds.kalender)).length, 0);
  });

  await step('A1-I1c MISSING blocks the First Publish of an empty plan: 409 PROJECT_CALENDAR_MISSING, German alert, nothing published', async () => {
    plans.kalender = (await createPlan(page, 'kalender')).id;
    await openPlan(page, plans.kalender);
    const dialog = await openDialog(page);
    await dialog.getByRole('button', { name: 'Jetzt veröffentlichen', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await assertRefusal(region(page, 'Planstatus'), 'Keine Betriebstage festgelegt', 'Der Plan wurde nicht veröffentlicht.');
    const sent = publishesFor(plans.kalender);
    assert.deepEqual(sent.map((entry) => entry.status), [409]);
    assert.equal((await planOf(projectIds.kalender)).status, 'UNPUBLISHED');
    assert.equal((await publishAudit(plans.kalender)).length, 0);
    const keyRows = (await pool.query('SELECT state FROM idempotency_records WHERE company_id = $1 AND key_hash = $2',
      [ids.company, sha256(sent[0].key)])).rows;
    assert.ok(keyRows.every((row) => row.state !== 'COMPLETED'), 'no completed reservation for a refused command');
    report.refusedPublishKeyRows = keyRows.map((row) => row.state);
  });

  await step('A1-I1b MISSING blocks duty creation: 409 PROJECT_CALENDAR_MISSING, German text, input kept, nothing saved', async () => {
    const { form, status, code } = await submitDuty(page, { date: '2026-12-08', kind: 'DAY', people: ['Synthetic Delta'] });
    assert.deepEqual([status, code], [409, 'PROJECT_CALENDAR_MISSING']);
    await assertRefusal(form, 'Keine Betriebstage festgelegt', 'Es wurde nichts gespeichert.');
    assert.equal(await form.getByLabel('Datum').inputValue(), '2026-12-08', 'input kept');
    assert.ok(await form.getByRole('checkbox', { name: /^Synthetic Delta / }).isChecked(), 'selection kept');
    assert.equal((await dutyRows(plans.kalender)).length, 0);
  });

  await step('A1-I1d explicit configuration through the admin API: APPLIED version 1, one bounded calendar audit (no bootstrap flag)', async () => {
    const answer = await patchCalendar(page, 'kalender', kalenderRead, { weekdays: POLICY });
    assert.equal(answer.status, 200);
    assert.deepEqual([answer.body.outcome, answer.body.state, answer.body.effective.operatingWeekdays, answer.body.effective.version, answer.body.exactVersion.version],
      ['APPLIED', 'CONFIGURED', POLICY, 1, 1]);
    assert.deepEqual((await calendarRows(projectIds.kalender)).map((row) => [row.month, row.weekday_mask, row.version]), [[`${MONTH}-01`, 62, '1']]);
    const audits = (await calendarAudits()).filter((row) => row.resource_id === projectIds.kalender);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].old_values, null);
    assert.deepEqual(audits[0].new_values, { effectiveFromMonth: `${MONTH}-01`, operatingWeekdays: POLICY, version: 1 });
  });

  await step('A1-I1e stale preconditions: 409 PROJECT_CALENDAR_CONCURRENT_MODIFICATION; a fresh same-set write is NO_OP; neither is audited', async () => {
    const stale = await patchCalendar(page, 'kalender', kalenderRead, { weekdays: [1, 2, 3, 4, 5, 6, 7] });
    assert.deepEqual([stale.status, stale.code], [409, 'PROJECT_CALENDAR_CONCURRENT_MODIFICATION']);
    const same = await patchCalendar(page, 'kalender', await readCalendar(page, projectIds.kalender), { weekdays: POLICY });
    assert.deepEqual([same.status, same.body.outcome], [200, 'NO_OP']);
    assert.deepEqual((await calendarRows(projectIds.kalender)).map((row) => [row.weekday_mask, row.version]), [[62, '1']]);
    assert.equal((await calendarAudits()).filter((row) => row.resource_id === projectIds.kalender).length, 1);
  });

  await step('A1-I2a the kept input is saved once the calendar exists: DAY duty on an operating Tuesday (201)', async () => {
    const form = region(page, 'Dienst hinzufügen');
    const answer = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/entries'));
    await form.getByRole('button', { name: 'Dienst anlegen', exact: true }).click();
    assert.equal((await answer).status(), 201);
    await page.getByText('Der Tagdienst am Di., 08.12.2026 wurde angelegt.', { exact: true }).waitFor();
    assert.deepEqual((await dutyRows(plans.kalender)).map((row) => [row.date, row.kind, row.members]),
      [['2026-12-08', 'TAG', [`${ids.delta}:MITARBEITER`]]]);
  });

  await step('A1-I2b a NIGHT starting on an operating Saturday and ending on a closed Sunday is accepted (the start date decides)', async () => {
    const { status } = await submitDuty(page, { date: '2026-12-12', kind: 'NIGHT', people: ['Synthetic Echo'] });
    assert.equal(status, 201);
    await page.getByText('Der Nachtdienst am Sa., 12.12.2026 wurde angelegt.', { exact: true }).waitFor();
  });

  await step('A1-I3a/I3b closed weekdays: DAY on a Monday and NIGHT starting on a Sunday → 409 PROJECT_CLOSED_WEEKDAY; nothing saved', async () => {
    const before = (await dutyRows(plans.kalender)).length;
    const monday = await submitDuty(page, { date: '2026-12-07', kind: 'DAY', people: ['Synthetic Delta'] });
    assert.deepEqual([monday.status, monday.code], [409, 'PROJECT_CLOSED_WEEKDAY']);
    await assertRefusal(monday.form, 'Kein Betriebstag', 'Es wurde nichts gespeichert.');
    const sunday = await submitDuty(page, { date: '2026-12-13', kind: 'NIGHT' });
    assert.deepEqual([sunday.status, sunday.code], [409, 'PROJECT_CLOSED_WEEKDAY']);
    await assertRefusal(sunday.form, 'Kein Betriebstag', 'Es wurde nichts gespeichert.');
    await closeCreateForm(page);
    assert.equal((await dutyRows(plans.kalender)).length, before);
  });

  await step('A1-I3c editing a duty onto a closed Monday → 409 PROJECT_CLOSED_WEEKDAY; duty unchanged; input and lease kept', async () => {
    const before = await dutyRows(plans.kalender);
    const panel = await openEditor(page, 'Di., 8. Dezember: Tagdienst, 1 Person; kein Nachtdienst', 'Dienste am Di., 08.12.2026',
      'Tagdienst', 'Tagdienst am Di., 08.12.2026 bearbeiten');
    await panel.getByLabel('Datum').fill('2026-12-14');
    const { status, code } = await saveEditor(page, panel);
    assert.deepEqual([status, code], [409, 'PROJECT_CLOSED_WEEKDAY']);
    await assertRefusal(panel, 'Kein Betriebstag', 'Es wurde nichts geändert.');
    assert.equal(await panel.getByLabel('Datum').inputValue(), '2026-12-14', 'input kept');
    await panel.getByText('Für Sie reserviert').waitFor();
    assert.deepEqual(await dutyRows(plans.kalender), before);
    await closePanel(page, panel);
  });

  await step('A1-I3d a calendar change cannot newly close an occupied date: 409 PROJECT_CALENDAR_DEPENDENCY_CONFLICT; version unchanged', async () => {
    // Closing Tuesday from December would close the saved duty of 8 December.
    const closing = await patchCalendar(page, 'kalender', await readCalendar(page, projectIds.kalender), { weekdays: [3, 4, 5, 6] });
    assert.deepEqual([closing.status, closing.code], [409, 'PROJECT_CALENDAR_DEPENDENCY_CONFLICT']);
    assert.deepEqual((await calendarRows(projectIds.kalender)).map((row) => [row.weekday_mask, row.version]), [[62, '1']]);
  });

  await step('A1-I4a/I4b one shift per person, project and date: DAY then NIGHT and NIGHT then DAY → 409 EMPLOYEE_DAILY_SHIFT_CONFLICT', async () => {
    assert.equal((await submitDuty(page, { date: '2026-12-09', kind: 'DAY', people: ['Synthetic Delta'] })).status, 201);
    const night = await submitDuty(page, { date: '2026-12-09', kind: 'NIGHT', people: ['Synthetic Delta'] });
    assert.deepEqual([night.status, night.code], [409, 'EMPLOYEE_DAILY_SHIFT_CONFLICT']);
    await assertRefusal(night.form, 'Tag- und Nachtdienst am selben Tag', 'Es wurde nichts gespeichert.');
    assert.equal((await submitDuty(page, { date: '2026-12-10', kind: 'NIGHT', people: ['Synthetic Echo'] })).status, 201);
    const day = await submitDuty(page, { date: '2026-12-10', kind: 'DAY', people: ['Synthetic Echo'] });
    assert.deepEqual([day.status, day.code], [409, 'EMPLOYEE_DAILY_SHIFT_CONFLICT']);
    await assertRefusal(day.form, 'Tag- und Nachtdienst am selben Tag', 'Es wurde nichts gespeichert.');
    await closeCreateForm(page);
    // DAY 06-18 and NIGHT 18-06 are adjacent, not overlapping: only the A1 rule refuses them.
    assert.deepEqual((await dutyRows(plans.kalender)).filter((row) => ['2026-12-09', '2026-12-10'].includes(row.date)).map((row) => [row.date, row.kind]),
      [['2026-12-09', 'TAG'], ['2026-12-10', 'NACHT']]);
  });

  await step('A1-I4c adding the person to the other shift of the same date through the editor → 409; duty unchanged; lease kept', async () => {
    assert.equal((await submitDuty(page, { date: '2026-12-09', kind: 'NIGHT' })).status, 201, 'an unstaffed NIGHT is allowed');
    const before = await dutyRows(plans.kalender);
    const panel = await openEditor(page, 'Mi., 9. Dezember: Tagdienst, 1 Person; Nachtdienst, ohne Besetzung', 'Dienste am Mi., 09.12.2026',
      'Nachtdienst', 'Nachtdienst am Mi., 09.12.2026 bearbeiten');
    await panel.getByRole('checkbox', { name: /^Synthetic Delta / }).check();
    const { status, code } = await saveEditor(page, panel);
    assert.deepEqual([status, code], [409, 'EMPLOYEE_DAILY_SHIFT_CONFLICT']);
    await assertRefusal(panel, 'Tag- und Nachtdienst am selben Tag', 'Es wurde nichts geändert.');
    await panel.getByText('Für Sie reserviert').waitFor();
    assert.deepEqual(await dutyRows(plans.kalender), before);
    await closePanel(page, panel);
  });

  await step('A1-I5a First Publish on the configured project: one bodyless POST, 200, one audit, one COMPLETED reservation = SHA-256(browser key)', async () => {
    await openPlan(page, plans.kalender);
    const dialog = await openDialog(page);
    assert.equal(await dialog.locator('dt', { hasText: 'Dienste' }).locator('xpath=following-sibling::dd').innerText(), '5 (davon 1 ohne Besetzung)');
    await dialog.getByRole('button', { name: 'Jetzt veröffentlichen', exact: true }).dblclick();
    await page.getByText(SUCCESS).waitFor();
    const sent = publishesFor(plans.kalender);
    assert.equal(sent.length, 2, 'the refused I1c command and exactly one new one');
    const request = sent[1];
    assert.notEqual(request.key, sent[0].key, 'a new decision has a new key');
    assert.deepEqual([request.bodyBytes, request.contentType, request.csrf, request.origin, request.expectedVersion, request.status, request.replayed],
      [0, null, true, true, null, 200, 'false']);
    const row = await planOf(projectIds.kalender);
    assert.deepEqual([row.status, row.published_by_account_id], ['PUBLISHED', ids.admin]);
    assert.equal((await publishAudit(plans.kalender)).length, 1);
    const completed = (await reservations(plans.kalender)).filter((record) => record.state === 'COMPLETED');
    assert.equal(completed.length, 1);
    assert.ok(completed[0].key_hash.equals(sha256(request.key)));
    report.kalenderPublishedAt = row.published_at.toISOString();
  });

  await step('A1-I5c CR-03 after publication: an allowed edit applies directly; an edit onto a closed weekday is refused; no second publish', async () => {
    let panel = await openEditor(page, 'Di., 8. Dezember: Tagdienst, 1 Person; kein Nachtdienst', 'Dienste am Di., 08.12.2026',
      'Tagdienst', 'Tagdienst am Di., 08.12.2026 bearbeiten');
    await panel.getByRole('checkbox', { name: /^Synthetic Echo / }).check();
    assert.equal((await saveEditor(page, panel)).status, 200);
    await page.getByText(/wurden gespeichert\. Der Plan ist veröffentlicht: Die Änderung gilt sofort, ohne erneutes Veröffentlichen\./).waitFor();
    panel = await openEditor(page, 'Di., 8. Dezember: Tagdienst, 2 Personen; kein Nachtdienst', 'Dienste am Di., 08.12.2026',
      'Tagdienst', 'Tagdienst am Di., 08.12.2026 bearbeiten');
    await panel.getByLabel('Datum').fill('2026-12-14');
    const refused = await saveEditor(page, panel);
    assert.deepEqual([refused.status, refused.code], [409, 'PROJECT_CLOSED_WEEKDAY']);
    await assertRefusal(panel, 'Kein Betriebstag', 'Es wurde nichts geändert.');
    await closePanel(page, panel);
    const row = await planOf(projectIds.kalender);
    assert.deepEqual([row.status, row.published_at.toISOString()], ['PUBLISHED', report.kalenderPublishedAt]);
    assert.equal(publishesFor(plans.kalender).length, 2, 'no second publish');
    assert.equal((await publishAudit(plans.kalender)).length, 1);
  });

  await step('A1-I6c a completed publication replays with the same key after a later calendar version and project deactivation; no second audit', async () => {
    const key = publishesFor(plans.sued)[0].key;
    const january = await readCalendar(page, projectIds.sued, '2027-01-01');
    const later = await patchCalendar(page, 'sued', january, { weekdays: [1], month: '2027-01-01' });
    assert.deepEqual([later.status, later.body.outcome], [200, 'APPLIED']);
    await other.goto(`${origin}/projekte/${projectIds.sued}`);
    await other.getByRole('button', { name: 'Projekt auf inaktiv setzen …', exact: true }).click();
    await other.getByRole('button', { name: 'Auf inaktiv setzen', exact: true }).click();
    await other.getByText('Das Projekt ist jetzt inaktiv.').waitFor();
    const replay = await adminApi(page, 'POST', `/api/v1/monthly-plans/${plans.sued}/publish`, null, { 'Idempotency-Key': key });
    assert.deepEqual([replay.status, replay.replayed, replay.body?.status, replay.body?.id], [200, 'true', 'PUBLISHED', plans.sued]);
    assert.equal(publishesFor(plans.sued).at(-1).bodyBytes, 0, 'bodyless replay');
    assert.equal((await publishAudit(plans.sued)).length, 1);
    assert.equal((await reservations(plans.sued)).length, 1);
  });

  await step('A1-I6d the same key for another plan: 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST; nothing published', async () => {
    const key = publishesFor(plans.sued)[0].key;
    const reuse = await adminApi(page, 'POST', `/api/v1/monthly-plans/${plans.werft}/publish`, null, { 'Idempotency-Key': key });
    assert.deepEqual([reuse.status, reuse.code], [409, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST']);
    assert.equal((await planOf(projectIds.werft)).status, 'UNPUBLISHED');
    assert.equal((await publishAudit(plans.werft)).length, 0);
  });

  await step('A1-I8 isolation and authorization: a foreign calendar is concealed (404) for read and write; an EMPLOYEE gets 403', async () => {
    const body = { effectiveFromMonth: `${MONTH}-01`, expectedExactVersion: null, expectedEffective: null,
      expectedNextEffectiveFromMonth: null, operatingWeekdays: POLICY, bootstrap: false };
    const read = await adminApi(page, 'GET', `${calendarPath(ids.foreignProject)}?effectiveForMonth=${MONTH}-01`);
    const write = await adminApi(page, 'PATCH', calendarPath(ids.foreignProject), body);
    assert.deepEqual([read.status, write.status], [404, 404]);
    const employeeContext = await browser.newContext(contextOptions);
    try {
      const employee = await login(employeeContext, '/', email('employee', ids.deltaAccount));
      const denied = await adminApi(employee, 'GET', `${calendarPath(projectIds.kalender)}?effectiveForMonth=${MONTH}-01`);
      const deniedWrite = await adminApi(employee, 'PATCH', calendarPath(projectIds.kalender), body);
      assert.deepEqual([denied.status, deniedWrite.status], [403, 403]);
    } finally { await employeeContext.close(); }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_operating_calendars WHERE company_id = $1', [ids.foreignCompany])).rows[0].n, 0);
    assert.equal(JSON.stringify((await pool.query('SELECT id, status, published_at FROM monthly_plans WHERE company_id = $1', [ids.foreignCompany])).rows), foreignBefore);
  });

  await step('A1-T totals: one calendar audit per APPLIED write, none for refusals or NO_OP; every calendar row from an API write; publications', async () => {
    const applied = calendarWrites.filter((write) => write.outcome === 'APPLIED');
    assert.equal((await calendarAudits()).length, applied.length);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_operating_calendars WHERE company_id = $1', [ids.company])).rows[0].n,
      applied.length, 'each APPLIED write created one row; nothing else wrote calendars');
    for (const key of ['hafen', 'nord', 'sued', 'west', 'ost', 'mitte', 'kalender']) {
      assert.equal((await planOf(projectIds[key])).status, 'PUBLISHED', key);
      assert.equal((await publishAudit(plans[key])).length, 1, key);
      assert.equal((await reservations(plans[key])).filter((row) => row.state === 'COMPLETED').length, 1, key);
    }
    for (const key of ['kai', 'werft']) assert.equal((await planOf(projectIds[key])).status, 'UNPUBLISHED', key);
    report.calendarWrites = calendarWrites;
    assert.deepEqual(report.pageErrors, []);
    assert.equal(report.consoleCategories.other ?? 0, 0, 'no application console errors');
  });
  await otherContext.close();
} catch (error) {
  // Assertion and locator messages contain no raw headers, keys, tokens or passwords.
  report.failure = error instanceof Error ? error.message : 'Browser acceptance failed';
  process.exitCode = 1;
  console.error(report.failure);
  if (page && !page.isClosed()) {
    report.failureUi = await page.locator('main').innerText().catch(() => 'Main view not present');
    await page.screenshot({ path: resolve(output, 'sp13-publish-browser-failure.png'), fullPage: true }).catch(() => {});
  }
} finally {
  await browser?.close();
  if (frontend) await new Promise((done) => frontend.close(done));
  if (backend && backend.exitCode === null) { backend.kill(); await new Promise((done) => backend.once('exit', done)); }
  if (seeded) {
    await verifyRecordedTestTarget();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='5s'");
      for (const companyId of [ids.company, ids.foreignCompany]) {
        for (const table of ['sessions', 'account_tokens', 'audit_event', 'idempotency_records', 'edit_leases', 'plan_assignments', 'duties',
          'monthly_plans', 'availability_batch_commands', 'employee_availability_days', 'shift_configurations', 'project_assignments',
          'project_operating_calendars', 'employees', 'projects', 'accounts']) {
          await client.query(`DELETE FROM ${table} WHERE company_id=$1`, [companyId]);
        }
        await client.query('DELETE FROM companies WHERE id=$1', [companyId]);
      }
      await client.query('COMMIT');
      report.fixtureCleanup = 'PASS';
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  await pool.end();
  report.finishedAt = new Date().toISOString();
  // Request facts only (path ids masked); never header values, bodies, keys or tokens.
  report.publishRequests = proxy.publishes.map((entry) => ({
    forwarded: entry.forwarded, status: entry.status, replayed: entry.replayed, bodyBytes: entry.bodyBytes,
    contentType: entry.contentType, csrf: entry.csrf, sameOrigin: entry.origin, keyPresent: entry.key !== null,
  }));
  await writeFile(resolve(output, 'sp13-publish-browser-results.json'), `${JSON.stringify(report, null, 2)}\n`);
}
