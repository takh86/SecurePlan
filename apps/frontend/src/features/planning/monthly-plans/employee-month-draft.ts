/**
 * Issue #88 (Product Owner decision 2026-11-02, design gate OPEN) with the PO
 * clarification in #90 and the Tech Lead review of PR #91: pure draft state of
 * the employee-month workflow. One employee, every day of the plan month. The
 * admin paints dates with a mode (TAG, NACHT or FREI); the draft records what
 * the admin wants on top of the server state it was built on. It never writes
 * anything. The base is either the plan's duty list (preview) or the A2
 * employee-month read (`monthBaseFromRead`), whose exact slot tokens become
 * the save preconditions (see `employee-month-save.ts`).
 *
 * Rules held by construction:
 * - ONE shift per employee, project and local duty date: a wanted day is TAG
 *   or NACHT (with a role) or Frei, never both. A night belongs to the date it
 *   starts on. Stored data with both shifts on a date (from before this rule)
 *   is shown as "Korrektur nötig" and blocks saving until the admin decides.
 * - Frei means "not planned in this project on this date"; it is a scheduling
 *   state only, never an absence record (sickness, leave).
 * - Other members of a duty are context only and never part of a change.
 * - An existing role (Schichtleitung) is kept unless the admin changes it.
 * - Project operating days come only from an authoritative calendar (A1, in
 *   the A2 read): new or changed work needs an open date; a MISSING calendar
 *   allows none. Existing work on such a date stays until the admin removes
 *   it; removing is always offered. Without a calendar (preview) no date is
 *   treated as closed and the server decides.
 */
import { SHIFT_TYPE_LABELS } from '../../../shared/shift/shift-view';
import type { DateOnly, MonthKey } from '../../../shared/time/month';
import type { EmployeeMonthConflictReason } from '../../../shared/api/api-error';
import type { Employee } from '../../employees/employee-types';
import type { ShiftKind } from '../../projects/shift-configuration-api';
import { eligibleForShift, employedOn } from './duty-eligibility';
import type { EmployeeMonthRead, MonthSlot } from './employee-month-api';
import { DUTY_ROLE_LABELS, type Duty, type DutyRole } from './monthly-plan-types';
import { matrixDays } from './planning-matrix';

/** Fixed slot order within a day. */
export const SLOT_KINDS: readonly ShiftKind[] = ['DAY', 'NIGHT'];

/** `YYYY-MM-DD|DAY` – one duty slot of the month. */
export type SlotKey = string;

export function slotKey(date: DateOnly, kind: ShiftKind): SlotKey {
  return `${date}|${kind}`;
}

/** The employee's role in one slot; null = no membership. */
export type Choice = DutyRole | null;

export type OtherMember = { employeeId: string; dutyRole: DutyRole };

/** Server state of one slot from the selected employee's point of view. */
export type SlotBase = {
  date: DateOnly;
  kind: ShiftKind;
  /** The duty of this date and kind, or null while none is created. */
  dutyId: string | null;
  version: number | null;
  /** The employee's current role in that duty. */
  role: Choice;
  /**
   * Neutral E-04 hint (never a reason): preview = on the employee's membership;
   * A2 read = the employee is unavailable on this date.
   */
  unavailable: boolean;
  /**
   * Every other current member (preview only; the A2 read never lists other
   * people). A change of this employee preserves them.
   */
  others: readonly OtherMember[];
};

export type MonthBase = {
  employeeId: string;
  month: MonthKey;
  /** Every calendar day of the month, in order. */
  days: readonly DateOnly[];
  slots: ReadonlyMap<SlotKey, SlotBase>;
  /** The A2 read this base was built from: the only source of save preconditions. Absent in the preview. */
  source?: EmployeeMonthRead;
};

/**
 * Builds the month's slots for one employee from the plan's duties. Duties
 * outside the month are ignored; a night duty belongs to the date it starts
 * on, so the night of the last day is part of the month.
 */
export function monthBase(duties: readonly Duty[], employeeId: string, month: MonthKey): MonthBase {
  const days = matrixDays(month);
  const inMonth = new Set(days);
  const own = employeeId.toLowerCase();
  const bySlot = new Map<SlotKey, Duty>();
  for (const duty of duties) {
    if (!inMonth.has(duty.dutyDate)) continue;
    const key = slotKey(duty.dutyDate, duty.shiftKind);
    // The server keeps at most one duty per date and kind (DUTY_ALREADY_EXISTS).
    if (!bySlot.has(key)) bySlot.set(key, duty);
  }
  const slots = new Map<SlotKey, SlotBase>();
  for (const date of days) {
    for (const kind of SLOT_KINDS) {
      const key = slotKey(date, kind);
      const duty = bySlot.get(key);
      const membership = duty?.assignments.find((member) => member.employeeId.toLowerCase() === own);
      slots.set(key, {
        date,
        kind,
        dutyId: duty?.id ?? null,
        version: duty?.version ?? null,
        role: membership?.dutyRole ?? null,
        unavailable: membership !== undefined
          && duty!.availabilityConflicts.some((conflict) => conflict.assignmentId.toLowerCase() === membership.id.toLowerCase()),
        others: (duty?.assignments ?? [])
          .filter((member) => member.employeeId.toLowerCase() !== own)
          .map(({ employeeId: other, dutyRole }) => ({ employeeId: other, dutyRole })),
      });
    }
  }
  return { employeeId, month, days, slots };
}

function slotFromRead(date: DateOnly, kind: ShiftKind, slot: MonthSlot | null, unavailable: boolean): SlotBase {
  return {
    date,
    kind,
    dutyId: slot?.dutyId ?? null,
    version: slot?.version ?? null,
    role: slot?.assignment?.dutyRole ?? null,
    unavailable,
    others: [],
  };
}

/**
 * The base of the A2 workflow: one consistent server read of the whole month.
 * Every slot keeps its exact duty ID and version (also empty duties and duties
 * staffed only by others), because all of them are preconditions of the save.
 */
export function monthBaseFromRead(read: EmployeeMonthRead): MonthBase {
  const unavailable = new Set(read.unavailableDates);
  const slots = new Map<SlotKey, SlotBase>();
  for (const day of read.days) {
    const off = unavailable.has(day.date);
    slots.set(slotKey(day.date, 'DAY'), slotFromRead(day.date, 'DAY', day.day, off));
    slots.set(slotKey(day.date, 'NIGHT'), slotFromRead(day.date, 'NIGHT', day.night, off));
  }
  return {
    employeeId: read.employeeId,
    month: read.plan.monthStart.slice(0, 7),
    days: read.days.map((day) => day.date),
    slots,
    source: read,
  };
}

/** The authoritative operating days of an A2 read (CLOSED dates, or MISSING for the whole month). */
export function calendarOfRead(read: EmployeeMonthRead): ProjectCalendar {
  if (read.calendar === null) return MISSING_CALENDAR;
  return { status: 'known', closed: new Set(read.days.filter((day) => day.operatingState === 'CLOSED').map((day) => day.date)) };
}

/**
 * Other current members of a slot's duty from the page's duty read, as
 * context only. Null when that read does not show this exact duty version:
 * the A2 read never lists other people, and two reads of different times are
 * never mixed into one statement.
 */
export function othersFromDuties(duties: readonly Duty[], slot: SlotBase, employeeId: string): readonly OtherMember[] | null {
  if (slot.dutyId === null) return [];
  const duty = duties.find((candidate) => candidate.id.toLowerCase() === slot.dutyId!.toLowerCase());
  if (!duty || duty.version !== slot.version) return null;
  const own = employeeId.toLowerCase();
  return duty.assignments
    .filter((member) => member.employeeId.toLowerCase() !== own)
    .map(({ employeeId: other, dutyRole }) => ({ employeeId: other, dutyRole }));
}

export function slotOf(draft: Pick<EmployeeMonthDraft, 'base'>, key: SlotKey): SlotBase {
  const slot = draft.base.slots.get(key);
  if (!slot) throw new Error(`Unknown slot ${key}`);
  return slot;
}

/** Both slots of one date. */
export function daySlots(base: MonthBase, date: DateOnly): Record<ShiftKind, SlotBase> {
  const day = base.slots.get(slotKey(date, 'DAY'));
  const night = base.slots.get(slotKey(date, 'NIGHT'));
  if (!day || !night) throw new Error(`Unknown date ${date}`);
  return { DAY: day, NIGHT: night };
}

/** The toolbar's paint modes, in display order. */
export type PaintMode = 'DAY' | 'NIGHT' | 'FREE';
export const PAINT_MODES: readonly PaintMode[] = ['DAY', 'NIGHT', 'FREE'];
export const PAINT_MODE_LABELS: Record<PaintMode, string> = { DAY: 'Tag', NIGHT: 'Nacht', FREE: 'Frei' };

/** What the employee does on one date: one shift with a role, or null = Frei (not planned). */
export type DayPlan = { kind: ShiftKind; role: DutyRole } | null;

/** A date's state: a valid plan, or BOTH for stored data with a DAY and a NIGHT membership. */
export type DayState = DayPlan | 'BOTH';

/** The stored state of a date for the employee. */
export function storedDay(base: MonthBase, date: DateOnly): DayState {
  const { DAY, NIGHT } = daySlots(base, date);
  if (DAY.role !== null && NIGHT.role !== null) return 'BOTH';
  if (DAY.role !== null) return { kind: 'DAY', role: DAY.role };
  if (NIGHT.role !== null) return { kind: 'NIGHT', role: NIGHT.role };
  return null;
}

export function sameDay(a: DayState, b: DayState): boolean {
  if (a === null || b === null || a === 'BOTH' || b === 'BOTH') return a === b;
  return a.kind === b.kind && a.role === b.role;
}

/** The employee's wanted role in one slot of a plan (null when the plan is another shift or Frei). */
export function roleIn(plan: DayPlan, kind: ShiftKind): Choice {
  return plan !== null && plan.kind === kind ? plan.role : null;
}

/** Why a date with a choice needs a new decision after the server state changed under it. */
export type ConflictKind = 'own' | 'created' | 'removed' | 'replaced' | 'others';

export type DayConflict = {
  kind: ConflictKind;
  /** The shift whose change caused the conflict. */
  shift: ShiftKind;
  /** That slot as first known while the conflict is open. */
  before: SlotBase;
};

export type EmployeeMonthDraft = {
  base: MonthBase;
  /** Only dates whose wanted plan differs from the stored state. Never BOTH. */
  choices: ReadonlyMap<DateOnly, DayPlan>;
  /** Choices whose date changed on the server since they were made; saving waits for a decision. */
  conflicts: ReadonlyMap<DateOnly, DayConflict>;
};

export function emptyDraft(base: MonthBase): EmployeeMonthDraft {
  return { base, choices: new Map(), conflicts: new Map() };
}

/** The state the admin wants for a date (the stored state when unchanged). */
export function wanted(draft: EmployeeMonthDraft, date: DateOnly): DayState {
  return draft.choices.has(date) ? draft.choices.get(date)! : storedDay(draft.base, date);
}

/**
 * Sets the wanted plan of a date. A plan equal to the stored state is no
 * change; an explicit decision settles an open conflict of that date.
 */
export function setDay(draft: EmployeeMonthDraft, date: DateOnly, plan: DayPlan): EmployeeMonthDraft {
  const choices = new Map(draft.choices);
  if (sameDay(plan, storedDay(draft.base, date))) choices.delete(date);
  else choices.set(date, plan);
  const conflicts = new Map(draft.conflicts);
  conflicts.delete(date);
  return { ...draft, choices, conflicts };
}

/**
 * The plan a paint mode leads to. TAG and NACHT replace each other; FREI
 * takes the employee off both. A shift the date already has keeps its role
 * (repeating a mode is no change); otherwise the stored role of that shift is
 * restored, and a new membership starts as Mitarbeitende.
 */
export function paintedPlan(draft: EmployeeMonthDraft, date: DateOnly, mode: PaintMode): DayPlan {
  if (mode === 'FREE') return null;
  const current = wanted(draft, date);
  if (current !== null && current !== 'BOTH' && current.kind === mode) return current;
  return { kind: mode, role: daySlots(draft.base, date)[mode].role ?? 'EMPLOYEE' };
}

/** Paints one date. Painting the state a date already has returns the same draft (idempotent). */
export function paint(draft: EmployeeMonthDraft, date: DateOnly, mode: PaintMode): EmployeeMonthDraft {
  const plan = paintedPlan(draft, date, mode);
  return sameDay(plan, wanted(draft, date)) ? draft : setDay(draft, date, plan);
}

/** Changes the role of the date's single wanted shift; no-op for Frei or a date with both shifts. */
export function setRole(draft: EmployeeMonthDraft, date: DateOnly, role: DutyRole): EmployeeMonthDraft {
  const current = wanted(draft, date);
  if (current === null || current === 'BOTH' || current.role === role) return draft;
  return setDay(draft, date, { kind: current.kind, role });
}

/** Back to the stored state of a date ("Aktuellen Stand übernehmen" for a conflict). */
export function revertDay(draft: EmployeeMonthDraft, date: DateOnly): EmployeeMonthDraft {
  if (!draft.choices.has(date) && !draft.conflicts.has(date)) return draft;
  const choices = new Map(draft.choices);
  choices.delete(date);
  const conflicts = new Map(draft.conflicts);
  conflicts.delete(date);
  return { ...draft, choices, conflicts };
}

/** Keeps the admin's choice on top of the newer server state. */
export function keepChoice(draft: EmployeeMonthDraft, date: DateOnly): EmployeeMonthDraft {
  if (!draft.conflicts.has(date)) return draft;
  const conflicts = new Map(draft.conflicts);
  conflicts.delete(date);
  return { ...draft, conflicts };
}

export type DayStatus = 'unchanged' | 'added' | 'removed' | 'switched' | 'role-changed' | 'corrected';

export function dayStatus(before: DayState, after: DayState): DayStatus {
  if (sameDay(before, after)) return 'unchanged';
  if (before === null) return 'added';
  if (after === null) return 'removed';
  if (before === 'BOTH') return 'corrected';
  if (after === 'BOTH') throw new Error('A wanted day never has both shifts');
  return before.kind !== after.kind ? 'switched' : 'role-changed';
}

export type DayChange = {
  date: DateOnly;
  before: DayState;
  after: DayPlan;
  status: Exclude<DayStatus, 'unchanged'>;
  slots: Record<ShiftKind, SlotBase>;
  conflict: DayConflict | null;
};

/** Every pending change in calendar order. */
export function pendingChanges(draft: EmployeeMonthDraft): DayChange[] {
  const changes: DayChange[] = [];
  for (const date of draft.base.days) {
    if (!draft.choices.has(date)) continue;
    const before = storedDay(draft.base, date);
    const after = draft.choices.get(date)!;
    changes.push({
      date,
      before,
      after,
      status: dayStatus(before, after) as DayChange['status'],
      slots: daySlots(draft.base, date),
      conflict: draft.conflicts.get(date) ?? null,
    });
  }
  return changes;
}

/**
 * The project's operating days in the plan month (A1), resolved by the server
 * to company-local dates (a night counts on its start date):
 * - `known`: the effective calendar; `closed` are the dates outside its weekdays.
 * - `missing`: no calendar applies to the month; no new work is possible on any date.
 * - `unknown`: preview without the A2 read; no date is treated as closed and the server decides.
 * Never an assumed Mon–Fri or seven-day week.
 */
export type ProjectCalendar =
  | { status: 'unknown' }
  | { status: 'missing' }
  | { status: 'known'; closed: ReadonlySet<DateOnly> };

export const UNKNOWN_CALENDAR: ProjectCalendar = { status: 'unknown' };
export const MISSING_CALENDAR: ProjectCalendar = { status: 'missing' };

export function isClosed(calendar: ProjectCalendar, date: DateOnly): boolean {
  return calendar.status === 'known' && calendar.closed.has(date);
}

/** Why the calendar allows no new or changed work on a date (null = allowed or unknown). */
export function calendarBlock(calendar: ProjectCalendar, date: DateOnly): 'CLOSED_DAY' | 'CALENDAR_MISSING' | null {
  if (calendar.status === 'missing') return 'CALENDAR_MISSING';
  return isClosed(calendar, date) ? 'CLOSED_DAY' : null;
}

/**
 * True when the wanted shift of a date is new or changed work for the
 * employee: another kind than stored, or another role. Keeping a stored shift
 * (also the kept half of a stored Tag + Nacht) is no new work.
 */
export function isNewWork(draft: EmployeeMonthDraft, date: DateOnly): boolean {
  const plan = wanted(draft, date);
  if (plan === null || plan === 'BOTH') return false;
  return daySlots(draft.base, date)[plan.kind].role !== plan.role;
}

/** Why a date needs a decision before the month can be saved. */
export type CorrectionReason = 'BOTH_SHIFTS' | 'CLOSED_DAY' | 'CALENDAR_MISSING';

export const CORRECTION_TEXT: Record<CorrectionReason, string> = {
  BOTH_SHIFTS: 'Tagdienst und Nachtdienst gespeichert – pro Tag ist nur ein Dienst erlaubt. Wählen Sie Tag, Nacht oder Frei.',
  CLOSED_DAY: 'Das Projekt ist an diesem Tag nicht in Betrieb. Nehmen Sie die Änderung zurück oder setzen Sie den Tag auf Frei.',
  CALENDAR_MISSING: 'Für das Projekt sind in diesem Monat keine Betriebstage festgelegt. Nehmen Sie die Änderung zurück oder setzen Sie den Tag auf Frei.',
};

/**
 * A date that blocks the save: stored Tag + Nacht without a decision, or a
 * pending new/changed shift on a date the calendar does not open (the server
 * would refuse the whole month). Existing work on such a date is no correction.
 */
export function correctionOf(draft: EmployeeMonthDraft, date: DateOnly, calendar: ProjectCalendar): CorrectionReason | null {
  const state = wanted(draft, date);
  if (state === 'BOTH') return 'BOTH_SHIFTS';
  if (!isNewWork(draft, date)) return null;
  return calendarBlock(calendar, date);
}

/** Existing (unchanged) work on a date the calendar does not open: shown, kept, removable. */
export function keptOnBlockedDay(draft: EmployeeMonthDraft, date: DateOnly, calendar: ProjectCalendar): boolean {
  const state = wanted(draft, date);
  if (state === null || isNewWork(draft, date)) return false;
  return calendarBlock(calendar, date) !== null;
}

export const KEPT_ON_BLOCKED_DAY_TEXT: Record<'CLOSED_DAY' | 'CALENDAR_MISSING', string> = {
  CLOSED_DAY: 'Bestehender Dienst an einem Tag, an dem das Projekt nicht in Betrieb ist. Er bleibt unverändert, bis Sie den Tag auf Frei setzen.',
  CALENDAR_MISSING: 'Bestehender Dienst, obwohl für diesen Monat keine Betriebstage festgelegt sind. Er bleibt unverändert, bis Sie den Tag auf Frei setzen.',
};

export function corrections(draft: EmployeeMonthDraft, calendar: ProjectCalendar): { date: DateOnly; reason: CorrectionReason }[] {
  return draft.base.days.flatMap((date) => {
    const reason = correctionOf(draft, date, calendar);
    return reason === null ? [] : [{ date, reason }];
  });
}

/** Wanted shifts of the month, for the summary line. */
export function monthSummary(draft: EmployeeMonthDraft): { day: number; night: number; free: number; both: number } {
  const summary = { day: 0, night: 0, free: 0, both: 0 };
  for (const date of draft.base.days) {
    const state = wanted(draft, date);
    if (state === 'BOTH') summary.both += 1;
    else if (state === null) summary.free += 1;
    else if (state.kind === 'DAY') summary.day += 1;
    else summary.night += 1;
  }
  return summary;
}

export type RebaseReport = {
  /** Dates whose wanted plan the newer server state already shows; they are no longer pending. */
  reached: DateOnly[];
  /** Dates whose choice touches a slot that changed; the choice stays, marked for a decision. */
  conflicts: DateOnly[];
  /** Dates without a choice whose state for this employee changed on the server. */
  changedElsewhere: DateOnly[];
};

/** How one slot changed; a change of the employee's own membership is named first. */
function conflictKind(before: SlotBase, now: SlotBase): ConflictKind | null {
  if (before.role !== now.role) return 'own';
  if (before.dutyId === null && now.dutyId !== null) return 'created';
  if (before.dutyId !== null && now.dutyId === null) return 'removed';
  if (before.dutyId !== null && now.dutyId !== null && before.dutyId.toLowerCase() !== now.dutyId.toLowerCase()) return 'replaced';
  if (before.version !== now.version) return 'others';
  return null;
}

const CONFLICT_PRIORITY: readonly ConflictKind[] = ['own', 'replaced', 'removed', 'created', 'others'];

/**
 * The conflict of a choice: a change of any slot the choice writes to (the
 * employee's membership there differs from the wanted one, before or now).
 * A slot the choice leaves alone does not matter.
 */
function dayConflict(before: Record<ShiftKind, SlotBase>, now: Record<ShiftKind, SlotBase>, choice: DayPlan): { kind: ConflictKind; shift: ShiftKind } | null {
  let found: { kind: ConflictKind; shift: ShiftKind } | null = null;
  for (const shift of SLOT_KINDS) {
    const target = roleIn(choice, shift);
    if (target === before[shift].role && target === now[shift].role) continue;
    const kind = conflictKind(before[shift], now[shift]);
    if (kind !== null && (found === null || CONFLICT_PRIORITY.indexOf(kind) < CONFLICT_PRIORITY.indexOf(found.kind))) {
      found = { kind, shift };
    }
  }
  return found;
}

/**
 * Moves the draft onto a newer server state ("Aktuellen Stand laden", or the
 * re-read after a save). No choice is lost silently: a choice the server
 * already shows is reported as reached; a choice whose slots changed stays and
 * needs an explicit "keep" or "take server state". A choice is a single shift
 * or Frei, so a rebase can never produce both shifts on a date.
 */
export function rebase(draft: EmployeeMonthDraft, fresh: MonthBase): { draft: EmployeeMonthDraft; report: RebaseReport } {
  if (fresh.employeeId.toLowerCase() !== draft.base.employeeId.toLowerCase() || fresh.month !== draft.base.month) {
    throw new Error('A draft can only move to a newer state of the same employee and month');
  }
  const choices = new Map<DateOnly, DayPlan>();
  const conflicts = new Map<DateOnly, DayConflict>();
  const report: RebaseReport = { reached: [], conflicts: [], changedElsewhere: [] };
  for (const date of draft.base.days) {
    const now = storedDay(fresh, date);
    if (!draft.choices.has(date)) {
      if (!sameDay(storedDay(draft.base, date), now)) report.changedElsewhere.push(date);
      continue;
    }
    const choice = draft.choices.get(date)!;
    if (sameDay(choice, now)) {
      report.reached.push(date);
      continue;
    }
    choices.set(date, choice);
    const before = daySlots(draft.base, date);
    const found = dayConflict(before, daySlots(fresh, date), choice);
    const open = draft.conflicts.get(date);
    if (found !== null) {
      // The first known state stays the reference while the conflict is open.
      conflicts.set(date, { ...found, before: open?.before ?? before[found.shift] });
      report.conflicts.push(date);
    } else if (open) {
      conflicts.set(date, open);
    }
  }
  return { draft: { base: fresh, choices, conflicts }, report };
}

/** Why the UI does not offer a change; a UX aid mirroring static rules, the server decides. */
export type ChangeRestriction =
  | 'PROJECT_INACTIVE'
  | 'CLOSED_DAY'
  | 'CALENDAR_MISSING'
  | 'UNKNOWN_PERSON'
  | 'NOT_ASSIGNED'
  | 'INACTIVE'
  | 'NOT_EMPLOYED'
  | 'NOT_ELIGIBLE_FOR_SHIFT'
  | 'NO_DUTY';

export const RESTRICTION_TEXT: Record<ChangeRestriction, string> = {
  PROJECT_INACTIVE: 'Projekt inaktiv: nur Frei möglich',
  CLOSED_DAY: 'Projekt an diesem Tag nicht in Betrieb',
  CALENDAR_MISSING: 'keine Betriebstage festgelegt: nur Frei möglich',
  UNKNOWN_PERSON: 'Person nicht mehr vorhanden: nur Frei möglich',
  NOT_ASSIGNED: 'im Monat nicht dem Projekt zugeordnet: nur Frei möglich',
  INACTIVE: 'Person deaktiviert: nur Frei möglich',
  NOT_EMPLOYED: 'an diesem Tag nicht beschäftigt',
  NOT_ELIGIBLE_FOR_SHIFT: 'nicht für diese Dienstart freigegeben',
  NO_DUTY: 'kein Dienst angelegt',
};

export type PlannerContext = {
  /** Null for a member who is no longer among the company's employees. */
  employee: Employee | null;
  /** Assigned to the plan's project for the plan month (A09). */
  assigned: boolean;
  projectActive: boolean;
  /**
   * Whether a choice may target a date/kind without a duty. Settled by the A2
   * contract (the save creates the canonical duty); the preview keeps the switch.
   */
  newDuties: boolean;
  /** Operating days: from the A2 read, or `unknown` in the preview. */
  calendar: ProjectCalendar;
};

/**
 * Restriction of a role in one slot that differs from the stored state.
 * Taking someone off a duty and returning to the stored role are always offered.
 */
export function changeRestriction(context: PlannerContext, slot: SlotBase, choice: Choice): ChangeRestriction | null {
  if (choice === null || choice === slot.role) return null;
  if (!context.projectActive) return 'PROJECT_INACTIVE';
  const blocked = calendarBlock(context.calendar, slot.date);
  if (blocked !== null) return blocked;
  if (context.employee === null) return 'UNKNOWN_PERSON';
  if (!context.assigned) return 'NOT_ASSIGNED';
  if (context.employee.status !== 'ACTIVE') return 'INACTIVE';
  if (!employedOn(context.employee, slot.date)) return 'NOT_EMPLOYED';
  if (!eligibleForShift(context.employee, slot.kind)) return 'NOT_ELIGIBLE_FOR_SHIFT';
  if (slot.dutyId === null && !context.newDuties) return 'NO_DUTY';
  return null;
}

/** Restriction of painting a date; FREI and a repeated mode are always offered. */
export function paintRestriction(context: PlannerContext, draft: EmployeeMonthDraft, date: DateOnly, mode: PaintMode): ChangeRestriction | null {
  const plan = paintedPlan(draft, date, mode);
  if (plan === null || sameDay(plan, wanted(draft, date))) return null;
  return changeRestriction(context, daySlots(draft.base, date)[plan.kind], plan.role);
}

/**
 * A refused save's finding for one date and shift: exactly the frozen A2
 * reason enum (`AtomicConflict.conflicts[].reason`). Texts stay neutral: no
 * absence reason, no lease holder, no other person (their problems are
 * PRESERVED_ROSTER_CONFLICT).
 */
export type DayIssueReason = EmployeeMonthConflictReason;

export type DayIssue = { date: DateOnly; kind: ShiftKind; reason: DayIssueReason };

export const DAY_ISSUE_TEXT: Record<DayIssueReason, string> = {
  PLAN_CONCURRENT_MODIFICATION: 'Inzwischen geändert. Laden Sie den aktuellen Stand.',
  ACTIVE_DUTY_EDIT: 'Dieser Dienst wird gerade bearbeitet. Speichern Sie später erneut.',
  PRESERVED_ROSTER_CONFLICT: 'Mit der übrigen Besetzung dieses Dienstes nicht möglich. Klären Sie den Dienst in der Ansicht „Alle Personen“.',
  PROJECT_INACTIVE: 'Das Projekt ist inaktiv.',
  PROJECT_CALENDAR_MISSING: 'Für das Projekt sind keine Betriebstage festgelegt.',
  PROJECT_CLOSED_WEEKDAY: 'Das Projekt ist an diesem Tag nicht in Betrieb.',
  SHIFT_CONFIGURATION_MISSING: 'Für diese Dienstart sind im Monat keine Schichtzeiten festgelegt.',
  DUTY_TIME_RANGE_INVALID: 'Die Schichtzeit lässt sich für diesen Tag nicht bilden.',
  EMPLOYEE_INACTIVE: 'Die Person ist deaktiviert.',
  EMPLOYEE_NOT_EMPLOYED_FOR_DAY: 'An diesem Tag nicht beschäftigt.',
  EMPLOYEE_NOT_ASSIGNED_TO_PROJECT_MONTH: 'Im Monat nicht diesem Projekt zugeordnet.',
  EMPLOYEE_NOT_ELIGIBLE_FOR_SHIFT: 'Nicht für diese Dienstart freigegeben.',
  EMPLOYEE_UNAVAILABLE: 'An diesem Tag nicht verfügbar.',
  EMPLOYEE_DAILY_SHIFT_CONFLICT: 'Pro Tag ist nur ein Dienst möglich (Tag oder Nacht).',
  DUTY_ASSIGNMENT_CONFLICT: 'Überschneidet sich zeitlich mit einem anderen Dienst dieser Person.',
};

/** Issues that still apply after the admin changed one date (that date's findings are outdated). */
export function issuesAfterEdit(issues: readonly DayIssue[], date: DateOnly): DayIssue[] {
  return issues.filter((issue) => issue.date !== date);
}

const ROLE = DUTY_ROLE_LABELS;
const KIND = SHIFT_TYPE_LABELS;
const KIND_GENITIVE: Record<ShiftKind, string> = { DAY: 'Tagdienstes', NIGHT: 'Nachtdienstes' };

/** A date's state in words, e.g. `Tagdienst (Schichtleitung)` or `Frei (nicht eingeplant)`. */
export function dayText(state: DayState): string {
  if (state === 'BOTH') return 'Tagdienst und Nachtdienst';
  if (state === null) return 'Frei (nicht eingeplant)';
  return `${KIND[state.kind]} (${ROLE[state.role]})`;
}

/** A wanted shift without a duty: the A2 save creates the canonical duty (P2). */
export const NEW_DUTY_TEXT = 'Dienst wird beim Speichern angelegt';

/** Whether the wanted shift of a date has no duty yet. */
export function withoutDuty(slots: Record<ShiftKind, SlotBase>, plan: DayState): boolean {
  return plan !== null && plan !== 'BOTH' && slots[plan.kind].dutyId === null;
}

/** Summary line of one change, e.g. `Nachtdienst (Mitarbeitende) statt Tagdienst (Mitarbeitende)`. */
export function changeText(change: Pick<DayChange, 'before' | 'after' | 'status' | 'slots'>): string {
  const { before, after } = change;
  const suffix = withoutDuty(change.slots, after) ? ` – ${NEW_DUTY_TEXT}` : '';
  switch (change.status) {
    case 'added':
      return `neu: ${dayText(after)}${suffix}`;
    case 'removed':
      return `Frei, bisher ${dayText(before)}`;
    case 'switched':
      return `${dayText(after)} statt ${dayText(before)}${suffix}`;
    case 'role-changed':
      return `${KIND[after!.kind]}: Funktion von ${ROLE[(before as Exclude<DayPlan, null>).role]} zu ${ROLE[after!.role]}`;
    case 'corrected':
      return `nur noch ${dayText(after)}; ${KIND[after!.kind === 'DAY' ? 'NIGHT' : 'DAY']} wird ausgetragen${suffix}`;
  }
}

/** State of one date in words (accessible description and day details). */
export function dayStateText(slots: Record<ShiftKind, SlotBase>, before: DayState, after: DayState): string {
  const parts: string[] = [];
  const status = dayStatus(before, after);
  if (status === 'unchanged') parts.push(after === 'BOTH' ? 'Tagdienst und Nachtdienst gespeichert, Korrektur nötig' : dayText(after));
  else parts.push(`${dayText(after)}, bisher ${dayText(before)}, noch nicht gespeichert`);
  if (withoutDuty(slots, after)) parts.push(NEW_DUTY_TEXT);
  if (SLOT_KINDS.some((kind) => slots[kind].unavailable)) parts.push('Hinweis: nicht verfügbar');
  return parts.join('; ');
}

/** What changed on the server under a choice, in words. */
export function conflictText(conflict: DayConflict, now: DayState): string {
  switch (conflict.kind) {
    case 'created':
      return `Der ${KIND[conflict.shift]} wurde inzwischen angelegt.`;
    case 'removed':
      return `Der ${KIND[conflict.shift]} wurde inzwischen gelöscht.`;
    case 'replaced':
      return `Der ${KIND[conflict.shift]} wurde inzwischen gelöscht und neu angelegt.`;
    case 'own':
      return `Inzwischen geändert: jetzt ${dayText(now)}.`;
    case 'others':
      return `Die Besetzung des ${KIND_GENITIVE[conflict.shift]} wurde inzwischen geändert.`;
  }
}

/** Monday-first weeks of the month; null pads the first and last week. */
export function calendarWeeks(days: readonly DateOnly[]): (DateOnly | null)[][] {
  const weeks: (DateOnly | null)[][] = [];
  let week: (DateOnly | null)[] = [];
  for (const date of days) {
    const weekday = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
    if (week.length === 0) week = Array.from({ length: weekday }, () => null);
    week.push(date);
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  if (week.length > 0) weeks.push([...week, ...Array.from({ length: 7 - week.length }, () => null)]);
  return weeks;
}

/** Why the month cannot be saved yet, from the draft alone (null = nothing in the draft blocks it). */
export type DraftBlock = 'NO_CHANGES' | 'CONFLICTS' | 'CORRECTIONS';

export function draftBlock(draft: EmployeeMonthDraft, calendar: ProjectCalendar): DraftBlock | null {
  if (draft.choices.size === 0) return 'NO_CHANGES';
  if (draft.conflicts.size > 0) return 'CONFLICTS';
  if (corrections(draft, calendar).length > 0) return 'CORRECTIONS';
  return null;
}
