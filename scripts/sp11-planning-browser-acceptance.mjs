/** SP-11 PR-2: real Chrome -> built React -> unmodified NestJS -> verified disposable PostgreSQL 17.
 * Playwright is an external, pinned test tool, not an application dependency (as in SP-10).
 * No mocked API, session injection, TLS bypass, .env fallback or browser storage.
 *
 * Fixture boundary: the harness inserts only PREREQUISITES directly (synthetic companies,
 * accounts, employees, projects, month assignments, shift times, one foreign-tenant plan).
 * Every plan, duty and membership that is asserted as persisted is created through the UI
 * and read back from PostgreSQL; a later absence is entered through the real SP-10 UI.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
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
  sourceDirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '',
  browser: null,
  results: [],
  pageErrors: [],
};

// Synthetic identities (random per run) and data; examples, not business rules.
const ids = {
  company: randomUUID(), foreignCompany: randomUUID(),
  admin: randomUUID(), secondAdmin: randomUUID(), foreignAdmin: randomUUID(),
  alphaAccount: randomUUID(), bravoAccount: randomUUID(), charlieAccount: randomUUID(), deltaAccount: randomUUID(),
  alpha: randomUUID(), bravo: randomUUID(), charlie: randomUUID(), delta: randomUUID(),
  hafen: randomUUID(), messe: randomUUID(), foreignProject: randomUUID(), foreignPlan: randomUUID(),
};
const password = randomBytes(24).toString('base64url');
const email = (label, id) => `browser-${label}-${id}@secureplan.invalid`;
const emails = {
  admin: email('admin', ids.admin), secondAdmin: email('admin', ids.secondAdmin), alpha: email('employee', ids.alphaAccount),
};
const PROJECT = 'Synthetic Objekt Hafen';
const FOREIGN_PROJECT = 'Synthetic Fremdmandant Objekt';
const MONTH = '2026-12';
const MONTH_LABEL = 'Dezember 2026';
const PLAN_TITLE = `${PROJECT} – ${MONTH_LABEL}`;

let backend; let frontend; let browser; let page; let seeded = false;
let truncateNextDutyCreate = false;
const dutyPosts = [];
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

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
async function plansOf(companyId) {
  return (await pool.query(
    `SELECT id, project_id, to_char(planning_month, 'YYYY-MM-DD') AS month, status, published_at
     FROM monthly_plans WHERE company_id = $1 ORDER BY planning_month, id`, [companyId])).rows;
}
async function dutiesOf(companyId) {
  return (await pool.query(
    `SELECT id, to_char(duty_date, 'YYYY-MM-DD') AS date, shift_kind AS kind, time_zone,
            to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
            to_char(ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at,
            concurrency_version::text AS version, removed_at, updated_at
     FROM duties WHERE company_id = $1 ORDER BY duty_date, shift_kind DESC`, [companyId])).rows;
}
async function membersOf(companyId) {
  return (await pool.query(
    `SELECT to_char(d.duty_date, 'YYYY-MM-DD') AS date, d.shift_kind AS kind, pa.employee_id,
            pa.duty_function, pa.source, pa.state, pa.updated_at
     FROM plan_assignments pa JOIN duties d ON d.company_id = pa.company_id AND d.id = pa.duty_id
     WHERE pa.company_id = $1 ORDER BY d.duty_date, d.shift_kind DESC, pa.employee_id`, [companyId])).rows;
}
async function auditCounts(companyId) {
  const rows = (await pool.query(
    `SELECT action, count(*)::int AS n FROM audit_event
     WHERE company_id = $1 AND action IN ('MONTHLY_PLAN_CREATED', 'DUTY_CREATED', 'DUTY_MEMBERSHIP_ADDED')
     GROUP BY action`, [companyId])).rows;
  return Object.fromEntries(rows.map((row) => [row.action, row.n]));
}

// --- Browser helpers ---
async function login(context, path, address) {
  const opened = await context.newPage();
  opened.on('pageerror', () => report.pageErrors.push('Uncaught browser exception'));
  await opened.goto(`${origin}${path}`);
  await opened.getByLabel('E-Mail-Adresse').fill(address);
  await opened.getByLabel('Passwort', { exact: true }).fill(password);
  const response = opened.waitForResponse((r) => r.url().endsWith('/api/v1/auth/login') && r.request().method() === 'POST');
  await opened.getByRole('button', { name: 'Anmelden', exact: true }).click();
  assert.equal((await response).status(), 200);
  await opened.getByRole('navigation', { name: 'Hauptnavigation' }).waitFor();
  const cookie = (await context.cookies()).find((c) => c.name === '__Host-secureplan_session');
  assert.ok(cookie?.secure && cookie.httpOnly && cookie.sameSite === 'Lax');
  return opened;
}
const region = (target, name) => target.getByRole('heading', { level: 2, name, exact: true }).locator('xpath=ancestor::section[1]');
async function focusIs(locator) { assert.ok(await locator.evaluate((el) => el === document.activeElement)); }
async function dutyRows(target) {
  const table = target.getByRole('table', { name: `Dienste im ${MONTH_LABEL}` });
  await table.waitFor();
  return table.locator('tbody tr').evaluateAll((rows) =>
    rows.map((row) => [...row.querySelectorAll('th, td')].map((cell) => cell.textContent)));
}
async function storageEmpty(target) {
  assert.equal(await target.evaluate(() => localStorage.length + sessionStorage.length), 0);
}
async function noHorizontalScroll(target) {
  const [scroll, client] = await target.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  assert.ok(scroll <= client + 1, `horizontal page scroll: ${scroll} > ${client}`);
  // Content may also overflow inside a card without scrolling the page: every badge and
  // its text must stay inside its table cell.
  const clipped = await target.locator('main td .status-badge').evaluateAll((badges) => badges
    .filter((badge) => {
      const cell = badge.closest('td').getBoundingClientRect();
      const box = badge.getBoundingClientRect();
      return box.right > cell.right + 1 || badge.scrollWidth > badge.clientWidth + 1;
    })
    .map((badge) => badge.textContent));
  assert.deepEqual(clipped, [], `badges overflow their cells: ${clipped.join(', ')}`);
}
async function addDuty(target, { date, kind, members = [] }) {
  const form = region(target, 'Dienst hinzufügen');
  await form.getByLabel('Datum').fill(date);
  await form.getByRole('radio', { name: kind, exact: true }).check();
  for (const [name, role] of members) {
    await form.getByRole('checkbox', { name: new RegExp(`^${name} \\(`) }).check();
    if (role) await form.getByRole('combobox', { name: `Funktion im Dienst für ${name}` }).selectOption({ label: role });
  }
  await form.getByRole('button', { name: 'Dienst anlegen', exact: true }).click();
  return form;
}

let origin;
try {
  const backendPort = await freePort();
  const frontendPort = await freePort();
  origin = `https://localhost:${frontendPort}`;
  backend = spawn(process.execPath, ['apps/backend/dist/main.js'], {
    cwd: root, env: { ...process.env, PORT: String(backendPort), APP_ORIGIN: origin }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
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
      const isDutyCreate = req.method === 'POST' && /^\/api\/v1\/monthly-plans\/[^/]+\/entries$/.test(req.url);
      if (isDutyCreate) dutyPosts.push(req.url);
      const truncate = isDutyCreate && truncateNextDutyCreate;
      if (truncate) truncateNextDutyCreate = false;
      const upstream = proxyRequest({
        hostname: '127.0.0.1', port: backendPort, path: req.url, method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${backendPort}` },
      }, (reply) => {
        if (truncate && reply.statusCode === 201) {
          // Real success headers, then a truncated body AFTER PostgreSQL committed:
          // the browser cannot read the answer and must not claim success or failure.
          res.writeHead(reply.statusCode, reply.headers); res.flushHeaders();
          reply.resume(); reply.on('end', () => { res.write('{'); res.destroy(); });
          return;
        }
        res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
      });
      upstream.on('error', () => { res.writeHead(502); res.end(); });
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
  const contextOptions = { viewport: { width: 1280, height: 1000 }, locale: 'de-DE', timezoneId: 'Europe/Berlin' };
  const context = await browser.newContext(contextOptions);

  // --- Synthetic prerequisites (direct inserts; never used as persistence evidence) ---
  await verifyRecordedTestTarget();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hash = await hashPassword(password);
    await client.query("INSERT INTO companies(id,name,status,time_zone) VALUES($1,'Synthetic Planning Acceptance','ACTIVE','Europe/Berlin')", [ids.company]);
    await client.query("INSERT INTO companies(id,name,status,time_zone) VALUES($1,'Synthetic Foreign Tenant','ACTIVE','Europe/Berlin')", [ids.foreignCompany]);
    const accounts = [
      [ids.admin, ids.company, emails.admin, 'COMPANY_ADMIN'],
      [ids.secondAdmin, ids.company, emails.secondAdmin, 'COMPANY_ADMIN'],
      [ids.foreignAdmin, ids.foreignCompany, email('foreign-admin', ids.foreignAdmin), 'COMPANY_ADMIN'],
      [ids.alphaAccount, ids.company, emails.alpha, 'EMPLOYEE'],
      [ids.bravoAccount, ids.company, email('employee', ids.bravoAccount), 'EMPLOYEE'],
      [ids.charlieAccount, ids.company, email('employee', ids.charlieAccount), 'EMPLOYEE'],
      [ids.deltaAccount, ids.company, email('employee', ids.deltaAccount), 'EMPLOYEE'],
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
    ];
    for (const [employeeId, accountId, number, first, last, eligibility] of staff) {
      await client.query(
        "INSERT INTO employees(id,company_id,account_id,employee_number,first_name,last_name,shift_eligibility,employment_start) VALUES($1,$2,$3,$4,$5,$6,$7,'2020-01-01')",
        [employeeId, ids.company, accountId, number, first, last, eligibility]);
    }
    await client.query("INSERT INTO projects(id,company_id,name,status) VALUES($1,$2,$3,'ACTIVE')", [ids.hafen, ids.company, PROJECT]);
    await client.query("INSERT INTO projects(id,company_id,name,status) VALUES($1,$2,'Synthetic Objekt Messe','INACTIVE')", [ids.messe, ids.company]);
    await client.query("INSERT INTO projects(id,company_id,name,status) VALUES($1,$2,$3,'ACTIVE')", [ids.foreignProject, ids.foreignCompany, FOREIGN_PROJECT]);
    // Example shift times for the plan month (company local time), not business rules.
    for (const [kind, start, end] of [['TAG', '06:00', '18:00'], ['NACHT', '18:00', '06:00']]) {
      await client.query(
        `INSERT INTO shift_configurations(company_id,project_id,effective_from_month,shift_kind,start_local,end_local)
         VALUES($1,$2,$3::date,$4,$5::time,$6::time)`, [ids.company, ids.hafen, `${MONTH}-01`, kind, start, end]);
    }
    // Alpha, Bravo and Charlie belong to the project in the plan month; Delta does not.
    for (const employeeId of [ids.alpha, ids.bravo, ids.charlie]) {
      await client.query('INSERT INTO project_assignments(company_id,employee_id,project_id,planning_month) VALUES($1,$2,$3,$4::date)',
        [ids.company, employeeId, ids.hafen, `${MONTH}-01`]);
    }
    // Pre-existing absence of Charlie (fixture) for the neutral refusal check.
    await client.query("INSERT INTO employee_availability_days(company_id,employee_id,day,status) VALUES($1,$2,'2026-12-10','SICK')", [ids.company, ids.charlie]);
    // A plan of ANOTHER tenant, for the isolation check only.
    await client.query("INSERT INTO monthly_plans(id,company_id,project_id,planning_month) VALUES($1,$2,$3,$4::date)",
      [ids.foreignPlan, ids.foreignCompany, ids.foreignProject, `${MONTH}-01`]);
    await client.query('COMMIT');
    seeded = true;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  const foreignBefore = JSON.stringify(await plansOf(ids.foreignCompany));

  await step('P01 admin form login on a planning deep link; overview of the current month', async () => {
    page = await login(context, '/monatsplanung', emails.admin);
    await page.getByRole('heading', { level: 1, name: 'Monatsplanung' }).waitFor();
    const now = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric', timeZone: 'Europe/Berlin' }).format(new Date());
    await page.getByRole('heading', { level: 3, name: now }).waitFor();
    await page.getByRole('link', { name: /^Nächster Monat: / }).click();
    await page.waitForURL(/\/monatsplanung\?month=\d{4}-\d{2}$/);
    await page.goto(`${origin}/monatsplanung?month=${MONTH}`);
    await page.getByRole('heading', { level: 3, name: MONTH_LABEL }).waitFor();
    const table = page.getByRole('table', { name: `Projekte und Monatspläne im ${MONTH_LABEL}` });
    await table.waitFor();
    assert.equal(await table.getByRole('row', { name: /Synthetic Objekt Messe/ }).getByRole('button').count(), 0);
    assert.equal(await page.getByText(FOREIGN_PROJECT).count(), 0, 'foreign tenant project must not be listed');
    await storageEmpty(page);
    await page.screenshot({ path: resolve(output, 'sp11-pr2-overview.png'), fullPage: true });
  });

  await step('P02 keyboard-only plan creation with confirmation; UNPUBLISHED row and audit in PostgreSQL', async () => {
    const trigger = page.getByRole('button', { name: `Monatsplan für ${PROJECT}, ${MONTH_LABEL} erstellen …` });
    await trigger.focus(); await page.keyboard.press('Enter');
    const heading = page.getByRole('heading', { level: 3, name: `Monatsplan für ${PROJECT}, ${MONTH_LABEL} erstellen?` });
    await heading.waitFor(); await focusIs(heading);
    assert.deepEqual(await plansOf(ids.company), [], 'opening the confirmation must not write');
    await page.keyboard.press('Tab'); await focusIs(page.getByRole('button', { name: 'Monatsplan erstellen', exact: true }));
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { level: 1, name: PLAN_TITLE }).waitFor();
    await page.getByText('Der Monatsplan wurde erstellt.', { exact: false }).waitFor();
    const plans = await plansOf(ids.company);
    assert.equal(plans.length, 1);
    assert.deepEqual({ project: plans[0].project_id, month: plans[0].month, status: plans[0].status, publishedAt: plans[0].published_at },
      { project: ids.hafen, month: `${MONTH}-01`, status: 'UNPUBLISHED', publishedAt: null });
    assert.ok(page.url().endsWith(`/monatsplanung/${plans[0].id}`));
    assert.deepEqual(await auditCounts(ids.company), { MONTHLY_PLAN_CREATED: 1 });
    report.planId = plans[0].id;
  });

  await step('P03 eligible pre-selection, DAY duty with roles; resolved instants and members in PostgreSQL', async () => {
    const form = region(page, 'Dienst hinzufügen');
    await form.getByText('Tagdienst: 06:00 – 18:00').waitFor();
    await form.getByLabel('Datum').fill('2026-12-03');
    await form.getByRole('radio', { name: 'Tagdienst', exact: true }).check();
    const offered = await form.getByRole('list', { name: 'Auswählbare Personen' }).getByRole('checkbox').evaluateAll((boxes) =>
      boxes.map((box) => box.closest('label').textContent));
    // Delta is not assigned to the project in this month; absence is not pre-filtered (server decides).
    assert.deepEqual(offered, ['Synthetic Alpha (SYN-ALPHA)', 'Synthetic Bravo (SYN-BRAVO)', 'Synthetic Charlie (SYN-CHARLIE)']);
    await form.getByRole('checkbox', { name: /^Synthetic Alpha/ }).check();
    await form.getByRole('combobox', { name: 'Funktion im Dienst für Synthetic Alpha' }).selectOption({ label: 'Schichtleitung' });
    await form.getByRole('checkbox', { name: /^Synthetic Bravo/ }).check();
    const submit = form.getByRole('button', { name: 'Dienst anlegen', exact: true });
    await submit.focus(); await page.keyboard.press('Enter');
    const notice = page.getByText('Der Tagdienst am Do., 03.12.2026 wurde angelegt.', { exact: true });
    await notice.waitFor(); await focusIs(notice);
    assert.deepEqual(await dutyRows(page), [
      ['Do., 03.12.2026', 'Tagdienst', '06:00 – 18:00 MEZ', 'Synthetic Alpha · SchichtleitungSynthetic Bravo'],
    ]);
    const duties = await dutiesOf(ids.company);
    assert.equal(duties.length, 1);
    assert.deepEqual([duties[0].date, duties[0].kind, duties[0].starts_at, duties[0].ends_at, duties[0].time_zone, duties[0].version],
      ['2026-12-03', 'TAG', '2026-12-03T05:00:00Z', '2026-12-03T17:00:00Z', 'Europe/Berlin', '1']);
    const members = await membersOf(ids.company);
    assert.deepEqual(members.map((row) => [row.employee_id, row.duty_function, row.source, row.state]).sort(), [
      [ids.alpha, 'SCHICHTLEITER', 'NORMAL', 'ACTIVE'],
      [ids.bravo, 'MITARBEITER', 'NORMAL', 'ACTIVE'],
    ].sort());
    assert.deepEqual(await auditCounts(ids.company), { MONTHLY_PLAN_CREATED: 1, DUTY_CREATED: 1, DUTY_MEMBERSHIP_ADDED: 2 });
  });

  await step('P04 NIGHT duty across the year boundary; DAY-only person excluded with reason', async () => {
    const form = region(page, 'Dienst hinzufügen');
    await form.getByLabel('Datum').fill('2026-12-31');
    await form.getByRole('radio', { name: 'Nachtdienst', exact: true }).check();
    await form.getByText('1 weitere zugeordnete Person ist nicht auswählbar').click();
    await form.getByText('Synthetic Bravo: nicht für diese Dienstart freigegeben', { exact: true }).waitFor();
    await form.getByRole('checkbox', { name: /^Synthetic Alpha/ }).check();
    await form.getByRole('button', { name: 'Dienst anlegen', exact: true }).click();
    await page.getByText('Der Nachtdienst am Do., 31.12.2026 wurde angelegt.', { exact: true }).waitFor();
    const rows = await dutyRows(page);
    assert.deepEqual(rows[1], ['Do., 31.12.2026', 'Nachtdienst', '18:00 – 06:00 (Fr., 01.01.2027) MEZ', 'Synthetic Alpha']);
    const night = (await dutiesOf(ids.company)).find((row) => row.date === '2026-12-31');
    assert.deepEqual([night.kind, night.starts_at, night.ends_at], ['NACHT', '2026-12-31T17:00:00Z', '2027-01-01T05:00:00Z']);
  });

  await step('P05 neutral refusal of an absent member: nothing persisted, no reason shown', async () => {
    const before = { duties: (await dutiesOf(ids.company)).length, audit: await auditCounts(ids.company) };
    const form = await addDuty(page, { date: '2026-12-10', kind: 'Tagdienst', members: [['Synthetic Charlie']] });
    const alert = form.getByRole('alert');
    await alert.getByText('Person nicht verfügbar', { exact: true }).waitFor();
    assert.match(await alert.innerText(), /Es wurde nichts gespeichert\./);
    assert.doesNotMatch(await page.locator('main').innerText(), /krank|urlaub|sick|leave/i);
    assert.equal(await form.getByLabel('Datum').inputValue(), '2026-12-10', 'input is kept');
    assert.equal((await dutiesOf(ids.company)).length, before.duties);
    assert.deepEqual(await auditCounts(ids.company), before.audit);
  });

  const otherContext = await browser.newContext(contextOptions);
  const other = await login(otherContext, `/monatsplanung/${report.planId}`, emails.secondAdmin);
  await step('P06 a second real admin takes the slot first: DUTY_ALREADY_EXISTS, explicit reload shows one duty', async () => {
    await other.getByRole('heading', { level: 1, name: PLAN_TITLE }).waitFor();
    await addDuty(other, { date: '2026-12-04', kind: 'Tagdienst' });
    await other.getByText('Der Tagdienst am Fr., 04.12.2026 wurde angelegt.', { exact: true }).waitFor();
    // The first admin's list is stale; the server decides.
    const form = await addDuty(page, { date: '2026-12-04', kind: 'Tagdienst', members: [['Synthetic Charlie']] });
    await form.getByRole('alert').getByText('Dienst existiert bereits', { exact: true }).waitFor();
    await form.getByRole('button', { name: 'Dienste neu laden', exact: true }).click();
    const rows = await dutyRows(page);
    assert.equal(rows.filter((row) => row[0] === 'Fr., 04.12.2026').length, 1);
    const stored = (await dutiesOf(ids.company)).filter((row) => row.date === '2026-12-04');
    assert.equal(stored.length, 1);
    assert.equal((await membersOf(ids.company)).filter((row) => row.date === '2026-12-04').length, 0, 'loser members were not written');
  });

  await step('P07 committed response lost: outcome unknown, no automatic retry, reload shows exactly one duty', async () => {
    const posts = dutyPosts.length;
    const before = (await dutiesOf(ids.company)).length;
    truncateNextDutyCreate = true;
    const form = await addDuty(page, { date: '2026-12-05', kind: 'Nachtdienst', members: [['Synthetic Charlie']] });
    await form.getByRole('alert').getByText('Ergebnis unbekannt', { exact: true }).waitFor();
    assert.equal(await form.getByRole('button', { name: 'Erneut versuchen' }).count(), 0);
    await wait(300);
    assert.equal(dutyPosts.length, posts + 1, 'no automatic second POST');
    assert.equal((await dutiesOf(ids.company)).length, before + 1, 'the server committed once');
    await form.getByRole('button', { name: 'Dienste neu laden', exact: true }).click();
    const rows = await dutyRows(page);
    assert.equal(rows.filter((row) => row[0] === 'Sa., 05.12.2026').length, 1);
    assert.equal(await form.getByLabel('Datum').inputValue(), '2026-12-05', 'the form keeps the input for a deliberate decision');
  });

  await step('P08 later absence via the real SP-10 UI: neutral conflict hint; duties and members unchanged', async () => {
    const duties = JSON.stringify(await dutiesOf(ids.company));
    const members = JSON.stringify(await membersOf(ids.company));
    // Leave the plan page with input in the form: the unsaved-changes guard holds, then discard.
    await page.getByRole('link', { name: 'Mitarbeitende' }).click();
    const prompt = page.getByRole('group', { name: 'Ungespeicherter Dienst' });
    await prompt.waitFor(); await focusIs(prompt.getByRole('heading'));
    await prompt.getByRole('button', { name: 'Eingaben verwerfen und wechseln', exact: true }).click();
    await page.getByRole('heading', { level: 1, name: 'Mitarbeitende' }).waitFor();
    await page.goto(`${origin}/mitarbeitende/${ids.bravo}`);
    const area = region(page, 'Verfügbarkeit');
    await area.getByRole('button', { name: 'Verfügbarkeit anzeigen', exact: true }).click();
    await area.getByLabel('Anzeigemonat').fill(MONTH);
    await area.getByLabel('Von einschließlich').fill('2026-12-03');
    await area.getByLabel('Bis einschließlich').fill('2026-12-03');
    await area.getByRole('button', { name: 'Vorschau erstellen', exact: true }).click();
    await area.getByRole('heading', { name: /^Vorschau:/ }).waitFor();
    await area.getByRole('button', { name: 'Einträge speichern', exact: true }).click();
    await area.getByText(/Tage geändert, .*Tage unverändert/).waitFor();

    await page.goto(`${origin}/monatsplanung/${report.planId}`);
    const summary = page.getByRole('group', { name: /Nicht verfügbare Personen/ });
    await summary.waitFor();
    assert.match(await summary.innerText(), /Do\., 03\.12\.2026, Tagdienst: Synthetic Bravo/);
    const rows = await dutyRows(page);
    assert.match(rows[0][3], /Synthetic Bravo Nicht verfügbar/);
    assert.doesNotMatch(await page.locator('main').innerText(), /krank|urlaub|sick|leave/i);
    assert.equal(JSON.stringify(await dutiesOf(ids.company)), duties, 'an absence never changes a duty');
    assert.equal(JSON.stringify(await membersOf(ids.company)), members);
    await page.screenshot({ path: resolve(output, 'sp11-pr2-plan-desktop.png'), fullPage: true });
  });

  await step('P09 tenant isolation: a foreign plan id is concealed as not found; foreign rows unchanged', async () => {
    await page.goto(`${origin}/monatsplanung/${ids.foreignPlan}`);
    await page.getByRole('alert').getByText('Nicht gefunden', { exact: true }).waitFor();
    assert.equal(await page.getByText(FOREIGN_PROJECT).count(), 0);
    assert.equal(await page.getByRole('table').count(), 0);
    assert.equal(JSON.stringify(await plansOf(ids.foreignCompany)), foreignBefore);
    assert.equal((await dutiesOf(ids.foreignCompany)).length, 0);
  });

  await step('P10 narrow viewport (390 px): plan and overview usable without horizontal page scroll', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/monatsplanung/${report.planId}`);
    await page.getByRole('heading', { level: 1, name: PLAN_TITLE }).waitFor();
    await dutyRows(page);
    await region(page, 'Dienst hinzufügen').getByLabel('Datum').waitFor();
    await noHorizontalScroll(page);
    await page.screenshot({ path: resolve(output, 'sp11-pr2-plan-narrow.png'), fullPage: true });
    await page.goto(`${origin}/monatsplanung?month=${MONTH}`);
    await page.getByRole('table', { name: `Projekte und Monatspläne im ${MONTH_LABEL}` }).waitFor();
    await noHorizontalScroll(page);
    await page.screenshot({ path: resolve(output, 'sp11-pr2-overview-narrow.png'), fullPage: true });
    await page.setViewportSize(contextOptions.viewport);
  });

  await step('P11 EMPLOYEE role: no planning view; the API refuses the read with 403', async () => {
    const employeeContext = await browser.newContext(contextOptions);
    const employeePage = await login(employeeContext, '/mein-monatsplan', emails.alpha);
    await employeePage.goto(`${origin}/monatsplanung`);
    await employeePage.getByRole('heading', { level: 1, name: 'Kein Zugriff auf diese Ansicht' }).waitFor();
    const status = await employeePage.evaluate(async (url) =>
      (await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })).status, `/api/v1/monthly-plans/${report.planId}`);
    assert.equal(status, 403);
    assert.equal(await employeePage.getByText(PROJECT).count(), 0);
    await employeeContext.close();
  });

  await step('P12 logout, then Back, Forward and Refresh never show plan data; reload never repeats a write', async () => {
    const before = { duties: (await dutiesOf(ids.company)).length, audit: await auditCounts(ids.company), posts: dutyPosts.length };
    await page.goto(`${origin}/monatsplanung/${report.planId}`);
    await page.getByRole('heading', { level: 1, name: PLAN_TITLE }).waitFor();
    await page.reload();
    await page.getByRole('heading', { level: 1, name: PLAN_TITLE }).waitFor();
    await page.getByRole('button', { name: 'Abmelden', exact: true }).click();
    await page.getByRole('heading', { name: 'Anmelden', exact: true }).waitFor();
    await page.goBack();
    await page.getByRole('heading', { name: 'Anmelden', exact: true }).waitFor();
    assert.equal(await page.getByText(PROJECT).count(), 0);
    await page.goForward();
    await page.getByRole('heading', { name: 'Anmelden', exact: true }).waitFor();
    await page.goBack();
    await page.reload();
    await page.getByRole('heading', { name: 'Anmelden', exact: true }).waitFor();
    assert.equal(await page.getByText(PROJECT).count(), 0);
    assert.equal(await page.getByText('Synthetic Alpha').count(), 0);
    await storageEmpty(page);
    assert.deepEqual({ duties: (await dutiesOf(ids.company)).length, audit: await auditCounts(ids.company), posts: dutyPosts.length }, before);
    assert.deepEqual(report.pageErrors, []);
  });
} catch (error) {
  // Assertion and locator messages contain no raw headers or passwords.
  report.failure = error instanceof Error ? error.message : 'Browser acceptance failed';
  process.exitCode = 1;
  console.error(report.failure);
  if (page && !page.isClosed()) {
    report.failureUi = await page.locator('main').innerText().catch(() => 'Main view not present');
    await page.screenshot({ path: resolve(output, 'sp11-pr2-browser-failure.png'), fullPage: true }).catch(() => {});
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
        for (const table of ['sessions', 'account_tokens', 'audit_event', 'plan_assignments', 'duties', 'monthly_plans',
          'availability_batch_commands', 'employee_availability_days', 'shift_configurations', 'project_assignments',
          'employees', 'projects', 'accounts']) {
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
  await writeFile(resolve(output, 'sp11-pr2-browser-results.json'), `${JSON.stringify(report, null, 2)}\n`);
}
