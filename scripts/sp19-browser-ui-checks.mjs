/**
 * SP-19 browser UI checks: real installed Chrome -> built React frontend.
 * The API is answered by network-level stubs (contract-shaped payloads), so this is NOT
 * backend/PostgreSQL acceptance. It records every request, asserts the exact parameters the
 * browser sends, and injects controlled failures. Evidence contains no credentials.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = resolve(process.env.SECUREPLAN_REPO_ROOT);
const dist = join(repo, 'apps', 'frontend', 'dist');
const output = resolve(process.env.SECUREPLAN_BROWSER_OUTPUT_DIR);
await mkdir(output, { recursive: true });
const { chromium } = await import(pathToFileURL(resolve(process.env.SECUREPLAN_PLAYWRIGHT_MODULE)).href);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = normalize(join(dist, path === '/' ? 'index.html' : path));
  if (!file.startsWith(dist + sep)) { res.writeHead(403).end(); return; }
  let body;
  try {
    body = await readFile(file);
  } catch {
    body = null;
  }
  if (body) {
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } else {
    // SPA fallback for client routes.
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(await readFile(join(dist, 'index.html')));
  }
});
// Prevents a stray socket error from masking the real assertion failure.
server.on('clientError', (_error, socket) => socket.destroy());
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------------------
// Synthetic contract-shaped payloads (names, places and times are invented).
// ---------------------------------------------------------------------------
const uuid = (n, block = '71') => `${block}000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ADMIN = { accountId: uuid(1, '70'), companyId: uuid(2, '70'), email: 'admin@secureplan.test', role: 'COMPANY_ADMIN' };
const EMPLOYEE = { accountId: uuid(3, '70'), companyId: uuid(2, '70'), email: 'mitarbeitende@secureplan.test', role: 'EMPLOYEE' };
const CSRF = 'c'.repeat(43);
const PROJECT_NORD = uuid(0x40);
const PROJECT_SUED = uuid(0x41);
const HIDDEN_PROJECT = uuid(0x99);
const EVALUATED = '2026-12-15T10:00:00.000Z';

const night = { id: uuid(0x100), dutyDate: '2026-12-16', shiftKind: 'NIGHT', startsAt: '2026-12-16T17:00:00Z', endsAt: '2026-12-17T05:00:00Z' };
const day = { id: uuid(0x101), dutyDate: '2026-12-18', shiftKind: 'DAY', startsAt: '2026-12-18T05:00:00Z', endsAt: '2026-12-18T17:00:00Z' };
const cancellationOne = { type: 'CANCELLATION_REQUEST', cancellationRequestId: uuid(0x200), replacementNeedId: uuid(0x300), duty: night,
  requestingEmployee: { id: uuid(0x500), employeeCode: 'P-100', firstName: 'Testperson', lastName: 'Eins' },
  cancellationStatus: 'OPEN', replacementNeedStatus: 'OPEN', openOfferCount: 2, eligibleOpenOfferCount: 1,
  project: { id: PROJECT_NORD, name: 'Testprojekt Nord' }, monthStart: '2026-12-01', timeZone: 'Europe/Berlin', createdAt: '2026-12-15T09:30:00.000Z' };
const replacementTwo = { type: 'REPLACEMENT_NEED', cancellationRequestId: uuid(0x201), replacementNeedId: uuid(0x301), duty: day,
  requestingEmployee: { id: uuid(0x501), employeeCode: 'P-200', firstName: 'Testperson', lastName: 'Zwei' },
  cancellationStatus: 'APPROVED', replacementNeedStatus: 'OPEN_UNFILLED', openOfferCount: 0, eligibleOpenOfferCount: 0,
  project: { id: PROJECT_SUED, name: 'Testprojekt Süd' }, monthStart: '2026-12-01', timeZone: 'Europe/Berlin', createdAt: '2026-12-14T08:00:00.000Z' };

const offers = [
  { id: uuid(0x600), needId: uuid(0x300), employee: { id: uuid(0x601), employeeCode: 'O-201', firstName: 'Erika', lastName: 'Erste' }, status: 'OPEN', createdAt: '2026-12-15T10:00:00.000Z', decidedAt: null, reviewEligibility: 'ELIGIBLE' },
  { id: uuid(0x602), needId: uuid(0x300), employee: { id: uuid(0x603), employeeCode: 'O-202', firstName: 'Max', lastName: 'Zweiter' }, status: 'OPEN', createdAt: '2026-12-15T10:01:00.000Z', decidedAt: null, reviewEligibility: 'INELIGIBLE' },
  { id: uuid(0x604), needId: uuid(0x300), employee: { id: uuid(0x605), employeeCode: 'O-203', firstName: 'Lena', lastName: 'Dritte' }, status: 'WITHDRAWN', createdAt: '2026-12-15T10:02:00.000Z', decidedAt: '2026-12-15T10:03:00.000Z', reviewEligibility: 'NOT_APPLICABLE' },
];
const context = (overrides = {}) => ({
  cancellation: { id: uuid(0x200), assignmentId: uuid(0x700), employee: cancellationOne.requestingEmployee, duty: night, status: 'OPEN', createdAt: '2026-12-15T09:30:00.000Z', decidedAt: null,
    replacementNeed: { id: uuid(0x300), status: 'OPEN', resolvedAt: null } },
  need: { id: uuid(0x300), cancellationRequestId: uuid(0x200), duty: night, status: 'OPEN', resolvedAt: null, openOfferCount: 2, project: { id: PROJECT_NORD, name: 'Testprojekt Nord' }, timeZone: 'Europe/Berlin' },
  monthStart: '2026-12-01', dutyRemoved: false, originalAssignmentActive: true, eligibleOpenOfferCount: 1, evaluatedAt: EVALUATED, ...overrides });

const pagination = (totalItems, page = 1, pageSize = 25) => ({ page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) });
const rowsFor = (count, prefix = 'Massendaten') => Array.from({ length: count }, (_, i) => ({
  ...cancellationOne, replacementNeedId: uuid(0x1000 + i), cancellationRequestId: uuid(0x2000 + i), requestingEmployee: { ...cancellationOne.requestingEmployee, lastName: `${prefix} ${i + 1}` } }));

// ---------------------------------------------------------------------------
// Scenario state the stub answers from.
// ---------------------------------------------------------------------------
const state = { identity: ADMIN, queue: null, offers: null, projects: null, mutations: [], requests: [] };
const resetState = () => {
  state.identity = ADMIN;
  state.queue = (q) => ({ items: [cancellationOne, replacementTwo], pagination: pagination(2, Number(q.get('page') ?? 1)), evaluatedAt: EVALUATED });
  state.offers = (id, q) => {
    const status = q.get('status');
    const list = status ? offers.filter((o) => o.status === status) : offers;
    return { items: list, pagination: pagination(list.length, Number(q.get('page') ?? 1)), context: context() };
  };
  state.projects = () => ({ items: [{ id: PROJECT_NORD, name: 'Testprojekt Nord', status: 'ACTIVE' }, { id: PROJECT_SUED, name: 'Testprojekt Süd', status: 'INACTIVE' }], pagination: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 } });
};
const json = (route, status, body, extra = {}) => route.fulfill({ status, contentType: 'application/json', headers: { 'cache-control': 'no-store', ...extra }, body: JSON.stringify(body) });
const problem = (route, status, code) => route.fulfill({ status, contentType: 'application/problem+json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify({ code }) });

async function answer(route) {
  const url = new URL(route.request().url());
  const method = route.request().method();
  state.requests.push({ method, path: url.pathname, search: url.search });
  if (method !== 'GET') { state.mutations.push(`${method} ${url.pathname}`); return problem(route, 405, 'ACTION_FORBIDDEN'); }
  if (url.pathname === '/api/v1/me') {
    if (!state.identity) return problem(route, 401, 'SESSION_REQUIRED');
    return json(route, 200, { ...state.identity, companyTimeZone: 'Europe/Berlin', currentCompanyMonth: '2026-12-01' }, { 'x-csrf-token': CSRF });
  }
  if (url.pathname === '/api/v1/admin/work-queue') {
    const forced = state.queueOverride?.(url.searchParams);
    if (forced) return forced(route);
    return json(route, 200, state.queue(url.searchParams));
  }
  const offersMatch = url.pathname.match(/^\/api\/v1\/replacement-needs\/([^/]+)\/offers$/);
  if (offersMatch) {
    const forced = state.offersOverride?.(offersMatch[1], url.searchParams);
    if (forced) return forced(route);
    return json(route, 200, state.offers(offersMatch[1], url.searchParams));
  }
  if (url.pathname === '/api/v1/projects') {
    const forced = state.projectsOverride?.(url.searchParams);
    if (forced) return forced(route);
    return json(route, 200, state.projects());
  }
  return problem(route, 404, 'RESOURCE_NOT_FOUND');
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context_ = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'de-DE', timezoneId: 'America/Los_Angeles' });
const page = await context_.newPage();
const consoleErrors = [];
let pageErrors = 0;
page.on('pageerror', () => { pageErrors += 1; });
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
await page.route('**/api/**', answer);

const results = [];
async function check(id, description, work) {
  const started = Date.now();
  try {
    await work();
    results.push({ id, description, result: 'PASS', ms: Date.now() - started });
    console.log(`PASS ${id} ${description}`);
  } catch (error) {
    results.push({ id, description, result: 'FAIL', detail: String(error.message ?? error).slice(0, 400) });
    console.log(`FAIL ${id} ${description}: ${String(error.message ?? error).slice(0, 300)}`);
    await page.screenshot({ path: join(output, `${id}-failure.png`), fullPage: true }).catch(() => {});
  }
}
const shot = (name) => page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
const go = async (path) => { state.requests = []; await page.goto(`${origin}${path}`); };
const reqs = () => state.requests.filter((r) => r.path.startsWith('/api/v1/admin') || r.path.startsWith('/api/v1/replacement'));
async function waitFor(predicate, label, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!(await predicate())) { assert.ok(Date.now() < end, `timeout: ${label}`); await new Promise((r) => setTimeout(r, 100)); }
}

// ---------------------------------------------------------------------------
resetState();

await check('UI-01', 'administrator lands on the live queue; no synthetic preview text; read requests only', async () => {
  await go('/arbeitsuebersicht');
  await page.getByRole('heading', { level: 1, name: 'Arbeitsübersicht' }).waitFor();
  await page.getByRole('rowheader', { name: /Testperson Eins/ }).waitFor();
  const text = await page.locator('body').innerText();
  for (const fragment of ['Demodaten', 'VORSCHAU', 'Alex Beispiel', 'Beispielzeit']) assert.ok(!text.includes(fragment), `preview text: ${fragment}`);
  assert.ok(state.requests.some((r) => r.path === '/api/v1/admin/work-queue'), 'queue requested');
  assert.deepEqual(state.mutations, []);
  await shot('UI-01-queue-desktop');
});

await check('UI-02', 'queue values and overnight time in the saved zone (browser zone America/Los_Angeles)', async () => {
  const row = page.getByRole('row').filter({ hasText: 'Testperson Eins' });
  const cells = await row.evaluate((tr) => Object.fromEntries([...tr.querySelectorAll('td')].map((td) => [td.dataset.label, td.textContent.trim()])));
  assert.equal(cells['Offene Angebote'], '2');
  assert.equal(cells['Aktuell geeignet'], '1');
  const dienst = await row.locator('td[data-label="Dienst"]').innerText();
  assert.ok(dienst.includes('Nachtdienst'), dienst);
  assert.ok(dienst.includes('18:00 – 06:00 (Do, 17.12.2026)'), `saved-zone time: ${dienst}`);
  assert.ok(dienst.includes('Zeitzone Europe/Berlin'), dienst);
  assert.ok((await row.innerText()).includes('Mi, 16.12.2026'), 'duty date');
  const created = await row.locator('td[data-label="Angelegt"]').innerText();
  assert.ok(created.endsWith('UTC'), created);
});

await check('UI-03', 'open case shows ELIGIBLE / INELIGIBLE / NOT_APPLICABLE as text, separate counts, no decision controls', async () => {
  await page.getByRole('link', { name: 'Vorgang öffnen für Testperson Eins' }).click();
  await page.getByRole('heading', { level: 1, name: 'Vorgang prüfen' }).waitFor();
  const table = page.getByRole('table', { name: 'Eingereichte Ersatzangebote' });
  await table.waitFor();
  const rows = await table.locator('tbody tr').allInnerTexts();
  assert.equal(rows.length, 3);
  assert.ok(rows[0].includes('Aktuell geeignet') && rows[1].includes('Aktuell nicht geeignet') && rows[2].includes('Nicht anwendbar'), rows.join(' | '));
  const counts = await page.locator('section').filter({ hasText: 'Ersatzangebote' }).first().innerText();
  assert.ok(counts.includes('Offene Angebote') && counts.includes('Davon aktuell geeignet'), counts);
  const buttons = await page.getByRole('button').allInnerTexts();
  for (const label of buttons) assert.ok(!/Genehmig|Ablehn|Auswähl|Zuweis|Bestätig|Speicher|Absage/i.test(label), `decision control: ${label}`);
  assert.deepEqual(state.mutations, []);
  await shot('UI-03-case-desktop');
});

await check('UI-04', 'filters, sorting and pagination send the documented server parameters; refresh keeps URL state', async () => {
  await go('/arbeitsuebersicht');
  // Navigation via the router settles after the click; check the settled state, not the instant after the click.
  const eligibleRadio = page.getByRole('radio', { name: 'Mit aktuell geeigneten Angeboten' });
  await eligibleRadio.click();
  await waitFor(async () => (await eligibleRadio.isChecked()) && new URL(page.url()).searchParams.get('offerPresence') === 'WITH_ELIGIBLE', `offer filter settled: ${page.url()}`);
  await waitFor(() => reqs().some((r) => r.search.includes('offerPresence=WITH_ELIGIBLE') && r.search.includes('page=1')), 'offer filter request');
  await page.getByLabel('Vorgangsart').selectOption('REPLACEMENT_NEED');
  await waitFor(() => reqs().some((r) => r.search.includes('type=REPLACEMENT_NEED')), 'type request');
  await page.getByLabel('Projekt').selectOption({ label: 'Testprojekt Süd' });
  await waitFor(() => reqs().some((r) => r.search.includes(`projectId=${PROJECT_SUED}`)), 'project request');
  await page.getByLabel('Sortieren nach').selectOption('dutyDate');
  await page.getByLabel('Reihenfolge').selectOption('desc');
  await waitFor(() => reqs().some((r) => r.search.includes('sortBy=dutyDate') && r.search.includes('sortOrder=desc')), 'sort request');
  await page.getByLabel('Dienstmonat').fill('2026-12');
  await waitFor(() => reqs().some((r) => r.search.includes('monthStart=2026-12-01')), 'month request');
  const url = new URL(page.url());
  assert.equal(url.searchParams.get('month'), '2026-12');
  await page.reload();
  await page.getByRole('heading', { level: 1, name: 'Arbeitsübersicht' }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('projectId'), PROJECT_SUED, 'URL state survives refresh');
  assert.equal(await page.getByRole('radio', { name: 'Mit aktuell geeigneten Angeboten' }).isChecked(), true);
  assert.deepEqual(state.mutations, []);
});

await check('UI-04b', 'pagination: next/previous page requests, page count, empty page beyond the last page, back to page one', async () => {
  state.queue = (q) => {
    const page = Number(q.get('page') ?? 1);
    const all = rowsFor(30);
    return { items: page === 1 ? all.slice(0, 25) : page === 2 ? all.slice(25) : [], pagination: pagination(30, page), evaluatedAt: EVALUATED };
  };
  await go('/arbeitsuebersicht');
  await page.getByText('Seite 1 von 2', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Nächste Seite' }).click();
  await page.getByText('Seite 2 von 2', { exact: true }).waitFor();
  assert.ok(reqs().some((r) => r.search.includes('page=2')), 'page 2 requested');
  await page.getByRole('button', { name: 'Vorherige Seite' }).click();
  await page.getByText('Seite 1 von 2', { exact: true }).waitFor();
  await go('/arbeitsuebersicht?page=3');
  await page.getByText('Diese Seite ist leer').waitFor();
  await page.getByRole('button', { name: 'Zur ersten Seite' }).click();
  await page.getByRole('table').waitFor();
  assert.ok(new URL(page.url()).searchParams.get('page') === null, 'page one has no page parameter');
  resetState();
});

await check('UI-05', 'case changed while open: refresh shows the authoritative state and the closed case is not pending', async () => {
  await go(`/arbeitsuebersicht/${uuid(0x300)}`);
  await page.getByRole('heading', { name: 'Vorgangsstatus' }).waitFor();
  assert.ok(!(await page.locator('body').innerText()).includes('nicht mehr offen'), 'open case has no closed note');
  state.offersOverride = null;
  state.offers = () => ({ items: [], pagination: pagination(0), context: context({
    cancellation: { ...context().cancellation, status: 'WITHDRAWN', decidedAt: '2026-12-15T11:00:00.000Z', replacementNeed: { id: uuid(0x300), status: 'CLOSED', resolvedAt: null } },
    need: { ...context().need, status: 'CLOSED' }, originalAssignmentActive: false, eligibleOpenOfferCount: 0 }) });
  await page.getByRole('button', { name: 'Ansicht aktualisieren' }).click();
  await page.getByRole('note').waitFor();
  assert.ok((await page.getByRole('note').innerText()).includes('nicht mehr offen'));
  await go('/arbeitsuebersicht');
  await page.getByRole('heading', { level: 1, name: 'Arbeitsübersicht' }).waitFor();
  resetState();
  state.queue = (q) => ({ items: [replacementTwo], pagination: pagination(1), evaluatedAt: EVALUATED });
  await page.getByRole('button', { name: 'Liste aktualisieren' }).click();
  await waitFor(async () => !(await page.locator('body').innerText()).includes('Testperson Eins'), 'withdrawn case gone from queue');
  resetState();
});

await check('UI-06', 'EMPLOYEE gets no administrative request; invalid and unknown case ids are safe', async () => {
  state.identity = EMPLOYEE;
  await go('/arbeitsuebersicht');
  await page.getByRole('heading', { name: 'Kein Zugriff auf diese Ansicht' }).waitFor();
  assert.equal(reqs().length, 0, 'no admin request for employee view');
  resetState();
  await go('/arbeitsuebersicht/not-a-uuid');
  await page.getByRole('alert').filter({ hasText: 'Vorgang nicht verfügbar' }).waitFor();
  assert.equal(reqs().filter((r) => r.path.includes('offers')).length, 0, 'no request for malformed id');
  resetState();
});

await check('UI-07a', 'network interruption shows a safe error and retry recovers', async () => {
  let failures = 1;
  state.queueOverride = () => (route) => {
    if (failures > 0) { failures -= 1; return route.abort('internetdisconnected'); }
    return json(route, 200, state.queue(new URL(route.request().url()).searchParams));
  };
  await go('/arbeitsuebersicht');
  const alert = page.getByRole('alert').filter({ hasText: 'Verbindung fehlgeschlagen' });
  await alert.waitFor();
  await alert.getByRole('button', { name: 'Erneut versuchen' }).click();
  await page.getByRole('table').waitFor();
  state.queueOverride = null;
});

await check('UI-07b', 'API 401 leaves the protected view (sign-in form), API 403 denies and revalidates the session', async () => {
  state.queueOverride = () => (route) => problem(route, 401, 'SESSION_REVOKED');
  await go('/arbeitsuebersicht');
  await page.getByRole('heading', { name: 'Anmelden', exact: true }).waitFor();
  assert.equal(await page.getByRole('navigation', { name: 'Hauptnavigation' }).count(), 0);
  state.queueOverride = null;
  resetState();
  state.queueOverride = () => (route) => problem(route, 403, 'ACTION_FORBIDDEN');
  await go('/arbeitsuebersicht');
  await page.getByRole('alert').filter({ hasText: 'Kein Zugriff' }).waitFor();
  // Regression for the request loop found in this run: a 403 must not remount the page and re-request.
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(state.requests.filter((r) => r.path === '/api/v1/admin/work-queue').length, 1, 'exactly one queue request after 403');
  state.queueOverride = null;
  resetState();
});

await check('UI-07c', 'API 404 for a hidden project filter gives a neutral message and a way out; unknown case gives unavailable', async () => {
  state.queueOverride = (q) => (q.get('projectId') ? (route) => problem(route, 404, 'RESOURCE_NOT_FOUND') : null);
  await go(`/arbeitsuebersicht?projectId=${HIDDEN_PROJECT}`);
  await page.getByRole('alert').filter({ hasText: 'Projekt nicht verfügbar' }).waitFor();
  await page.getByRole('button', { name: 'Projektfilter entfernen' }).click();
  await waitFor(() => !new URL(page.url()).searchParams.has('projectId') && reqs().slice(-1)[0]?.search === '?page=1&pageSize=25&sortBy=createdAt&sortOrder=asc', 'project filter removed');
  state.queueOverride = null;
  state.offersOverride = () => (route) => problem(route, 404, 'RESOURCE_NOT_FOUND');
  await go(`/arbeitsuebersicht/${uuid(0x9999)}`);
  await page.getByRole('alert').filter({ hasText: 'Vorgang nicht verfügbar' }).waitFor();
  assert.ok(!(await page.locator('body').innerText()).includes('Vorgangsstatus'), 'no case data on 404');
  state.offersOverride = null;
  resetState();
});

await check('UI-07d', 'invalid response and impossible timestamp are rejected without a page error', async () => {
  const errorsBefore = pageErrors;
  state.queueOverride = () => (route) => json(route, 200, { items: [{ unexpected: true }], pagination: pagination(1), evaluatedAt: EVALUATED });
  await go('/arbeitsuebersicht');
  await page.getByRole('alert').filter({ hasText: 'Antwort konnte nicht verarbeitet werden' }).waitFor();
  state.queueOverride = () => (route) => json(route, 200, { items: [{ ...cancellationOne, createdAt: '2026-13-01T10:00:00.000Z' }], pagination: pagination(1), evaluatedAt: EVALUATED });
  await go('/arbeitsuebersicht');
  await page.getByRole('alert').filter({ hasText: 'Antwort konnte nicht verarbeitet werden' }).waitFor();
  assert.equal(pageErrors, errorsBefore, 'no uncaught page error (P2-01 regression in the browser)');
  state.queueOverride = null;
  resetState();
});

await check('UI-07e', 'empty company shows the empty state; project list failure offers a retry', async () => {
  state.queue = () => ({ items: [], pagination: pagination(0), evaluatedAt: EVALUATED });
  await go('/arbeitsuebersicht');
  await page.getByText('Keine offenen Vorgänge').waitFor();
  resetState();
  let projectCalls = 0;
  state.projectsOverride = () => (route) => { projectCalls += 1; if (projectCalls === 1) return route.abort('internetdisconnected'); return json(route, 200, state.projects()); };
  await go('/arbeitsuebersicht');
  await page.getByRole('button', { name: 'Projektliste erneut laden' }).click();
  await page.getByRole('combobox', { name: 'Projekt' }).locator('option', { hasText: 'Testprojekt Süd' }).waitFor({ state: 'attached' });
  assert.equal(projectCalls, 2);
  state.projectsOverride = null;
});

await check('UI-07f', 'case page: page beyond the last one keeps the status filter and returns to page one', async () => {
  state.offers = (id, q) => (q.get('page') === '3'
    ? { items: [], pagination: pagination(2, 3), context: context() }
    : { items: offers.filter((o) => o.status === 'OPEN'), pagination: pagination(2, 1), context: context() });
  await go(`/arbeitsuebersicht/${uuid(0x300)}?status=OPEN&page=3`);
  await page.getByText('Diese Seite ist leer').waitFor();
  await page.getByRole('button', { name: 'Zur ersten Seite' }).click();
  await page.getByRole('table', { name: 'Eingereichte Ersatzangebote' }).waitFor();
  assert.ok(new URL(page.url()).searchParams.get('status') === 'OPEN', 'status kept');
  resetState();
});

await check('UI-08a', 'keyboard: links receive visible focus; no horizontal page scroll at 390px; table rows labelled', async () => {
  await go('/arbeitsuebersicht');
  await page.getByRole('link', { name: 'Vorgang öffnen für Testperson Eins' }).focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const focus = await page.evaluate(() => {
    const el = document.activeElement;
    const style = getComputedStyle(el);
    return { text: el.textContent.trim(), outline: style.outlineStyle, width: style.outlineWidth, visible: el.matches(':focus-visible') };
  });
  assert.equal(focus.visible, true, JSON.stringify(focus));
  assert.notEqual(focus.outline, 'none', JSON.stringify(focus));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole('table').waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `horizontal page overflow ${overflow}px`);
  const labelled = await page.locator('td[data-label]').count();
  assert.ok(labelled > 0, 'mobile cells labelled');
  await shot('UI-08a-queue-mobile-390');
  await page.setViewportSize({ width: 1440, height: 1000 });
});

await check('UI-08b', 'console: no uncaught page errors during the run; console error categories recorded', async () => {
  assert.equal(pageErrors, 0, `uncaught page errors: ${pageErrors}`);
});

await browser.close();
server.close();
const categories = consoleErrors.reduce((acc, text) => { const key = text.startsWith('Failed to load resource') ? 'failed-resource (expected from injected faults)' : 'other'; acc[key] = (acc[key] ?? 0) + 1; return acc; }, {});
const report = { kind: 'sp19-ui-stub-checks', notAcceptance: 'Backend, PostgreSQL and authorization are NOT exercised: API responses are network stubs.', browser: 'Google Chrome (channel chrome) via Playwright', origin: 'loopback static build', results, pageErrors, consoleErrorCategories: categories, mutationsAttempted: state.mutations };
await writeFile(join(output, 'ui-stub-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: results.filter((r) => r.result === 'PASS').length, failed: results.filter((r) => r.result === 'FAIL').length, pageErrors, categories }));
process.exitCode = results.some((r) => r.result === 'FAIL') ? 1 : 0;
