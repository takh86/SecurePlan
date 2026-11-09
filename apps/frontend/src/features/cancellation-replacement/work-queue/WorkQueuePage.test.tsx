// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/arbeitsuebersicht"}
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { APP_ROUTES, type AppRoute } from '../../../app/routes';
import { ApiError } from '../../../shared/api/api-error';
import type { SessionApi } from '../../auth/session-api';
import { WorkQueueSection } from './WorkQueueSection';
import {
  IDENTITY,
  NEED_ID,
  PROJECT_ID,
  caseContext,
  offersPage,
  queueItem,
  queuePage,
  recordingApi,
  threeOffers,
  type Recorded,
} from './work-queue.test-support';
import type { QueueItem } from './work-queue-types';

const OTHER_PROJECT_ID = '71000000-0000-4000-8000-0000000000aa';
const PROJECTS = {
  items: [
    { id: PROJECT_ID, name: 'Testprojekt Nord', status: 'ACTIVE' },
    { id: OTHER_PROJECT_ID, name: 'Testprojekt Süd', status: 'INACTIVE' },
  ],
  pagination: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 },
};

function workQueueRoute(): AppRoute {
  const route = APP_ROUTES.find((candidate) => candidate.id === 'work-queue');
  if (!route) throw new Error('work-queue route missing');
  return route;
}

/** 25 distinct rows for a full first page (the server returns exactly the page size). */
function fullPage(prefix: string, count = 25): QueueItem[] {
  return Array.from({ length: count }, (_, index) =>
    queueItem({
      replacementNeedId: `71000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
      project: { id: PROJECT_ID, name: `${prefix} ${index + 1}` },
    }),
  );
}

function queryOf(path: string): URLSearchParams {
  return new URL(path, 'https://localhost:8443').searchParams;
}

type Answers = {
  queue?: (path: string) => unknown | Promise<unknown>;
  offers?: (path: string) => unknown | Promise<unknown>;
  projects?: (path: string) => unknown | Promise<unknown>;
};

/** Answers by path; unexpected paths fail the test instead of passing silently. */
function apiWith(answers: Answers = {}) {
  return recordingApi((path) => {
    if (path.startsWith('/api/v1/admin/work-queue?')) {
      if (answers.queue) return answers.queue(path);
      // Default: one case on page 1; any other page is empty and reports its own number, as the server does.
      const page = Number(queryOf(path).get('page'));
      return page === 1 ? queuePage([queueItem()]) : queuePage([], 1, page);
    }
    if (path.startsWith('/api/v1/replacement-needs/')) return answers.offers ? answers.offers(path) : offersPage(threeOffers(), caseContext());
    if (path.startsWith('/api/v1/projects?')) return answers.projects ? answers.projects(path) : PROJECTS;
    throw new Error(`unexpected request: ${path}`);
  });
}

function renderAt(path: string, api: SessionApi, revalidate = vi.fn()) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/arbeitsuebersicht/*"
          element={
            <WorkQueueSection route={workQueueRoute()} api={api} identity={IDENTITY} requestSessionRevalidation={revalidate} />
          }
        />
        <Route path="*" element={<p>Außerhalb des Arbeitsbereichs</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function queueRequests(requests: Recorded[]): string[] {
  return requests.filter((request) => request.path.startsWith('/api/v1/admin/work-queue?')).map((request) => request.path);
}

afterEach(() => {
  cleanup();
});

describe('SP-19 — administrative work queue (read-only)', () => {
  it('shows real cases with the open and currently eligible offer counts kept apart', async () => {
    renderAt('/arbeitsuebersicht', apiWith().api);
    const table = await screen.findByRole('table', { name: 'Offene Absagen und Ersatzbedarfe' });
    const row = within(table).getByRole('rowheader', { name: /Testperson Eins/ }).closest('tr');
    if (!row) throw new Error('row missing');

    expect(row.textContent).toContain('Personalnummer P-100');
    expect(row.textContent).toContain('Testprojekt Nord');
    expect(row.textContent).toContain('Mi, 16.12.2026');
    expect(row.textContent).toContain('Nachtdienst · 18:00 – 06:00 (Do, 17.12.2026)');
    expect(row.textContent).toContain('Zeitzone Europe/Berlin');
    expect(row.querySelector('td[data-label="Offene Angebote"]')?.textContent).toBe('3');
    expect(row.querySelector('td[data-label="Aktuell geeignet"]')?.textContent).toBe('1');
    expect(within(row).getByRole('link', { name: /Vorgang öffnen für Testperson Eins/ }).getAttribute('href')).toBe(
      `/arbeitsuebersicht/${NEED_ID}`,
    );
  });

  it('shows the evaluation time in UTC, not the browser zone', async () => {
    renderAt('/arbeitsuebersicht', apiWith().api);
    const summary = await screen.findByText(/Stand der Auswertung/);
    expect(summary.textContent).toContain('15.12.2026, 10:00 UTC');
  });

  it('requests the first page with the documented parameters and sends only GET requests', async () => {
    const { api, requests } = apiWith();
    renderAt('/arbeitsuebersicht', api);
    await screen.findByRole('table');
    expect(queueRequests(requests)).toEqual(['/api/v1/admin/work-queue?page=1&pageSize=25&sortBy=createdAt&sortOrder=asc']);
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('applies the eligible-offer filter on the server and returns to the first page', async () => {
    const user = userEvent.setup();
    const { api, requests } = apiWith();
    renderAt('/arbeitsuebersicht?page=2', api);
    // Page 2 is empty for one case; the filter controls are present in every state.
    await user.click(await screen.findByRole('radio', { name: 'Mit aktuell geeigneten Angeboten' }));
    await waitFor(() => expect(queueRequests(requests).at(-1)).toContain('offerPresence=WITH_ELIGIBLE'));
    expect(queryOf(queueRequests(requests).at(-1) ?? '').get('page')).toBe('1');
  });

  it('moves between pages with server requests', async () => {
    const user = userEvent.setup();
    const { api, requests } = apiWith({
      queue: (path) => {
        const page = Number(queryOf(path).get('page'));
        return page === 1 ? queuePage(fullPage('Erste Seite'), 30, 1) : queuePage(fullPage('Zweite Seite', 5), 30, 2);
      },
    });
    renderAt('/arbeitsuebersicht', api);
    await screen.findByText('Seite 1 von 2');
    await user.click(screen.getByRole('button', { name: 'Nächste Seite' }));
    await screen.findByText('Zweite Seite 1');
    expect(queueRequests(requests).at(-1)).toContain('page=2');
    expect(screen.getByText('Seite 2 von 2')).toBeTruthy();
  });

  it('sorts on the server by duty date', async () => {
    const user = userEvent.setup();
    const { api, requests } = apiWith();
    renderAt('/arbeitsuebersicht', api);
    await screen.findByRole('table');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sortieren nach' }), 'dutyDate');
    await waitFor(() => expect(queueRequests(requests).at(-1)).toContain('sortBy=dutyDate'));
    expect(queueRequests(requests).at(-1)).toContain('sortOrder=asc');
  });

  it('shows the empty state when no open case exists', async () => {
    renderAt('/arbeitsuebersicht', apiWith({ queue: () => queuePage([], 0) }).api);
    expect(await screen.findByText('Keine offenen Vorgänge')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows a filtered empty state with a reset that clears only the filters', async () => {
    const user = userEvent.setup();
    const { api, requests } = apiWith({ queue: () => queuePage([], 0) });
    renderAt('/arbeitsuebersicht?offerPresence=WITHOUT_ELIGIBLE&sortBy=dutyDate', api);
    expect(await screen.findByText('Keine Vorgänge für diese Auswahl')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Filter zurücksetzen' }));
    await waitFor(() => expect(queueRequests(requests).at(-1)).not.toContain('offerPresence'));
    expect(queueRequests(requests).at(-1)).toContain('sortBy=dutyDate');
  });

  it('handles a page beyond the last page without showing an error', async () => {
    const user = userEvent.setup();
    const { api, requests } = apiWith({ queue: (path) => (queryOf(path).get('page') === '3' ? queuePage([], 1, 3) : queuePage([queueItem()])) });
    renderAt('/arbeitsuebersicht?page=3', api);
    expect(await screen.findByText('Diese Seite ist leer')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Zur ersten Seite' }));
    await waitFor(() => expect(queueRequests(requests).at(-1)).toContain('page=1'));
  });

  it('shows a safe network error and retries', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const { api } = apiWith({
      queue: () => {
        calls += 1;
        if (calls === 1) throw new ApiError('network', null, null, null);
        return queuePage([queueItem()]);
      },
    });
    renderAt('/arbeitsuebersicht', api);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Verbindung fehlgeschlagen');
    await user.click(within(alert).getByRole('button', { name: 'Erneut versuchen' }));
    expect(await screen.findByRole('table')).toBeTruthy();
  });

  it('asks the session to revalidate on forbidden access and shows no case data', async () => {
    const revalidate = vi.fn();
    const { api } = apiWith({ queue: () => Promise.reject(new ApiError('http', 403, 'ACTION_FORBIDDEN', 'req-403')) });
    renderAt('/arbeitsuebersicht', api, revalidate);
    expect((await screen.findByRole('alert')).textContent).toContain('Kein Zugriff');
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('answers a hidden project filter (404) with a neutral message and a way out', async () => {
    const user = userEvent.setup();
    const { api, requests } = apiWith({
      queue: (path) => {
        if (queryOf(path).get('projectId')) throw new ApiError('http', 404, 'RESOURCE_NOT_FOUND', null);
        return queuePage([queueItem()]);
      },
    });
    renderAt(`/arbeitsuebersicht?projectId=${PROJECT_ID}`, api);
    expect((await screen.findByRole('alert')).textContent).toContain('Projekt nicht verfügbar');
    await user.click(screen.getByRole('button', { name: 'Projektfilter entfernen' }));
    await waitFor(() => expect(queueRequests(requests).at(-1)).not.toContain('projectId'));
  });

  it('offers the company projects, including inactive ones, sorted by name', async () => {
    const { api } = apiWith();
    renderAt('/arbeitsuebersicht', api);
    const select = await screen.findByRole('combobox', { name: 'Projekt' });
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(3));
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Alle Projekte',
      'Testprojekt Nord',
      'Testprojekt Süd',
    ]);
  });

  it('keeps a project filter visible when the project list is unavailable', async () => {
    const { api } = apiWith({
      projects: () => {
        throw new ApiError('network', null, null, null);
      },
    });
    renderAt(`/arbeitsuebersicht?projectId=${PROJECT_ID}`, api);
    const select = await screen.findByRole('combobox', { name: 'Projekt' });
    expect(await screen.findByText(/Die Projektliste konnte nicht geladen werden/)).toBeTruthy();
    expect((select as HTMLSelectElement).value).toBe(PROJECT_ID);
    expect(within(select).getByRole('option', { name: 'Ausgewähltes Projekt' })).toBeTruthy();
  });

  it('ignores a response that arrives after a newer filter was selected', async () => {
    const user = userEvent.setup();
    let release!: (value: unknown) => void;
    const stale = new Promise((resolve) => {
      release = resolve;
    });
    const { api } = apiWith({
      queue: (path) => (queryOf(path).has('offerPresence') ? queuePage([queueItem({ project: { id: PROJECT_ID, name: 'Aktuelles Ergebnis' } })]) : stale),
    });
    renderAt('/arbeitsuebersicht', api);
    await user.click(screen.getByRole('radio', { name: 'Ohne aktuell geeignete Angebote' }));
    expect(await screen.findByText('Aktuelles Ergebnis')).toBeTruthy();
    release(queuePage([queueItem({ project: { id: PROJECT_ID, name: 'Veraltetes Ergebnis' } })]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText('Veraltetes Ergebnis')).toBeNull();
    expect(screen.getByText('Aktuelles Ergebnis')).toBeTruthy();
  });

  it('reloads the authoritative list on manual refresh', async () => {
    const user = userEvent.setup();
    const { api, requests } = apiWith();
    renderAt('/arbeitsuebersicht', api);
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Liste aktualisieren' }));
    await waitFor(() => expect(queueRequests(requests)).toHaveLength(2));
  });

  it('opens a case with the list state preserved for the way back', async () => {
    const user = userEvent.setup();
    const { api } = apiWith();
    renderAt('/arbeitsuebersicht?offerPresence=WITH_ELIGIBLE', api);
    await user.click(await screen.findByRole('link', { name: /Vorgang öffnen für Testperson Eins/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Vorgang prüfen' })).toBeTruthy();
    const back = screen.getByRole('link', { name: 'Zur Arbeitsübersicht' });
    expect(back.getAttribute('href')).toBe('/arbeitsuebersicht?offerPresence=WITH_ELIGIBLE');
  });

  it('exposes no decision or mutation control', async () => {
    const { api, requests } = apiWith();
    renderAt('/arbeitsuebersicht', api);
    await screen.findByRole('table');
    for (const button of screen.getAllByRole('button')) {
      expect(button.textContent ?? '').not.toMatch(/Genehmig|Ablehn|Auswähl|Zuweis|Bestätig|Speicher/i);
    }
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('returns an unknown sub-path of the work queue to the queue', async () => {
    renderAt(`/arbeitsuebersicht/${NEED_ID}/unbekannt`, apiWith().api);
    expect(await screen.findByRole('heading', { level: 1, name: 'Arbeitsübersicht' })).toBeTruthy();
    expect(await screen.findByRole('table')).toBeTruthy();
  });
});
