// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/monatsplanung"}
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../../../shared/api/api-error';
import { deferred, httpError } from '../../employees/employees.test-support';
import { shiftVersion } from '../../projects/projects.test-support';
import {
  HAFEN_ID,
  JONAS_ID,
  LEA_ID,
  MIRA_ID,
  PAUL_ID,
  PLAN_ID,
  STANDARD_SHIFTS,
  duty,
  hafen,
  member,
  monthAssignments,
  plan,
  planningCompany,
} from './monthly-planning.test-support';
import { renderPlanning } from './monthly-planning-render.test-support';

afterEach(() => cleanup());

const PLAN_PATH = `/monatsplanung/${PLAN_ID}`;
const ENTRIES = `/api/v1/monthly-plans/${PLAN_ID}/entries`;
const UNKNOWN_EMPLOYEE = 'f9999999-9999-4999-8999-999999999999';

function section(name: string) {
  return screen.getByRole('heading', { level: 2, name }).closest('section') as HTMLElement;
}

async function dutiesTable() {
  return screen.findByRole('table', { name: /^Dienste im / });
}

function rowTexts(table: HTMLElement) {
  return within(table).getAllByRole('row').slice(1).map((row) =>
    [...row.querySelectorAll('th, td')].map((cell) => cell.textContent));
}

/** Waits for the page and the form's own reads (assignments, shift times). */
async function openForm() {
  const heading = await screen.findByRole('heading', { level: 2, name: 'Dienst hinzufügen' });
  return within(heading.closest('section') as HTMLElement).findByLabelText('Datum');
}

function setDate(value: string) {
  fireEvent.change(screen.getByLabelText('Datum'), { target: { value } });
}

describe('SP-11 PR-2 — plan page: stored duties (real API source)', () => {
  it('shows status, members, resolved times (named zone) and the year-end night duty', async () => {
    const server = planningCompany({
      plans: [plan()],
      duties: {
        [PLAN_ID]: [
          duty({
            dutyDate: '2026-12-03', startsAt: '2026-12-03T05:00:00Z', endsAt: '2026-12-03T17:00:00Z',
            assignments: [member(MIRA_ID, 'SHIFT_LEAD'), member(JONAS_ID)],
          }),
          duty({ dutyDate: '2026-12-31', shiftKind: 'NIGHT', startsAt: '2026-12-31T17:00:00Z', endsAt: '2027-01-01T05:00:00Z' }),
          duty({ dutyDate: '2026-12-05', startsAt: '2026-12-05T05:00:00Z', endsAt: '2026-12-05T17:00:00Z', assignments: [member(UNKNOWN_EMPLOYEE)] }),
        ],
      },
    });
    const { requests } = renderPlanning(PLAN_PATH, server.handler);
    expect(screen.getByText('Monatsplan wird geladen …').closest('[role="status"]')).not.toBeNull();
    expect(await screen.findByRole('heading', { level: 1, name: 'Demo-Objekt Hafen – Dezember 2026' })).toBeTruthy();
    const status = section('Planstatus');
    expect(status.textContent).toContain('Unveröffentlicht');
    expect(status.textContent).toContain('Das Veröffentlichen ist in dieser Ausbaustufe noch nicht verfügbar.');
    expect(within(status).getByRole('link', { name: /Schichtzeiten und Mitarbeiterzuordnung/ }).getAttribute('href'))
      .toBe(`/projekte/${HAFEN_ID}/2026-12`);
    // No publish, edit or delete action exists in this slice.
    expect(screen.queryByRole('button', { name: /veröffentlichen|bearbeiten|löschen|entfernen/i })).toBeNull();

    const table = await dutiesTable();
    expect(rowTexts(table)).toEqual([
      ['Do., 03.12.2026', 'Tagdienst', '06:00 – 18:00 MEZ', 'Mira Beispiel · SchichtleitungJonas Muster'],
      ['Sa., 05.12.2026', 'Tagdienst', '06:00 – 18:00 MEZ', 'Unbekannte Person'],
      ['Do., 31.12.2026', 'Nachtdienst', '18:00 – 06:00 (Fr., 01.01.2027) MEZ', 'Noch keine Besetzung'],
    ]);
    expect(screen.getByText('3 Dienste')).toBeTruthy();
    expect(screen.getByText(/in der Zeitzone dieses Geräts angezeigt \(Europe\/Berlin\)/)).toBeTruthy();
    expect(requests.map((request) => request.path).sort()).toEqual([
      `/api/v1/monthly-plans/${PLAN_ID}`,
      ENTRIES,
      `/api/v1/projects/${HAFEN_ID}`,
      '/api/v1/employees?pageSize=100',
      '/api/v1/project-assignments?monthStart=2026-12-01&pageSize=100',
      `/api/v1/projects/${HAFEN_ID}/shift-configuration?effectiveForMonth=2026-12-01`,
    ].sort());
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('marks unavailable members neutrally in place and in a summary; never says why', async () => {
    const lead = member(MIRA_ID, 'SHIFT_LEAD');
    const server = planningCompany({
      plans: [plan()],
      duties: {
        [PLAN_ID]: [duty({
          dutyDate: '2026-12-03', startsAt: '2026-12-03T05:00:00Z', endsAt: '2026-12-03T17:00:00Z',
          assignments: [lead, member(JONAS_ID)],
          availabilityConflicts: [{ code: 'EMPLOYEE_UNAVAILABLE', assignmentId: lead.id, employeeId: MIRA_ID }],
        })],
      },
    });
    renderPlanning(PLAN_PATH, server.handler);
    const table = await dutiesTable();
    const summary = screen.getByRole('group', { name: /Nicht verfügbare Personen/ });
    expect(summary.textContent).toContain('Eine eingeplante Person ist am Diensttag nicht verfügbar.');
    expect(summary.textContent).toContain('Bestehende Dienste werden dadurch nicht automatisch geändert.');
    expect(within(summary).getByRole('listitem').textContent).toBe('Do., 03.12.2026, Tagdienst: Mira Beispiel');
    const cell = within(table).getAllByRole('cell')[2];
    expect(within(cell).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Mira Beispiel · Schichtleitung Nicht verfügbar',
      'Jonas Muster',
    ]);
    expect(document.body.textContent).not.toMatch(/krank|urlaub|sick|leave/i);
  });

  it('names both zones for a night duty across the end of daylight saving time', async () => {
    const october = plan({ monthStart: '2026-10-01' });
    const server = planningCompany({
      plans: [october],
      shiftVersions: [STANDARD_SHIFTS('2026-10-01')],
      duties: { [PLAN_ID]: [duty({ dutyDate: '2026-10-24', shiftKind: 'NIGHT', startsAt: '2026-10-24T16:00:00Z', endsAt: '2026-10-25T05:00:00Z' })] },
    });
    renderPlanning(PLAN_PATH, server.handler);
    expect(rowTexts(await dutiesTable())[0][2]).toBe('18:00 MESZ – 06:00 (So., 25.10.2026) MEZ');
  });

  it('shows the empty state, the effective shift times and a hint for a missing kind', async () => {
    const server = planningCompany({ plans: [plan()], shiftVersions: [shiftVersion('2026-11-01', [['DAY', '07:00', '19:00']], HAFEN_ID)] });
    renderPlanning(PLAN_PATH, server.handler);
    expect(await screen.findByText('Noch keine Dienste')).toBeTruthy();
    const form = section('Dienst hinzufügen');
    await within(form).findByLabelText('Datum');
    expect(form.textContent).toContain('Tagdienst: 07:00 – 19:00');
    expect(form.textContent).toContain('Nachtdienst: keine Schichtzeit hinterlegt');
    expect(within(form).getByRole('link', { name: 'Schichtzeiten im Projekt festlegen' }).getAttribute('href')).toBe(`/projekte/${HAFEN_ID}/2026-12`);
  });

  it('renders a PUBLISHED plan fixture read-only (fixture only: this slice has no publish endpoint)', async () => {
    const server = planningCompany({ plans: [plan({ status: 'PUBLISHED', publishedAt: '2026-11-30T12:00:00Z' })] });
    renderPlanning(PLAN_PATH, server.handler);
    const status = await screen.findByRole('heading', { level: 2, name: 'Planstatus' });
    expect(status.closest('section')?.textContent).toContain('Veröffentlicht am Mo., 30.11.2026, 13:00 MEZ.');
  });

  it('an inactive project shows its duties but no form', async () => {
    const server = planningCompany({ projects: [{ ...hafen, status: 'INACTIVE' }], plans: [plan()] });
    renderPlanning(PLAN_PATH, server.handler);
    expect(await screen.findByText('Noch keine Dienste')).toBeTruthy();
    expect(section('Dienst hinzufügen').textContent).toContain('Das Projekt ist inaktiv.');
    expect(screen.queryByLabelText('Datum')).toBeNull();
  });

  it.each([
    [404, 'RESOURCE_NOT_FOUND', 'Nicht gefunden'],
    [403, 'ACTION_FORBIDDEN', 'Kein Zugriff'],
  ] as const)('a %s for the plan shows a safe state without plan data', async (status, code, title) => {
    const server = planningCompany({ plans: [] });
    server.fail(() => httpError(status, code));
    renderPlanning(PLAN_PATH, server.handler);
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((alert) => alert.textContent?.includes(title))).toBe(true);
    expect(screen.getByRole('heading', { level: 1, name: 'Monatsplan' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Zurück zur Übersicht' }).getAttribute('href')).toBe('/monatsplanung');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('a failed duty read is retryable on its own; the plan header stays', async () => {
    const server = planningCompany({ plans: [plan()] });
    server.fail((request) => (request.path === ENTRIES ? new ApiError('network', null, null, null) : undefined));
    renderPlanning(PLAN_PATH, server.handler);
    const duties = await screen.findByRole('heading', { level: 2, name: 'Dienste' });
    const alert = await within(duties.closest('section')!).findByRole('alert');
    expect(alert.textContent).toContain('Verbindung fehlgeschlagen');
    expect(section('Planstatus')).toBeTruthy();
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Erneut versuchen' }));
    expect(await screen.findByText('Noch keine Dienste')).toBeTruthy();
  });
});

describe('SP-11 PR-2 — add a duty', () => {
  it('offers only eligible employees of this project and month and explains the excluded ones', async () => {
    renderPlanning(PLAN_PATH, planningCompany({ plans: [plan()] }).handler);
    await openForm();
    const form = section('Dienst hinzufügen');
    expect(form.textContent).toContain('Wählen Sie zuerst Datum und Dienstart');
    const user = userEvent.setup();
    setDate('2026-12-16');
    await user.click(within(form).getByRole('radio', { name: 'Nachtdienst' }));

    const list = within(form).getByRole('list', { name: 'Auswählbare Personen' });
    // Mira (BOTH, employed) only: Jonas is DAY-only, Lea left on 15.12., Oskar is deactivated; Paul is not assigned.
    expect(within(list).getAllByRole('checkbox').map((box) => box.closest('label')?.textContent)).toEqual(['Mira Beispiel (A-001)']);
    const excluded = within(form).getByText('3 weitere zugeordnete Personen sind nicht auswählbar').closest('details')!;
    expect(within(excluded).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Jonas Muster: nicht für diese Dienstart freigegeben',
      'Lea Probe: am Diensttag nicht beschäftigt',
      'Oskar Test: deaktiviert',
    ]);
    expect(form.textContent).not.toContain('Paul Anders');
    expect(form.textContent).toContain('Abwesenheiten und Überschneidungen prüft SecurePlan beim Speichern.');

    // Last employed day and the day kind: Lea and Jonas become selectable.
    setDate('2026-12-15');
    await user.click(within(form).getByRole('radio', { name: 'Tagdienst' }));
    expect(within(within(form).getByRole('list', { name: 'Auswählbare Personen' })).getAllByRole('checkbox')).toHaveLength(3);
  });

  it('creates the duty with exactly the selected members and roles; the row and a focused notice appear', async () => {
    const server = planningCompany({ plans: [plan()] });
    const { requests } = renderPlanning(PLAN_PATH, server.handler);
    await openForm();
    const form = section('Dienst hinzufügen');
    const user = userEvent.setup();
    setDate('2026-12-03');
    await user.click(within(form).getByRole('radio', { name: 'Tagdienst' }));
    const role = within(form).getByRole('combobox', { name: 'Funktion im Dienst für Jonas Muster' });
    expect(role.hasAttribute('disabled')).toBe(true);
    await user.click(within(form).getByRole('checkbox', { name: 'Jonas Muster (A-002)' }));
    await user.click(within(form).getByRole('checkbox', { name: 'Mira Beispiel (A-001)' }));
    expect(role.hasAttribute('disabled')).toBe(false);
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Funktion im Dienst für Mira Beispiel' }), 'Schichtleitung');
    expect(within(form).getByText('2 Personen ausgewählt')).toBeTruthy();

    await user.click(within(form).getByRole('button', { name: 'Dienst anlegen' }));
    const notice = await screen.findByText('Der Tagdienst am Do., 03.12.2026 wurde angelegt.');
    await waitFor(() => expect(document.activeElement).toBe(notice));
    const post = requests.filter((request) => request.method === 'POST');
    expect(post).toHaveLength(1);
    expect(post[0].path).toBe(ENTRIES);
    expect(post[0].body).toEqual({
      dutyDate: '2026-12-03',
      shiftKind: 'DAY',
      // Members in the displayed (name) order; the server sorts for its checks.
      assignments: [{ employeeId: MIRA_ID, dutyRole: 'SHIFT_LEAD' }, { employeeId: JONAS_ID, dutyRole: 'EMPLOYEE' }],
    });
    expect(rowTexts(await dutiesTable())).toEqual([
      ['Do., 03.12.2026', 'Tagdienst', '06:00 – 18:00 MEZ', 'Mira Beispiel · SchichtleitungJonas Muster'],
    ]);
    // The form is clean again; the server answer, not a re-read, filled the row.
    expect((screen.getByLabelText('Datum') as HTMLInputElement).value).toBe('');
    expect(requests.filter((request) => request.path === ENTRIES && request.method === 'GET')).toHaveLength(1);
  });

  it('allows a duty without members (no staffing minimum) and a night duty on the last day of the year', async () => {
    const server = planningCompany({ plans: [plan()] });
    const { requests } = renderPlanning(PLAN_PATH, server.handler);
    await openForm();
    const form = section('Dienst hinzufügen');
    const user = userEvent.setup();
    setDate('2026-12-31');
    await user.click(within(form).getByRole('radio', { name: 'Nachtdienst' }));
    await user.click(within(form).getByRole('button', { name: 'Dienst anlegen' }));
    expect(await screen.findByText('Der Nachtdienst am Do., 31.12.2026 wurde angelegt.')).toBeTruthy();
    expect(requests.find((request) => request.method === 'POST')?.body).toEqual({ dutyDate: '2026-12-31', shiftKind: 'NIGHT', assignments: [] });
    expect(rowTexts(await dutiesTable())).toEqual([
      ['Do., 31.12.2026', 'Nachtdienst', '18:00 – 06:00 (Fr., 01.01.2027) MEZ', 'Noch keine Besetzung'],
    ]);
  });

  it('validates on the client before any request and focuses the first problem', async () => {
    const server = planningCompany({
      plans: [plan()],
      duties: { [PLAN_ID]: [duty({ dutyDate: '2026-12-03', startsAt: '2026-12-03T05:00:00Z', endsAt: '2026-12-03T17:00:00Z' })] },
    });
    const { requests } = renderPlanning(PLAN_PATH, server.handler);
    const date = await openForm();
    const form = section('Dienst hinzufügen');
    const user = userEvent.setup();
    await user.click(within(form).getByRole('button', { name: 'Dienst anlegen' }));
    expect(within(form).getByText('Bitte wählen Sie ein Datum.')).toBeTruthy();
    expect(within(form).getByText('Bitte wählen Sie Tagdienst oder Nachtdienst.')).toBeTruthy();
    expect(date.getAttribute('aria-invalid')).toBe('true');
    expect(date.getAttribute('aria-describedby')).toContain(within(form).getByText('Bitte wählen Sie ein Datum.').id);
    await waitFor(() => expect(document.activeElement).toBe(date));

    // Outside the plan month (year boundary) and an occupied slot.
    setDate('2027-01-01');
    await user.click(within(form).getByRole('radio', { name: 'Tagdienst' }));
    await user.click(within(form).getByRole('button', { name: 'Dienst anlegen' }));
    expect(within(form).getByText('Das Datum muss im Dezember 2026 liegen.')).toBeTruthy();
    setDate('2026-12-03');
    await user.click(within(form).getByRole('button', { name: 'Dienst anlegen' }));
    expect(within(form).getByText('Am Do., 03.12.2026 gibt es in diesem Plan bereits einen Tagdienst.')).toBeTruthy();
    expect(requests.filter((request) => request.method === 'POST')).toEqual([]);
  });

  it.each([
    ['2026-12', '2026-12-01', '2026-12-31'],
    ['2028-02', '2028-02-01', '2028-02-29'],
    ['2027-02', '2027-02-01', '2027-02-28'],
  ])('limits the date field to the plan month %s', async (month, min, max) => {
    const server = planningCompany({ plans: [plan({ monthStart: `${month}-01` })], shiftVersions: [STANDARD_SHIFTS(`${month}-01`)] });
    renderPlanning(PLAN_PATH, server.handler);
    const date = await openForm();
    expect([date.getAttribute('min'), date.getAttribute('max')]).toEqual([min, max]);
  });

  it.each([
    ['EMPLOYEE_UNAVAILABLE', 'Person nicht verfügbar'],
    ['DUTY_ASSIGNMENT_CONFLICT', 'Zeitliche Überschneidung'],
    ['EMPLOYEE_NOT_ASSIGNED_TO_PROJECT_MONTH', 'Nicht dem Projekt zugeordnet'],
    ['DUTY_TIME_RANGE_INVALID', 'Dienstzeit nicht bestimmbar'],
  ] as const)('a server refusal %s keeps every input and says nothing was saved', async (code, title) => {
    const server = planningCompany({ plans: [plan()] });
    server.fail((request) => (request.method === 'POST' ? httpError(409, code) : undefined));
    renderPlanning(PLAN_PATH, server.handler);
    await openForm();
    const form = section('Dienst hinzufügen');
    const user = userEvent.setup();
    setDate('2026-12-03');
    await user.click(within(form).getByRole('radio', { name: 'Tagdienst' }));
    await user.click(within(form).getByRole('checkbox', { name: 'Mira Beispiel (A-001)' }));
    await user.click(within(form).getByRole('button', { name: 'Dienst anlegen' }));
    const alert = await within(form).findByRole('alert');
    expect(alert.textContent).toContain(title);
    expect(alert.textContent).toContain('Es wurde nichts gespeichert.');
    expect(alert.textContent).not.toMatch(/krank|urlaub/i);
    expect((screen.getByLabelText('Datum') as HTMLInputElement).value).toBe('2026-12-03');
    expect((within(form).getByRole('radio', { name: 'Tagdienst' }) as HTMLInputElement).checked).toBe(true);
    expect((within(form).getByRole('checkbox', { name: 'Mira Beispiel (A-001)' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Noch keine Dienste')).toBeTruthy();
  });

  it('the in-memory server refuses an absent member neutrally (EMPLOYEE_UNAVAILABLE); nothing is stored', async () => {
    const server = planningCompany({ plans: [plan()], unavailable: new Set([`${MIRA_ID}|2026-12-03`]) });
    renderPlanning(PLAN_PATH, server.handler);
    await openForm();
    const form = section('Dienst hinzufügen');
    const user = userEvent.setup();
    setDate('2026-12-03');
    await user.click(within(form).getByRole('radio', { name: 'Tagdienst' }));
    await user.click(within(form).getByRole('checkbox', { name: 'Mira Beispiel (A-001)' }));
    await user.click(within(form).getByRole('button', { name: 'Dienst anlegen' }));
    expect((await within(form).findByRole('alert')).textContent).toContain('Eine ausgewählte Person ist am Diensttag nicht verfügbar.');
    expect(server.state.duties[PLAN_ID]).toEqual([]);
  });

  it('SHIFT_CONFIGURATION_MISSING links to the project shift times', async () => {
    const server = planningCompany({ plans: [plan()], shiftVersions: [shiftVersion('2026-12-01', [['DAY', '06:00', '18:00']], HAFEN_ID)] });
    renderPlanning(PLAN_PATH, server.handler);
    await openForm();
    const form = section('Dienst hinzufügen');
    const user = userEvent.setup();
    setDate('2026-12-03');
    await user.click(within(form).getByRole('radio', { name: 'Nachtdienst' }));
    await user.click(within(form).getByRole('button', { name: 'Dienst anlegen' }));
    expect((await within(form).findByRole('alert')).textContent).toContain('Keine Schichtzeiten hinterlegt');
    expect(within(form).getAllByRole('link', { name: 'Schichtzeiten im Projekt festlegen' }).length).toBeGreaterThan(0);
  });

  it('a lost response: outcome unknown, no automatic retry; reloading the duties keeps the form', async () => {
    const server = planningCompany({ plans: [plan()] });
    server.fail((request) => (request.method === 'POST' ? new ApiError('network', null, null, null) : undefined));
    const { requests } = renderPlanning(PLAN_PATH, server.handler);
    await openForm();
    const form = section('Dienst hinzufügen');
    const user = userEvent.setup();
    setDate('2026-12-03');
    await user.click(within(form).getByRole('radio', { name: 'Tagdienst' }));
    await user.click(within(form).getByRole('button', { name: 'Dienst anlegen' }));
    const alert = await within(form).findByRole('alert');
    expect(alert.textContent).toContain('Ergebnis unbekannt');
    expect(within(alert).queryByRole('button', { name: 'Erneut versuchen' })).toBeNull();
    await user.click(within(form).getByRole('button', { name: 'Dienste neu laden' }));
    expect(within(form).queryByRole('alert')).toBeNull();
    expect((screen.getByLabelText('Datum') as HTMLInputElement).value).toBe('2026-12-03');
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    expect(requests.filter((request) => request.path === ENTRIES && request.method === 'GET')).toHaveLength(2);
  });

  it('a double submit sends one request; the form is locked while saving', async () => {
    const response = deferred<unknown>();
    const server = planningCompany({ plans: [plan()] });
    const { requests } = renderPlanning(PLAN_PATH, (request) => (request.method === 'POST' ? response.promise : server.handler(request)));
    await openForm();
    const form = section('Dienst hinzufügen');
    const user = userEvent.setup();
    setDate('2026-12-03');
    await user.click(within(form).getByRole('radio', { name: 'Tagdienst' }));
    await user.dblClick(within(form).getByRole('button', { name: 'Dienst anlegen' }));
    expect(within(form).getByRole('button', { name: 'Dienst wird angelegt …' }).hasAttribute('disabled')).toBe(true);
    expect((screen.getByLabelText('Datum') as HTMLInputElement).disabled).toBe(true);
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    response.resolve(duty({ dutyDate: '2026-12-03', startsAt: '2026-12-03T05:00:00Z', endsAt: '2026-12-03T17:00:00Z' }));
    expect(await screen.findByText('Der Tagdienst am Do., 03.12.2026 wurde angelegt.')).toBeTruthy();
  });

  it('holds navigation while input is unsaved: stay keeps it, discarding leaves exactly once', async () => {
    const server = planningCompany({ plans: [plan()] });
    const { location } = renderPlanning(PLAN_PATH, server.handler);
    await openForm();
    const user = userEvent.setup();
    setDate('2026-12-03');
    await user.click(screen.getByRole('link', { name: 'Zurück zur Übersicht' }));
    const prompt = await screen.findByRole('group', { name: 'Ungespeicherter Dienst' });
    expect(document.activeElement).toBe(within(prompt).getByRole('heading'));
    expect(location()).toBe(PLAN_PATH);

    await user.click(within(prompt).getByRole('button', { name: 'Weiter bearbeiten' }));
    expect(screen.queryByRole('group', { name: 'Ungespeicherter Dienst' })).toBeNull();
    expect((screen.getByLabelText('Datum') as HTMLInputElement).value).toBe('2026-12-03');

    await user.click(screen.getByRole('link', { name: 'Zurück zur Übersicht' }));
    await user.click(await screen.findByRole('button', { name: 'Eingaben verwerfen und wechseln' }));
    await waitFor(() => expect(location()).toBe('/monatsplanung?month=2026-12'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Monatsplanung' })).toBeTruthy();
  });

  it('a clean form never holds navigation', async () => {
    const { location } = renderPlanning(PLAN_PATH, planningCompany({ plans: [plan()] }).handler);
    await openForm();
    await userEvent.setup().click(screen.getByRole('link', { name: 'Zurück zur Übersicht' }));
    await waitFor(() => expect(location()).toBe('/monatsplanung?month=2026-12'));
  });

  it('says so when nobody is assigned to the project in the plan month', async () => {
    const server = planningCompany({ plans: [plan()], assignments: monthAssignments(HAFEN_ID, '2026-11-01', [MIRA_ID, PAUL_ID]) });
    renderPlanning(PLAN_PATH, server.handler);
    await openForm();
    const form = section('Dienst hinzufügen');
    expect(form.textContent).toContain('Diesem Projekt ist im Dezember 2026 noch niemand zugeordnet.');
    expect(within(form).getByRole('link', { name: 'Mitarbeitende im Projekt zuordnen' }).getAttribute('href')).toBe(`/projekte/${HAFEN_ID}/2026-12`);
  });

  it('works under StrictMode (effects run twice) without duplicate writes', async () => {
    const server = planningCompany({ plans: [plan()] });
    const { requests } = renderPlanning(PLAN_PATH, server.handler, { strict: true });
    await openForm();
    const form = section('Dienst hinzufügen');
    const user = userEvent.setup();
    setDate('2026-12-04');
    await user.click(within(form).getByRole('radio', { name: 'Tagdienst' }));
    await user.click(within(form).getByRole('checkbox', { name: 'Lea Probe (A-003)' }));
    await user.click(within(form).getByRole('button', { name: 'Dienst anlegen' }));
    expect(await screen.findByText('Der Tagdienst am Fr., 04.12.2026 wurde angelegt.')).toBeTruthy();
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    expect(server.state.duties[PLAN_ID][0].assignments.map((item) => item.employeeId)).toEqual([LEA_ID]);
  });
});
