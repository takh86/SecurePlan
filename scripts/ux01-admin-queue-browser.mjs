/** UX-01 layout regression: installed Chrome -> production React build.
 * Contract-shaped synthetic GET stubs isolate layout, keyboard filters and navigation.
 * This does not establish backend authorization or database/business acceptance.
 * Build frontend first; supply external SECUREPLAN_PLAYWRIGHT_MODULE and private
 * SECUREPLAN_BROWSER_OUTPUT_DIR. Optional SECUREPLAN_REPO_ROOT defaults to this repo.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

assert.ok(process.env.SECUREPLAN_PLAYWRIGHT_MODULE, 'Supply the external Playwright module path');
assert.ok(process.env.SECUREPLAN_BROWSER_OUTPUT_DIR, 'Supply a private evidence directory');
const repo = resolve(process.env.SECUREPLAN_REPO_ROOT ?? fileURLToPath(new URL('../', import.meta.url)));
const dist = resolve(repo, 'apps/frontend/dist');
const output = resolve(process.env.SECUREPLAN_BROWSER_OUTPUT_DIR);
await mkdir(output, { recursive: true });
const { chromium } = await import(pathToFileURL(resolve(process.env.SECUREPLAN_PLAYWRIGHT_MODULE)).href);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const asset = resolve(dist, pathname === '/' ? 'index.html' : `.${pathname}`);
    assert.ok(asset.startsWith(dist + sep), 'Path outside frontend build');
    let body, file = asset;
    try { body = await readFile(file); }
    catch { file = resolve(dist, 'index.html'); body = await readFile(file); }
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
server.on('clientError', (_error, socket) => socket.destroy());
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const id = n => `71000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1);
const projectName = 'Synthetischer Sicherheitsdienst Flughafen und Veranstaltungsschutz Nordwest';
const projects = [{ id: projectId, name: projectName, status: 'ACTIVE' }];
const item = {
  type: 'CANCELLATION_REQUEST', cancellationRequestId: id(2), replacementNeedId: id(3),
  duty: { id: id(4), dutyDate: '2026-12-16', shiftKind: 'NIGHT', startsAt: '2026-12-16T17:00:00Z', endsAt: '2026-12-17T05:00:00Z' },
  requestingEmployee: { id: id(5), employeeCode: 'UX-01', firstName: 'Synthetische', lastName: 'Prüfperson' },
  cancellationStatus: 'OPEN', replacementNeedStatus: 'OPEN', openOfferCount: 2, eligibleOpenOfferCount: 1,
  project: { id: projectId, name: projectName }, monthStart: '2026-12-01', timeZone: 'Europe/Berlin', createdAt: '2026-12-15T09:30:00.000Z',
};
const pagination = (totalItems, pageSize = 25) => ({ page: 1, pageSize, totalItems, totalPages: totalItems ? 1 : 0 });
const widths = [320, 375, 390, 768, 1024, 1440];
const report = { kind: 'UX-01 browser layout regression; network-stubbed API, no backend/DB acceptance', browser: null, results: [], pageErrors: [], consoleErrors: [], unexpectedRequests: [] };
let browser;

// Report actual sizing at each layer so an overflow cannot be hidden by clipping the body.
async function geometry(page) {
  return page.evaluate(() => ({
    viewport: innerWidth, document: document.documentElement.scrollWidth,
    layers: ['.shell__main', '.work-queue', '.work-queue__filters', '.work-queue__presence', '.work-queue__controls', '.work-queue__controls label', '.work-queue__controls select'].flatMap(selector =>
      [...document.querySelectorAll(selector)].map(element => {
        const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
        return { selector, width: rect.width, left: rect.left, right: rect.right, scroll: element.scrollWidth,
          minWidth: style.minWidth, columns: style.gridTemplateColumns };
      })),
  }));
}

try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  report.browser = browser.version();
  for (const state of ['empty', 'populated']) {
    for (const width of widths) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'de-DE' });
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      const queueQueries = [];
      page.on('pageerror', error => report.pageErrors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
      await page.route('**/api/**', async route => {
        const req = route.request(), url = new URL(req.url());
        const json = (body, headers = {}) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store', ...headers }, body: JSON.stringify(body) });
        if (req.method() === 'GET' && url.pathname === '/api/v1/me') return json({
          accountId: id(6), companyId: id(7), email: 'ux01-admin@secureplan.test', role: 'COMPANY_ADMIN',
          companyTimeZone: 'Europe/Berlin', currentCompanyMonth: '2026-12-01',
        }, { 'x-csrf-token': 'c'.repeat(43) });
        if (req.method() === 'GET' && url.pathname === '/api/v1/projects') return json({ items: projects, pagination: pagination(1, 100) });
        if (req.method() === 'GET' && url.pathname === '/api/v1/admin/work-queue') {
          queueQueries.push(Object.fromEntries(url.searchParams));
          return json({ items: state === 'empty' ? [] : [item], pagination: pagination(state === 'empty' ? 0 : 1), evaluatedAt: '2026-12-15T10:00:00.000Z' });
        }
        report.unexpectedRequests.push({ method: req.method(), path: url.pathname });
        return route.fulfill({ status: 404, contentType: 'application/problem+json', body: JSON.stringify({ code: 'RESOURCE_NOT_FOUND' }) });
      });
      const result = { state, width, result: 'FAIL' };
      try {
        await page.goto(`${origin}/arbeitsuebersicht`);
        const project = page.getByRole('combobox', { name: 'Projekt', exact: true });
        await project.getByRole('option', { name: projectName, exact: true }).waitFor({ state: 'attached' });
        if (state === 'empty') await page.getByText('Keine offenen Vorgänge', { exact: true }).waitFor();
        else await page.getByRole('rowheader', { name: /Synthetische Prüfperson/ }).waitFor();
        result.beforeSelection = await geometry(page);
        await page.screenshot({ path: resolve(output, `${state}-${width}.png`), fullPage: true });
        assert.ok(result.beforeSelection.document <= width + 1, `document ${result.beforeSelection.document}px exceeds ${width}px`);
        for (const layer of result.beforeSelection.layers) {
          assert.ok(layer.left >= -1 && layer.right <= width + 1, `${layer.selector} outside viewport`);
        }
        // Real keyboard changes on the native select must retain focus and submit the same filter.
        await project.focus();
        assert.equal(await project.inputValue(), '', 'Starts with all projects');
        const filteredResponse = page.waitForResponse(response => {
          const url = new URL(response.url());
          return url.pathname === '/api/v1/admin/work-queue' && url.searchParams.get('projectId') === projectId;
        });
        await page.keyboard.press('ArrowDown');
        await filteredResponse;
        await page.waitForFunction(id => new URL(location.href).searchParams.get('projectId') === id, projectId);
        await page.waitForFunction(({ id, value }) => document.getElementById(id)?.value === value,
          { id: await project.getAttribute('id'), value: projectId });
        assert.equal(await project.inputValue(), projectId);
        assert.equal(await project.locator('option:checked').textContent(), projectName, 'Full option name is retained');
        assert.ok(queueQueries.some(query => query.projectId === projectId && query.page === '1'), 'Server filter request');
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        assert.equal(await project.evaluate(element => element === document.activeElement), true, 'Focus returns to select');
        const focus = await project.evaluate(element => {
          const style = getComputedStyle(element), rect = element.getBoundingClientRect();
          return { visible: element.matches(':focus-visible'), outline: style.outlineStyle,
            extent: parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset), left: rect.left, right: rect.right };
        });
        assert.ok(focus.visible && focus.outline !== 'none', 'Keyboard focus indicator');
        assert.ok(focus.left - focus.extent >= 0 && focus.right + focus.extent <= width, 'Focus fits viewport');
        result.afterSelection = await geometry(page);
        assert.ok(result.afterSelection.document <= width + 1, 'Selected long name must also fit');
        if (width === 320) await page.screenshot({ path: resolve(output, `${state}-${width}-selected-focus.png`), fullPage: true });
        // Preserve meaningful project text in populated rows; allow intentional local table scrolling.
        if (state === 'populated') assert.equal(await page.locator('td[data-label="Projekt"]').textContent(), projectName);
        await page.reload();
        await project.getByRole('option', { name: projectName, exact: true }).waitFor({ state: 'attached' });
        assert.equal(await project.inputValue(), projectId, 'Project filter survives reload');
        assert.ok((await geometry(page)).document <= width + 1, 'Restored filter still fits');
        if (width < 960) await page.getByRole('button', { name: 'Menü', exact: true }).click();
        await page.getByRole('link', { name: 'Projekte & Zuordnungen', exact: true }).click();
        await page.getByRole('heading', { level: 1, name: 'Projekte & Zuordnungen', exact: true }).waitFor();
        if (width < 960) await page.getByRole('button', { name: 'Menü', exact: true }).click();
        await page.getByRole('link', { name: 'Arbeitsübersicht', exact: true }).click();
        await project.getByRole('option', { name: projectName, exact: true }).waitFor({ state: 'attached' });
        assert.ok((await geometry(page)).document <= width + 1, 'Queue still fits after admin navigation');
        result.result = 'PASS';
      } catch (error) {
        result.error = error.message.slice(0, 500);
      } finally {
        report.results.push(result);
        console.log(`${result.result} ${state} ${width}px${result.error ? `: ${result.error}` : ''}`);
        await context.close();
      }
    }
  }
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
assert.equal(report.results.length, 12, 'Both states at all six viewport widths');
assert.deepEqual(report.pageErrors, [], 'No uncaught application errors');
assert.deepEqual(report.consoleErrors, [], 'No browser console errors');
assert.deepEqual(report.unexpectedRequests, [], 'No mutations or unexpected API requests');
assert.ok(report.results.every(result => result.result === 'PASS'), 'UX-01 regression failed; see report.json');
