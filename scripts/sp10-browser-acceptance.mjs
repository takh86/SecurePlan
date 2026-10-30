/** Real Chrome -> built React -> unmodified NestJS -> verified disposable PG.
 * Playwright is an external, pinned test tool, not an application dependency.
 * No mocked API, session injection, TLS bypass, .env fallback or browser storage.
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
const report = { startedAt: new Date().toISOString(), cluster: receipt.cluster,
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  browser: null, results: [], pageErrors: [] };
let backend; let frontend; let browser; let page; let area; let seeded = false;
let dropNextCommitResponse = false; let failNextMonthRead = false; let heldPreview = null;
const ids = { company: randomUUID(), admin: randomUUID(), secondAdmin: randomUUID(),
  account: randomUUID(), employee: randomUUID(), secondAccount: randomUUID(), secondEmployee: randomUUID() };
const password = randomBytes(24).toString('base64url');
const emails = [`browser-admin-${ids.admin}@secureplan.invalid`, `browser-admin-${ids.secondAdmin}@secureplan.invalid`];
const dates = ['2026-10-28', '2026-10-29'];
const holds = [];
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const apiPath = `/api/v1/employees/${ids.employee}/availability`;
async function step(name, work) {
  try { await work(); report.results.push({ name, result: 'PASS' }); console.log(`PASS ${name}`); }
  catch (error) { report.results.push({ name, result: 'FAIL' }); throw error; }
}
async function port() {
  const server = httpServer(); await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const value = server.address().port; await new Promise((done) => server.close(done)); return value;
}
async function rows() {
  return (await pool.query(`SELECT to_char(day,'YYYY-MM-DD') AS day,status FROM employee_availability_days
    WHERE company_id=$1 AND employee_id=$2 ORDER BY day`, [ids.company, ids.employee])).rows;
}
async function auditCount() { return Number((await pool.query('SELECT count(*) FROM audit_event WHERE company_id=$1 AND resource_type=$2', [ids.company, 'EMPLOYEE_AVAILABILITY'])).rows[0].count); }
async function login(context, origin, email) {
  const page = await context.newPage(); page.on('pageerror', () => report.pageErrors.push('Uncaught browser exception'));
  await page.goto(`${origin}/mitarbeitende/${ids.employee}`);
  await page.getByLabel('E-Mail-Adresse').fill(email); await page.getByLabel('Passwort', { exact: true }).fill(password);
  const response = page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/login') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click(); assert.equal((await response).status(), 200);
  await page.getByRole('button', { name: 'Verfügbarkeit anzeigen', exact: true }).waitFor();
  const cookie = (await context.cookies()).find((c) => c.name === '__Host-secureplan_session');
  assert.ok(cookie?.secure && cookie.httpOnly && cookie.sameSite === 'Lax');
  return page;
}
function section(page) { return page.getByRole('region', { name: 'Verfügbarkeit', exact: true }); }
async function open(page) {
  const area = section(page); await area.getByRole('button', { name: 'Verfügbarkeit anzeigen', exact: true }).click();
  await area.getByLabel('Anzeigemonat').fill('2026-10');
  await area.getByLabel('Von einschließlich').fill(dates[0]); await area.getByLabel('Bis einschließlich').fill(dates[1]);
  await area.getByText('Keine Verfügbarkeitseinträge in diesem Monat.', { exact: true }).waitFor(); return area;
}
async function preview(area) { await area.getByRole('button', { name: 'Vorschau erstellen', exact: true }).click(); await area.getByRole('heading', { name: /^Vorschau:/ }).waitFor(); }
async function saved(area) { await area.getByText(/Tage geändert, .*Tage unverändert/).waitFor(); }
async function focusIs(locator) { assert.ok(await locator.evaluate((el) => el === document.activeElement)); }
function latch() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

try {
  const backendPort = await port(); const frontendPort = await port(); const origin = `https://localhost:${frontendPort}`;
  backend = spawn(process.execPath, ['apps/backend/dist/main.js'], { cwd: root,
    env: { ...process.env, PORT: String(backendPort), APP_ORIGIN: origin }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  // Logs are deliberately not copied into evidence (no request or credential logging).
  backend.stdout.resume(); backend.stderr.resume();
  const until = Date.now() + 15_000;
  while (true) {
    if (backend.exitCode !== null) throw new Error('Isolated backend failed to start');
    try { if ((await fetch(`http://127.0.0.1:${backendPort}/api/v1/health/ready`)).status === 200) break; } catch {}
    assert.ok(Date.now() < until, 'Isolated backend readiness timeout'); await wait(100);
  }
  const dist = resolve(root, 'apps/frontend/dist');
  frontend = httpsServer({ key: await readFile(resolve(root, 'infra/tls/localhost-key.pem')),
    cert: await readFile(resolve(root, 'infra/tls/localhost.pem')) }, async (req, res) => {
    if (req.url.startsWith('/api/')) {
      if (failNextMonthRead && req.method === 'GET' && req.url.startsWith(`${apiPath}?`)) {
        failNextMonthRead = false; res.writeHead(502); res.end(); return;
      }
      const drop = dropNextCommitResponse && req.method === 'POST' && req.url === `${apiPath}/batch`;
      if (drop) dropNextCommitResponse = false;
      const hold = req.method === 'POST' && req.url === `${apiPath}/preview` ? heldPreview : null;
      if (hold) heldPreview = null;
      const upstream = proxyRequest({ hostname: '127.0.0.1', port: backendPort, path: req.url,
        method: req.method, headers: { ...req.headers, host: `127.0.0.1:${backendPort}` } }, async (reply) => {
        if (drop && reply.statusCode === 200) {
          // Send real success headers, then truncate the body after PostgreSQL
          // committed. This prevents a browser's transparent pre-header retry.
          res.writeHead(reply.statusCode, reply.headers); res.flushHeaders();
          reply.resume(); reply.on('end', () => { res.write('{'); res.destroy(); }); return;
        }
        if (hold) { hold.ready.resolve(); await hold.resume.promise; }
        res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
      });
      upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream); return;
    }
    try {
      const pathname = new URL(req.url, origin).pathname;
      const asset = pathname.startsWith('/assets/'); const file = asset ? resolve(dist, `.${pathname}`) : resolve(dist, 'index.html');
      if (!file.startsWith(`${dist}${sep}`)) throw new Error('Invalid asset path');
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(await readFile(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((done) => frontend.listen(frontendPort, '127.0.0.1', done));
  // Use the installed, supported Chrome channel and normal certificate validation.
  browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'de-DE' });
  const probe = await context.newPage(); await probe.goto(origin); await probe.close();
  await verifyRecordedTestTarget();
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); const hash = await hashPassword(password);
    await client.query("INSERT INTO companies(id,name,status,time_zone) VALUES($1,'Synthetic Browser Acceptance','ACTIVE','Europe/Berlin')", [ids.company]);
    for (const [accountId, email, role] of [[ids.admin, emails[0], 'COMPANY_ADMIN'], [ids.secondAdmin, emails[1], 'COMPANY_ADMIN'],
      [ids.account, `browser-employee-${ids.account}@secureplan.invalid`, 'EMPLOYEE'], [ids.secondAccount, `browser-employee-${ids.secondAccount}@secureplan.invalid`, 'EMPLOYEE']]) {
      await client.query("INSERT INTO accounts(id,company_id,email,account_scope,role,status,password_hash) VALUES($1,$2,$3,'TENANT',$4,'ACTIVE',$5)", [accountId, ids.company, email, role, hash]);
    }
    await client.query("INSERT INTO employees(id,company_id,account_id,employee_number,first_name,last_name,shift_eligibility,employment_start) VALUES($1,$2,$3,'BROWSER-SYNTHETIC','Synthetic','Employee','BOTH','2020-01-01')", [ids.employee, ids.company, ids.account]);
    await client.query("INSERT INTO employees(id,company_id,account_id,employee_number,first_name,last_name,shift_eligibility,employment_start) VALUES($1,$2,$3,'BROWSER-SECOND','Second','Employee','BOTH','2020-01-01')", [ids.secondEmployee, ids.company, ids.secondAccount]);
    await client.query('COMMIT'); seeded = true;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  await step('B01 real admin login, secure cookie and empty month', async () => { page = await login(context, origin, emails[0]); area = await open(page); });
  await step('B02 keyboard SET preview, focus, save and PG persistence', async () => {
    const button = area.getByRole('button', { name: 'Vorschau erstellen', exact: true }); await button.focus(); await page.keyboard.press('Enter');
    const heading = area.getByRole('heading', { name: /^Vorschau:/ }); await heading.waitFor(); await focusIs(heading);
    assert.equal(await area.getByRole('cell', { name: 'Neu eintragen', exact: true }).count(), 2);
    await page.keyboard.press('Tab'); await focusIs(area.getByRole('button', { name: 'Einträge speichern', exact: true })); await page.keyboard.press('Enter'); await saved(area);
    assert.deepEqual(await rows(), dates.map((day) => ({ day, status: 'SICK' }))); assert.equal(await auditCount(), 2);
    await area.getByRole('list', { name: 'Gespeicherte Verfügbarkeit' }).getByText(`${dates[0]}: Krank`, { exact: true }).waitFor();
    await area.getByLabel('Anzeigemonat').fill('2026-11'); await area.getByText('Keine Verfügbarkeitseinträge in diesem Monat.', { exact: true }).waitFor();
    await area.getByLabel('Anzeigemonat').fill('2026-10'); await area.getByRole('list', { name: 'Gespeicherte Verfügbarkeit' }).waitFor();
  });
  await step('B03 conflict REJECT, fresh REPLACE, keyboard confirmation and persistence', async () => {
    await area.getByRole('radio', { name: 'Urlaub (genehmigt)', exact: true }).check(); await preview(area);
    assert.equal(await area.getByRole('cell', { name: 'Abweichender Status', exact: true }).count(), 2);
    assert.equal(await area.getByRole('button', { name: 'Einträge speichern', exact: true }).count(), 0);
    await area.getByRole('button', { name: 'Vorschau zum Ersetzen erstellen', exact: true }).click();
    const confirm = area.getByRole('checkbox'); await confirm.waitFor();
    await page.screenshot({ path: resolve(output, 'sp10-replace-preview.png'), fullPage: true });
    const save = area.getByRole('button', { name: 'Bestätigte Ersetzung speichern', exact: true }); assert.ok(await save.isDisabled());
    await focusIs(area.getByRole('heading', { name: /^Vorschau:/ })); await page.keyboard.press('Tab'); await focusIs(confirm);
    await page.keyboard.press('Space'); await page.keyboard.press('Tab'); await focusIs(save); await page.keyboard.press('Enter'); await saved(area);
    assert.deepEqual(await rows(), dates.map((day) => ({ day, status: 'LEAVE' }))); assert.equal(await auditCount(), 4);
  });
  await step('B04 confirmed CLEAR, no confirmation write and actual removal', async () => {
    await area.getByRole('radio', { name: 'Einträge entfernen', exact: true }).check(); await preview(area);
    const save = area.getByRole('button', { name: 'Bestätigte Entfernung speichern', exact: true }); assert.ok(await save.isDisabled());
    assert.equal((await rows()).length, 2); await area.getByRole('checkbox').check(); await save.click(); await saved(area);
    assert.deepEqual(await rows(), []); assert.equal(await auditCount(), 6);
  });
  const otherContext = await browser.newContext({ locale: 'de-DE' });
  const otherPage = await login(otherContext, origin, emails[1]); const other = await open(otherPage);
  await step('B05 competing real admin invalidates preview; stale recovery retains input', async () => {
    await area.getByRole('radio', { name: 'Eintragen', exact: true }).check(); await area.getByRole('radio', { name: 'Krank', exact: true }).check(); await preview(area);
    await preview(other); await other.getByRole('button', { name: 'Einträge speichern', exact: true }).click(); await saved(other);
    await area.getByRole('button', { name: 'Einträge speichern', exact: true }).click();
    await area.getByRole('heading', { name: 'Vorschau nicht mehr gültig', exact: true }).waitFor();
    assert.equal(await area.getByRole('heading', { name: /^Vorschau:/ }).count(), 0);
    assert.equal(await area.getByLabel('Von einschließlich').inputValue(), dates[0]); assert.equal(await auditCount(), 8);
    await preview(area); await area.getByRole('button', { name: 'Einträge speichern', exact: true }).click(); await saved(area); assert.equal(await auditCount(), 8);
  });
  await step('B06 month reload after competing CLEAR discards confirmed preview', async () => {
    await area.getByRole('radio', { name: 'Einträge entfernen', exact: true }).check(); await preview(area); await area.getByRole('checkbox').check();
    await area.getByRole('button', { name: 'Verfügbarkeit ausblenden', exact: true }).click();
    await other.getByRole('radio', { name: 'Einträge entfernen', exact: true }).check(); await preview(other); await other.getByRole('checkbox').check();
    await other.getByRole('button', { name: 'Bestätigte Entfernung speichern', exact: true }).click(); await saved(other);
    await area.getByRole('button', { name: 'Verfügbarkeit anzeigen', exact: true }).click();
    await area.getByText('Keine Verfügbarkeitseinträge in diesem Monat.', { exact: true }).waitFor();
    assert.equal(await area.getByRole('checkbox').count(), 0, 'Changed month data must discard old confirmation');
    assert.equal(await area.getByRole('button', { name: 'Bestätigte Entfernung speichern', exact: true }).count(), 0);
    assert.deepEqual(await rows(), []);
  });
  await step('B07 cancel restores focus, reload never repeats a mutation, privacy-safe audit', async () => {
    await preview(area); await area.getByRole('button', { name: 'Vorschau verwerfen', exact: true }).click();
    await focusIs(area.getByRole('button', { name: 'Verfügbarkeit ausblenden', exact: true }));
    const before = await auditCount(); await page.reload(); await page.getByRole('button', { name: 'Verfügbarkeit anzeigen', exact: true }).waitFor();
    assert.equal(await auditCount(), before);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    const audits = (await pool.query('SELECT old_values,new_values FROM audit_event WHERE company_id=$1 AND resource_type=$2', [ids.company, 'EMPLOYEE_AVAILABILITY'])).rows;
    for (const event of audits) for (const value of [event.old_values, event.new_values]) if (value !== null) assert.deepEqual(Object.keys(value), ['day']);
    assert.deepEqual(report.pageErrors, []);
    await page.screenshot({ path: resolve(output, 'sp10-browser-final.png'), fullPage: true });
  });
  const sent = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith(`${apiPath}/batch`)) sent.push({ body: req.postData(), key: req.headers()['idempotency-key'] });
  });
  await step('B08 actual committed response lost; exact explicit retry replays without duplicate audit', async () => {
    area = await open(page); await preview(area); const before = await auditCount(); const offset = sent.length;
    dropNextCommitResponse = true; await area.getByRole('button', { name: 'Einträge speichern', exact: true }).click();
    const retry = area.getByRole('button', { name: 'Denselben Vorgang erneut prüfen', exact: true }); await retry.waitFor();
    assert.ok(await area.getByLabel('Von einschließlich').isDisabled());
    assert.equal(await auditCount(), before + 2); assert.equal((await rows()).length, 2);
    const replay = page.waitForResponse((r) => r.url().endsWith(`${apiPath}/batch`)); await retry.click();
    const response = await replay; assert.equal(response.status(), 200); assert.equal(response.headers()['idempotency-replayed'], 'true'); await saved(area);
    assert.equal(sent.length, offset + 2); assert.deepEqual(sent[offset], sent[offset + 1]); assert.equal(await auditCount(), before + 2);
  });
  await step('B09 failed authoritative refresh preserves acknowledged success; read retry never repeats CLEAR', async () => {
    await area.getByRole('radio', { name: 'Einträge entfernen', exact: true }).check(); await preview(area); await area.getByRole('checkbox').check();
    failNextMonthRead = true; const offset = sent.length; await area.getByRole('button', { name: 'Bestätigte Entfernung speichern', exact: true }).click();
    await saved(area); await area.getByRole('alert').waitFor(); assert.deepEqual(await rows(), []); assert.equal(sent.length, offset + 1);
    assert.equal(await area.getByRole('button', { name: 'Denselben Vorgang erneut prüfen', exact: true }).count(), 0);
    await area.getByRole('button', { name: 'Erneut versuchen', exact: true }).click();
    await area.getByText('Keine Verfügbarkeitseinträge in diesem Monat.', { exact: true }).waitFor(); assert.equal(sent.length, offset + 1);
  });
  await step('B10 validation and save preserve unrelated unsaved employee input', async () => {
    await page.getByRole('button', { name: 'Stammdaten bearbeiten', exact: true }).click();
    const code = page.getByLabel('Mitarbeiter-ID', { exact: true }); await code.fill('UNSAVED-BROWSER');
    await area.getByRole('radio', { name: 'Eintragen', exact: true }).check();
    await area.getByLabel('Von einschließlich').fill('2026-10-01'); await area.getByLabel('Bis einschließlich').fill('2027-01-02');
    await area.getByRole('button', { name: 'Vorschau erstellen', exact: true }).click(); await area.getByRole('heading', { name: 'Zeitraum prüfen', exact: true }).waitFor();
    assert.equal(await code.inputValue(), 'UNSAVED-BROWSER'); assert.equal(await area.getByLabel('Bis einschließlich').inputValue(), '2027-01-02');
    await area.getByLabel('Von einschließlich').fill(dates[0]); await area.getByLabel('Bis einschließlich').fill(dates[1]);
    await preview(area); await area.getByRole('button', { name: 'Einträge speichern', exact: true }).click(); await saved(area);
    assert.equal(await code.inputValue(), 'UNSAVED-BROWSER');
    assert.equal((await pool.query('SELECT employee_number FROM employees WHERE company_id=$1 AND id=$2', [ids.company, ids.employee])).rows[0].employee_number, 'BROWSER-SYNTHETIC');
  });
  await step('B11 SPA employee switch ignores a delayed real preview; logout and new session discard decisions', async () => {
    const hold = { ready: latch(), resume: latch() }; holds.push(hold); heldPreview = hold;
    await area.getByRole('button', { name: 'Vorschau erstellen', exact: true }).click(); await hold.ready.promise;
    await page.getByRole('link', { name: 'Zurück zur Übersicht', exact: true }).click();
    await page.getByRole('link', { name: 'Second Employee', exact: true }).click();
    const switched = await open(page); const response = page.waitForResponse((r) => r.url().endsWith(`${apiPath}/preview`)); hold.resume.resolve();
    await (await response).finished();
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    assert.equal(await switched.getByRole('heading', { name: /^Vorschau:/ }).count(), 0);
    assert.equal(await switched.getByRole('button', { name: 'Denselben Vorgang erneut prüfen', exact: true }).count(), 0);
    await preview(switched); const before = await auditCount(); await page.getByRole('button', { name: 'Abmelden', exact: true }).click();
    await page.getByRole('heading', { name: 'Anmelden', exact: true }).waitFor();
    const next = await login(context, origin, emails[1]);
    assert.equal(await section(next).getByRole('heading', { name: /^Vorschau:/ }).count(), 0); assert.equal(await auditCount(), before);
    assert.equal(await next.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.deepEqual(report.pageErrors, []);
  });
} catch (error) {
  // Error messages from assertions/locators contain no raw headers or passwords.
  report.failure = error instanceof Error ? error.message : 'Browser acceptance failed'; process.exitCode = 1;
  console.error(report.failure);
  if (page && !page.isClosed()) {
    report.failureUi = await section(page).innerText().catch(() => 'Availability view not present');
    await page.screenshot({ path: resolve(output, 'sp10-browser-failure.png'), fullPage: true }).catch(() => {});
  }
} finally {
  for (const hold of holds) hold.resume.resolve();
  await browser?.close();
  if (frontend) await new Promise((done) => frontend.close(done));
  if (backend && backend.exitCode === null) { backend.kill(); await new Promise((done) => backend.once('exit', done)); }
  if (seeded) {
    await verifyRecordedTestTarget(); const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query("SET LOCAL lock_timeout='5s'");
      for (const table of ['sessions', 'account_tokens', 'audit_event', 'availability_batch_commands', 'employee_availability_days', 'employees', 'accounts']) {
        await client.query(`DELETE FROM ${table} WHERE company_id=$1`, [ids.company]);
      }
      await client.query('DELETE FROM companies WHERE id=$1', [ids.company]); await client.query('COMMIT');
      report.fixtureCleanup = 'PASS';
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  await pool.end(); report.finishedAt = new Date().toISOString();
  await writeFile(resolve(output, 'sp10-browser-results.json'), `${JSON.stringify(report, null, 2)}\n`);
}
