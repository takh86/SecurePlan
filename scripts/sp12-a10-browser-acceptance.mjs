/** SP-12 A10: real Chrome -> built React -> unmodified NestJS -> verified disposable PostgreSQL 17.
 * Playwright is an external, pinned test tool, not an application dependency (as in SP-10/SP-11).
 * No mocked API, session injection, TLS bypass, .env fallback or browser storage.
 *
 * Fixture boundary: the harness inserts only PREREQUISITES directly (synthetic companies,
 * accounts, employees, projects, month assignments, shift times, one foreign-tenant plan).
 * Plans, duties, edits, removals and leases asserted as persisted are produced through the UI
 * and read back from PostgreSQL. ONE fixture step is explicit: there is no publish endpoint yet
 * (SP-13), so A09 marks the plan PUBLISHED directly to check CR-03 behaviour of later edits.
 *
 * The backend runs with a short technical lease TTL (SECUREPLAN_EDIT_LEASE_TTL_SECONDS) so that
 * renewal, expiry and takeover happen in real time. The proxy can fail lease renewals (502) and
 * drop a committed write's response; it never alters a request.
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
const LEASE_TTL_SECONDS = 10;
const report = {
  startedAt: new Date().toISOString(),
  cluster: receipt.cluster,
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceDirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '',
  leaseTtlSeconds: LEASE_TTL_SECONDS,
  browser: null,
  results: [],
  pageErrors: [],
  consoleErrors: 0,
};

// Synthetic identities (random per run) and data; examples, not business rules.
const ids = {
  company: randomUUID(), foreignCompany: randomUUID(),
  admin: randomUUID(), secondAdmin: randomUUID(), foreignAdmin: randomUUID(),
  alphaAccount: randomUUID(), bravoAccount: randomUUID(), charlieAccount: randomUUID(), deltaAccount: randomUUID(),
  alpha: randomUUID(), bravo: randomUUID(), charlie: randomUUID(), delta: randomUUID(),
  hafen: randomUUID(), foreignProject: randomUUID(), foreignPlan: randomUUID(),
};
const password = randomBytes(24).toString('base64url');
const email = (label, id) => `browser-${label}-${id}@secureplan.invalid`;
const emails = { admin: email('admin', ids.admin), secondAdmin: email('admin', ids.secondAdmin), alpha: email('employee', ids.alphaAccount) };
const PROJECT = 'Synthetic Objekt Hafen';
const FOREIGN_PROJECT = 'Synthetic Fremdmandant Objekt';
const MONTH = '2026-12';
const MONTH_LABEL = 'Dezember 2026';
const PLAN_TITLE = `${PROJECT} – ${MONTH_LABEL}`;
const GRID = `Dienste im ${MONTH_LABEL} nach Person und Tag`;
const DAY_EDITOR = 'Tagdienst am Do., 03.12.2026 bearbeiten';

let backend; let frontend; let browser; let page; let seeded = false;
// Proxy controls and observations (request lines only; never headers or bodies in evidence).
const proxy = { failRenewals: false, faultNextPatch: null, writes: [] };
/** Every lease token seen in a response, to prove none leaks into DOM, URL, storage or a request line. */
const seenTokens = new Set();
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
    `SELECT id, status, published_at FROM monthly_plans WHERE company_id = $1 ORDER BY planning_month, id`, [companyId])).rows;
}
async function dutiesOf(companyId) {
  return (await pool.query(
    `SELECT id, to_char(duty_date, 'YYYY-MM-DD') AS date, shift_kind AS kind,
            to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
            concurrency_version::text AS version, removed_at IS NOT NULL AS removed
     FROM duties WHERE company_id = $1 ORDER BY duty_date, shift_kind DESC, id`, [companyId])).rows;
}
async function activeMembers(dutyId) {
  return (await pool.query(
    `SELECT employee_id, duty_function FROM plan_assignments
     WHERE company_id = $1 AND duty_id = $2 AND state = 'ACTIVE' ORDER BY employee_id`, [ids.company, dutyId])).rows
    .map((row) => [row.employee_id, row.duty_function]);
}
async function leaseOf(dutyId) {
  const { rows } = await pool.query(
    `SELECT owner_account_id, token_hash, renewed_at IS NOT NULL AS renewed, released_at IS NOT NULL AS released,
            expires_at > clock_timestamp() AS live
     FROM edit_leases WHERE company_id = $1 AND duty_id = $2`, [ids.company, dutyId]);
  return rows[0] ?? null;
}
async function auditCounts(companyId) {
  const rows = (await pool.query(
    `SELECT action, count(*)::int AS n FROM audit_event WHERE company_id = $1 AND action LIKE 'DUTY%' GROUP BY action`, [companyId])).rows;
  return Object.fromEntries(rows.map((row) => [row.action, row.n]));
}
const sha256 = (token) => createHash('sha256').update(token).digest();
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
  // Only counted: console text is never copied into evidence.
  target.on('console', (message) => { if (message.type() === 'error') report.consoleErrors += 1; });
  target.on('response', async (response) => {
    if (response.request().method() === 'POST' && response.url().endsWith('/edit-lease') && response.status() === 200) {
      const body = await response.json().catch(() => null);
      if (typeof body?.leaseToken === 'string') seenTokens.add(body.leaseToken);
    }
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
const grid = (target) => target.getByRole('grid', { name: GRID });
const cellButton = (target, name) => grid(target).getByRole('button', { name, exact: true });
async function focusIs(locator) { assert.ok(await locator.evaluate((el) => el === document.activeElement)); }
const activeLabel = (target) => target.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null);
async function rowHeaders(target) {
  return grid(target).getByRole('rowheader').evaluateAll((cells) => cells.map((cell) => cell.textContent));
}
async function noTokenExposed(target) {
  const dom = await target.content();
  const where = await target.evaluate(() => ({
    url: location.href,
    storage: JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
    cookies: document.cookie,
  }));
  for (const token of seenTokens) {
    assert.ok(!dom.includes(token), 'lease token in DOM');
    assert.ok(!where.url.includes(token) && !where.storage.includes(token) && !where.cookies.includes(token), 'lease token in URL/storage/cookie');
    assert.ok(proxy.writes.every((line) => !line.includes(token)), 'lease token in a request line');
  }
  assert.equal(await target.evaluate(() => localStorage.length + sessionStorage.length), 0);
}
async function noHorizontalPageScroll(target) {
  const [scroll, client] = await target.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  assert.ok(scroll <= client + 1, `horizontal page scroll: ${scroll} > ${client}`);
}
/** Opens the duty editor from a cell of the matrix and waits until it is editable (lease held). */
async function openEditor(target, cellName, kind = 'Tagdienst', editor = DAY_EDITOR) {
  await cellButton(target, cellName).click();
  await target.getByRole('region', { name: /03\.12\.2026|31\.12\.2026/ }).getByRole('button', { name: `${kind} bearbeiten`, exact: true }).click();
  const panel = region(target, editor);
  await panel.getByText('Für Sie reserviert').waitFor();
  await panel.getByLabel('Datum').waitFor();
  return panel;
}

let origin;
try {
  const backendPort = await freePort();
  const frontendPort = await freePort();
  origin = `https://localhost:${frontendPort}`;
  backend = spawn(process.execPath, ['apps/backend/dist/main.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(backendPort), APP_ORIGIN: origin, SECUREPLAN_EDIT_LEASE_TTL_SECONDS: String(LEASE_TTL_SECONDS) },
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
      const isRenewal = req.method === 'PUT' && req.url.endsWith('/edit-lease');
      if (isRenewal && proxy.failRenewals) {
        // A renewal that never reaches the server (gateway failure); the request is not forwarded.
        res.writeHead(502); res.end();
        return;
      }
      const isDutyWrite = /^\/api\/v1\/monthly-plans\/[^/]+\/entries\/[^/]+$/.test(req.url) && ['PATCH', 'DELETE'].includes(req.method);
      if (isDutyWrite || req.url.endsWith('/edit-lease')) proxy.writes.push(`${req.method} ${req.url}`);
      const fault = isDutyWrite && req.method === 'PATCH' ? proxy.faultNextPatch : null;
      if (fault) proxy.faultNextPatch = null;
      const upstream = proxyRequest({
        hostname: '127.0.0.1', port: backendPort, path: req.url, method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${backendPort}` },
      }, (reply) => {
        if (fault === 'truncate') {
          // Real success headers, then a truncated body AFTER PostgreSQL committed:
          // the browser cannot read the answer and must not claim success or failure.
          res.writeHead(reply.statusCode, reply.headers); res.flushHeaders();
          reply.resume(); reply.on('end', () => { res.write('{'); res.destroy(); });
          return;
        }
        if (fault === 'reset') {
          // The server committed; the connection closes before any response byte.
          reply.resume(); reply.on('end', () => res.destroy());
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
  const contextOptions = { viewport: { width: 1440, height: 1000 }, locale: 'de-DE', timezoneId: 'Europe/Berlin' };
  const context = await browser.newContext(contextOptions);

  // --- Synthetic prerequisites (direct inserts; never used as persistence evidence) ---
  await verifyRecordedTestTarget();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hash = await hashPassword(password);
    await client.query("INSERT INTO companies(id,name,status,time_zone) VALUES($1,'Synthetic A10 Acceptance','ACTIVE','Europe/Berlin')", [ids.company]);
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
    // A plan of ANOTHER tenant, for the isolation check only.
    await client.query('INSERT INTO monthly_plans(id,company_id,project_id,planning_month) VALUES($1,$2,$3,$4::date)',
      [ids.foreignPlan, ids.foreignCompany, ids.foreignProject, `${MONTH}-01`]);
    await client.query('COMMIT');
    seeded = true;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  const foreignBefore = JSON.stringify(await plansOf(ids.foreignCompany));

  await step('A01 plan created through the UI; the A10 matrix lists assigned persons by day', async () => {
    page = await login(context, `/monatsplanung?month=${MONTH}`, emails.admin);
    await page.getByRole('button', { name: `Monatsplan für ${PROJECT}, ${MONTH_LABEL} erstellen …` }).click();
    await page.getByRole('button', { name: 'Monatsplan erstellen', exact: true }).click();
    await page.getByRole('heading', { level: 1, name: PLAN_TITLE }).waitFor();
    const plans = await plansOf(ids.company);
    assert.equal(plans.length, 1);
    report.planId = plans[0].id;
    await grid(page).waitFor();
    // Delta is not assigned to the project in this month: no row.
    assert.deepEqual(await rowHeaders(page), [
      'Dienste am Tag', 'Synthetic AlphaSYN-ALPHA', 'Synthetic BravoSYN-BRAVO', 'Synthetic CharlieSYN-CHARLIE',
    ]);
    assert.equal(await grid(page).getByRole('columnheader').count(), 32);
    assert.equal(await grid(page).locator('button[tabindex="0"]').count(), 1, 'roving tabindex: one tab stop');
    // Sticky header and person column (5.7): computed in the real browser.
    const sticky = await grid(page).evaluate((table) => [
      getComputedStyle(table.querySelector('thead th')).position,
      getComputedStyle(table.querySelector('tbody th')).position,
    ]);
    assert.deepEqual(sticky, ['sticky', 'sticky']);
    await page.screenshot({ path: resolve(output, 'sp12-a10-matrix-empty.png'), fullPage: true });
  });

  await step('A02 keyboard: arrows/Home/End move one focus; Enter opens the focus panel; Escape returns', async () => {
    await cellButton(page, 'Di., 1. Dezember: kein Tagdienst; kein Nachtdienst').focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await activeLabel(page), 'Synthetic Alpha, Di., 1. Dezember: frei');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    assert.equal(await activeLabel(page), 'Synthetic Alpha, Do., 3. Dezember: frei');
    await page.keyboard.press('End');
    assert.equal(await activeLabel(page), 'Synthetic Alpha, Do., 31. Dezember: frei');
    await page.keyboard.press('Control+End');
    assert.equal(await activeLabel(page), 'Synthetic Charlie, Do., 31. Dezember: frei');
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    const panel = region(page, 'Synthetic Charlie · Di., 01.12.2026');
    await panel.waitFor();
    await focusIs(panel.getByRole('heading', { level: 3 }));
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'detached' });
    assert.equal(await activeLabel(page), 'Synthetic Charlie, Di., 1. Dezember: frei');
  });

  await step('A03 duties created from free cells (prefilled); persisted with members', async () => {
    await cellButton(page, 'Synthetic Alpha, Do., 3. Dezember: frei').click();
    await region(page, 'Synthetic Alpha · Do., 03.12.2026').getByRole('button', { name: 'Tagdienst anlegen', exact: true }).click();
    const form = region(page, 'Dienst hinzufügen');
    await form.getByText('Tagdienst: 06:00 – 18:00').waitFor();
    assert.equal(await form.getByLabel('Datum').inputValue(), '2026-12-03');
    assert.ok(await form.getByRole('checkbox', { name: /^Synthetic Alpha/ }).isChecked(), 'the cell person is preselected');
    await form.getByRole('combobox', { name: 'Funktion im Dienst für Synthetic Alpha' }).selectOption({ label: 'Schichtleitung' });
    await form.getByRole('checkbox', { name: /^Synthetic Bravo/ }).check();
    await form.getByRole('button', { name: 'Dienst anlegen', exact: true }).click();
    await page.getByText('Der Tagdienst am Do., 03.12.2026 wurde angelegt.', { exact: true }).waitFor();
    await cellButton(page, 'Synthetic Alpha, Do., 3. Dezember: Tagdienst, Schichtleitung').waitFor();

    await cellButton(page, 'Do., 31. Dezember: kein Tagdienst; kein Nachtdienst').click();
    await region(page, 'Dienste am Do., 31.12.2026').getByRole('button', { name: 'Nachtdienst anlegen', exact: true }).click();
    await region(page, 'Dienst hinzufügen').getByRole('checkbox', { name: /^Synthetic Charlie/ }).check();
    await region(page, 'Dienst hinzufügen').getByRole('button', { name: 'Dienst anlegen', exact: true }).click();
    await page.getByText('Der Nachtdienst am Do., 31.12.2026 wurde angelegt.', { exact: true }).waitFor();
    const duties = await dutiesOf(ids.company);
    assert.deepEqual(duties.map((row) => [row.date, row.kind, row.version, row.removed]), [
      ['2026-12-03', 'TAG', '1', false], ['2026-12-31', 'NACHT', '1', false],
    ]);
    report.day = duties[0].id;
    report.night = duties[1].id;
    assert.deepEqual(await activeMembers(report.day), [[ids.alpha, 'SCHICHTLEITER'], [ids.bravo, 'MITARBEITER']].sort());
  });

  await step('A04 edit with lease: renewed in real time past the TTL; one PATCH with version + token headers; lease released', async () => {
    const panel = await openEditor(page, 'Synthetic Bravo, Do., 3. Dezember: Tagdienst');
    const held = await leaseOf(report.day);
    assert.ok(held.live && !held.released && held.owner_account_id === ids.admin);
    const token = [...seenTokens].find((value) => sha256(value).equals(held.token_hash));
    assert.ok(token, 'the stored hash belongs to a token this browser received');
    await noTokenExposed(page);
    await panel.getByRole('checkbox', { name: /^Synthetic Bravo/ }).uncheck();
    await panel.getByRole('checkbox', { name: /^Synthetic Charlie/ }).check();
    // Longer than the TTL: only renewals keep the lease alive.
    await wait((LEASE_TTL_SECONDS + 3) * 1000);
    const renewed = await leaseOf(report.day);
    assert.ok(renewed.live && renewed.renewed && renewed.token_hash.equals(held.token_hash), 'renewed with the same token');
    const patch = page.waitForRequest((request) => request.method() === 'PATCH');
    await panel.getByRole('button', { name: 'Änderungen speichern', exact: true }).click();
    const headers = (await patch).headers();
    assert.equal(headers['expected-version'], '1');
    assert.equal(headers['edit-lease-token'], token);
    assert.ok(headers['x-csrf-token']);
    assert.deepEqual(JSON.parse((await patch).postData()), {
      assignments: [{ employeeId: ids.alpha, dutyRole: 'SHIFT_LEAD' }, { employeeId: ids.charlie, dutyRole: 'EMPLOYEE' }],
    });
    await page.getByText('Die Änderungen am Tagdienst am Do., 03.12.2026 wurden gespeichert.', { exact: true }).waitFor();
    assert.deepEqual(await activeMembers(report.day), [[ids.alpha, 'SCHICHTLEITER'], [ids.charlie, 'MITARBEITER']].sort());
    assert.equal((await dutiesOf(ids.company))[0].version, '2');
    await waitFor(async () => (await leaseOf(report.day)).released, 'lease released after closing');
    await cellButton(page, 'Synthetic Bravo, Do., 3. Dezember: frei').waitFor();
    assert.deepEqual(await auditCounts(ids.company), {
      DUTY_CREATED: 2, DUTY_MEMBERSHIP_ADDED: 4, DUTY_UPDATED: 1, DUTY_MEMBERSHIP_REMOVED: 1,
    });
    await noTokenExposed(page);
  });

  const otherContext = await browser.newContext(contextOptions);
  const other = await login(otherContext, `/monatsplanung/${report.planId}`, emails.secondAdmin);
  await step('A05 a second admin sees "being edited" read-only; after the release a retry acquires', async () => {
    const panel = await openEditor(page, 'Synthetic Alpha, Do., 3. Dezember: Tagdienst, Schichtleitung');
    await grid(other).waitFor();
    await cellButton(other, 'Synthetic Alpha, Do., 3. Dezember: Tagdienst, Schichtleitung').click();
    await other.getByRole('region', { name: /03\.12\.2026/ }).getByRole('button', { name: 'Tagdienst bearbeiten', exact: true }).click();
    const blocked = region(other, DAY_EDITOR);
    await blocked.getByText(/wird gerade von einer anderen Person bearbeitet/).waitFor();
    assert.equal(await blocked.getByLabel('Datum').count(), 0, 'no form without the lease');
    assert.equal(await blocked.getByRole('button', { name: 'Dienst löschen' }).count(), 0);
    await panel.getByRole('button', { name: 'Schließen', exact: true }).click();
    await waitFor(async () => (await leaseOf(report.day)).released, 'first admin released');
    await blocked.getByRole('button', { name: 'Erneut versuchen', exact: true }).click();
    await blocked.getByText('Für Sie reserviert').waitFor();
    assert.equal((await leaseOf(report.day)).owner_account_id, ids.secondAdmin);
    await blocked.getByRole('button', { name: 'Schließen', exact: true }).click();
    await waitFor(async () => (await leaseOf(report.day)).released, 'second admin released');
  });

  await step('A06 renewals fail -> lease lost (input kept); takeover + change by another admin -> explicit stale reload, nothing overwritten', async () => {
    const panel = await openEditor(page, 'Synthetic Alpha, Do., 3. Dezember: Tagdienst, Schichtleitung');
    await panel.getByRole('checkbox', { name: /^Synthetic Bravo/ }).check();
    const patches = proxy.writes.filter((line) => line.startsWith('PATCH')).length;
    proxy.failRenewals = true;
    await panel.getByText(/Ihre Reservierung gilt nicht mehr/).waitFor({ timeout: (LEASE_TTL_SECONDS + 15) * 1000 });
    assert.ok(await panel.getByRole('checkbox', { name: /^Synthetic Bravo/ }).isChecked(), 'input kept');
    assert.ok(await panel.getByRole('button', { name: 'Änderungen speichern', exact: true }).isDisabled());
    proxy.failRenewals = false;
    await waitFor(async () => !(await leaseOf(report.day)).live, 'expired on the server', 3_000);

    // The second admin takes the expired slot over and saves a change.
    await other.reload();
    await cellButton(other, 'Synthetic Charlie, Do., 3. Dezember: Tagdienst').click();
    await other.getByRole('region', { name: /03\.12\.2026/ }).getByRole('button', { name: 'Tagdienst bearbeiten', exact: true }).click();
    const theirs = region(other, DAY_EDITOR);
    await theirs.getByText('Für Sie reserviert').waitFor();
    await theirs.getByRole('combobox', { name: 'Funktion im Dienst für Synthetic Charlie' }).selectOption({ label: 'Schichtleitung' });
    await theirs.getByRole('button', { name: 'Änderungen speichern', exact: true }).click();
    await other.getByText('Die Änderungen am Tagdienst am Do., 03.12.2026 wurden gespeichert.', { exact: true }).waitFor();
    await waitFor(async () => (await leaseOf(report.day)).released, 'second admin released');

    // The first admin re-acquires explicitly: the version moved on, so the draft is not saved.
    await panel.getByRole('button', { name: 'Erneut reservieren', exact: true }).click();
    const alert = panel.getByRole('alert');
    await alert.getByText('Dienst wurde inzwischen geändert', { exact: true }).waitFor();
    assert.match(await alert.innerText(), /Eingeplant: Synthetic Bravo/);
    assert.equal(proxy.writes.filter((line) => line.startsWith('PATCH')).length, patches + 1, 'only the second admin wrote');
    await alert.getByRole('button', { name: 'Aktuellen Stand laden', exact: true }).click();
    await panel.getByText('Der aktuelle Stand wurde geladen.').waitFor();
    assert.equal(await panel.getByRole('combobox', { name: 'Funktion im Dienst für Synthetic Charlie' }).inputValue(), 'SHIFT_LEAD');
    assert.equal(await panel.getByRole('checkbox', { name: /^Synthetic Bravo/ }).isChecked(), false);
    assert.deepEqual(await activeMembers(report.day), [[ids.alpha, 'SCHICHTLEITER'], [ids.charlie, 'SCHICHTLEITER']].sort());
    await panel.getByRole('button', { name: 'Schließen', exact: true }).click();
    await waitFor(async () => (await leaseOf(report.day)).released, 'released after closing');
    await page.screenshot({ path: resolve(output, 'sp12-a10-matrix-desktop.png'), fullPage: true });
  });

  await step('A07 committed PATCH answer unreadable: unknown outcome, no automatic retry; explicit check confirms one change', async () => {
    const panel = await openEditor(page, 'Synthetic Alpha, Do., 3. Dezember: Tagdienst, Schichtleitung');
    await panel.getByRole('checkbox', { name: /^Synthetic Bravo/ }).check();
    const before = { patches: proxy.writes.filter((line) => line.startsWith('PATCH')).length, audit: await auditCounts(ids.company) };
    proxy.faultNextPatch = 'truncate';
    await panel.getByRole('button', { name: 'Änderungen speichern', exact: true }).click();
    await panel.getByRole('alert').getByText('Ergebnis unbekannt', { exact: true }).waitFor();
    await wait(1500);
    assert.equal(proxy.writes.filter((line) => line.startsWith('PATCH')).length, before.patches + 1, 'no automatic second PATCH');
    assert.equal((await auditCounts(ids.company)).DUTY_UPDATED, before.audit.DUTY_UPDATED + 1, 'the server committed once');
    await panel.getByRole('button', { name: 'Aktuellen Stand prüfen', exact: true }).click();
    await page.getByText('Die Änderungen am Tagdienst am Do., 03.12.2026 wurden gespeichert. Das hat das erneute Laden des aktuellen Stands bestätigt.', { exact: true }).waitFor();
    assert.equal(proxy.writes.filter((line) => line.startsWith('PATCH')).length, before.patches + 1);
    await cellButton(page, 'Synthetic Bravo, Do., 3. Dezember: Tagdienst').waitFor();
  });

  await step('A07b connection reset after commit: never applied twice (Expected-Version); the UI ends in the saved state', async () => {
    const panel = await openEditor(page, 'Synthetic Alpha, Do., 3. Dezember: Tagdienst, Schichtleitung');
    await panel.getByRole('checkbox', { name: /^Synthetic Bravo/ }).uncheck();
    const before = { patches: proxy.writes.filter((line) => line.startsWith('PATCH')).length, audit: await auditCounts(ids.company) };
    proxy.faultNextPatch = 'reset';
    await panel.getByRole('button', { name: 'Änderungen speichern', exact: true }).click();
    // The browser may transparently re-send a request whose connection closed before any
    // response byte. Either way the app shows no success, and the server applies it once.
    const alert = panel.getByRole('alert');
    await alert.waitFor();
    await wait(1500);
    report.resetResend = { patchesSent: proxy.writes.filter((line) => line.startsWith('PATCH')).length - before.patches };
    assert.ok([1, 2].includes(report.resetResend.patchesSent));
    assert.equal((await auditCounts(ids.company)).DUTY_UPDATED, before.audit.DUTY_UPDATED + 1, 'applied exactly once');
    const text = await alert.innerText();
    const button = /Ergebnis unbekannt/.test(text) ? 'Aktuellen Stand prüfen' : 'Aktuellen Stand laden';
    report.resetResend.uiState = button === 'Aktuellen Stand prüfen' ? 'unknown-outcome' : 'version-conflict';
    await alert.getByRole('button', { name: button, exact: true }).click();
    await page.getByText('Die Änderungen am Tagdienst am Do., 03.12.2026 wurden gespeichert. Das hat das erneute Laden des aktuellen Stands bestätigt.', { exact: true }).waitFor();
    assert.deepEqual(await activeMembers(report.day), [[ids.alpha, 'SCHICHTLEITER'], [ids.charlie, 'SCHICHTLEITER']].sort());
    await cellButton(page, 'Synthetic Bravo, Do., 3. Dezember: frei').waitFor();
  });

  await step('A08 deletion needs an explicit confirmation; cancel writes nothing; confirm removes once with audit', async () => {
    const panel = await openEditor(page, 'Synthetic Charlie, Do., 31. Dezember: Nachtdienst', 'Nachtdienst', 'Nachtdienst am Do., 31.12.2026 bearbeiten');
    await panel.getByRole('button', { name: 'Dienst löschen', exact: true }).click();
    const confirm = panel.getByRole('group', { name: 'Nachtdienst am Do., 31.12.2026 löschen?' });
    await confirm.waitFor();
    await focusIs(confirm.getByRole('heading'));
    assert.match(await confirm.innerText(), /1 eingeplante Person wird aus diesem Dienst ausgetragen\./);
    await confirm.getByRole('button', { name: 'Abbrechen', exact: true }).click();
    assert.equal((await dutiesOf(ids.company)).find((row) => row.id === report.night).removed, false);
    await panel.getByRole('button', { name: 'Dienst löschen', exact: true }).click();
    await panel.getByRole('button', { name: 'Ja, Dienst löschen', exact: true }).click();
    await page.getByText('Der Nachtdienst am Do., 31.12.2026 wurde gelöscht.', { exact: true }).waitFor();
    const night = (await dutiesOf(ids.company)).find((row) => row.id === report.night);
    assert.equal(night.removed, true);
    assert.deepEqual(await activeMembers(report.night), []);
    assert.ok((await leaseOf(report.night)).released, 'removal released the lease');
    assert.equal((await auditCounts(ids.company)).DUTY_REMOVED, 1);
    assert.equal(proxy.writes.filter((line) => line.startsWith('DELETE') && !line.endsWith('/edit-lease')).length, 1);
    await cellButton(page, 'Do., 31. Dezember: kein Tagdienst; kein Nachtdienst').waitFor();
  });

  await step('A09 CR-03 (fixture-published plan): an edit applies at once, the plan stays PUBLISHED, no publish request', async () => {
    // FIXTURE: no publish endpoint exists in this slice (SP-13); this simulates a first publication.
    await pool.query(
      `UPDATE monthly_plans SET status = 'PUBLISHED', published_at = date_trunc('second', clock_timestamp()),
              published_by_account_id = $2 WHERE company_id = $1 AND id = $3`, [ids.company, ids.admin, report.planId]);
    const published = (await plansOf(ids.company))[0];
    await page.reload();
    await grid(page).waitFor();
    assert.match(await page.getByRole('region', { name: 'Planstatus' }).innerText(), /Änderungen an Diensten gelten sofort, ohne erneutes Veröffentlichen\./);
    const panel = await openEditor(page, 'Synthetic Alpha, Do., 3. Dezember: Tagdienst, Schichtleitung');
    await panel.getByText(/Gespeicherte Änderungen gelten sofort im veröffentlichten Plan/).waitFor();
    await panel.getByRole('checkbox', { name: /^Synthetic Bravo/ }).check();
    await panel.getByRole('button', { name: 'Änderungen speichern', exact: true }).click();
    await page.getByText(/wurden gespeichert\. Der Plan ist veröffentlicht: Die Änderung gilt sofort, ohne erneutes Veröffentlichen\./).waitFor();
    assert.deepEqual(await activeMembers(report.day),
      [[ids.alpha, 'SCHICHTLEITER'], [ids.bravo, 'MITARBEITER'], [ids.charlie, 'SCHICHTLEITER']].sort());
    const after = (await plansOf(ids.company))[0];
    assert.deepEqual([after.status, after.published_at.toISOString()], ['PUBLISHED', published.published_at.toISOString()]);
    assert.ok(proxy.writes.every((line) => !/publish/i.test(line)));
  });

  await step('A10 leaving the page with an open editor (pagehide) releases the lease via keepalive', async () => {
    await openEditor(page, 'Synthetic Alpha, Do., 3. Dezember: Tagdienst, Schichtleitung');
    assert.equal((await leaseOf(report.day)).released, false);
    await page.goto('about:blank');
    await waitFor(async () => (await leaseOf(report.day)).released, 'pagehide released the lease', 5_000);
    await page.goto(`${origin}/monatsplanung/${report.planId}`);
    await grid(page).waitFor();
  });

  await step('A11 narrow (390 px) and tablet (1024 px): the matrix scrolls in its frame, never the page; panel usable', async () => {
    for (const width of [1024, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.reload();
      await grid(page).waitFor();
      await noHorizontalPageScroll(page);
      const frame = await page.locator('.planning-matrix__wrap').evaluate((el) => [el.scrollWidth > el.clientWidth, getComputedStyle(el).overflowX]);
      assert.deepEqual(frame, [true, 'auto'], 'the matrix scrolls inside its own frame');
      await cellButton(page, 'Synthetic Alpha, Do., 3. Dezember: Tagdienst, Schichtleitung').click();
      const panel = region(page, 'Synthetic Alpha · Do., 03.12.2026');
      await panel.waitFor();
      await noHorizontalPageScroll(page);
      await page.screenshot({ path: resolve(output, `sp12-a10-plan-${width}.png`), fullPage: true });
      await panel.getByRole('button', { name: 'Schließen', exact: true }).click();
    }
    await page.setViewportSize(contextOptions.viewport);
  });

  await step('A12 tenant isolation and role: a foreign plan is "not found"; an EMPLOYEE gets no planning view', async () => {
    await page.goto(`${origin}/monatsplanung/${ids.foreignPlan}`);
    await page.getByRole('alert').getByText('Nicht gefunden', { exact: true }).waitFor();
    assert.equal(await page.getByText(FOREIGN_PROJECT).count(), 0);
    assert.equal(await page.getByRole('grid').count(), 0);
    assert.equal(JSON.stringify(await plansOf(ids.foreignCompany)), foreignBefore);
    const employeeContext = await browser.newContext(contextOptions);
    const employeePage = await login(employeeContext, '/mein-monatsplan', emails.alpha);
    await employeePage.goto(`${origin}/monatsplanung/${report.planId}`);
    await employeePage.getByRole('heading', { level: 1, name: 'Kein Zugriff auf diese Ansicht' }).waitFor();
    assert.equal(await employeePage.getByText(PROJECT).count(), 0);
    await employeeContext.close();
  });

  await step('A13 logout with an editor open; Back/Forward/Refresh show no plan data; the lease ends by its TTL', async () => {
    await page.goto(`${origin}/monatsplanung/${report.planId}`);
    await openEditor(page, 'Synthetic Alpha, Do., 3. Dezember: Tagdienst, Schichtleitung');
    const writes = proxy.writes.filter((line) => !line.endsWith('/edit-lease')).length;
    await page.getByRole('button', { name: 'Abmelden', exact: true }).click();
    await page.getByRole('heading', { name: 'Anmelden', exact: true }).waitFor();
    await page.goBack();
    await page.getByRole('heading', { name: 'Anmelden', exact: true }).waitFor();
    assert.equal(await page.getByText(PROJECT).count(), 0);
    await page.goForward();
    await page.reload();
    await page.getByRole('heading', { name: 'Anmelden', exact: true }).waitFor();
    assert.equal(await page.getByText('Synthetic Alpha').count(), 0);
    // A release after the session ended is refused (401); the server lets the lease run out.
    await waitFor(async () => {
      const lease = await leaseOf(report.day);
      return lease.released || !lease.live;
    }, 'lease no longer live', (LEASE_TTL_SECONDS + 5) * 1000);
    assert.equal(proxy.writes.filter((line) => !line.endsWith('/edit-lease')).length, writes, 'no duty write after logout');
    await noTokenExposed(page);
    assert.deepEqual(report.pageErrors, []);
  });
  await otherContext.close();
} catch (error) {
  // Assertion and locator messages contain no raw headers, tokens or passwords.
  report.failure = error instanceof Error ? error.message : 'Browser acceptance failed';
  process.exitCode = 1;
  console.error(report.failure);
  if (page && !page.isClosed()) {
    report.failureUi = await page.locator('main').innerText().catch(() => 'Main view not present');
    await page.screenshot({ path: resolve(output, 'sp12-a10-browser-failure.png'), fullPage: true }).catch(() => {});
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
        for (const table of ['sessions', 'account_tokens', 'audit_event', 'edit_leases', 'plan_assignments', 'duties', 'monthly_plans',
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
  report.leaseTokensObserved = seenTokens.size;
  // Request lines only (method + path with ids masked); never headers, bodies or tokens.
  report.proxyWriteLines = proxy.writes.map((line) => line.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id'));
  await writeFile(resolve(output, 'sp12-a10-browser-results.json'), `${JSON.stringify(report, null, 2)}\n`);
}
