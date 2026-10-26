// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/"}
/**
 * Cross-tab logout: two LoginScreen instances stand for two tabs of one
 * browser profile. They share the fetch stub (one cookie jar) and an in-memory
 * session channel with BroadcastChannel semantics (async, never to the sender).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginScreen, type AuthenticatedSession } from './LoginScreen';
import type { OpenSessionChannel, SessionSignal } from './session-channel';

// Minimal protected UI with one business read, so the tests stay on the session boundary.
function ProtectedStub({ identity, api, logout }: AuthenticatedSession) {
  return (
    <div>
      <h1>Geschützter Bereich</h1>
      <p>{identity.email}</p>
      <button type="button" onClick={() => { void api.request('/api/v1/employees').catch(() => {}); }}>Laden</button>
      <button type="button" onClick={logout}>Abmelden</button>
    </div>
  );
}

const CSRF = 'c'.repeat(43);
const identityOf = (email: string) => ({
  accountId: '11111111-1111-4111-8111-111111111111',
  companyId: '22222222-2222-4222-8222-222222222222',
  email,
  role: 'COMPANY_ADMIN',
});
const authorized = (email = 'admin@secureplan.test') => () => new Response(JSON.stringify(identityOf(email)), {
  status: 200,
  headers: { 'content-type': 'application/json', 'x-csrf-token': CSRF },
});
const problem = (status: number, code: string) => () => new Response(JSON.stringify({ code }), {
  status,
  headers: { 'content-type': 'application/problem+json' },
});
const noContent = () => new Response(null, { status: 204 });

type Responder = () => Response | Promise<Response>;

/** One cookie jar: both tabs consume the same queued answers per URL. */
function stubServer(queues: Record<string, Responder[]>) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const next = queues[String(input)]?.shift();
    return next ? Promise.resolve(next()) : Promise.reject(new Error(`Unexpected request ${String(input)}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** In-memory BroadcastChannel stand-in: asynchronous, never delivered to the sender. */
function sessionBus() {
  const listeners = new Set<(signal: SessionSignal) => void>();
  const posted: SessionSignal[] = [];
  const open: OpenSessionChannel = (onSignal) => {
    listeners.add(onSignal);
    return {
      post(signal) {
        posted.push(signal);
        for (const listener of listeners) {
          if (listener !== onSignal) queueMicrotask(() => listener(signal));
        }
      },
      close() {
        listeners.delete(onSignal);
      },
    };
  };
  return { open, posted, listeners };
}

function renderTab(bus: ReturnType<typeof sessionBus>, onSignedOut = vi.fn()) {
  const container = document.body.appendChild(document.createElement('div'));
  render(<LoginScreen authenticatedView={ProtectedStub} onSignedOut={onSignedOut} openChannel={bus.open} />, { container });
  return { view: within(container), onSignedOut };
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function callsTo(fetchMock: ReturnType<typeof stubServer>, url: string) {
  return fetchMock.mock.calls.filter(([input]) => String(input) === url).length;
}

describe('cross-tab logout (shared session cookie)', () => {
  it('a logout in tab A hides protected content in tab B at once, without a request from B', async () => {
    const bus = sessionBus();
    const fetchMock = stubServer({
      '/api/v1/me': [authorized(), authorized()],
      '/api/v1/auth/logout': [noContent],
    });
    const tabA = renderTab(bus);
    const tabB = renderTab(bus);
    expect(await tabA.view.findByRole('heading', { name: 'Geschützter Bereich' })).toBeTruthy();
    expect(await tabB.view.findByRole('heading', { name: 'Geschützter Bereich' })).toBeTruthy();
    const callsBefore = fetchMock.mock.calls.length;

    await userEvent.setup().click(tabA.view.getByRole('button', { name: 'Abmelden' }));

    expect(await tabB.view.findByRole('heading', { name: 'Anmelden' })).toBeTruthy();
    expect(tabB.view.queryByText('admin@secureplan.test')).toBeNull();
    expect(tabB.view.queryByRole('alert')).toBeNull();
    expect(tabB.onSignedOut).toHaveBeenCalledTimes(1);
    // Only tab A's logout POST went to the server.
    expect(fetchMock.mock.calls.slice(callsBefore).map(([input]) => String(input))).toEqual(['/api/v1/auth/logout']);
    // The broadcast carries the bare signal only.
    expect(bus.posted).toEqual(['signed-out']);
  });

  it('a 401 from a business request in tab A also ends the protected view in tab B', async () => {
    const bus = sessionBus();
    stubServer({
      '/api/v1/me': [authorized(), authorized()],
      '/api/v1/employees': [problem(401, 'SESSION_EXPIRED')],
    });
    const tabA = renderTab(bus);
    const tabB = renderTab(bus);
    await tabA.view.findByRole('heading', { name: 'Geschützter Bereich' });
    await tabB.view.findByRole('heading', { name: 'Geschützter Bereich' });

    await userEvent.setup().click(tabA.view.getByRole('button', { name: 'Laden' }));

    expect(await tabA.view.findByRole('heading', { name: 'Anmelden' })).toBeTruthy();
    expect(await tabB.view.findByRole('heading', { name: 'Anmelden' })).toBeTruthy();
    expect(tabB.view.queryByText('admin@secureplan.test')).toBeNull();
    expect(bus.posted).toEqual(['signed-out']);
  });

  it('a new login in tab A makes tab B re-check its session before showing protected content again', async () => {
    const bus = sessionBus();
    let resolveRecheck!: (response: Response) => void;
    const recheck = new Promise<Response>((resolve) => { resolveRecheck = resolve; });
    const fetchMock = stubServer({
      // A: no session yet; B: an older session; B's re-check after A's login.
      '/api/v1/me': [problem(401, 'SESSION_REQUIRED'), authorized('old@secureplan.test'), () => recheck],
      '/api/v1/auth/login': [authorized('new@secureplan.test')],
    });
    const tabA = renderTab(bus);
    await tabA.view.findByRole('heading', { name: 'Anmelden' });
    const tabB = renderTab(bus);
    expect(await tabB.view.findByText('old@secureplan.test')).toBeTruthy();

    const user = userEvent.setup();
    await user.type(tabA.view.getByLabelText('E-Mail-Adresse'), 'new@secureplan.test');
    await user.type(tabA.view.getByLabelText('Passwort'), 'Local Password 2026!');
    await user.click(tabA.view.getByRole('button', { name: 'Anmelden' }));
    await tabA.view.findByText('new@secureplan.test');

    // While the re-check is pending, tab B shows no protected content.
    expect(await tabB.view.findByRole('heading', { name: 'Sitzung wird geprüft' })).toBeTruthy();
    expect(tabB.view.queryByText('old@secureplan.test')).toBeNull();
    await act(async () => resolveRecheck(authorized('new@secureplan.test')()));
    expect(await tabB.view.findByText('new@secureplan.test')).toBeTruthy();
    expect(callsTo(fetchMock, '/api/v1/me')).toBe(3);
    expect(bus.posted).toEqual(['signed-in']);
  });

  it('a failed re-check signs tab B out (fail closed)', async () => {
    const bus = sessionBus();
    stubServer({
      '/api/v1/me': [problem(401, 'SESSION_REQUIRED'), authorized('old@secureplan.test'), problem(401, 'SESSION_REVOKED')],
      '/api/v1/auth/login': [authorized('new@secureplan.test')],
    });
    const tabA = renderTab(bus);
    await tabA.view.findByRole('heading', { name: 'Anmelden' });
    const tabB = renderTab(bus);
    await tabB.view.findByText('old@secureplan.test');

    const user = userEvent.setup();
    await user.type(tabA.view.getByLabelText('E-Mail-Adresse'), 'new@secureplan.test');
    await user.type(tabA.view.getByLabelText('Passwort'), 'Local Password 2026!');
    await user.click(tabA.view.getByRole('button', { name: 'Anmelden' }));

    expect(await tabB.view.findByRole('heading', { name: 'Anmelden' })).toBeTruthy();
    expect(tabB.view.queryByText('old@secureplan.test')).toBeNull();
    expect(tabB.onSignedOut).toHaveBeenCalledTimes(1);
  });

  it('a tab that shows the login form ignores signals: no request, no automatic sign-in', async () => {
    const bus = sessionBus();
    const fetchMock = stubServer({
      '/api/v1/me': [problem(401, 'SESSION_REQUIRED'), problem(401, 'SESSION_REQUIRED')],
      '/api/v1/auth/login': [authorized()],
    });
    const tabA = renderTab(bus);
    const tabB = renderTab(bus);
    await tabA.view.findByRole('heading', { name: 'Anmelden' });
    await tabB.view.findByRole('heading', { name: 'Anmelden' });

    const user = userEvent.setup();
    await user.type(tabA.view.getByLabelText('E-Mail-Adresse'), 'admin@secureplan.test');
    await user.type(tabA.view.getByLabelText('Passwort'), 'Local Password 2026!');
    await user.click(tabA.view.getByRole('button', { name: 'Anmelden' }));
    await tabA.view.findByRole('heading', { name: 'Geschützter Bereich' });
    await act(async () => { await Promise.resolve(); });

    expect(tabB.view.getByRole('heading', { name: 'Anmelden' })).toBeTruthy();
    expect(callsTo(fetchMock, '/api/v1/me')).toBe(2);
    expect(tabB.onSignedOut).not.toHaveBeenCalled();
  });

  it('closes its channel on unmount', async () => {
    const bus = sessionBus();
    stubServer({ '/api/v1/me': [problem(401, 'SESSION_REQUIRED')] });
    renderTab(bus);
    await screen.findByRole('heading', { name: 'Anmelden' });
    expect(bus.listeners.size).toBe(1);
    cleanup();
    expect(bus.listeners.size).toBe(0);
  });
});
