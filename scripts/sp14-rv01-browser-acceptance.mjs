/** Installed Chrome + built React with controlled HTTPS auth responses.
 * This is frontend/session acceptance, not NestJS/PostgreSQL evidence.
 * No database connection, env-file loading or existing browser profile is used.
 */
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

assert.ok(process.env.SECUREPLAN_PLAYWRIGHT_MODULE);
assert.ok(process.env.SECUREPLAN_BROWSER_OUTPUT_DIR);
const { chromium } = await import(
  pathToFileURL(resolve(process.env.SECUREPLAN_PLAYWRIGHT_MODULE)).href
);
const root = fileURLToPath(new URL('../', import.meta.url)),
  dist = resolve(root, 'apps/frontend/dist');
const output = resolve(process.env.SECUREPLAN_BROWSER_OUTPUT_DIR);
await mkdir(output, { recursive: true });
const a = {
  accountId: '11111111-1111-4111-8111-111111111111',
  companyId: '22222222-2222-4222-8222-222222222222',
  email: 'a@example.invalid',
  role: 'EMPLOYEE',
};
const b = { ...a, accountId: '33333333-3333-4333-8333-333333333333', email: 'b@example.invalid' };
const sessions = new Map();
let fixture;
function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}
async function entered(held) {
  let timeout;
  try {
    await Promise.race([
      held.entered.promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Expected controlled auth request was not received')),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
function gate() {
  return { entered: deferred(), release: deferred() };
}
function json(res, status, body, headers = {}) {
  if (!res.destroyed) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
      ...headers,
    });
    res.end(JSON.stringify(body));
  }
}
const report = {
  kind: 'Controlled HTTPS fixture; real Chrome/React/BroadcastChannel; no Nest or database connections',
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceDirty:
    execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      encoding: 'utf8',
    }).trim() !== '',
  results: [],
  pageErrors: 0,
};
let browser;
const server = createServer(
  {
    key: await readFile(resolve(root, 'infra/tls/localhost-key.pem')),
    cert: await readFile(resolve(root, 'infra/tls/localhost.pem')),
  },
  async (req, res) => {
    try {
      const path = new URL(req.url, 'https://localhost').pathname;
      const cookie = /__Host-secureplan_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      const session = sessions.get(cookie);
      if (path === '/api/v1/auth/login' && req.method === 'POST') {
        let input = '';
        for await (const chunk of req) input += chunk;
        const { email } = JSON.parse(input);
        const principal = email === a.email ? a : email === b.email ? b : null;
        if (!principal) {
          json(res, 401, {});
          return;
        }
        const token = randomBytes(32).toString('base64url'),
          csrf = randomBytes(32).toString('base64url');
        sessions.set(token, { principal, csrf });
        json(res, 200, principal, {
          'X-CSRF-Token': csrf,
          'Set-Cookie': `__Host-secureplan_session=${token}; Path=/; Secure; HttpOnly; SameSite=Lax`,
        });
        return;
      }
      if (path === '/api/v1/me') {
        if (!session) {
          json(res, 401, { code: 'SESSION_REQUIRED' });
          return;
        }
        // Snapshot at request time: later login changes the cookie, not this response.
        const snapshot = {
            ...session.principal,
            companyTimeZone: 'Europe/Berlin',
            currentCompanyMonth: '2026-12-01',
          },
          csrf = session.csrf;
        if (fixture?.armed && req.headers['x-sp14-test-tab'] === 'main') {
          const number = ++fixture.requests;
          const held = number === 1 ? fixture.old : number === 2 ? fixture.fresh : null;
          if (held) {
            held.entered.resolve();
            await held.release.promise;
            if (number === 1 && fixture.oldStatus === 401) {
              json(res, 401, { code: 'SESSION_REVOKED' });
              return;
            }
          }
        }
        json(res, 200, snapshot, { 'X-CSRF-Token': csrf });
        return;
      }
      if (path === '/api/v1/me/monthly-plans') {
        if (!session) {
          json(res, 401, { code: 'SESSION_REQUIRED' });
          return;
        }
        const name = session.principal.accountId === a.accountId ? 'Private Alpha' : 'Private Beta';
        json(res, 200, {
          items: [
            {
              planId: '40000000-0000-4000-8000-000000000001',
              project: { id: '50000000-0000-4000-8000-000000000001', name },
              monthStart: '2026-12-01',
              duties: [
                {
                  dutyId: '60000000-0000-4000-8000-000000000001',
                  dutyDate: '2026-12-03',
                  shiftKind: 'DAY',
                  startsAt: '2026-12-03T05:00:00Z',
                  endsAt: '2026-12-03T17:00:00Z',
                  dutyRole: 'EMPLOYEE',
                  timeZone: 'Europe/Berlin',
                },
              ],
            },
          ],
        });
        return;
      }
      if (path.startsWith('/api/')) {
        json(res, 404, {});
        return;
      }
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
        'Cache-Control': 'no-store',
      });
      res.end(await readFile(file));
    } catch {
      json(res, 500, { code: 'INTERNAL_ERROR' });
    }
  },
);
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `https://localhost:${server.address().port}`;
async function broadcast(page, count = 1) {
  await page.evaluate((count) => {
    const channel = new BroadcastChannel('secureplan-session');
    for (let i = 0; i < count; i++) channel.postMessage({ type: 'signed-in' });
    channel.close();
  }, count);
}
async function login(page, principal) {
  await page.getByLabel('E-Mail-Adresse').fill(principal.email);
  await page.getByLabel('Passwort', { exact: true }).fill('Synthetic browser fixture only');
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
}
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
  report.browser = browser.version();
  for (const same of [false, true])
    for (const oldStatus of [200, 401]) {
      fixture = { armed: false, requests: 0, oldStatus, old: gate(), fresh: gate() };
      const name = `${same ? 'same-account new session' : 'Employee A to B'} / obsolete ${oldStatus}`;
      const result = { name, result: 'FAIL' };
      report.results.push(result);
      const context = await browser.newContext({
        locale: 'de-DE',
        viewport: { width: 1280, height: 900 },
      });
      try {
        const main = await context.newPage(),
          changer = await context.newPage();
        main.on('pageerror', () => report.pageErrors++);
        changer.on('pageerror', () => report.pageErrors++);
        await main.setExtraHTTPHeaders({ 'X-SP14-Test-Tab': 'main' });
        await changer.setExtraHTTPHeaders({ 'X-SP14-Test-Tab': 'changer' });
        await main.addInitScript(() => {
          window.__sessionSignals = 0;
          window.__obsolete = [];
          const descriptor = Object.getOwnPropertyDescriptor(
            BroadcastChannel.prototype,
            'onmessage',
          );
          Object.defineProperty(BroadcastChannel.prototype, 'onmessage', {
            ...descriptor,
            set(handler) {
              descriptor.set.call(
                this,
                handler
                  ? function (event) {
                      handler.call(this, event);
                      if (event.data?.type === 'signed-in') window.__sessionSignals++;
                    }
                  : null,
              );
            },
          });
        });
        await main.goto(`${origin}/mein-monatsplan/2026-12`);
        await changer.goto(`${origin}/mein-monatsplan/2026-12`);
        await changer.getByRole('heading', { name: 'Anmelden', exact: true }).waitFor();
        await login(main, a);
        await main.getByText('Projekt: Private Alpha', { exact: true }).waitFor();
        const oldCookie = (await context.cookies()).find(
          (c) => c.name === '__Host-secureplan_session',
        ).value;
        fixture.armed = true;
        await broadcast(changer);
        await entered(fixture.old);
        await main.getByRole('heading', { name: /^Sitzung wird/, exact: true }).waitFor();
        await main.evaluate(() => {
          window.__watch = new MutationObserver(() => {
            if (
              document.body.textContent.includes('a@example.invalid') ||
              document.body.textContent.includes('Private Alpha')
            )
              window.__obsolete.push('obsolete principal rendered');
          });
          window.__watch.observe(document.body, {
            subtree: true,
            childList: true,
            characterData: true,
          });
        });
        const principal = same ? a : b;
        await login(changer, principal);
        await changer
          .getByText(`Projekt: ${same ? 'Private Alpha' : 'Private Beta'}`, { exact: true })
          .waitFor();
        await main.waitForFunction(() => window.__sessionSignals >= 2);
        await broadcast(changer, 2);
        await main.waitForFunction(() => window.__sessionSignals >= 4);
        assert.equal(
          fixture.requests,
          1,
          'new signals stay single-flight until the old request settles',
        );
        fixture.old.release.resolve();
        await entered(fixture.fresh);
        assert.equal(await main.locator('.duty-card').count(), 0);
        assert.equal(await main.evaluate(() => window.__obsolete.length), 0);
        await main.getByRole('heading', { name: /^Sitzung wird/, exact: true }).waitFor();
        assert.equal(fixture.requests, 2);
        await main.evaluate(() => window.__watch.disconnect());
        fixture.fresh.release.resolve();
        await main
          .getByText(`Projekt: ${same ? 'Private Alpha' : 'Private Beta'}`, { exact: true })
          .waitFor();
        await changer
          .getByText(`Projekt: ${same ? 'Private Alpha' : 'Private Beta'}`, { exact: true })
          .waitFor();
        assert.equal(await main.getByRole('heading', { name: 'Anmelden', exact: true }).count(), 0);
        assert.notEqual(
          (await context.cookies()).find((c) => c.name === '__Host-secureplan_session').value,
          oldCookie,
        );
        await main.screenshot({
          path: resolve(output, `${same ? 'same' : 'different'}-${oldStatus}.png`),
          fullPage: true,
        });
        result.result = 'PASS';
        result.obsoleteRenders = 0;
        result.repeatedSignals = 4;
        result.freshCheckQueued = true;
        result.cookieGenerationChanged = true;
        console.log(`PASS ${name}`);
      } finally {
        fixture.old.release.resolve();
        fixture.fresh.release.resolve();
        await context.close();
      }
    }
  assert.equal(report.pageErrors, 0);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Browser acceptance failed');
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
  report.bundleHash = createHash('sha256')
    .update(await readFile(resolve(dist, 'index.html')))
    .digest('hex');
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
