// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/"}
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginScreen, type AuthenticatedSession } from './LoginScreen';
import type { SessionSignal } from './session-channel';
import type { SessionApi } from './session-api';

const a = {
  accountId: '11111111-1111-4111-8111-111111111111',
  companyId: '22222222-2222-4222-8222-222222222222',
  email: 'a@example.invalid',
  role: 'EMPLOYEE',
};
const b = { ...a, accountId: '33333333-3333-4333-8333-333333333333', email: 'b@example.invalid' };
const authorized = (principal = a, token = 'a') =>
  new Response(
    JSON.stringify({
      ...principal,
      companyTimeZone: 'Europe/Berlin',
      currentCompanyMonth: '2026-12-01',
    }),
    { status: 200, headers: { 'x-csrf-token': token.repeat(43) } },
  );
const problem = (status: number) =>
  new Response(JSON.stringify({ code: status === 401 ? 'SESSION_REVOKED' : 'INTERNAL_ERROR' }), {
    status,
  });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function harness() {
  const first = deferred<Response>(),
    fresh = deferred<Response>(),
    third = deferred<Response>(),
    oldProbe = deferred<Response>();
  const fetcher = vi.fn((path: string) => {
    if (path === '/api/v1/me') {
      const number = fetcher.mock.calls.filter(([url]) => url === '/api/v1/me').length;
      return number === 1
        ? Promise.resolve(authorized())
        : number === 2
          ? first.promise
          : number === 3
            ? fresh.promise
            : third.promise;
    }
    return oldProbe.promise;
  });
  vi.stubGlobal('fetch', fetcher);
  let signal!: (value: SessionSignal) => void;
  const rendered: SessionApi[] = [],
    sessions: AuthenticatedSession[] = [];
  function PrivateView(session: AuthenticatedSession) {
    rendered.push(session.api);
    sessions.push(session);
    return <p>Private schedule {session.identity.email}</p>;
  }
  const view = render(
    <LoginScreen
      authenticatedView={PrivateView}
      openChannel={(receive) => {
        signal = receive;
        return { post: vi.fn(), close: vi.fn() };
      }}
    />,
  );
  return {
    first,
    fresh,
    third,
    oldProbe,
    fetcher,
    rendered,
    sessions,
    view,
    signal: (value: SessionSignal) => act(() => signal(value)),
    meCalls: () => fetcher.mock.calls.filter(([url]) => url === '/api/v1/me').length,
  };
}
describe('SP14-RV-01 superseding authoritative revalidation', () => {
  it.each(['different account', 'same account'])(
    '%s: queued signal skips old200, gets fresh identity, ignores old business401',
    async (mode) => {
      const h = harness();
      await screen.findByText('Private schedule a@example.invalid');
      const oldApi = h.sessions.at(-1)!.api;
      const late = oldApi.request('/api/v1/private-probe').catch((error) => error);
      h.signal('signed-in');
      expect(h.meCalls()).toBe(2);
      h.signal('signed-in');
      h.signal('signed-in');
      expect(h.meCalls()).toBe(2);
      h.rendered.length = 0;
      await act(async () => h.first.resolve(authorized(a)));
      expect(h.rendered).toEqual([]);
      expect(screen.queryByText(/Private schedule/)).toBeNull();
      expect(h.meCalls()).toBe(3);
      const principal = mode === 'same account' ? a : b;
      await act(async () => h.fresh.resolve(authorized(principal, 'b')));
      await screen.findByText(`Private schedule ${principal.email}`);
      const newApi = h.sessions.at(-1)!.api;
      expect(newApi).not.toBe(oldApi);
      expect(h.rendered).not.toContain(oldApi);
      await act(async () => {
        h.oldProbe.resolve(problem(401));
        await late;
      });
      expect(screen.getByText(`Private schedule ${principal.email}`)).toBeTruthy();
      expect(screen.queryByRole('heading', { name: 'Anmelden' })).toBeNull();
      const calls = h.fetcher.mock.calls.length;
      await expect(oldApi.request('/api/v1/private-probe')).rejects.toThrow(
        'Session is no longer active',
      );
      expect(h.fetcher).toHaveBeenCalledTimes(calls);
    },
  );
  it.each(['401', '500', 'network', 'malformed'])(
    'obsolete %s cannot sign out or replace the fresh session check',
    async (outcome) => {
      const h = harness();
      await screen.findByText('Private schedule a@example.invalid');
      h.signal('signed-in');
      h.signal('signed-in');
      h.rendered.length = 0;
      await act(async () => {
        if (outcome === 'network') h.first.reject(new TypeError('synthetic network failure'));
        else
          h.first.resolve(
            outcome === 'malformed'
              ? new Response('{}', { status: 200 })
              : problem(Number(outcome)),
          );
      });
      expect(h.rendered).toEqual([]);
      expect(h.meCalls()).toBe(3);
      expect(screen.queryByRole('heading', { name: 'Anmelden' })).toBeNull();
      await act(async () => h.fresh.resolve(authorized(b, 'b')));
      await screen.findByText('Private schedule b@example.invalid');
    },
  );
  it('a signal during the queued check supersedes that check and starts only one latest request', async () => {
    const h = harness();
    await screen.findByText('Private schedule a@example.invalid');
    h.signal('signed-in');
    h.signal('signed-in');
    await act(async () => h.first.resolve(authorized(a)));
    expect(h.meCalls()).toBe(3);
    h.signal('signed-in');
    h.signal('signed-in');
    h.rendered.length = 0;
    await act(async () => h.fresh.resolve(authorized(b, 'b')));
    expect(h.rendered).toEqual([]);
    expect(h.meCalls()).toBe(4);
    await act(async () => h.third.resolve(authorized(b, 'c')));
    await screen.findByText('Private schedule b@example.invalid');
    expect(h.meCalls()).toBe(4);
  });
  it.each([401, 500])(
    'the latest authoritative failure %s fails closed without restoring the old view',
    async (status) => {
      const h = harness();
      await screen.findByText('Private schedule a@example.invalid');
      h.signal('signed-in');
      h.signal('signed-in');
      h.rendered.length = 0;
      await act(async () => h.first.resolve(authorized(a)));
      expect(h.meCalls()).toBe(3);
      await act(async () => h.fresh.resolve(problem(status)));
      await screen.findByRole('heading', { name: 'Anmelden' });
      expect(h.rendered).toEqual([]);
      expect(h.meCalls()).toBe(3);
    },
  );
  it('signed-out cancels a queued signed-in check without automatic sign-in', async () => {
    const h = harness();
    await screen.findByText('Private schedule a@example.invalid');
    h.signal('signed-in');
    h.signal('signed-in');
    h.signal('signed-out');
    await act(async () => h.first.resolve(authorized(a)));
    await screen.findByRole('heading', { name: 'Anmelden' });
    expect(h.meCalls()).toBe(2);
    expect(screen.queryByText(/Private schedule/)).toBeNull();
  });
  it('unmount prevents a queued check from making another request', async () => {
    const h = harness();
    await screen.findByText('Private schedule a@example.invalid');
    h.signal('signed-in');
    h.signal('signed-in');
    h.view.unmount();
    await act(async () => h.first.resolve(authorized(a)));
    expect(h.meCalls()).toBe(2);
  });
});
