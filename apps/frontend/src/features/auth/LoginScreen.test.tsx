// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiErrorAlert } from '../../shared/ui/ApiErrorAlert';
import { LoginScreen, type AuthenticatedSession } from './LoginScreen';

// Minimal stand-in for the protected UI, so these tests stay focused on the session boundary.
function AuthenticatedStub({ identity, logout, logoutPending, logoutError }: AuthenticatedSession) {
  return (
    <div>
      <h1>Angemeldet</h1>
      <p>{identity.email}</p>
      <ApiErrorAlert error={logoutError} />
      <button type="button" onClick={logout} disabled={logoutPending}>Abmelden</button>
    </div>
  );
}

const csrf = 'c'.repeat(43);
const identity = {
  accountId: '11111111-1111-4111-8111-111111111111',
  companyId: '22222222-2222-4222-8222-222222222222',
  email: 'demo@secureplan.test',
  role: 'EMPLOYEE',
};

function authorized() {
  return new Response(JSON.stringify(identity), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
  });
}
function unauthorized(code = 'SESSION_REQUIRED') {
  return new Response(JSON.stringify({ code }), {
    status: 401,
    headers: { 'content-type': 'application/problem+json' },
  });
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function fillCredentials() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('E-Mail-Adresse'), 'demo@secureplan.test');
  await user.type(screen.getByLabelText('Passwort'), 'Local Password 2026!');
  return user;
}

describe('SP-05 — React Login and session UX', () => {
  it('checks /me on first render, showing login when there is no session', async () => {
    const fetchMock = vi.fn().mockResolvedValue(unauthorized());
    vi.stubGlobal('fetch', fetchMock);
    render(<LoginScreen authenticatedView={AuthenticatedStub} />);

    expect(await screen.findByRole('heading', { name: 'Anmelden' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/me');
    expect(fetchMock.mock.calls[0][1].credentials).toBe('same-origin');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('logs in through the same-origin API and renders trusted identity', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(authorized());
    vi.stubGlobal('fetch', fetchMock);
    render(<LoginScreen authenticatedView={AuthenticatedStub} />);

    await screen.findByRole('heading', { name: 'Anmelden' });
    const user = await fillCredentials();
    await user.click(screen.getByRole('button', { name: 'Anmelden' }));

    expect(await screen.findByRole('heading', { name: 'Angemeldet' })).toBeTruthy();
    expect(screen.getByText('demo@secureplan.test')).toBeTruthy();
    const [path, options] = fetchMock.mock.calls[1];
    expect(path).toBe('/api/v1/auth/login');
    expect(options.method).toBe('POST');
    expect(options.credentials).toBe('same-origin');
    expect(options.cache).toBe('no-store');
    expect(JSON.parse(options.body)).toEqual({
      email: 'demo@secureplan.test',
      password: 'Local Password 2026!',
    });
  });

  it('restores a valid session via GET /me without login POST', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(authorized());
    vi.stubGlobal('fetch', fetchMock);
    render(<LoginScreen authenticatedView={AuthenticatedStub} />);

    expect(await screen.findByRole('heading', { name: 'Angemeldet' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/me');
    expect(screen.queryByLabelText('Passwort')).toBeNull();
  });

  it('shows a neutral credential error without leaking server details', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 'INVALID_CREDENTIALS',
        detail: 'private diagnostic that must not be displayed',
      }), {
        status: 401,
        headers: { 'content-type': 'application/problem+json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    render(<LoginScreen authenticatedView={AuthenticatedStub} />);
    await screen.findByRole('heading', { name: 'Anmelden' });
    const user = await fillCredentials();
    await user.click(screen.getByRole('button', { name: 'Anmelden' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Anmeldung erforderlich');
    expect(alert.textContent).not.toContain('private diagnostic');
    expect(screen.getByRole('button', { name: 'Anmelden' })).toBeTruthy();
  });

  it('includes the CSRF response header value in logout and returns to login', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(authorized())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<LoginScreen authenticatedView={AuthenticatedStub} />);
    await screen.findByRole('heading', { name: 'Angemeldet' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Abmelden' }));

    expect(await screen.findByRole('heading', { name: 'Anmelden' })).toBeTruthy();
    const [path, options] = fetchMock.mock.calls[1];
    expect(path).toBe('/api/v1/auth/logout');
    expect(options.headers['X-CSRF-Token']).toBe(csrf);
    expect(options.credentials).toBe('same-origin');
    expect(options.body).toBe('{}');
  });

  it('does not claim logout succeeded when the server rejects it', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(authorized())
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'CSRF_VALIDATION_FAILED' }), {
        status: 403,
        headers: { 'content-type': 'application/problem+json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    render(<LoginScreen authenticatedView={AuthenticatedStub} />);
    await screen.findByRole('heading', { name: 'Angemeldet' });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Abmelden' }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Angemeldet' })).toBeTruthy();
  });

  it('rejects a login response missing the CSRF header', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(new Response(JSON.stringify(identity), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    render(<LoginScreen authenticatedView={AuthenticatedStub} />);
    await screen.findByRole('heading', { name: 'Anmelden' });
    const user = await fillCredentials();
    await user.click(screen.getByRole('button', { name: 'Anmelden' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Antwort konnte nicht verarbeitet werden');
    expect(screen.queryByRole('heading', { name: 'Angemeldet' })).toBeNull();
  });

  it('lets the user attempt login if the initial session check hits a network error', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('private network diagnostic'));
    vi.stubGlobal('fetch', fetchMock);
    render(<LoginScreen authenticatedView={AuthenticatedStub} />);
    expect(await screen.findByRole('heading', { name: 'Anmelden' })).toBeTruthy();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Verbindung fehlgeschlagen');
    expect(alert.textContent).not.toContain('private network diagnostic');
  });
});
