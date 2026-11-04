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
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installDialogPolyfill } from '../../../shared/ui/native-dialog.test-support';
import { ApiError } from '../../../shared/api/api-error';
import type { SessionApi } from '../../auth/session-api';
import { CancellationAction } from './CancellationAction';
import { employeeIdentity, personalPlan } from './my-month-plan.test-support';
import { cancellation } from './cancellation.test-support';
const request = vi.fn(),
  stale = vi.fn(),
  revalidate = vi.fn();
const api: SessionApi = { request };
const props = () => ({
  api,
  identity: employeeIdentity,
  duty: personalPlan().items[0].duties[0],
  project: 'Synthetic Nord',
  onStale: stale,
  revalidate,
});
function setup() {
  return render(<CancellationAction {...props()} />);
}
async function open() {
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Dienst absagen' }));
  return screen.getByRole('dialog');
}
function send() {
  fireEvent.click(
    screen.getByRole('button', { name: 'Absage verbindlich einreichen' }),
  );
}
function pending() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(() => {
  installDialogPolyfill();
  request.mockReset();
  stale.mockReset();
  revalidate.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('opens labelled confirmation for selected date, shift, project and assignment; closing returns focus', async () => {
  setup();
  const dialog = await open();
  expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
  expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
  expect(screen.getByText(/31.12.2026.*Nachtdienst/)).toBeTruthy();
  expect(
    screen.getByText(/Ihr zugeteilter Dienst bleibt bestehen/),
  ).toBeTruthy();
  expect(request).not.toHaveBeenCalled();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Zurück' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'Dienst absagen' }),
  );
});
it('synchronously fences double clicks before a render or HTTP response', async () => {
  const p = pending();
  request.mockReturnValue(p.promise);
  setup();
  await open();
  const button = screen.getByRole('button', {
    name: 'Absage verbindlich einreichen',
  });
  act(() => {
    fireEvent.click(button);
    fireEvent.click(button);
  });
  expect(request).toHaveBeenCalledTimes(1);
  expect(button.hasAttribute('disabled')).toBe(true);
  expect(request.mock.calls[0][1]).toMatchObject({
    method: 'POST',
    body: { assignmentId: personalPlan().items[0].duties[0].assignmentId },
    expectedVersion: 1,
  });
  await act(async () => p.resolve(cancellation()));
  expect(screen.getByRole('status').textContent).toContain(
    'Absage eingereicht: Offen',
  );
});
it('network uncertainty retains the exact key/version/payload and blocks Escape/new-key retries', async () => {
  request
    .mockRejectedValueOnce(new TypeError('network'))
    .mockResolvedValueOnce(cancellation());
  setup();
  await open();
  send();
  await screen.findByText(/Das Ergebnis ist noch unklar/);
  const dialog = screen.getByRole('dialog');
  fireEvent(dialog, new Event('cancel', { cancelable: true }));
  expect(screen.getByRole('dialog')).toBe(dialog);
  await userEvent
    .setup()
    .click(
      screen.getByRole('button', { name: 'Dieselbe Anfrage erneut versuchen' }),
    );
  await screen.findByText(/Absage eingereicht: Offen/);
  expect(request).toHaveBeenCalledTimes(2);
  const first = request.mock.calls[0][1],
    second = request.mock.calls[1][1];
  expect(second.idempotencyKey).toBe(first.idempotencyKey);
  expect(second.body).toEqual(first.body);
  expect(second.expectedVersion).toBe(first.expectedVersion);
});
it.each([
  new ApiError('http', 409, 'IDEMPOTENCY_REQUEST_IN_PROGRESS', null),
  new ApiError('http', 500, 'INTERNAL_ERROR', null),
  new ApiError('invalid-response', 201, null, null),
])('keeps ambiguous failure recoverable with same key %j', async (error) => {
  request.mockRejectedValueOnce(error).mockResolvedValueOnce(cancellation());
  setup();
  await open();
  send();
  await screen.findByText(/Das Ergebnis ist noch unklar/);
  await userEvent
    .setup()
    .click(
      screen.getByRole('button', { name: 'Dieselbe Anfrage erneut versuchen' }),
    );
  await screen.findByText(/Absage eingereicht: Offen/);
  expect(request.mock.calls[1][1].idempotencyKey).toBe(
    request.mock.calls[0][1].idempotencyKey,
  );
});
it.each([
  'PLAN_CONCURRENT_MODIFICATION',
  'CANCELLATION_ASSIGNMENT_NOT_ACTIVE',
  'CANCELLATION_PLAN_CHANGED',
] as const)(
  'reloads and requires new explicit confirmation on %s',
  async (code) => {
    request.mockRejectedValueOnce(new ApiError('http', 409, code, null));
    setup();
    await open();
    send();
    await waitFor(() => expect(stale).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  },
);
it('does not fabricate existing request identity after different-key duplicate', async () => {
  request.mockRejectedValue(
    new ApiError('http', 409, 'CANCELLATION_ALREADY_EXISTS', null),
  );
  setup();
  await open();
  send();
  await screen.findByText(
    'Für diesen Dienst liegt bereits eine offene Absage vor.',
  );
  expect(
    screen.queryByRole('button', { name: 'Dieselbe Anfrage erneut versuchen' }),
  ).toBeNull();
});
it.each([401, 403])(
  'clears command state and revalidates authorization on status %s',
  async (status) => {
    request.mockRejectedValue(
      new ApiError(
        'http',
        status,
        status === 401 ? 'SESSION_REVOKED' : 'ACTION_FORBIDDEN',
        null,
      ),
    );
    setup();
    await open();
    send();
    await waitFor(() => expect(revalidate).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
  },
);
it.each(['account', 'tenant', 'api'] as const)(
  'aborts and ignores late result after %s changes',
  async (change) => {
    const p = pending();
    request.mockReturnValue(p.promise);
    const view = setup();
    await open();
    send();
    const old = request.mock.calls[0][1];
    const next = props();
    if (change === 'account')
      next.identity = {
        ...employeeIdentity,
        accountId: '10000000-0000-4000-8000-000000000001',
      };
    if (change === 'tenant')
      next.identity = {
        ...employeeIdentity,
        companyId: '10000000-0000-4000-8000-000000000001',
      };
    if (change === 'api') next.api = { request: vi.fn() };
    view.rerender(<CancellationAction {...next} />);
    expect(old.signal.aborted).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => p.resolve(cancellation()));
    expect(screen.queryByText(/Absage eingereicht: Offen/)).toBeNull();
    expect(stale).not.toHaveBeenCalled();
  },
);
it('aborts and ignores late HTTP success after navigation/unmount', async () => {
  const p = pending();
  request.mockReturnValue(p.promise);
  const view = setup();
  await open();
  send();
  const options = request.mock.calls[0][1];
  view.unmount();
  expect(options.signal.aborted).toBe(true);
  await act(async () => p.resolve(cancellation()));
  expect(stale).not.toHaveBeenCalled();
  expect(revalidate).not.toHaveBeenCalled();
});
it('shows coherent obsolete replay and retains the original duty in the view', async () => {
  const result = cancellation();
  result.status = 'OBSOLETE';
  result.replacementNeed.status = 'CLOSED';
  request.mockResolvedValue(result);
  setup();
  await open();
  send();
  await screen.findByText(/Absage eingereicht: Gegenstandslos.*Geschlossen/);
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Schließen' }));
  expect(
    screen
      .getByRole('button', { name: 'Absage eingereicht' })
      .hasAttribute('disabled'),
  ).toBe(true);
});

it('response timeout preserves the frozen attempt and ignores a late HTTP success', async () => {
  vi.useFakeTimers();
  try {
    const late = pending();
    request
      .mockReturnValueOnce(late.promise)
      .mockResolvedValueOnce(cancellation());
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Dienst absagen' }));
    send();
    const frozen = request.mock.calls[0][1];
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(frozen.signal.aborted).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain(
      'Das Ergebnis ist noch unklar',
    );
    await act(async () => late.resolve(cancellation()));
    expect(screen.queryByText(/Absage eingereicht: Offen/)).toBeNull();
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Dieselbe Anfrage erneut versuchen',
        }),
      );
    });
    expect(request.mock.calls[1][1].idempotencyKey).toBe(frozen.idempotencyKey);
    expect(screen.getByRole('status').textContent).toContain(
      'Absage eingereicht: Offen',
    );
  } finally {
    vi.useRealTimers();
  }
});
