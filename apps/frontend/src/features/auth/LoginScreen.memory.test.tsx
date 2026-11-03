// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/"}
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginScreen, type AuthenticatedSession } from './LoginScreen';
import { useSessionMemory } from './session-memory';
import type { SessionApi } from './session-api';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const principal = { accountId: '11111111-1111-4111-8111-111111111111', companyId: '22222222-2222-4222-8222-222222222222', role: 'COMPANY_ADMIN', email: 'a@example.invalid' };
const authenticated = (change: object = {}) => new Response(JSON.stringify({ ...principal, ...change, companyTimeZone: 'Europe/Berlin', currentCompanyMonth: '2026-12-01' }), { status: 200, headers: { 'x-csrf-token': 'c'.repeat(43) } });
const revoked = () => new Response(JSON.stringify({ code: 'SESSION_REVOKED' }), { status: 401 });

describe('login boundary draft capabilities', () => {
  it.each([{}, { accountId: '33333333-3333-4333-8333-333333333333' }, { companyId: '44444444-4444-4444-8444-444444444444' }, { role: 'EMPLOYEE' }])('hides data on 401, restores only the same principal, and disables stale APIs: %j', async (change) => {
    let oldApi: SessionApi | null = null;
    function Protected(session: AuthenticatedSession) {
      const memory = useSessionMemory();
      oldApi ??= session.api;
      return <>
        <h1>Protected</h1>
        <p>{String(memory?.read('plan:person') ?? 'Empty')}</p>
        <button onClick={() => { memory?.write('plan:person', 'Private selection'); }}>Edit</button>
        <button onClick={() => { void session.api.request('/api/v1/probe').catch(() => {}); }}>Request</button>
      </>;
    }
    const fetchMock = vi.fn().mockResolvedValueOnce(authenticated()).mockResolvedValueOnce(revoked()).mockResolvedValueOnce(authenticated(change));
    vi.stubGlobal('fetch', fetchMock);
    render(<LoginScreen authenticatedView={Protected} />);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Protected' });
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Request' }));
    await screen.findByRole('heading', { name: 'Anmelden' });
    expect(screen.queryByText('Private selection')).toBeNull();
    await user.type(screen.getByLabelText('E-Mail-Adresse'), 'a@example.invalid');
    await user.type(screen.getByLabelText('Passwort'), 'synthetic password');
    await user.click(screen.getByRole('button', { name: 'Anmelden' }));
    await screen.findByRole('heading', { name: 'Protected' });
    expect(screen.getByText(Object.keys(change).length ? 'Empty' : 'Private selection')).toBeTruthy();
    const calls = fetchMock.mock.calls.length;
    await expect(oldApi!.request('/api/v1/probe', { method: 'POST', body: {} })).rejects.toThrow('Session is no longer active');
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });
});
