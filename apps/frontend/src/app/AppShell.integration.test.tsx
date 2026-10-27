// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/"}
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import App from '../App';
import type { IdentityContext } from '../features/auth/auth-api';
import type { TenantRole } from './routes';

const CSRF = 'c'.repeat(43);
const ALLOWED_REQUESTS = new Set(['/api/v1/me', '/api/v1/auth/login', '/api/v1/auth/logout']);
// Text that only exists inside the authenticated shell or its preview views.
const PROTECTED_TEXT = [
  'Hauptnavigation',
  'Arbeitsübersicht',
  'Mein Monatsplan',
  'Demodaten',
  'Demo-Objekt',
  'Beispielzeit',
  'Alex Beispiel',
  'Angemeldet als',
];

const IDENTITIES: Record<TenantRole, IdentityContext> = {
  COMPANY_ADMIN: {
    accountId: '11111111-1111-4111-8111-111111111111',
    companyId: '22222222-2222-4222-8222-222222222222',
    email: 'admin@secureplan.test',
    role: 'COMPANY_ADMIN',
  },
  EMPLOYEE: {
    accountId: '33333333-3333-4333-8333-333333333333',
    companyId: '22222222-2222-4222-8222-222222222222',
    email: 'mitarbeitende@secureplan.test',
    role: 'EMPLOYEE',
  },
};

// Per role: landing page, a second protected page reached by a click, and how to get there.
const JOURNEYS = {
  COMPANY_ADMIN: { landing: '/arbeitsuebersicht', landingTitle: 'Arbeitsübersicht', next: '/mitarbeitende', nextLink: /^Mitarbeitende/ },
  EMPLOYEE: { landing: '/mein-monatsplan', landingTitle: 'Mein Monatsplan', next: '/mein-monatsplan/2027-01', nextLink: /^Nächster Monat/ },
} as const;

type Handler = () => Response | Promise<Response>;
type Responder = () => Response;

function authorized(role: TenantRole): Responder {
  return () => new Response(JSON.stringify(IDENTITIES[role]), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-csrf-token': CSRF },
  });
}

function problem(status: number, code: string): Responder {
  return () => new Response(JSON.stringify({ code }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

const unauthorized = problem(401, 'SESSION_REQUIRED');
const noContent: Responder = () => new Response(null, { status: 204 });
const EMPLOYEES = '/api/v1/employees';
const json = (status: number, body: unknown): Responder => () => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});
// SP-07: an empty company for the real employee list.
const emptyEmployees = json(200, { items: [], pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 } });
// SP-08: an empty company for the real project list.
const PROJECTS = '/api/v1/projects';
const emptyProjects = json(200, { items: [], pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 } });
// SP-09: reads of the month-assignment panel on a project detail page (test "today": December 2026).
const MONTH_ASSIGNMENTS = '/api/v1/project-assignments?monthStart=2026-12-01&pageSize=100';
const emptyPage = json(200, { items: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } });

// SP-08b: the detail page also reads the shift configuration effective for the month.
const shiftConfiguration = (projectId: string, monthStart: string) =>
  `${PROJECTS}/${projectId}/shift-configuration?effectiveForMonth=${monthStart}`;
const noShifts = (projectId: string) => json(200, { projectId, effectiveFromMonth: null, shifts: [] });

function enqueueMonthReads(visits: number, projectId: string) {
  for (let visit = 0; visit < visits; visit += 1) {
    enqueue(queues, MONTH_ASSIGNMENTS, emptyPage);
    enqueue(queues, `${EMPLOYEES}?pageSize=100`, emptyPage);
    enqueue(queues, `${PROJECTS}?pageSize=100`, emptyPage);
    enqueue(queues, shiftConfiguration(projectId, '2026-12-01'), noShifts(projectId));
  }
}

function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { handler: (() => promise) as Handler, resolve };
}

/** Routes fetch calls by URL; each call consumes the next queued response. */
function stubApi(queues: Partial<Record<string, Handler[]>>) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const next = queues[String(input)]?.shift();
    return next ? Promise.resolve(next()) : Promise.reject(new Error(`Unexpected request ${String(input)}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function enqueue(fetchQueues: Partial<Record<string, Handler[]>>, url: string, ...handlers: Handler[]) {
  (fetchQueues[url] ??= []).push(...handlers);
}

function renderAt(path: string, Component: ComponentType = App) {
  window.history.replaceState(null, '', path);
  return render(<Component />);
}

function expectNoShellContent(role: TenantRole) {
  expect(screen.queryByRole('navigation', { name: 'Hauptnavigation' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Abmelden' })).toBeNull();
  expect(document.getElementById('main')).toBeNull();
  const text = document.body.textContent ?? '';
  expect(text).not.toContain(IDENTITIES[role].email);
  for (const fragment of PROTECTED_TEXT) expect(text, fragment).not.toContain(fragment);
}

function expectNoProtectedContent(role: TenantRole) {
  expectNoShellContent(role);
  expect(screen.getByRole('heading', { level: 1, name: 'Anmelden' })).toBeTruthy();
  expect(screen.getByLabelText('E-Mail-Adresse')).toBeTruthy();
}

async function expectShell(title: string) {
  expect(await screen.findByRole('navigation', { name: 'Hauptnavigation' })).toBeTruthy();
  // `/` first renders a redirect, so the page heading may appear one render later.
  expect(await screen.findByRole('heading', { level: 1, name: title })).toBeTruthy();
}

function restoreFromBfcache() {
  act(() => {
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
}

function meCalls(fetchMock: { mock: { calls: unknown[][] } }) {
  return fetchMock.mock.calls.filter(([url]) => url === '/api/v1/me').length;
}

async function traverse(direction: 'back' | 'forward', expectedPath: string) {
  act(() => {
    if (direction === 'back') window.history.back();
    else window.history.forward();
  });
  await waitFor(() => expect(window.location.pathname).toBe(expectedPath));
}

let queues: Partial<Record<string, Handler[]>>;
let setItemSpy: MockInstance<Storage['setItem']>;

beforeEach(() => {
  // Deterministic "today" for the preview data: 15.12.2026, local midday.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 11, 15, 12, 0, 0));
  queues = {};
  setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('F1 — authenticated shell through <App/> (fetch mocked)', () => {
  it('never shows protected content for an unauthenticated deep link, also while GET /me is pending', async () => {
    const me = deferred();
    enqueue(queues, '/api/v1/me', me.handler);
    const fetchMock = stubApi(queues);
    renderAt('/arbeitsuebersicht');

    expect(screen.getByRole('heading', { name: 'Sitzung wird geprüft' })).toBeTruthy();
    expectNoShellContent('COMPANY_ADMIN');

    await act(async () => me.resolve(unauthorized()));
    expect(await screen.findByRole('heading', { name: 'Anmelden' })).toBeTruthy();
    expectNoProtectedContent('COMPANY_ADMIN');
    expect(window.location.pathname).toBe('/arbeitsuebersicht');
    expect(window.location.search).toBe('');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.title).toBe('Anmelden – SecurePlan');
  });

  it.each(['COMPANY_ADMIN', 'EMPLOYEE'] as const)('restores a %s session at / and lands on the role landing page', async (role) => {
    enqueue(queues, '/api/v1/me', authorized(role));
    const fetchMock = stubApi(queues);
    renderAt('/');

    await expectShell(JOURNEYS[role].landingTitle);
    expect(window.location.pathname).toBe(JOURNEYS[role].landing);
    const nav = screen.getByRole('navigation', { name: 'Hauptnavigation' });
    const otherLanding = role === 'COMPANY_ADMIN' ? 'Mein Monatsplan' : 'Arbeitsübersicht';
    expect(within(nav).queryByText(otherLanding)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps an allowed deep link across login', async () => {
    enqueue(queues, '/api/v1/me', unauthorized);
    enqueue(queues, '/api/v1/auth/login', authorized('EMPLOYEE'));
    stubApi(queues);
    renderAt('/mein-monatsplan/2027-01');

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('E-Mail-Adresse'), 'mitarbeitende@secureplan.test');
    await user.type(screen.getByLabelText('Passwort'), 'Local Password 2026!');
    await user.click(screen.getByRole('button', { name: 'Anmelden' }));

    await expectShell('Mein Monatsplan');
    expect(window.location.pathname).toBe('/mein-monatsplan/2027-01');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Januar 2027');
  });

  it('supports link navigation, Back and Forward with focus and title updates', async () => {
    enqueue(queues, '/api/v1/me', authorized('COMPANY_ADMIN'));
    // SP-08: the projects area reads the real list on each visit.
    enqueue(queues, PROJECTS, emptyProjects, emptyProjects);
    stubApi(queues);
    renderAt('/arbeitsuebersicht');
    await expectShell('Arbeitsübersicht');

    await userEvent.setup().click(screen.getByRole('link', { name: /^Projekte & Zuordnungen/ }));
    expect(window.location.pathname).toBe('/projekte');
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Projekte & Zuordnungen' }));
    expect(document.title).toBe('Projekte & Zuordnungen – SecurePlan');

    await traverse('back', '/arbeitsuebersicht');
    expect(await screen.findByRole('heading', { level: 1, name: 'Arbeitsübersicht' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));

    await traverse('forward', '/projekte');
    expect(await screen.findByRole('heading', { level: 1, name: 'Projekte & Zuordnungen' })).toBeTruthy();
  });

  it('refreshing with a valid session restores the deep link without a login request', async () => {
    enqueue(queues, '/api/v1/me', authorized('EMPLOYEE'));
    const fetchMock = stubApi(queues);
    renderAt('/mein-monatsplan/2027-01');
    await expectShell('Mein Monatsplan');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Januar 2027');
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(['/api/v1/me']);
  });

  describe.each(['COMPANY_ADMIN', 'EMPLOYEE'] as const)('logout, then Back, Forward and Refresh (%s)', (role) => {
    const journey = JOURNEYS[role];

    async function signInAndLogout() {
      enqueue(queues, '/api/v1/me', authorized(role));
      enqueue(queues, '/api/v1/auth/logout', noContent);
      if (role === 'COMPANY_ADMIN') enqueue(queues, EMPLOYEES, emptyEmployees);
      const fetchMock = stubApi(queues);
      renderAt(journey.landing);
      await expectShell(journey.landingTitle);

      const user = userEvent.setup();
      await user.click(screen.getByRole('link', { name: journey.nextLink }));
      expect(window.location.pathname).toBe(journey.next);

      await user.click(screen.getByRole('button', { name: 'Abmelden' }));
      await screen.findByRole('heading', { name: 'Anmelden' });
      return fetchMock;
    }

    it('T-LOGOUT-1/2/3: logout resets the URL; Back and Forward never bring protected content back', async () => {
      const fetchMock = await signInAndLogout();

      // T-LOGOUT-1: logout sent the in-memory CSRF token and reset the URL.
      const logoutCall = fetchMock.mock.calls.find(([url]) => url === '/api/v1/auth/logout');
      const logoutHeaders = (logoutCall?.[1]?.headers ?? {}) as Record<string, string>;
      expect(logoutHeaders['X-CSRF-Token']).toBe(CSRF);
      expect(window.location.pathname).toBe('/');
      expectNoProtectedContent(role);
      const callsAfterLogout = fetchMock.mock.calls.length;

      // T-LOGOUT-2: Back returns to a protected URL, but only the login form is shown.
      await traverse('back', journey.landing);
      expectNoProtectedContent(role);

      // T-LOGOUT-3: Forward again shows only the login form.
      await traverse('forward', '/');
      expectNoProtectedContent(role);

      // Back/Forward after logout neither restores a session nor calls any API.
      expect(fetchMock.mock.calls.length).toBe(callsAfterLogout);
    });

    it('T-LOGOUT-4: Refresh on a protected URL after logout shows the session check, then only the login form', async () => {
      await signInAndLogout();
      await traverse('back', journey.landing);
      cleanup();

      // Simulated browser refresh: fresh module graph, the server rejects the revoked session.
      vi.resetModules();
      const me = deferred();
      enqueue(queues, '/api/v1/me', me.handler);
      const fetchMock = stubApi(queues);
      const FreshApp = (await import('../App')).default;
      renderAt(journey.landing, FreshApp);

      expect(screen.getByRole('heading', { name: 'Sitzung wird geprüft' })).toBeTruthy();
      expectNoShellContent(role);
      await act(async () => me.resolve(unauthorized()));
      expect(await screen.findByRole('heading', { name: 'Anmelden' })).toBeTruthy();
      expectNoProtectedContent(role);
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(['/api/v1/me']);
    });
  });

  it('T-LOGOUT-5: protected content does not appear before a pending GET /me resolves', async () => {
    const me = deferred();
    enqueue(queues, '/api/v1/me', me.handler);
    stubApi(queues);
    renderAt('/mein-monatsplan/2027-01');

    expect(screen.getByRole('heading', { name: 'Sitzung wird geprüft' })).toBeTruthy();
    expectNoShellContent('EMPLOYEE');
    await act(async () => { await Promise.resolve(); });
    expectNoShellContent('EMPLOYEE');

    await act(async () => me.resolve(authorized('EMPLOYEE')()));
    await expectShell('Mein Monatsplan');
  });

  it('T-LOGOUT-6: a back/forward-cache restore hides the shell and signs out when /me returns 401', async () => {
    const me = deferred();
    enqueue(queues, '/api/v1/me', authorized('COMPANY_ADMIN'), me.handler);
    stubApi(queues);
    renderAt('/arbeitsuebersicht');
    await expectShell('Arbeitsübersicht');

    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    expect(screen.getByRole('heading', { name: 'Sitzung wird geprüft' })).toBeTruthy();
    expectNoShellContent('COMPANY_ADMIN');

    await act(async () => me.resolve(unauthorized()));
    expect(await screen.findByRole('heading', { name: 'Anmelden' })).toBeTruthy();
    expectNoProtectedContent('COMPANY_ADMIN');
    expect(window.location.pathname).toBe('/');
  });

  it('T-LOGOUT-6: a back/forward-cache restore shows the shell again when /me confirms the session', async () => {
    const me = deferred();
    enqueue(queues, '/api/v1/me', authorized('EMPLOYEE'), me.handler);
    stubApi(queues);
    renderAt('/mein-monatsplan');
    await expectShell('Mein Monatsplan');

    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    expectNoShellContent('EMPLOYEE');

    await act(async () => me.resolve(authorized('EMPLOYEE')()));
    await expectShell('Mein Monatsplan');
    expect(window.location.pathname).toBe('/mein-monatsplan');
  });

  describe('P1 — bfcache revalidation is single-flight and fail-closed', () => {
    it.each([
      ['401 settles first, then the stale 200', ['first', 'stale'] as const],
      ['stale 200 settles first, then the 401', ['stale', 'first'] as const],
    ])('overlapping restores send one /me; a 401 is never overwritten by a stale 200 (%s, same batch)', async (_label, order) => {
      const responses = { first: deferred(), stale: deferred() };
      enqueue(queues, '/api/v1/me', authorized('COMPANY_ADMIN'), responses.first.handler, responses.stale.handler);
      const fetchMock = stubApi(queues);
      renderAt('/arbeitsuebersicht');
      await expectShell('Arbeitsübersicht');

      restoreFromBfcache();
      expectNoShellContent('COMPANY_ADMIN');
      restoreFromBfcache();
      expectNoShellContent('COMPANY_ADMIN');
      // Single-flight: the second restore must not start another session check.
      expect(meCalls(fetchMock)).toBe(2);

      // Settle both conflicting responses in one batch; only the in-flight check may count.
      await act(async () => {
        for (const key of order) {
          if (key === 'first') responses.first.resolve(unauthorized());
          else responses.stale.resolve(authorized('COMPANY_ADMIN')());
        }
      });
      expect(await screen.findByRole('heading', { name: 'Anmelden' })).toBeTruthy();
      await act(async () => { await Promise.resolve(); });
      expectNoProtectedContent('COMPANY_ADMIN');
      expect(window.location.pathname).toBe('/');
      expect(meCalls(fetchMock)).toBe(2);
    });

    it('keeps a revoked session signed out: later restores neither re-check nor re-authenticate', async () => {
      const valid = deferred();
      const revoked = deferred();
      enqueue(queues, '/api/v1/me', authorized('EMPLOYEE'), valid.handler, revoked.handler, authorized('EMPLOYEE'));
      const fetchMock = stubApi(queues);
      renderAt('/mein-monatsplan');
      await expectShell('Mein Monatsplan');

      restoreFromBfcache();
      await act(async () => valid.resolve(authorized('EMPLOYEE')()));
      await expectShell('Mein Monatsplan');

      restoreFromBfcache();
      expectNoShellContent('EMPLOYEE');
      await act(async () => revoked.resolve(unauthorized()));
      expect(await screen.findByRole('heading', { name: 'Anmelden' })).toBeTruthy();

      restoreFromBfcache();
      await act(async () => { await Promise.resolve(); });
      expectNoProtectedContent('EMPLOYEE');
      expect(meCalls(fetchMock)).toBe(3);
    });

    it('fails closed with a safe alert when the revalidation hits a network error', async () => {
      enqueue(queues, '/api/v1/me', authorized('EMPLOYEE'), () => Promise.reject(new TypeError('private network diagnostic')));
      stubApi(queues);
      renderAt('/mein-monatsplan');
      await expectShell('Mein Monatsplan');

      restoreFromBfcache();
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('Verbindung fehlgeschlagen');
      expect(alert.textContent).not.toContain('private network diagnostic');
      expectNoProtectedContent('EMPLOYEE');
      expect(window.location.pathname).toBe('/');
    });

    it('re-checks once per restore and keeps a session the server still confirms', async () => {
      enqueue(queues, '/api/v1/me', authorized('COMPANY_ADMIN'), authorized('COMPANY_ADMIN'), authorized('COMPANY_ADMIN'));
      const fetchMock = stubApi(queues);
      renderAt('/arbeitsuebersicht');
      await expectShell('Arbeitsübersicht');

      restoreFromBfcache();
      await expectShell('Arbeitsübersicht');
      restoreFromBfcache();
      await expectShell('Arbeitsübersicht');
      expect(meCalls(fetchMock)).toBe(3);
      expect(window.location.pathname).toBe('/arbeitsuebersicht');
    });

    it.each([
      ['confirmed (200)', 200],
      ['revoked (401)', 401],
    ] as const)('does not strand the check when Back is used while it is pending — session %s', async (_label, status) => {
      const pending = deferred();
      enqueue(queues, '/api/v1/me', authorized('COMPANY_ADMIN'), pending.handler);
      enqueue(queues, EMPLOYEES, emptyEmployees);
      const fetchMock = stubApi(queues);
      renderAt('/arbeitsuebersicht');
      await expectShell('Arbeitsübersicht');
      await userEvent.setup().click(screen.getByRole('link', { name: /^Mitarbeitende/ }));
      expect(window.location.pathname).toBe('/mitarbeitende');

      restoreFromBfcache();
      expectNoShellContent('COMPANY_ADMIN');
      // A location change while the check is pending re-renders the session root.
      await traverse('back', '/arbeitsuebersicht');
      expectNoShellContent('COMPANY_ADMIN');

      await act(async () => pending.resolve(status === 200 ? authorized('COMPANY_ADMIN')() : unauthorized()));
      if (status === 200) {
        await expectShell('Arbeitsübersicht');
      } else {
        expect(await screen.findByRole('heading', { name: 'Anmelden' })).toBeTruthy();
        expectNoProtectedContent('COMPANY_ADMIN');
        expect(window.location.pathname).toBe('/');
      }
      expect(meCalls(fetchMock)).toBe(2);
    });
  });

  it('ignores a normal (non-persisted) pageshow', async () => {
    enqueue(queues, '/api/v1/me', authorized('EMPLOYEE'));
    const fetchMock = stubApi(queues);
    renderAt('/mein-monatsplan');
    await expectShell('Mein Monatsplan');

    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
    });
    expect(screen.getByRole('navigation', { name: 'Hauptnavigation' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the shell and shows an alert when logout is rejected with 403', async () => {
    enqueue(queues, '/api/v1/me', authorized('COMPANY_ADMIN'));
    enqueue(queues, '/api/v1/auth/logout', problem(403, 'CSRF_VALIDATION_FAILED'));
    stubApi(queues);
    renderAt('/arbeitsuebersicht');
    await expectShell('Arbeitsübersicht');

    await userEvent.setup().click(screen.getByRole('button', { name: 'Abmelden' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Kein Zugriff');
    expect(screen.getByRole('navigation', { name: 'Hauptnavigation' })).toBeTruthy();
    expect(window.location.pathname).toBe('/arbeitsuebersicht');
  });

  it('signs out when logout returns 401 because the session is already invalid', async () => {
    enqueue(queues, '/api/v1/me', authorized('EMPLOYEE'));
    enqueue(queues, '/api/v1/auth/logout', problem(401, 'SESSION_REVOKED'));
    stubApi(queues);
    renderAt('/mein-monatsplan');
    await expectShell('Mein Monatsplan');

    await userEvent.setup().click(screen.getByRole('button', { name: 'Abmelden' }));
    expect(await screen.findByRole('heading', { name: 'Anmelden' })).toBeTruthy();
    expectNoShellContent('EMPLOYEE');
    expect(window.location.pathname).toBe('/');
  });

  it('keeps identity and CSRF token out of storage, DOM and URL and calls only the auth endpoints', async () => {
    enqueue(queues, '/api/v1/me', unauthorized);
    enqueue(queues, '/api/v1/auth/login', authorized('COMPANY_ADMIN'));
    enqueue(queues, '/api/v1/auth/logout', noContent);
    const fetchMock = stubApi(queues);
    renderAt('/');

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('E-Mail-Adresse'), 'admin@secureplan.test');
    await user.type(screen.getByLabelText('Passwort'), 'Local Password 2026!');
    await user.click(screen.getByRole('button', { name: 'Anmelden' }));
    await expectShell('Arbeitsübersicht');
    await user.click(screen.getByRole('link', { name: /^Monatsplanung/ }));
    expect(document.body.innerHTML).not.toContain(CSRF);
    expect(window.location.href).not.toContain(CSRF);
    await user.click(screen.getByRole('button', { name: 'Abmelden' }));
    await screen.findByRole('heading', { name: 'Anmelden' });

    expect(setItemSpy).not.toHaveBeenCalled();
    for (const [url, init] of fetchMock.mock.calls) {
      expect(ALLOWED_REQUESTS.has(String(url)), String(url)).toBe(true);
      const body = typeof init?.body === 'string' ? init.body : '';
      expect(body).not.toContain(IDENTITIES.COMPANY_ADMIN.companyId);
      expect(body).not.toContain('COMPANY_ADMIN');
      expect(body).not.toContain('accountId');
    }
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/v1/me',
      '/api/v1/auth/login',
      '/api/v1/auth/logout',
    ]);
  });

  it('SP-07: an employee write carries the in-memory CSRF token, which never reaches DOM, URL or storage', async () => {
    const created = {
      id: '6f1ad9a6-3a0c-4b7c-9c5e-0d4f2a1e8b11',
      employeeCode: 'A-100',
      firstName: 'Mira',
      lastName: 'Beispiel',
      employmentStart: null,
      employmentEnd: null,
      shiftEligibility: 'DAY',
      status: 'ACTIVE',
      email: 'mira@secureplan.test',
      accountStatus: 'PENDING_ACTIVATION',
    };
    enqueue(queues, '/api/v1/me', authorized('COMPANY_ADMIN'));
    enqueue(queues, EMPLOYEES, json(201, created));
    enqueue(queues, `${EMPLOYEES}/${created.id}`, json(200, created));
    const fetchMock = stubApi(queues);
    renderAt('/mitarbeitende/neu');
    await expectShell('Mitarbeiter:in anlegen');

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Mitarbeiter-ID'), 'A-100');
    await user.type(screen.getByLabelText('Vorname'), 'Mira');
    await user.type(screen.getByLabelText('Nachname'), 'Beispiel');
    await user.type(screen.getByLabelText('E-Mail-Adresse'), 'mira@secureplan.test');
    await user.click(screen.getByRole('radio', { name: 'Tag' }));
    await user.click(screen.getByRole('button', { name: 'Mitarbeiter:in anlegen' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Mira Beispiel' })).toBeTruthy();
    expect(window.location.pathname).toBe(`/mitarbeitende/${created.id}`);
    const post = fetchMock.mock.calls.find(([url, init]) => url === EMPLOYEES && init?.method === 'POST');
    const headers = new Headers(post?.[1]?.headers);
    expect(headers.get('x-csrf-token')).toBe(CSRF);
    expect(post?.[1]?.credentials).toBe('same-origin');
    // The client never sends tenant or role; the server derives them from the session.
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      employeeCode: 'A-100',
      firstName: 'Mira',
      lastName: 'Beispiel',
      email: 'mira@secureplan.test',
      shiftEligibility: 'DAY',
    });
    // Reads never carry the CSRF token.
    for (const [, init] of fetchMock.mock.calls.filter(([, init]) => (init?.method ?? 'GET') === 'GET')) {
      expect(new Headers(init?.headers).get('x-csrf-token')).toBeNull();
    }
    expect(document.body.innerHTML).not.toContain(CSRF);
    expect(window.location.href).not.toContain(CSRF);
    expect(setItemSpy).not.toHaveBeenCalled();
  });

  it('SP-07: a 401 from an employee request shows the login in place with the reason', async () => {
    enqueue(queues, '/api/v1/me', authorized('COMPANY_ADMIN'));
    enqueue(queues, EMPLOYEES, problem(401, 'SESSION_REVOKED'));
    stubApi(queues);
    renderAt('/mitarbeitende');

    expect(await screen.findByRole('heading', { name: 'Anmelden' })).toBeTruthy();
    expectNoProtectedContent('COMPANY_ADMIN');
    expect(screen.getByRole('alert').textContent).toContain('Anmeldung erforderlich');
    // The deep link is kept, so work can continue after signing in again.
    expect(window.location.pathname).toBe('/mitarbeitende');
  });

  describe('SP-07 — a late 401 from an earlier session is ignored', () => {
    /** Submits a create that stays pending, then signs out; returns the pending response. */
    async function submitCreateThenLogout() {
      const pendingCreate = deferred();
      enqueue(queues, '/api/v1/me', authorized('COMPANY_ADMIN'));
      enqueue(queues, EMPLOYEES, pendingCreate.handler);
      enqueue(queues, '/api/v1/auth/logout', noContent);
      enqueue(queues, '/api/v1/auth/login', authorized('COMPANY_ADMIN'));
      const fetchMock = stubApi(queues);
      renderAt('/mitarbeitende/neu');
      await expectShell('Mitarbeiter:in anlegen');

      const user = userEvent.setup();
      await user.type(screen.getByLabelText('Mitarbeiter-ID'), 'A-100');
      await user.type(screen.getByLabelText('Vorname'), 'Mira');
      await user.type(screen.getByLabelText('Nachname'), 'Beispiel');
      await user.type(screen.getByLabelText('E-Mail-Adresse'), 'mira@secureplan.test');
      await user.click(screen.getByRole('radio', { name: 'Tag' }));
      await user.click(screen.getByRole('button', { name: 'Mitarbeiter:in anlegen' }));
      await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === EMPLOYEES && init?.method === 'POST')).toBe(true));

      // The write is still pending when the user signs out.
      await user.click(screen.getByRole('button', { name: 'Abmelden' }));
      expect(await screen.findByRole('heading', { name: 'Anmelden' })).toBeTruthy();
      return { pendingCreate, user };
    }

    it('does not end a newer session established after re-login', async () => {
      const { pendingCreate, user } = await submitCreateThenLogout();
      await user.type(screen.getByLabelText('E-Mail-Adresse'), 'admin@secureplan.test');
      await user.type(screen.getByLabelText('Passwort'), 'Local Password 2026!');
      await user.click(screen.getByRole('button', { name: 'Anmelden' }));
      await expectShell('Arbeitsübersicht');

      await act(async () => pendingCreate.resolve(problem(401, 'SESSION_REVOKED')()));
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByRole('navigation', { name: 'Hauptnavigation' })).toBeTruthy();
      expect(screen.queryByRole('heading', { name: 'Anmelden' })).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(window.location.pathname).toBe('/arbeitsuebersicht');
    });

    it('does not put a session error on the login form after a deliberate logout', async () => {
      const { pendingCreate } = await submitCreateThenLogout();

      await act(async () => pendingCreate.resolve(problem(401, 'SESSION_REVOKED')()));
      await act(async () => { await Promise.resolve(); });
      expectNoProtectedContent('COMPANY_ADMIN');
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  describe('SP-08 — project detail deep link: logout, then Back, Forward and Refresh', () => {
    // Synthetic example record, not a business rule.
    const project = { id: '7a2be0c4-1d3e-4f5a-8b6c-9d0e1f2a3b4c', name: 'Demo-Objekt Hafen', status: 'ACTIVE' };
    const detailPath = `/projekte/${project.id}`;
    const projectName = new RegExp(project.name);

    it('never brings the project back after logout; Refresh re-checks the session first', async () => {
      enqueue(queues, '/api/v1/me', authorized('COMPANY_ADMIN'));
      // Each visit of a page reads again: detail, list, detail (Back), list (Forward).
      enqueue(queues, `${PROJECTS}/${project.id}`, json(200, project), json(200, project));
      enqueue(queues, PROJECTS, emptyProjects, emptyProjects);
      // SP-09/SP-08b: every detail visit also reads the month assignment, its pool and the shift times (December 2026).
      enqueueMonthReads(2, project.id);
      enqueue(queues, '/api/v1/auth/logout', noContent);
      const fetchMock = stubApi(queues);
      renderAt(detailPath);
      await expectShell(project.name);

      // A pushed entry after the deep link: logout replaces the CURRENT entry with `/`.
      const user = userEvent.setup();
      await user.click(screen.getByRole('link', { name: 'Zurück zur Übersicht' }));
      expect(await screen.findByText('Noch keine Projekte')).toBeTruthy();
      await traverse('back', detailPath);
      expect(await screen.findByRole('heading', { level: 1, name: project.name })).toBeTruthy();
      await traverse('forward', '/projekte');
      await user.click(screen.getByRole('button', { name: 'Abmelden' }));
      await screen.findByRole('heading', { name: 'Anmelden' });
      expect(window.location.pathname).toBe('/');
      const callsAfterLogout = fetchMock.mock.calls.length;

      await traverse('back', detailPath);
      expectNoProtectedContent('COMPANY_ADMIN');
      expect(document.body.textContent).not.toMatch(projectName);
      await traverse('forward', '/');
      expectNoProtectedContent('COMPANY_ADMIN');
      expect(fetchMock.mock.calls.length).toBe(callsAfterLogout);

      await traverse('back', detailPath);
      cleanup();
      // Simulated browser refresh: fresh module graph, the server rejects the revoked session.
      vi.resetModules();
      const me = deferred();
      enqueue(queues, '/api/v1/me', me.handler);
      const refreshed = stubApi(queues);
      const FreshApp = (await import('../App')).default;
      renderAt(detailPath, FreshApp);
      expect(screen.getByRole('heading', { name: 'Sitzung wird geprüft' })).toBeTruthy();
      await act(async () => me.resolve(unauthorized()));
      expect(await screen.findByRole('heading', { name: 'Anmelden' })).toBeTruthy();
      expectNoProtectedContent('COMPANY_ADMIN');
      expect(document.body.textContent).not.toMatch(projectName);
      expect(refreshed.mock.calls.map(([url]) => String(url))).toEqual(['/api/v1/me']);
    });
  });

  describe('SP-09 — month assignment deep link', () => {
    // Synthetic example record, not a business rule.
    const project = { id: '7a2be0c4-1d3e-4f5a-8b6c-9d0e1f2a3b4c', name: 'Demo-Objekt Hafen', status: 'ACTIVE' };
    const monthPath = `/projekte/${project.id}/2027-01`;

    it('a 401 from the month read shows the login in place and keeps the month deep link', async () => {
      enqueue(queues, '/api/v1/me', authorized('COMPANY_ADMIN'));
      enqueue(queues, `${PROJECTS}/${project.id}`, json(200, project));
      enqueue(queues, '/api/v1/project-assignments?monthStart=2027-01-01&pageSize=100', problem(401, 'SESSION_EXPIRED'));
      enqueue(queues, `${EMPLOYEES}?pageSize=100`, emptyPage);
      enqueue(queues, `${PROJECTS}?pageSize=100`, emptyPage);
      enqueue(queues, shiftConfiguration(project.id, '2027-01-01'), noShifts(project.id));
      stubApi(queues);
      renderAt(monthPath);

      expect(await screen.findByRole('heading', { name: 'Anmelden' })).toBeTruthy();
      expectNoProtectedContent('COMPANY_ADMIN');
      expect(document.body.textContent).not.toContain(project.name);
      expect(screen.getByRole('alert').textContent).toContain('Anmeldung erforderlich');
      expect(window.location.pathname).toBe(monthPath);
    });

    it('an assignment write carries the in-memory CSRF token and only the three business fields', async () => {
      const employee = {
        id: '6f1ad9a6-3a0c-4b7c-9c5e-0d4f2a1e8b11', employeeCode: 'A-001', firstName: 'Mira', lastName: 'Beispiel',
        employmentStart: null, employmentEnd: null, shiftEligibility: 'BOTH', status: 'ACTIVE',
        email: 'mira@secureplan.test', accountStatus: 'ACTIVE',
      };
      const created = { id: 'a-1', employeeId: employee.id, projectId: project.id, monthStart: '2027-01-01' };
      const pageOf = (items: unknown[]) => json(200, { items, pagination: { page: 1, pageSize: 100, totalItems: items.length, totalPages: 1 } });
      const MONTH = '/api/v1/project-assignments?monthStart=2027-01-01&pageSize=100';
      enqueue(queues, '/api/v1/me', authorized('COMPANY_ADMIN'));
      enqueue(queues, `${PROJECTS}/${project.id}`, json(200, project));
      enqueue(queues, MONTH, pageOf([]), pageOf([created]));
      enqueue(queues, `${EMPLOYEES}?pageSize=100`, pageOf([employee]), pageOf([employee]));
      enqueue(queues, `${PROJECTS}?pageSize=100`, pageOf([project]), pageOf([project]));
      enqueue(queues, '/api/v1/project-assignments', json(201, created));
      enqueue(queues, shiftConfiguration(project.id, '2027-01-01'), noShifts(project.id));
      const fetchMock = stubApi(queues);
      renderAt(monthPath);

      const user = userEvent.setup();
      await user.selectOptions(await screen.findByLabelText('Mitarbeiter:in für Januar 2027 zuordnen'), employee.id);
      await user.click(screen.getByRole('button', { name: 'Zuordnen' }));
      expect(await screen.findByText('Mira Beispiel ist dem Projekt Demo-Objekt Hafen für Januar 2027 zugeordnet.')).toBeTruthy();

      const post = fetchMock.mock.calls.find(([url, init]) => url === '/api/v1/project-assignments' && init?.method === 'POST');
      expect(new Headers(post?.[1]?.headers).get('x-csrf-token')).toBe(CSRF);
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({
        employeeId: employee.id, projectId: project.id, monthStart: '2027-01-01',
      });
      expect(document.body.innerHTML).not.toContain(CSRF);
      expect(setItemSpy).not.toHaveBeenCalled();
    });
  });
});
