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
      "INSERT INTO companies(id,name,status,time_zone) VALUES($1,'Synthetic SP17 Acceptance','ACTIVE','Europe/Berlin')",
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
    [ids.project, 'Synthetic SP17 Open'],
    [ids.missingProject, 'Synthetic SP17 Missing'],
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
          /^\/api\/v1\/cancellation-requests\/[^/]+\/withdraw$/.test(req.url);
        if (feature) {
          const chunks = [];
          req.on('data', (chunk) => chunks.push(chunk));
          req.on('end', () =>
            submissions.push({
              path: req.url,
              bodyBytes: Buffer.concat(chunks).length,
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
  const ownSection = () =>
    employeePage.getByRole('region', { name: 'Meine Absagen' });
  const item = (n) =>
    ownSection()
      .getByRole('article')
      .filter({
        has: employeePage.getByRole('heading', {
          name: new RegExp(
            cases[n].duty.dutyDate.split('-').reverse().join('\\.'),
          ),
        }),
      });
  const openWithdrawal = async (n) => {
    await item(n)
      .getByRole('button', { name: 'Absage zurückziehen', exact: true })
      .click();
    await employeePage
      .getByRole('dialog', { name: 'Absage zurückziehen', exact: true })
      .waitFor();
  };
  const confirmWithdrawal = () =>
    employeePage
      .getByRole('button', {
        name: 'Absage verbindlich zurückziehen',
        exact: true,
      })
      .click();
  const audits = async (id) =>
    (
      await pool.query(
        "SELECT action,resource_id,old_values,new_values FROM audit_event WHERE company_id=$1 AND (resource_id=$2 OR resource_id=$3) AND action IN ('CANCELLATION_WITHDRAWN','REPLACEMENT_NEED_CLOSED') ORDER BY action",
        [ids.company, id, cases.find((c) => c.id === id).replacementNeed.id],
      )
    ).rows;
  const bytes = async (id) =>
    (
      await pool.query(
        'SELECT to_jsonb(d)::text AS duty,to_jsonb(a)::text AS assignment FROM duties d JOIN plan_assignments a ON a.company_id=d.company_id AND a.duty_id=d.id WHERE d.id=$1 ORDER BY a.id',
        [id],
      )
    ).rows;
  await step(
    'Chrome reload discovery and German confirmation: focus trap, Escape, retained assignment explanation',
    async () => {
      await employeePage.reload();
      await ownSection()
        .getByRole('button', { name: 'Absage zurückziehen', exact: true })
        .first()
        .waitFor();
      assert.equal(await ownSection().getByRole('article').count(), 4);
      await openWithdrawal(0);
      const dialog = employeePage.getByRole('dialog');
      assert.match(
        await dialog.innerText(),
        /Sie bleiben dem ursprünglichen Dienst zugeteilt/,
      );
      assert.equal(
        await dialog
          .getByRole('button', { name: 'Zurück', exact: true })
          .evaluate((el) => el === document.activeElement),
        true,
      );
      for (let i = 0; i < 5; i++) {
        await employeePage.keyboard.press(i === 0 ? 'Shift+Tab' : 'Tab');
        assert.equal(
          await dialog.evaluate((el) => el.contains(document.activeElement)),
          true,
        );
      }
      await employeePage.keyboard.press('Escape');
      assert.equal(await dialog.count(), 0);
      assert.equal(
        await item(0)
          .getByRole('button', { name: 'Absage zurückziehen', exact: true })
          .evaluate((el) => el === document.activeElement),
        true,
      );
      await employeePage.screenshot({
        path: resolve(output, 'desktop-discovery.png'),
        fullPage: true,
      });
    },
  );
  await step(
    'Chrome double submit: one WITHDRAWN/CLOSED transition; assignment, duty version, statistics and receipts unchanged',
    async () => {
      const before = await bytes(cases[0].duty.id);
      const stats = await api(
        employeePage,
        'GET',
        '/me/planning-statistics?monthStart=2026-12-01',
      );
      const ledger = (
        await pool.query(
          'SELECT to_jsonb(r)::text AS receipt FROM idempotency_records r WHERE company_id=$1 ORDER BY id',
          [ids.company],
        )
      ).rows;
      await openWithdrawal(0);
      const count = submissions.length;
      await employeePage
        .getByRole('button', { name: 'Absage verbindlich zurückziehen' })
        .evaluate((el) => {
          el.click();
          el.click();
        });
      await employeePage
        .getByText('Absage zurückgezogen. Sie bleiben dem Dienst zugeteilt.', {
          exact: true,
        })
        .waitFor();
      assert.equal(submissions.length - count, 1);
      assert.equal(submissions.at(-1).bodyBytes, 0);
      assert.equal((await audits(cases[0].id)).length, 2);
      assert.deepEqual(await bytes(cases[0].duty.id), before);
      assert.deepEqual(
        (
          await api(
            employeePage,
            'GET',
            '/me/planning-statistics?monthStart=2026-12-01',
          )
        ).body,
        stats.body,
      );
      assert.deepEqual(
        (
          await pool.query(
            'SELECT to_jsonb(r)::text AS receipt FROM idempotency_records r WHERE company_id=$1 ORDER BY id',
            [ids.company],
          )
        ).rows,
        ledger,
      );
      await employeePage
        .getByRole('button', { name: 'Schließen', exact: true })
        .click();
      await item(0)
        .getByText('Absage: Zurückgezogen. Ersatzbedarf: Geschlossen.', {
          exact: true,
        })
        .waitFor();
      assert.equal(
        await item(0)
          .getByRole('button', { name: 'Absage zurückziehen', exact: true })
          .count(),
        0,
      );
      assert.equal(
        await ownSection()
          .getByRole('heading', { name: 'Meine Absagen' })
          .evaluate((el) => el === document.activeElement),
        true,
      );
      await employeePage.reload();
      await item(0)
        .getByText('Absage: Zurückgezogen. Ersatzbedarf: Geschlossen.', {
          exact: true,
        })
        .waitFor();
    },
  );
  await step(
    'Chrome truncated committed response: frozen request-ID retry and exactly two mandatory audits',
    async () => {
      fault = 'truncate';
      await openWithdrawal(1);
      const count = submissions.length;
      await confirmWithdrawal();
      await employeePage.getByText(/Das Ergebnis ist noch unklar/).waitFor();
      assert.equal((await audits(cases[1].id)).length, 2);
      await employeePage.screenshot({
        path: resolve(output, 'uncertain-response.png'),
        fullPage: false,
      });
      await employeePage
        .getByRole('button', { name: 'Dieselbe Rücknahme erneut versuchen' })
        .click();
      await employeePage
        .getByText('Absage zurückgezogen. Sie bleiben dem Dienst zugeteilt.', {
          exact: true,
        })
        .waitFor();
      assert.equal(submissions.length - count, 2);
      assert.equal(submissions.at(-1).path, submissions.at(-2).path);
      assert.equal((await audits(cases[1].id)).length, 2);
      await employeePage
        .getByRole('button', { name: 'Schließen', exact: true })
        .click();
      await item(1)
        .getByText('Absage: Zurückgezogen. Ersatzbedarf: Geschlossen.', {
          exact: true,
        })
        .waitFor();
    },
  );
  await step(
    'Chrome stale cancellation after real CR03 DELETE reloads OBSOLETE/CLOSED and offers no withdrawal',
    async () => {
      await openWithdrawal(2);
      const path = `/monthly-plans/${plan}/entries/${cases[2].duty.id}`;
      const lease = await api(page, 'POST', path + '/edit-lease');
      assert.equal(lease.status, 200);
      assert.equal(
        (
          await api(page, 'DELETE', path, null, {
            'Expected-Version': String(own[2].version),
            'Edit-Lease-Token': lease.body.leaseToken,
          })
        ).status,
        204,
      );
      await confirmWithdrawal();
      await employeePage
        .getByText(/Der Antrag kann nicht mehr zurückgezogen werden/)
        .waitFor();
      await employeePage
        .getByRole('button', { name: 'Aktuellen Status laden' })
        .click();
      await item(2)
        .getByText('Absage: Gegenstandslos. Ersatzbedarf: Geschlossen.', {
          exact: true,
        })
        .waitFor();
      assert.equal(
        await item(2)
          .getByRole('button', { name: 'Absage zurückziehen', exact: true })
          .count(),
        0,
      );
      assert.equal(
        (await audits(cases[2].id)).filter(
          (a) => a.action === 'CANCELLATION_WITHDRAWN',
        ).length,
        0,
      );
    },
  );
  await step(
    'Chrome 390px viewport: accessible withdrawal modal, keyboard focus, no horizontal overflow',
    async () => {
      await employeePage.setViewportSize({ width: 390, height: 844 });
      await openWithdrawal(3);
      const dialog = employeePage.getByRole('dialog'),
        bounds = await dialog.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
      assert.equal(
        await employeePage.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
      );
      assert.ok(await dialog.getAttribute('aria-labelledby'));
      assert.ok(await dialog.getAttribute('aria-describedby'));
      await employeePage.screenshot({
        path: resolve(output, 'mobile-withdrawal.png'),
        fullPage: false,
      });
      await employeePage.keyboard.press('Escape');
      assert.equal(
        await item(3)
          .getByRole('button', { name: 'Absage zurückziehen', exact: true })
          .evaluate((el) => el === document.activeElement),
        true,
      );
      await employeePage.setViewportSize({ width: 1440, height: 1000 });
    },
  );
  await step(
    'Chrome private work-items/withdrawal GET, HEAD, CSRF and absent-resource errors',
    async () => {
      for (const method of ['GET', 'HEAD']) {
        const r = await api(
          employeePage,
          method,
          '/me/work-items?monthStart=2026-12-01',
        );
        assert.equal(r.status, 200);
        assert.equal(r.cache, 'private, no-store');
      }
      const missing = await api(
        employeePage,
        'POST',
        `/cancellation-requests/${randomUUID()}/withdraw`,
      );
      assert.equal(missing.status, 404);
      assert.equal(missing.cache, 'private, no-store');
      const csrf = await api(
        employeePage,
        'POST',
        `/cancellation-requests/${cases[3].id}/withdraw`,
        null,
        {},
        false,
      );
      assert.equal(csrf.status, 403);
      assert.equal(csrf.cache, 'private, no-store');
      for (const reply of replies)
        assert.equal(reply.cache, 'private, no-store');
    },
  );
  await step(
    'Chrome delayed withdrawal plus logout/account switch: private UI cleared, late response ignored, owner re-login discovers persisted status',
    async () => {
      let entered, release;
      const seen = new Promise((r) => (entered = r)),
        promise = new Promise((r) => (release = r));
      heldResponse = { entered, promise };
      await openWithdrawal(3);
      await confirmWithdrawal();
      await seen;
      assert.equal((await audits(cases[3].id)).length, 2);
      await api(employeePage, 'POST', '/auth/logout', {});
      await employeePage.goto(`${origin}/mein-monatsplan/2026-12`);
      await employeePage
        .getByRole('heading', { name: 'Anmelden', exact: true })
        .waitFor();
      release();
      await login(employeePage, ids.secondAccount);
      await employeePage.goto(`${origin}/mein-monatsplan/2026-12`);
      await employeePage
        .getByText('Keine Absagen für diesen Monat.', { exact: true })
        .waitFor();
      assert.equal(await ownSection().getByRole('article').count(), 0);
      assert.equal(await employeePage.getByRole('dialog').count(), 0);
      await logoutUi(employeePage);
      await login(employeePage, ids.employeeAccount);
      await employeePage.goto(`${origin}/mein-monatsplan/2026-12`);
      await item(3)
        .getByText('Absage: Zurückgezogen. Ersatzbedarf: Geschlossen.', {
          exact: true,
        })
        .waitFor();
      assert.equal(await ownSection().getByRole('article').count(), 4);
      assert.equal(await employeePage.getByRole('dialog').count(), 0);
      await employeePage.screenshot({
        path: resolve(output, 'relogin-current-status.png'),
        fullPage: true,
      });
    },
  );
  report.persistedBeforeCleanup = {
    requests: cases.length,
    withdrawals: (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE company_id=$1 AND action='CANCELLATION_WITHDRAWN'",
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
