// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/arbeitsuebersicht"}
/**
 * SP-21 S5: REJECT and APPROVE without replacement in the existing case view, coordinated with SP-20 selection.
 * The API double answers by method and path; every request is recorded to prove what was (not) sent.
 */
import { useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { APP_ROUTES, type AppRoute } from '../../../app/routes';
import { ApiError } from '../../../shared/api/api-error';
import type { IdentityContext } from '../../auth/auth-api';
import type { SessionApi, SessionRequest } from '../../auth/session-api';
import { WorkQueueSection } from './WorkQueueSection';
import {
  CANCELLATION_ID,
  IDENTITY,
  NEED_ID,
  caseContext,
  decidedContext,
  decisionReceipt,
  offersPage,
  recordingApi,
  threeOffers,
} from './work-queue.test-support';
import type { CaseContext, OffersPage } from './work-queue-types';

const CASE_PATH = `/arbeitsuebersicht/${NEED_ID}`;
const DECISION_PATH = `/api/v1/cancellation-requests/${CANCELLATION_ID}/decision`;

function workQueueRoute(): AppRoute {
  const route = APP_ROUTES.find((candidate) => candidate.id === 'work-queue');
  if (!route) throw new Error('work-queue route missing');
  return route;
}

type Posted = { path: string; options: SessionRequest };
type Handler = (path: string, options: SessionRequest) => unknown;

/** `read` answers every GET of the case; `write` answers every POST. */
function setup(read: () => OffersPage, write: Handler) {
  const posts: Posted[] = [];
  const { api, requests } = recordingApi((path, options) => {
    if (options.method === 'POST') {
      posts.push({ path, options });
      return write(path, options);
    }
    if (path.startsWith('/api/v1/replacement-needs/')) return read();
    throw new Error(`unexpected request: ${path}`);
  });
  return { api, posts, gets: () => requests.filter((r) => r.method === 'GET').length };
}

function renderWith(api: SessionApi, identity: IdentityContext = IDENTITY, path = CASE_PATH) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/arbeitsuebersicht/*" element={<WorkQueueSection route={workQueueRoute()} api={api} identity={identity} />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** A read that switches to the decided state once a write was accepted. */
function readAfter(decision: 'REJECT' | 'APPROVE', items = threeOffers()) {
  let decided = false;
  return {
    read: () => (decided ? offersPage(items.map((o) => (o.status === 'OPEN' ? { ...o, status: 'NOT_SELECTED' as const, decidedAt: '2026-12-15T11:00:00.000Z', reviewEligibility: 'NOT_APPLICABLE' as const } : o)), decidedContext(decision)) : offersPage(items)),
    commit: () => {
      decided = true;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function openCase() {
  await screen.findByRole('heading', { level: 2, name: 'Absage ohne Ersatz entscheiden' });
}
const confirmGroup = (name: RegExp) => screen.getByRole('group', { name });
const button = (name: string | RegExp) => screen.getByRole('button', { name });

afterEach(() => {
  cleanup();
});

describe('SP-21 S5 — confirmation before any write', () => {
  it('REJECT explains that the original membership stays active and that all open offers become NOT_SELECTED', async () => {
    const user = userEvent.setup();
    const { api, posts } = setup(() => offersPage(threeOffers()), () => decisionReceipt('REJECT'));
    renderWith(api);
    await openCase();
    expect(screen.getByText(/auch wenn geeignete Angebote vorliegen/)).toBeTruthy();
    await user.click(button('Ablehnen'));
    const group = confirmGroup(/Absage ablehnen\?/);
    expect(group.textContent).toContain('Die ursprüngliche Zuordnung bleibt aktiv');
    expect(group.textContent).toContain('Der Ersatzbedarf wird geschlossen');
    expect(group.textContent).toContain('auf „Nicht ausgewählt“ gesetzt werden: 3 (davon aktuell geeignet: 1)');
    // Focus moves into the confirmation; nothing has been sent.
    expect(document.activeElement).toBe(within(group).getByRole('heading', { name: 'Absage ablehnen?' }));
    expect(posts).toEqual([]);
  });

  it('APPROVE explains removal, a still-published duty and a visible unfilled need', async () => {
    const user = userEvent.setup();
    const { api, posts } = setup(() => offersPage(threeOffers()), () => decisionReceipt('APPROVE'));
    renderWith(api);
    await openCase();
    await user.click(button('Ohne Ersatz genehmigen'));
    const text = confirmGroup(/Absage ohne Ersatz genehmigen\?/).textContent ?? '';
    expect(text).toContain('Die ursprüngliche Zuordnung wird entfernt');
    expect(text).toContain('Der Dienst bleibt veröffentlicht');
    expect(text).toContain('„Unbesetzt“ in der Arbeitsübersicht sichtbar');
    expect(posts).toEqual([]);
  });

  it('Abbrechen and Escape close the confirmation without a request and return focus to the opener', async () => {
    const user = userEvent.setup();
    const { api, posts } = setup(() => offersPage(threeOffers()), () => decisionReceipt('REJECT'));
    renderWith(api);
    await openCase();
    await user.click(button('Ablehnen'));
    await user.click(within(confirmGroup(/Absage ablehnen\?/)).getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() => expect(document.activeElement).toBe(button('Ablehnen')));
    // Keyboard only: open with Enter, close with Escape.
    button('Ohne Ersatz genehmigen').focus();
    await user.keyboard('{Enter}');
    expect(confirmGroup(/Absage ohne Ersatz genehmigen\?/)).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: /genehmigen\?/ })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(button('Ohne Ersatz genehmigen')));
    expect(posts).toEqual([]);
  });
});

describe('SP-21 S5 — successful decisions', () => {
  it('REJECT posts {decision:REJECT} with a key and no version, announces the receipt outcome and reloads', async () => {
    const user = userEvent.setup();
    const state = readAfter('REJECT');
    const { api, posts, gets } = setup(state.read, () => {
      state.commit();
      return decisionReceipt('REJECT');
    });
    renderWith(api);
    await openCase();
    const before = gets();
    await user.click(button('Ablehnen'));
    await user.click(button('Ablehnung bestätigen'));
    const done = await screen.findByText('Absage abgelehnt. Die ursprüngliche Zuordnung bleibt aktiv; der Ersatzbedarf ist geschlossen.');
    expect(done.getAttribute('role')).toBe('status');
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe(DECISION_PATH);
    expect(posts[0].options.body).toEqual({ decision: 'REJECT' });
    expect(posts[0].options.expectedVersion).toBeUndefined();
    expect(posts[0].options.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(gets()).toBeGreaterThan(before));
    // The reloaded server state is shown; no decision is offered any more.
    expect(await screen.findByText('Dieser Vorgang ist nicht mehr offen und wird nicht als ausstehende Arbeit geführt.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ablehnen' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ersatz auswählen' })).toBeNull();
  });

  it.each([
    ['multiple', threeOffers()],
    ['zero', []],
  ])('APPROVE with %s open offers sends both server versions and shows the unfilled outcome', async (_n, items) => {
    const user = userEvent.setup();
    const state = readAfter('APPROVE', items);
    const { api, posts } = setup(state.read, () => {
      state.commit();
      return decisionReceipt('APPROVE');
    });
    renderWith(api);
    await openCase();
    await user.click(button('Ohne Ersatz genehmigen'));
    await user.click(button('Genehmigung ohne Ersatz bestätigen'));
    expect(await screen.findByText(/Absage ohne Ersatz genehmigt\./)).toBeTruthy();
    expect(posts).toHaveLength(1);
    expect(posts[0].options.expectedVersion).toBe(1); // need version
    expect(posts[0].options.body).toEqual({ decision: 'APPROVE', expectedDutyVersion: 4 }); // duty version, not the need version
    const status = screen.getByRole('heading', { level: 2, name: 'Vorgangsstatus' }).closest('section');
    await waitFor(() => expect(status?.textContent).toContain('Unbesetzt'));
    expect(screen.queryByRole('button', { name: 'Ohne Ersatz genehmigen' })).toBeNull();
  });

  it('a decision never shows a success that the receipt does not confirm (malformed 200 stays uncertain)', async () => {
    const user = userEvent.setup();
    const { api, posts } = setup(() => offersPage(threeOffers()), () => ({ ...decisionReceipt('REJECT'), selectedOffer: {} }));
    renderWith(api);
    await openCase();
    await user.click(button('Ablehnen'));
    await user.click(button('Ablehnung bestätigen'));
    expect(await screen.findByText(/Das Ergebnis ist nicht bestätigt/)).toBeTruthy();
    expect(screen.queryByText(/Absage abgelehnt\./)).toBeNull();
    expect(posts).toHaveLength(1);
  });
});

describe('SP-21 S5 — no actionable decision for a case that is not open and consistent', () => {
  const variants: [string, CaseContext][] = [
    ['rejected', decidedContext('REJECT')],
    ['approved and unfilled', decidedContext('APPROVE')],
    ['inconsistent', caseContext({ consistency: 'INCONSISTENT' })],
    ['with a removed duty', caseContext({ dutyRemoved: true })],
    ['with an inactive original membership', caseContext({ originalAssignmentActive: false })],
  ];
  it.each(variants)('%s', async (_n, context) => {
    const { api } = setup(() => offersPage([], context), () => {
      throw new Error('no write expected');
    });
    renderWith(api);
    await screen.findByRole('heading', { level: 2, name: 'Vorgangsstatus' });
    expect(screen.queryByRole('heading', { name: 'Absage ohne Ersatz entscheiden' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Ablehnen|Ohne Ersatz genehmigen/ })).toBeNull();
  });
});

describe('SP-21 S5 — refusals', () => {
  it.each([
    [409, 'PLAN_CONCURRENT_MODIFICATION', 'Der Vorgang wurde inzwischen geändert. Die Daten wurden neu geladen.'],
    [409, 'CANCELLATION_ALREADY_RESOLVED', 'Dieser Vorgang ist bereits entschieden. Die Daten wurden neu geladen.'],
    [409, 'RESOURCE_EDIT_LOCKED', 'Der Dienst wird gerade im Plan bearbeitet. Versuchen Sie es in einer Minute erneut. Die Daten wurden neu geladen.'],
    [404, 'RESOURCE_NOT_FOUND', 'Dieser Vorgang ist nicht mehr sichtbar. Die Daten wurden neu geladen.'],
  ] as const)('%i %s closes the stale confirmation, explains it and reloads once', async (status, code, text) => {
    const user = userEvent.setup();
    const { api, posts, gets } = setup(() => offersPage(threeOffers()), () => {
      throw new ApiError('http', status, code, null);
    });
    renderWith(api);
    await openCase();
    await user.click(button('Ohne Ersatz genehmigen'));
    const before = gets();
    await user.click(button('Genehmigung ohne Ersatz bestätigen'));
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.getByText(text).getAttribute('role')).toBe('alert');
    await waitFor(() => expect(gets()).toBe(before + 1));
    expect(screen.queryByRole('group', { name: /genehmigen\?/ })).toBeNull();
    expect(posts).toHaveLength(1);
  });

  it.each([
    [403, 'ACTION_FORBIDDEN', 'Für diese Aktion fehlt die Berechtigung.'],
    [401, 'SESSION_EXPIRED', 'Die Entscheidung wurde nicht angenommen.'],
  ] as const)('%i fails closed without a reload loop', async (status, code, text) => {
    const user = userEvent.setup();
    const { api, posts, gets } = setup(() => offersPage(threeOffers()), () => {
      throw new ApiError('http', status, code, null);
    });
    renderWith(api);
    await openCase();
    await user.click(button('Ablehnen'));
    const before = gets();
    await user.click(button('Ablehnung bestätigen'));
    expect(await screen.findByText(new RegExp(text))).toBeTruthy();
    // Give any accidental reload a chance to happen.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(gets()).toBe(before);
    expect(posts).toHaveLength(1);
  });
});

describe('SP-21 S5 — one write per case, coordinated with SP-20', () => {
  it('while REJECT is in flight, nothing else can be submitted: confirm, other decision and SP-20 selection are disabled', async () => {
    const user = userEvent.setup();
    const pending = deferred<unknown>();
    const { api, posts } = setup(() => offersPage(threeOffers()), () => pending.promise);
    renderWith(api);
    await openCase();
    await user.click(button('Ablehnen'));
    await user.click(button('Ablehnung bestätigen'));
    expect(await screen.findByText('Ablehnung wird gespeichert …')).toBeTruthy();
    expect((button('Ablehnung bestätigen') as HTMLButtonElement).disabled).toBe(true);
    await user.click(button('Ablehnung bestätigen'));
    expect(screen.queryByRole('button', { name: 'Ohne Ersatz genehmigen' })).toBeNull();
    for (const select of screen.getAllByRole('button', { name: 'Ersatz auswählen' })) expect((select as HTMLButtonElement).disabled).toBe(true);
    expect(posts).toHaveLength(1);
    await act(async () => pending.resolve(decisionReceipt('REJECT')));
  });

  it('while an SP-20 selection is in flight, the decision openers are disabled', async () => {
    const user = userEvent.setup();
    const pending = deferred<unknown>();
    const { api, posts } = setup(() => offersPage(threeOffers()), () => pending.promise);
    renderWith(api);
    await openCase();
    await user.click(screen.getAllByRole('button', { name: 'Ersatz auswählen' })[0]);
    await user.click(button('Ersatz bestätigen'));
    expect(await screen.findByText('Auswahl wird gespeichert …')).toBeTruthy();
    expect((button('Ablehnen') as HTMLButtonElement).disabled).toBe(true);
    expect((button('Ohne Ersatz genehmigen') as HTMLButtonElement).disabled).toBe(true);
    await user.click(button('Ablehnen'));
    expect(posts.map((p) => p.path)).toEqual([`/api/v1/replacement-needs/${NEED_ID}/selection`]);
    pending.reject(new ApiError('http', 409, 'CANCELLATION_ALREADY_RESOLVED', null));
  });

  it('opening a decision while an SP-20 confirmation is open replaces it; nothing is sent', async () => {
    const user = userEvent.setup();
    const { api, posts } = setup(() => offersPage(threeOffers()), () => decisionReceipt('REJECT'));
    renderWith(api);
    await openCase();
    await user.click(screen.getAllByRole('button', { name: 'Ersatz auswählen' })[0]);
    await user.click(button('Ablehnen'));
    expect(screen.queryByRole('button', { name: 'Ersatz bestätigen' })).toBeNull();
    expect(confirmGroup(/Absage ablehnen\?/)).toBeTruthy();
    expect(posts).toEqual([]);
  });
});

describe('SP-21 S5 — uncertain outcomes keep the same command', () => {
  it.each([
    ['a network failure', new ApiError('network', null, null, null)],
    ['a 5xx', new ApiError('http', 503, null, null)],
    ['an in-progress replay', new ApiError('http', 409, 'IDEMPOTENCY_REQUEST_IN_PROGRESS', null)],
  ])('after %s only an explicit retry with the same key, body and versions is possible', async (_n, failure) => {
    const user = userEvent.setup();
    let reads = 0;
    const state = readAfter('APPROVE');
    const { api, posts } = setup(
      () => {
        reads += 1;
        // A later read reports newer versions; the retry must still carry the captured ones.
        if (reads > 1 && posts.length < 2) return offersPage(threeOffers(), caseContext({ need: { ...caseContext().need, concurrencyVersion: 7, dutyConcurrencyVersion: 9 } }));
        return state.read();
      },
      () => {
        if (posts.length === 1) throw failure;
        state.commit();
        return decisionReceipt('APPROVE');
      },
    );
    renderWith(api);
    await openCase();
    await user.click(button('Ohne Ersatz genehmigen'));
    await user.click(button('Genehmigung ohne Ersatz bestätigen'));
    expect(await screen.findByText(/Das Ergebnis ist nicht bestätigt/)).toBeTruthy();
    // Locked: no cancel, no switch to REJECT, no SP-20 selection.
    expect((button('Abbrechen') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Ablehnen' })).toBeNull();
    for (const select of screen.getAllByRole('button', { name: 'Ersatz auswählen' })) expect((select as HTMLButtonElement).disabled).toBe(true);
    // A manual reload of the view does not unlock or change the pending command.
    await user.click(button('Ansicht aktualisieren'));
    await user.click(await screen.findByRole('button', { name: 'Erneut bestätigen' }));
    expect(await screen.findByText(/Absage ohne Ersatz genehmigt\./)).toBeTruthy();
    expect(posts).toHaveLength(2);
    expect(posts[1].options.idempotencyKey).toBe(posts[0].options.idempotencyKey);
    expect(posts[1].options.body).toEqual(posts[0].options.body);
    expect(posts[1].options.body).toEqual({ decision: 'APPROVE', expectedDutyVersion: 4 });
    expect(posts[1].options.expectedVersion).toBe(1);
  });

  it('a new confirmed intent after a finished one gets a new key', async () => {
    const user = userEvent.setup();
    const { api, posts } = setup(() => offersPage(threeOffers()), () => {
      throw new ApiError('http', 409, 'RESOURCE_EDIT_LOCKED', null);
    });
    renderWith(api);
    await openCase();
    await user.click(button('Ablehnen'));
    await user.click(button('Ablehnung bestätigen'));
    await screen.findByText(/Der Dienst wird gerade im Plan bearbeitet/);
    await user.click(await screen.findByRole('button', { name: 'Ablehnen' }));
    await user.click(button('Ablehnung bestätigen'));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1].options.idempotencyKey).not.toBe(posts[0].options.idempotencyKey);
  });
});

describe('SP-21 S5 — identity and case boundaries', () => {
  it('a decision answer that arrives after the session changed is not shown to the new identity', async () => {
    const user = userEvent.setup();
    const pending = deferred<unknown>();
    const first = setup(() => offersPage(threeOffers()), () => pending.promise);
    const view = renderWith(first.api);
    await openCase();
    await user.click(button('Ablehnen'));
    await user.click(button('Ablehnung bestätigen'));
    await screen.findByText('Ablehnung wird gespeichert …');
    const second = setup(() => offersPage(threeOffers()), () => decisionReceipt('REJECT'));
    view.rerender(
      <MemoryRouter initialEntries={[CASE_PATH]}>
        <Routes>
          <Route
            path="/arbeitsuebersicht/*"
            element={<WorkQueueSection route={workQueueRoute()} api={second.api} identity={{ ...IDENTITY, accountId: '70000000-0000-4000-8000-000000000099' }} />}
          />
        </Routes>
      </MemoryRouter>,
    );
    await openCase();
    await act(async () => pending.resolve(decisionReceipt('REJECT')));
    expect(screen.queryByText(/Absage abgelehnt\./)).toBeNull();
    expect(screen.queryByText('Ablehnung wird gespeichert …')).toBeNull();
    expect(button('Ablehnen')).toBeTruthy();
    expect(second.posts).toEqual([]);
  });

  it('a decision answer for the previous case is not shown on another case', async () => {
    const user = userEvent.setup();
    const pending = deferred<unknown>();
    const OTHER = '71000000-0000-4000-8000-0000000000aa';
    const nav: { go: (path: string) => void } = { go: () => undefined };
    function Navigator() {
      const navigate = useNavigate();
      useEffect(() => {
        nav.go = (path) => {
          void navigate(path);
        };
      }, [navigate]);
      return null;
    }
    const { api } = setup(() => offersPage(threeOffers()), () => pending.promise);
    const otherApi: SessionApi = {
      request: async <T,>(path: string, options: SessionRequest = {}) => {
        if (path.includes(OTHER)) {
          const base = caseContext();
          const context = caseContext({ need: { ...base.need, id: OTHER }, cancellation: { ...base.cancellation, replacementNeed: { ...base.cancellation.replacementNeed, id: OTHER } } });
          return { ...offersPage([], context) } as T;
        }
        return api.request<T>(path, options);
      },
    };
    render(
      <MemoryRouter initialEntries={[CASE_PATH]}>
        <Navigator />
        <Routes>
          <Route path="/arbeitsuebersicht/*" element={<WorkQueueSection route={workQueueRoute()} api={otherApi} identity={IDENTITY} />} />
        </Routes>
      </MemoryRouter>,
    );
    await openCase();
    await user.click(button('Ablehnen'));
    await user.click(button('Ablehnung bestätigen'));
    await screen.findByText('Ablehnung wird gespeichert …');
    await act(async () => nav.go(`/arbeitsuebersicht/${OTHER}`));
    await openCase();
    await act(async () => pending.resolve(decisionReceipt('REJECT')));
    expect(screen.queryByText(/Absage abgelehnt\./)).toBeNull();
    expect((button('Ablehnen') as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps keys, receipts and personal data out of browser storage', async () => {
    const user = userEvent.setup();
    localStorage.clear();
    sessionStorage.clear();
    const state = readAfter('REJECT');
    const { api } = setup(state.read, () => {
      state.commit();
      return decisionReceipt('REJECT');
    });
    renderWith(api);
    await openCase();
    await user.click(button('Ablehnen'));
    await user.click(button('Ablehnung bestätigen'));
    await screen.findByText(/Absage abgelehnt\./);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
