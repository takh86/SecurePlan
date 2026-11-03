/** F-A1-2 calendar admin UI: real Chrome -> built React -> unmodified NestJS -> verified disposable PostgreSQL 17.
 * Playwright is an external, pinned test tool, not an application dependency (as in SP-10 … SP-13).
 * No mocked API, session injection, TLS bypass, .env fallback or browser storage.
 *
 * Fixture boundary: the harness inserts only PREREQUISITES directly (synthetic companies, accounts,
 * projects, shift times for one month, and legacy pre-calendar plans/duties in past months, which
 * the current application can no longer create). Every calendar version asserted below is written
 * through the React UI by an administrator and read back from PostgreSQL; no calendar row is ever
 * written by SQL. Each weekday set is an explicit synthetic example, never a default or business rule.
 *
 * The proxy observes calendar requests (method, status, Cache-Control, CSRF/Origin presence and the
 * PATCH's non-secret body fields) and can drop one committed calendar answer (real headers, truncated
 * body). It never alters a forwarded request.
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
  sourceDirty: execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim() !== '',
  browser: null,
  months: null,
  results: [],
  pageErrors: [],
  consoleErrors: 0,
  consoleCategories: {},
};

// --- Months: the company zone is Europe/Berlin; the UI decides "past" for every zone (UTC-12 … UTC+14). ---
function monthOf(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit' })
    .formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}`;
}
function addMonths(month, delta) {
  const [year, number] = month.split('-').map(Number);
  const index = year * 12 + number - 1 + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}
const label = (month) => new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  .format(new Date(`${month}-01T00:00:00Z`));
/** First date in `month` with the given ISO weekday (1 = Monday). */
function firstWeekday(month, isoDay) {
  for (let day = 1; day <= 7; day += 1) {
    const date = `${month}-0${day}`;
    if (((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1 === isoDay) return date;
  }
  throw new Error('unreachable');
}
/** UTC instant of a Europe/Berlin wall-clock time (legacy duty prerequisite only). */
function berlinInstant(date, time) {
  const guess = new Date(`${date}T${time}:00Z`);
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', timeZoneName: 'shortOffset' })
    .formatToParts(guess).find((part) => part.type === 'timeZoneName').value; // e.g. GMT+1
  const hours = Number(/GMT([+-]\d+)/.exec(offset)?.[1] ?? 0);
  return new Date(guess.getTime() - hours * 3600_000).toISOString();
}
const now = new Date();
const CURRENT = monthOf(now, 'Europe/Berlin');
// Outside the ~26 h month-boundary window every supported zone agrees on the current month,
// so "past" in the UI and in the company zone coincide for the months used below.
assert.equal(monthOf(new Date(now.getTime() - 12 * 3600_000), 'UTC'), CURRENT, 'Run outside the month-boundary window');
assert.equal(monthOf(new Date(now.getTime() + 14 * 3600_000), 'UTC'), CURRENT, 'Run outside the month-boundary window');
const PAST1 = addMonths(CURRENT, -1);
const PAST2 = addMonths(CURRENT, -2);
const NEXT = addMonths(CURRENT, 1);
const LATER = addMonths(CURRENT, 2);
report.months = { CURRENT, PAST1, PAST2, NEXT, LATER };

// Synthetic identities (random per run); examples, not business rules.
const ids = {
  company: randomUUID(), foreignCompany: randomUUID(),
  admin: randomUUID(), secondAdmin: randomUUID(), foreignAdmin: randomUUID(), employeeAccount: randomUUID(), employee: randomUUID(),
  foreignProject: randomUUID(),
};
const PROJECTS = {
  neu: 'Synthetic Objekt Neu', belegt: 'Synthetic Objekt Belegt', legacy: 'Synthetic Objekt Altbestand',
  inaktiv: 'Synthetic Objekt Inaktiv', rennen: 'Synthetic Objekt Rennen',
};
const projectIds = Object.fromEntries(Object.keys(PROJECTS).map((key) => [key, randomUUID()]));
const password = randomBytes(24).toString('base64url');
const email = (kind, id) => `browser-${kind}-${id}@secureplan.invalid`;
const emails = { admin: email('admin', ids.admin), secondAdmin: email('admin', ids.secondAdmin), employee: email('employee', ids.employeeAccount) };
// Legacy prerequisite: one empty duty on the first Tuesday of PAST2 (unpublished plan) and PAST1 (published plan).
const LEGACY = { early: firstWeekday(PAST2, 2), late: firstWeekday(PAST1, 2) };
const SATURDAY_NEXT = firstWeekday(NEXT, 6);
const DAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

let backend; let frontend; let browser; let page; let other; let seeded = false;
/** Calendar requests seen by the proxy; no header values, cookies, tokens or ids beyond the shape. */
const proxy = { truncateNextCalendarPatch: false, calendar: [] };
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
async function waitFor(check, message, timeout = 20_000) {
  const until = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    assert.ok(Date.now() < until, message);
    await wait(200);
  }
}

// --- PostgreSQL read-back (the only persistence evidence) ---
async function calendarRows(projectId) {
  return (await pool.query(
    `SELECT to_char(effective_from_month, 'YYYY-MM') AS month, weekday_mask AS mask, version::int AS version
     FROM project_operating_calendars WHERE company_id = $1 AND project_id = $2 ORDER BY effective_from_month`,
    [ids.company, projectId])).rows;
}
async function calendarAudits(projectId) {
  return (await pool.query(
    `SELECT actor_account_id, old_values, new_values FROM audit_event
     WHERE company_id = $1 AND action = 'PROJECT_OPERATING_CALENDAR_UPDATED' AND resource_type = 'PROJECT_OPERATING_CALENDAR'
       AND resource_id = $2 ORDER BY occurred_at, id`, [ids.company, projectId])).rows;
}
const mask = (days) => days.reduce((sum, day) => sum | (1 << (day - 1)), 0);
const calendarPatches = () => proxy.calendar.filter((entry) => entry.method === 'PATCH');

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
let origin;
async function login(context, path, address) {
  const opened = observe(await context.newPage());
  await opened.goto(`${origin}${path}`);
  await opened.getByLabel('E-Mail-Adresse').fill(address);
  await opened.getByLabel('Passwort', { exact: true }).fill(password);
  const response = opened.waitForResponse((r) => r.url().endsWith('/api/v1/auth/login') && r.request().method() === 'POST');
  await opened.getByRole('button', { name: 'Anmelden', exact: true }).click();
  assert.equal((await response).status(), 200);
  // Attached, not visible: on narrow screens the navigation sits behind the "Menü" button.
  await opened.getByRole('navigation', { name: 'Hauptnavigation', includeHidden: true }).waitFor({ state: 'attached' });
  return opened;
}
const section = (target) => target.getByRole('region', { name: 'Betriebstage', exact: true });
const box = (target, day) => section(target).getByRole('checkbox', { name: day, exact: true });
const button = (target, name) => section(target).getByRole('button', { name, exact: true });
async function checkedDays(target) {
  const result = [];
  for (const day of DAYS) if (await box(target, day).isChecked()) result.push(day);
  return result;
}
async function focusIs(locator, message = 'focus') { assert.ok(await locator.evaluate((el) => el === document.activeElement), message); }
async function openProject(target, key, month) {
  await target.goto(`${origin}/projekte/${projectIds[key]}/${month}`);
  await section(target).getByRole('heading', { level: 2, name: 'Betriebstage' }).waitFor();
  await waitFor(async () => (await section(target).getByText('Betriebstage werden geladen …').count()) === 0, 'calendar loaded');
}
async function openForm(target, editLabel, heading) {
  await button(target, editLabel).click();
  const title = section(target).getByRole('heading', { level: 3, name: heading, exact: true });
  await title.waitFor();
  await focusIs(title, 'focus starts on the form heading');
}
/** Saves and waits for the server's answer; returns its status. */
async function save(target, name = 'Betriebstage speichern') {
  const answer = target.waitForResponse((r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname.endsWith('/operating-calendar'));
  await button(target, name).click();
  return (await answer).status();
}
async function alertText(target, title) {
  const heading = section(target).getByRole('heading', { name: title, exact: true });
  await heading.waitFor();
  return (await heading.locator('xpath=ancestor::*[@role="alert"][1]').innerText()).replace(/\s+/g, ' ');
}
/** One authenticated API call from inside the logged-in page (same-origin credentials, the browser's Origin). */
async function pageApi(target, method, path, body = null, { csrf = true } = {}) {
  return target.evaluate(async ([verb, url, payload, withCsrf]) => {
    const headers = {};
    if (verb !== 'GET' && withCsrf) {
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
    return { status: response.status, body: json, code: json && typeof json.code === 'string' ? json.code : null };
  }, [method, path, body, csrf]);
}
async function noHorizontalPageScroll(target) {
  const [scroll, client] = await target.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  assert.ok(scroll <= client + 1, `horizontal page scroll: ${scroll} > ${client}`);
}

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
      const isCalendar = /^\/api\/v1\/projects\/[^/]+\/operating-calendar(?:\?|$)/.test(req.url);
      let entry = null;
      if (isCalendar) {
        entry = {
          method: req.method,
          csrf: typeof req.headers['x-csrf-token'] === 'string' && req.headers['x-csrf-token'].length > 0,
          sameOrigin: req.headers.origin === undefined ? null : req.headers.origin === origin,
          status: null, cacheControl: null, truncated: false, body: null,
        };
        proxy.calendar.push(entry);
      }
      const truncate = isCalendar && req.method === 'PATCH' && proxy.truncateNextCalendarPatch;
      if (truncate) proxy.truncateNextCalendarPatch = false;
      const upstream = proxyRequest({
        hostname: '127.0.0.1', port: backendPort, path: req.url, method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${backendPort}` },
      }, (reply) => {
        if (entry) { entry.status = reply.statusCode; entry.cacheControl = reply.headers['cache-control'] ?? null; }
        if (truncate) {
          // Real success headers, then a truncated body AFTER PostgreSQL committed: the browser
          // cannot read the answer and must claim neither success nor failure.
          entry.truncated = true;
          res.writeHead(reply.statusCode, reply.headers); res.flushHeaders();
          reply.resume(); reply.on('end', () => { res.write('{'); res.destroy(); });
          return;
        }
        res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
      });
      upstream.on('error', () => { res.writeHead(502); res.end(); });
      if (entry && req.method === 'PATCH') {
        // Only non-secret contract fields of the body are kept (no version ids).
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            entry.body = {
              effectiveFromMonth: body.effectiveFromMonth, operatingWeekdays: body.operatingWeekdays, bootstrap: body.bootstrap,
              expectedExactVersion: body.expectedExactVersion === null ? null : body.expectedExactVersion?.version ?? 'invalid',
              expectedEffective: body.expectedEffective === null ? null : body.expectedEffective?.version ?? 'invalid',
              expectedNextEffectiveFromMonth: body.expectedNextEffectiveFromMonth, keys: Object.keys(body).sort(),
            };
          } catch { entry.body = 'unparsable'; }
        });
      }
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
  const otherContext = await browser.newContext(contextOptions);

  // --- Synthetic prerequisites (direct inserts; never used as persistence evidence) ---
  await verifyRecordedTestTarget();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hash = await hashPassword(password);
    await client.query("INSERT INTO companies(id,name,status,time_zone) VALUES($1,'Synthetic F-A1-2 Acceptance','ACTIVE','Europe/Berlin')", [ids.company]);
    await client.query("INSERT INTO companies(id,name,status,time_zone) VALUES($1,'Synthetic Foreign Tenant','ACTIVE','Europe/Berlin')", [ids.foreignCompany]);
    for (const [accountId, companyId, address, role] of [
      [ids.admin, ids.company, emails.admin, 'COMPANY_ADMIN'],
      [ids.secondAdmin, ids.company, emails.secondAdmin, 'COMPANY_ADMIN'],
      [ids.foreignAdmin, ids.foreignCompany, email('foreign-admin', ids.foreignAdmin), 'COMPANY_ADMIN'],
      [ids.employeeAccount, ids.company, emails.employee, 'EMPLOYEE'],
    ]) {
      await client.query("INSERT INTO accounts(id,company_id,email,account_scope,role,status,password_hash) VALUES($1,$2,$3,'TENANT',$4,'ACTIVE',$5)",
        [accountId, companyId, address, role, hash]);
    }
    await client.query(
      "INSERT INTO employees(id,company_id,account_id,employee_number,first_name,last_name,shift_eligibility,employment_start) VALUES($1,$2,$3,'SYN-EMP','Synthetic','Employee','BOTH','2020-01-01')",
      [ids.employee, ids.company, ids.employeeAccount]);
    for (const [key, name] of Object.entries(PROJECTS)) {
      await client.query('INSERT INTO projects(id,company_id,name,status) VALUES($1,$2,$3,$4)',
        [projectIds[key], ids.company, name, key === 'inaktiv' ? 'INACTIVE' : 'ACTIVE']);
    }
    await client.query("INSERT INTO projects(id,company_id,name,status) VALUES($1,$2,'Synthetic Fremdmandant Objekt','ACTIVE')", [ids.foreignProject, ids.foreignCompany]);
    // Example shift times for the duty created through the API in C4 (company local time), not business rules.
    for (const [kind, start, end] of [['TAG', '06:00', '18:00'], ['NACHT', '18:00', '06:00']]) {
      await client.query(
        `INSERT INTO shift_configurations(company_id,project_id,effective_from_month,shift_kind,start_local,end_local)
         VALUES($1,$2,$3::date,$4,$5::time,$6::time)`, [ids.company, projectIds.belegt, `${NEXT}-01`, kind, start, end]);
    }
    // Legacy (pre-calendar) data: empty TAG duties on the first Tuesday of PAST2 (unpublished plan)
    // and PAST1 (published plan). The current application refuses new duties without a calendar.
    for (const [month, date, published] of [[PAST2, LEGACY.early, false], [PAST1, LEGACY.late, true]]) {
      const planId = randomUUID();
      await client.query(
        `INSERT INTO monthly_plans(id,company_id,project_id,planning_month,status,published_at,published_by_account_id)
         VALUES($1,$2,$3,$4::date,$5,$6,$7)`,
        [planId, ids.company, projectIds.legacy, `${month}-01`, published ? 'PUBLISHED' : 'UNPUBLISHED',
          published ? new Date().toISOString() : null, published ? ids.admin : null]);
      await client.query(
        `INSERT INTO duties(id,company_id,project_id,monthly_plan_id,planning_month,duty_date,shift_kind,starts_at,ends_at,
           time_zone,config_effective_from_month,start_local,end_local)
         VALUES($1,$2,$3,$4,$5::date,$6::date,'TAG',$7,$8,'Europe/Berlin',$5::date,'06:00','18:00')`,
        [randomUUID(), ids.company, projectIds.legacy, planId, `${month}-01`, date, berlinInstant(date, '06:00'), berlinInstant(date, '18:00')]);
    }
    await client.query('COMMIT');
    seeded = true;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  for (const key of Object.keys(PROJECTS)) assert.deepEqual(await calendarRows(projectIds[key]), [], `${key}: no seeded calendar`);

  page = await login(context, `/projekte/${projectIds.neu}`, emails.admin);
  other = await login(otherContext, `/projekte/${projectIds.neu}`, emails.secondAdmin);

  await step('C1 MISSING shows the stored state and no assumed set; first configuration is an explicit keyboard selection', async () => {
    await openProject(page, 'neu', CURRENT);
    const card = section(page);
    await card.getByText('Nicht festgelegt', { exact: true }).waitFor();
    await card.getByText('Keine Betriebstage festgelegt', { exact: true }).waitFor();
    assert.equal(await card.getByRole('list').count(), 0, 'no weekday overview for MISSING');
    await openForm(page, `Betriebstage ab ${label(CURRENT)} festlegen`, `Betriebstage ab ${label(CURRENT)} festlegen`);
    assert.deepEqual(await checkedDays(page), [], 'nothing preselected');
    assert.match((await card.innerText()).replace(/\s+/g, ' '), /Es gibt keine Voreinstellung\./);
    assert.match((await card.innerText()).replace(/\s+/g, ' '), /Erste Fassung für dieses Projekt\./);
    // No selection: refused on the client, focus on Monday, no request.
    await button(page, 'Betriebstage speichern').click();
    await card.getByText(/^Bitte wählen Sie mindestens einen Betriebstag aus\./).waitFor();
    await focusIs(box(page, 'Montag'), 'focus on the first weekday');
    assert.equal(calendarPatches().length, 0);
    // Keyboard only: Monday first in tab order; Space toggles Tuesday … Saturday; Enter on the save button.
    for (const day of ['Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag']) {
      await page.keyboard.press('Tab');
      await focusIs(box(page, day), `tab order reaches ${day}`);
      await page.keyboard.press('Space');
    }
    assert.deepEqual(await checkedDays(page), ['Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag']);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await focusIs(button(page, 'Betriebstage speichern'), 'tab order reaches the save button');
    const answer = page.waitForResponse((r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname.endsWith('/operating-calendar'));
    await page.keyboard.press('Enter');
    assert.equal((await answer).status(), 200);
    await card.getByText(`Die Betriebstage ab ${label(CURRENT)} wurden gespeichert (Version 1).`, { exact: true }).waitFor();
    await card.getByText(`Für ${label(CURRENT)} gespeichert`, { exact: true }).waitFor();
    assert.deepEqual(await calendarRows(projectIds.neu), [{ month: CURRENT, mask: mask([2, 3, 4, 5, 6]), version: 1 }]);
    const audits = await calendarAudits(projectIds.neu);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actor_account_id, ids.admin);
    assert.equal(audits[0].old_values, null);
    assert.deepEqual(audits[0].new_values, { effectiveFromMonth: `${CURRENT}-01`, operatingWeekdays: [2, 3, 4, 5, 6], version: 1 });
    const patch = calendarPatches().at(-1);
    assert.deepEqual(patch.body, {
      effectiveFromMonth: `${CURRENT}-01`, operatingWeekdays: [2, 3, 4, 5, 6], bootstrap: false,
      expectedExactVersion: null, expectedEffective: null, expectedNextEffectiveFromMonth: null,
      keys: ['bootstrap', 'effectiveFromMonth', 'expectedEffective', 'expectedExactVersion', 'expectedNextEffectiveFromMonth', 'operatingWeekdays'],
    });
    assert.deepEqual([patch.csrf, patch.sameOrigin, patch.cacheControl], [true, true, 'no-store']);
  });

  await step('C2 month-effective versions: an own later version, then a change bounded by it; versions and audit from the server', async () => {
    await openProject(page, 'neu', LATER);
    await section(page).getByText(`Übernommen aus ${label(CURRENT)}`, { exact: true }).waitFor();
    await openForm(page, `Eigene Betriebstage ab ${label(LATER)} festlegen`, `Betriebstage ab ${label(LATER)} festlegen`);
    assert.deepEqual(await checkedDays(page), ['Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'], 'preselected from the stored set in force');
    await box(page, 'Samstag').uncheck();
    await box(page, 'Sonntag').check();
    await section(page).getByText('Neu geschlossen:').waitFor();
    assert.equal(await save(page), 200);
    await section(page).getByText(`Die Betriebstage ab ${label(LATER)} wurden gespeichert (Version 1).`, { exact: true }).waitFor();

    await openProject(page, 'neu', CURRENT);
    await section(page).getByText(`ab ${label(LATER)}`, { exact: true }).waitFor();
    await openForm(page, `Betriebstage ab ${label(CURRENT)} ändern`, `Betriebstage ab ${label(CURRENT)} ändern`);
    await section(page).getByText(`Ihre Auswahl gilt von ${label(CURRENT)} bis einschließlich ${label(NEXT)}. Ab ${label(LATER)} gilt weiterhin die dort gespeicherte Fassung.`, { exact: true }).waitFor();
    await box(page, 'Montag').check();
    assert.equal(await save(page), 200);
    await section(page).getByText(`Die Betriebstage ab ${label(CURRENT)} wurden gespeichert (Version 2).`, { exact: true }).waitFor();
    assert.deepEqual(await calendarRows(projectIds.neu), [
      { month: CURRENT, mask: mask([1, 2, 3, 4, 5, 6]), version: 2 },
      { month: LATER, mask: mask([2, 3, 4, 5, 7]), version: 1 },
    ]);
    assert.deepEqual(calendarPatches().at(-1).body.expectedNextEffectiveFromMonth, `${LATER}-01`);
    assert.deepEqual([calendarPatches().at(-1).body.expectedExactVersion, calendarPatches().at(-1).body.expectedEffective], [1, 1]);
    const audits = await calendarAudits(projectIds.neu);
    assert.equal(audits.length, 3);
    assert.deepEqual(audits[2].old_values, { effectiveFromMonth: `${CURRENT}-01`, operatingWeekdays: [2, 3, 4, 5, 6], version: 1 });
  });

  await step('C3 stale version (two admins): German conflict, selection kept, save blocked until reload; then fresh preconditions', async () => {
    await openProject(page, 'neu', CURRENT);
    await openForm(page, `Betriebstage ab ${label(CURRENT)} ändern`, `Betriebstage ab ${label(CURRENT)} ändern`);
    await box(page, 'Sonntag').check();
    // The second administrator changes the same month first.
    await openProject(other, 'neu', CURRENT);
    await openForm(other, `Betriebstage ab ${label(CURRENT)} ändern`, `Betriebstage ab ${label(CURRENT)} ändern`);
    await box(other, 'Montag').uncheck();
    assert.equal(await save(other), 200);
    await section(other).getByText(`Die Betriebstage ab ${label(CURRENT)} wurden gespeichert (Version 3).`, { exact: true }).waitFor();

    assert.equal(await save(page), 409);
    const text = await alertText(page, 'Betriebstage wurden inzwischen geändert');
    assert.match(text, /Ihre Auswahl bleibt erhalten\. Es wurde nichts gespeichert\./);
    assert.deepEqual(await checkedDays(page), ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag']);
    assert.equal(await button(page, 'Betriebstage speichern').isDisabled(), true);
    assert.deepEqual(await calendarRows(projectIds.neu).then((rows) => rows[0]), { month: CURRENT, mask: mask([2, 3, 4, 5, 6]), version: 3 });

    await button(page, 'Aktuellen Stand laden').click();
    const notice = section(page).getByText(/^Aktueller Stand geladen:/);
    await notice.waitFor();
    assert.match(await notice.innerText(), /\(Version 3\)\. Ihre Auswahl ist unverändert\./);
    assert.deepEqual(await checkedDays(page), ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag']);
    assert.equal(await save(page), 200);
    await section(page).getByText(`Die Betriebstage ab ${label(CURRENT)} wurden gespeichert (Version 4).`, { exact: true }).waitFor();
    const patches = calendarPatches().slice(-3);
    assert.deepEqual(patches.map((entry) => [entry.status, entry.body.expectedExactVersion]), [[200, 2], [409, 2], [200, 3]]);
    assert.equal(patches[1].cacheControl, 'no-store');
    assert.equal((await calendarAudits(projectIds.neu)).length, 5, 'the refused write is not audited');
  });

  await step('C4 a change that would close an occupied date is refused with a safe text; correction saves without reload', async () => {
    await openProject(page, 'belegt', NEXT);
    await openForm(page, `Betriebstage ab ${label(NEXT)} festlegen`, `Betriebstage ab ${label(NEXT)} festlegen`);
    for (const day of DAYS.slice(0, 6)) await box(page, day).check();
    assert.equal(await save(page), 200);
    await section(page).getByText(`Die Betriebstage ab ${label(NEXT)} wurden gespeichert (Version 1).`, { exact: true }).waitFor();
    // An unstaffed DAY duty on a Saturday, created through the real planning API.
    const plan = await pageApi(page, 'POST', '/api/v1/monthly-plans', { projectId: projectIds.belegt, monthStart: `${NEXT}-01` });
    assert.equal(plan.status, 201);
    const duty = await pageApi(page, 'POST', `/api/v1/monthly-plans/${plan.body.id}/entries`, { dutyDate: SATURDAY_NEXT, shiftKind: 'DAY', assignments: [] });
    assert.equal(duty.status, 201);

    await openForm(page, `Betriebstage ab ${label(NEXT)} ändern`, `Betriebstage ab ${label(NEXT)} ändern`);
    await box(page, 'Samstag').uncheck();
    await section(page).getByText('Neu geschlossen:').waitFor();
    assert.equal(await save(page), 409);
    const text = await alertText(page, 'Gespeicherte Dienste an geschlossenen Tagen');
    assert.match(text, /auch Dienste ohne Besetzung und Dienste veröffentlichter Pläne zählen/);
    assert.doesNotMatch(text, /\d{2}\.\d{2}\.\d{4}|\d{4}-\d{2}-\d{2}|Synthetic/, 'no duty date or name');
    assert.equal(calendarPatches().at(-1).body.expectedExactVersion, 1);
    assert.deepEqual(await calendarRows(projectIds.belegt), [{ month: NEXT, mask: mask([1, 2, 3, 4, 5, 6]), version: 1 }]);
    assert.deepEqual(await checkedDays(page), DAYS.slice(0, 5));
    assert.equal(await button(page, 'Betriebstage speichern').isDisabled(), false, 'no reload needed after a dependency conflict');

    await box(page, 'Samstag').check();
    await box(page, 'Montag').uncheck();
    assert.equal(await save(page), 200);
    await section(page).getByText(`Die Betriebstage ab ${label(NEXT)} wurden gespeichert (Version 2).`, { exact: true }).waitFor();
    assert.deepEqual(await calendarRows(projectIds.belegt), [{ month: NEXT, mask: mask([2, 3, 4, 5, 6]), version: 2 }]);
    assert.equal((await calendarAudits(projectIds.belegt)).length, 2);
  });

  await step('C5 lost answer after commit: outcome unknown, no blind resend; reload shows the applied state; nothing written twice', async () => {
    await openProject(page, 'neu', CURRENT);
    await openForm(page, `Betriebstage ab ${label(CURRENT)} ändern`, `Betriebstage ab ${label(CURRENT)} ändern`);
    await box(page, 'Sonntag').uncheck();
    const before = calendarPatches().length;
    proxy.truncateNextCalendarPatch = true;
    await button(page, 'Betriebstage speichern').click();
    const text = await alertText(page, 'Ergebnis unbekannt');
    assert.doesNotMatch(text, /nichts gespeichert/);
    assert.equal(await button(page, 'Betriebstage speichern').isDisabled(), true);
    await waitFor(async () => (await calendarRows(projectIds.neu))[0].version === 5, 'the write committed');
    assert.equal(calendarPatches().length, before + 1);
    assert.equal(calendarPatches().at(-1).truncated, true);

    await button(page, 'Aktuellen Stand laden').click();
    const notice = section(page).getByText(/^Aktueller Stand geladen:/);
    await notice.waitFor();
    assert.match(await notice.innerText(), /\(Version 5\)\./);
    assert.equal(await section(page).getByText('Ungespeicherte Änderungen', { exact: true }).count(), 0);
    await button(page, 'Betriebstage speichern').click();
    await section(page).getByText('Es gab keine Änderungen zu speichern.', { exact: true }).waitFor();
    assert.equal(calendarPatches().length, before + 1, 'exactly one PATCH; no resend');
    assert.deepEqual((await calendarRows(projectIds.neu))[0], { month: CURRENT, mask: mask([1, 2, 3, 4, 5, 6]), version: 5 });
    assert.equal((await calendarAudits(projectIds.neu)).length, 6);
  });

  await step('C6 historical bootstrap: only in a past month without versions; warnings, explicit confirmation, server-checked month', async () => {
    await openProject(page, 'legacy', CURRENT);
    await openForm(page, `Betriebstage ab ${label(CURRENT)} festlegen`, `Betriebstage ab ${label(CURRENT)} festlegen`);
    assert.match((await section(page).innerText()).replace(/\s+/g, ' '), /Nach diesem Speichern ist die Ersteinrichtung nicht mehr möglich/);
    await button(page, 'Abbrechen').click();

    // A later past month than the earliest live duty: refused by the server, input kept.
    await openProject(page, 'legacy', PAST1);
    await openForm(page, `Einmalige Ersteinrichtung ab ${label(PAST1)} …`, `Einmalige Ersteinrichtung ab ${label(PAST1)}`);
    const warnings = (await section(page).innerText()).replace(/\s+/g, ' ');
    for (const warning of [/Einmalige Ersteinrichtung – bitte sorgfältig prüfen\./, /nur ab dem Monat des frühesten gespeicherten Dienstes/,
      /auch Dienste ohne Besetzung und Dienste veröffentlichter Pläne/, /kein Nachweis früherer Betriebszeiten/]) {
      assert.match(warnings, warning);
    }
    await box(page, 'Dienstag').check();
    const patchesBefore = calendarPatches().length;
    await button(page, 'Ersteinrichtung speichern').click();
    await section(page).getByText('Bitte bestätigen Sie die einmalige Ersteinrichtung ausdrücklich.', { exact: true }).waitFor();
    const confirm = section(page).getByRole('checkbox', { name: /^Ich habe die Auswahl geprüft\./ });
    await focusIs(confirm, 'focus on the missing confirmation');
    assert.equal(calendarPatches().length, patchesBefore, 'no request without the explicit confirmation');
    await confirm.check();
    assert.equal(await save(page, 'Ersteinrichtung speichern'), 400);
    assert.match(await alertText(page, `Ersteinrichtung für ${label(PAST1)} nicht möglich`), /Wechseln Sie über die Monatsnavigation zu diesem Monat\./);
    assert.deepEqual(await checkedDays(page), ['Dienstag']);
    assert.deepEqual(await calendarRows(projectIds.legacy), []);

    // Month change with unsaved input asks first; discarding is explicit.
    await page.getByRole('link', { name: `Vorheriger Monat: ${label(PAST2)}` }).click();
    await page.getByRole('group', { name: 'Ungespeicherte Betriebstage' }).waitFor();
    await page.getByRole('button', { name: 'Änderungen verwerfen und wechseln', exact: true }).click();
    await waitFor(async () => new URL(page.url()).pathname.endsWith(`/${PAST2}`), 'moved to the earliest duty month');
    await openForm(page, `Einmalige Ersteinrichtung ab ${label(PAST2)} …`, `Einmalige Ersteinrichtung ab ${label(PAST2)}`);
    // Monday alone would exclude the saved Tuesday duties (also the one in the published plan).
    await box(page, 'Montag').check();
    await section(page).getByRole('checkbox', { name: /^Ich habe die Auswahl geprüft\./ }).check();
    assert.equal(await save(page, 'Ersteinrichtung speichern'), 409);
    assert.match(await alertText(page, 'Gespeicherte Dienste an ausgeschlossenen Tagen'), new RegExp(`alle gespeicherten Dienste ab ${label(PAST2)} abdecken`));
    assert.deepEqual(await calendarRows(projectIds.legacy), []);
    await box(page, 'Dienstag').check();
    assert.equal(await save(page, 'Ersteinrichtung speichern'), 200);
    await section(page).getByText(`Die einmalige Ersteinrichtung ab ${label(PAST2)} wurde gespeichert (Version 1).`, { exact: true }).waitFor();
    assert.deepEqual(calendarPatches().at(-1).body, {
      effectiveFromMonth: `${PAST2}-01`, operatingWeekdays: [1, 2], bootstrap: true,
      expectedExactVersion: null, expectedEffective: null, expectedNextEffectiveFromMonth: null,
      keys: ['bootstrap', 'effectiveFromMonth', 'expectedEffective', 'expectedExactVersion', 'expectedNextEffectiveFromMonth', 'operatingWeekdays'],
    });
    assert.deepEqual(await calendarRows(projectIds.legacy), [{ month: PAST2, mask: mask([1, 2]), version: 1 }]);
    const audits = await calendarAudits(projectIds.legacy);
    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0].new_values, { effectiveFromMonth: `${PAST2}-01`, operatingWeekdays: [1, 2], version: 1, bootstrap: true });
    // Afterwards: past months read-only, the bootstrap is gone, legacy duties untouched.
    await section(page).getByText(`${label(PAST2)} liegt in der Vergangenheit. Betriebstage vergangener Monate können nicht geändert werden.`, { exact: true }).waitFor();
    assert.equal(await section(page).getByRole('button').count(), 0);
    await openProject(page, 'legacy', PAST1);
    await section(page).getByText(`Übernommen aus ${label(PAST2)}`, { exact: true }).waitFor();
    assert.equal(await section(page).getByRole('button').count(), 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM duties WHERE company_id = $1 AND project_id = $2 AND removed_at IS NULL',
      [ids.company, projectIds.legacy])).rows[0].n, 2);
  });

  await step('C7 unsaved selection: month links ask first (stay keeps input); a reload/close asks the browser', async () => {
    const guarded = observe(await context.newPage());
    await guarded.goto(`${origin}/projekte/${projectIds.neu}/${CURRENT}`);
    await section(guarded).getByRole('heading', { level: 2, name: 'Betriebstage' }).waitFor();
    await openForm(guarded, `Betriebstage ab ${label(CURRENT)} ändern`, `Betriebstage ab ${label(CURRENT)} ändern`);
    await box(guarded, 'Montag').uncheck();
    const next = guarded.getByRole('link', { name: `Nächster Monat: ${label(NEXT)}` });
    await next.click();
    const prompt = guarded.getByRole('group', { name: 'Ungespeicherte Betriebstage' });
    await prompt.waitFor();
    assert.match(await prompt.innerText(), new RegExp(`Die Auswahl der Betriebstage ab ${label(CURRENT)} ist noch nicht gespeichert\\.`));
    await prompt.getByRole('button', { name: 'Weiter bearbeiten', exact: true }).click();
    await focusIs(next, 'focus returns to the month link');
    assert.ok(new URL(guarded.url()).pathname.endsWith(`/${CURRENT}`));
    assert.equal(await box(guarded, 'Montag').isChecked(), false, 'selection kept');
    const dialogs = [];
    guarded.on('dialog', (dialog) => { dialogs.push(dialog.type()); void dialog.dismiss(); });
    await guarded.close({ runBeforeUnload: true });
    await waitFor(async () => dialogs.length === 1, 'beforeunload asked');
    assert.deepEqual(dialogs, ['beforeunload']);
    await guarded.close();
  });

  await step('C8 inactive project is read-only; a project deactivated while editing ends the form with a German refusal', async () => {
    await openProject(page, 'inaktiv', CURRENT);
    await section(page).getByText(/^Das Projekt ist inaktiv\. Betriebstage können nur angesehen werden/).waitFor();
    assert.equal(await section(page).getByRole('button').count(), 0);
    const direct = await pageApi(page, 'PATCH', `/api/v1/projects/${projectIds.inaktiv}/operating-calendar`, {
      effectiveFromMonth: `${CURRENT}-01`, expectedExactVersion: null, expectedEffective: null,
      expectedNextEffectiveFromMonth: null, operatingWeekdays: [1], bootstrap: false });
    assert.deepEqual([direct.status, direct.code], [409, 'PROJECT_INACTIVE']);

    await openProject(page, 'rennen', CURRENT);
    await openForm(page, `Betriebstage ab ${label(CURRENT)} festlegen`, `Betriebstage ab ${label(CURRENT)} festlegen`);
    await box(page, 'Mittwoch').check();
    await other.goto(`${origin}/projekte/${projectIds.rennen}`);
    await other.getByRole('button', { name: 'Projekt auf inaktiv setzen …', exact: true }).click();
    await other.getByRole('button', { name: 'Auf inaktiv setzen', exact: true }).click();
    await other.getByText('Das Projekt ist jetzt inaktiv.').waitFor();
    assert.equal(await save(page), 409);
    assert.match(await alertText(page, 'Projekt ist inaktiv'), /Es wurde nichts gespeichert\./);
    assert.equal(await button(page, 'Aktuellen Stand laden').count(), 0);
    assert.equal(await button(page, 'Betriebstage speichern').isDisabled(), true);
    assert.deepEqual(await calendarRows(projectIds.rennen), []);
    assert.deepEqual(await calendarRows(projectIds.inaktiv), []);
  });

  await step('C9 390 px: no horizontal page scroll; weekday choices and overview stay inside their cards', async () => {
    const narrow = await browser.newContext({ ...contextOptions, viewport: { width: 390, height: 844 } });
    try {
      const small = await login(narrow, `/projekte/${projectIds.neu}/${CURRENT}`, emails.admin);
      await section(small).getByRole('list').waitFor();
      await noHorizontalPageScroll(small);
      const card = await section(small).boundingBox();
      for (const item of await section(small).getByRole('listitem').all()) {
        const box2 = await item.boundingBox();
        assert.ok(box2.x >= card.x && box2.x + box2.width <= card.x + card.width + 0.5, 'overview item inside the card');
      }
      await openForm(small, `Betriebstage ab ${label(CURRENT)} ändern`, `Betriebstage ab ${label(CURRENT)} ändern`);
      await noHorizontalPageScroll(small);
      const fieldset = await section(small).getByRole('group', { name: `Betriebstage ab ${label(CURRENT)}` }).boundingBox();
      for (const day of DAYS) {
        const choice = await box(small, day).locator('xpath=ancestor::label[1]').boundingBox();
        assert.ok(choice.x >= fieldset.x && choice.x + choice.width <= fieldset.x + fieldset.width + 0.5, `${day} inside the fieldset`);
        assert.ok(choice.height >= 44, `${day}: 44 px target`);
      }
      await small.screenshot({ path: resolve(output, 'sp90-calendar-390.png'), fullPage: true });
    } finally { await narrow.close(); }
  });

  await step('C10 tenant isolation and authorization: foreign calendar concealed (404); EMPLOYEE 403; missing CSRF 403; nothing written', async () => {
    const body = { effectiveFromMonth: `${CURRENT}-01`, expectedExactVersion: null, expectedEffective: null,
      expectedNextEffectiveFromMonth: null, operatingWeekdays: [1], bootstrap: false };
    const path = `/api/v1/projects/${ids.foreignProject}/operating-calendar`;
    const read = await pageApi(page, 'GET', `${path}?effectiveForMonth=${CURRENT}-01`);
    const write = await pageApi(page, 'PATCH', path, body);
    assert.deepEqual([read.status, write.status], [404, 404]);
    await page.goto(`${origin}/projekte/${ids.foreignProject}`);
    await page.getByRole('heading', { name: 'Nicht gefunden', exact: true }).waitFor();
    assert.equal(await page.getByRole('region', { name: 'Betriebstage', exact: true }).count(), 0);
    const noCsrf = await pageApi(page, 'PATCH', `/api/v1/projects/${projectIds.rennen}/operating-calendar`, body, { csrf: false });
    assert.equal(noCsrf.status, 403);
    const employeeContext = await browser.newContext(contextOptions);
    try {
      const employee = await login(employeeContext, '/', emails.employee);
      const ownPath = `/api/v1/projects/${projectIds.neu}/operating-calendar`;
      const denied = await pageApi(employee, 'GET', `${ownPath}?effectiveForMonth=${CURRENT}-01`);
      const deniedWrite = await pageApi(employee, 'PATCH', ownPath, body);
      assert.deepEqual([denied.status, deniedWrite.status], [403, 403]);
      assert.equal(await employee.getByRole('link', { name: 'Projekte', exact: true }).count(), 0, 'no project administration for employees');
    } finally { await employeeContext.close(); }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_operating_calendars WHERE company_id = $1', [ids.foreignCompany])).rows[0].n, 0);
    assert.deepEqual(await calendarRows(projectIds.rennen), []);
  });

  await step('C-T totals: one audit per applied version change, none for refusals/no-ops; every calendar answer no-store; no app console errors', async () => {
    const rows = (await pool.query('SELECT version::int AS version FROM project_operating_calendars WHERE company_id = $1', [ids.company])).rows;
    const appliedWrites = rows.reduce((sum, row) => sum + row.version, 0);
    const audits = (await pool.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE company_id = $1 AND action = 'PROJECT_OPERATING_CALENDAR_UPDATED'", [ids.company])).rows[0].n;
    assert.equal(audits, appliedWrites, 'audit count equals applied writes');
    // neu: CURRENT v1…v5 + LATER v1; belegt: v1, v2; legacy: bootstrap v1.
    assert.equal(audits, 9);
    for (const entry of proxy.calendar) {
      assert.equal(entry.cacheControl, 'no-store', `${entry.method} ${entry.status} is no-store`);
      if (entry.method === 'PATCH') assert.equal(entry.sameOrigin, true);
    }
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
    await page.screenshot({ path: resolve(output, 'sp90-calendar-browser-failure.png'), fullPage: true }).catch(() => {});
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
  // Request facts only; never header values, cookies, tokens or version ids.
  report.calendarRequests = proxy.calendar;
  await writeFile(resolve(output, 'sp90-calendar-browser-results.json'), `${JSON.stringify(report, null, 2)}\n`);
}
