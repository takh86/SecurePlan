/** A1 legacy upgrade (I7 of docs/reviews/sp13-a1-integration-plan.md) with REAL binaries:
 *   pre-A1 backend (migrations 0001-0013) creates legacy data over HTTP -> writers drained ->
 *   integrated migrator applies 0014 -> read-only inventory -> integrated backend + built React in Chrome
 *   (blocked publish, explicit bootstrap, dual-shift refusal, correction by removal, publish).
 *
 * Target: a FRESH, EMPTY, verified disposable PostgreSQL 17 (receipt). The pre-A1 build is an external
 * export of the commit before A1 (SECUREPLAN_LEGACY_ROOT, with its own built apps/backend/dist); this
 * script proves it has no 0014 and no calendar module, and that its 13 migrations are byte-identical.
 * Playwright is an external pinned tool (SECUREPLAN_PLAYWRIGHT_MODULE), as in the SP-13 harness.
 *
 * Fixture boundary: only prerequisites (company, admin account, employees, projects, month assignments,
 * shift times) are inserted directly. Plans, duties and the pre-A1 publication come from the pre-A1
 * HTTP API; calendars only from the integrated admin API; corrections and publications from the UI.
 * No calendar, publication or audit row is written by SQL. All weekday sets are synthetic examples.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { createServer as httpServer, request as httpRequest } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { verifyRecordedTestTarget } from './disposable-test-target.mjs';

const execute = promisify(execFile);
const receipt = await verifyRecordedTestTarget();
const root = fileURLToPath(new URL('../', import.meta.url));
const legacyRoot = process.env.SECUREPLAN_LEGACY_ROOT;
assert.ok(legacyRoot, 'SECUREPLAN_LEGACY_ROOT (pre-A1 build) is required');
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
  legacyCommit: process.env.SECUREPLAN_LEGACY_COMMIT ?? null,
  results: [], pageErrors: [], consoleErrors: 0, consoleCategories: {},
};
const ids = {
  company: randomUUID(), admin: randomUUID(), oneAccount: randomUUID(), twoAccount: randomUUID(),
  one: randomUUID(), two: randomUUID(), legacy: randomUUID(), empty: randomUUID(),
};
const password = randomBytes(24).toString('base64url');
const adminEmail = `legacy-admin-${ids.admin}@secureplan.invalid`;
const SUCCESS = /^Der Monatsplan wurde veröffentlicht\./;
const TRIGGER = 'Monatsplan veröffentlichen …';
const DIALOG = 'Monatsplan veröffentlichen?';
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
let seeded = false; let legacyBackend; let backend; let frontend; let browser; let page;

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
async function startBackend(cwd, port, origin) {
  const child = spawn(process.execPath, ['apps/backend/dist/main.js'], {
    cwd, env: { ...process.env, PORT: String(port), APP_ORIGIN: origin }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout.resume(); child.stderr.resume();
  const until = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error('Backend failed to start');
    try { if ((await fetch(`http://127.0.0.1:${port}/api/v1/health/ready`)).status === 200) return child; } catch { /* starting */ }
    assert.ok(Date.now() < until, 'Backend readiness timeout');
    await wait(100);
  }
}
async function stopBackend(child, port) {
  if (child && child.exitCode === null) { child.kill(); await new Promise((done) => child.once('exit', done)); }
  // Drained: nothing answers on the old port any more.
  const answered = await fetch(`http://127.0.0.1:${port}/api/v1/health/ready`).then(() => true, () => false);
  assert.equal(answered, false, 'old writer drained');
}
async function migrations(cwd) {
  const { stdout } = await execute(process.execPath, ['scripts/migrate.mjs'], { cwd, env: process.env, timeout: 120_000 });
  const lines = stdout.split(/\r?\n/);
  return {
    applied: lines.filter((line) => line.startsWith('Applied:')).map((line) => line.slice('Applied:'.length).trim()),
    already: lines.filter((line) => line.startsWith('Already applied:')).length,
  };
}

/** Minimal HTTP client against the pre-A1 backend: same Origin, session cookie, CSRF; never logs. */
function legacyClient(port, origin) {
  let cookie = null; let csrf = null;
  const call = (method, path, body = null, extra = {}) => new Promise((done, fail) => {
    const headers = { Origin: origin, ...extra };
    if (cookie) headers.Cookie = cookie;
    if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
    const payload = body === null ? null : JSON.stringify(body);
    if (payload !== null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    else if (method !== 'GET') headers['Content-Length'] = 0;
    const req = httpRequest({ hostname: '127.0.0.1', port, path: `/api/v1${path}`, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        done({ status: res.statusCode, headers: res.headers, body: json });
      });
    });
    req.on('error', fail);
    if (payload !== null) req.write(payload);
    req.end();
  });
  return {
    async login(email) {
      const answer = await call('POST', '/auth/login', { email, password });
      assert.equal(answer.status, 200, 'legacy login');
      cookie = String(answer.headers['set-cookie']).split(';')[0];
      csrf = answer.headers['x-csrf-token'];
    },
    call,
  };
}

async function snapshot() {
  const q = async (sql) => (await pool.query(sql, [ids.company])).rows;
  return JSON.stringify({
    plans: await q(`SELECT id, project_id, to_char(planning_month,'YYYY-MM-DD') AS m, status, published_at, published_by_account_id
      FROM monthly_plans WHERE company_id = $1 ORDER BY id`),
    duties: await q(`SELECT id, monthly_plan_id, to_char(duty_date,'YYYY-MM-DD') AS d, shift_kind, concurrency_version::text AS v, removed_at
      FROM duties WHERE company_id = $1 ORDER BY id`),
    members: await q(`SELECT id, duty_id, employee_id, duty_function, state FROM plan_assignments WHERE company_id = $1 ORDER BY id`),
    audits: await q(`SELECT action, resource_id FROM audit_event WHERE company_id = $1 ORDER BY id`),
    reservations: await q(`SELECT state, result_plan_id FROM idempotency_records WHERE company_id = $1 ORDER BY id`),
  });
}
async function planRow(planId) {
  return (await pool.query('SELECT status, published_at, published_by_account_id FROM monthly_plans WHERE company_id = $1 AND id = $2',
    [ids.company, planId])).rows[0];
}
async function publishAudits(planId) {
  return (await pool.query(`SELECT 1 FROM audit_event WHERE company_id = $1 AND action = 'MONTHLY_PLAN_PUBLISHED' AND resource_id = $2`,
    [ids.company, planId])).rowCount;
}
async function calendarAudits() {
  return (await pool.query(`SELECT resource_id, new_values FROM audit_event WHERE company_id = $1 AND action = 'PROJECT_OPERATING_CALENDAR_UPDATED' ORDER BY occurred_at`,
    [ids.company])).rows;
}
async function members(planId) {
  return (await pool.query(
    `SELECT to_char(d.duty_date,'YYYY-MM-DD') AS d, d.shift_kind AS k, d.concurrency_version::text AS v, pa.employee_id::text AS e, pa.duty_function AS f
     FROM duties d JOIN plan_assignments pa ON pa.company_id = d.company_id AND pa.duty_id = d.id AND pa.state = 'ACTIVE'
     WHERE d.company_id = $1 AND d.monthly_plan_id = $2 AND d.removed_at IS NULL ORDER BY d.duty_date, d.shift_kind, pa.employee_id`,
    [ids.company, planId])).rows;
}
/** Read-only inventory of this tenant (counts only; IDs never enter evidence). */
async function inventory() {
  const { stdout } = await execute(process.execPath, ['scripts/scan-project-calendars.mjs'], { cwd: root, env: process.env, timeout: 60_000 });
  const scan = JSON.parse(stdout);
  const findings = scan.findings.filter((row) => row.company_id === ids.company);
  const projects = scan.projects.filter((row) => row.company_id === ids.company);
  const label = (projectId) => (projectId === ids.legacy ? 'legacy' : projectId === ids.empty ? 'empty' : 'other');
  return {
    findings: findings.map((row) => ({ project: label(row.project_id), month: row.month, violation: row.violation, count: row.count })),
    projects: projects.map((row) => ({ project: label(row.project_id), calendarVersions: row.calendar_versions,
      earliestLiveDutyMonth: row.earliest_live_duty_month, missingPlanMonths: row.missing_plan_months })),
  };
}

// --- Browser helpers (integrated UI) ---
function observe(target) {
  target.on('pageerror', () => report.pageErrors.push('Uncaught browser exception'));
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
const region = (target, name) => target.getByRole('region', { name, exact: true });
const trigger = (target) => region(target, 'Planstatus').getByRole('button', { name: TRIGGER, exact: true });
async function adminApi(target, method, path, body = null) {
  return target.evaluate(async ([verb, url, payload]) => {
    const headers = {};
    if (verb !== 'GET') {
      const me = await fetch('/api/v1/me', { credentials: 'same-origin', cache: 'no-store' });
      headers['X-CSRF-Token'] = me.headers.get('X-CSRF-Token') ?? '';
    }
    if (payload !== null) headers['Content-Type'] = 'application/json';
    const response = await fetch(url, { method: verb, credentials: 'same-origin', cache: 'no-store', headers,
      body: payload === null ? undefined : JSON.stringify(payload) });
    let json = null; try { json = await response.json(); } catch { /* empty */ }
    return { status: response.status, cacheControl: response.headers.get('cache-control'), body: json,
      code: json && typeof json.code === 'string' ? json.code : null };
  }, [method, path, body]);
}
const calendarPath = (projectId) => `/api/v1/projects/${projectId}/operating-calendar`;
async function readCalendar(projectId, month) {
  const read = await adminApi(page, 'GET', `${calendarPath(projectId)}?effectiveForMonth=${month}`);
  assert.equal(read.status, 200);
  return read.body;
}
async function patchCalendar(projectId, read, { month, weekdays, bootstrap }) {
  const answer = await adminApi(page, 'PATCH', calendarPath(projectId), {
    effectiveFromMonth: month, expectedExactVersion: read.exactVersion,
    expectedEffective: read.effective ? { id: read.effective.id, version: read.effective.version } : null,
    expectedNextEffectiveFromMonth: read.nextEffectiveFromMonth, operatingWeekdays: weekdays, bootstrap,
  });
  assert.equal(answer.cacheControl, 'no-store');
  return answer;
}
async function openPlan(planId, monthLabel) {
  await page.goto(`${origin}/monatsplanung/${planId}`);
  await page.getByRole('grid', { name: `Dienste im ${monthLabel} nach Person und Tag` }).waitFor();
}
/** Opens the dialog and confirms; returns the publish answer's status and problem code. */
async function publish() {
  await waitForReady();
  await trigger(page).click();
  const dialog = page.getByRole('alertdialog', { name: DIALOG });
  await dialog.waitFor();
  const answer = page.waitForResponse((r) => r.request().method() === 'POST' && /\/publish$/.test(new URL(r.url()).pathname));
  await dialog.getByRole('button', { name: 'Jetzt veröffentlichen', exact: true }).click();
  const response = await answer;
  const status = response.status();
  const code = status >= 400 ? ((await response.json().catch(() => null))?.code ?? null) : null;
  await dialog.waitFor({ state: 'detached' });
  return { status, code };
}
async function waitForReady() {
  const until = Date.now() + 15_000;
  while ((await trigger(page).getAttribute('aria-disabled')) !== null) {
    assert.ok(Date.now() < until, 'publish action ready');
    await wait(200);
  }
}
async function assertRefusal(container, title, outcome) {
  const heading = container.getByRole('heading', { name: title, exact: true });
  await heading.waitFor();
  const text = (await heading.locator('xpath=ancestor::*[@role="alert"][1]').innerText()).replace(/\s+/g, ' ');
  assert.ok(text.includes(outcome), `${title}: outcome`);
  assert.doesNotMatch(text, /Synthetic|\d{2}\.\d{2}\.\d{4}|krank|urlaub/i, `${title}: privacy-safe`);
}
async function openEditor(dayCell, dayRegion, kindLabel, panelName) {
  await page.getByRole('button', { name: dayCell, exact: true }).click();
  await region(page, dayRegion).getByRole('button', { name: `${kindLabel} bearbeiten`, exact: true }).click();
  const panel = region(page, panelName);
  await panel.getByText('Für Sie reserviert').waitFor();
  return panel;
}
async function saveEditor(panel) {
  const answer = page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/entries\/[^/]+$/.test(new URL(r.url()).pathname));
  await panel.getByRole('button', { name: 'Änderungen speichern', exact: true }).click();
  const response = await answer;
  const status = response.status();
  const code = status >= 400 ? ((await response.json().catch(() => null))?.code ?? null) : null;
  if (status === 200) await panel.waitFor({ state: 'detached' });
  return { status, code };
}
async function closePanel(panel) {
  await panel.getByRole('button', { name: 'Schließen', exact: true }).first().click();
  const leave = page.getByRole('button', { name: /^(Eingaben|Änderungen) verwerfen und wechseln$/ });
  if (await leave.waitFor({ timeout: 2000 }).then(() => true, () => false)) await leave.click();
  await panel.waitFor({ state: 'detached' });
}

let origin;
const plans = {};
try {
  // ---------- Pre-A1 build and empty target ----------
  await step('L0 the pre-A1 build has no 0014 and no calendar module; its 13 migrations equal ours; the target is empty', async () => {
    const legacyMigrations = (await readdir(resolve(legacyRoot, 'apps/backend/migrations'))).filter((name) => name.endsWith('.sql')).sort();
    assert.equal(legacyMigrations.length, 13);
    assert.ok(!legacyMigrations.some((name) => name.startsWith('0014')));
    for (const name of legacyMigrations) {
      const ours = await readFile(resolve(root, 'apps/backend/migrations', name));
      const theirs = await readFile(resolve(legacyRoot, 'apps/backend/migrations', name));
      assert.ok(createHash('sha256').update(ours).digest().equals(createHash('sha256').update(theirs).digest()), name);
    }
    assert.ok(existsSync(resolve(legacyRoot, 'apps/backend/dist/main.js')), 'legacy build present');
    assert.ok(!existsSync(resolve(legacyRoot, 'apps/backend/dist/modules/workforce/projects/operating-calendar.controller.js')), 'no A1 code');
    assert.ok(existsSync(resolve(root, 'apps/backend/dist/modules/workforce/projects/operating-calendar.controller.js')), 'integrated build has A1');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'")).rows[0].n, 0, 'empty target');
  });

  await step('L1 the pre-A1 migrator applies exactly 0001-0013', async () => {
    const run = await migrations(legacyRoot);
    assert.equal(run.applied.length, 13);
    assert.ok(run.applied.at(-1).startsWith('0013_'));
    report.legacyMigrationsApplied = run.applied.length;
  });

  // Prerequisites only (no plan, duty, calendar, publication or audit).
  await verifyRecordedTestTarget();
  {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const hash = await hashPassword(password);
      await client.query("INSERT INTO companies(id,name,status,time_zone) VALUES($1,'Synthetic A1 Legacy','ACTIVE','Europe/Berlin')", [ids.company]);
      for (const [accountId, address, role] of [[ids.admin, adminEmail, 'COMPANY_ADMIN'],
        [ids.oneAccount, `legacy-one-${ids.oneAccount}@secureplan.invalid`, 'EMPLOYEE'],
        [ids.twoAccount, `legacy-two-${ids.twoAccount}@secureplan.invalid`, 'EMPLOYEE']]) {
        await client.query("INSERT INTO accounts(id,company_id,email,account_scope,role,status,password_hash) VALUES($1,$2,$3,'TENANT',$4,'ACTIVE',$5)",
          [accountId, ids.company, address, role, hash]);
      }
      for (const [employeeId, accountId, number, last] of [[ids.one, ids.oneAccount, 'LEG-ONE', 'Eins'], [ids.two, ids.twoAccount, 'LEG-TWO', 'Zwei']]) {
        await client.query(
          "INSERT INTO employees(id,company_id,account_id,employee_number,first_name,last_name,shift_eligibility,employment_start) VALUES($1,$2,$3,$4,'Synthetic',$5,'BOTH','2020-01-01')",
          [employeeId, ids.company, accountId, number, last]);
      }
      for (const [projectId, name] of [[ids.legacy, 'Synthetic Altbestand'], [ids.empty, 'Synthetic Altbestand Leer']]) {
        await client.query("INSERT INTO projects(id,company_id,name,status) VALUES($1,$2,$3,'ACTIVE')", [projectId, ids.company, name]);
        for (const [kind, start, end] of [['TAG', '06:00', '18:00'], ['NACHT', '18:00', '06:00']]) {
          await client.query(`INSERT INTO shift_configurations(company_id,project_id,effective_from_month,shift_kind,start_local,end_local)
            VALUES($1,$2,'2026-12-01',$3,$4::time,$5::time)`, [ids.company, projectId, kind, start, end]);
        }
      }
      for (const employeeId of [ids.one, ids.two]) {
        for (const month of ['2026-12-01', '2027-01-01']) {
          await client.query('INSERT INTO project_assignments(company_id,employee_id,project_id,planning_month) VALUES($1,$2,$3,$4::date)',
            [ids.company, employeeId, ids.legacy, month]);
        }
      }
      await client.query('COMMIT');
      seeded = true;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  let before;
  const legacyPort = await freePort();
  await step('L2 the pre-A1 backend creates legacy data over HTTP: DAY+NIGHT of one date for one person in two plans, a Sunday duty, one pre-A1 publication, one empty plan', async () => {
    legacyBackend = await startBackend(legacyRoot, legacyPort, 'https://localhost:9');
    const api = legacyClient(legacyPort, 'https://localhost:9');
    await api.login(adminEmail);
    const create = async (projectId, monthStart) => {
      const answer = await api.call('POST', '/monthly-plans', { projectId, monthStart });
      assert.equal(answer.status, 201, 'plan created');
      return answer.body.id;
    };
    plans.a = await create(ids.legacy, '2026-12-01');
    plans.b = await create(ids.legacy, '2027-01-01');
    plans.empty = await create(ids.empty, '2026-12-01');
    const duty = async (planId, dutyDate, shiftKind, employees) => {
      const answer = await api.call('POST', `/monthly-plans/${planId}/entries`,
        { dutyDate, shiftKind, assignments: employees.map((employeeId) => ({ employeeId, dutyRole: 'EMPLOYEE' })) });
      assert.equal(answer.status, 201, `${dutyDate} ${shiftKind}`);
    };
    // Adjacent DAY 06-18 and NIGHT 18-06: accepted before A1 (no UTC overlap).
    await duty(plans.a, '2026-12-16', 'DAY', [ids.one]);
    await duty(plans.a, '2026-12-16', 'NIGHT', [ids.one]);
    await duty(plans.a, '2026-12-20', 'DAY', [ids.two]);
    await duty(plans.b, '2027-01-13', 'DAY', [ids.one]);
    await duty(plans.b, '2027-01-13', 'NIGHT', [ids.one]);
    const published = await api.call('POST', `/monthly-plans/${plans.b}/publish`, null, { 'Idempotency-Key': randomUUID() });
    assert.deepEqual([published.status, published.body?.status], [200, 'PUBLISHED'], 'pre-A1 publication');
    assert.equal((await api.call('GET', `/projects/${ids.legacy}/operating-calendar?effectiveForMonth=2026-12-01`)).status, 404, 'no calendar API before A1');
    before = await snapshot();
  });

  await step('L3 drain: the pre-A1 backend is stopped before the migration (no old writer remains)', async () => {
    await stopBackend(legacyBackend, legacyPort);
    legacyBackend = null;
  });

  await step('I7a-1 the integrated migrator applies only 0014; replay applies nothing; verify-db passes; legacy rows unchanged; zero calendars', async () => {
    const first = await migrations(root);
    assert.deepEqual(first.applied, ['0014_project_operating_calendars.sql']);
    assert.equal(first.already, 13);
    const second = await migrations(root);
    assert.deepEqual([second.applied.length, second.already], [0, 14]);
    await execute(process.execPath, ['scripts/verify-db.mjs'], { cwd: root, env: process.env, timeout: 60_000 });
    assert.equal(await snapshot(), before, 'plans, duties, memberships, audit and reservations byte-identical');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_operating_calendars')).rows[0].n, 0);
  });

  await step('I7b read-only inventory: MISSING for every legacy duty month, one dual DAY/NIGHT group per plan, the empty project listed; no repair', async () => {
    const scan = await inventory();
    report.inventoryBefore = scan;
    const find = (month, violation) => scan.findings.find((row) => row.project === 'legacy' && row.month === month && row.violation === violation)?.count;
    assert.deepEqual([find('2026-12-01', 'MISSING'), find('2027-01-01', 'MISSING'), find('2026-12-01', 'DUAL_ASSIGNMENT'), find('2027-01-01', 'DUAL_ASSIGNMENT')],
      [3, 2, 1, 1]);
    const empty = scan.projects.find((row) => row.project === 'empty');
    assert.deepEqual([empty.calendarVersions, empty.earliestLiveDutyMonth, empty.missingPlanMonths], [0, null, ['2026-12-01']]);
    assert.equal(await snapshot(), before, 'the inventory changed nothing');
  });

  // ---------- Integrated backend + built React in Chrome ----------
  const backendPort = await freePort();
  const frontendPort = await freePort();
  origin = `https://localhost:${frontendPort}`;
  backend = await startBackend(root, backendPort, origin);
  const dist = resolve(root, 'apps/frontend/dist');
  frontend = httpsServer({
    key: await readFile(resolve(root, 'infra/tls/localhost-key.pem')),
    cert: await readFile(resolve(root, 'infra/tls/localhost.pem')),
  }, async (req, res) => {
    if (req.url.startsWith('/api/')) {
      const upstream = httpRequest({ hostname: '127.0.0.1', port: backendPort, path: req.url, method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${backendPort}` } }, (reply) => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
      upstream.on('error', () => { res.writeHead(502); res.end(); });
      req.pipe(upstream);
      return;
    }
    try {
      const pathname = new URL(req.url, origin).pathname;
      const file = pathname.startsWith('/assets/') ? resolve(dist, `.${pathname}`) : resolve(dist, 'index.html');
      if (!file.startsWith(`${dist}${sep}`)) throw new Error('Invalid asset path');
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(await readFile(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((done) => frontend.listen(frontendPort, '127.0.0.1', done));
  browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  page = observe(await context.newPage());
  await page.goto(`${origin}/monatsplanung/${plans.a}`);
  await page.getByLabel('E-Mail-Adresse').fill(adminEmail);
  await page.getByLabel('Passwort', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
  await page.getByRole('navigation', { name: 'Hauptnavigation' }).waitFor();

  await step('I7a-2 the integrated UI shows every legacy duty, including the dual DAY+NIGHT and the Sunday duty', async () => {
    await openPlan(plans.a, 'Dezember 2026');
    await page.getByRole('button', { name: 'Synthetic Eins, Mi., 16. Dezember: Tagdienst; Nachtdienst', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Synthetic Zwei, So., 20. Dezember: Tagdienst', exact: true }).waitFor();
  });

  await step('I7c legacy First Publish without a calendar: 409 PROJECT_CALENDAR_MISSING, German alert, nothing published', async () => {
    const { status, code } = await publish();
    assert.deepEqual([status, code], [409, 'PROJECT_CALENDAR_MISSING']);
    await assertRefusal(region(page, 'Planstatus'), 'Keine Betriebstage festgelegt', 'Der Plan wurde nicht veröffentlicht.');
    assert.equal((await planRow(plans.a)).status, 'UNPUBLISHED');
    assert.equal(await publishAudits(plans.a), 0);
  });

  await step('I7d explicit bootstrap: wrong month 400, a set not covering a live duty 409, the covering set APPLIED with bootstrap audit, a second bootstrap 400', async () => {
    const wrongMonth = await patchCalendar(ids.legacy, await readCalendar(ids.legacy, '2027-01-01'), { month: '2027-01-01', weekdays: [3, 7], bootstrap: true });
    assert.deepEqual([wrongMonth.status, wrongMonth.code], [400, 'PROJECT_CALENDAR_INVALID']);
    const december = await readCalendar(ids.legacy, '2026-12-01');
    assert.equal(december.state, 'MISSING');
    const uncovered = await patchCalendar(ids.legacy, december, { month: '2026-12-01', weekdays: [3], bootstrap: true });
    assert.deepEqual([uncovered.status, uncovered.code], [409, 'PROJECT_CALENDAR_DEPENDENCY_CONFLICT'], 'the Sunday duty must be covered');
    // Explicit admin choice covering every live duty date (Wednesday, Sunday); a synthetic example.
    const applied = await patchCalendar(ids.legacy, december, { month: '2026-12-01', weekdays: [3, 7], bootstrap: true });
    assert.deepEqual([applied.status, applied.body.outcome, applied.body.effective.operatingWeekdays], [200, 'APPLIED', [3, 7]]);
    const again = await patchCalendar(ids.legacy, await readCalendar(ids.legacy, '2026-12-01'), { month: '2026-12-01', weekdays: [3, 4, 7], bootstrap: true });
    assert.deepEqual([again.status, again.code], [400, 'PROJECT_CALENDAR_INVALID'], 'bootstrap is one-time');
    const audits = await calendarAudits();
    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0].new_values, { effectiveFromMonth: '2026-12-01', operatingWeekdays: [3, 7], version: 1, bootstrap: true });
    assert.equal(await snapshot().then((value) => JSON.parse(value).duties.length), JSON.parse(before).duties.length, 'bootstrap deletes nothing');
  });

  await step('I7e legacy dual DAY/NIGHT blocks First Publish: 409 EMPLOYEE_DAILY_SHIFT_CONFLICT, German alert, nothing published', async () => {
    await openPlan(plans.a, 'Dezember 2026');
    const { status, code } = await publish();
    assert.deepEqual([status, code], [409, 'EMPLOYEE_DAILY_SHIFT_CONFLICT']);
    await assertRefusal(region(page, 'Planstatus'), 'Tag- und Nachtdienst am selben Tag', 'Der Plan wurde nicht veröffentlicht.');
    assert.equal((await planRow(plans.a)).status, 'UNPUBLISHED');
  });

  await step('I7f correction by pure removal through the editor: the person leaves the NIGHT duty (200), although the legacy pair existed', async () => {
    const panel = await openEditor('Mi., 16. Dezember: Tagdienst, 1 Person; Nachtdienst, 1 Person', 'Dienste am Mi., 16.12.2026',
      'Nachtdienst', 'Nachtdienst am Mi., 16.12.2026 bearbeiten');
    await panel.getByRole('checkbox', { name: /^Synthetic Eins / }).uncheck();
    assert.equal((await saveEditor(panel)).status, 200);
    assert.deepEqual((await members(plans.a)).map((row) => [row.d, row.k]), [['2026-12-16', 'TAG'], ['2026-12-20', 'TAG']]);
  });

  await step('I7g First Publish after the correction: 200 PUBLISHED, one audit', async () => {
    const { status } = await publish();
    assert.equal(status, 200);
    await page.getByText(SUCCESS).waitFor();
    assert.equal((await planRow(plans.a)).status, 'PUBLISHED');
    assert.equal(await publishAudits(plans.a), 1);
  });

  await step('I7h the plan published before A1 stays PUBLISHED: a role change of a dual member is refused (409), a pure removal applies directly', async () => {
    const publishedBefore = (await planRow(plans.b)).published_at.toISOString();
    await openPlan(plans.b, 'Januar 2027');
    let panel = await openEditor('Mi., 13. Januar: Tagdienst, 1 Person; Nachtdienst, 1 Person', 'Dienste am Mi., 13.01.2027',
      'Tagdienst', 'Tagdienst am Mi., 13.01.2027 bearbeiten');
    await panel.getByRole('combobox', { name: 'Funktion im Dienst für Synthetic Eins' }).selectOption({ label: 'Schichtleitung' });
    const refused = await saveEditor(panel);
    assert.deepEqual([refused.status, refused.code], [409, 'EMPLOYEE_DAILY_SHIFT_CONFLICT']);
    await assertRefusal(panel, 'Tag- und Nachtdienst am selben Tag', 'Es wurde nichts geändert.');
    await closePanel(panel);
    panel = await openEditor('Mi., 13. Januar: Tagdienst, 1 Person; Nachtdienst, 1 Person', 'Dienste am Mi., 13.01.2027',
      'Nachtdienst', 'Nachtdienst am Mi., 13.01.2027 bearbeiten');
    await panel.getByRole('checkbox', { name: /^Synthetic Eins / }).uncheck();
    assert.equal((await saveEditor(panel)).status, 200);
    await page.getByText(/Der Plan ist veröffentlicht: Die Änderung gilt sofort, ohne erneutes Veröffentlichen\./).waitFor();
    const row = await planRow(plans.b);
    assert.deepEqual([row.status, row.published_at.toISOString()], ['PUBLISHED', publishedBefore]);
    assert.equal(await publishAudits(plans.b), 1, 'only the pre-A1 publication');
    assert.deepEqual((await members(plans.b)).map((member) => [member.d, member.k, member.f]), [['2027-01-13', 'TAG', 'MITARBEITER']]);
  });

  await step('I7i project without live duties: publish 409 MISSING; bootstrap at the company-local current month; publish 200', async () => {
    await openPlan(plans.empty, 'Dezember 2026');
    const blocked = await publish();
    assert.deepEqual([blocked.status, blocked.code], [409, 'PROJECT_CALENDAR_MISSING']);
    const current = (await pool.query(
      "SELECT to_char(date_trunc('month', clock_timestamp() AT TIME ZONE time_zone), 'YYYY-MM-DD') AS m FROM companies WHERE id = $1", [ids.company])).rows[0].m;
    const applied = await patchCalendar(ids.empty, await readCalendar(ids.empty, current), { month: current, weekdays: [1, 2, 3, 4, 5], bootstrap: true });
    assert.deepEqual([applied.status, applied.body.outcome], [200, 'APPLIED']);
    await openPlan(plans.empty, 'Dezember 2026');
    const done = await publish();
    assert.equal(done.status, 200);
    await page.getByText(SUCCESS).waitFor();
    assert.equal((await planRow(plans.empty)).status, 'PUBLISHED');
    assert.equal(await publishAudits(plans.empty), 1);
  });

  await step('I7-T totals: inventory clean after the explicit corrections; two calendar audits; no page errors', async () => {
    const scan = await inventory();
    report.inventoryAfter = scan;
    assert.deepEqual(scan.findings, []);
    assert.deepEqual(scan.projects.map((row) => [row.project, row.calendarVersions, row.missingPlanMonths]).sort(),
      [['empty', 1, []], ['legacy', 1, []]]);
    assert.equal((await calendarAudits()).length, 2);
    assert.deepEqual(report.pageErrors, []);
    assert.equal(report.consoleCategories.other ?? 0, 0);
  });
} catch (error) {
  report.failure = error instanceof Error ? error.message : 'Legacy acceptance failed';
  process.exitCode = 1;
  console.error(report.failure);
  if (page && !page.isClosed()) {
    report.failureUi = await page.locator('main').innerText().catch(() => 'Main view not present');
    await page.screenshot({ path: resolve(output, 'sp13-a1-legacy-failure.png'), fullPage: true }).catch(() => {});
  }
} finally {
  await browser?.close();
  if (frontend) await new Promise((done) => frontend.close(done));
  for (const child of [legacyBackend, backend]) {
    if (child && child.exitCode === null) { child.kill(); await new Promise((done) => child.once('exit', done)); }
  }
  if (seeded) {
    await verifyRecordedTestTarget();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='5s'");
      const hasCalendars = (await client.query("SELECT to_regclass('public.project_operating_calendars') IS NOT NULL AS ok")).rows[0].ok;
      for (const table of ['sessions', 'account_tokens', 'audit_event', 'idempotency_records', 'edit_leases', 'plan_assignments', 'duties',
        'monthly_plans', 'shift_configurations', 'project_assignments', ...(hasCalendars ? ['project_operating_calendars'] : []),
        'employees', 'projects', 'accounts']) {
        await client.query(`DELETE FROM ${table} WHERE company_id=$1`, [ids.company]);
      }
      await client.query('DELETE FROM companies WHERE id=$1', [ids.company]);
      await client.query('COMMIT');
      report.fixtureCleanup = 'PASS';
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  await pool.end();
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(output, 'sp13-a1-legacy-results.json'), `${JSON.stringify(report, null, 2)}\n`);
}
