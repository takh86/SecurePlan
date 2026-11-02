// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { deferred } from '../../employees/employees.test-support';
import { fullName } from '../../employees/employee-types';
import type { Project } from '../../projects/project-types';
import { EmployeeMonthPlanner } from './EmployeeMonthPlanner';
import type { EmployeeMonthSave, EmployeeMonthSaveOutcome } from './employee-month-draft';
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

const DEC_3 = { dutyDate: '2026-12-03', startsAt: '2026-12-03T05:00:00Z', endsAt: '2026-12-03T17:00:00Z' };
const DEC_3_NIGHT = { dutyDate: '2026-12-03', shiftKind: 'NIGHT' as const, startsAt: '2026-12-03T17:00:00Z', endsAt: '2026-12-04T05:00:00Z' };
const NAMES = new Map(staff.map((employee) => [employee.id.toLowerCase(), fullName(employee)]));
const nameOf = (id: string) => NAMES.get(id.toLowerCase()) ?? 'Unbekannte Person';

type Options = {
  duties?: Duty[];
  employeeId?: string;
  save?: EmployeeMonthSave;
  plan?: MonthlyPlan;
  project?: Project;
  month?: string;
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
        onReload={onReload}
        reloading={false}
        onEditStateChange={onEditStateChange}
      />
    );
  };
  const view = render(element(options.duties ?? []));
  return { ...view, onReload, onEditStateChange, update: (duties: Duty[]) => view.rerender(element(duties)) };
}

function slot(name: string) {
  return within(screen.getByRole('grid')).getByRole('button', { name });
}

function description(button: HTMLElement) {
  return document.getElementById(button.getAttribute('aria-describedby')!)!.textContent;
}

function changes() {
  return screen.getByRole('region', { name: /Ungespeicherte Änderungen/ });
}

function saveButton() {
  return screen.getByRole('button', { name: /^Monat (speichern|wird gespeichert)/ });
}

const D3 = 'Tagdienst am Do., 3. Dezember';
const N3 = 'Nachtdienst am Do., 3. Dezember';
const D5 = 'Tagdienst am Sa., 5. Dezember';

describe('#88 employee-month planner (preview component)', () => {
  it('is a labelled preview: Monat speichern is unavailable, explains why and writes nothing', async () => {
    const user = userEvent.setup();
    renderPlanner();
    expect(screen.getByText(/Monat einer Person planen – noch ohne Speichern/)).toBeTruthy();
    await user.click(slot(D3));
    const save = saveButton();
    expect(save.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(save.getAttribute('aria-describedby')!)!.textContent)
      .toBe('Vorschau: Das Speichern eines ganzen Monats ist noch nicht freigegeben. Es wird nichts gespeichert.');
    await user.click(save);
    expect(slot(D3).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows every day of the month with existing duties and distinguishes unchanged, new, removed and cleared selections', async () => {
    const user = userEvent.setup();
    const { onEditStateChange } = renderPlanner({
      duties: [duty({ ...DEC_3, assignments: [member(MIRA_ID, 'SHIFT_LEAD'), member(JONAS_ID)] })],
    });
    const grid = screen.getByRole('grid', { name: 'Dienste von Mira Beispiel im Dezember 2026' });
    expect(within(grid).getAllByRole('rowheader')).toHaveLength(31);
    expect(slot(D3).getAttribute('aria-pressed')).toBe('true');
    expect(slot(D3).textContent).toContain('SL');
    expect(description(slot(D3))).toBe('eingeplant als Schichtleitung');
    expect(description(slot(N3))).toBe('nicht eingeplant; Dienst noch nicht angelegt');
    expect(within(changes()).getByText('Keine ungespeicherten Änderungen.')).toBeTruthy();

    await user.click(slot(N3));
    expect(slot(N3).getAttribute('aria-pressed')).toBe('true');
    expect(description(slot(N3))).toBe('neu eingeplant als Mitarbeitende, noch nicht gespeichert; Dienst noch nicht angelegt');
    await user.click(slot(D3));
    expect(slot(D3).getAttribute('aria-pressed')).toBe('false');
    expect(description(slot(D3))).toBe('wird ausgetragen, bisher Schichtleitung, noch nicht gespeichert');
    expect(changes().querySelector('h4')!.textContent).toBe('Ungespeicherte Änderungen (2)');
    expect(changes().textContent).toContain('Tagdienst: ausgetragen (bisher Schichtleitung)');
    expect(changes().textContent).toContain('Nachtdienst: neu eingeplant als Mitarbeitende (Dienst noch nicht angelegt)');
    expect(onEditStateChange).toHaveBeenLastCalledWith('dirty');

    // Clearing a new selection and selecting a removed one again both return to "no change".
    await user.click(slot(N3));
    await user.click(slot(D3));
    expect(slot(D3).textContent).toContain('SL');
    expect(within(changes()).getByText('Keine ungespeicherten Änderungen.')).toBeTruthy();
    expect(onEditStateChange).toHaveBeenLastCalledWith('clean');
  });

  it('allows DAY and NIGHT on the same date and changes the role in the day details, listing the other members as unchanged', async () => {
    const user = userEvent.setup();
    renderPlanner({ duties: [duty({ ...DEC_3, assignments: [member(MIRA_ID), member(JONAS_ID, 'SHIFT_LEAD')] }), duty({ ...DEC_3_NIGHT, assignments: [member(LEA_ID)] })] });
    await user.click(slot(N3));
    expect(slot(D3).getAttribute('aria-pressed')).toBe('true');
    expect(slot(N3).getAttribute('aria-pressed')).toBe('true');
    const day = screen.getByRole('region', { name: 'Ausgewählter Tag: Do., 3. Dezember' });
    expect(day.textContent).toContain('Weitere Personen (bleiben unverändert): Jonas Muster (Schichtleitung)');
    expect(day.textContent).toContain('Weitere Personen (bleiben unverändert): Lea Probe');
    await user.click(within(within(day).getByRole('group', { name: 'Funktion im Tagdienst' })).getByRole('radio', { name: 'Schichtleitung' }));
    expect(changes().textContent).toContain('Tagdienst: Funktion geändert von Mitarbeitende zu Schichtleitung');
    expect(slot(D3).textContent).toContain('SL');
  });

  it('offers one tab stop and moves with arrows, Page Up/Down, Home/End and Ctrl+Home/End; Space toggles', async () => {
    const user = userEvent.setup();
    renderPlanner();
    const grid = screen.getByRole('grid');
    const stops = within(grid).getAllByRole('button').filter((button) => button.tabIndex === 0);
    expect(stops.map((button) => button.getAttribute('aria-label'))).toEqual(['Tagdienst am Di., 1. Dezember']);
    stops[0].focus();
    const focused = () => document.activeElement!.getAttribute('aria-label');
    await user.keyboard('{ArrowDown}');
    expect(focused()).toBe('Tagdienst am Mi., 2. Dezember');
    await user.keyboard('{ArrowRight}');
    expect(focused()).toBe('Nachtdienst am Mi., 2. Dezember');
    await user.keyboard('{PageDown}');
    expect(focused()).toBe('Nachtdienst am Mi., 9. Dezember');
    await user.keyboard('{Home}');
    expect(focused()).toBe('Tagdienst am Mi., 9. Dezember');
    await user.keyboard('{PageUp}{PageUp}');
    expect(focused()).toBe('Tagdienst am Di., 1. Dezember');
    await user.keyboard('{Control>}{End}{/Control}');
    expect(focused()).toBe('Nachtdienst am Do., 31. Dezember');
    expect(screen.getByRole('region', { name: 'Ausgewählter Tag: Do., 31. Dezember' })).toBeTruthy();
    await user.keyboard(' ');
    expect(slot('Nachtdienst am Do., 31. Dezember').getAttribute('aria-pressed')).toBe('true');
    await user.keyboard('{Control>}{Home}{/Control}');
    expect(focused()).toBe('Tagdienst am Di., 1. Dezember');
    expect(within(grid).getAllByRole('button').filter((button) => button.tabIndex === 0)).toHaveLength(1);
    // "Zum Tag" in the change list returns focus to the grid cell.
    await user.click(within(changes()).getByRole('button', { name: 'Do., 31.12.2026' }));
    expect(focused()).toBe('Nachtdienst am Do., 31. Dezember');
  });

  it('follows the calendar at month boundaries (29 days in February 2028)', () => {
    renderPlanner({ month: '2028-02' });
    const grid = screen.getByRole('grid', { name: 'Dienste von Mira Beispiel im Februar 2028' });
    expect(within(grid).getAllByRole('rowheader')).toHaveLength(29);
    expect(slot('Nachtdienst am Di., 29. Februar')).toBeTruthy();
    expect(within(grid).queryByRole('button', { name: /1\. März/ })).toBeNull();
  });

  it('does not offer what the static rules exclude, but always allows taking someone off', async () => {
    const user = userEvent.setup();
    renderPlanner({ employeeId: JONAS_ID, duties: [duty({ ...DEC_3_NIGHT, assignments: [member(JONAS_ID)] })] });
    const night = slot('Nachtdienst am Fr., 4. Dezember');
    expect(night.getAttribute('aria-disabled')).toBe('true');
    expect(description(night)).toContain('Einplanen nicht möglich: nicht für diese Dienstart freigegeben');
    await user.click(night);
    expect(night.getAttribute('aria-pressed')).toBe('false');
    // An existing (now ineligible) night membership can still be removed.
    expect(slot(N3).getAttribute('aria-disabled')).toBeNull();
    await user.click(slot(N3));
    expect(changes().textContent).toContain('Nachtdienst: ausgetragen (bisher Mitarbeitende)');
  });

  it('only allows taking someone off in an inactive project', async () => {
    const user = userEvent.setup();
    renderPlanner({ project: { ...hafen, status: 'INACTIVE' }, duties: [duty({ ...DEC_3, assignments: [member(MIRA_ID)] })] });
    expect(screen.getByText('Das Projekt ist inaktiv: Sie können die Person nur austragen.')).toBeTruthy();
    expect(slot(N3).getAttribute('aria-disabled')).toBe('true');
    await user.click(slot(D3));
    expect(changes().textContent).toContain('Tagdienst: ausgetragen');
  });

  it('sends ONE command for the whole month and keeps every selection after a rejection, with neutral day findings', async () => {
    const user = userEvent.setup();
    const save = vi.fn<EmployeeMonthSave>().mockResolvedValue({
      kind: 'rejected',
      issues: [{ date: '2026-12-03', kind: 'NIGHT', reason: 'EMPLOYEE_UNAVAILABLE' }],
    });
    const stored = duty({ ...DEC_3, version: 3, assignments: [member(JONAS_ID, 'SHIFT_LEAD')] });
    renderPlanner({ save, duties: [stored] });
    await user.click(slot(D3));
    await user.click(slot(N3));
    await user.click(slot(D5));
    await user.click(saveButton());

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toEqual({
      planId: plan().id,
      employeeId: MIRA_ID,
      month: '2026-12',
      changes: [
        { date: '2026-12-03', kind: 'DAY', dutyId: stored.id, basedOnVersion: 3, from: null, to: 'EMPLOYEE' },
        { date: '2026-12-03', kind: 'NIGHT', dutyId: null, basedOnVersion: null, from: null, to: 'EMPLOYEE' },
        { date: '2026-12-05', kind: 'DAY', dutyId: null, basedOnVersion: null, from: null, to: 'EMPLOYEE' },
      ],
    });
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('heading', { name: 'Monat nicht gespeichert' })).toBe(document.activeElement);
    expect(alert.textContent).toContain('Es wurde nichts gespeichert; Ihre Auswahl ist erhalten.');
    expect(alert.textContent).toMatch(/03\.12\.2026, Nachtdienst: An diesem Tag nicht verfügbar\./);
    expect(document.body.textContent).not.toMatch(/krank|Krankheit|Urlaub/i);
    for (const name of [D3, N3, D5]) expect(slot(name).getAttribute('aria-pressed')).toBe('true');
    expect(changes().querySelector('h4')!.textContent).toBe('Ungespeicherte Änderungen (3)');
    expect(description(slot(N3))).toContain('Nicht gespeichert: An diesem Tag nicht verfügbar.');

    // Correcting the reported slot clears its finding; a new attempt is an explicit second command.
    await user.click(slot(N3));
    expect(description(slot(N3))).not.toContain('Nicht gespeichert');
    save.mockResolvedValueOnce({ kind: 'rejected', issues: [] });
    await user.click(saveButton());
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0].changes).toHaveLength(2);
  });

  it('blocks another attempt after an unknown outcome until the current state was re-read, without attributing what it shows', async () => {
    const user = userEvent.setup();
    const save = vi.fn<EmployeeMonthSave>().mockRejectedValue(new Error('adapter failure'));
    const stored = duty({ ...DEC_3, assignments: [] });
    const { onReload, update } = renderPlanner({ save, duties: [stored] });
    await user.click(slot(D3));
    await user.click(slot(D5));
    await user.click(saveButton());

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('heading', { name: 'Ergebnis unbekannt' })).toBeTruthy();
    expect(saveButton().getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(saveButton().getAttribute('aria-describedby')!)!.textContent).toBe('Prüfen Sie zuerst den aktuellen Stand.');
    await user.click(saveButton());
    expect(save).toHaveBeenCalledTimes(1);
    expect(slot(D3).getAttribute('aria-pressed')).toBe('true');

    await user.click(within(alert).getByRole('button', { name: 'Aktuellen Stand prüfen' }));
    expect(onReload).toHaveBeenCalledTimes(1);
    update([{ ...stored, version: 2, assignments: [member(MIRA_ID)] }]);
    expect(screen.getByRole('status').textContent).toBe(
      'Der aktuelle Stand wurde geladen. Eine Ihrer Änderungen ist darin bereits enthalten. 1 Änderung ist noch nicht gespeichert.',
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(saveButton().getAttribute('aria-disabled')).toBeNull();
    expect(changes().textContent).toContain('Tagdienst: neu eingeplant als Mitarbeitende (Dienst noch nicht angelegt)');
  });

  it('treats a malformed save outcome as unknown instead of claiming success or failure', async () => {
    const user = userEvent.setup();
    const save = vi.fn<EmployeeMonthSave>().mockResolvedValue({ kind: 'rejected' } as unknown as EmployeeMonthSaveOutcome);
    renderPlanner({ save });
    await user.click(slot(D3));
    await user.click(saveButton());
    expect(within(await screen.findByRole('alert')).getByRole('heading', { name: 'Ergebnis unbekannt' })).toBeTruthy();
    expect(slot(D3).getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps a choice whose duty changed meanwhile and waits for an explicit decision', async () => {
    const user = userEvent.setup();
    const save = vi.fn<EmployeeMonthSave>().mockResolvedValue({ kind: 'rejected', issues: [] });
    const stored = duty({ ...DEC_3, version: 1, assignments: [member(JONAS_ID)] });
    const { update } = renderPlanner({ save, duties: [stored] });
    await user.click(slot(D3));
    update([{ ...stored, version: 2, assignments: [member(JONAS_ID), member(LEA_ID)] }]);

    expect(screen.getByRole('status').textContent).toContain('1 Änderung betrifft inzwischen geänderte Dienste');
    expect(changes().textContent).toContain('Die Besetzung dieses Dienstes wurde inzwischen geändert.');
    expect(slot(D3).getAttribute('aria-pressed')).toBe('true');
    expect(document.getElementById(saveButton().getAttribute('aria-describedby')!)!.textContent)
      .toBe('Entscheiden Sie zuerst über die inzwischen geänderten Dienste.');
    const day = screen.getByRole('region', { name: 'Ausgewählter Tag: Do., 3. Dezember' });
    expect(day.textContent).toContain('Weitere Personen (bleiben unverändert): Jonas Muster, Lea Probe');
    await user.click(within(day).getByRole('button', { name: 'Meine Auswahl behalten' }));
    expect(saveButton().getAttribute('aria-disabled')).toBeNull();
    await user.click(saveButton());
    expect(save.mock.calls[0][0].changes).toEqual([expect.objectContaining({ dutyId: stored.id, basedOnVersion: 2 })]);
  });

  it('can take the server state for a changed duty instead', async () => {
    const user = userEvent.setup();
    const stored = duty({ ...DEC_3, version: 1 });
    const { update } = renderPlanner({ duties: [stored] });
    await user.click(slot(D3));
    update([{ ...stored, version: 2, assignments: [member(MIRA_ID, 'SHIFT_LEAD')] }]);
    expect(changes().textContent).toContain('Inzwischen geändert: jetzt eingeplant als Schichtleitung.');
    await user.click(screen.getByRole('button', { name: 'Aktuellen Stand übernehmen' }));
    expect(within(changes()).getByText('Keine ungespeicherten Änderungen.')).toBeTruthy();
    expect(slot(D3).textContent).toContain('SL');
  });

  it('locks the draft while a save runs, reports it to the page and re-reads after a confirmed save', async () => {
    const user = userEvent.setup();
    const answer = deferred<EmployeeMonthSaveOutcome>();
    const save = vi.fn<EmployeeMonthSave>().mockReturnValue(answer.promise);
    const stored = duty({ ...DEC_3, assignments: [] });
    const { onReload, onEditStateChange, update } = renderPlanner({ save, duties: [stored] });
    await user.click(slot(D3));
    await user.click(saveButton());
    expect(saveButton().textContent).toBe('Monat wird gespeichert …');
    expect(onEditStateChange).toHaveBeenLastCalledWith('saving');
    await user.click(slot(N3));
    expect(slot(N3).getAttribute('aria-pressed')).toBe('false');

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
    await user.click(slot(D3));
    await user.click(slot(D5));
    await user.click(screen.getByRole('button', { name: 'Alle Änderungen verwerfen' }));
    const confirm = screen.getByRole('group', { name: 'Alle Änderungen verwerfen' });
    expect(confirm.textContent).toContain('2 ungespeicherte Änderungen verwerfen?');
    await user.click(within(confirm).getByRole('button', { name: 'Abbrechen' }));
    expect(slot(D3).getAttribute('aria-pressed')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Alle Änderungen verwerfen' }));
    await user.click(screen.getByRole('button', { name: 'Ja, alle verwerfen' }));
    expect(slot(D3).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('status').textContent).toBe('Alle ungespeicherten Änderungen wurden verworfen.');
  });

  it('says that saved changes of a published plan apply at once (CR-03)', () => {
    renderPlanner({ plan: plan({ status: 'PUBLISHED', publishedAt: '2026-11-30T10:00:00Z' }) });
    expect(screen.getByText('Der Plan ist veröffentlicht: Gespeicherte Änderungen gelten sofort, ohne erneutes Veröffentlichen.')).toBeTruthy();
  });
});
