/** SP-13 First Publish: real Chrome -> built React -> unmodified NestJS -> verified disposable PostgreSQL 17.
 * Playwright is an external, pinned test tool, not an application dependency (as in SP-10/SP-11/SP-12).
 * No mocked API, session injection, TLS bypass, .env fallback or browser storage.
 *
 * Fixture boundary: the harness inserts only PREREQUISITES directly (synthetic companies, accounts,
 * employees, projects, month assignments, shift times, one foreign-tenant plan). Every plan, duty,
 * publication, project deactivation and employee change asserted below is produced through the UI by
 * one of two administrators and read back from PostgreSQL. No publication is ever written by SQL.
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
  alpha: randomUUID(), bravo: randomUUID(), charlie: randomUUID(),
  foreignProject: randomUUID(), foreignPlan: randomUUID(),
};
const PROJECTS = {
  hafen: 'Synthetic Objekt Hafen', nord: 'Synthetic Objekt Nord', sued: 'Synthetic Objekt Süd',
  west: 'Synthetic Objekt West', ost: 'Synthetic Objekt Ost', mitte: 'Synthetic Objekt Mitte',
  kai: 'Synthetic Objekt Kai', werft: 'Synthetic Objekt Werft',
};
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
    ];
    for (const [accountId, companyId, address, role] of accounts) {
      await client.query("INSERT INTO accounts(id,company_id,email,account_scope,role,status,password_hash) VALUES($1,$2,$3,'TENANT',$4,'ACTIVE',$5)",
        [accountId, companyId, address, role, hash]);
    }
    const staff = [
      [ids.alpha, ids.alphaAccount, 'SYN-ALPHA', 'Synthetic', 'Alpha', 'BOTH'],
      [ids.bravo, ids.bravoAccount, 'SYN-BRAVO', 'Synthetic', 'Bravo', 'TAG'],
      [ids.charlie, ids.charlieAccount, 'SYN-CHARLIE', 'Synthetic', 'Charlie', 'BOTH'],
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
    // One project per person and month: Alpha and Bravo work at Hafen, Charlie at Werft.
    for (const [employeeId, projectId] of [[ids.alpha, projectIds.hafen], [ids.bravo, projectIds.hafen], [ids.charlie, projectIds.werft]]) {
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
  await step('P01 plan and duties created through the UI; the plan status offers the First Publish action', async () => {
    page = await login(context, `/monatsplanung?month=${MONTH}`, emails.admin);
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
  // Request facts only (path ids masked); never header values, bodies, keys or tokens.
  report.publishRequests = proxy.publishes.map((entry) => ({
    forwarded: entry.forwarded, status: entry.status, replayed: entry.replayed, bodyBytes: entry.bodyBytes,
    contentType: entry.contentType, csrf: entry.csrf, sameOrigin: entry.origin, keyPresent: entry.key !== null,
  }));
  await writeFile(resolve(output, 'sp13-publish-browser-results.json'), `${JSON.stringify(report, null, 2)}\n`);
}
