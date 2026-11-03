/** Real installed Chrome -> built React -> NestJS -> verified disposable PG17.
 * Prerequisites and the explicitly labelled invalid legacy fixture use SQL.
 * Normal saves, calendars, publications and competing writes use real HTTP.
 * Proxy faults discard the real server response; successful commands have already committed.
 * Evidence contains statuses/assertions/screenshots of synthetic data, never credentials/bodies/keys.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { verifyRecordedTestTarget } from './disposable-test-target.mjs';

const verified = await verifyRecordedTestTarget();
const root = fileURLToPath(new URL('../', import.meta.url));
assert.ok(process.env.SECUREPLAN_PLAYWRIGHT_MODULE);
assert.ok(process.env.SECUREPLAN_BROWSER_OUTPUT_DIR);
const { chromium } = await import(pathToFileURL(resolve(process.env.SECUREPLAN_PLAYWRIGHT_MODULE)).href);
const output = resolve(process.env.SECUREPLAN_BROWSER_OUTPUT_DIR);
await mkdir(output, { recursive: true });
const { hashPassword } = await import('../apps/backend/dist/auth/password-hasher.js');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const ids = Object.fromEntries(['company', 'foreign', 'admin', 'other', 'foreignAdmin', 'employeeAccount', 'secondAccount', 'missingAccount', 'employee', 'second', 'missingEmployee', 'project', 'missingProject'].map(k => [k, randomUUID()]));
const password = randomBytes(24).toString('base64url');
const email = (id) => `${id}@example.invalid`;
const report = { startedAt: new Date().toISOString(), sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceDirty: execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim() !== '', cluster: verified.cluster, browser: null, results: [], pageErrors: 0 };
const wait = ms => new Promise(done => setTimeout(done, ms));
let backend, frontend, browser, activePage, origin, plan, missingPlan;
let truncate = false;
const saves = [];
async function step(name, work) {
  try { await work(); report.results.push({ name, result: 'PASS' }); console.log(`PASS ${name}`); }
  catch (error) { report.results.push({ name, result: 'FAIL' }); throw error; }
}
async function until(predicate, label) {
  const end = Date.now() + 15_000;
  while (!await predicate()) { assert.ok(Date.now() < end, label); await wait(75); }
}
async function freePort() {
  const s = createServer(); await new Promise(done => s.listen(0, '127.0.0.1', done));
  const port = s.address().port; await new Promise(done => s.close(done)); return port;
}
async function api(page, method, path, body = null, headers = {}, csrf = true) {
  return page.evaluate(async ([method, path, body, headers, csrf]) => {
    if (csrf && method !== 'GET') {
      const me = await fetch('/api/v1/me', { cache: 'no-store' });
      headers['X-CSRF-Token'] = me.headers.get('x-csrf-token') ?? '';
    }
    if (body !== null) headers['Content-Type'] = 'application/json';
    const r = await fetch(`/api/v1${path}`, { method, headers, cache: 'no-store', body: body === null ? undefined : JSON.stringify(body) });
    let json = null; try { json = await r.json(); } catch { /* bodyless */ }
    return { status: r.status, body: json, cache: r.headers.get('cache-control'), replayed: r.headers.get('idempotency-replayed') };
  }, [method, path, body, headers, csrf]);
}
async function login(page, account = ids.admin) {
  await page.goto(`${origin}/monatsplanung?month=2026-12`);
  await page.getByRole('heading', { name: 'Anmelden', exact: true }).waitFor();
  await page.getByLabel('E-Mail-Adresse').fill(email(account));
  await page.getByLabel('Passwort', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
  await until(async () => (await api(page, 'GET', '/me')).status === 200, 'login');
}
const route = (id = plan, person = ids.employee) => `/monthly-plans/${id}/employee-months/${person}`;
async function bodyFor(page, id = plan, person = ids.employee) {
  const r = await api(page, 'GET', route(id, person)); assert.equal(r.status, 200); assert.equal(r.cache, 'no-store');
  const v = r.body;
  return { expectedPlan: { status: v.plan.status, publishedAt: v.plan.publishedAt }, expectedCreationContext: v.creationContextFingerprint,
    expectedCalendar: v.operatingCalendar.effective ? { id: v.operatingCalendar.effective.id, version: v.operatingCalendar.effective.version } : null,
    days: v.days.map(d => ({ date: d.date, expected: { day: d.day ? { id: d.day.dutyId, version: d.day.version } : null, night: d.night ? { id: d.night.dutyId, version: d.night.version } : null },
      desired: d.day?.assignment ? { state: 'DAY', role: d.day.assignment.dutyRole } : d.night?.assignment ? { state: 'NIGHT', role: d.night.assignment.dutyRole } : { state: 'OFF' } })) };
}
async function saveApi(page, body, id = plan, person = ids.employee, key = randomUUID()) {
  return api(page, 'POST', `${route(id, person)}/save`, body, { 'Idempotency-Key': key });
}
async function calendar(page, project, weekdays) {
  const path = `/projects/${project}/operating-calendar`;
  const r = await api(page, 'GET', `${path}?effectiveForMonth=2026-12-01`); assert.equal(r.status, 200);
  const v = r.body;
  const updated = await api(page, 'PATCH', path, { effectiveFromMonth: '2026-12-01', expectedExactVersion: v.exactVersion,
    expectedEffective: v.effective ? { id: v.effective.id, version: v.effective.version } : null,
    expectedNextEffectiveFromMonth: v.nextEffectiveFromMonth, operatingWeekdays: weekdays, bootstrap: false });
  assert.equal(updated.status, 200);
}
async function openPlanner(page, id = plan, person = ids.employee) {
  await page.goto(`${origin}/monatsplanung/${id}`);
  await page.getByRole('radio', { name: /Monat einer Person planen/ }).check();
  await page.getByRole('grid', { name: /Dienste von/ }).waitFor();
  await page.getByLabel('Person', { exact: true }).selectOption(person);
  await page.getByRole('grid', { name: `Dienste von Synthetic ${person === ids.missingEmployee ? 'Missing' : 'Alpha'} im Dezember 2026`, exact: true }).waitFor();
}
const day = (page, date) => page.getByRole('grid').locator(`button[data-index="${date - 1}"]`);
async function paint(page, mode, dates) {
  await page.locator('.month-planner__modes input[type="radio"]').nth(['Tag', 'Nacht', 'Frei'].indexOf(mode)).check();
  for (const date of dates) await day(page, date).click();
}
const saveButton = page => page.getByRole('button', { name: 'Monat speichern', exact: true });
async function saveUi(page) {
  const n = saves.length; await saveButton(page).click();
  await until(async () => saves.length === n + 1 && saves.at(-1).status !== null, 'one save request');
  assert.equal(saves.at(-1).status, 200);
  await page.getByText(/Der Monat wurde gespeichert:.*Der aktuelle Stand ist geladen\./).waitFor();
}
async function rows() {
  return (await pool.query(`SELECT d.id, d.duty_date::text, d.shift_kind, d.concurrency_version::text, pa.employee_id, pa.duty_function
    FROM duties d LEFT JOIN plan_assignments pa ON pa.duty_id=d.id AND pa.company_id=d.company_id AND pa.state='ACTIVE'
    WHERE d.company_id=$1 AND d.monthly_plan_id=$2 AND d.removed_at IS NULL ORDER BY d.id, pa.employee_id`, [ids.company, plan])).rows;
}
async function seed() {
  await verifyRecordedTestTarget();
  const hash = await hashPassword(password);
  for (const company of [ids.company, ids.foreign]) await pool.query("INSERT INTO companies(id,name,status,time_zone) VALUES($1,'Synthetic A2 Acceptance','ACTIVE','Europe/Berlin')", [company]);
  for (const [id, company, role] of [[ids.admin, ids.company, 'COMPANY_ADMIN'], [ids.other, ids.company, 'COMPANY_ADMIN'], [ids.foreignAdmin, ids.foreign, 'COMPANY_ADMIN'], [ids.employeeAccount, ids.company, 'EMPLOYEE'], [ids.secondAccount, ids.company, 'EMPLOYEE'], [ids.missingAccount, ids.company, 'EMPLOYEE']])
    await pool.query("INSERT INTO accounts(id,company_id,email,account_scope,role,status,password_hash) VALUES($1,$2,$3,'TENANT',$4,'ACTIVE',$5)", [id, company, email(id), role, hash]);
  for (const [id, account, name] of [[ids.employee, ids.employeeAccount, 'Alpha'], [ids.second, ids.secondAccount, 'Bravo'], [ids.missingEmployee, ids.missingAccount, 'Missing']])
    await pool.query("INSERT INTO employees(id,company_id,account_id,employee_number,first_name,last_name,shift_eligibility,employment_start) VALUES($1,$2,$3,$4,'Synthetic',$5,'BOTH','2020-01-01')", [id, ids.company, account, name, name]);
  for (const [project, name] of [[ids.project, 'Synthetic A2 Open'], [ids.missingProject, 'Synthetic A2 Missing']]) {
    await pool.query("INSERT INTO projects(id,company_id,name,status) VALUES($1,$2,$3,'ACTIVE')", [project, ids.company, name]);
    for (const [kind, start, end] of [['TAG', '06:00', '18:00'], ['NACHT', '18:00', '06:00']])
      await pool.query('INSERT INTO shift_configurations(company_id,project_id,effective_from_month,shift_kind,start_local,end_local) VALUES($1,$2,\'2026-12-01\',$3,$4,$5)', [ids.company, project, kind, start, end]);
  }
  for (const person of [ids.employee, ids.second]) await pool.query("INSERT INTO project_assignments(company_id,employee_id,project_id,planning_month) VALUES($1,$2,$3,'2026-12-01')", [ids.company, person, ids.project]);
  await pool.query("INSERT INTO project_assignments(company_id,employee_id,project_id,planning_month) VALUES($1,$2,$3,'2026-12-01')", [ids.company, ids.missingEmployee, ids.missingProject]);
}

try {
  const bp = await freePort(), fp = await freePort(); origin = `https://localhost:${fp}`;
  backend = spawn(process.execPath, ['apps/backend/dist/main.js'], { cwd: root, env: { ...process.env, PORT: String(bp), APP_ORIGIN: origin }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  backend.stdout.resume(); backend.stderr.resume();
  await until(async () => { assert.equal(backend.exitCode, null, 'backend running'); return fetch(`http://127.0.0.1:${bp}/api/v1/health/ready`).then(r => r.status === 200, () => false); }, 'backend ready');
  const dist = resolve(root, 'apps/frontend/dist');
  frontend = httpsServer({ key: await readFile(resolve(root, 'infra/tls/localhost-key.pem')), cert: await readFile(resolve(root, 'infra/tls/localhost.pem')) }, async (req, res) => {
    if (req.url.startsWith('/api/')) {
      const isSave = req.method === 'POST' && /\/employee-months\/[^/]+\/save$/.test(req.url);
      const entry = isSave ? { path: req.url, key: req.headers['idempotency-key'], body: '', status: null, cache: null, result: null } : null;
      if (entry) saves.push(entry);
      const drop = isSave && truncate; if (drop) truncate = false;
      const upstream = request({ hostname: '127.0.0.1', port: bp, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${bp}` } }, reply => {
        const chunks = [];
        if (entry) { entry.status = reply.statusCode; entry.cache = reply.headers['cache-control']; reply.on('data', c => chunks.push(c)); reply.on('end', () => { try { entry.result = JSON.parse(Buffer.concat(chunks)); } catch { /* empty */ } }); }
        if (drop) { reply.resume(); reply.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{'); }); }
        else { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); }
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      if (entry) req.on('data', c => { entry.body += c.toString(); }); req.pipe(upstream); return;
    }
    try {
      const path = new URL(req.url, origin).pathname;
      const file = path.startsWith('/assets/') ? resolve(dist, `.${path}`) : resolve(dist, 'index.html');
      assert.ok(file.startsWith(`${dist}${sep}`));
      res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', 'Cache-Control': 'no-store' }); res.end(await readFile(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(done => frontend.listen(fp, '127.0.0.1', done));
  browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true }); report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const page = await context.newPage(); activePage = page; page.on('pageerror', () => report.pageErrors++);
  await seed(); await login(page);
  await calendar(page, ids.project, [1, 2, 3, 4, 5, 6, 7]);
  const p = await api(page, 'POST', '/monthly-plans', { projectId: ids.project, monthStart: '2026-12-01' }); assert.equal(p.status, 201); plan = p.body.id;
  const m = await api(page, 'POST', '/monthly-plans', { projectId: ids.missingProject, monthStart: '2026-12-01' }); assert.equal(m.status, 201); missingPlan = m.body.id;
  await openPlanner(page);
  await step('B01 multi-day UI save is one complete atomic request; reload persists', async () => {
    assert.equal(await page.getByText(/Vorschau/).count(), 0);
    await paint(page, 'Tag', [3, 5]); await paint(page, 'Nacht', [8]);
    const n = saves.length; await saveUi(page); assert.equal(saves.length, n + 1);
    assert.equal(JSON.parse(saves.at(-1).body).days.length, 31); assert.equal(saves.at(-1).cache, 'no-store');
    assert.equal((await rows()).filter(r => r.employee_id === ids.employee).length, 3);
    await openPlanner(page); assert.match(await day(page, 8).getAttribute('aria-label'), /Nachtdienst/);
    await page.screenshot({ path: resolve(output, 'B01-desktop.png'), fullPage: true });
  });
  await step('B02 DAY to NIGHT, NIGHT to DAY, FREI and SHIFT_LEAD; other employee unchanged', async () => {
    const b = await bodyFor(page, plan, ids.second); b.days[2].desired = { state: 'DAY', role: 'SHIFT_LEAD' }; assert.equal((await saveApi(page, b, plan, ids.second)).status, 200);
    const before = (await rows()).filter(r => r.employee_id === ids.second).map(r => [r.id, r.employee_id, r.duty_function]);
    await openPlanner(page); await paint(page, 'Nacht', [3]); await paint(page, 'Tag', [8]); await paint(page, 'Frei', [5]); await saveUi(page);
    const lead = await bodyFor(page); lead.days[7].desired.role = 'SHIFT_LEAD'; assert.equal((await saveApi(page, lead)).status, 200);
    await openPlanner(page); await paint(page, 'Tag', [10]); await saveUi(page);
    assert.match(await day(page, 8).getAttribute('aria-label'), /Schichtleitung/);
    assert.deepEqual((await rows()).filter(r => r.employee_id === ids.second).map(r => [r.id, r.employee_id, r.duty_function]), before);
    assert.doesNotMatch(saves.at(-1).body, new RegExp(ids.second));
  });
  await step('B03 invalid day from concurrent availability change rolls back the entire React save', async () => {
    await paint(page, 'Tag', [12, 14]);
    const selection = { operation: 'SET', fromDate: '2026-12-14', toDate: '2026-12-14', status: 'LEAVE', conflictPolicy: 'REJECT' };
    const preview = await api(page, 'POST', `/employees/${ids.employee}/availability/preview`, selection); assert.equal(preview.status, 200);
    assert.equal((await api(page, 'POST', `/employees/${ids.employee}/availability/batch`, { ...selection, previewToken: preview.body.previewToken }, { 'Idempotency-Key': randomUUID() })).status, 200);
    const before = await rows(); const n = saves.length; await saveButton(page).click();
    await until(() => Promise.resolve(saves.length === n + 1 && saves.at(-1).status !== null), 'rollback response');
    assert.equal(saves.at(-1).status, 409); assert.equal(saves.at(-1).result.stage, 'VALIDATION');
    assert.deepEqual(await rows(), before);
    await page.getByText(/Es wurde nichts gespeichert/).waitFor();
    // Recover through explicit UI navigation, preserving the refusal until discarded.
    await page.getByRole('radio', { name: 'Alle Personen', exact: true }).click();
    await page.getByRole('button', { name: 'Auswahl verwerfen und wechseln', exact: true }).click();
  });
  await step('B04 competing administrator modifies a duty; stale preconditions refuse every change', async () => {
    await openPlanner(page); await paint(page, 'Frei', [8]);
    const c = await browser.newContext(); const other = await c.newPage(); await login(other, ids.other);
    const b = await bodyFor(other, plan, ids.second); b.days[7].desired = { state: 'DAY', role: 'EMPLOYEE' }; assert.equal((await saveApi(other, b, plan, ids.second)).status, 200);
    const before = await rows(); const n = saves.length; await saveButton(page).click();
    await until(() => Promise.resolve(saves.length === n + 1 && saves.at(-1).status !== null), 'stale response');
    assert.equal(saves.at(-1).result.stage, 'PRECONDITION'); assert.deepEqual(await rows(), before);
    await page.getByRole('button', { name: 'Aktuellen Stand laden', exact: true }).click();
    await page.getByText(/Die Besetzung des Tagdienstes wurde inzwischen geändert/).first().waitFor();
    await page.getByRole('button', { name: 'Meine Auswahl behalten', exact: true }).first().click(); await saveUi(page); await c.close();
  });
  await step('B05 lost response after COMMIT; immutable receipt lookup and same-key replay; double click', async () => {
    await paint(page, 'Tag', [16]); truncate = true;
    const n = saves.length; await saveButton(page).dblclick();
    await page.getByRole('heading', { name: 'Ergebnis unbekannt', exact: true }).waitFor(); assert.equal(saves.length, n + 1);
    const sent = saves.at(-1); await until(() => Promise.resolve(sent.result !== null), 'committed receipt');
    const before = await rows();
    await page.getByRole('button', { name: 'Ergebnis abfragen', exact: true }).click();
    await page.getByText(/Der Monat wurde gespeichert:.*Der aktuelle Stand ist geladen\./).waitFor(); assert.equal(saves.length, n + 1);
    const replay = await saveApi(page, JSON.parse(sent.body), plan, ids.employee, sent.key);
    assert.equal(replay.status, 200); assert.equal(replay.replayed, 'true'); assert.deepEqual(replay.body, sent.result); assert.deepEqual(await rows(), before);
    const changed = structuredClone(JSON.parse(sent.body)); changed.days[17].desired = { state: 'DAY', role: 'EMPLOYEE' };
    assert.equal((await saveApi(page, changed, plan, ids.employee, sent.key)).status, 409);
  });
  await step('B06 real First Publish, then CR-03 UI save without republish', async () => {
    await page.getByRole('radio', { name: 'Alle Personen', exact: true }).click();
    await page.getByRole('button', { name: 'Monatsplan veröffentlichen …', exact: true }).click();
    const dialog = page.getByRole('alertdialog'); await dialog.getByRole('button', { name: 'Jetzt veröffentlichen', exact: true }).click();
    await page.getByText(/^Der Monatsplan wurde veröffentlicht\./).waitFor();
    const before = (await pool.query('SELECT published_at FROM monthly_plans WHERE id=$1', [plan])).rows[0];
    await openPlanner(page); await paint(page, 'Tag', [18]); await saveUi(page);
    assert.equal(JSON.parse(saves.at(-1).body).expectedPlan.status, 'PUBLISHED');
    assert.deepEqual((await pool.query('SELECT published_at FROM monthly_plans WHERE id=$1', [plan])).rows[0], before);
  });
  await step('B07 closed and MISSING calendars block new work; backend rejects injected work atomically', async () => {
    // The removed Saturday membership leaves an empty Saturday duty, so keep
    // Saturday open and close Sunday (calendar D5 also protects empty duties).
    await calendar(page, ids.project, [1, 2, 3, 4, 5, 6]); await openPlanner(page);
    await paint(page, 'Tag', []); assert.equal(await day(page, 20).getAttribute('aria-disabled'), 'true');
    const b = await bodyFor(page); b.days[19].desired = { state: 'DAY', role: 'EMPLOYEE' }; const before = await rows();
    assert.equal((await saveApi(page, b)).status, 409); assert.deepEqual(await rows(), before);
    await openPlanner(page, missingPlan, ids.missingEmployee); await page.getByText(/keine Betriebstage festgelegt/).waitFor();
    const missing = await bodyFor(page, missingPlan, ids.missingEmployee); missing.days[1].desired = { state: 'DAY', role: 'EMPLOYEE' };
    assert.equal((await saveApi(page, missing, missingPlan, ids.missingEmployee)).status, 409);
    await calendar(page, ids.project, [1, 2, 3, 4, 5, 6, 7]);
  });
  await step('B08 explicit legacy DAY+NIGHT SQL fixture is corrected exclusively through React', async () => {
    // Modern writers forbid this state. Reproduce historical input only on our verified fixture tenant.
    await verifyRecordedTestTarget();
    const d = randomUUID();
    await pool.query(`INSERT INTO duties(id,company_id,project_id,monthly_plan_id,planning_month,duty_date,shift_kind,starts_at,ends_at,time_zone,config_effective_from_month,start_local,end_local)
      VALUES($1,$2,$3,$4,'2026-12-01','2026-12-03','TAG','2026-12-03T05:00Z','2026-12-03T17:00Z','Europe/Berlin','2026-12-01','06:00','18:00') ON CONFLICT DO NOTHING`, [d, ids.company, ids.project, plan]);
    const duty = (await pool.query("SELECT id FROM duties WHERE company_id=$1 AND monthly_plan_id=$2 AND duty_date='2026-12-03' AND shift_kind='TAG' AND removed_at IS NULL", [ids.company, plan])).rows[0].id;
    await pool.query("INSERT INTO plan_assignments(company_id,duty_id,employee_id,duty_function) VALUES($1,$2,$3,'MITARBEITER')", [ids.company, duty, ids.employee]);
    await openPlanner(page); assert.match(await day(page, 3).getAttribute('aria-label'), /Tagdienst und Nachtdienst/);
    assert.equal(await saveButton(page).getAttribute('aria-disabled'), 'true'); await paint(page, 'Nacht', [3]); await saveUi(page);
    assert.equal((await rows()).filter(r => r.duty_date === '2026-12-03' && r.employee_id === ids.employee).length, 1);
  });
  await step('B09 mobile 390px, keyboard roving focus and unsaved navigation/beforeunload guards', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await paint(page, 'Tag', [20]);
    await day(page, 20).focus(); await page.keyboard.press('ArrowRight'); assert.equal(await day(page, 21).evaluate(el => el === document.activeElement), true);
    await page.getByRole('link', { name: 'Zurück zur Übersicht', exact: true }).click();
    await page.getByRole('group', { name: 'Ungespeicherte Monatsplanung' }).waitFor(); await page.getByRole('button', { name: 'Weiter planen', exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: resolve(output, 'B09-mobile.png'), fullPage: true });
    const dialogEvent = page.waitForEvent('dialog');
    const reload = page.reload().catch(() => null);
    const guard = await dialogEvent; assert.equal(guard.type(), 'beforeunload'); await guard.dismiss(); await reload;
    assert.match(await day(page, 20).getAttribute('aria-label'), /Tagdienst/);
    await saveUi(page);
  });
  await step('B10 401 hides draft; same actor re-login re-reads and restores without sending', async () => {
    await paint(page, 'Tag', [22]); await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE account_id=$1 AND revoked_at IS NULL', [ids.admin]);
    const n = saves.length; await saveButton(page).click();
    await page.getByRole('heading', { name: 'Anmelden', exact: true }).waitFor(); assert.equal(await page.getByRole('grid').count(), 0);
    // Login in place: no page.goto, because a document reload intentionally loses memory.
    await page.getByLabel('E-Mail-Adresse').fill(email(ids.admin)); await page.getByLabel('Passwort', { exact: true }).fill(password); await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
    await page.getByRole('radio', { name: /Monat einer Person planen/ }).check(); await page.getByRole('grid', { name: /Dienste von/ }).waitFor();
    assert.match(await day(page, 22).getAttribute('aria-label'), /Tagdienst/); assert.equal(saves.length, n + 1);
    await page.getByRole('heading', { name: 'Ergebnis unbekannt', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Ergebnis abfragen', exact: true }).click();
    await page.getByRole('heading', { name: 'Ergebnis nicht feststellbar', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Aktuellen Stand laden und Auswahl prüfen', exact: true }).click();
    await page.getByText(/Der aktuelle Stand wurde geladen/).waitFor(); await saveUi(page);
  });
  await step('B11 different actor/company never sees or submits the retained draft; role and tenant guards', async () => {
    await paint(page, 'Tag', [24]); await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE account_id=$1 AND revoked_at IS NULL', [ids.admin]); await saveButton(page).click();
    await page.getByRole('heading', { name: 'Anmelden', exact: true }).waitFor();
    await page.getByLabel('E-Mail-Adresse').fill(email(ids.other)); await page.getByLabel('Passwort', { exact: true }).fill(password); await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
    await page.getByRole('radio', { name: /Monat einer Person planen/ }).check(); await page.getByRole('grid', { name: /Dienste von/ }).waitFor();
    assert.match(await day(page, 24).getAttribute('aria-label'), /Frei/); assert.equal(await saveButton(page).getAttribute('aria-disabled'), 'true');
    const foreignContext = await browser.newContext(); const foreignPage = await foreignContext.newPage(); await login(foreignPage, ids.foreignAdmin);
    assert.equal((await api(foreignPage, 'GET', route())).status, 404);
    const body = await bodyFor(page); assert.equal((await saveApi(foreignPage, body)).status, 404);
    const employeeContext = await browser.newContext(); const employeePage = await employeeContext.newPage(); await login(employeePage, ids.employeeAccount);
    assert.equal((await api(employeePage, 'GET', route())).status, 403); assert.equal((await saveApi(employeePage, body)).status, 403);
    assert.equal((await api(page, 'POST', `${route()}/save`, body, { 'Idempotency-Key': randomUUID() }, false)).status, 403);
    assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
    await foreignContext.close(); await employeeContext.close();
  });
  await step('B12 failed result lookup, then explicit same-body/key retry after correction', async () => {
    await openPlanner(page); await paint(page, 'Tag', [14, 25]); truncate = true;
    await saveButton(page).click(); await page.getByRole('heading', { name: 'Ergebnis unbekannt', exact: true }).waitFor();
    const failed = saves.at(-1); assert.equal(failed.status, 409);
    await page.getByRole('button', { name: 'Ergebnis abfragen', exact: true }).click();
    await page.getByRole('heading', { name: 'Monat nicht gespeichert', exact: true }).waitFor();
    const selection = { operation: 'CLEAR', fromDate: '2026-12-14', toDate: '2026-12-14' };
    const preview = await api(page, 'POST', `/employees/${ids.employee}/availability/preview`, selection); assert.equal(preview.status, 200);
    assert.equal((await api(page, 'POST', `/employees/${ids.employee}/availability/batch`, { ...selection, previewToken: preview.body.previewToken, confirmation: 'CLEAR' }, { 'Idempotency-Key': randomUUID() })).status, 200);
    const n = saves.length; await page.getByRole('button', { name: 'Unverändert erneut speichern', exact: true }).click();
    await page.getByText(/Der Monat wurde gespeichert:.*Der aktuelle Stand ist geladen\./).waitFor();
    assert.equal(saves.length, n + 1); assert.equal(saves.at(-1).key, failed.key); assert.equal(saves.at(-1).body, failed.body);
  });
  await step('B13 company switch on the same login boundary discards hidden draft and old receipt key scope', async () => {
    await paint(page, 'Tag', [27]);
    const priorKey = saves.at(-1).key;
    await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE account_id=$1 AND revoked_at IS NULL', [ids.other]);
    await saveButton(page).click(); await page.getByRole('heading', { name: 'Anmelden', exact: true }).waitFor();
    await page.getByLabel('E-Mail-Adresse').fill(email(ids.foreignAdmin)); await page.getByLabel('Passwort', { exact: true }).fill(password); await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
    await page.getByText('Nicht gefunden', { exact: true }).waitFor();
    assert.equal(await page.getByRole('grid').count(), 0); assert.equal(await saveButton(page).count(), 0);
    assert.equal((await api(page, 'GET', `${route()}/save-result`, null, { 'Idempotency-Key': priorKey })).status, 404);
  });
  assert.equal(report.pageErrors, 0);
} catch (error) {
  if (activePage) {
    await activePage.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
    await writeFile(resolve(output, 'failure-text.txt'), await activePage.locator('body').innerText().catch(() => 'Page unavailable'));
    await writeFile(resolve(output, 'failure-aria.txt'), await activePage.locator('body').ariaSnapshot().catch(() => 'Unavailable'));
    await writeFile(resolve(output, 'failure-modes.txt'), await activePage.locator('.month-planner__modes').evaluate(el => el.outerHTML).catch(() => 'Unavailable'));
  }
  // Assertion text contains only synthetic fixture values. Never dump request/response objects.
  console.error(error instanceof Error ? error.message : 'Acceptance failed'); process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  for (const name of ['B01','B02','B03','B04','B05','B06','B07','B08','B09','B10','B11','B12','B13']) if (!report.results.some(r => r.name.startsWith(name))) report.results.push({ name, result: 'NOT_RUN' });
  report.requestCount = saves.length; report.bundleHash = createHash('sha256').update(await readFile(resolve(root, 'apps/frontend/dist/index.html'))).digest('hex');
  await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close(); if (frontend) await new Promise(done => frontend.close(done));
  if (backend && backend.exitCode === null) { backend.kill(); await new Promise(done => backend.once('exit', done)); }
  // Leave synthetic data only in this tmpfs disposable container for evidence queries.
  await pool.end();
}
