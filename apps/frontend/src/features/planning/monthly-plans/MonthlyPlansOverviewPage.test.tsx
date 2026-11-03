// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/monatsplanung"}
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../../../shared/api/api-error';
import { deferred, httpError } from '../../employees/employees.test-support';
import {
  NORD_ID,
  PLAN_ID,
  hafen,
  messe,
  nord,
  plan,
  planningCompany,
} from './monthly-planning.test-support';
import { renderPlanning } from './monthly-planning-render.test-support';

afterEach(() => cleanup());

const MONTH_READS = (monthStart: string) => [
  '/api/v1/projects?pageSize=100',
  `/api/v1/monthly-plans?monthStart=${monthStart}&pageSize=100`,
];

function table() {
  return screen.findByRole('table', { name: /^Projekte und Monatspläne im / });
}

function rowOf(name: string) {
  const row = screen.getByRole('rowheader', { name }).closest('tr');
  if (!row) throw new Error(`row ${name} missing`);
  return row;
}

describe('SP-11 PR-2 — month overview (real API source)', () => {
  it('lists every project of the month with its plan state; actions depend on plan and project status', async () => {
    const server = planningCompany({ projects: [hafen, messe, nord], plans: [plan()] });
    const { requests } = renderPlanning('/monatsplanung', server.handler);
    expect(screen.getByRole('heading', { level: 1, name: 'Monatsplanung' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Monatspläne werden geladen');

    await table();
    expect(screen.getByRole('heading', { level: 3, name: 'Dezember 2026' })).toBeTruthy();
    expect(screen.getByText('3 Projekte · 1 Monatsplan im Dezember 2026')).toBeTruthy();

    const open = within(rowOf('Demo-Objekt Hafen')).getByRole('link', { name: 'Monatsplan Demo-Objekt Hafen, Dezember 2026 öffnen' });
    expect(open.getAttribute('href')).toBe(`/monatsplanung/${PLAN_ID}`);
    expect(within(rowOf('Demo-Objekt Hafen')).getByText('Unveröffentlicht').closest('.status-badge')?.querySelector('svg')).not.toBeNull();
    expect(within(rowOf('Demo-Objekt Nord')).getByText('Kein Monatsplan')).toBeTruthy();
    expect(within(rowOf('Demo-Objekt Nord')).getByRole('button', { name: 'Monatsplan für Demo-Objekt Nord, Dezember 2026 erstellen …' })).toBeTruthy();
    // An inactive project gets no create action (the server would refuse it with PROJECT_INACTIVE).
    expect(within(rowOf('Demo-Objekt Messe')).queryByRole('button')).toBeNull();
    expect(within(rowOf('Demo-Objekt Messe')).getByText('Projekt inaktiv – kein neuer Monatsplan möglich')).toBeTruthy();

    // Reads only; tenant and role are never part of a request.
    expect(requests.map((request) => request.path)).toEqual(MONTH_READS('2026-12-01'));
    expect(requests.every((request) => request.method === 'GET' && request.body === undefined)).toBe(true);
  });

  it('steps across the year boundary and back; focus stays on the month link', async () => {
    const server = planningCompany({ projects: [hafen], plans: [plan({ id: 'e1111111-1111-4111-8111-111111111111', monthStart: '2027-01-01' })] });
    const { requests, location } = renderPlanning('/monatsplanung', server.handler);
    await table();
    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: 'Nächster Monat: Januar 2027' }));
    await waitFor(() => expect(location()).toBe('/monatsplanung?month=2027-01'));
    expect(await screen.findByRole('link', { name: 'Monatsplan Demo-Objekt Hafen, Januar 2027 öffnen' })).toBeTruthy();
    expect(document.activeElement?.textContent).toContain('Nächster Monat');

    await user.click(screen.getByRole('link', { name: 'Vorheriger Monat: Dezember 2026' }));
    await waitFor(() => expect(location()).toBe('/monatsplanung?month=2026-12'));
    expect(await screen.findByText('Kein Monatsplan')).toBeTruthy();
    expect(requests.map((request) => request.path)).toEqual([
      ...MONTH_READS('2026-12-01'),
      ...MONTH_READS('2027-01-01'),
      ...MONTH_READS('2026-12-01'),
    ]);
  });

  it.each(['2026-13', '1999-12', '2026-1', 'abc'])('replaces the invalid month %s with the current month', async (month) => {
    const { location } = renderPlanning(`/monatsplanung?month=${month}`, planningCompany().handler);
    await waitFor(() => expect(location()).toBe('/monatsplanung'));
    expect(await screen.findByRole('heading', { level: 3, name: 'Dezember 2026' })).toBeTruthy();
  });

  it('distinguishes a company without projects and links to the projects area', async () => {
    renderPlanning('/monatsplanung', planningCompany({ projects: [] }).handler);
    expect(await screen.findByText('Noch keine Projekte')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Zu den Projekten' }).getAttribute('href')).toBe('/projekte');
  });

  it('shows a safe, retryable error for a failed load', async () => {
    const server = planningCompany({ projects: [hafen] });
    server.fail((request) => (request.path.startsWith('/api/v1/monthly-plans') ? new ApiError('network', null, null, null) : undefined));
    renderPlanning('/monatsplanung', server.handler);
    expect((await screen.findByRole('alert')).textContent).toContain('Verbindung fehlgeschlagen');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(await screen.findByText('Kein Monatsplan')).toBeTruthy();
  });

  it('shows "Kein Zugriff" when the server refuses the read (403); no data is shown', async () => {
    const server = planningCompany({ projects: [hafen] });
    server.fail(() => httpError(403, 'ACTION_FORBIDDEN'));
    renderPlanning('/monatsplanung', server.handler);
    expect((await screen.findByRole('alert')).textContent).toContain('Kein Zugriff');
    expect(screen.queryByText('Demo-Objekt Hafen')).toBeNull();
  });
});

describe('SP-11 PR-2 — create an UNPUBLISHED plan', () => {
  it('asks for confirmation; cancel sends nothing and returns focus to the trigger', async () => {
    const server = planningCompany({ projects: [nord] });
    const { requests } = renderPlanning('/monatsplanung', server.handler);
    await table();
    const user = userEvent.setup();
    const trigger = screen.getByRole('button', { name: 'Monatsplan für Demo-Objekt Nord, Dezember 2026 erstellen …' });
    await user.click(trigger);
    const panel = screen.getByRole('group', { name: 'Monatsplan für Demo-Objekt Nord, Dezember 2026 erstellen?' });
    expect(document.activeElement).toBe(within(panel).getByRole('heading', { level: 3 }));
    expect(panel.textContent).toContain('unveröffentlicht angelegt');
    expect(panel.textContent).toContain('in dieser Ausbaustufe nicht gelöscht werden');
    // No employee-visibility promise ("not yet" would imply a view after publication; SP-14 reads do not exist).
    expect(panel.textContent).not.toMatch(/Mitarbeitende sehen/);

    await user.click(within(panel).getByRole('button', { name: 'Abbrechen' }));
    expect(screen.queryByRole('group')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });

  it('creates exactly the selected project and month and opens the new plan with a notice', async () => {
    const server = planningCompany({ projects: [nord] });
    const { requests, location } = renderPlanning('/monatsplanung?month=2027-01', server.handler);
    await table();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Monatsplan für Demo-Objekt Nord, Januar 2027 erstellen …' }));
    await user.click(screen.getByRole('button', { name: 'Monatsplan erstellen' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Demo-Objekt Nord – Januar 2027' })).toBeTruthy();
    expect(location()).toMatch(/^\/monatsplanung\/e0000000-0000-4000-8000-\d{12}$/);
    expect(screen.getByText('Der Monatsplan wurde erstellt. Er ist unveröffentlicht; legen Sie jetzt die Dienste an.')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Planstatus' }).closest('section')?.textContent).toContain('Unveröffentlicht');
    expect(requests.filter((request) => request.method === 'POST')).toEqual([
      { path: '/api/v1/monthly-plans', method: 'POST', body: { projectId: NORD_ID, monthStart: '2027-01-01' } },
    ]);
    expect(server.state.plans).toHaveLength(1);
  });

  it('a double click sends one request; the button shows the pending state', async () => {
    const response = deferred<unknown>();
    const server = planningCompany({ projects: [nord] });
    const { requests } = renderPlanning('/monatsplanung', (request) =>
      request.method === 'POST' ? response.promise : server.handler(request));
    await table();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^Monatsplan für Demo-Objekt Nord/ }));
    const confirm = screen.getByRole('button', { name: 'Monatsplan erstellen' });
    await user.dblClick(confirm);
    const pending = screen.getByRole('button', { name: 'Monatsplan wird erstellt …' });
    expect(pending.hasAttribute('disabled')).toBe(true);
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    response.resolve(plan({ projectId: NORD_ID }));
    expect(await screen.findByRole('heading', { level: 1, name: /^Monatsplan|Demo-Objekt Nord/ })).toBeTruthy();
  });

  it('MONTHLY_PLAN_ALREADY_EXISTS (another admin was faster): explains and re-reads only on request', async () => {
    const server = planningCompany({ projects: [hafen] });
    const { requests } = renderPlanning('/monatsplanung', server.handler);
    await table();
    // Another administrator creates the plan meanwhile.
    server.state.plans.push(plan());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^Monatsplan für Demo-Objekt Hafen/ }));
    await user.click(screen.getByRole('button', { name: 'Monatsplan erstellen' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Monatsplan existiert bereits');
    expect(alert.textContent).toContain('Es wurde nichts gespeichert.');
    expect(alert.textContent).toContain('Referenz-ID: req-sp07-1');
    expect(screen.queryByRole('button', { name: 'Monatsplan erstellen' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Übersicht neu laden' }));
    expect(await screen.findByRole('link', { name: 'Monatsplan Demo-Objekt Hafen, Dezember 2026 öffnen' })).toBeTruthy();
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('a lost response claims neither success nor failure and is never retried automatically', async () => {
    const server = planningCompany({ projects: [hafen] });
    server.fail((request) => (request.method === 'POST' ? new ApiError('network', null, null, null) : undefined));
    const { requests } = renderPlanning('/monatsplanung', server.handler);
    await table();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^Monatsplan für Demo-Objekt Hafen/ }));
    await user.click(screen.getByRole('button', { name: 'Monatsplan erstellen' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Ergebnis unbekannt');
    expect(within(alert).queryByRole('button', { name: 'Erneut versuchen' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Übersicht neu laden' })).toBeTruthy();
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('PROJECT_INACTIVE (status changed meanwhile) uses the plan wording', async () => {
    const server = planningCompany({ projects: [hafen] });
    server.fail((request) => (request.method === 'POST' ? httpError(409, 'PROJECT_INACTIVE') : undefined));
    renderPlanning('/monatsplanung', server.handler);
    await table();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^Monatsplan für Demo-Objekt Hafen/ }));
    await user.click(screen.getByRole('button', { name: 'Monatsplan erstellen' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Für ein inaktives Projekt kann kein Monatsplan erstellt werden.');
    expect(screen.getByRole('button', { name: 'Monatsplan erstellen' })).toBeTruthy();
  });

  it('a month step discards an open confirmation', async () => {
    renderPlanning('/monatsplanung', planningCompany({ projects: [hafen, messe] }).handler);
    await table();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^Monatsplan für Demo-Objekt Hafen/ }));
    expect(screen.getByRole('group')).toBeTruthy();
    await user.click(screen.getByRole('link', { name: 'Nächster Monat: Januar 2027' }));
    expect(await screen.findByRole('heading', { level: 3, name: 'Januar 2027' })).toBeTruthy();
    expect(screen.queryByRole('group')).toBeNull();
  });
});
