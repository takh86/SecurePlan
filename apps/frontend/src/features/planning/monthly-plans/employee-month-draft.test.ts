import { describe, expect, it } from 'vitest';
import type { Duty } from './monthly-plan-types';
import {
  PAINT_MODES,
  UNKNOWN_CALENDAR,
  calendarWeeks,
  changeRestriction,
  changeText,
  correctionOf,
  corrections,
  dayStateText,
  dayText,
  daySlots,
  emptyDraft,
  issuesAfterEdit,
  keepChoice,
  monthBase,
  monthCommand,
  monthSummary,
  paint,
  paintRestriction,
  pendingChanges,
  rebase,
  revertDay,
  setDay,
  setRole,
  slotKey,
  storedDay,
  wanted,
  type EmployeeMonthDraft,
  type PaintMode,
  type PlannerContext,
  type ProjectCalendar,
} from './employee-month-draft';
import { JONAS_ID, LEA_ID, MIRA_ID, OSKAR_ID, duty, member, staff } from './monthly-planning.test-support';

/** `2026-12-DD`. */
function dec(day: number): string {
  return `2026-12-${String(day).padStart(2, '0')}`;
}

function dayDuty(day: number, overrides: Partial<Duty> = {}): Duty {
  return duty({ dutyDate: dec(day), startsAt: `${dec(day)}T05:00:00Z`, endsAt: `${dec(day)}T17:00:00Z`, ...overrides });
}

function nightDuty(day: number, overrides: Partial<Duty> = {}): Duty {
  const next = day === 31 ? '2027-01-01' : dec(day + 1);
  return duty({ dutyDate: dec(day), shiftKind: 'NIGHT', startsAt: `${dec(day)}T17:00:00Z`, endsAt: `${next}T05:00:00Z`, ...overrides });
}

function person(id: string) {
  return staff.find((employee) => employee.id === id)!;
}

const ACTIVE: PlannerContext = { employee: person(MIRA_ID), assigned: true, projectActive: true, newDuties: true, calendar: UNKNOWN_CALENDAR };

function draftFor(duties: Duty[], employeeId = MIRA_ID, month = '2026-12'): EmployeeMonthDraft {
  return emptyDraft(monthBase(duties, employeeId, month));
}

function paintAll(draft: EmployeeMonthDraft, mode: PaintMode, days: number[]): EmployeeMonthDraft {
  return days.reduce((current, day) => paint(current, dec(day), mode), draft);
}

/** The invariant: no wanted date has both shifts unless it is untouched stored data. */
function expectOneShiftPerDate(draft: EmployeeMonthDraft) {
  for (const [date, choice] of draft.choices) {
    expect(choice === null || (choice.kind === 'DAY' || choice.kind === 'NIGHT'), date).toBe(true);
    expect(wanted(draft, date)).not.toBe('BOTH');
  }
}

describe('#88 employee-month draft — month base', () => {
  it('has a DAY and a NIGHT slot for every calendar day, including the night of the last day', () => {
    const base = monthBase([nightDuty(31)], MIRA_ID, '2026-12');
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
    const stored = dayDuty(3, {
      version: 7,
      assignments: [{ ...own, employeeId: MIRA_ID.toUpperCase() }, member(JONAS_ID, 'SHIFT_LEAD'), member(LEA_ID)],
      availabilityConflicts: [{ code: 'EMPLOYEE_UNAVAILABLE', assignmentId: own.id, employeeId: MIRA_ID }],
    });
    const slot = monthBase([stored], MIRA_ID, '2026-12').slots.get(slotKey(dec(3), 'DAY'))!;
    expect(slot).toMatchObject({ dutyId: stored.id, version: 7, role: 'SHIFT_LEAD', unavailable: true });
    expect(slot.others).toEqual([{ employeeId: JONAS_ID, dutyRole: 'SHIFT_LEAD' }, { employeeId: LEA_ID, dutyRole: 'EMPLOYEE' }]);
    expect(monthBase([stored], LEA_ID, '2026-12').slots.get(slotKey(dec(3), 'DAY'))!).toMatchObject({ role: 'EMPLOYEE', unavailable: false });
  });

  it('reads a date as Tag, Nacht, Frei or — for stored data from before the rule — both', () => {
    const base = monthBase([
      dayDuty(1, { assignments: [member(MIRA_ID, 'SHIFT_LEAD')] }),
      nightDuty(2, { assignments: [member(MIRA_ID)] }),
      dayDuty(4, { assignments: [member(MIRA_ID)] }),
      nightDuty(4, { assignments: [member(MIRA_ID, 'SHIFT_LEAD')] }),
    ], MIRA_ID, '2026-12');
    expect(storedDay(base, dec(1))).toEqual({ kind: 'DAY', role: 'SHIFT_LEAD' });
    expect(storedDay(base, dec(2))).toEqual({ kind: 'NIGHT', role: 'EMPLOYEE' });
    expect(storedDay(base, dec(3))).toBeNull();
    expect(storedDay(base, dec(4))).toBe('BOTH');
  });
});

describe('#88 employee-month draft — paint modes, one shift per date', () => {
  it('runs the acceptance scenario: TAG 1, 2, 5, 10 · NACHT 17, 19 · FREI 5 · TAG 2 again · NACHT on a TAG date', () => {
    let draft = draftFor([]);
    draft = paintAll(draft, 'DAY', [1, 2, 5, 10]);
    draft = paintAll(draft, 'NIGHT', [17, 19]);
    draft = paint(draft, dec(5), 'FREE');
    const beforeRepeat = draft;
    draft = paint(draft, dec(2), 'DAY');
    expect(draft).toBe(beforeRepeat);
    draft = paint(draft, dec(1), 'NIGHT');

    expect(Object.fromEntries([...draft.choices].map(([date, plan]) => [date.slice(8), plan?.kind ?? 'FREE']))).toEqual({
      '01': 'NIGHT', '02': 'DAY', 10: 'DAY', 17: 'NIGHT', 19: 'NIGHT',
    });
    // 5 went back to Frei = the stored state: no change is left for it.
    expect(wanted(draft, dec(5))).toBeNull();
    expect(draft.choices.has(dec(5))).toBe(false);
    expect(monthSummary(draft)).toEqual({ day: 2, night: 3, free: 26, both: 0 });
    expectOneShiftPerDate(draft);
  });

  it('replaces a stored TAG with NACHT as ONE date change, and painting the stored state again leaves nothing pending', () => {
    let draft = draftFor([dayDuty(3, { assignments: [member(MIRA_ID)] })]);
    draft = paint(draft, dec(3), 'NIGHT');
    const [change] = pendingChanges(draft);
    expect(change).toMatchObject({ date: dec(3), status: 'switched', before: { kind: 'DAY' }, after: { kind: 'NIGHT', role: 'EMPLOYEE' } });
    expect(changeText(change)).toBe('Nachtdienst (Mitarbeitende) statt Tagdienst (Mitarbeitende) – Dienst noch nicht angelegt');
    draft = paint(draft, dec(3), 'DAY');
    expect(draft.choices.size).toBe(0);
  });

  it('repeating the active mode is idempotent: same draft, kept role, open conflict untouched', () => {
    const stored = dayDuty(3, { version: 1, assignments: [member(MIRA_ID, 'SHIFT_LEAD')] });
    const base = draftFor([stored]);
    expect(paint(base, dec(3), 'DAY')).toBe(base);
    expect(paint(base, dec(4), 'FREE')).toBe(base);

    const lead = setRole(paint(base, dec(7), 'NIGHT'), dec(7), 'SHIFT_LEAD');
    expect(paint(lead, dec(7), 'NIGHT')).toBe(lead);
    expect(wanted(lead, dec(7))).toEqual({ kind: 'NIGHT', role: 'SHIFT_LEAD' });

    const changed = paint(base, dec(3), 'FREE');
    const moved = rebase(changed, monthBase([{ ...stored, version: 2, assignments: [...stored.assignments, member(LEA_ID)] }], MIRA_ID, '2026-12')).draft;
    expect(moved.conflicts.has(dec(3))).toBe(true);
    expect(paint(moved, dec(3), 'FREE')).toBe(moved);
  });

  it('keeps an existing Schichtleitung unless the role is changed explicitly; a new membership starts as Mitarbeitende', () => {
    let draft = draftFor([dayDuty(3, { assignments: [member(MIRA_ID, 'SHIFT_LEAD')] })]);
    draft = paint(draft, dec(3), 'NIGHT');
    expect(wanted(draft, dec(3))).toEqual({ kind: 'NIGHT', role: 'EMPLOYEE' });
    draft = paint(draft, dec(3), 'DAY');
    expect(wanted(draft, dec(3))).toEqual({ kind: 'DAY', role: 'SHIFT_LEAD' });
    expect(draft.choices.size).toBe(0);

    draft = setRole(draft, dec(3), 'EMPLOYEE');
    const [change] = pendingChanges(draft);
    expect(change.status).toBe('role-changed');
    expect(changeText(change)).toBe('Tagdienst: Funktion von Schichtleitung zu Mitarbeitende');
    // A role belongs to the one wanted shift: no role on Frei, and no way to a second shift.
    expect(setRole(draft, dec(4), 'SHIFT_LEAD')).toBe(draft);
  });

  it('never yields both shifts, whatever sequence of modes, role edits and resets is applied to any stored state', () => {
    const states: Duty[][] = [
      [],
      [dayDuty(3, { assignments: [member(MIRA_ID, 'SHIFT_LEAD')] })],
      [nightDuty(3, { assignments: [member(MIRA_ID)] })],
      [dayDuty(3, { assignments: [member(MIRA_ID)] }), nightDuty(3, { assignments: [member(MIRA_ID, 'SHIFT_LEAD')] })],
    ];
    for (const duties of states) {
      for (const first of PAINT_MODES) {
        for (const second of PAINT_MODES) {
          for (const third of PAINT_MODES) {
            let draft = draftFor(duties);
            draft = paint(draft, dec(3), first);
            draft = setRole(draft, dec(3), 'SHIFT_LEAD');
            draft = paint(draft, dec(3), second);
            draft = paint(draft, dec(3), third);
            expect(wanted(draft, dec(3))).not.toBe('BOTH');
            expect(wanted(draft, dec(3))).toEqual(third === 'FREE' ? null : expect.objectContaining({ kind: third }));
            expectOneShiftPerDate(draft);
            const command = monthCommand(draft, 'plan-1', UNKNOWN_CALENDAR);
            for (const day of command?.days ?? []) expect(day.to === null || day.to.kind === third).toBe(true);
          }
        }
      }
    }
  });

  it('describes dates without implying an absence', () => {
    const slots = daySlots(monthBase([], MIRA_ID, '2026-12'), dec(3));
    expect(dayText(null)).toBe('Frei (nicht eingeplant)');
    expect(dayStateText(slots, null, null)).toBe('Frei (nicht eingeplant)');
    expect(dayStateText(slots, null, { kind: 'DAY', role: 'EMPLOYEE' }))
      .toBe('Tagdienst (Mitarbeitende), bisher Frei (nicht eingeplant), noch nicht gespeichert; Dienst noch nicht angelegt');
    expect(`${dayText(null)} ${dayStateText(slots, null, null)}`).not.toMatch(/krank|Urlaub|abwesend|Abwesenheit/i);
  });

  it('reverting a date drops its choice and any open conflict', () => {
    const draft = paint(draftFor([]), dec(3), 'DAY');
    expect(revertDay(draft, dec(3)).choices.size).toBe(0);
    expect(revertDay(draft, dec(4))).toBe(draft);
  });
});

describe('#88 employee-month draft — stored dates with both shifts', () => {
  const both = [dayDuty(3, { assignments: [member(MIRA_ID)] }), nightDuty(3, { assignments: [member(MIRA_ID, 'SHIFT_LEAD'), member(JONAS_ID)] })];

  it('stays visible as "Korrektur nötig", is never changed on load and blocks the month command', () => {
    let draft = draftFor(both);
    expect(wanted(draft, dec(3))).toBe('BOTH');
    expect(draft.choices.size).toBe(0);
    expect(corrections(draft, UNKNOWN_CALENDAR)).toEqual([{ date: dec(3), reason: 'BOTH_SHIFTS' }]);
    expect(monthSummary(draft).both).toBe(1);
    draft = paint(draft, dec(10), 'DAY');
    expect(monthCommand(draft, 'plan-1', UNKNOWN_CALENDAR)).toBeNull();
    // A newer read keeps it visible as well.
    expect(wanted(rebase(draft, monthBase(both, MIRA_ID, '2026-12')).draft, dec(3))).toBe('BOTH');
  });

  it('is corrected explicitly by keeping one shift (with its stored role) or by Frei', () => {
    const base = draftFor(both);
    const night = paint(base, dec(3), 'NIGHT');
    expect(wanted(night, dec(3))).toEqual({ kind: 'NIGHT', role: 'SHIFT_LEAD' });
    const [change] = pendingChanges(night);
    expect(change.status).toBe('corrected');
    expect(changeText(change)).toBe('nur noch Nachtdienst (Schichtleitung); Tagdienst wird ausgetragen');
    expect(monthCommand(night, 'plan-1', UNKNOWN_CALENDAR)!.days).toEqual([{
      date: dec(3),
      to: { kind: 'NIGHT', role: 'SHIFT_LEAD' },
      basedOn: {
        DAY: { dutyId: both[0].id, version: both[0].version, role: 'EMPLOYEE' },
        NIGHT: { dutyId: both[1].id, version: both[1].version, role: 'SHIFT_LEAD' },
      },
    }]);
    const free = setDay(base, dec(3), null);
    expect(pendingChanges(free)[0].status).toBe('removed');
    expect(changeText(pendingChanges(free)[0])).toBe('Frei, bisher Tagdienst und Nachtdienst');
    expect(corrections(free, UNKNOWN_CALENDAR)).toEqual([]);
    // Any operation on such a date ends with one shift or none.
    expect(revertDay(night, dec(3)).choices.size).toBe(0);
    expect(wanted(revertDay(night, dec(3)), dec(3))).toBe('BOTH');
  });
});

describe('#88 employee-month draft — the command never touches other members', () => {
  it('lists per changed date the wanted plan and the stored state of both slots, never other members', () => {
    const shared = dayDuty(3, { version: 4, assignments: [member(JONAS_ID, 'SHIFT_LEAD'), member(LEA_ID)] });
    const night = nightDuty(4, { version: 2, assignments: [member(MIRA_ID), member(JONAS_ID)] });
    let draft = draftFor([shared, night]);
    draft = paint(draft, dec(3), 'DAY');
    draft = paint(draft, dec(4), 'FREE');
    const command = monthCommand(draft, 'plan-1', UNKNOWN_CALENDAR)!;
    expect(command).toEqual({
      planId: 'plan-1',
      employeeId: MIRA_ID,
      month: '2026-12',
      days: [
        {
          date: dec(3),
          to: { kind: 'DAY', role: 'EMPLOYEE' },
          basedOn: { DAY: { dutyId: shared.id, version: 4, role: null }, NIGHT: { dutyId: null, version: null, role: null } },
        },
        {
          date: dec(4),
          to: null,
          basedOn: { DAY: { dutyId: null, version: null, role: null }, NIGHT: { dutyId: night.id, version: 2, role: 'EMPLOYEE' } },
        },
      ],
    });
    expect(JSON.stringify(command)).not.toContain(JONAS_ID);
    expect(JSON.stringify(command)).not.toContain(LEA_ID);
  });

  it('has nothing to save without changes or while a conflict is undecided', () => {
    const stored = dayDuty(3, { assignments: [] });
    expect(monthCommand(draftFor([stored]), 'plan-1', UNKNOWN_CALENDAR)).toBeNull();
    const draft = paint(draftFor([stored]), dec(3), 'DAY');
    const moved = rebase(draft, monthBase([{ ...stored, version: 2, assignments: [member(JONAS_ID)] }], MIRA_ID, '2026-12')).draft;
    expect(moved.conflicts.size).toBe(1);
    expect(monthCommand(moved, 'plan-1', UNKNOWN_CALENDAR)).toBeNull();
    expect(monthCommand(keepChoice(moved, dec(3)), 'plan-1', UNKNOWN_CALENDAR)!.days).toEqual([
      expect.objectContaining({ basedOn: expect.objectContaining({ DAY: { dutyId: stored.id, version: 2, role: null } }) }),
    ]);
  });
});

describe('#88 employee-month draft — moving onto a newer server state', () => {
  const stored = dayDuty(3, { version: 1, assignments: [member(JONAS_ID)] });

  it('keeps every choice, reports reached ones and marks each kind of server change', () => {
    const night = nightDuty(4, { version: 1, assignments: [member(MIRA_ID)] });
    const dec6 = dayDuty(6, { version: 1 });
    let draft = draftFor([stored, night, dec6]);
    draft = paint(draft, dec(3), 'DAY'); // others change → 'others'
    draft = setRole(draft, dec(4), 'SHIFT_LEAD'); // own role changed elsewhere → 'own'
    draft = paint(draft, dec(5), 'DAY'); // duty created meanwhile → 'created'
    draft = paint(draft, dec(6), 'DAY'); // duty removed meanwhile → 'removed'
    draft = paint(draft, dec(7), 'DAY'); // reached on the server → dropped

    const fresh = monthBase([
      { ...stored, version: 2, assignments: [...stored.assignments, member(LEA_ID)] },
      { ...night, version: 2, assignments: [] },
      dayDuty(5),
      dayDuty(7, { assignments: [member(MIRA_ID)] }),
      dayDuty(8, { assignments: [member(MIRA_ID)] }),
    ], MIRA_ID, '2026-12');
    const { draft: moved, report } = rebase(draft, fresh);

    expect(report.reached).toEqual([dec(7)]);
    expect(report.changedElsewhere).toEqual([dec(8)]);
    expect(Object.fromEntries([...moved.conflicts].map(([date, conflict]) => [date, `${conflict.kind}/${conflict.shift}`]))).toEqual({
      [dec(3)]: 'others/DAY',
      [dec(4)]: 'own/NIGHT',
      [dec(5)]: 'created/DAY',
      [dec(6)]: 'removed/DAY',
    });
    expect([...moved.choices.keys()]).toHaveLength(4);
    expectOneShiftPerDate(moved);
  });

  it('never makes a date dual: a TAG choice stays the only wanted shift when someone adds a night meanwhile', () => {
    let draft = paint(draftFor([]), dec(3), 'DAY');
    const elsewhere = monthBase([nightDuty(3, { assignments: [member(MIRA_ID)] }), dayDuty(9, { assignments: [member(MIRA_ID)] }), nightDuty(9, { assignments: [member(MIRA_ID)] })], MIRA_ID, '2026-12');
    const { draft: moved, report } = rebase(draft, elsewhere);
    expect(wanted(moved, dec(3))).toEqual({ kind: 'DAY', role: 'EMPLOYEE' });
    expect(moved.conflicts.get(dec(3))).toMatchObject({ kind: 'own', shift: 'NIGHT' });
    expect(pendingChanges(moved)[0].status).toBe('switched');
    // An untouched date that became dual elsewhere is reported and needs a correction; it is not hidden.
    expect(report.changedElsewhere).toEqual([dec(9)]);
    expect(correctionOf(moved, dec(9), UNKNOWN_CALENDAR)).toBe('BOTH_SHIFTS');
    draft = keepChoice(moved, dec(3));
    expect(monthCommand(draft, 'plan-1', UNKNOWN_CALENDAR)).toBeNull();
    draft = paint(draft, dec(9), 'FREE');
    expect(monthCommand(draft, 'plan-1', UNKNOWN_CALENDAR)!.days.map((day) => [day.date, day.to?.kind ?? null])).toEqual([[dec(3), 'DAY'], [dec(9), null]]);
  });

  it('ignores a change of a slot the choice does not write to', () => {
    const night = nightDuty(3, { version: 1, assignments: [member(JONAS_ID)] });
    const draft = paint(draftFor([night]), dec(3), 'DAY');
    const moved = rebase(draft, monthBase([{ ...night, version: 2, assignments: [member(JONAS_ID), member(LEA_ID)] }], MIRA_ID, '2026-12')).draft;
    expect(moved.conflicts.size).toBe(0);
    expect(moved.choices.size).toBe(1);
  });

  it('marks a duty that was deleted and created again as replaced', () => {
    const draft = paint(draftFor([stored]), dec(3), 'DAY');
    expect(rebase(draft, monthBase([dayDuty(3, { version: 1 })], MIRA_ID, '2026-12')).draft.conflicts.get(dec(3))!.kind).toBe('replaced');
  });

  it('is a no-op for an identical state and keeps an open conflict with its first reference', () => {
    const draft = paint(draftFor([stored]), dec(3), 'DAY');
    expect(rebase(draft, monthBase([stored], MIRA_ID, '2026-12')).draft.conflicts.size).toBe(0);
    const first = rebase(draft, monthBase([{ ...stored, version: 2 }], MIRA_ID, '2026-12')).draft;
    const second = rebase(first, monthBase([{ ...stored, version: 2 }], MIRA_ID, '2026-12')).draft;
    expect(second.conflicts.get(dec(3))!.before.version).toBe(1);
  });

  it('refuses to move a draft to another employee or month', () => {
    const draft = draftFor([stored]);
    expect(() => rebase(draft, monthBase([stored], JONAS_ID, '2026-12'))).toThrow();
    expect(() => rebase(draft, monthBase([stored], MIRA_ID, '2027-01'))).toThrow();
  });
});

describe('#88 employee-month draft — static restrictions (UX aid only)', () => {
  const free = draftFor([]);
  const planned = draftFor([dayDuty(3, { assignments: [member(MIRA_ID)] })]);

  it('always allows Frei and returning to the stored state', () => {
    const blocked: PlannerContext = { employee: null, assigned: false, projectActive: false, newDuties: false, calendar: UNKNOWN_CALENDAR };
    expect(paintRestriction(blocked, planned, dec(3), 'FREE')).toBeNull();
    expect(paintRestriction(blocked, planned, dec(3), 'DAY')).toBeNull();
    expect(paintRestriction(blocked, planned, dec(3), 'NIGHT')).toBe('PROJECT_INACTIVE');
    const slot = daySlots(planned.base, dec(3)).DAY;
    expect(changeRestriction(blocked, slot, 'EMPLOYEE')).toBeNull();
    expect(changeRestriction(blocked, slot, 'SHIFT_LEAD')).toBe('PROJECT_INACTIVE');
  });

  it('mirrors project, assignment, status, employment, eligibility and missing-duty rules', () => {
    expect(paintRestriction(ACTIVE, free, dec(3), 'DAY')).toBeNull();
    expect(paintRestriction({ ...ACTIVE, projectActive: false }, free, dec(3), 'DAY')).toBe('PROJECT_INACTIVE');
    expect(paintRestriction({ ...ACTIVE, employee: null }, free, dec(3), 'DAY')).toBe('UNKNOWN_PERSON');
    expect(paintRestriction({ ...ACTIVE, assigned: false }, free, dec(3), 'DAY')).toBe('NOT_ASSIGNED');
    expect(paintRestriction({ ...ACTIVE, employee: person(OSKAR_ID) }, free, dec(3), 'DAY')).toBe('INACTIVE');
    const lea = { ...ACTIVE, employee: person(LEA_ID) };
    expect(paintRestriction(lea, draftFor([], LEA_ID), dec(15), 'DAY')).toBeNull();
    expect(paintRestriction(lea, draftFor([], LEA_ID), dec(16), 'DAY')).toBe('NOT_EMPLOYED');
    const jonas = { ...ACTIVE, employee: person(JONAS_ID) };
    expect(paintRestriction(jonas, draftFor([], JONAS_ID), dec(3), 'NIGHT')).toBe('NOT_ELIGIBLE_FOR_SHIFT');
    expect(paintRestriction({ ...ACTIVE, newDuties: false }, free, dec(3), 'DAY')).toBe('NO_DUTY');
  });

  it('assumes no weekend rule while the operating days are unknown (#90)', () => {
    // 5 and 6 December 2026 are a Saturday and a Sunday.
    expect(paintRestriction(ACTIVE, free, dec(5), 'NIGHT')).toBeNull();
    expect(paintRestriction(ACTIVE, free, dec(6), 'DAY')).toBeNull();
    expect(corrections(paintAll(free, 'DAY', [5, 6]), UNKNOWN_CALENDAR)).toEqual([]);
  });

  it('with an authoritative calendar, offers only Frei on a closed date and flags stored duties there (#90 boundary)', () => {
    const calendar: ProjectCalendar = { status: 'known', closed: new Set([dec(3), dec(24)]) };
    const context = { ...ACTIVE, calendar };
    expect(paintRestriction(context, free, dec(24), 'DAY')).toBe('CLOSED_DAY');
    expect(paintRestriction(context, free, dec(24), 'NIGHT')).toBe('CLOSED_DAY');
    expect(paintRestriction(context, free, dec(23), 'NIGHT')).toBeNull();
    expect(paintRestriction(context, planned, dec(3), 'FREE')).toBeNull();
    expect(correctionOf(planned, dec(3), calendar)).toBe('CLOSED_DAY');
    expect(monthCommand(paint(planned, dec(10), 'DAY'), 'plan-1', calendar)).toBeNull();
    expect(monthCommand(paint(planned, dec(3), 'FREE'), 'plan-1', calendar)!.days).toHaveLength(1);
  });
});

describe('#88 employee-month draft — calendar layout', () => {
  it('builds Monday-first weeks with padding at month boundaries', () => {
    const december = calendarWeeks(monthBase([], MIRA_ID, '2026-12').days);
    expect(december).toHaveLength(5);
    expect(december[0]).toEqual([null, dec(1), dec(2), dec(3), dec(4), dec(5), dec(6)]);
    expect(december[4]).toEqual([dec(28), dec(29), dec(30), dec(31), null, null, null]);
    const february = calendarWeeks(monthBase([], MIRA_ID, '2027-02').days);
    expect(february).toHaveLength(4);
    expect(february.flat().every((date) => date !== null)).toBe(true);
    const november = calendarWeeks(monthBase([], MIRA_ID, '2026-11').days);
    expect(november).toHaveLength(6);
    expect(november[0].filter((date) => date !== null)).toEqual(['2026-11-01']);
    expect(calendarWeeks(monthBase([], MIRA_ID, '2028-02').days).flat().filter((date) => date !== null)).toHaveLength(29);
  });
});

describe('#88 employee-month draft — day findings', () => {
  it('drops every finding of an edited date and keeps the others', () => {
    const issues = [
      { date: dec(3), kind: 'DAY' as const, reason: 'EMPLOYEE_UNAVAILABLE' as const },
      { date: dec(3), kind: 'NIGHT' as const, reason: 'ONE_SHIFT_PER_DAY' as const },
      { date: dec(4), kind: null, reason: 'PROJECT_CLOSED_DAY' as const },
    ];
    expect(issuesAfterEdit(issues, dec(3))).toEqual([issues[2]]);
    expect(issuesAfterEdit(issues, dec(5))).toEqual(issues);
  });
});
