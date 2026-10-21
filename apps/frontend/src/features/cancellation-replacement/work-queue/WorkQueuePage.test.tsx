// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/arbeitsuebersicht"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../../../shared/api/api-error';
import { buildWorkQueueFixtures } from './work-queue-fixtures';
import { createWorkQueuePreviewSource } from './work-queue-preview-source';
import type { WorkQueueCase, WorkQueueSource } from './work-queue-types';
import { WorkQueuePage } from './WorkQueuePage';

// Fixed local-midday clock: deterministic in every time zone.
const clock = () => new Date(2026, 11, 15, 12, 0, 0);
const MUTATION_LABELS = /Genehmigen|Ablehnen|Auswählen|Absage|Speichern/i;

function sourceOf(kind: WorkQueueSource['kind'], load: WorkQueueSource['load']): WorkQueueSource {
  return { kind, load };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('F1 — Work Queue preview (admin)', () => {
  it('shows a loading state until the source resolves', () => {
    render(<WorkQueuePage source={sourceOf('preview', () => new Promise(() => {}))} />);
    expect(screen.getByRole('status').textContent).toContain('Offene Vorgänge werden geladen');
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('shows a safe error with retry and recovers on retry', async () => {
    const load = vi.fn<WorkQueueSource['load']>()
      .mockRejectedValueOnce(new ApiError('network', null, null, null))
      .mockResolvedValueOnce(buildWorkQueueFixtures(clock));
    render(<WorkQueuePage source={sourceOf('preview', load)} />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Verbindung fehlgeschlagen');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Erneut versuchen' }));

    expect(await screen.findByRole('heading', { name: 'Alex Beispiel' })).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shows an empty state when no cases are open', async () => {
    render(<WorkQueuePage source={sourceOf('preview', () => Promise.resolve([]))} />);
    expect(await screen.findByText('Keine offenen Vorgänge')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Vorgänge filtern' })).toBeNull();
  });

  it('summarizes open cases and lists them by shift start', async () => {
    render(<WorkQueuePage source={createWorkQueuePreviewSource(clock)} />);

    const summary = await screen.findByRole('region', { name: 'Zusammenfassung' });
    expect(summary.textContent).toContain('Offene Vorgänge6');
    expect(summary.textContent).toContain('Mit Ersatzangebot4');
    expect(summary.textContent).toContain('Ohne Ersatzangebot2');

    const cases = screen.getAllByRole('article');
    expect(cases.map((item) => within(item).getByRole('heading').textContent)).toEqual([
      'Alex Beispiel',
      'Kim Muster',
      'Jona Probe',
      'Sam Demo',
      'Mika Test',
      'Robin Platzhalter',
    ]);
    // Dates are relative to the fixed clock (15.12.2026).
    expect(cases[0].textContent).toContain('Mi., 16.12.2026 · Nachtdienst');
    expect(cases[0].textContent).toContain('Beispielzeit: 18:00 – 06:00 (Do., 17.12.2026)');
    expect(cases[0].textContent).toContain('Absage eingegangenDi., 15.12.2026');
  });

  it('filters by segment with labelled radios and shows status as text plus icon', async () => {
    const user = userEvent.setup();
    render(<WorkQueuePage source={createWorkQueuePreviewSource(clock)} />);
    await screen.findByRole('group', { name: 'Vorgänge filtern' });

    await user.click(screen.getByRole('radio', { name: 'Noch kein Ersatzangebot (2)' }));
    const cases = screen.getAllByRole('article');
    expect(cases).toHaveLength(2);
    expect(screen.getByText('2 von 6 Vorgängen angezeigt')).toBeTruthy();
    for (const item of cases) {
      const badge = within(item).getByText('Noch kein Ersatzangebot');
      expect(badge.querySelector('svg')).not.toBeNull();
    }

    await user.click(screen.getByRole('radio', { name: 'Ersatzangebote liegen vor (4)' }));
    expect(screen.getAllByRole('article')).toHaveLength(4);
    expect((screen.getByRole('radio', { name: 'Ersatzangebote liegen vor (4)' }) as HTMLInputElement).checked).toBe(true);
  });

  it('shows an empty segment state when a filter has no matches', async () => {
    const onlyWithOffers: WorkQueueCase[] = buildWorkQueueFixtures(clock).filter((item) => item.replacementOfferCount > 0);
    render(<WorkQueuePage source={sourceOf('preview', () => Promise.resolve(onlyWithOffers))} />);
    await userEvent.setup().click(await screen.findByRole('radio', { name: 'Noch kein Ersatzangebot (0)' }));
    expect(screen.getByText('Keine Vorgänge in dieser Auswahl')).toBeTruthy();
    expect(screen.queryAllByRole('article')).toHaveLength(0);
  });

  it('T-LABEL-1: labels every shift time as an example and explains the synthetic data', async () => {
    render(<WorkQueuePage source={createWorkQueuePreviewSource(clock)} />);
    const cases = await screen.findAllByRole('article');
    for (const item of cases) expect(item.textContent).toContain('Beispielzeit:');

    const notice = screen.getByRole('complementary', { name: 'Hinweis zu Demodaten' });
    expect(notice.textContent).toContain('Demodaten / UI-Vorschau');
    expect(notice.textContent?.replace(/\s+/g, ' ')).toContain(
      'synthetische Beispielwerte, keine freigegebenen Schicht- oder Planungsregeln',
    );
    expect(notice.textContent).toContain('Es werden keine Daten gespeichert.');
  });

  it('hides the preview notice and example label for a future API source', async () => {
    render(<WorkQueuePage source={sourceOf('api', () => Promise.resolve(buildWorkQueueFixtures(clock)))} />);
    const cases = await screen.findAllByRole('article');
    expect(screen.queryByText(/Demodaten/)).toBeNull();
    expect(cases[0].textContent).toContain('Dienstzeit:');
    expect(cases[0].textContent).not.toContain('Beispielzeit');
  });

  it('offers no decision or mutation controls and makes no network request', async () => {
    render(<WorkQueuePage source={createWorkQueuePreviewSource(clock)} />);
    await screen.findAllByRole('article');
    for (const button of screen.queryAllByRole('button')) {
      expect(button.textContent ?? '').not.toMatch(MUTATION_LABELS);
    }
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText(/Die Bearbeitung einzelner Vorgänge folgt in einer späteren Ausbaustufe/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
