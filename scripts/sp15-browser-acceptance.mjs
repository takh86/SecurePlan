/** Real installed Chrome -> built React -> NestJS -> verified disposable PG17.
 * Synthetic identity/project prerequisites use SQL on the verified target.
 * Normal saves, calendars, publication and CR03 edits use real HTTP.
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
const { chromium } = await import(
  pathToFileURL(resolve(process.env.SECUREPLAN_PLAYWRIGHT_MODULE)).href
);
const output = resolve(process.env.SECUREPLAN_BROWSER_OUTPUT_DIR);
await mkdir(output, { recursive: true });
const { hashPassword } =
  await import('../apps/backend/dist/auth/password-hasher.js');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const ids = Object.fromEntries(
  [
    'company',
    'foreign',
    'admin',
    'other',
    'foreignAdmin',
    'foreignEmployeeAccount',
    'foreignEmployee',
    'employeeAccount',
    'secondAccount',
    'missingAccount',
    'employee',
    'second',
    'missingEmployee',
    'project',
    'missingProject',
  ].map((k) => [k, randomUUID()]),
);
const password = randomBytes(24).toString('base64url');
const email = (id) => `${id}@example.invalid`;
const report = {
  startedAt: new Date().toISOString(),
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim(),
  sourceDirty:
    execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      encoding: 'utf8',
    }).trim() !== '',
  cluster: verified.cluster,
  browser: null,
  results: [],
  pageErrors: 0,
};
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
let backend,
  frontend,
  browser,
  nativeBrowser,
  nativeDriver,
  activePage,
  origin,
  plan;
let heldResponse = null;
let fault = null;
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
async function until(predicate, label) {
  const end = Date.now() + 15_000;
  while (!(await predicate())) {
    assert.ok(Date.now() < end, label);
    await wait(75);
  }
}
async function freePort() {
  const s = createServer();
  await new Promise((done) => s.listen(0, '127.0.0.1', done));
  const port = s.address().port;
  await new Promise((done) => s.close(done));
  return port;
}
async function api(page, method, path, body = null, headers = {}, csrf = true) {
  return page.evaluate(
    async ([method, path, body, headers, csrf]) => {
      if (csrf && method !== 'GET') {
        const me = await fetch('/api/v1/me', { cache: 'no-store' });
        headers['X-CSRF-Token'] = me.headers.get('x-csrf-token') ?? '';
      }
      if (body !== null) headers['Content-Type'] = 'application/json';
      const r = await fetch(`/api/v1${path}`, {
        method,
        headers,
        cache: 'no-store',
        body: body === null ? undefined : JSON.stringify(body),
      });
      let json = null;
      try {
        json = await r.json();
      } catch {
        /* bodyless */
      }
      return {
        status: r.status,
        body: json,
        cache: r.headers.get('cache-control'),
        replayed: r.headers.get('idempotency-replayed'),
      };
    },
    [method, path, body, headers, csrf],
  );
}
async function logoutUi(p) {
  const button = p.getByRole('button', { name: 'Abmelden', exact: true });
  if (!(await button.isVisible()))
    await p.getByRole('button', { name: /Men\u00fc/ }).click();
  await button.click();
}
async function login(page, account = ids.admin) {
  await page.goto(`${origin}/monatsplanung?month=2026-12`);
  await page.getByRole('heading', { name: 'Anmelden', exact: true }).waitFor();
  await page.getByLabel('E-Mail-Adresse').fill(email(account));
  await page.getByLabel('Passwort', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
  await until(
    async () => (await api(page, 'GET', '/me')).status === 200,
    'login',
  );
}
const route = (id = plan, person = ids.employee) =>
  `/monthly-plans/${id}/employee-months/${person}`;
async function bodyFor(page, id = plan, person = ids.employee) {
  const r = await api(page, 'GET', route(id, person));
  assert.equal(r.status, 200);
  assert.equal(r.cache, 'no-store');
  const v = r.body;
  return {
    expectedPlan: { status: v.plan.status, publishedAt: v.plan.publishedAt },
    expectedCreationContext: v.creationContextFingerprint,
    expectedCalendar: v.operatingCalendar.effective
      ? {
          id: v.operatingCalendar.effective.id,
          version: v.operatingCalendar.effective.version,
        }
      : null,
    days: v.days.map((d) => ({
      date: d.date,
      expected: {
        day: d.day ? { id: d.day.dutyId, version: d.day.version } : null,
        night: d.night
          ? { id: d.night.dutyId, version: d.night.version }
          : null,
      },
      desired: d.day?.assignment
        ? { state: 'DAY', role: d.day.assignment.dutyRole }
        : d.night?.assignment
          ? { state: 'NIGHT', role: d.night.assignment.dutyRole }
          : { state: 'OFF' },
    })),
  };
}
async function saveApi(
  page,
  body,
  id = plan,
  person = ids.employee,
  key = randomUUID(),
) {
  return api(page, 'POST', `${route(id, person)}/save`, body, {
    'Idempotency-Key': key,
  });
}
async function calendar(page, project, weekdays) {
  const path = `/projects/${project}/operating-calendar`;
  const r = await api(page, 'GET', `${path}?effectiveForMonth=2026-12-01`);
  assert.equal(r.status, 200);
  const v = r.body;
  const updated = await api(page, 'PATCH', path, {
    effectiveFromMonth: '2026-12-01',
    expectedExactVersion: v.exactVersion,
    expectedEffective: v.effective
      ? { id: v.effective.id, version: v.effective.version }
      : null,
    expectedNextEffectiveFromMonth: v.nextEffectiveFromMonth,
    operatingWeekdays: weekdays,
    bootstrap: false,
  });
  assert.equal(updated.status, 200);
}
async function seed() {
  await verifyRecordedTestTarget();
  const hash = await hashPassword(password);
  for (const company of [ids.company, ids.foreign])
    await pool.query(
      "INSERT INTO companies(id,name,status,time_zone) VALUES($1,'Synthetic SP15 Acceptance','ACTIVE','Europe/Berlin')",
      [company],
    );
  for (const [id, company, role] of [
    [ids.admin, ids.company, 'COMPANY_ADMIN'],
    [ids.other, ids.company, 'COMPANY_ADMIN'],
    [ids.foreignAdmin, ids.foreign, 'COMPANY_ADMIN'],
    [ids.foreignEmployeeAccount, ids.foreign, 'EMPLOYEE'],
    [ids.employeeAccount, ids.company, 'EMPLOYEE'],
    [ids.secondAccount, ids.company, 'EMPLOYEE'],
    [ids.missingAccount, ids.company, 'EMPLOYEE'],
  ])
    await pool.query(
      "INSERT INTO accounts(id,company_id,email,account_scope,role,status,password_hash) VALUES($1,$2,$3,'TENANT',$4,'ACTIVE',$5)",
      [id, company, email(id), role, hash],
    );
  for (const [id, account, name] of [
    [ids.employee, ids.employeeAccount, 'Alpha'],
    [ids.second, ids.secondAccount, 'Bravo'],
    [ids.missingEmployee, ids.missingAccount, 'Missing'],
  ])
    await pool.query(
      "INSERT INTO employees(id,company_id,account_id,employee_number,first_name,last_name,shift_eligibility,employment_start) VALUES($1,$2,$3,$4,'Synthetic',$5,'BOTH','2020-01-01')",
      [id, ids.company, account, name, name],
    );
  await pool.query(
    "INSERT INTO employees(id,company_id,account_id,employee_number,first_name,last_name,shift_eligibility,employment_start) VALUES($1,$2,$3,'Foreign','Synthetic','Foreign','BOTH','2020-01-01')",
    [ids.foreignEmployee, ids.foreign, ids.foreignEmployeeAccount],
  );
  for (const [project, name] of [
    [ids.project, 'Synthetic SP15 Open'],
    [ids.missingProject, 'Synthetic SP15 Missing'],
  ]) {
    await pool.query(
      "INSERT INTO projects(id,company_id,name,status) VALUES($1,$2,$3,'ACTIVE')",
      [project, ids.company, name],
    );
    for (const [kind, start, end] of [
      ['TAG', '06:00', '18:00'],
      ['NACHT', '18:00', '06:00'],
    ])
      await pool.query(
        "INSERT INTO shift_configurations(company_id,project_id,effective_from_month,shift_kind,start_local,end_local) VALUES($1,$2,'2026-12-01',$3,$4,$5)",
        [ids.company, project, kind, start, end],
      );
  }
  for (const person of [ids.employee, ids.second])
    await pool.query(
      "INSERT INTO project_assignments(company_id,employee_id,project_id,planning_month) VALUES($1,$2,$3,'2026-12-01')",
      [ids.company, person, ids.project],
    );
  await pool.query(
    "INSERT INTO project_assignments(company_id,employee_id,project_id,planning_month) VALUES($1,$2,$3,'2026-12-01')",
    [ids.company, ids.missingEmployee, ids.missingProject],
  );
}
try {
  const bp = await freePort(),
    fp = await freePort();
  origin = `https://localhost:${fp}`;
  backend = spawn(process.execPath, ['apps/backend/dist/main.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(bp), APP_ORIGIN: origin },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  backend.stdout.resume();
  backend.stderr.resume();
  await until(async () => {
    assert.equal(backend.exitCode, null, 'backend running');
    return fetch(`http://127.0.0.1:${bp}/api/v1/health/ready`).then(
      (r) => r.status === 200,
      () => false,
    );
  }, 'backend ready');
  const dist = resolve(root, 'apps/frontend/dist');
  frontend = httpsServer(
    {
      key: await readFile(resolve(root, 'infra/tls/localhost-key.pem')),
      cert: await readFile(resolve(root, 'infra/tls/localhost.pem')),
    },
    async (req, res) => {
      if (req.url === '/browser-away') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<!doctype html><title>Acceptance away</title><p>Acceptance away</p>',
        );
        return;
      }
      if (req.url.startsWith('/api/')) {
        const feature = req.url.startsWith('/api/v1/me/planning-statistics');
        const hold = feature && heldResponse ? heldResponse : null;
        if (hold) heldResponse = null;
        const injected = feature && fault ? fault : null;
        if (injected) fault = null;
        const upstream = request(
          {
            hostname: '127.0.0.1',
            port: bp,
            path: req.url,
            method: req.method,
            headers: { ...req.headers, host: `127.0.0.1:${bp}` },
          },
          (reply) => {
            const chunks = [];
            reply.on('data', (chunk) => chunks.push(chunk));
            reply.on('end', async () => {
              if (hold) {
                hold.entered();
                await hold.promise;
              }
              if (res.destroyed) return;
              if (injected) {
                res.writeHead(injected === 401 ? 401 : 200, {
                  'Content-Type': 'application/json',
                  'Cache-Control': 'private, no-store',
                });
                res.end(injected === 401 ? '{}' : '{"invalid":true}');
              } else {
                res.writeHead(reply.statusCode, reply.headers);
                res.end(Buffer.concat(chunks));
              }
            });
          },
        );
        upstream.on('error', () => {
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });
        req.pipe(upstream);
        return;
      }
      try {
        const path = new URL(req.url, origin).pathname;
        const file = path.startsWith('/assets/')
          ? resolve(dist, `.${path}`)
          : resolve(dist, 'index.html');
        assert.ok(file.startsWith(`${dist}${sep}`));
        res.writeHead(200, {
          'Content-Type': file.endsWith('.js')
            ? 'text/javascript'
            : file.endsWith('.css')
              ? 'text/css'
              : 'text/html',
          'Cache-Control': 'private, max-age=60',
        });
        res.end(await readFile(file));
      } catch {
        res.writeHead(404);
        res.end();
      }
    },
  );
  await new Promise((done) => frontend.listen(fp, '127.0.0.1', done));
  browser = await chromium.launch({
    channel: process.env.SECUREPLAN_BROWSER_CHANNEL ?? 'chrome',
    headless: true,
    chromiumSandbox: true,
    ignoreDefaultArgs: ['--disable-back-forward-cache'],
    args: ['--enable-features=BackForwardCache,BackForwardCacheWithNoStore'],
  });
  report.browser = {
    channel: process.env.SECUREPLAN_BROWSER_CHANNEL ?? 'chrome',
    version: browser.version(),
  };

  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: 'de-DE',
    timezoneId: 'America/Los_Angeles',
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  activePage = page;
  page.on('pageerror', () => report.pageErrors++);
  await seed();
  await login(page);
  await calendar(page, ids.project, [1, 2, 3, 4, 5, 6, 7]);
  const p = await api(page, 'POST', '/monthly-plans', {
    projectId: ids.project,
    monthStart: '2026-12-01',
  });
  assert.equal(p.status, 201);
  plan = p.body.id;
  const body = await bodyFor(page);
  body.days[3].desired = { state: 'DAY', role: 'EMPLOYEE' };
  body.days[4].desired = { state: 'NIGHT', role: 'SHIFT_LEAD' };
  assert.equal((await saveApi(page, body)).status, 200);
  await page.goto(`${origin}/monatsplanung/${plan}`);
  await page
    .getByRole('button', { name: /Monatsplan veröffentlichen/ })
    .click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: /Jetzt veröffentlichen/ })
    .click();
  await page.getByText(/^Der Monatsplan wurde veröffentlicht\./).waitFor();
  const ec = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: 'de-DE',
    timezoneId: 'Pacific/Honolulu',
    ignoreHTTPSErrors: true,
  });
  const ep = await ec.newPage();
  activePage = ep;
  ep.on('pageerror', () => report.pageErrors++);
  await login(ep, ids.employeeAccount);
  const cardValues = () => ep.locator('.statistics-card dd').allTextContents();
  const waitCards = async (values) =>
    until(
      async () => JSON.stringify(await cardValues()) === JSON.stringify(values),
      'expected statistics cards',
    );
  await step(
    'B01 real login, published own DAY/NIGHT 2/1/1, exact API, role/tenant boundaries',
    async () => {
      await ep.goto(`${origin}/meine-statistik/2026-12`);
      await waitCards(['2', '1', '1']);
      const r = await api(
        ep,
        'GET',
        '/me/planning-statistics?monthStart=2026-12-01',
      );
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, {
        monthStart: '2026-12-01',
        plannedWorkdays: 2,
        dayShiftCount: 1,
        nightShiftCount: 1,
      });
      assert.equal(r.cache, 'private, no-store');
      assert.equal(
        (
          await api(
            page,
            'GET',
            '/me/planning-statistics?monthStart=2026-12-01',
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await api(
            ep,
            'GET',
            `/me/planning-statistics?monthStart=2026-12-01&companyId=${ids.foreign}`,
          )
        ).status,
        400,
      );
      const foreignContext = await browser.newContext({
          ignoreHTTPSErrors: true,
        }),
        foreignPage = await foreignContext.newPage();
      await login(foreignPage, ids.foreignAdmin);
      assert.equal(
        (
          await api(
            foreignPage,
            'GET',
            '/me/planning-statistics?monthStart=2026-12-01',
          )
        ).status,
        403,
      );
      assert.equal(
        (await api(foreignPage, 'POST', '/auth/logout', {})).status,
        204,
      );
      await login(foreignPage, ids.foreignEmployeeAccount);
      const isolated = await api(
        foreignPage,
        'GET',
        '/me/planning-statistics?monthStart=2026-12-01',
      );
      assert.equal(isolated.status, 200);
      assert.deepEqual(isolated.body, {
        monthStart: '2026-12-01',
        plannedWorkdays: 0,
        dayShiftCount: 0,
        nightShiftCount: 0,
      });
      await foreignContext.close();
    },
  );
  await step(
    'B01 company month default, explicit selection, next/previous, neutral zero, invalid route',
    async () => {
      await ep.goto(`${origin}/meine-statistik`);
      const me = await api(ep, 'GET', '/me');
      await ep.waitForURL(
        `**/meine-statistik/${me.body.currentCompanyMonth.slice(0, 7)}`,
      );
      await ep.goto(`${origin}/meine-statistik/2026-12`);
      await waitCards(['2', '1', '1']);
      await ep
        .getByRole('link', { name: 'Nächster Monat: Januar 2027' })
        .click();
      await waitCards(['0', '0', '0']);
      await ep
        .getByText(
          'Für diesen Monat liegen keine eigenen veröffentlichten Dienste vor.',
        )
        .waitFor();
      await ep
        .getByRole('link', { name: 'Vorheriger Monat: Dezember 2026' })
        .click();
      await waitCards(['2', '1', '1']);
      await ep.getByLabel('Monat auswählen').fill('2026-10');
      await ep.waitForURL('**/meine-statistik/2026-10');
      await waitCards(['0', '0', '0']);
      await ep.goto(`${origin}/meine-statistik/0000-01`);
      await ep.getByRole('heading', { name: 'Ungültiger Monat' }).waitFor();
      assert.equal(await ep.locator('.statistics-card').count(), 0);
      await ep.getByRole('link', { name: 'Zur aktuellen Statistik' }).click();
      await ep.waitForURL(
        `**/meine-statistik/${me.body.currentCompanyMonth.slice(0, 7)}`,
      );
      await ep.goto(`${origin}/meine-statistik/2026-12`);
      await waitCards(['2', '1', '1']);
    },
  );
  await step(
    'B02 responsive 320/390/768/1440, semantic cards, focus, keyboard and 200 percent zoom',
    async () => {
      for (const width of [320, 390, 768, 1440]) {
        await ep.setViewportSize({ width, height: 1000 });
        assert.equal(
          await ep.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
          `no overflow ${width}`,
        );
        assert.equal(
          await ep.locator('dl[aria-label="Planungsstatistik"] dt').count(),
          3,
        );
        await ep.screenshot({
          path: resolve(output, `statistics-${width}.png`),
          fullPage: true,
        });
      }
      await ep
        .getByRole('link', { name: 'Nächster Monat: Januar 2027' })
        .focus();
      const focus = await ep.evaluate(() => {
        const s = getComputedStyle(document.activeElement);
        return { style: s.outlineStyle, width: s.outlineWidth };
      });
      assert.notEqual(focus.style, 'none');
      assert.notEqual(focus.width, '0px');
      await ep.keyboard.press('Enter');
      await waitCards(['0', '0', '0']);
      await ep
        .getByRole('link', { name: 'Vorheriger Monat: Dezember 2026' })
        .focus();
      await ep.keyboard.press('Enter');
      await waitCards(['2', '1', '1']);
      // Real browser page zoom through CDP; record visual scale and separately verify narrow effective layout.
      const cdp = await ec.newCDPSession(ep);
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
      assert.equal(await ep.evaluate(() => visualViewport.scale), 2);
      await ep.screenshot({ path: resolve(output, 'statistics-zoom-200.png') });
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
      await ep.setViewportSize({ width: 640, height: 900 });
      assert.equal(
        await ep.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await ep.setViewportSize({ width: 390, height: 844 });
    },
  );
  await step(
    'B01 fresh CR03 supported HTTP save changes counts without republish',
    async () => {
      const published = (
        await pool.query('SELECT published_at FROM monthly_plans WHERE id=$1', [
          plan,
        ])
      ).rows;
      const edit = await bodyFor(page);
      edit.days[4].desired = { state: 'OFF' };
      assert.equal((await saveApi(page, edit)).status, 200);
      await ep.getByRole('button', { name: 'Aktualisieren' }).click();
      await waitCards(['1', '1', '0']);
      assert.deepEqual(
        (
          await pool.query(
            'SELECT published_at FROM monthly_plans WHERE id=$1',
            [plan],
          )
        ).rows,
        published,
      );
    },
  );
  await step(
    'B01 invalid 200 fails whole response; retry recovers; current 401 signs out',
    async () => {
      fault = 'invalid';
      await ep.getByRole('button', { name: 'Aktualisieren' }).click();
      await ep.getByRole('alert').waitFor();
      assert.equal(await ep.locator('.statistics-card').count(), 0);
      await ep.getByRole('button', { name: /Erneut|Wiederholen/ }).click();
      await waitCards(['1', '1', '0']);
      assert.equal((await api(ep, 'POST', '/auth/logout', {})).status, 204);
      await ep.getByRole('button', { name: 'Aktualisieren' }).click();
      await ep
        .getByRole('heading', { name: 'Anmelden', exact: true })
        .waitFor();
      assert.equal(await ep.locator('.statistics-card').count(), 0);
      await login(ep, ids.employeeAccount);
      await ep.goto(`${origin}/meine-statistik/2026-12`);
      await waitCards(['1', '1', '0']);
    },
  );
  function gate() {
    let release, entered;
    const promise = new Promise((done) => (release = done)),
      arrival = new Promise((done) => (entered = done));
    return { promise, release, entered, arrival };
  }
  await step(
    'B03 real shared-cookie login, BroadcastChannel, old delayed 200/401 and repeated signals',
    async () => {
      const other = await ec.newPage();
      await other.goto(`${origin}/browser-away`);
      for (const status of [200, 401]) {
        const hold = gate();
        heldResponse = hold;
        if (status === 401) fault = 401;
        await ep.getByRole('button', { name: 'Aktualisieren' }).click();
        await hold.arrival;
        assert.equal(await ep.locator('.statistics-card').count(), 0);
        // Same account, a genuinely new cookie/session, two signals while authority is rechecked.
        const signed = await api(other, 'POST', '/auth/login', {
          email: email(ids.employeeAccount),
          password,
        });
        assert.equal(signed.status, 200);
        await other.evaluate(() => {
          const c = new BroadcastChannel('secureplan-session');
          c.postMessage({ type: 'signed-in' });
          c.postMessage({ type: 'signed-in' });
          c.close();
        });
        await waitCards(['1', '1', '0']);
        hold.release();
        await ep.waitForTimeout(100);
        await waitCards(['1', '1', '0']);
        assert.equal(
          await ep
            .getByRole('heading', { name: 'Anmelden', exact: true })
            .count(),
          0,
        );
      }
      // Different employee in same tenant: no own duties; old cards cannot be retained.
      assert.equal(
        (
          await api(other, 'POST', '/auth/login', {
            email: email(ids.secondAccount),
            password,
          })
        ).status,
        200,
      );
      await other.evaluate(() => {
        const c = new BroadcastChannel('secureplan-session');
        c.postMessage({ type: 'signed-in' });
        c.close();
      });
      await waitCards(['0', '0', '0']);
      assert.ok(ep.url().endsWith('/meine-statistik/2026-12'));
      assert.equal((await api(other, 'POST', '/auth/logout', {})).status, 204);
      await other.evaluate(() => {
        const c = new BroadcastChannel('secureplan-session');
        c.postMessage({ type: 'signed-out' });
        c.close();
      });
      await ep
        .getByRole('heading', { name: 'Anmelden', exact: true })
        .waitFor();
      assert.equal(await ep.locator('.statistics-card').count(), 0);
      await other.close();
      await login(ep, ids.employeeAccount);
      await ep.goto(`${origin}/meine-statistik/2026-12`);
      await waitCards(['1', '1', '0']);
    },
  );
  await step(
    'B03 pagehide and persisted history lifecycle conceal before revalidation, retain selected URL',
    async () => {
      // Explicit lifecycle dispatch verifies the built boundary; genuine BFCache admission recorded separately below.
      await ep.evaluate(() =>
        dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
      );
      assert.equal(
        await ep.evaluate(
          () => document.documentElement.dataset.privateSessionHidden,
        ),
        'true',
      );
      await ep.evaluate(() =>
        dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
      );
      await waitCards(['1', '1', '0']);
      await ep.goto(`${origin}/browser-away`);
      await ep
        .goBack({ waitUntil: 'commit', timeout: 5000 })
        .catch(() => assert.ok(ep.url().endsWith('/2026-12')));
      await waitCards(['1', '1', '0']);
      assert.ok(ep.url().endsWith('/meine-statistik/2026-12'));
      report.historyNavigation = await ep.evaluate(() =>
        performance.getEntriesByType('navigation').map((x) => ({
          type: x.type,
          notRestoredReasons: x.notRestoredReasons ?? null,
        })),
      );
    },
  );
  await step(
    'B03 actual foreground and bfcache revalidation conceal revoked employee DOM',
    async () => {
      const debugPort = await freePort();
      nativeDriver = await chromium.launch({
        channel: process.env.SECUREPLAN_BROWSER_CHANNEL ?? 'chrome',
        headless: false,
        chromiumSandbox: true,
        ignoreDefaultArgs: [
          '--disable-back-forward-cache',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-background-timer-throttling',
        ],
        args: [
          '--window-position=-10000,-10000',
          '--disable-features=CalculateNativeWinOcclusion',
          `--remote-debugging-port=${debugPort}`,
        ],
      });
      nativeBrowser = await chromium.connectOverCDP(
        `http://127.0.0.1:${debugPort}`,
        {
          noDefaults: true,
        },
      );
      const c = nativeBrowser.contexts()[0];
      const p = await c.newPage();
      activePage = p;
      await p.bringToFront();
      await p.addInitScript(() => {
        window.addEventListener('pageshow', (event) => {
          if (event.persisted) window.__sp15Persisted = true;
        });
      });
      await p.goto(`${origin}/browser-away`);
      assert.equal(
        (
          await api(
            p,
            'POST',
            '/auth/login',
            { email: email(ids.employeeAccount), password },
            {},
            false,
          )
        ).status,
        200,
      );
      await p.goto(`${origin}/meine-statistik/2026-12`);
      await p.locator('.statistics-card').nth(2).waitFor({ state: 'attached' });
      const sibling = await c.newPage();
      await sibling.goto(`${origin}/browser-away`);
      await sibling.bringToFront();
      const cdp = await c.newCDPSession(p);
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'minimized' },
      });
      await until(
        async () =>
          await p.evaluate(() => document.visibilityState === 'hidden'),
        'native minimized visibility',
      );
      const hidden = await p.evaluate(
        () => document.visibilityState === 'hidden',
      );
      report.foregroundNativeHidden = hidden;
      if (hidden)
        await until(
          async () =>
            await p.evaluate(
              () => getComputedStyle(document.body).visibility === 'hidden',
            ),
          'visibility event conceals private DOM',
        );
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'normal' },
      });
      await p.bringToFront();
      await p.locator('.statistics-card').nth(2).waitFor();
      await p.goto(`${origin}/browser-away`);
      await pool.query(
        'UPDATE sessions SET revoked_at=clock_timestamp() WHERE account_id=$1',
        [ids.employeeAccount],
      );
      await p
        .goBack({ waitUntil: 'commit', timeout: 5000 })
        .catch(() => assert.match(p.url(), /2026-12$/));
      await p.getByRole('heading', { name: 'Anmelden', exact: true }).waitFor();
      report.bfcachePersisted = await p.evaluate(
        () => window.__sp15Persisted === true,
      );
      report.bfcacheReasons = await p.evaluate(() =>
        performance
          .getEntriesByType('navigation')[0]
          ?.notRestoredReasons?.toJSON(),
      );
      assert.equal(
        report.bfcachePersisted,
        true,
        'actual Chrome persisted pageshow required',
      );
      assert.equal(await p.locator('.statistics-card').count(), 0);
      assert.match(p.url(), /2026-12$/);
      await nativeBrowser.close();
      await nativeDriver.close();
      nativeBrowser = null;
      nativeDriver = null;
      activePage = ep;
    },
  );
  assert.equal(report.pageErrors, 0);
} catch (error) {
  if (activePage)
    await activePage
      .screenshot({ path: resolve(output, 'failure.png'), fullPage: true })
      .catch(() => {});
  console.error(
    error instanceof Error ? error.stack : 'Browser acceptance failed',
  );
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  report.bundleHash = createHash('sha256')
    .update(await readFile(resolve(root, 'apps/frontend/dist/index.html')))
    .digest('hex');
  report.limitations = [
    'No physical Android/iOS devices or Safari; desktop viewport emulation only.',
    'Page scale via CDP and narrow layout, not browser toolbar desktop zoom.',
    'Dispatched persisted lifecycle is distinguished from actual BFCache admission.',
  ];
  await writeFile(
    resolve(output, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  await nativeBrowser?.close();
  await nativeDriver?.close();
  await browser?.close();
  if (frontend) await new Promise((done) => frontend.close(done));
  if (backend && backend.exitCode === null) {
    backend.kill();
    await new Promise((done) => backend.once('exit', done));
  }
  await pool.end();
}
