// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/"}
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installDialogPolyfill } from '../../../shared/ui/native-dialog.test-support';
import { ApiError } from '../../../shared/api/api-error';
import { OpenDutiesPage } from './OpenDutiesPage';
import { need, offer, page } from './offer.test-support';
const request = vi.fn(),
  revalidate = vi.fn(),
  api = { request };
const identity = {
  accountId: '30000000-0000-4000-8000-000000000001',
  companyId: '30000000-0000-4000-8000-000000000002',
  role: 'EMPLOYEE' as const,
  email: 'employee@example.invalid',
};
let work: unknown, mutation: () => Promise<unknown>, needs: unknown;
const props = () => ({ api, identity, requestSessionRevalidation: revalidate });
function tree(p = props()) {
  return (
    <MemoryRouter initialEntries={['/offene-dienste/2027-01']}>
      <Routes>
        <Route
          path="/offene-dienste/:month?"
          element={<OpenDutiesPage {...p} />}
        />
      </Routes>
    </MemoryRouter>
  );
}
const setup = () => render(tree());
const posts = () => request.mock.calls.filter((c) => c[1]?.method === 'POST');
async function open() {
  await userEvent.setup().click(
    await screen.findByRole('button', {
      name: 'Als Ersatz anbieten',
    }),
  );
  await screen.findByRole('dialog');
}
const send = () =>
  fireEvent.click(
    screen.getByRole('button', { name: 'Angebot verbindlich abgeben' }),
  );
function pending() {
  let resolve!: (v: unknown) => void;
  const promise = new Promise<unknown>((r) => (resolve = r));
  return { promise, resolve };
}
beforeEach(() => {
  installDialogPolyfill();
  request.mockReset();
  revalidate.mockReset();
  work = { cancellationRequests: [], replacementOffers: [] };
  needs = page();
  mutation = async () => {
    work = { cancellationRequests: [], replacementOffers: [offer()] };
    return offer();
  };
  request.mockImplementation(
    async (path: string, options?: { method?: string }) =>
      options?.method === 'POST'
        ? mutation()
        : path === '/api/v1/me'
          ? {
              ...identity,
              companyTimeZone: 'Europe/Berlin',
              currentCompanyMonth: '2027-01-01',
            }
          : path.includes('/work-items?')
            ? work
            : path.includes('/me/replacement-needs?')
              ? needs
              : need(),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it('shows German saved-zone opportunities and accessible confirmation, safe focus and Escape', async () => {
  setup();
  await open();
  expect(screen.getByText(/Du gibst ein Ersatzangebot ab/)).toBeTruthy();
  const cancel = screen.getByRole('button', { name: 'Abbrechen' }),
    confirm = screen.getByRole('button', {
      name: 'Angebot verbindlich abgeben',
    });
  expect(document.activeElement).toBe(cancel);
  fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(confirm);
  fireEvent.keyDown(confirm, { key: 'Tab' });
  expect(document.activeElement).toBe(cancel);
  fireEvent(
    screen.getByRole('dialog'),
    new Event('cancel', { cancelable: true }),
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'Als Ersatz anbieten' }),
  );
  expect(posts()).toHaveLength(0);
});
it('synchronous double click sends one bodyless frozen-key command and recovers history', async () => {
  const p = pending();
  mutation = () => p.promise;
  setup();
  await open();
  act(() => {
    send();
    send();
  });
  expect(posts()).toHaveLength(1);
  expect(posts()[0][1]).toEqual({
    method: 'POST',
    noBody: true,
    idempotencyKey: expect.any(String),
    signal: expect.any(AbortSignal),
  });
  await act(async () => p.resolve(offer()));
  await screen.findByText(
    'Angebot abgegeben. Du bist noch nicht für diesen Dienst eingeplant.',
  );
});
it('lost response retains exact key for explicit retry with no automatic POST', async () => {
  let count = 0;
  mutation = async () => {
    if (count++ === 0) throw new ApiError('network', null, null, null);
    return offer();
  };
  setup();
  await open();
  send();
  await screen.findByText(/Das Ergebnis ist noch unklar/);
  const key = posts()[0][1].idempotencyKey;
  expect(posts()).toHaveLength(1);
  fireEvent.click(
    screen.getByRole('button', { name: 'Denselben Versuch erneut senden' }),
  );
  await screen.findByText(/Angebot abgegeben. Du bist noch nicht/);
  expect(posts()[1][1].idempotencyKey).toBe(key);
});
it('failed recovery read retains uncertainty and status recovery avoids fresh writes', async () => {
  mutation = async () => {
    work = { cancellationRequests: [], replacementOffers: [offer()] };
    throw new ApiError('network', null, null, null);
  };
  setup();
  await open();
  send();
  await screen.findByText(/Das Ergebnis ist noch unklar/);
  fireEvent.click(screen.getByRole('button', { name: 'Status prüfen' }));
  await screen.findByText(/Angebot abgegeben. Du bist noch nicht/);
  expect(posts()).toHaveLength(1);
});
it('closed conflict provides refresh recovery', async () => {
  mutation = async () => {
    throw new ApiError('http', 409, 'REPLACEMENT_NEED_NOT_OPEN', null);
  };
  setup();
  await open();
  send();
  await screen.findByText(/Der Dienst ist nicht mehr verfügbar/);
  expect(
    screen.queryByRole('button', { name: 'Denselben Versuch erneut senden' }),
  ).toBeNull();
});
it.each([401, 403])('invalidates session on command %s', async (status) => {
  mutation = async () => {
    throw new ApiError(
      'http',
      status,
      status === 401 ? 'SESSION_REVOKED' : 'ACTION_FORBIDDEN',
      null,
    );
  };
  setup();
  await open();
  send();
  await waitFor(() => expect(revalidate).toHaveBeenCalled());
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('unmount aborts a pending command and ignores its late result', async () => {
  const p = pending();
  mutation = () => p.promise;
  const view = setup();
  await open();
  send();
  const signal = posts()[0][1].signal;
  view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => p.resolve(offer()));
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('account or API capability change synchronously closes private command state', async () => {
  const p = pending();
  mutation = () => p.promise;
  const view = setup();
  await open();
  send();
  view.rerender(
    tree({ ...props(), identity: { ...identity, accountId: need().id } }),
  );
  expect(posts()[0][1].signal.aborted).toBe(true);
  expect(screen.queryByRole('dialog')).toBeNull();
  await act(async () => p.resolve(offer()));
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('reload/relogin reconstructs terminal own history without any persisted key or POST', async () => {
  work = {
    cancellationRequests: [],
    replacementOffers: [
      {
        ...offer(),
        status: 'INVALIDATED',
        decidedAt: '2026-11-05T06:01:00.000Z',
      },
    ],
  };
  const view = setup();
  await screen.findByText(/Nicht mehr gültig/);
  view.unmount();
  setup();
  await screen.findByText(/Nicht mehr gültig/);
  expect(posts()).toHaveLength(0);
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
});
it('shows empty opportunities and disables existing active offer', async () => {
  needs = { ...page(), items: [{ need: need(), myOffer: offer() }] };
  setup();
  expect(
    (
      await screen.findByRole('button', { name: 'Angebot bereits abgegeben' })
    ).hasAttribute('disabled'),
  ).toBe(true);
});

it('recovery read failure leaves uncertainty intact without a fresh POST', async () => {
  mutation = async () => {
    throw new ApiError('network', null, null, null);
  };
  setup();
  await open();
  send();
  await screen.findByText(/Das Ergebnis ist noch unklar/);
  const original = request.getMockImplementation()!;
  request.mockImplementation((path: string, options: unknown) =>
    path.includes('/work-items?')
      ? Promise.reject(new ApiError('network', null, null, null))
      : original(path, options),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Status prüfen' }));
  await screen.findByText(
    'Status konnte nicht geprüft werden. Das Ergebnis bleibt unklar.',
  );
  expect(screen.getByText(/Das Ergebnis ist noch unklar/)).toBeTruthy();
  expect(posts()).toHaveLength(1);
});
it('bounded timeout aborts the request and preserves the same uncertain attempt', async () => {
  setup();
  await open();
  const original = request.getMockImplementation()!;
  request.mockImplementation(
    (path: string, options: { method?: string; signal?: AbortSignal }) =>
      options?.method === 'POST'
        ? new Promise((_resolve, reject) =>
            options.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            ),
          )
        : original(path, options),
  );
  vi.useFakeTimers();
  send();
  const key = posts()[0][1].idempotencyKey;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(posts()[0][1].signal.aborted).toBe(true);
  expect(screen.getByText(/Das Ergebnis ist noch unklar/)).toBeTruthy();
  expect(posts()).toHaveLength(1);
  expect(posts()[0][1].idempotencyKey).toBe(key);
});
