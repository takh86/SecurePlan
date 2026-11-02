import { describe, expect, it } from 'vitest';
import type { Duty } from './monthly-plan-types';
import {
  changeRestriction,
  changeText,
  desired,
  emptyDraft,
  issuesAfterEdit,
  keepChoice,
  monthBase,
  monthCommand,
  pendingChanges,
  rebase,
  revertSlot,
  setChoice,
  slotKey,
  slotOf,
  slotStateText,
  toggledChoice,
  type EmployeeMonthDraft,
  type PlannerContext,
} from './employee-month-draft';
import { JONAS_ID, LEA_ID, MIRA_ID, OSKAR_ID, duty, member, staff } from './monthly-planning.test-support';

const DEC_3 = { dutyDate: '2026-12-03', startsAt: '2026-12-03T05:00:00Z', endsAt: '2026-12-03T17:00:00Z' };
const DEC_3_NIGHT = { dutyDate: '2026-12-03', shiftKind: 'NIGHT' as const, startsAt: '2026-12-03T17:00:00Z', endsAt: '2026-12-04T05:00:00Z' };
const DEC_31_NIGHT = { dutyDate: '2026-12-31', shiftKind: 'NIGHT' as const, startsAt: '2026-12-31T17:00:00Z', endsAt: '2027-01-01T05:00:00Z' };

const D3 = slotKey('2026-12-03', 'DAY');
const N3 = slotKey('2026-12-03', 'NIGHT');

function person(id: string) {
  return staff.find((employee) => employee.id === id)!;
}

const ACTIVE: PlannerContext = { employee: person(MIRA_ID), assigned: true, projectActive: true, newDuties: true };

function draftFor(duties: Duty[], employeeId = MIRA_ID, month = '2026-12'): EmployeeMonthDraft {
  return emptyDraft(monthBase(duties, employeeId, month));
}

describe('#88 employee-month draft — month base', () => {
  it('has a DAY and a NIGHT slot for every calendar day, including the night of the last day', () => {
    const base = monthBase([duty(DEC_31_NIGHT)], MIRA_ID, '2026-12');
    expect(base.days).toHaveLength(31);
    expect(base.days[0]).toBe('2026-12-01');
    expect(base.days.at(-1)).toBe('2026-12-31');
    expect(base.slots.size).toBe(62);
    expect(base.slots.get(slotKey('2026-12-31', 'NIGHT'))!.dutyId).not.toBeNull();
  });

  it('follows the calendar at month boundaries (leap February, 30-day month) and ignores duties of other months', () => {
    expect(monthBase([], MIRA_ID, '2028-02').days).toHaveLength(29);
    expect(monthBase([], MIRA_ID, '2027-02').days).toHaveLength(28);
    expect(monthBase([], MIRA_ID, '2026-11').days.at(-1)).toBe('2026-11-30');
    const outside = duty({ dutyDate: '2027-01-01', startsAt: '2027-01-01T05:00:00Z', endsAt: '2027-01-01T17:00:00Z', assignments: [member(MIRA_ID)] });
    const base = monthBase([outside], MIRA_ID, '2026-12');
    expect([...base.slots.values()].every((slot) => slot.dutyId === null)).toBe(true);
  });

  it('reads the employee role, the neutral hint and every other member, case-insensitively', () => {
    const own = member(MIRA_ID, 'SHIFT_LEAD');
    const stored = duty({
      ...DEC_3,
      version: 7,
      assignments: [{ ...own, employeeId: MIRA_ID.toUpperCase() }, member(JONAS_ID, 'SHIFT_LEAD'), member(LEA_ID)],
      availabilityConflicts: [{ code: 'EMPLOYEE_UNAVAILABLE', assignmentId: own.id, employeeId: MIRA_ID }],
    });
    const slot = monthBase([stored], MIRA_ID, '2026-12').slots.get(D3)!;
    expect(slot).toMatchObject({ dutyId: stored.id, version: 7, role: 'SHIFT_LEAD', unavailable: true });
    expect(slot.others).toEqual([{ employeeId: JONAS_ID, dutyRole: 'SHIFT_LEAD' }, { employeeId: LEA_ID, dutyRole: 'EMPLOYEE' }]);
    expect(monthBase([stored], LEA_ID, '2026-12').slots.get(D3)!).toMatchObject({ role: 'EMPLOYEE', unavailable: false });
  });
});

describe('#88 employee-month draft — choosing and clearing', () => {
  it('toggles a free slot to Mitarbeitende and back to no change', () => {
    let draft = draftFor([]);
    expect(toggledChoice(draft, D3)).toBe('EMPLOYEE');
    draft = setChoice(draft, D3, toggledChoice(draft, D3));
    expect(desired(draft, D3)).toBe('EMPLOYEE');
    expect(pendingChanges(draft).map((change) => change.status)).toEqual(['added']);
    draft = setChoice(draft, D3, toggledChoice(draft, D3));
    expect(desired(draft, D3)).toBeNull();
    expect(draft.choices.size).toBe(0);
  });

  it('removes an existing membership and restores its original role when toggled again', () => {
    let draft = draftFor([duty({ ...DEC_3, assignments: [member(MIRA_ID, 'SHIFT_LEAD')] })]);
    draft = setChoice(draft, D3, toggledChoice(draft, D3));
    expect(pendingChanges(draft)).toMatchObject([{ status: 'removed', after: null }]);
    expect(toggledChoice(draft, D3)).toBe('SHIFT_LEAD');
    draft = setChoice(draft, D3, toggledChoice(draft, D3));
    expect(draft.choices.size).toBe(0);
  });

  it('records a role change of an existing membership', () => {
    const draft = setChoice(draftFor([duty({ ...DEC_3, assignments: [member(MIRA_ID)] })]), D3, 'SHIFT_LEAD');
    const [change] = pendingChanges(draft);
    expect(change.status).toBe('role-changed');
    expect(changeText(change)).toBe('Tagdienst: Funktion geändert von Mitarbeitende zu Schichtleitung');
    expect(slotStateText(change.slot, change.after)).toBe('Funktion geändert zu Schichtleitung, bisher Mitarbeitende, noch nicht gespeichert');
  });

  it('keeps DAY and NIGHT of one date independent and lists changes in calendar order, DAY first', () => {
    let draft = draftFor([]);
    draft = setChoice(draft, slotKey('2026-12-05', 'NIGHT'), 'EMPLOYEE');
    draft = setChoice(draft, N3, 'SHIFT_LEAD');
    draft = setChoice(draft, D3, 'EMPLOYEE');
    expect(pendingChanges(draft).map((change) => change.key)).toEqual([D3, N3, slotKey('2026-12-05', 'NIGHT')]);
    expect(changeText(pendingChanges(draft)[1])).toBe('Nachtdienst: neu eingeplant als Schichtleitung (Dienst noch nicht angelegt)');
  });

  it('describes slots without implying an absence', () => {
    const base = monthBase([], MIRA_ID, '2026-12');
    expect(slotStateText(base.slots.get(D3)!, null)).toBe('nicht eingeplant; Dienst noch nicht angelegt');
    expect(slotStateText(base.slots.get(D3)!, null)).not.toMatch(/krank|Urlaub|abwesend|frei/i);
  });

  it('reverting a slot drops the choice and any open conflict', () => {
    const draft = setChoice(draftFor([]), D3, 'EMPLOYEE');
    expect(revertSlot(draft, D3).choices.size).toBe(0);
  });
});

describe('#88 employee-month draft — the command never touches other members', () => {
  it('lists only the selected employee slots with the duty and version they were based on', () => {
    const shared = duty({ ...DEC_3, version: 4, assignments: [member(JONAS_ID, 'SHIFT_LEAD'), member(LEA_ID)] });
    const night = duty({ ...DEC_3_NIGHT, version: 2, assignments: [member(MIRA_ID), member(JONAS_ID)] });
    let draft = draftFor([shared, night]);
    draft = setChoice(draft, D3, 'EMPLOYEE');
    draft = setChoice(draft, N3, null);
    const command = monthCommand(draft, 'plan-1')!;
    expect(command).toEqual({
      planId: 'plan-1',
      employeeId: MIRA_ID,
      month: '2026-12',
      changes: [
        { date: '2026-12-03', kind: 'DAY', dutyId: shared.id, basedOnVersion: 4, from: null, to: 'EMPLOYEE' },
        { date: '2026-12-03', kind: 'NIGHT', dutyId: night.id, basedOnVersion: 2, from: 'EMPLOYEE', to: null },
      ],
    });
    expect(JSON.stringify(command)).not.toContain(JONAS_ID);
    expect(JSON.stringify(command)).not.toContain(LEA_ID);
  });

  it('has nothing to save without changes or while a conflict is undecided', () => {
    const stored = duty({ ...DEC_3, assignments: [] });
    expect(monthCommand(draftFor([stored]), 'plan-1')).toBeNull();
    const draft = setChoice(draftFor([stored]), D3, 'EMPLOYEE');
    const moved = rebase(draft, monthBase([{ ...stored, version: 2, assignments: [member(JONAS_ID)] }], MIRA_ID, '2026-12')).draft;
    expect(moved.conflicts.size).toBe(1);
    expect(monthCommand(moved, 'plan-1')).toBeNull();
    expect(monthCommand(keepChoice(moved, D3), 'plan-1')!.changes).toEqual([
      expect.objectContaining({ dutyId: stored.id, basedOnVersion: 2, to: 'EMPLOYEE' }),
    ]);
  });
});

describe('#88 employee-month draft — moving onto a newer server state', () => {
  const stored = duty({ ...DEC_3, version: 1, assignments: [member(JONAS_ID)] });

  it('keeps every choice, reports reached ones and marks each kind of server change', () => {
    const night = duty({ ...DEC_3_NIGHT, version: 1, assignments: [member(MIRA_ID)] });
    const dec5 = duty({ dutyDate: '2026-12-05', startsAt: '2026-12-05T05:00:00Z', endsAt: '2026-12-05T17:00:00Z', version: 1 });
    let draft = draftFor([stored, night, dec5]);
    draft = setChoice(draft, D3, 'EMPLOYEE'); // others change → 'others'
    draft = setChoice(draft, N3, 'SHIFT_LEAD'); // own role changed elsewhere → 'own'
    draft = setChoice(draft, slotKey('2026-12-04', 'DAY'), 'EMPLOYEE'); // duty created meanwhile → 'created'
    draft = setChoice(draft, slotKey('2026-12-05', 'DAY'), 'EMPLOYEE'); // duty removed meanwhile → 'removed'
    draft = setChoice(draft, slotKey('2026-12-06', 'DAY'), 'EMPLOYEE'); // reached on the server → dropped

    const fresh = monthBase([
      { ...stored, version: 2, assignments: [...stored.assignments, member(LEA_ID)] },
      { ...night, version: 2, assignments: [] },
      duty({ dutyDate: '2026-12-04', startsAt: '2026-12-04T05:00:00Z', endsAt: '2026-12-04T17:00:00Z' }),
      duty({ dutyDate: '2026-12-06', startsAt: '2026-12-06T05:00:00Z', endsAt: '2026-12-06T17:00:00Z', assignments: [member(MIRA_ID)] }),
      duty({ dutyDate: '2026-12-07', startsAt: '2026-12-07T05:00:00Z', endsAt: '2026-12-07T17:00:00Z', assignments: [member(MIRA_ID)] }),
    ], MIRA_ID, '2026-12');
    const { draft: moved, report } = rebase(draft, fresh);

    expect(report.reached).toEqual([slotKey('2026-12-06', 'DAY')]);
    expect(report.changedElsewhere).toEqual([slotKey('2026-12-07', 'DAY')]);
    expect(Object.fromEntries([...moved.conflicts].map(([key, conflict]) => [key, conflict.kind]))).toEqual({
      [D3]: 'others',
      [N3]: 'own',
      [slotKey('2026-12-04', 'DAY')]: 'created',
      [slotKey('2026-12-05', 'DAY')]: 'removed',
    });
    expect([...moved.choices.keys()]).toHaveLength(4);
    expect(slotOf(moved, D3).version).toBe(2);
  });

  it('marks a duty that was deleted and created again as replaced', () => {
    const draft = setChoice(draftFor([stored]), D3, 'EMPLOYEE');
    const recreated = duty({ ...DEC_3, version: 1 });
    expect(rebase(draft, monthBase([recreated], MIRA_ID, '2026-12')).draft.conflicts.get(D3)!.kind).toBe('replaced');
  });

  it('is a no-op for an identical state and keeps an open conflict with its first reference', () => {
    const draft = setChoice(draftFor([stored]), D3, 'EMPLOYEE');
    expect(rebase(draft, monthBase([stored], MIRA_ID, '2026-12')).draft.conflicts.size).toBe(0);
    const first = rebase(draft, monthBase([{ ...stored, version: 2 }], MIRA_ID, '2026-12')).draft;
    const second = rebase(first, monthBase([{ ...stored, version: 2 }], MIRA_ID, '2026-12')).draft;
    expect(second.conflicts.get(D3)!.before.version).toBe(1);
  });

  it('refuses to move a draft to another employee or month', () => {
    const draft = draftFor([stored]);
    expect(() => rebase(draft, monthBase([stored], JONAS_ID, '2026-12'))).toThrow();
    expect(() => rebase(draft, monthBase([stored], MIRA_ID, '2027-01'))).toThrow();
  });
});

describe('#88 employee-month draft — static restrictions (UX aid only)', () => {
  const free = monthBase([], MIRA_ID, '2026-12').slots.get(D3)!;
  const planned = monthBase([duty({ ...DEC_3, assignments: [member(MIRA_ID)] })], MIRA_ID, '2026-12').slots.get(D3)!;

  it('always allows taking someone off a duty and returning to the server state', () => {
    const blocked: PlannerContext = { employee: null, assigned: false, projectActive: false, newDuties: false };
    expect(changeRestriction(blocked, planned, null)).toBeNull();
    expect(changeRestriction(blocked, planned, 'EMPLOYEE')).toBeNull();
    expect(changeRestriction(blocked, planned, 'SHIFT_LEAD')).toBe('PROJECT_INACTIVE');
  });

  it('mirrors project, assignment, status, employment, eligibility and missing-duty rules in server order', () => {
    expect(changeRestriction(ACTIVE, free, 'EMPLOYEE')).toBeNull();
    expect(changeRestriction({ ...ACTIVE, projectActive: false }, free, 'EMPLOYEE')).toBe('PROJECT_INACTIVE');
    expect(changeRestriction({ ...ACTIVE, employee: null }, free, 'EMPLOYEE')).toBe('UNKNOWN_PERSON');
    expect(changeRestriction({ ...ACTIVE, assigned: false }, free, 'EMPLOYEE')).toBe('NOT_ASSIGNED');
    expect(changeRestriction({ ...ACTIVE, employee: person(OSKAR_ID) }, free, 'EMPLOYEE')).toBe('INACTIVE');
    const lea = { ...ACTIVE, employee: person(LEA_ID) };
    expect(changeRestriction(lea, free, 'EMPLOYEE')).toBeNull();
    expect(changeRestriction(lea, monthBase([], LEA_ID, '2026-12').slots.get(slotKey('2026-12-16', 'DAY'))!, 'EMPLOYEE')).toBe('NOT_EMPLOYED');
    const jonas = { ...ACTIVE, employee: person(JONAS_ID) };
    expect(changeRestriction(jonas, monthBase([], JONAS_ID, '2026-12').slots.get(N3)!, 'EMPLOYEE')).toBe('NOT_ELIGIBLE_FOR_SHIFT');
    expect(changeRestriction({ ...ACTIVE, newDuties: false }, free, 'EMPLOYEE')).toBe('NO_DUTY');
  });
});

describe('#88 employee-month draft — day findings', () => {
  it('drops the finding of an edited slot and keeps the others', () => {
    const issues = [
      { date: '2026-12-03', kind: 'DAY' as const, reason: 'EMPLOYEE_UNAVAILABLE' as const },
      { date: '2026-12-03', kind: 'NIGHT' as const, reason: 'DUTY_ASSIGNMENT_CONFLICT' as const },
      { date: '2026-12-04', kind: null, reason: 'REJECTED' as const },
    ];
    expect(issuesAfterEdit(issues, '2026-12-03', 'DAY')).toEqual([issues[1], issues[2]]);
    expect(issuesAfterEdit(issues, '2026-12-04', 'NIGHT')).toEqual([issues[0], issues[1]]);
  });
});
