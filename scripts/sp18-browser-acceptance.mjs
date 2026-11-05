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
let backend, frontend, browser, activePage, origin, plan;
let heldResponse = null;
const submissions = [];
const replies = [];
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
      "INSERT INTO companies(id,name,status,time_zone) VALUES($1,'Synthetic SP18 Acceptance','ACTIVE','Europe/Berlin')",
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
    [ids.project, 'Synthetic SP18 Open'],
    [ids.missingProject, 'Synthetic SP18 Missing'],
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
        const feature =
          req.method === 'POST' &&
          /^\/api\/v1\/replacement-needs\/[^/]+\/offers$/.test(req.url);
        if (feature) {
          const chunks = [];
          req.on('data', (chunk) => chunks.push(chunk));
          req.on('end', () =>
            submissions.push({
              path: req.url,
              bodyBytes: Buffer.concat(chunks).length,
              keyHash: createHash('sha256')
                .update(req.headers['idempotency-key'] ?? '')
                .digest('hex'),
            }),
          );
        }
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
              if (feature)
                replies.push({
                  status: reply.statusCode,
                  replayed: reply.headers['idempotency-replayed'],
                  cache: reply.headers['cache-control'],
                });
              if (hold) {
                hold.entered();
                await hold.promise;
              }
              if (res.destroyed) return;
              if (injected) {
                // Discard an actual committed response; this creates real browser uncertainty.
                const complete = Buffer.concat(chunks);
                res.writeHead(reply.statusCode, {
                  ...reply.headers,
                  'content-length': String(complete.length + 1),
                  connection: 'close',
                });
                res.end(complete.subarray(0, 10));
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
  const created = await api(page, 'POST', '/monthly-plans', {
    projectId: ids.project,
    monthStart: '2026-12-01',
  });
  assert.equal(created.status, 201);
  plan = created.body.id;
  const desired = await bodyFor(page);
  for (const i of [3, 4, 5, 6, 7])
    desired.days[i].desired = {
      state: 'DAY',
      role: i === 4 ? 'SHIFT_LEAD' : 'EMPLOYEE',
    };
  assert.equal((await saveApi(page, desired)).status, 200);
  assert.equal(
    (
      await api(page, 'POST', `/monthly-plans/${plan}/publish`, null, {
        'Idempotency-Key': randomUUID(),
      })
    ).status,
    200,
  );
  const employeeContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: 'de-DE',
    ignoreHTTPSErrors: true,
  });
  const employeePage = await employeeContext.newPage();
  activePage = employeePage;
  employeePage.on('pageerror', () => report.pageErrors++);
  await login(employeePage, ids.employeeAccount);
  await employeePage.goto(`${origin}/mein-monatsplan/2026-12`);
  await employeePage.getByRole('article').first().waitFor();
  const own = (
    await api(employeePage, 'GET', '/me/monthly-plans?monthStart=2026-12-01')
  ).body.items[0].duties;
  const cases = [];
  for (const duty of own.slice(0, 4)) {
    const created = await api(
      employeePage,
      'POST',
      '/cancellation-requests',
      { assignmentId: duty.assignmentId },
      {
        'Expected-Version': String(duty.version),
        'Idempotency-Key': randomUUID(),
      },
    );
    assert.equal(created.status, 201);
    cases.push(created.body);
  }
  const candidateContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: 'de-DE',
    timezoneId: 'America/Los_Angeles',
    ignoreHTTPSErrors: true,
  });
  const candidate = await candidateContext.newPage();
  activePage = candidate;
  candidate.on('pageerror', () => report.pageErrors++);
  await login(candidate, ids.secondAccount);
  const go = () => candidate.goto(`${origin}/offene-dienste/2026-12`);
  const card = (n) =>
    candidate
      .getByRole('listitem')
      .filter({
        has: candidate.getByRole('heading', {
          name: new RegExp('Synthetic SP18 Open'),
        }),
      })
      .filter({
        hasText: cases[n].duty.dutyDate.split('-').reverse().join('.'),
      });
  const open = async (n) => {
    await card(n)
      .getByRole('button', { name: 'Als Ersatz anbieten', exact: true })
      .click();
    await candidate.getByRole('dialog').waitFor();
  };
  const send = () =>
    candidate
      .getByRole('button', { name: 'Angebot verbindlich abgeben', exact: true })
      .click();
  await step(
    'Built Chrome eligibility, German saved-zone detail, safe focus and cancellation',
    async () => {
      await go();
      assert.equal(
        (
          await api(
            candidate,
            'GET',
            '/me/replacement-needs?monthStart=2026-12-01',
          )
        ).body.pagination.totalItems,
        4,
      );
      await open(0);
      await candidate
        .getByText(
          'Du gibst ein Ersatzangebot ab. Das ist noch keine feste Einplanung. Das Büro entscheidet über die Übernahme.',
          { exact: true },
        )
        .waitFor();
      assert.equal(
        await candidate
          .getByRole('button', { name: 'Abbrechen' })
          .evaluate((e) => e === document.activeElement),
        true,
      );
      await candidate.keyboard.press('Shift+Tab');
      assert.equal(
        await candidate
          .getByRole('button', { name: 'Angebot verbindlich abgeben' })
          .evaluate((e) => e === document.activeElement),
        true,
      );
      await candidate.keyboard.press('Escape');
      assert.equal(await candidate.getByRole('dialog').count(), 0);
      assert.equal(submissions.length, 0);
    },
  );
  await step(
    'Built Chrome voluntary create, own status, unchanged assignments and duplicate prevention',
    async () => {
      const before = (
        await pool.query('SELECT concurrency_version FROM duties WHERE id=$1', [
          cases[0].duty.id,
        ])
      ).rows[0];
      await open(0);
      await send();
      await candidate
        .getByText(
          'Angebot abgegeben. Du bist noch nicht für diesen Dienst eingeplant.',
          { exact: true },
        )
        .waitFor();
      await candidate.getByRole('button', { name: 'Schließen' }).click();
      await card(0)
        .getByRole('button', { name: 'Angebot bereits abgegeben' })
        .waitFor();
      assert.equal(
        await card(0)
          .getByRole('button', { name: 'Angebot bereits abgegeben' })
          .isDisabled(),
        true,
      );
      assert.deepEqual(
        (
          await pool.query(
            'SELECT concurrency_version FROM duties WHERE id=$1',
            [cases[0].duty.id],
          )
        ).rows[0],
        before,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM plan_assignments WHERE company_id=$1 AND employee_id=$2 AND state='ACTIVE'",
            [ids.company, ids.second],
          )
        ).rows[0].n,
        0,
      );
      await candidate.screenshot({
        path: resolve(output, 'offers-desktop.png'),
        fullPage: true,
      });
    },
  );
  await step(
    'Built Chrome commit acknowledgement loss and exact frozen-key explicit replay',
    async () => {
      fault = 'lost-ack';
      await open(1);
      await send();
      await candidate
        .getByText(
          'Das Ergebnis ist noch unklar. Status prüfen oder denselben Versuch erneut senden.',
          { exact: true },
        )
        .waitFor();
      const first = submissions.at(-1);
      await candidate
        .getByRole('button', { name: 'Denselben Versuch erneut senden' })
        .click();
      await candidate
        .getByText(
          'Angebot abgegeben. Du bist noch nicht für diesen Dienst eingeplant.',
          { exact: true },
        )
        .waitFor();
      assert.equal(submissions.at(-1).keyHash, first.keyHash);
      assert.equal(replies.at(-1).replayed, 'true');
      assert.equal(submissions.at(-1).bodyBytes, 0);
      await candidate.getByRole('button', { name: 'Schließen' }).click();
    },
  );
  await step(
    'Built Chrome reload and relogin recover owned terminal history after actual SP17 closure',
    async () => {
      assert.equal(
        (
          await api(
            employeePage,
            'POST',
            `/cancellation-requests/${cases[0].id}/withdraw`,
          )
        ).status,
        200,
      );
      await candidate.reload();
      await candidate.getByText(/Nicht mehr gültig/).waitFor();
      await logoutUi(candidate);
      await login(candidate, ids.secondAccount);
      await go();
      await candidate.getByText(/Nicht mehr gültig/).waitFor();
      const requester = (
        await api(employeePage, 'GET', '/me/work-items?monthStart=2026-12-01')
      ).body;
      assert.equal(requester.replacementOffers.length, 0);
    },
  );
  await step(
    'Built Chrome 360 and 390 pixel layout, dialog keyboard and saved offset',
    async () => {
      for (const width of [360, 390]) {
        await candidate.setViewportSize({ width, height: 900 });
        await go();
        await card(2).waitFor();
        assert.ok(
          await candidate.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        );
        await open(2);
        assert.ok(
          await candidate
            .getByRole('dialog')
            .evaluate((e) => e.scrollWidth <= e.clientWidth),
        );
        await candidate.screenshot({
          path: resolve(output, `offers-mobile-${width}.png`),
          fullPage: true,
        });
        await candidate.keyboard.press('Escape');
      }
    },
  );
  await step(
    'Built Chrome stale closure, refresh recovery and concealed detail',
    async () => {
      await open(2);
      assert.equal(
        (
          await api(
            employeePage,
            'POST',
            `/cancellation-requests/${cases[2].id}/withdraw`,
          )
        ).status,
        200,
      );
      await send();
      await candidate
        .getByText(
          'Der Dienst ist nicht mehr verfügbar oder deine Voraussetzungen haben sich geändert. Bitte aktualisiere die Liste.',
          { exact: true },
        )
        .waitFor();
      await candidate
        .getByRole('button', { name: 'Liste aktualisieren', exact: true })
        .click();
      assert.equal(await candidate.getByRole('dialog').count(), 0);
      assert.equal(
        (
          await api(
            candidate,
            'GET',
            `/replacement-needs/${cases[2].replacementNeed.id}`,
          )
        ).status,
        404,
      );
    },
  );
  await step(
    'Built Chrome held committed response, logout/account switch, private state clear and owner recovery',
    async () => {
      let entered, release;
      const seen = new Promise((r) => (entered = r)),
        promise = new Promise((r) => (release = r));
      heldResponse = { entered, promise };
      await open(3);
      await send();
      await seen;
      await api(candidate, 'POST', '/auth/logout', {});
      await candidate.goto(`${origin}/offene-dienste/2026-12`);
      await candidate
        .getByRole('heading', { name: 'Anmelden', exact: true })
        .waitFor();
      release();
      await login(candidate, ids.employeeAccount);
      await go();
      await candidate
        .getByText('Noch keine Ersatzangebote in diesem Monat.', {
          exact: true,
        })
        .waitFor();
      assert.equal(await candidate.getByRole('dialog').count(), 0);
      await logoutUi(candidate);
      await login(candidate, ids.secondAccount);
      await go();
      await candidate
        .getByRole('region', { name: 'Meine Ersatzangebote' })
        .getByText(/Offen/)
        .first()
        .waitFor();
      assert.equal(await candidate.getByRole('dialog').count(), 0);
    },
  );
  await step(
    'Built Chrome saved Berlin overnight DST endpoints in a different browser zone',
    async () => {
      const dstPlan = randomUUID(),
        dstDuty = randomUUID(),
        membership = randomUUID();
      for (const person of [ids.employee, ids.second])
        await pool.query(
          "INSERT INTO project_assignments(company_id,employee_id,project_id,planning_month) VALUES($1,$2,$3,'2027-03-01')",
          [ids.company, person, ids.project],
        );
      await pool.query(
        "INSERT INTO monthly_plans(id,company_id,project_id,planning_month,status,published_at,published_by_account_id) VALUES($1,$2,$3,'2027-03-01','PUBLISHED',clock_timestamp(),$4)",
        [dstPlan, ids.company, ids.project, ids.admin],
      );
      await pool.query(
        "INSERT INTO duties(id,company_id,project_id,monthly_plan_id,planning_month,duty_date,shift_kind,starts_at,ends_at,time_zone,config_effective_from_month,start_local,end_local) VALUES($1,$2,$3,$4,'2027-03-01','2027-03-27','NACHT','2027-03-27T17:00:00Z','2027-03-28T04:00:00Z','Europe/Berlin','2026-12-01','18:00','06:00')",
        [dstDuty, ids.company, ids.project, dstPlan],
      );
      await pool.query(
        "INSERT INTO plan_assignments(id,company_id,duty_id,employee_id,duty_function) VALUES($1,$2,$3,$4,'MITARBEITER')",
        [membership, ids.company, dstDuty, ids.employee],
      );
      const created = await api(
        employeePage,
        'POST',
        '/cancellation-requests',
        { assignmentId: membership },
        { 'Expected-Version': '1', 'Idempotency-Key': randomUUID() },
      );
      assert.equal(created.status, 201);
      await candidate.goto(`${origin}/offene-dienste/2027-03`);
      await candidate
        .getByRole('button', { name: 'Als Ersatz anbieten', exact: true })
        .waitFor();
      const text = await candidate.locator('.open-duties__list').innerText();
      for (const expected of [
        '27.03.2027',
        '28.03.2027',
        'GMT+01:00',
        'GMT+02:00',
        'Europe/Berlin',
      ])
        assert.ok(text.includes(expected));
      await candidate.screenshot({
        path: resolve(output, 'offers-overnight-dst.png'),
        fullPage: true,
      });
      const stored = await candidate.evaluate(() => [
        ...Object.values(localStorage),
        ...Object.values(sessionStorage),
      ]);
      assert.ok(
        stored.every(
          (value) =>
            !value.includes('replacementOffers') &&
            !value.includes(created.body.replacementNeed.id),
        ),
      );
    },
  );
  for (const submission of submissions) assert.equal(submission.bodyBytes, 0);
  for (const reply of replies) assert.equal(reply.cache, 'private, no-store');
  report.persistedBeforeCleanup = {
    offers: (
      await pool.query(
        'SELECT count(*)::int AS n FROM replacement_offers WHERE company_id=$1',
        [ids.company],
      )
    ).rows[0].n,
  };
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
    'Installed desktop Google Chrome only; 390px viewport is emulation. Firefox, Edge, Safari and physical devices NOT_RUN.',
  ];
  await writeFile(
    resolve(output, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  await browser?.close();
  if (frontend) await new Promise((done) => frontend.close(done));
  if (backend && backend.exitCode === null) {
    backend.kill();
    await new Promise((done) => backend.once('exit', done));
  }
  await pool.end();
}
