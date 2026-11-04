// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/"}
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installDialogPolyfill } from '../../../shared/ui/native-dialog.test-support';
import { ApiError } from '../../../shared/api/api-error';
import { OwnCancellations } from './OwnCancellations';
import { employeeIdentity } from './my-month-plan.test-support';
import { cancellation } from './cancellation.test-support';
const request = vi.fn(),
  revalidate = vi.fn();
const api = { request };
let principal = employeeIdentity,
  items: unknown,
  mutation: () => Promise<unknown>;
const withdrawn = () => ({
  ...cancellation(),
  status: 'WITHDRAWN',
  replacementNeed: { ...cancellation().replacementNeed, status: 'CLOSED' },
});
const props = () => ({
  api,
  identity: principal,
  monthStart: '2026-12-01',
  revision: 0,
  revalidate,
});
function setup() {
  return render(<OwnCancellations {...props()} />);
}
async function open() {
  await userEvent
    .setup()
    .click(await screen.findByRole('button', { name: 'Absage zurückziehen' }));
  return screen.getByRole('dialog');
}
function send() {
  fireEvent.click(
    screen.getByRole('button', { name: 'Absage verbindlich zurückziehen' }),
  );
}
function pending() {
  let resolve!: (v: unknown) => void;
  const promise = new Promise<unknown>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(() => {
  installDialogPolyfill();
  request.mockReset();
  revalidate.mockReset();
  principal = employeeIdentity;
  items = { cancellationRequests: [cancellation()], replacementOffers: [] };
  mutation = async () => withdrawn();
  request.mockImplementation(async (path: string) =>
    path === '/api/v1/me'
      ? principal
      : path.includes('/work-items?')
        ? items
        : mutation(),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it('discovers own OPEN cancellation by month after remount and shows German status', async () => {
  const view = setup();
  await screen.findByText('Absage: Offen. Ersatzbedarf: Offen.');
  expect(request.mock.calls.map((c) => c[0])).toEqual([
    '/api/v1/me',
    '/api/v1/me/work-items?monthStart=2026-12-01',
  ]);
  view.unmount();
  setup();
  await screen.findByRole('button', { name: 'Absage zurückziehen' });
  expect(
    request.mock.calls.filter((c) => c[0].includes('/work-items?')),
  ).toHaveLength(2);
});
it('confirmation explains retained assignment, starts on safe button, traps focus and Escape returns focus', async () => {
  setup();
  const element = await open();
  expect(element.getAttribute('aria-labelledby')).toBeTruthy();
  expect(element.getAttribute('aria-describedby')).toBeTruthy();
  expect(
    screen.getByText(/Sie bleiben dem ursprünglichen Dienst zugeteilt/),
  ).toBeTruthy();
  const back = screen.getByRole('button', { name: 'Zurück' }),
    confirm = screen.getByRole('button', {
      name: 'Absage verbindlich zurückziehen',
    });
  expect(document.activeElement).toBe(back);
  fireEvent.keyDown(back, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(confirm);
  fireEvent.keyDown(confirm, { key: 'Tab' });
  expect(document.activeElement).toBe(back);
  fireEvent(element, new Event('cancel', { cancelable: true }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'Absage zurückziehen' }),
  );
  expect(
    request.mock.calls.filter((c) => c[1]?.method === 'POST'),
  ).toHaveLength(0);
});
it('fences synchronous double activation and uses exact bodyless request identity without a new receipt key', async () => {
  const p = pending();
  mutation = () => p.promise;
  setup();
  await open();
  const confirm = screen.getByRole('button', {
    name: 'Absage verbindlich zurückziehen',
  });
  act(() => {
    fireEvent.click(confirm);
    fireEvent.click(confirm);
  });
  const calls = request.mock.calls.filter((c) => c[1]?.method === 'POST');
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toBe(
    `/api/v1/cancellation-requests/${cancellation().id}/withdraw`,
  );
  expect(calls[0][1]).toEqual({
    method: 'POST',
    noBody: true,
    signal: expect.any(AbortSignal),
  });
  expect(confirm.hasAttribute('disabled')).toBe(true);
  expect(document.activeElement?.closest('dialog')).toBeTruthy();
  fireEvent(
    screen.getByRole('dialog'),
    new Event('cancel', { cancelable: true }),
  );
  expect(screen.getByRole('dialog')).toBeTruthy();
  await act(async () => p.resolve(withdrawn()));
  await screen.findByText(
    'Absage zurückgezogen. Sie bleiben dem Dienst zugeteilt.',
  );
  items = { cancellationRequests: [withdrawn()], replacementOffers: [] };
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Schließen' }));
  await screen.findByText('Absage: Zurückgezogen. Ersatzbedarf: Geschlossen.');
  expect(
    screen.queryByRole('button', { name: 'Absage zurückziehen' }),
  ).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole('heading', { name: 'Meine Absagen' }),
  );
});
it.each(['network', 'server', 'invalid'] as const)(
  'recovers uncertain %s outcome by the identical request without losing focus',
  async (kind) => {
    let n = 0;
    mutation = async () => {
      if (n++ === 0)
        throw kind === 'network'
          ? new ApiError('network', null, null, null)
          : kind === 'server'
            ? new ApiError('http', 500, 'INTERNAL_ERROR', null)
            : new ApiError('invalid-response', 200, null, null);
      return withdrawn();
    };
    setup();
    await open();
    send();
    await screen.findByText(/Das Ergebnis ist noch unklar/);
    const retry = screen.getByRole('button', {
      name: 'Dieselbe Rücknahme erneut versuchen',
    });
    expect(document.activeElement?.closest('dialog')).toBeTruthy();
    await userEvent.setup().click(retry);
    await screen.findByText(
      'Absage zurückgezogen. Sie bleiben dem Dienst zugeteilt.',
    );
    const calls = request.mock.calls.filter((c) => c[1]?.method === 'POST');
    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toBe(calls[0][0]);
  },
);
it('deadline aborts stalled transport; retry succeeds and late old completion cannot replace it', async () => {
  const p = pending();
  let n = 0;
  mutation = () => (n++ === 0 ? p.promise : Promise.resolve(withdrawn()));
  setup();
  await open();
  vi.useFakeTimers();
  send();
  await act(async () => vi.advanceTimersByTime(30_000));
  vi.useRealTimers();
  expect(screen.getByText(/Das Ergebnis ist noch unklar/)).toBeTruthy();
  const calls = request.mock.calls.filter((c) => c[1]?.method === 'POST');
  expect((calls[0][1].signal as AbortSignal).aborted).toBe(true);
  await userEvent.setup().click(
    screen.getByRole('button', {
      name: 'Dieselbe Rücknahme erneut versuchen',
    }),
  );
  await screen.findByText(
    'Absage zurückgezogen. Sie bleiben dem Dienst zugeteilt.',
  );
  await act(async () =>
    p.resolve({ ...withdrawn(), id: '70000000-0000-4000-8000-000000000002' }),
  );
  expect(
    screen.getByText('Absage zurückgezogen. Sie bleiben dem Dienst zugeteilt.'),
  ).toBeTruthy();
});
it.each([
  ['CANCELLATION_NOT_WITHDRAWABLE', 409],
  ['RESOURCE_NOT_FOUND', 404],
] as const)('stale %s requires current-status reload', async (code, status) => {
  mutation = async () => {
    throw new ApiError('http', status, code, null);
  };
  setup();
  await open();
  send();
  await screen.findByText(/Der Antrag kann nicht mehr zurückgezogen werden/);
  expect(
    screen.queryByRole('button', {
      name: 'Dieselbe Rücknahme erneut versuchen',
    }),
  ).toBeNull();
  items = {
    cancellationRequests: [{ ...withdrawn(), status: 'OBSOLETE' }],
    replacementOffers: [],
  };
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Aktuellen Status laden' }));
  await screen.findByText('Absage: Gegenstandslos. Ersatzbedarf: Geschlossen.');
});
it.each([401, 403])(
  'clears dialog and requests session revalidation after %s',
  async (status) => {
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
    await waitFor(() => expect(revalidate).toHaveBeenCalledOnce());
    expect(screen.queryByRole('dialog')).toBeNull();
  },
);
it.each(['APPROVED', 'REJECTED', 'WITHDRAWN', 'OBSOLETE'] as const)(
  'shows %s accurately with no withdrawal action',
  async (status) => {
    const item = withdrawn();
    items = {
      cancellationRequests: [
        {
          ...item,
          status,
          decidedAt: ['APPROVED', 'REJECTED'].includes(status)
            ? '2026-11-04T15:00:00.000Z'
            : null,
          replacementNeed: {
            ...item.replacementNeed,
            status: status === 'APPROVED' ? 'OPEN_UNFILLED' : 'CLOSED',
          },
        },
      ],
      replacementOffers: [],
    };
    setup();
    await screen.findByRole('article');
    expect(
      screen.queryByRole('button', { name: 'Absage zurückziehen' }),
    ).toBeNull();
  },
);
it('read failure has retry feedback and does not fabricate an empty successful status', async () => {
  request.mockRejectedValue(new ApiError('network', null, null, null));
  setup();
  await screen.findByRole('alert');
  expect(screen.queryByText('Keine Absagen für diesen Monat.')).toBeNull();
  request.mockImplementation(async (path: string) =>
    path === '/api/v1/me' ? principal : items,
  );
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Absagestatus aktualisieren' }));
  await screen.findByRole('article');
});
it('focus re-reads current state after reconciliation, but preserves an uncertain modal identity', async () => {
  setup();
  await screen.findByRole('article');
  items = {
    cancellationRequests: [{ ...withdrawn(), status: 'OBSOLETE' }],
    replacementOffers: [],
  };
  fireEvent.focus(window);
  await screen.findByText('Absage: Gegenstandslos. Ersatzbedarf: Geschlossen.');
  items = { cancellationRequests: [cancellation()], replacementOffers: [] };
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Absagestatus aktualisieren' }));
  mutation = async () => {
    throw new ApiError('network', null, null, null);
  };
  await open();
  send();
  await screen.findByText(/Das Ergebnis ist noch unklar/);
  const count = request.mock.calls.length;
  fireEvent.focus(window);
  expect(request.mock.calls).toHaveLength(count);
  expect(screen.getByRole('dialog')).toBeTruthy();
});
it('account/API boundary aborts pending withdrawal and ignores late success', async () => {
  const p = pending();
  mutation = () => p.promise;
  const view = setup();
  await open();
  send();
  const call = request.mock.calls.find((c) => c[1]?.method === 'POST');
  principal = {
    ...employeeIdentity,
    accountId: '20000000-0000-4000-8000-000000000002',
  };
  items = { cancellationRequests: [], replacementOffers: [] };
  view.rerender(<OwnCancellations {...props()} api={{ request }} />);
  expect((call![1].signal as AbortSignal).aborted).toBe(true);
  await act(async () => p.resolve(withdrawn()));
  await screen.findByText('Keine Absagen für diesen Monat.');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByText(/Absage zurückgezogen/)).toBeNull();
});
it('unmount aborts transport and ignores a later response', async () => {
  const p = pending();
  mutation = () => p.promise;
  const view = setup();
  await open();
  send();
  const call = request.mock.calls.find((c) => c[1]?.method === 'POST');
  view.unmount();
  expect((call![1].signal as AbortSignal).aborted).toBe(true);
  await act(async () => p.resolve(withdrawn()));
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('does not load private work-items when trusted current principal differs', async () => {
  request.mockResolvedValue({
    ...employeeIdentity,
    accountId: '20000000-0000-4000-8000-000000000002',
  });
  setup();
  await screen.findByRole('alert');
  expect(request).toHaveBeenCalledTimes(1);
  expect(revalidate).toHaveBeenCalledOnce();
  expect(screen.queryByRole('article')).toBeNull();
});
it('rejects a successful response for another request and permits same-ID recovery', async () => {
  mutation = async () => ({
    ...withdrawn(),
    id: '70000000-0000-4000-8000-000000000002',
  });
  setup();
  await open();
  send();
  await screen.findByText(/Das Ergebnis ist noch unklar/);
  expect(
    within(screen.getByRole('dialog')).queryByText(
      'Absage zurückgezogen. Sie bleiben dem Dienst zugeteilt.',
    ),
  ).toBeNull();
});
