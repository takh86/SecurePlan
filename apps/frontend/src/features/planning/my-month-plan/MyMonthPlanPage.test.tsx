// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/mein-monatsplan"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter, Route, Routes } from 'react-router';
import { ApiError } from '../../../shared/api/api-error';
import type { Clock } from '../../../shared/time/clock';
import { buildMyMonthPlanFixture } from './my-month-plan-fixtures';
import { createMyMonthPlanPreviewSource } from './my-month-plan-preview-source';
import type { MyMonthPlanSource } from './my-month-plan-types';
import { MyMonthPlanPage } from './MyMonthPlanPage';

// Fixed local-midday clocks: deterministic in every time zone.
const clockAt = (year: number, month: number, day: number): Clock => () => new Date(year, month - 1, day, 12, 0, 0);
const DECEMBER_2026 = clockAt(2026, 12, 15);
const MUTATION_LABELS = /Genehmigen|Ablehnen|Auswählen|Absage|Speichern/i;

let fetchMock: ReturnType<typeof vi.fn>;

function renderPlan(path: string, options: { source?: MyMonthPlanSource; clock?: Clock } = {}) {
  const clock = options.clock ?? DECEMBER_2026;
  const source = options.source ?? createMyMonthPlanPreviewSource(clock);
  window.history.replaceState(null, '', path);
  render(
    <BrowserRouter>
      <Routes>
        <Route path="/mein-monatsplan/:month?" element={<MyMonthPlanPage source={source} clock={clock} />} />
      </Routes>
    </BrowserRouter>,
  );
}

function monthHeading() {
  return screen.getByRole('heading', { level: 2 });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('F1 — Mein Monatsplan preview (employee)', () => {
  it('T-MONTH-6: December → next month → January 2027, browser Back returns to December', async () => {
    renderPlan('/mein-monatsplan');
    expect(monthHeading().textContent).toBe('Dezember 2026');
    expect(await screen.findAllByRole('article')).toHaveLength(10);
    expect(screen.getAllByText('Projekt: Demo-Objekt Nord')).toHaveLength(10);

    await userEvent.setup().click(screen.getByRole('link', { name: 'Nächster Monat: Januar 2027' }));
    expect(window.location.pathname).toBe('/mein-monatsplan/2027-01');
    expect(monthHeading().textContent).toBe('Januar 2027');
    expect(await screen.findAllByText('Projekt: Demo-Objekt Hafen')).toHaveLength(10);

    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe('/mein-monatsplan'));
    await waitFor(() => expect(monthHeading().textContent).toBe('Dezember 2026'));
  });

  it('T-MONTH-7: deep link January 2027 → previous month → December 2026', async () => {
    renderPlan('/mein-monatsplan/2027-01');
    expect(monthHeading().textContent).toBe('Januar 2027');
    await screen.findAllByRole('article');

    await userEvent.setup().click(screen.getByRole('link', { name: 'Vorheriger Monat: Dezember 2026' }));
    expect(window.location.pathname).toBe('/mein-monatsplan/2026-12');
    expect(monthHeading().textContent).toBe('Dezember 2026');
    expect(await screen.findAllByText('Projekt: Demo-Objekt Nord')).toHaveLength(10);
  });

  it('T-MONTH-8: a month outside the preview range shows the no-plan empty state', async () => {
    renderPlan('/mein-monatsplan/2027-02');
    expect(await screen.findByText('Für Februar 2027 liegt kein veröffentlichter Plan vor.')).toBeTruthy();
    expect(screen.queryAllByRole('article')).toHaveLength(0);
  });

  it('T-MONTH-9: a night shift on 31.12.2026 ends on 01.01.2027', async () => {
    renderPlan('/mein-monatsplan');
    const card = await screen.findByRole('article', { name: 'Do., 31.12.2026' });
    expect(card.textContent).toContain('Nachtdienst');
    expect(card.textContent).toContain('Beispielzeit: 18:00 – 06:00 (Fr., 01.01.2027)');
  });

  it('follows the injected clock across the year boundary', async () => {
    renderPlan('/mein-monatsplan', { clock: clockAt(2026, 12, 31) });
    expect(monthHeading().textContent).toBe('Dezember 2026');
    cleanup();

    renderPlan('/mein-monatsplan', { clock: clockAt(2027, 1, 1) });
    expect(monthHeading().textContent).toBe('Januar 2027');
    expect(await screen.findAllByText('Projekt: Demo-Objekt Nord')).toHaveLength(10);
    // The January 2027 preview starts a new plan; December 2026 is now outside the preview range.
    await userEvent.setup().click(screen.getByRole('link', { name: 'Vorheriger Monat: Dezember 2026' }));
    expect(await screen.findByText('Für Dezember 2026 liegt kein veröffentlichter Plan vor.')).toBeTruthy();
  });

  it('redirects an invalid month to the current month', async () => {
    renderPlan('/mein-monatsplan/2026-13');
    await waitFor(() => expect(window.location.pathname).toBe('/mein-monatsplan'));
    expect(monthHeading().textContent).toBe('Dezember 2026');
  });

  it('shows loading, error with retry and an empty plan', async () => {
    const load = vi.fn<MyMonthPlanSource['load']>()
      .mockReturnValueOnce(new Promise(() => {}));
    renderPlan('/mein-monatsplan', { source: { kind: 'preview', load } });
    expect(screen.getByRole('status').textContent).toContain('Monatsplan wird geladen');
    cleanup();

    const failing = vi.fn<MyMonthPlanSource['load']>()
      .mockRejectedValueOnce(new ApiError('http', 503, 'SERVICE_UNAVAILABLE', null))
      .mockResolvedValueOnce({ duties: [] });
    renderPlan('/mein-monatsplan', { source: { kind: 'preview', load: failing } });
    expect((await screen.findByRole('alert')).textContent).toContain('Dienst vorübergehend nicht verfügbar');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(await screen.findByText('Für Dezember 2026 sind für Sie keine Dienste geplant.')).toBeTruthy();
  });

  it('T-LABEL-1: labels every shift time as an example and shows status as text', async () => {
    renderPlan('/mein-monatsplan');
    const cards = await screen.findAllByRole('article');
    for (const card of cards) expect(card.textContent).toContain('Beispielzeit:');
    expect(within(cards[5]).getByText('Absage beantragt – Entscheidung offen')).toBeTruthy();
    expect(within(cards[0]).getByText('Geplant')).toBeTruthy();

    const notice = screen.getByRole('complementary', { name: 'Hinweis zu Demodaten' });
    expect(notice.textContent?.replace(/\s+/g, ' ')).toContain(
      'synthetische Beispielwerte, keine freigegebenen Schicht- oder Planungsregeln',
    );
  });

  it('hides the preview notice and example label for a future API source', async () => {
    renderPlan('/mein-monatsplan', {
      source: { kind: 'api', load: (month) => Promise.resolve(buildMyMonthPlanFixture(month, 'Projekt A')) },
    });
    const cards = await screen.findAllByRole('article');
    expect(screen.queryByText(/Demodaten/)).toBeNull();
    expect(cards[0].textContent).toContain('Dienstzeit:');
  });

  it('offers no cancellation, statistics or save action and makes no network request', async () => {
    renderPlan('/mein-monatsplan');
    await screen.findAllByRole('article');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    for (const link of screen.getAllByRole('link')) {
      expect(link.textContent ?? '').not.toMatch(MUTATION_LABELS);
    }
    expect(screen.queryByText(/Statistik/)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
