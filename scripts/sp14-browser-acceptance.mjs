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
let backend, frontend, browser, nativeBrowser, nativeDriver, activePage, origin, plan, missingPlan;
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
async function logoutUi(p) {
  const button=p.getByRole('button',{name:'Abmelden',exact:true});
  if(!await button.isVisible()) await p.getByRole('button',{name:/Men\u00fc/}).click();
  await button.click();
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
  for (const company of [ids.company, ids.foreign]) await pool.query("INSERT INTO companies(id,name,status,time_zone) VALUES($1,'Synthetic SP14 Acceptance','ACTIVE','Europe/Berlin')", [company]);
  for (const [id, company, role] of [[ids.admin, ids.company, 'COMPANY_ADMIN'], [ids.other, ids.company, 'COMPANY_ADMIN'], [ids.foreignAdmin, ids.foreign, 'COMPANY_ADMIN'], [ids.employeeAccount, ids.company, 'EMPLOYEE'], [ids.secondAccount, ids.company, 'EMPLOYEE'], [ids.missingAccount, ids.company, 'EMPLOYEE']])
    await pool.query("INSERT INTO accounts(id,company_id,email,account_scope,role,status,password_hash) VALUES($1,$2,$3,'TENANT',$4,'ACTIVE',$5)", [id, company, email(id), role, hash]);
  for (const [id, account, name] of [[ids.employee, ids.employeeAccount, 'Alpha'], [ids.second, ids.secondAccount, 'Bravo'], [ids.missingEmployee, ids.missingAccount, 'Missing']])
    await pool.query("INSERT INTO employees(id,company_id,account_id,employee_number,first_name,last_name,shift_eligibility,employment_start) VALUES($1,$2,$3,$4,'Synthetic',$5,'BOTH','2020-01-01')", [id, ids.company, account, name, name]);
  for (const [project, name] of [[ids.project, 'Synthetic SP14 Open'], [ids.missingProject, 'Synthetic SP14 Missing']]) {
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
    if(req.url==='/browser-away'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>Acceptance away</title><p>Acceptance away</p>');return;}
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
      res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', 'Cache-Control': 'private, max-age=60' }); res.end(await readFile(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(done => frontend.listen(fp, '127.0.0.1', done));
  browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, ignoreDefaultArgs:['--disable-back-forward-cache'], args:['--enable-features=BackForwardCache,BackForwardCacheWithNoStore'] }); report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const page = await context.newPage(); activePage = page; page.on('pageerror', () => report.pageErrors++);
  await seed(); await login(page);
  await calendar(page, ids.project, [1, 2, 3, 4, 5, 6, 7]);
  const p = await api(page, 'POST', '/monthly-plans', { projectId: ids.project, monthStart: '2026-12-01' }); assert.equal(p.status, 201); plan = p.body.id;
  const m = await api(page, 'POST', '/monthly-plans', { projectId: ids.missingProject, monthStart: '2026-12-01' }); assert.equal(m.status, 201); missingPlan = m.body.id;
  await openPlanner(page);

  await step('B1 admin UI Save and First Publish; employee sees exact own saved duties', async () => {
    await paint(page, 'Tag', [3]); await paint(page, 'Nacht', [31]); await saveUi(page);
    await page.getByRole('radio', { name: 'Alle Personen', exact: true }).click();
    await page.getByRole('button', { name: /Monatsplan ver\u00f6ffentlichen/ }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: /Jetzt ver\u00f6ffentlichen/ }).click();
    await page.getByText(/^Der Monatsplan wurde ver\u00f6ffentlicht\./).waitFor();
  });
  const ec = await browser.newContext({viewport:{width:390,height:844},locale:'de-DE',timezoneId:'America/Los_Angeles'});
  const ep = await ec.newPage(); activePage=ep; ep.on('pageerror',()=>report.pageErrors++);
  await login(ep,ids.employeeAccount); await ep.goto(`${origin}/mein-monatsplan/2026-12`);
  await ep.locator('.duty-card').nth(1).waitFor();
  await step('B1 employee full reload agrees with primary SQL and CR03 next refresh',async()=>{
    assert.equal(await ep.locator('.duty-card').count(),2);
    const own = await api(ep,'GET','/me/monthly-plans?monthStart=2026-12-01');
    assert.equal(own.status,200); assert.equal(own.cache,'private, no-store'); assert.equal(own.body.items[0].duties.length,2);
    assert.equal(own.body.items[0].duties[1].endsAt,'2027-01-01T05:00:00Z');
    assert.doesNotMatch(JSON.stringify(own.body),new RegExp(`${ids.employee}|${ids.second}|${ids.company}`));
    await ep.reload(); await ep.locator('.duty-card').nth(1).waitFor();
    const published=(await pool.query('SELECT published_at FROM monthly_plans WHERE id=$1',[plan])).rows;
    await openPlanner(page); await paint(page,'Tag',[5]); await saveUi(page);
    await ep.getByRole('button',{name:'Aktualisieren',exact:true}).click(); await until(async()=>await ep.locator('.duty-card').count()===3,'CR03 fresh read');
    assert.deepEqual((await pool.query('SELECT published_at FROM monthly_plans WHERE id=$1',[plan])).rows,published);
  });
  await step('B2 390px layout, saved Berlin zone, overnight date and keyboard navigation',async()=>{
    assert.equal(await ep.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.match(await ep.locator('body').innerText(),/01\.01\.2027/);
    assert.match(await ep.locator('body').innerText(),/Europe\/Berlin/);
    assert.equal(await ep.locator('ul.my-plan__duties > li article').count(),3);
    await ep.getByRole('link',{name:/N\u00e4chster Monat/}).focus(); await ep.keyboard.press('Enter');
    await ep.getByText('Kein ver\u00f6ffentlichter Plan',{exact:true}).waitFor();
    assert.match(ep.url(),/2027-01$/);
    await ep.getByLabel('Monat ausw\u00e4hlen').fill('2026-12'); await ep.locator('.duty-card').nth(2).waitFor();
    await ep.screenshot({path:resolve(output,'B2-390px.png'),fullPage:true});
  });
  await step('B3 authoritative company default independent of Los Angeles and Tokyo browser zones',async()=>{
    const me=(await api(ep,'GET','/me')).body;
    for(const zone of ['America/Los_Angeles','Asia/Tokyo']){
      const c=await browser.newContext({timezoneId:zone,locale:'de-DE'});const p=await c.newPage();
      await login(p,ids.employeeAccount); await p.goto(`${origin}/mein-monatsplan`);
      await until(async()=>new URL(p.url()).pathname===`/mein-monatsplan/${me.currentCompanyMonth.slice(0,7)}`,'company default');
      await p.goto(`${origin}/mein-monatsplan/2026-12`);await p.locator('.duty-card').nth(2).waitFor();
      assert.match(await p.locator('body').innerText(),/Europe\/Berlin/);await c.close();
    }
  });
  await step('B5 malformed200, 403 and500 reject complete payload; explicit retry recovers',async()=>{
    const pattern='**/api/v1/me/monthly-plans?*';
    for(const status of [200,403,500]){
      await ep.route(pattern,async route=>{
        const real=await route.fetch({ignoreHTTPSErrors:true});const body=await real.json();
        if(status===200) body.items.push({privateUnexpected:true});
        await route.fulfill({status,contentType:status===200?'application/json':'application/problem+json',body:JSON.stringify(body)});
      });
      await ep.getByRole('button',{name:'Aktualisieren',exact:true}).click();await ep.getByRole('alert').waitFor();
      assert.equal(await ep.locator('.duty-card').count(),0); await ep.unroute(pattern);
      await ep.getByRole('button',{name:'Aktualisieren',exact:true}).click();await ep.locator('.duty-card').nth(2).waitFor();
    }
  });
  await step('B4 late old-principal response after logout and another employee login never renders',async()=>{
    const pattern='**/api/v1/me/monthly-plans?*';let entered;const started=new Promise(done=>entered=done);let release;const held=new Promise(done=>release=done);
    await ep.route(pattern,async route=>{const response=await route.fetch({ignoreHTTPSErrors:true});entered();await held;await route.fulfill({response}).catch(()=>{});});
    await ep.getByRole('button',{name:'Aktualisieren',exact:true}).click();await started;
    await logoutUi(ep);await ep.getByRole('heading',{name:'Anmelden',exact:true}).waitFor();
    await ep.unroute(pattern);await ep.getByLabel('E-Mail-Adresse').fill(email(ids.secondAccount));await ep.getByLabel('Passwort',{exact:true}).fill(password);await ep.getByRole('button',{name:'Anmelden',exact:true}).click();
    await until(async()=>(await api(ep,'GET','/me')).body?.accountId===ids.secondAccount,'second principal login complete');
    await ep.goto(`${origin}/mein-monatsplan/2026-12`);await ep.getByText('Keine Dienste geplant',{exact:true}).waitFor();release();await wait(150);
    assert.equal(await ep.locator('.duty-card').count(),0);
    assert.equal((await api(ep,'GET','/me')).body.accountId,ids.secondAccount);
    const stored=await ep.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));
    assert.doesNotMatch(stored,/dutyId|startsAt|Synthetic SP14/);
  });
  await step('B4 cross-tab logout unmounts; back navigation remains authenticated-gated',async()=>{
    const sibling=await ec.newPage();await sibling.goto(`${origin}/mein-monatsplan/2026-12`);await sibling.getByText('Keine Dienste geplant',{exact:true}).waitFor();
    await logoutUi(sibling);await ep.getByRole('heading',{name:'Anmelden',exact:true}).waitFor();
    assert.equal(await ep.locator('.duty-card').count(),0);await ep.goBack();await ep.getByRole('heading',{name:'Anmelden',exact:true}).waitFor();await sibling.close();
  });
  await step('B5 real session expiry central401 clears schedule; invalid month is a safe German error',async()=>{
    await login(ep,ids.employeeAccount);await ep.goto(`${origin}/mein-monatsplan/2026-12`);await ep.locator('.duty-card').nth(2).waitFor();
    await pool.query("UPDATE sessions SET created_at=clock_timestamp()-interval '1 hour',absolute_expires_at=clock_timestamp()-interval '1 second' WHERE account_id=$1",[ids.employeeAccount]);
    await ep.getByRole('button',{name:'Aktualisieren',exact:true}).click();await ep.getByRole('heading',{name:'Anmelden',exact:true}).waitFor();assert.equal(await ep.locator('.duty-card').count(),0);
    await login(ep,ids.employeeAccount);await ep.goto(`${origin}/mein-monatsplan/2026-13`);await ep.getByRole('heading',{name:'Ung\u00fcltiger Monat'}).waitFor();assert.equal(await ep.locator('.duty-card').count(),0);
  });

  await step('B4 actual foreground and bfcache revalidation conceal revoked employee DOM',async()=>{
    const debugPort=await freePort();
    nativeDriver=await chromium.launch({channel:'chrome',headless:false,chromiumSandbox:true,ignoreDefaultArgs:['--disable-back-forward-cache','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding','--disable-background-timer-throttling'],args:['--window-position=-10000,-10000','--disable-features=CalculateNativeWinOcclusion',`--remote-debugging-port=${debugPort}`]});
    nativeBrowser=await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`,{noDefaults:true});
    const c=nativeBrowser.contexts()[0];const p=await c.newPage();activePage=p;await p.bringToFront();
    await p.addInitScript(()=>{window.addEventListener('pageshow',event=>{if(event.persisted)window.__sp14Persisted=true;});});
    await p.goto(`${origin}/browser-away`);assert.equal((await api(p,'POST','/auth/login',{email:email(ids.employeeAccount),password},{},false)).status,200);
    await p.goto(`${origin}/mein-monatsplan/2026-12`);await p.locator('.duty-card').nth(2).waitFor({state:'attached'});
    const sibling=await c.newPage();await sibling.goto(`${origin}/browser-away`);await sibling.bringToFront();
    const cdp=await c.newCDPSession(p);const {windowId}=await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:false});
    await cdp.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'minimized'}});
    await until(async()=>await p.evaluate(()=>document.visibilityState==='hidden'),'native minimized visibility');
    const hidden=await p.evaluate(()=>document.visibilityState==='hidden');
    report.foregroundNativeHidden=hidden;
    if(hidden)await until(async()=>await p.evaluate(()=>getComputedStyle(document.body).visibility==='hidden'),'visibility event conceals private DOM');
    await cdp.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'normal'}});await p.bringToFront();await p.locator('.duty-card').nth(2).waitFor();
    await p.goto(`${origin}/browser-away`);
    await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE account_id=$1',[ids.employeeAccount]);
    await p.goBack({waitUntil:'commit',timeout:5000}).catch(()=>assert.match(p.url(),/2026-12$/));await p.getByRole('heading',{name:'Anmelden',exact:true}).waitFor();
    report.bfcachePersisted=await p.evaluate(()=>window.__sp14Persisted===true);
    report.bfcacheReasons=await p.evaluate(()=>performance.getEntriesByType('navigation')[0]?.notRestoredReasons?.toJSON());
    assert.equal(report.bfcachePersisted,true,'actual Chrome persisted pageshow required');
    assert.equal(await p.locator('.duty-card').count(),0);assert.match(p.url(),/2026-12$/);await nativeBrowser.close();await nativeDriver.close();nativeBrowser=null;nativeDriver=null;activePage=ep;
  });
  await step('B4 same-account new session ignores delayed old200 and network failure has no fallback',async()=>{
    await ep.goto(`${origin}/mein-monatsplan/2026-12`);await ep.getByRole('heading',{name:'Anmelden',exact:true}).waitFor();
    await ep.getByLabel('E-Mail-Adresse').fill(email(ids.employeeAccount));await ep.getByLabel('Passwort',{exact:true}).fill(password);await ep.getByRole('button',{name:'Anmelden',exact:true}).click();await ep.locator('.duty-card').nth(2).waitFor();
    const pattern='**/api/v1/me/monthly-plans?*';let entered;const started=new Promise(done=>entered=done);let release;const held=new Promise(done=>release=done);
    await ep.route(pattern,async route=>{const response=await route.fetch({ignoreHTTPSErrors:true});entered();await held;await route.fulfill({response}).catch(()=>{});});
    await ep.getByRole('button',{name:'Aktualisieren',exact:true}).click();await started;await logoutUi(ep);await ep.getByRole('heading',{name:'Anmelden',exact:true}).waitFor();await ep.unroute(pattern);
    await ep.getByLabel('E-Mail-Adresse').fill(email(ids.employeeAccount));await ep.getByLabel('Passwort',{exact:true}).fill(password);await ep.getByRole('button',{name:'Anmelden',exact:true}).click();
    await ep.locator('.duty-card').nth(2).waitFor();release();await wait(100);assert.equal(await ep.locator('.duty-card').count(),3);
    await ep.route(pattern,route=>route.abort('internetdisconnected'));await ep.getByRole('button',{name:'Aktualisieren',exact:true}).click();await ep.getByRole('alert').waitFor();assert.equal(await ep.locator('.duty-card').count(),0);await ep.unroute(pattern);
    await ep.getByRole('button',{name:'Aktualisieren',exact:true}).click();await ep.locator('.duty-card').nth(2).waitFor();
  });
  assert.equal(report.pageErrors,0);await ec.close();
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
  report.requestCount = saves.length; report.bundleHash = createHash('sha256').update(await readFile(resolve(root, 'apps/frontend/dist/index.html'))).digest('hex');
  await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await nativeBrowser?.close();await nativeDriver?.close();await browser?.close(); if (frontend) await new Promise(done => frontend.close(done));
  if (backend && backend.exitCode === null) { backend.kill(); await new Promise(done => backend.once('exit', done)); }
  // Leave synthetic data only in this tmpfs disposable container for evidence queries.
  await pool.end();
}
