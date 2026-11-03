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
const GRID_NAME = 'Dienste im Dezember 2026 nach Person und Tag';

function section(name: string) {
  return screen.getByRole('heading', { level: 2, name }).closest('section') as HTMLElement;
}

async function matrix(name = GRID_NAME) {
  return screen.findByRole('grid', { name });
}

function rowHeaders(grid: HTMLElement) {
  return within(grid).getAllByRole('rowheader').map((cell) => cell.textContent);
}

function cell(name: string) {
  return within(screen.getByRole('grid')).getByRole('button', { name });
}

/** The focus panel, a labelled region. */
function panel(name: string | RegExp) {
  return screen.getByRole('region', { name });
}

function form() {
  return panel('Dienst hinzufügen');
}

/** Opens the create form from the toolbar and waits for its shift-time read. */
async function openForm(user = userEvent.setup()) {
  await user.click(await screen.findByRole('button', { name: 'Dienst hinzufügen' }));
  return within(form()).findByLabelText('Datum');
}

function setDate(value: string) {
  fireEvent.change(within(form()).getByLabelText('Datum'), { target: { value } });
}

const DEC_3 = { dutyDate: '2026-12-03', startsAt: '2026-12-03T05:00:00Z', endsAt: '2026-12-03T17:00:00Z' };

describe('SP-12 A10 — plan page: employee-by-day matrix (real API source)', () => {
  it('shows status, one row per person, cells named by person, date and state, the day row, and only GET reads', async () => {
    const server = planningCompany({
      plans: [plan()],
      duties: {
        [PLAN_ID]: [
          duty({ ...DEC_3, assignments: [member(MIRA_ID, 'SHIFT_LEAD'), member(JONAS_ID)] }),
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
    expect(status.textContent).toContain('Dieser Monatsplan ist noch nicht veröffentlicht.');
    expect(status.textContent).not.toMatch(/Mitarbeitende sehen/);
    expect(within(status).getByRole('link', { name: /Schichtzeiten und Mitarbeiterzuordnung/ }).getAttribute('href'))
      .toBe(`/projekte/${HAFEN_ID}/2026-12`);
    // SP-13: the First Publish action sits in the plan status; opening the page sends no write.
    expect(await within(status).findByRole('button', { name: 'Monatsplan veröffentlichen …' })).toBeTruthy();

    const grid = await matrix();
    // Assigned persons (A09) plus every member; deactivated and unknown persons stay visible.
    expect(rowHeaders(grid)).toEqual([
      'Dienste am Tag', 'Mira BeispielA-001', 'Jonas MusterA-002', 'Lea ProbeA-003', 'Oskar TestA-004deaktiviert', 'Unbekannte Person',
    ]);
    expect(within(grid).getAllByRole('columnheader')).toHaveLength(32);
    expect(cell('Mira Beispiel, Do., 3. Dezember: Tagdienst, Schichtleitung').textContent).toBe('TagSL');
    expect(cell('Jonas Muster, Do., 3. Dezember: Tagdienst').textContent).toBe('Tag');
    expect(cell('Lea Probe, Do., 3. Dezember: frei').textContent).toBe('–');
    expect(cell('Unbekannte Person, Sa., 5. Dezember: Tagdienst').textContent).toBe('Tag');
    // A duty without members is still visible in the day row.
    expect(cell('Do., 31. Dezember: kein Tagdienst; Nachtdienst, ohne Besetzung').textContent).toBe('N0');
    expect(cell('Do., 3. Dezember: Tagdienst, 2 Personen; kein Nachtdienst').textContent).toBe('T2');
    // Roving tabindex: exactly one cell is in the tab order.
    expect(within(grid).getAllByRole('button').filter((button) => button.tabIndex === 0)).toHaveLength(1);
    expect(screen.getByText('5 Personen · 3 Dienste')).toBeTruthy();
    expect(screen.getByText(/in der Zeitzone dieses Geräts angezeigt \(Europe\/Berlin\)/)).toBeTruthy();

    expect(requests.map((request) => request.path).sort()).toEqual([
      `/api/v1/monthly-plans/${PLAN_ID}`,
      ENTRIES,
      `/api/v1/projects/${HAFEN_ID}`,
      '/api/v1/employees?pageSize=100',
      '/api/v1/project-assignments?monthStart=2026-12-01&pageSize=100',
    ].sort());
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('marks unavailable members neutrally at the cell, in the summary and in the panel; never says why', async () => {
    const lead = member(MIRA_ID, 'SHIFT_LEAD');
    const server = planningCompany({
      plans: [plan()],
      duties: {
        [PLAN_ID]: [duty({
          ...DEC_3,
          assignments: [lead, member(JONAS_ID)],
          availabilityConflicts: [{ code: 'EMPLOYEE_UNAVAILABLE', assignmentId: lead.id, employeeId: MIRA_ID }],
        })],
      },
    });
    renderPlanning(PLAN_PATH, server.handler);
    await matrix();
    const summary = screen.getByRole('group', { name: /Nicht verfügbare Personen/ });
    expect(summary.textContent).toContain('Eine eingeplante Person ist am Diensttag nicht verfügbar.');
    expect(summary.textContent).toContain('Bestehende Dienste werden dadurch nicht automatisch geändert.');
    expect(within(summary).getByRole('listitem').textContent).toBe('Do., 03.12.2026, Tagdienst: Mira Beispiel');
    const target = cell('Mira Beispiel, Do., 3. Dezember: Tagdienst, Schichtleitung, nicht verfügbar');
    expect(target.textContent).toBe('TagSL!');

    await userEvent.setup().click(target);
    const details = panel('Mira Beispiel · Do., 03.12.2026');
    expect(details.textContent).toContain('Am Diensttag nicht verfügbar.');
    expect(details.textContent).toContain('Mira Beispiel · Schichtleitung Nicht verfügbar');
    expect(document.body.textContent).not.toMatch(/krank|urlaub|sick|leave/i);
  });

  it('names both zones for a night duty across the end of daylight saving time', async () => {
    const server = planningCompany({
      plans: [plan({ monthStart: '2026-10-01' })],
      shiftVersions: [STANDARD_SHIFTS('2026-10-01')],
      duties: { [PLAN_ID]: [duty({ dutyDate: '2026-10-24', shiftKind: 'NIGHT', startsAt: '2026-10-24T16:00:00Z', endsAt: '2026-10-25T05:00:00Z' })] },
    });
    renderPlanning(PLAN_PATH, server.handler);
    await matrix('Dienste im Oktober 2026 nach Person und Tag');
    await userEvent.setup().click(cell('Sa., 24. Oktober: kein Tagdienst; Nachtdienst, ohne Besetzung'));
    expect(panel('Dienste am Sa., 24.10.2026').textContent).toContain('18:00 MESZ – 06:00 (So., 25.10.2026) MEZ');
  });

  it('shows the empty state; the create form shows the effective shift times and a hint for a missing kind', async () => {
    const server = planningCompany({ plans: [plan()], shiftVersions: [shiftVersion('2026-11-01', [['DAY', '07:00', '19:00']], HAFEN_ID)] });
    renderPlanning(PLAN_PATH, server.handler);
    expect(await screen.findByText('Noch keine Dienste')).toBeTruthy();
    await openForm();
    expect(form().textContent).toContain('Tagdienst: 07:00 – 19:00');
    expect(form().textContent).toContain('Nachtdienst: keine Schichtzeit hinterlegt');
    expect(within(form()).getByRole('link', { name: 'Schichtzeiten im Projekt festlegen' }).getAttribute('href')).toBe(`/projekte/${HAFEN_ID}/2026-12`);
  });

  it('a PUBLISHED plan states that duty changes apply at once, without re-publishing (CR-03)', async () => {
    const server = planningCompany({ plans: [plan({ status: 'PUBLISHED', publishedAt: '2026-11-30T12:00:00Z' })] });
    renderPlanning(PLAN_PATH, server.handler);
    const status = (await screen.findByRole('heading', { level: 2, name: 'Planstatus' })).closest('section')!;
    expect(status.textContent).toContain('Veröffentlicht am Mo., 30.11.2026, 13:00 MEZ.');
    expect(status.textContent).toContain('Änderungen an Diensten gelten sofort, ohne erneutes Veröffentlichen.');
    // SP-14 employee plan reads do not exist yet: no visibility promise, an explicit statement instead.
    expect(status.textContent).toContain('Mitarbeitende können veröffentlichte Monatspläne in dieser Ausbaustufe noch nicht abrufen.');
    expect(status.textContent).not.toMatch(/Mitarbeitende sehen/);
    // No re-publish (CR-03): a PUBLISHED plan offers no publish action at all.
    expect(within(status).queryByRole('button', { name: /veröffentlichen/i })).toBeNull();
  });

  it('an inactive project shows its duties but offers no creation', async () => {
    const server = planningCompany({ projects: [{ ...hafen, status: 'INACTIVE' }], plans: [plan()] });
    renderPlanning(PLAN_PATH, server.handler);
    expect(await screen.findByText('Noch keine Dienste')).toBeTruthy();
    expect(section('Dienste').textContent).toContain('Das Projekt ist inaktiv.');
    expect(screen.queryByRole('button', { name: 'Dienst hinzufügen' })).toBeNull();
    await userEvent.setup().click(cell('Fr., 4. Dezember: kein Tagdienst; kein Nachtdienst'));
    const details = panel('Dienste am Fr., 04.12.2026');
    expect(details.textContent).toContain('Für inaktive Projekte können keine Dienste angelegt werden.');
    expect(within(details).queryByRole('button', { name: /anlegen/ })).toBeNull();
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
    expect(screen.queryByRole('grid')).toBeNull();
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

  it('keyboard: arrows, Home/End and Ctrl+Home/End move one focusable cell; Enter opens the panel, Escape returns', async () => {
    renderPlanning(PLAN_PATH, planningCompany({ plans: [plan()] }).handler);
    const grid = await matrix();
    const user = userEvent.setup();
    const active = () => (document.activeElement as HTMLElement).getAttribute('aria-label');
    cell('Di., 1. Dezember: kein Tagdienst; kein Nachtdienst').focus();
    await user.keyboard('{ArrowRight}');
    expect(active()).toBe('Mi., 2. Dezember: kein Tagdienst; kein Nachtdienst');
    await user.keyboard('{ArrowDown}');
    expect(active()).toBe('Mira Beispiel, Mi., 2. Dezember: frei');
    await user.keyboard('{End}');
    expect(active()).toBe('Mira Beispiel, Do., 31. Dezember: frei');
    await user.keyboard('{Home}');
    expect(active()).toBe('Mira Beispiel, Di., 1. Dezember: frei');
    await user.keyboard('{ArrowUp}{ArrowUp}{ArrowLeft}');
    expect(active()).toBe('Di., 1. Dezember: kein Tagdienst; kein Nachtdienst');
    await user.keyboard('{Control>}{End}{/Control}');
    expect(active()).toBe('Oskar Test, Do., 31. Dezember: frei');
    expect(within(grid).getAllByRole('button').filter((button) => button.tabIndex === 0)).toHaveLength(1);

    await user.keyboard('{Enter}');
    const details = panel('Oskar Test · Do., 31.12.2026');
    await waitFor(() => expect(document.activeElement).toBe(within(details).getByRole('heading', { level: 3 })));
    expect(details.textContent).toContain('Deaktiviert');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'Oskar Test · Do., 31.12.2026' })).toBeNull();
    expect(active()).toBe('Oskar Test, Do., 31. Dezember: frei');
    await user.keyboard('{Control>}{Home}{/Control}');
    expect(active()).toBe('Di., 1. Dezember: kein Tagdienst; kein Nachtdienst');
  });

  it('search by name or code and the "hints only" filter narrow the rows, never the day row', async () => {
    const lead = member(MIRA_ID);
    const server = planningCompany({
      plans: [plan()],
      duties: {
        [PLAN_ID]: [duty({
          ...DEC_3,
          assignments: [lead],
          availabilityConflicts: [{ code: 'EMPLOYEE_UNAVAILABLE', assignmentId: lead.id, employeeId: MIRA_ID }],
        })],
      },
    });
    renderPlanning(PLAN_PATH, server.handler);
    const grid = await matrix();
    const user = userEvent.setup();
    const search = screen.getByLabelText('Person suchen');
    await user.type(search, 'muster');
    expect(rowHeaders(grid)).toEqual(['Dienste am Tag', 'Jonas MusterA-002']);
    expect(screen.getByText('4 Personen (1 angezeigt) · 1 Dienst')).toBeTruthy();
    await user.clear(search);
    await user.type(search, 'A-003');
    expect(rowHeaders(grid)).toEqual(['Dienste am Tag', 'Lea ProbeA-003']);
    await user.clear(search);
    await user.type(search, 'niemand');
    expect(screen.getByText('Keine Person entspricht der Auswahl.')).toBeTruthy();
    await user.clear(search);
    await user.click(screen.getByRole('checkbox', { name: 'Nur Personen mit Hinweisen' }));
    expect(rowHeaders(grid)).toEqual(['Dienste am Tag', 'Mira BeispielA-001']);
  });

  it('a free cell offers the missing duty prefilled with date, kind and person', async () => {
    const server = planningCompany({ plans: [plan()] });
    const { requests } = renderPlanning(PLAN_PATH, server.handler);
    await matrix();
    const user = userEvent.setup();
    await user.click(cell('Mira Beispiel, Fr., 4. Dezember: frei'));
    const details = panel('Mira Beispiel · Fr., 04.12.2026');
    expect(details.textContent).toContain('Tag und Nacht');
    expect(details.textContent).toContain('Im Dezember 2026 zugeordnet');
    expect(within(details).getByText('An diesem Tag').nextElementSibling?.textContent).toBe('frei');
    await user.click(within(details).getByRole('button', { name: 'Nachtdienst anlegen' }));

    const date = await within(form()).findByLabelText('Datum');
    expect((date as HTMLInputElement).value).toBe('2026-12-04');
    expect((within(form()).getByRole('radio', { name: 'Nachtdienst' }) as HTMLInputElement).checked).toBe(true);
    expect((within(form()).getByRole('checkbox', { name: 'Mira Beispiel (A-001)' }) as HTMLInputElement).checked).toBe(true);
    await user.click(within(form()).getByRole('button', { name: 'Dienst anlegen' }));

    expect(await screen.findByText('Der Nachtdienst am Fr., 04.12.2026 wurde angelegt.')).toBeTruthy();
    expect(requests.find((request) => request.method === 'POST')?.body).toEqual({
      dutyDate: '2026-12-04', shiftKind: 'NIGHT', assignments: [{ employeeId: MIRA_ID, dutyRole: 'EMPLOYEE' }],
    });
    expect(cell('Mira Beispiel, Fr., 4. Dezember: Nachtdienst').textContent).toBe('Nacht');
    expect(screen.queryByRole('region', { name: 'Dienst hinzufügen' })).toBeNull();
  });

  it('an untouched prefill holds nothing back; switching cells with unsaved input asks first', async () => {
    const { location } = renderPlanning(PLAN_PATH, planningCompany({ plans: [plan()] }).handler);
    await matrix();
    const user = userEvent.setup();
    await user.click(cell('Mira Beispiel, Fr., 4. Dezember: frei'));
    await user.click(within(panel('Mira Beispiel · Fr., 04.12.2026')).getByRole('button', { name: 'Tagdienst anlegen' }));
    await within(form()).findByLabelText('Datum');
    // Untouched: another cell opens without a question.
    await user.click(cell('Lea Probe, Fr., 4. Dezember: frei'));
    expect(panel('Lea Probe · Fr., 04.12.2026')).toBeTruthy();

    await user.click(within(panel('Lea Probe · Fr., 04.12.2026')).getByRole('button', { name: 'Tagdienst anlegen' }));
    await within(form()).findByLabelText('Datum');
    setDate('2026-12-05');
    await user.click(cell('Jonas Muster, Fr., 4. Dezember: frei'));
    const prompt = await within(form()).findByRole('group', { name: 'Ungespeicherter Dienst' });
    await user.click(within(prompt).getByRole('button', { name: 'Weiter bearbeiten' }));
    expect((within(form()).getByLabelText('Datum') as HTMLInputElement).value).toBe('2026-12-05');
    await user.click(cell('Jonas Muster, Fr., 4. Dezember: frei'));
    await user.click(within(await within(form()).findByRole('group', { name: 'Ungespeicherter Dienst' }))
      .getByRole('button', { name: 'Eingaben verwerfen und wechseln' }));
    expect(panel('Jonas Muster · Fr., 04.12.2026')).toBeTruthy();
    expect(location()).toBe(PLAN_PATH);
  });

  it('SP-13 integration point: the publish slot sees unsaved panel input and stays blocked until it is gone', async () => {
    renderPlanning(PLAN_PATH, planningCompany({ plans: [plan()] }).handler);
    const user = userEvent.setup();
    await openForm(user);
    setDate('2026-12-05');
    const publish = within(section('Planstatus')).getByRole('button', { name: 'Monatsplan veröffentlichen …' });
    expect(publish.getAttribute('aria-disabled')).toBe('true');
    expect(publish.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(publish.getAttribute('aria-describedby')!)!.textContent)
      .toContain('ungespeicherte Eingaben');
    await user.click(publish);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // Discarding the input (closing the panel) unblocks it.
    await user.click(within(form()).getByRole('button', { name: 'Schließen' }));
    await user.click(within(await within(form()).findByRole('group', { name: 'Ungespeicherter Dienst' }))
      .getByRole('button', { name: 'Eingaben verwerfen und wechseln' }));
    await waitFor(() => expect(publish.getAttribute('aria-disabled')).toBeNull());
  });
});

describe('SP-11 PR-2 / SP-12 A10 — add a duty from the focus panel', () => {
  it('offers only eligible employees of this project and month and explains the excluded ones', async () => {
    renderPlanning(PLAN_PATH, planningCompany({ plans: [plan()] }).handler);
    const user = userEvent.setup();
    await openForm(user);
    expect(form().textContent).toContain('Wählen Sie zuerst Datum und Dienstart');
    setDate('2026-12-16');
    await user.click(within(form()).getByRole('radio', { name: 'Nachtdienst' }));

    const list = within(form()).getByRole('list', { name: 'Auswählbare Personen' });
    // Mira (BOTH, employed) only: Jonas is DAY-only, Lea left on 15.12., Oskar is deactivated; Paul is not assigned.
    expect(within(list).getAllByRole('checkbox').map((box) => box.closest('label')?.textContent)).toEqual(['Mira Beispiel (A-001)']);
    const excluded = within(form()).getByText('3 weitere zugeordnete Personen sind nicht auswählbar').closest('details')!;
    expect(within(excluded).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Jonas Muster: nicht für diese Dienstart freigegeben',
      'Lea Probe: am Diensttag nicht beschäftigt',
      'Oskar Test: deaktiviert',
    ]);
    expect(form().textContent).not.toContain('Paul Anders');
    expect(form().textContent).toContain('Abwesenheiten und Überschneidungen prüft SecurePlan beim Speichern.');

    setDate('2026-12-15');
    await user.click(within(form()).getByRole('radio', { name: 'Tagdienst' }));
    expect(within(within(form()).getByRole('list', { name: 'Auswählbare Personen' })).getAllByRole('checkbox')).toHaveLength(3);
  });

  it('creates the duty with exactly the selected members and roles; the matrix and a focused notice show it', async () => {
    const server = planningCompany({ plans: [plan()] });
    const { requests } = renderPlanning(PLAN_PATH, server.handler);
    const user = userEvent.setup();
    await openForm(user);
    setDate('2026-12-03');
    await user.click(within(form()).getByRole('radio', { name: 'Tagdienst' }));
    const role = within(form()).getByRole('combobox', { name: 'Funktion im Dienst für Jonas Muster' });
    expect(role.hasAttribute('disabled')).toBe(true);
    await user.click(within(form()).getByRole('checkbox', { name: 'Jonas Muster (A-002)' }));
    await user.click(within(form()).getByRole('checkbox', { name: 'Mira Beispiel (A-001)' }));
    expect(role.hasAttribute('disabled')).toBe(false);
    await user.selectOptions(within(form()).getByRole('combobox', { name: 'Funktion im Dienst für Mira Beispiel' }), 'Schichtleitung');
    expect(within(form()).getByText('2 Personen ausgewählt')).toBeTruthy();

    await user.click(within(form()).getByRole('button', { name: 'Dienst anlegen' }));
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
    expect(cell('Mira Beispiel, Do., 3. Dezember: Tagdienst, Schichtleitung')).toBeTruthy();
    expect(cell('Jonas Muster, Do., 3. Dezember: Tagdienst')).toBeTruthy();
    expect(cell('Do., 3. Dezember: Tagdienst, 2 Personen; kein Nachtdienst')).toBeTruthy();
    // The panel closed; the server answer, not a re-read, filled the matrix.
    expect(screen.queryByRole('region', { name: 'Dienst hinzufügen' })).toBeNull();
    expect(requests.filter((request) => request.path === ENTRIES && request.method === 'GET')).toHaveLength(1);
  });

  it('allows a duty without members (no staffing minimum) and a night duty on the last day of the year', async () => {
    const server = planningCompany({ plans: [plan()] });
    const { requests } = renderPlanning(PLAN_PATH, server.handler);
    const user = userEvent.setup();
    await openForm(user);
    setDate('2026-12-31');
    await user.click(within(form()).getByRole('radio', { name: 'Nachtdienst' }));
    await user.click(within(form()).getByRole('button', { name: 'Dienst anlegen' }));
    expect(await screen.findByText('Der Nachtdienst am Do., 31.12.2026 wurde angelegt.')).toBeTruthy();
    expect(requests.find((request) => request.method === 'POST')?.body).toEqual({ dutyDate: '2026-12-31', shiftKind: 'NIGHT', assignments: [] });
    await userEvent.setup().click(cell('Do., 31. Dezember: kein Tagdienst; Nachtdienst, ohne Besetzung'));
    expect(panel('Dienste am Do., 31.12.2026').textContent).toContain('18:00 – 06:00 (Fr., 01.01.2027) MEZ · noch keine Besetzung');
  });

  it('validates on the client before any request and focuses the first problem', async () => {
    const server = planningCompany({ plans: [plan()], duties: { [PLAN_ID]: [duty(DEC_3)] } });
    const { requests } = renderPlanning(PLAN_PATH, server.handler);
    const user = userEvent.setup();
    const date = await openForm(user);
    await user.click(within(form()).getByRole('button', { name: 'Dienst anlegen' }));
    expect(within(form()).getByText('Bitte wählen Sie ein Datum.')).toBeTruthy();
    expect(within(form()).getByText('Bitte wählen Sie Tagdienst oder Nachtdienst.')).toBeTruthy();
    expect(date.getAttribute('aria-invalid')).toBe('true');
    expect(date.getAttribute('aria-describedby')).toContain(within(form()).getByText('Bitte wählen Sie ein Datum.').id);
    await waitFor(() => expect(document.activeElement).toBe(date));

    // Outside the plan month (year boundary) and an occupied slot.
    setDate('2027-01-01');
    await user.click(within(form()).getByRole('radio', { name: 'Tagdienst' }));
    await user.click(within(form()).getByRole('button', { name: 'Dienst anlegen' }));
    expect(within(form()).getByText('Das Datum muss im Dezember 2026 liegen.')).toBeTruthy();
    setDate('2026-12-03');
    await user.click(within(form()).getByRole('button', { name: 'Dienst anlegen' }));
    expect(within(form()).getByText('Am Do., 03.12.2026 gibt es in diesem Plan bereits einen Tagdienst.')).toBeTruthy();
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
    const user = userEvent.setup();
    await openForm(user);
    setDate('2026-12-03');
    await user.click(within(form()).getByRole('radio', { name: 'Tagdienst' }));
    await user.click(within(form()).getByRole('checkbox', { name: 'Mira Beispiel (A-001)' }));
    await user.click(within(form()).getByRole('button', { name: 'Dienst anlegen' }));
    const alert = await within(form()).findByRole('alert');
    expect(alert.textContent).toContain(title);
    expect(alert.textContent).toContain('Es wurde nichts gespeichert.');
    expect(alert.textContent).not.toMatch(/krank|urlaub/i);
    expect((within(form()).getByLabelText('Datum') as HTMLInputElement).value).toBe('2026-12-03');
    expect((within(form()).getByRole('radio', { name: 'Tagdienst' }) as HTMLInputElement).checked).toBe(true);
    expect((within(form()).getByRole('checkbox', { name: 'Mira Beispiel (A-001)' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Noch keine Dienste')).toBeTruthy();
  });

  it('the in-memory server refuses an absent member neutrally (EMPLOYEE_UNAVAILABLE); nothing is stored', async () => {
    const server = planningCompany({ plans: [plan()], unavailable: new Set([`${MIRA_ID}|2026-12-03`]) });
    renderPlanning(PLAN_PATH, server.handler);
    const user = userEvent.setup();
    await openForm(user);
    setDate('2026-12-03');
    await user.click(within(form()).getByRole('radio', { name: 'Tagdienst' }));
    await user.click(within(form()).getByRole('checkbox', { name: 'Mira Beispiel (A-001)' }));
    await user.click(within(form()).getByRole('button', { name: 'Dienst anlegen' }));
    expect((await within(form()).findByRole('alert')).textContent).toContain('Eine ausgewählte Person ist am Diensttag nicht verfügbar.');
    expect(server.state.duties[PLAN_ID]).toEqual([]);
  });

  it('SHIFT_CONFIGURATION_MISSING links to the project shift times', async () => {
    const server = planningCompany({ plans: [plan()], shiftVersions: [shiftVersion('2026-12-01', [['DAY', '06:00', '18:00']], HAFEN_ID)] });
    renderPlanning(PLAN_PATH, server.handler);
    const user = userEvent.setup();
    await openForm(user);
    setDate('2026-12-03');
    await user.click(within(form()).getByRole('radio', { name: 'Nachtdienst' }));
    await user.click(within(form()).getByRole('button', { name: 'Dienst anlegen' }));
    expect((await within(form()).findByRole('alert')).textContent).toContain('Keine Schichtzeiten hinterlegt');
    expect(within(form()).getAllByRole('link', { name: 'Schichtzeiten im Projekt festlegen' }).length).toBeGreaterThan(0);
  });

  it('a lost response: outcome unknown, no automatic retry; reloading the duties keeps the panel and its input', async () => {
    const server = planningCompany({ plans: [plan()] });
    server.fail((request) => (request.method === 'POST' ? new ApiError('network', null, null, null) : undefined));
    const { requests } = renderPlanning(PLAN_PATH, server.handler);
    const user = userEvent.setup();
    await openForm(user);
    setDate('2026-12-03');
    await user.click(within(form()).getByRole('radio', { name: 'Tagdienst' }));
    await user.click(within(form()).getByRole('button', { name: 'Dienst anlegen' }));
    const alert = await within(form()).findByRole('alert');
    expect(alert.textContent).toContain('Ergebnis unbekannt');
    expect(within(alert).queryByRole('button', { name: 'Erneut versuchen' })).toBeNull();
    await user.click(within(form()).getByRole('button', { name: 'Dienste neu laden' }));
    expect(within(form()).queryByRole('alert')).toBeNull();
    await waitFor(() => expect(requests.filter((request) => request.path === ENTRIES && request.method === 'GET')).toHaveLength(2));
    expect((within(form()).getByLabelText('Datum') as HTMLInputElement).value).toBe('2026-12-03');
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('a double submit sends one request; the form is locked while saving', async () => {
    const response = deferred<unknown>();
    const server = planningCompany({ plans: [plan()] });
    const { requests } = renderPlanning(PLAN_PATH, (request) => (request.method === 'POST' ? response.promise : server.handler(request)));
    const user = userEvent.setup();
    await openForm(user);
    setDate('2026-12-03');
    await user.click(within(form()).getByRole('radio', { name: 'Tagdienst' }));
    await user.dblClick(within(form()).getByRole('button', { name: 'Dienst anlegen' }));
    expect(within(form()).getByRole('button', { name: 'Dienst wird angelegt …' }).hasAttribute('disabled')).toBe(true);
    expect((within(form()).getByLabelText('Datum') as HTMLInputElement).disabled).toBe(true);
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    response.resolve(duty(DEC_3));
    expect(await screen.findByText('Der Tagdienst am Do., 03.12.2026 wurde angelegt.')).toBeTruthy();
  });

  it('holds navigation while input is unsaved: stay keeps it, discarding leaves exactly once', async () => {
    const server = planningCompany({ plans: [plan()] });
    const { location } = renderPlanning(PLAN_PATH, server.handler);
    const user = userEvent.setup();
    await openForm(user);
    setDate('2026-12-03');
    await user.click(screen.getByRole('link', { name: 'Zurück zur Übersicht' }));
    const prompt = await screen.findByRole('group', { name: 'Ungespeicherter Dienst' });
    expect(document.activeElement).toBe(within(prompt).getByRole('heading'));
    expect(location()).toBe(PLAN_PATH);

    await user.click(within(prompt).getByRole('button', { name: 'Weiter bearbeiten' }));
    expect(screen.queryByRole('group', { name: 'Ungespeicherter Dienst' })).toBeNull();
    expect((within(form()).getByLabelText('Datum') as HTMLInputElement).value).toBe('2026-12-03');

    await user.click(screen.getByRole('link', { name: 'Zurück zur Übersicht' }));
    await user.click(await screen.findByRole('button', { name: 'Eingaben verwerfen und wechseln' }));
    await waitFor(() => expect(location()).toBe('/monatsplanung?month=2026-12'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Monatsplanung' })).toBeTruthy();
  });

  it('a clean form never holds navigation', async () => {
    const { location } = renderPlanning(PLAN_PATH, planningCompany({ plans: [plan()] }).handler);
    const user = userEvent.setup();
    await openForm(user);
    await user.click(screen.getByRole('link', { name: 'Zurück zur Übersicht' }));
    await waitFor(() => expect(location()).toBe('/monatsplanung?month=2026-12'));
  });

  it('says so when nobody is assigned to the project in the plan month', async () => {
    const server = planningCompany({ plans: [plan()], assignments: monthAssignments(HAFEN_ID, '2026-11-01', [MIRA_ID, PAUL_ID]) });
    renderPlanning(PLAN_PATH, server.handler);
    const grid = await matrix();
    expect(rowHeaders(grid)).toEqual(['Dienste am Tag']);
    const board = section('Dienste');
    expect(board.textContent).toContain('Diesem Projekt ist im Dezember 2026 noch niemand zugeordnet.');
    expect(within(board).getByRole('link', { name: 'Mitarbeitende im Projekt zuordnen' }).getAttribute('href')).toBe(`/projekte/${HAFEN_ID}/2026-12`);
    await openForm();
    expect(form().textContent).toContain('Diesem Projekt ist im Dezember 2026 noch niemand zugeordnet.');
  });

  it('works under StrictMode (effects run twice) without duplicate writes', async () => {
    const server = planningCompany({ plans: [plan()] });
    const { requests } = renderPlanning(PLAN_PATH, server.handler, { strict: true });
    const user = userEvent.setup();
    await openForm(user);
    setDate('2026-12-04');
    await user.click(within(form()).getByRole('radio', { name: 'Tagdienst' }));
    await user.click(within(form()).getByRole('checkbox', { name: 'Lea Probe (A-003)' }));
    await user.click(within(form()).getByRole('button', { name: 'Dienst anlegen' }));
    expect(await screen.findByText('Der Tagdienst am Fr., 04.12.2026 wurde angelegt.')).toBeTruthy();
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    expect(server.state.duties[PLAN_ID][0].assignments.map((item) => item.employeeId)).toEqual([LEA_ID]);
  });
});
