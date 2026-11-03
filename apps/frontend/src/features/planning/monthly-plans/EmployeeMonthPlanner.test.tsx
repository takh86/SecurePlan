// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { deferred } from '../../employees/employees.test-support';
import { fullName } from '../../employees/employee-types';
import type { Project } from '../../projects/project-types';
import { EmployeeMonthPlanner } from './EmployeeMonthPlanner';
import type { EmployeeMonthSave, EmployeeMonthSaveOutcome, ProjectCalendar } from './employee-month-draft';
import type { Duty, MonthlyPlan } from './monthly-plan-types';
import {
  HAFEN_ID,
  JONAS_ID,
  LEA_ID,
  MIRA_ID,
  OSKAR_ID,
  duty,
  hafen,
  member,
  monthAssignments,
  plan,
  staff,
} from './monthly-planning.test-support';
import { buildMatrixRows } from './planning-matrix';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const NAMES = new Map(staff.map((employee) => [employee.id.toLowerCase(), fullName(employee)]));
const nameOf = (id: string) => NAMES.get(id.toLowerCase()) ?? 'Unbekannte Person';

function dec(day: number): string {
  return `2026-12-${String(day).padStart(2, '0')}`;
}

function dayDuty(day: number, overrides: Partial<Duty> = {}): Duty {
  return duty({ dutyDate: dec(day), startsAt: `${dec(day)}T05:00:00Z`, endsAt: `${dec(day)}T17:00:00Z`, ...overrides });
}

function nightDuty(day: number, overrides: Partial<Duty> = {}): Duty {
  return duty({ dutyDate: dec(day), shiftKind: 'NIGHT', startsAt: `${dec(day)}T17:00:00Z`, endsAt: `${dec(day + 1)}T05:00:00Z`, ...overrides });
}

type Options = {
  duties?: Duty[];
  employeeId?: string;
  save?: EmployeeMonthSave;
  plan?: MonthlyPlan;
  project?: Project;
  month?: string;
  calendar?: ProjectCalendar;
};

/** Renders the planner for one person; `update` simulates a newer duty read of the page. */
function renderPlanner(options: Options = {}) {
  const month = options.month ?? '2026-12';
  const monthStart = `${month}-01`;
  const assignments = monthAssignments(HAFEN_ID, monthStart, [MIRA_ID, JONAS_ID, LEA_ID, OSKAR_ID]);
  const onReload = vi.fn();
  const onEditStateChange = vi.fn();
  const element = (duties: Duty[]) => {
    const person = buildMatrixRows(staff, assignments, duties, HAFEN_ID, monthStart)
      .find((row) => row.key === (options.employeeId ?? MIRA_ID).toLowerCase())!;
    return (
      <EmployeeMonthPlanner
        plan={options.plan ?? plan({ monthStart })}
        project={options.project ?? hafen}
        month={month}
        person={person}
        duties={duties}
        nameOf={nameOf}
        save={options.save}
        calendar={options.calendar}
        onReload={onReload}
        reloading={false}
        onEditStateChange={onEditStateChange}
      />
    );
  };
  const view = render(element(options.duties ?? []));
  return { ...view, onReload, onEditStateChange, update: (duties: Duty[]) => view.rerender(element(duties)) };
}

/** The calendar button of a date; its name is `Do., 3. Dezember: <state>`. */
function dateButton(day: number, month = 'Dezember') {
  return within(screen.getByRole('grid')).getByRole('button', { name: new RegExp(`^[A-Z][a-z]\\., ${day}\\. ${month}:`) });
}

function stateOf(day: number) {
  return dateButton(day).getAttribute('aria-label')!.split(': ')[1];
}

function description(button: HTMLElement) {
  const id = button.getAttribute('aria-describedby');
  return id ? document.getElementById(id)!.textContent : '';
}

function modeRadio(label: 'Tag' | 'Nacht' | 'Frei') {
  return within(screen.getByRole('group', { name: 'Eintragen als' })).getByRole('radio', { name: label });
}

function changes() {
  return screen.getByRole('region', { name: /Ungespeicherte Änderungen/ });
}

function changeCount() {
  return changes().querySelector('h4')!.textContent;
}

function saveButton() {
  return screen.getByRole('button', { name: /^Monat (speichern|wird gespeichert)/ });
}

function saveNote() {
  return document.getElementById(saveButton().getAttribute('aria-describedby')!)!.textContent;
}

function dayDetails() {
  return screen.getByRole('region', { name: /^Ausgewählter Tag:/ });
}

const FREE = 'Frei (nicht eingeplant)';

describe('#88 employee-month planner — preview', () => {
  it('is a labelled preview: Monat speichern is unavailable, explains why and writes nothing', async () => {
    const user = userEvent.setup();
    renderPlanner();
    expect(screen.getByText(/Monat einer Person planen – noch ohne Speichern/)).toBeTruthy();
    await user.click(modeRadio('Tag'));
    await user.click(dateButton(3));
    expect(saveButton().getAttribute('aria-disabled')).toBe('true');
    expect(saveNote()).toBe('Vorschau: Das Speichern eines ganzen Monats ist noch nicht freigegeben. Es wird nichts gespeichert.');
    await user.click(saveButton());
    expect(stateOf(3)).toBe('Tagdienst (Mitarbeitende)');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the month as a Monday-first calendar with stored duties, and says that no weekday is blocked yet', () => {
    renderPlanner({ duties: [dayDuty(3, { assignments: [member(MIRA_ID, 'SHIFT_LEAD'), member(JONAS_ID)] }), nightDuty(4, { assignments: [member(MIRA_ID)] })] });
    const grid = screen.getByRole('grid', { name: 'Dienste von Mira Beispiel im Dezember 2026' });
    expect(within(grid).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']);
    expect(within(grid).getAllByRole('button')).toHaveLength(31);
    expect(grid.querySelectorAll('tbody tr')).toHaveLength(5);
    // 1 December 2026 is a Tuesday: the first row starts with one empty Monday.
    expect(grid.querySelector('tbody tr')!.children[1].querySelector('button')!.getAttribute('aria-label')).toBe(`Di., 1. Dezember: ${FREE}`);
    expect(stateOf(3)).toBe('Tagdienst (Schichtleitung)');
    expect(dateButton(3).textContent).toContain('SL');
    expect(stateOf(4)).toBe('Nachtdienst (Mitarbeitende)');
    expect(screen.getByText('Im Monat: 1 × Tag, 1 × Nacht, 29 × Frei')).toBeTruthy();
    expect(screen.getByText(/Die Ansicht sperrt keine Wochentage/)).toBeTruthy();
    expect(within(changes()).getByText('Keine ungespeicherten Änderungen.')).toBeTruthy();
  });

  it('follows the calendar at month boundaries (29 days in February 2028)', () => {
    renderPlanner({ month: '2028-02' });
    const grid = screen.getByRole('grid', { name: 'Dienste von Mira Beispiel im Februar 2028' });
    expect(within(grid).getAllByRole('button')).toHaveLength(29);
    expect(dateButton(29, 'Februar').getAttribute('aria-label')).toBe(`Di., 29. Februar: ${FREE}`);
    expect(within(grid).queryByRole('button', { name: /März/ })).toBeNull();
  });
});

describe('#88 employee-month planner — TAG / NACHT / FREI paint modes', () => {
  it('runs the acceptance scenario with single clicks: TAG 1, 2, 5, 10 · NACHT 17, 19 · FREI 5 · TAG 2 again · NACHT on 1', async () => {
    const user = userEvent.setup();
    const { onEditStateChange } = renderPlanner();
    await user.click(modeRadio('Tag'));
    for (const day of [1, 2, 5, 10]) await user.click(dateButton(day));
    await user.click(modeRadio('Nacht'));
    for (const day of [17, 19]) await user.click(dateButton(day));
    await user.click(modeRadio('Frei'));
    await user.click(dateButton(5));
    expect(stateOf(5)).toBe(FREE);
    expect(changeCount()).toBe('Ungespeicherte Änderungen (5)');

    // Repeating the active mode changes nothing.
    await user.click(modeRadio('Tag'));
    await user.click(dateButton(2));
    expect(screen.getByRole('status').textContent).toBe('Mi., 2. Dezember: bereits Tagdienst (Mitarbeitende), keine Änderung.');
    expect(stateOf(2)).toBe('Tagdienst (Mitarbeitende)');
    expect(changeCount()).toBe('Ungespeicherte Änderungen (5)');

    // NACHT on a TAG date replaces it.
    await user.click(modeRadio('Nacht'));
    await user.click(dateButton(1));
    expect(screen.getByRole('status').textContent).toBe('Di., 1. Dezember: Nachtdienst (Mitarbeitende).');
    expect(stateOf(1)).toBe('Nachtdienst (Mitarbeitende)');
    expect(changeCount()).toBe('Ungespeicherte Änderungen (5)');
    expect(screen.getByText('Im Monat: 2 × Tag, 3 × Nacht, 26 × Frei')).toBeTruthy();
    expect(changes().textContent).toContain('01.12.2026 · neu: Nachtdienst (Mitarbeitende) – Dienst noch nicht angelegt');
    for (const button of within(screen.getByRole('grid')).getAllByRole('button')) {
      expect(button.getAttribute('aria-label')).not.toMatch(/Tagdienst und Nachtdienst/);
    }
    expect(onEditStateChange).toHaveBeenLastCalledWith('dirty');
  });

  it('asks for a mode first: a click without a mode changes nothing but shows the date', async () => {
    const user = userEvent.setup();
    renderPlanner();
    await user.click(dateButton(8));
    expect(stateOf(8)).toBe(FREE);
    expect(screen.getByRole('status').textContent).toBe('Wählen Sie zuerst Tag, Nacht oder Frei.');
    expect(dayDetails().querySelector('h4')!.textContent).toBe('Ausgewählter Tag: Di., 8. Dezember');
    expect(within(changes()).getByText('Keine ungespeicherten Änderungen.')).toBeTruthy();
  });

  it('replaces a stored TAG with NACHT, keeps Schichtleitung of the stored shift and lists other members as unchanged', async () => {
    const user = userEvent.setup();
    const { onEditStateChange } = renderPlanner({
      duties: [dayDuty(3, { assignments: [member(MIRA_ID, 'SHIFT_LEAD'), member(JONAS_ID)] }), nightDuty(3, { assignments: [member(LEA_ID)] })],
    });
    await user.click(modeRadio('Nacht'));
    await user.click(dateButton(3));
    expect(stateOf(3)).toBe('Nachtdienst (Mitarbeitende)');
    expect(description(dateButton(3))).toContain('Geändert, bisher Tagdienst (Schichtleitung), noch nicht gespeichert');
    expect(changes().textContent).toContain('Nachtdienst (Mitarbeitende) statt Tagdienst (Schichtleitung)');
    expect(dayDetails().textContent).toContain('Tagdienst, weitere Personen (bleiben unverändert): Jonas Muster');
    expect(dayDetails().textContent).toContain('Nachtdienst, weitere Personen (bleiben unverändert): Lea Probe');

    await user.click(within(within(dayDetails()).getByRole('group', { name: 'Funktion im Nachtdienst' })).getByRole('radio', { name: 'Schichtleitung' }));
    expect(stateOf(3)).toBe('Nachtdienst (Schichtleitung)');
    await user.click(dateButton(3));
    expect(stateOf(3)).toBe('Nachtdienst (Schichtleitung)');

    // TAG again restores the stored day duty with its stored role: nothing is left to save.
    await user.click(modeRadio('Tag'));
    await user.click(dateButton(3));
    expect(stateOf(3)).toBe('Tagdienst (Schichtleitung)');
    expect(within(changes()).getByText('Keine ungespeicherten Änderungen.')).toBeTruthy();
    expect(onEditStateChange).toHaveBeenLastCalledWith('clean');
  });

  it('offers one tab stop, moves by day and week, chooses modes with T/N/F and paints with Space or Enter — never both shifts', async () => {
    const user = userEvent.setup();
    renderPlanner();
    const grid = screen.getByRole('grid');
    const stops = within(grid).getAllByRole('button').filter((button) => button.tabIndex === 0);
    expect(stops.map((button) => button.getAttribute('aria-label'))).toEqual([`Di., 1. Dezember: ${FREE}`]);
    stops[0].focus();
    const focused = () => document.activeElement!.getAttribute('aria-label')!.split(':')[0];
    await user.keyboard('{ArrowRight}');
    expect(focused()).toBe('Mi., 2. Dezember');
    await user.keyboard('{ArrowDown}');
    expect(focused()).toBe('Mi., 9. Dezember');
    await user.keyboard('{End}');
    expect(focused()).toBe('So., 13. Dezember');
    await user.keyboard('{Home}');
    expect(focused()).toBe('Mo., 7. Dezember');
    await user.keyboard('{ArrowUp}');
    expect(focused()).toBe('Mo., 7. Dezember');
    await user.keyboard('{ArrowLeft}');
    expect(focused()).toBe('So., 6. Dezember');
    await user.keyboard('{Control>}{End}{/Control}');
    expect(focused()).toBe('Do., 31. Dezember');
    expect(dayDetails().querySelector('h4')!.textContent).toBe('Ausgewählter Tag: Do., 31. Dezember');

    await user.keyboard('n');
    expect((modeRadio('Nacht') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('Eintragen als: Nacht.');
    await user.keyboard(' ');
    expect(stateOf(31)).toBe('Nachtdienst (Mitarbeitende)');
    await user.keyboard('t');
    await user.keyboard('{Enter}');
    expect(stateOf(31)).toBe('Tagdienst (Mitarbeitende)');
    expect(changeCount()).toBe('Ungespeicherte Änderungen (1)');
    await user.keyboard(' ');
    expect(screen.getByRole('status').textContent).toBe('Do., 31. Dezember: bereits Tagdienst (Mitarbeitende), keine Änderung.');
    expect(focused()).toBe('Do., 31. Dezember');
    await user.keyboard('f ');
    expect(stateOf(31)).toBe(FREE);
    expect(changeCount()).toBe('Ungespeicherte Änderungen (0)');

    await user.keyboard('t ');
    await user.keyboard('{Control>}{Home}{/Control}');
    expect(focused()).toBe('Di., 1. Dezember');
    expect(within(grid).getAllByRole('button').filter((button) => button.tabIndex === 0)).toHaveLength(1);
    // The date link in the change list returns focus to the calendar.
    await user.click(within(changes()).getByRole('button', { name: 'Do., 31.12.2026' }));
    expect(focused()).toBe('Do., 31. Dezember');
  });
});

describe('#88 employee-month planner — restrictions and corrections', () => {
  it('does not offer what the static rules exclude, but always offers Frei', async () => {
    const user = userEvent.setup();
    renderPlanner({ employeeId: JONAS_ID, duties: [nightDuty(3, { assignments: [member(JONAS_ID)] })] });
    await user.click(modeRadio('Nacht'));
    expect(dateButton(4).getAttribute('aria-disabled')).toBe('true');
    expect(description(dateButton(4))).toContain('Nacht nicht möglich: nicht für diese Dienstart freigegeben');
    await user.click(dateButton(4));
    expect(stateOf(4)).toBe(FREE);
    expect(screen.getByRole('status').textContent).toBe('Fr., 4. Dezember: Nacht nicht möglich – nicht für diese Dienstart freigegeben.');
    // A stored (now ineligible) night can be replaced by a day duty or set to Frei.
    await user.click(modeRadio('Frei'));
    expect(dateButton(3).getAttribute('aria-disabled')).toBeNull();
    await user.click(dateButton(3));
    expect(changes().textContent).toContain('Frei, bisher Nachtdienst (Mitarbeitende)');
  });

  it('only offers Frei in an inactive project', async () => {
    const user = userEvent.setup();
    renderPlanner({ project: { ...hafen, status: 'INACTIVE' }, duties: [dayDuty(3, { assignments: [member(MIRA_ID)] })] });
    expect(screen.getByText('Das Projekt ist inaktiv: Sie können Tage nur auf Frei setzen.')).toBeTruthy();
    await user.click(modeRadio('Tag'));
    expect(dateButton(4).getAttribute('aria-disabled')).toBe('true');
    await user.click(modeRadio('Frei'));
    await user.click(dateButton(3));
    expect(changes().textContent).toContain('Frei, bisher Tagdienst (Mitarbeitende)');
  });

  it('shows stored Tag and Nacht on one date as "Korrektur nötig", blocks saving and offers an explicit correction', async () => {
    const user = userEvent.setup();
    const save = vi.fn<EmployeeMonthSave>().mockResolvedValue({ kind: 'rejected', issues: [] });
    const day = dayDuty(3, { assignments: [member(MIRA_ID)] });
    const night = nightDuty(3, { assignments: [member(MIRA_ID, 'SHIFT_LEAD'), member(JONAS_ID)] });
    renderPlanner({ save, duties: [day, night] });

    const fixes = screen.getByRole('region', { name: 'Korrektur nötig (1)' });
    expect(fixes.textContent).toContain('03.12.2026: Tagdienst und Nachtdienst gespeichert – pro Tag ist nur ein Dienst erlaubt.');
    expect(stateOf(3)).toBe('Tagdienst und Nachtdienst, Korrektur nötig');
    expect(dateButton(3).textContent).toContain('Tag + Nacht');
    expect(screen.getByText('Im Monat: 0 × Tag, 0 × Nacht, 30 × Frei, 1 × Tag und Nacht (Korrektur nötig)')).toBeTruthy();

    await user.click(modeRadio('Tag'));
    await user.click(dateButton(10));
    expect(saveButton().getAttribute('aria-disabled')).toBe('true');
    expect(saveNote()).toBe('Korrigieren Sie zuerst 1 Tag unter „Korrektur nötig“.');
    expect(screen.getByText(/1 ungespeicherte Änderung · 1 Tag korrigieren/)).toBeTruthy();

    await user.click(within(fixes).getByRole('button', { name: 'Do., 03.12.2026' }));
    expect(document.activeElement).toBe(dateButton(3));
    await user.click(within(dayDetails()).getByRole('button', { name: 'Nur Nachtdienst behalten' }));
    expect(screen.queryByRole('region', { name: /Korrektur nötig/ })).toBeNull();
    expect(stateOf(3)).toBe('Nachtdienst (Schichtleitung)');
    expect(changes().textContent).toContain('nur noch Nachtdienst (Schichtleitung); Tagdienst wird ausgetragen');
    await user.click(saveButton());
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].days.map((value) => [value.date, value.to])).toEqual([
      [dec(3), { kind: 'NIGHT', role: 'SHIFT_LEAD' }],
      [dec(10), { kind: 'DAY', role: 'EMPLOYEE' }],
    ]);
  });

  it('with an authoritative calendar (#90 boundary), offers only Frei on closed dates and asks to correct stored duties there', async () => {
    const user = userEvent.setup();
    const calendar: ProjectCalendar = { status: 'known', closed: new Set([dec(6), dec(13)]) };
    renderPlanner({ calendar, duties: [dayDuty(13, { assignments: [member(MIRA_ID)] })] });
    expect(screen.queryByText(/Die Ansicht sperrt keine Wochentage/)).toBeNull();
    await user.click(modeRadio('Tag'));
    expect(dateButton(6).getAttribute('aria-disabled')).toBe('true');
    expect(description(dateButton(6))).toContain('Projekt an diesem Tag nicht in Betrieb');
    expect(dateButton(5).getAttribute('aria-disabled')).toBeNull();
    expect(screen.getByRole('region', { name: 'Korrektur nötig (1)' }).textContent).toContain('13.12.2026: Das Projekt ist an diesem Tag nicht in Betrieb.');
    await user.click(modeRadio('Frei'));
    await user.click(dateButton(13));
    expect(screen.queryByRole('region', { name: /Korrektur nötig/ })).toBeNull();
  });

  it('does not block weekends while the operating days are unknown', async () => {
    const user = userEvent.setup();
    renderPlanner();
    await user.click(modeRadio('Nacht'));
    // 5 and 6 December 2026 are a Saturday and a Sunday.
    expect(dateButton(5).getAttribute('aria-disabled')).toBeNull();
    await user.click(dateButton(6));
    expect(stateOf(6)).toBe('Nachtdienst (Mitarbeitende)');
  });
});

describe('#88 employee-month planner — save port, failures and newer reads', () => {
  it('sends ONE command for the whole month and keeps every selection after a rejection, with neutral day findings', async () => {
    const user = userEvent.setup();
    const save = vi.fn<EmployeeMonthSave>().mockResolvedValue({
      kind: 'rejected',
      issues: [
        { date: dec(4), kind: 'NIGHT', reason: 'EMPLOYEE_UNAVAILABLE' },
        { date: dec(5), kind: null, reason: 'PROJECT_CLOSED_DAY' },
      ],
    });
    const stored = dayDuty(3, { version: 3, assignments: [member(JONAS_ID, 'SHIFT_LEAD')] });
    renderPlanner({ save, duties: [stored] });
    await user.click(modeRadio('Tag'));
    await user.click(dateButton(3));
    await user.click(dateButton(5));
    await user.click(modeRadio('Nacht'));
    await user.click(dateButton(4));
    await user.click(saveButton());

    expect(save).toHaveBeenCalledTimes(1);
    const none = { dutyId: null, version: null, role: null };
    expect(save.mock.calls[0][0]).toEqual({
      planId: plan().id,
      employeeId: MIRA_ID,
      month: '2026-12',
      days: [
        { date: dec(3), to: { kind: 'DAY', role: 'EMPLOYEE' }, basedOn: { DAY: { dutyId: stored.id, version: 3, role: null }, NIGHT: none } },
        { date: dec(4), to: { kind: 'NIGHT', role: 'EMPLOYEE' }, basedOn: { DAY: none, NIGHT: none } },
        { date: dec(5), to: { kind: 'DAY', role: 'EMPLOYEE' }, basedOn: { DAY: none, NIGHT: none } },
      ],
    });
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('heading', { name: 'Monat nicht gespeichert' })).toBe(document.activeElement);
    expect(alert.textContent).toContain('Es wurde nichts gespeichert; Ihre Auswahl ist erhalten.');
    expect(alert.textContent).toMatch(/04\.12\.2026, Nachtdienst: An diesem Tag nicht verfügbar\./);
    expect(alert.textContent).toMatch(/05\.12\.2026: Das Projekt ist an diesem Tag nicht in Betrieb\./);
    expect(document.body.textContent).not.toMatch(/krank|Krankheit|Urlaub/i);
    expect([stateOf(3), stateOf(4), stateOf(5)]).toEqual(['Tagdienst (Mitarbeitende)', 'Nachtdienst (Mitarbeitende)', 'Tagdienst (Mitarbeitende)']);
    expect(changeCount()).toBe('Ungespeicherte Änderungen (3)');
    expect(description(dateButton(4))).toContain('Nicht gespeichert: Nachtdienst: An diesem Tag nicht verfügbar.');

    // Correcting a reported date clears its finding; a new attempt is an explicit second command.
    await user.click(modeRadio('Frei'));
    await user.click(dateButton(5));
    expect(description(dateButton(5))).not.toContain('Nicht gespeichert');
    save.mockResolvedValueOnce({ kind: 'rejected', issues: [] });
    await user.click(saveButton());
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0].days).toHaveLength(2);
  });

  it('blocks another attempt after an unknown outcome until the current state was re-read, without attributing what it shows', async () => {
    const user = userEvent.setup();
    const save = vi.fn<EmployeeMonthSave>().mockRejectedValue(new Error('adapter failure'));
    const stored = dayDuty(3, { assignments: [] });
    const { onReload, update } = renderPlanner({ save, duties: [stored] });
    await user.click(modeRadio('Tag'));
    await user.click(dateButton(3));
    await user.click(dateButton(5));
    await user.click(saveButton());

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('heading', { name: 'Ergebnis unbekannt' })).toBeTruthy();
    expect(saveButton().getAttribute('aria-disabled')).toBe('true');
    expect(saveNote()).toBe('Prüfen Sie zuerst den aktuellen Stand.');
    await user.click(saveButton());
    expect(save).toHaveBeenCalledTimes(1);
    expect(stateOf(3)).toBe('Tagdienst (Mitarbeitende)');

    await user.click(within(alert).getByRole('button', { name: 'Aktuellen Stand prüfen' }));
    expect(onReload).toHaveBeenCalledTimes(1);
    update([{ ...stored, version: 2, assignments: [member(MIRA_ID)] }]);
    expect(screen.getByRole('status').textContent).toBe(
      'Der aktuelle Stand wurde geladen. Eine Ihrer Änderungen ist darin bereits enthalten. 1 Änderung ist noch nicht gespeichert.',
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(saveButton().getAttribute('aria-disabled')).toBeNull();
    expect(changes().textContent).toContain('05.12.2026 · neu: Tagdienst (Mitarbeitende) – Dienst noch nicht angelegt');
  });

  it('treats a malformed save outcome as unknown instead of claiming success or failure', async () => {
    const user = userEvent.setup();
    const save = vi.fn<EmployeeMonthSave>().mockResolvedValue({ kind: 'rejected' } as unknown as EmployeeMonthSaveOutcome);
    renderPlanner({ save });
    await user.click(modeRadio('Tag'));
    await user.click(dateButton(3));
    await user.click(saveButton());
    expect(within(await screen.findByRole('alert')).getByRole('heading', { name: 'Ergebnis unbekannt' })).toBeTruthy();
    expect(stateOf(3)).toBe('Tagdienst (Mitarbeitende)');
  });

  it('keeps a choice whose duty changed meanwhile and waits for an explicit decision', async () => {
    const user = userEvent.setup();
    const save = vi.fn<EmployeeMonthSave>().mockResolvedValue({ kind: 'rejected', issues: [] });
    const stored = dayDuty(3, { version: 1, assignments: [member(JONAS_ID)] });
    const { update } = renderPlanner({ save, duties: [stored] });
    await user.click(modeRadio('Tag'));
    await user.click(dateButton(3));
    update([{ ...stored, version: 2, assignments: [member(JONAS_ID), member(LEA_ID)] }]);

    expect(screen.getByRole('status').textContent).toContain('1 Änderung betrifft inzwischen geänderte Dienste');
    expect(changes().textContent).toContain('Die Besetzung des Tagdienstes wurde inzwischen geändert.');
    expect(stateOf(3)).toBe('Tagdienst (Mitarbeitende)');
    expect(saveNote()).toBe('Entscheiden Sie zuerst über die inzwischen geänderten Dienste.');
    expect(dayDetails().textContent).toContain('Tagdienst, weitere Personen (bleiben unverändert): Jonas Muster, Lea Probe');
    await user.click(within(dayDetails()).getByRole('button', { name: 'Meine Auswahl behalten' }));
    expect(saveButton().getAttribute('aria-disabled')).toBeNull();
    await user.click(saveButton());
    expect(save.mock.calls[0][0].days[0].basedOn.DAY).toEqual({ dutyId: stored.id, version: 2, role: null });
  });

  it('can take the server state for a changed date instead', async () => {
    const user = userEvent.setup();
    const stored = dayDuty(3, { version: 1 });
    const { update } = renderPlanner({ duties: [stored] });
    await user.click(modeRadio('Tag'));
    await user.click(dateButton(3));
    update([{ ...stored, version: 2, assignments: [member(MIRA_ID, 'SHIFT_LEAD')] }]);
    expect(changes().textContent).toContain('Inzwischen geändert: jetzt Tagdienst (Schichtleitung).');
    await user.click(screen.getByRole('button', { name: 'Aktuellen Stand übernehmen' }));
    expect(within(changes()).getByText('Keine ungespeicherten Änderungen.')).toBeTruthy();
    expect(stateOf(3)).toBe('Tagdienst (Schichtleitung)');
  });

  it('never shows both shifts after a newer read: a TAG choice stays single when another admin plans a night on that date', async () => {
    const user = userEvent.setup();
    const { update } = renderPlanner();
    await user.click(modeRadio('Tag'));
    await user.click(dateButton(3));
    update([nightDuty(3, { assignments: [member(MIRA_ID)] })]);
    expect(stateOf(3)).toBe('Tagdienst (Mitarbeitende)');
    expect(changes().textContent).toContain('Tagdienst (Mitarbeitende) statt Nachtdienst (Mitarbeitende)');
    expect(changes().textContent).toContain('Inzwischen geändert: jetzt Nachtdienst (Mitarbeitende).');
    expect(screen.queryByRole('region', { name: /Korrektur nötig/ })).toBeNull();
    // A date another admin made dual is shown for correction, not hidden.
    update([nightDuty(3, { assignments: [member(MIRA_ID)] }), dayDuty(9, { assignments: [member(MIRA_ID)] }), nightDuty(9, { assignments: [member(MIRA_ID)] })]);
    expect(screen.getByRole('region', { name: 'Korrektur nötig (1)' }).textContent).toContain('09.12.2026');
    expect(stateOf(3)).toBe('Tagdienst (Mitarbeitende)');
  });

  it('locks the draft while a save runs, reports it to the page and re-reads after a confirmed save', async () => {
    const user = userEvent.setup();
    const answer = deferred<EmployeeMonthSaveOutcome>();
    const save = vi.fn<EmployeeMonthSave>().mockReturnValue(answer.promise);
    const stored = dayDuty(3, { assignments: [] });
    const { onReload, onEditStateChange, update } = renderPlanner({ save, duties: [stored] });
    await user.click(modeRadio('Tag'));
    await user.click(dateButton(3));
    await user.click(saveButton());
    expect(saveButton().textContent).toBe('Monat wird gespeichert …');
    expect(onEditStateChange).toHaveBeenLastCalledWith('saving');
    await user.click(dateButton(4));
    expect(stateOf(4)).toBe(FREE);

    answer.resolve({ kind: 'saved' });
    expect(await screen.findByText('Gespeichert. Der aktuelle Stand wird geladen …')).toBeTruthy();
    expect(onReload).toHaveBeenCalledTimes(1);
    update([{ ...stored, version: 2, assignments: [member(MIRA_ID)] }]);
    expect(screen.getByRole('status').textContent).toBe('Der Monat wurde gespeichert. Der aktuelle Stand ist geladen.');
    expect(within(changes()).getByText('Keine ungespeicherten Änderungen.')).toBeTruthy();
    expect(onEditStateChange).toHaveBeenLastCalledWith('clean');
  });

  it('discards all changes only after a confirmation', async () => {
    const user = userEvent.setup();
    renderPlanner();
    await user.click(modeRadio('Tag'));
    await user.click(dateButton(3));
    await user.click(dateButton(5));
    await user.click(screen.getByRole('button', { name: 'Alle Änderungen verwerfen' }));
    const confirm = screen.getByRole('group', { name: 'Alle Änderungen verwerfen' });
    expect(confirm.textContent).toContain('2 ungespeicherte Änderungen verwerfen?');
    await user.click(within(confirm).getByRole('button', { name: 'Abbrechen' }));
    expect(stateOf(3)).toBe('Tagdienst (Mitarbeitende)');
    await user.click(screen.getByRole('button', { name: 'Alle Änderungen verwerfen' }));
    await user.click(screen.getByRole('button', { name: 'Ja, alle verwerfen' }));
    expect(stateOf(3)).toBe(FREE);
    expect(screen.getByRole('status').textContent).toBe('Alle ungespeicherten Änderungen wurden verworfen.');
  });

  it('says that saved changes of a published plan apply at once (CR-03)', () => {
    renderPlanner({ plan: plan({ status: 'PUBLISHED', publishedAt: '2026-11-30T10:00:00Z' }) });
    expect(screen.getByText('Der Plan ist veröffentlicht: Gespeicherte Änderungen gelten sofort, ohne erneutes Veröffentlichen.')).toBeTruthy();
  });
});
