import { describe, expect, it } from 'vitest';
import {
  describeChanges,
  draftOf,
  dutyChanges,
  hasChanges,
  matchesDraft,
  rosterView,
} from './duty-editor-model';
import {
  HAFEN_ID,
  JONAS_ID,
  LEA_ID,
  MIRA_ID,
  OSKAR_ID,
  PAUL_ID,
  duty,
  member,
  monthAssignments,
  staff,
} from './monthly-planning.test-support';

const UNKNOWN = 'f9999999-9999-4999-8999-999999999999';
const names: Record<string, string> = { [MIRA_ID]: 'Mira Beispiel', [JONAS_ID]: 'Jonas Muster', [LEA_ID]: 'Lea Probe' };
const nameOf = (id: string) => names[id] ?? 'Unbekannte Person';
const assignments = monthAssignments(HAFEN_ID, '2026-12-01', [MIRA_ID, JONAS_ID, LEA_ID, OSKAR_ID]);

function base() {
  return duty({
    dutyDate: '2026-12-03', startsAt: '2026-12-03T05:00:00Z', endsAt: '2026-12-03T17:00:00Z', version: 4,
    assignments: [member(MIRA_ID, 'SHIFT_LEAD'), member(JONAS_ID)],
  });
}

describe('SP-12 editor model — PATCH body', () => {
  it('an unchanged draft sends nothing (no EMPTY_PATCH request is possible)', () => {
    const stored = base();
    expect(dutyChanges(stored, draftOf(stored))).toEqual({});
    expect(hasChanges({})).toBe(false);
  });

  it('only changed dimensions; the roster is complete, existing members first, ids case-insensitive', () => {
    const stored = base();
    const draft = draftOf(stored);
    const roster = { ...draft.roster };
    delete roster[JONAS_ID.toLowerCase()];
    roster[LEA_ID.toLowerCase()] = { employeeId: LEA_ID, dutyRole: 'EMPLOYEE' };
    roster[MIRA_ID.toLowerCase()] = { employeeId: MIRA_ID, dutyRole: 'EMPLOYEE' };
    expect(dutyChanges(stored, { ...draft, roster })).toEqual({
      assignments: [{ employeeId: MIRA_ID, dutyRole: 'EMPLOYEE' }, { employeeId: LEA_ID, dutyRole: 'EMPLOYEE' }],
    });
    expect(dutyChanges(stored, { ...draft, dutyDate: '2026-12-31' })).toEqual({ dutyDate: '2026-12-31' });
    expect(dutyChanges(stored, { ...draft, shiftKind: 'NIGHT' })).toEqual({ shiftKind: 'NIGHT' });
    // Removing everyone is a real change (no staffing minimum).
    expect(dutyChanges(stored, { ...draft, roster: {} })).toEqual({ assignments: [] });
  });

  it('matchesDraft decides a lost-response check by date, kind and exact roster with roles', () => {
    const stored = base();
    const draft = draftOf(stored);
    expect(matchesDraft(stored, draft)).toBe(true);
    expect(matchesDraft({ ...stored, shiftKind: 'NIGHT' }, draft)).toBe(false);
    expect(matchesDraft({ ...stored, assignments: [stored.assignments[0]] }, draft)).toBe(false);
    expect(matchesDraft({ ...stored, assignments: [{ ...stored.assignments[0], dutyRole: 'EMPLOYEE' }, stored.assignments[1]] }, draft)).toBe(false);
  });

  it('describes every unsaved change in German', () => {
    const stored = base();
    const draft = draftOf(stored);
    const roster = { ...draft.roster };
    delete roster[JONAS_ID.toLowerCase()];
    roster[LEA_ID.toLowerCase()] = { employeeId: LEA_ID, dutyRole: 'SHIFT_LEAD' };
    roster[MIRA_ID.toLowerCase()] = { employeeId: MIRA_ID, dutyRole: 'EMPLOYEE' };
    expect(describeChanges(stored, { dutyDate: '2026-12-04', shiftKind: 'NIGHT', roster }, nameOf)).toEqual([
      'Datum: Do., 03.12.2026 → Fr., 04.12.2026',
      'Dienstart: Tagdienst → Nachtdienst',
      'Funktion: Mira Beispiel → Mitarbeitende',
      'Eingeplant: Lea Probe (Schichtleitung)',
      'Ausgetragen: Jonas Muster',
    ]);
  });
});

describe('SP-12 editor model — roster options', () => {
  it('focused person first; members and eligible persons listed; excluded assigned persons separately', () => {
    const stored = base();
    const view = rosterView(stored, draftOf(stored), staff, assignments, HAFEN_ID, '2026-12-01', LEA_ID);
    expect(view.options.map((option) => [option.name, option.selected, option.selectable, option.focus])).toEqual([
      ['Lea Probe', false, true, true],
      ['Mira Beispiel', true, true, false],
      ['Jonas Muster', true, true, false],
    ]);
    expect(view.excluded.map((item) => [item.name, item.reason])).toEqual([['Oskar Test', 'INACTIVE']]);
  });

  it('a kind change flags a retained member by rule; restoring a stored member stays possible', () => {
    const stored = base();
    const draft = { ...draftOf(stored), shiftKind: 'NIGHT' as const };
    const jonas = rosterView(stored, draft, staff, assignments, HAFEN_ID, '2026-12-01', null)
      .options.find((option) => option.employeeId === JONAS_ID)!;
    expect(jonas).toMatchObject({ selected: true, stored: true, reason: 'NOT_ELIGIBLE_FOR_SHIFT', selectable: true });
  });

  it('a focused person outside the project month is shown with the reason, not selectable', () => {
    const stored = base();
    const paul = rosterView(stored, draftOf(stored), staff, assignments, HAFEN_ID, '2026-12-01', PAUL_ID).options[0];
    expect(paul).toMatchObject({ name: 'Paul Anders', reason: 'NOT_ASSIGNED', selectable: false, focus: true });
  });

  it('unknown members stay listed (so they can be removed); unavailability only while the date is unchanged', () => {
    const lead = member(MIRA_ID, 'SHIFT_LEAD');
    const stored = duty({
      dutyDate: '2026-12-03', startsAt: '2026-12-03T05:00:00Z', endsAt: '2026-12-03T17:00:00Z',
      assignments: [lead, member(UNKNOWN)],
      availabilityConflicts: [{ code: 'EMPLOYEE_UNAVAILABLE', assignmentId: lead.id, employeeId: MIRA_ID }],
    });
    const same = rosterView(stored, draftOf(stored), staff, assignments, HAFEN_ID, '2026-12-01', null);
    expect(same.options.map((option) => [option.name, option.reason, option.unavailable])).toEqual([
      ['Mira Beispiel', null, true],
      ['Jonas Muster', null, false],
      ['Lea Probe', null, false],
      ['Unbekannte Person', 'UNKNOWN', false],
    ]);
    const moved = rosterView(stored, { ...draftOf(stored), dutyDate: '2026-12-04' }, staff, assignments, HAFEN_ID, '2026-12-01', null);
    expect(moved.options.find((option) => option.employeeId === MIRA_ID)?.unavailable).toBe(false);
  });
});
