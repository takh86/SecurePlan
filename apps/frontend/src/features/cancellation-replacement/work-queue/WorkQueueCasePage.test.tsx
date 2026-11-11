// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/arbeitsuebersicht"}
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { APP_ROUTES, type AppRoute } from '../../../app/routes';
import { ApiError, parseApiError } from '../../../shared/api/api-error';
import type { SessionRequest } from '../../auth/session-api';
import { WorkQueueSection } from './WorkQueueSection';
import {
  CANCELLATION_ID,
  IDENTITY,
  NEED_ID,
  caseContext,
  offersPage,
  recordingApi,
  threeOffers,
  type Recorded,
} from './work-queue.test-support';

const CASE_PATH = `/arbeitsuebersicht/${NEED_ID}`;

function workQueueRoute(): AppRoute {
  const route = APP_ROUTES.find((candidate) => candidate.id === 'work-queue');
  if (!route) throw new Error('work-queue route missing');
  return route;
}

function renderCase(path: string, answer: (path: string) => unknown) {
  const { api, requests } = recordingApi((requested) => {
    if (requested.startsWith('/api/v1/replacement-needs/')) return answer(requested);
    throw new Error(`unexpected request: ${requested}`);
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/arbeitsuebersicht/*"
          element={<WorkQueueSection route={workQueueRoute()} api={api} identity={IDENTITY} />}
        />
      </Routes>
    </MemoryRouter>,
  );
  return { requests: requests as Recorded[] };
}

function rowFor(name: string): HTMLElement {
  const row = screen.getByRole('rowheader', { name: new RegExp(name) }).closest('tr');
  if (!row) throw new Error(`row ${name} missing`);
  return row;
}

afterEach(() => {
  cleanup();
});

describe('SP-19 — administrative case view (read-only)', () => {
  it('shows the cancellation, the duty and the offers with their current review state', async () => {
    renderCase(CASE_PATH, () => offersPage(threeOffers()));
    expect(await screen.findByRole('heading', { level: 2, name: 'Vorgangsstatus' })).toBeTruthy();

    expect(screen.getByText('Testperson Eins')).toBeTruthy();
    expect(screen.getByText('Personalnummer P-100')).toBeTruthy();
    const duty = screen.getByRole('heading', { level: 2, name: 'Betroffener Dienst' }).closest('section');
    expect(duty?.textContent).toContain('Nachtdienst');
    expect(duty?.textContent).toContain('18:00 – 06:00 (Do, 17.12.2026)');
    expect(duty?.textContent).toContain('Zeitzone Europe/Berlin');
    expect(duty?.textContent).toContain('Testprojekt Nord');
  });

  it('keeps open offers and currently eligible offers as separate counts', async () => {
    renderCase(CASE_PATH, () => offersPage(threeOffers()));
    const offers = await screen.findByRole('heading', { level: 2, name: 'Ersatzangebote' });
    const section = offers.closest('section');
    if (!section) throw new Error('section missing');
    const count = (label: string) => within(section).getByText(label).parentElement?.querySelector('dd')?.textContent;
    expect(count('Offene Angebote')).toBe('3');
    expect(count('Davon aktuell geeignet')).toBe('1');
    expect(section.textContent).toContain('keine Auswahl und keine Zuweisung');
  });

  it('labels each offer with ELIGIBLE, INELIGIBLE or NOT_APPLICABLE as text', async () => {
    renderCase(CASE_PATH, () => offersPage(threeOffers()));
    await screen.findByRole('table', { name: 'Eingereichte Ersatzangebote' });
    expect(rowFor('Erika Erste').textContent).toContain('Aktuell geeignet');
    expect(rowFor('Max Zweiter').textContent).toContain('Aktuell nicht geeignet');
    const withdrawn = rowFor('Lena Dritte');
    expect(withdrawn.textContent).toContain('Nicht anwendbar');
    expect(withdrawn.textContent).toContain('Zurückgezogen');
    expect(withdrawn.querySelector('td[data-label="Entschieden"]')?.textContent).toContain('15.12.2026, 10:03 UTC');
  });

  it('shows the evaluation time of the snapshot in UTC', async () => {
    renderCase(CASE_PATH, () => offersPage(threeOffers()));
    expect(await screen.findByText(/Stand der Auswertung/)).toBeTruthy();
    expect(screen.getByText(/Stand der Auswertung/).textContent).toContain('15.12.2026, 10:00 UTC');
  });

  it('says that a closed case is no longer pending work', async () => {
    const closed = caseContext({
      cancellation: {
        ...caseContext().cancellation,
        status: 'WITHDRAWN',
        decidedAt: '2026-12-15T11:00:00.000Z',
        replacementNeed: { id: NEED_ID, status: 'CLOSED', resolvedAt: null },
      },
      need: { ...caseContext().need, status: 'CLOSED' },
      originalAssignmentActive: false,
      eligibleOpenOfferCount: 0,
    });
    renderCase(CASE_PATH, () => offersPage([], closed));
    const note = await screen.findByRole('note');
    expect(note.textContent).toContain('nicht mehr offen');
    expect(note.textContent).toContain('nicht als ausstehende Arbeit');
    expect(await screen.findByText('Noch keine Ersatzangebote')).toBeTruthy();
  });

  it('shows the case-unavailable state for a 404 and reveals no case data', async () => {
    renderCase(CASE_PATH, () => {
      throw new ApiError('http', 404, 'RESOURCE_NOT_FOUND', null);
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Vorgang nicht verfügbar');
    expect(screen.queryByRole('heading', { name: 'Vorgangsstatus' })).toBeNull();
    expect(screen.queryByText('Testperson Eins')).toBeNull();
  });

  it('treats a malformed case identifier as unavailable without any request', async () => {
    const { requests } = renderCase('/arbeitsuebersicht/not-a-uuid', () => offersPage([]));
    expect((await screen.findByRole('alert')).textContent).toContain('Vorgang nicht verfügbar');
    expect(requests).toEqual([]);
  });

  it('filters the offers on the server by status and returns to the first page', async () => {
    const user = userEvent.setup();
    const [open] = threeOffers();
    const { requests } = renderCase(`${CASE_PATH}?page=2`, (path) => {
      // The server returns only offers of the requested status; page 2 of three offers is empty.
      if (path.includes('status=OPEN')) return offersPage([open], caseContext(), 1, 1);
      return path.includes('page=2') ? offersPage([], caseContext(), 3, 2) : offersPage(threeOffers());
    });
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Angebotsstatus' }), 'OPEN');
    await waitFor(() => expect(requests.at(-1)?.path).toContain('status=OPEN'));
    expect(requests.at(-1)?.path).toContain('page=1');
    expect(await screen.findByRole('table', { name: 'Eingereichte Ersatzangebote' })).toBeTruthy();
    expect(within(screen.getByRole('table', { name: 'Eingereichte Ersatzangebote' })).getAllByRole('row')).toHaveLength(2);
  });

  it('P2-02: a page past the last one says so, keeps the status filter and returns to page one', async () => {
    const user = userEvent.setup();
    const [open] = threeOffers();
    const { requests } = renderCase(`${CASE_PATH}?status=OPEN&page=3`, (path) =>
      path.includes('page=3') ? offersPage([], caseContext(), 2, 3) : offersPage([open], caseContext(), 1, 1),
    );
    expect(await screen.findByText('Diese Seite ist leer')).toBeTruthy();
    expect(screen.queryByText('Noch keine Ersatzangebote')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Zur ersten Seite' }));
    await waitFor(() => expect(requests.at(-1)?.path).toContain('page=1'));
    expect(requests.at(-1)?.path).toContain('status=OPEN');
    expect(await screen.findByRole('table', { name: 'Eingereichte Ersatzangebote' })).toBeTruthy();
  });

  it('P2-02: a status without matches is not reported as "no offers" and can show all offers', async () => {
    const user = userEvent.setup();
    const { requests } = renderCase(`${CASE_PATH}?status=WITHDRAWN`, (path) =>
      path.includes('status=WITHDRAWN') ? offersPage([], caseContext(), 0, 1) : offersPage(threeOffers()),
    );
    expect(await screen.findByText('Keine Angebote mit diesem Status')).toBeTruthy();
    expect(screen.queryByText('Noch keine Ersatzangebote')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Alle Angebote anzeigen' }));
    await waitFor(() => expect(requests.at(-1)?.path).not.toContain('status='));
    expect(await screen.findByRole('table', { name: 'Eingereichte Ersatzangebote' })).toBeTruthy();
  });

  it('shows a retry for a transient failure', async () => {
    let calls = 0;
    renderCase(CASE_PATH, () => {
      calls += 1;
      if (calls === 1) throw new ApiError('network', null, null, null);
      return offersPage(threeOffers());
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Verbindung fehlgeschlagen');
    expect(within(alert).getByRole('button', { name: 'Erneut versuchen' })).toBeTruthy();
  });

  it('loads with GET requests only; a write starts only from an explicit choice and confirmation', async () => {
    const { requests } = renderCase(CASE_PATH, () => offersPage(threeOffers()));
    await screen.findByRole('table', { name: 'Eingereichte Ersatzangebote' });
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
    // SP-20/SP-21: the only write entries are the explicit openers; each needs a separate confirmation.
    const writeOpeners = screen
      .getAllByRole('button')
      .map((button) => button.textContent ?? '')
      .filter((label) => /Genehmig|Ablehn|Zuweis|Speicher|auswählen/i.test(label));
    expect(writeOpeners.sort()).toEqual(['Ablehnen', 'Ersatz auswählen', 'Ohne Ersatz genehmigen']);
  });
});

describe('SP-20 — administrative selection', () => {
  function renderSelection(answer: (path: string, options: SessionRequest) => unknown) {
    const { api, requests } = recordingApi((path, options) => {
      if (path.startsWith('/api/v1/replacement-needs/')) return answer(path, options);
      throw new Error(`unexpected request: ${path}`);
    });
    render(
      <MemoryRouter initialEntries={[CASE_PATH]}>
        <Routes>
          <Route path="/arbeitsuebersicht/*" element={<WorkQueueSection route={workQueueRoute()} api={api} identity={IDENTITY} />} />
        </Routes>
      </MemoryRouter>,
    );
    return { requests };
  }

  function eligibleOffer() {
    const offer = threeOffers().find((candidate) => candidate.status === 'OPEN' && candidate.reviewEligibility === 'ELIGIBLE');
    if (!offer) throw new Error('fixture has no eligible offer');
    return offer;
  }

  function selectionAnswer(offer: { id: string; employee: { id: string; employeeCode: string; firstName: string; lastName: string } }) {
    return {
      needId: NEED_ID,
      cancellationRequestId: CANCELLATION_ID,
      status: { cancellation: 'APPROVED', need: 'RESOLVED' },
      decidedAt: '2026-12-15T10:00:00.000Z',
      needVersion: 2,
      selectedOffer: { id: offer.id, status: 'SELECTED', employee: offer.employee },
      otherOffers: [],
      originalAssignment: { id: '71000000-0000-4000-8000-000000000009', state: 'REMOVED', removedAt: '2026-12-15T10:00:00.000Z' },
      replacementAssignment: { id: '71000000-0000-4000-8000-000000000010', employeeId: offer.employee.id, source: 'REPLACEMENT', state: 'ACTIVE' },
      duty: { id: '71000000-0000-4000-8000-000000000011', concurrencyVersion: 3 },
    };
  }

  it('confirms before writing, then posts one selection with Expected-Version and an Idempotency-Key', async () => {
    const user = userEvent.setup();
    const offer = eligibleOffer();
    const posted: SessionRequest[] = [];
    const { requests } = renderSelection((_path, options) => {
      if (options.method === 'POST') {
        posted.push(options);
        return selectionAnswer(offer);
      }
      return offersPage(threeOffers());
    });
    await screen.findByRole('table', { name: 'Eingereichte Ersatzangebote' });
    await user.click((await screen.findAllByRole('button', { name: 'Ersatz auswählen' }))[0]);
    expect(posted).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Ersatz bestätigen' }));
    expect(await screen.findByText('Ersatz ausgewählt. Der Vorgang ist abgeschlossen.')).toBeTruthy();
    expect(posted).toHaveLength(1);
    expect(posted[0].expectedVersion).toBe(1);
    expect(posted[0].body).toEqual({ offerId: offer.id });
    expect(typeof posted[0].idempotencyKey).toBe('string');
    expect(requests.filter((request) => request.method === 'POST')).toEqual([
      { path: `/api/v1/replacement-needs/${NEED_ID}/selection`, method: 'POST' },
    ]);
  });

  it('a refused selection (409) names the reason and reloads the case', async () => {
    const user = userEvent.setup();
    let posts = 0;
    const { requests } = renderSelection((_path, options) => {
      if (options.method === 'POST') {
        posts += 1;
        throw new ApiError('http', 409, 'PLAN_CONCURRENT_MODIFICATION', null);
      }
      return offersPage(threeOffers());
    });
    await screen.findByRole('table', { name: 'Eingereichte Ersatzangebote' });
    await user.click((await screen.findAllByRole('button', { name: 'Ersatz auswählen' }))[0]);
    await user.click(screen.getByRole('button', { name: 'Ersatz bestätigen' }));
    expect(await screen.findByText(/Der Vorgang wurde inzwischen geändert\. Die Daten wurden neu geladen\./)).toBeTruthy();
    expect(posts).toBe(1);
    expect(requests.filter((request) => request.method === 'GET').length).toBeGreaterThanOrEqual(2);
  });

  // The refusal travels the real path: a problem+json response is parsed by parseApiError, so the code must be
  // on the allowlist for the specific German text to appear (not the generic "Die Auswahl wurde nicht angenommen.").
  for (const [code, text] of [
    ['CANCELLATION_ALREADY_RESOLVED', 'Dieser Vorgang ist bereits entschieden. Die Daten wurden neu geladen.'],
    ['REPLACEMENT_OFFER_NOT_SELECTABLE', 'Dieses Angebot kann nicht mehr ausgewählt werden. Die Daten wurden neu geladen.'],
  ] as const) {
    it(`SP-20: ${code} keeps its specific German refusal, reloads the case and writes only once`, async () => {
      const user = userEvent.setup();
      let posts = 0;
      const { requests } = renderSelection(async (_path, options) => {
        if (options.method === 'POST') {
          posts += 1;
          throw await parseApiError(
            new Response(JSON.stringify({ code }), { status: 409, headers: { 'content-type': 'application/problem+json' } }),
          );
        }
        return offersPage(threeOffers());
      });
      await screen.findByRole('table', { name: 'Eingereichte Ersatzangebote' });
      const getsBefore = requests.filter((request) => request.method === 'GET').length;
      await user.click((await screen.findAllByRole('button', { name: 'Ersatz auswählen' }))[0]);
      await user.click(screen.getByRole('button', { name: 'Ersatz bestätigen' }));
      expect(await screen.findByText(text)).toBeTruthy();
      expect(screen.queryByText('Die Auswahl wurde nicht angenommen. Die Daten wurden neu geladen.')).toBeNull();
      expect(posts).toBe(1);
      expect(requests.filter((request) => request.method === 'GET').length).toBeGreaterThan(getsBefore);
    });
  }

  it('while the selection is in flight the confirmation is disabled and no second write starts', async () => {
    const user = userEvent.setup();
    const offer = eligibleOffer();
    let release: (value: unknown) => void = () => undefined;
    let posts = 0;
    renderSelection((_path, options) => {
      if (options.method === 'POST') {
        posts += 1;
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return offersPage(threeOffers());
    });
    await screen.findByRole('table', { name: 'Eingereichte Ersatzangebote' });
    await user.click((await screen.findAllByRole('button', { name: 'Ersatz auswählen' }))[0]);
    await user.click(screen.getByRole('button', { name: 'Ersatz bestätigen' }));
    expect(await screen.findByText('Auswahl wird gespeichert …')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Ersatz bestätigen' }) as HTMLButtonElement).disabled).toBe(true);
    expect(posts).toBe(1);
    release(selectionAnswer(offer));
  });

  it('an unknown outcome keeps the same Idempotency-Key, so a retry replays the decision', async () => {
    const user = userEvent.setup();
    const offer = eligibleOffer();
    const keys: string[] = [];
    renderSelection((_path, options) => {
      if (options.method === 'POST') {
        keys.push(options.idempotencyKey ?? '');
        if (keys.length === 1) throw new ApiError('http', 500, null, null);
        return selectionAnswer(offer);
      }
      return offersPage(threeOffers());
    });
    await screen.findByRole('table', { name: 'Eingereichte Ersatzangebote' });
    await user.click((await screen.findAllByRole('button', { name: 'Ersatz auswählen' }))[0]);
    await user.click(screen.getByRole('button', { name: 'Ersatz bestätigen' }));
    await user.click(await screen.findByRole('button', { name: 'Erneut bestätigen' }));
    expect(await screen.findByText('Ersatz ausgewählt. Der Vorgang ist abgeschlossen.')).toBeTruthy();
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe('');
    expect(keys[1]).toBe(keys[0]);
  });
});
