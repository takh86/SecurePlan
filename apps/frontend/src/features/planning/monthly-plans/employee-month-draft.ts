/**
 * Issue #88 (Product Owner decision 2026-11-02; design gate OPEN): pure draft
 * state of the employee-month workflow. One employee, every day of the plan
 * month, one DAY and one NIGHT slot per day. The draft records what the admin
 * wants on top of the server state it was built on. It never writes anything,
 * and it defines no HTTP contract: `EmployeeMonthCommand` is only a frontend
 * seam that an adapter for the approved #88 contract will translate.
 *
 * Deliberately neutral:
 * - "nicht eingeplant" is only the absence of a membership, never an absence
 *   record (sickness, leave) of the employee;
 * - DAY and NIGHT of one date are independent slots; time overlap and every
 *   other staffing rule stay with the server;
 * - other members of a duty are context only and never part of a change;
 * - the duty role (Mitarbeitende/Schichtleitung) belongs to one membership;
 *   no limit on shift leads is assumed.
 */
import { SHIFT_TYPE_LABELS } from '../../../shared/shift/shift-view';
import type { DateOnly, MonthKey } from '../../../shared/time/month';
import type { Employee } from '../../employees/employee-types';
import type { ShiftKind } from '../../projects/shift-configuration-api';
import { eligibleForShift, employedOn } from './duty-eligibility';
import { DUTY_ROLE_LABELS, type Duty, type DutyRole } from './monthly-plan-types';
import { matrixDays } from './planning-matrix';

/** Fixed slot order within a day. */
export const SLOT_KINDS: readonly ShiftKind[] = ['DAY', 'NIGHT'];

/** `YYYY-MM-DD|DAY` – one slot of the month. */
export type SlotKey = string;

export function slotKey(date: DateOnly, kind: ShiftKind): SlotKey {
  return `${date}|${kind}`;
}

/** The employee's role in a slot; null = not planned (no membership). */
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
  /** Neutral E-04 hint on the employee's membership (never a reason). */
  unavailable: boolean;
  /** Every other current member; a change of this employee preserves them. */
  others: readonly OtherMember[];
};

export type MonthBase = {
  employeeId: string;
  month: MonthKey;
  /** Every calendar day of the month, in order. */
  days: readonly DateOnly[];
  slots: ReadonlyMap<SlotKey, SlotBase>;
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

/** Why a slot with a choice needs a new decision after the server state changed under it. */
export type ConflictKind = 'own' | 'created' | 'removed' | 'replaced' | 'others';

export type SlotConflict = { kind: ConflictKind; before: SlotBase };

export type EmployeeMonthDraft = {
  base: MonthBase;
  /** Only slots whose wanted role differs from the base. */
  choices: ReadonlyMap<SlotKey, Choice>;
  /** Choices whose slot changed on the server since they were made; saving waits for a decision. */
  conflicts: ReadonlyMap<SlotKey, SlotConflict>;
};

export function emptyDraft(base: MonthBase): EmployeeMonthDraft {
  return { base, choices: new Map(), conflicts: new Map() };
}

export function slotOf(draft: Pick<EmployeeMonthDraft, 'base'>, key: SlotKey): SlotBase {
  const slot = draft.base.slots.get(key);
  if (!slot) throw new Error(`Unknown slot ${key}`);
  return slot;
}

/** The role the admin wants in a slot (the server's role when unchanged). */
export function desired(draft: EmployeeMonthDraft, key: SlotKey): Choice {
  return draft.choices.has(key) ? draft.choices.get(key)! : slotOf(draft, key).role;
}

/** Sets the wanted role; a choice equal to the server state is no change. An explicit choice settles a conflict. */
export function setChoice(draft: EmployeeMonthDraft, key: SlotKey, choice: Choice): EmployeeMonthDraft {
  const slot = slotOf(draft, key);
  const choices = new Map(draft.choices);
  if (choice === slot.role) choices.delete(key);
  else choices.set(key, choice);
  const conflicts = new Map(draft.conflicts);
  conflicts.delete(key);
  return { ...draft, choices, conflicts };
}

/** The choice a toggle leads to: planned → not planned; not planned → the server's role, else Mitarbeitende. */
export function toggledChoice(draft: EmployeeMonthDraft, key: SlotKey): Choice {
  return desired(draft, key) !== null ? null : slotOf(draft, key).role ?? 'EMPLOYEE';
}

/** Back to the server state of one slot ("Serverstand übernehmen" for a conflict). */
export function revertSlot(draft: EmployeeMonthDraft, key: SlotKey): EmployeeMonthDraft {
  return setChoice(draft, key, slotOf(draft, key).role);
}

/** Keeps the admin's choice on top of the newer server state. */
export function keepChoice(draft: EmployeeMonthDraft, key: SlotKey): EmployeeMonthDraft {
  if (!draft.conflicts.has(key)) return draft;
  const conflicts = new Map(draft.conflicts);
  conflicts.delete(key);
  return { ...draft, conflicts };
}

export type SlotStatus = 'unchanged' | 'added' | 'removed' | 'role-changed';

export function statusOf(before: Choice, after: Choice): SlotStatus {
  if (before === after) return 'unchanged';
  if (before === null) return 'added';
  if (after === null) return 'removed';
  return 'role-changed';
}

export type SlotChange = {
  key: SlotKey;
  slot: SlotBase;
  after: Choice;
  status: Exclude<SlotStatus, 'unchanged'>;
  conflict: SlotConflict | null;
};

/** Every pending change in calendar order, DAY before NIGHT. */
export function pendingChanges(draft: EmployeeMonthDraft): SlotChange[] {
  const changes: SlotChange[] = [];
  for (const date of draft.base.days) {
    for (const kind of SLOT_KINDS) {
      const key = slotKey(date, kind);
      if (!draft.choices.has(key)) continue;
      const slot = slotOf(draft, key);
      const after = draft.choices.get(key)!;
      changes.push({ key, slot, after, status: statusOf(slot.role, after) as SlotChange['status'], conflict: draft.conflicts.get(key) ?? null });
    }
  }
  return changes;
}

export type RebaseReport = {
  /** Choices the newer server state already shows; they are no longer pending. */
  reached: SlotKey[];
  /** Choices whose slot changed under them; they stay, marked for a decision. */
  conflicts: SlotKey[];
  /** Slots without a choice whose role for this employee changed on the server. */
  changedElsewhere: SlotKey[];
};

function conflictKind(before: SlotBase, now: SlotBase): ConflictKind | null {
  if (before.dutyId === null && now.dutyId !== null) return 'created';
  if (before.dutyId !== null && now.dutyId === null) return 'removed';
  if (before.dutyId !== null && now.dutyId !== null && before.dutyId.toLowerCase() !== now.dutyId.toLowerCase()) return 'replaced';
  if (before.role !== now.role) return 'own';
  if (before.version !== now.version) return 'others';
  return null;
}

/**
 * Moves the draft onto a newer server state ("Aktuellen Stand laden", or the
 * re-read after a save). No choice is lost silently: a choice the server
 * already shows is reported as reached; a choice whose slot changed in any way
 * stays and needs an explicit "keep" or "take server state".
 */
export function rebase(draft: EmployeeMonthDraft, fresh: MonthBase): { draft: EmployeeMonthDraft; report: RebaseReport } {
  if (fresh.employeeId.toLowerCase() !== draft.base.employeeId.toLowerCase() || fresh.month !== draft.base.month) {
    throw new Error('A draft can only move to a newer state of the same employee and month');
  }
  const choices = new Map<SlotKey, Choice>();
  const conflicts = new Map<SlotKey, SlotConflict>();
  const report: RebaseReport = { reached: [], conflicts: [], changedElsewhere: [] };
  for (const [key, before] of draft.base.slots) {
    const now = fresh.slots.get(key)!;
    if (!draft.choices.has(key)) {
      if (before.role !== now.role) report.changedElsewhere.push(key);
      continue;
    }
    const choice = draft.choices.get(key)!;
    if (choice === now.role) {
      report.reached.push(key);
      continue;
    }
    choices.set(key, choice);
    const kind = conflictKind(before, now);
    const open = draft.conflicts.get(key);
    if (kind !== null) {
      // The first known state stays the reference while the conflict is open.
      conflicts.set(key, { kind, before: open?.before ?? before });
      report.conflicts.push(key);
    } else if (open) {
      conflicts.set(key, open);
    }
  }
  return { draft: { base: fresh, choices, conflicts }, report };
}

/** Why the UI does not offer a change; a UX aid mirroring static rules, the server decides. */
export type ChangeRestriction =
  | 'PROJECT_INACTIVE'
  | 'UNKNOWN_PERSON'
  | 'NOT_ASSIGNED'
  | 'INACTIVE'
  | 'NOT_EMPLOYED'
  | 'NOT_ELIGIBLE_FOR_SHIFT'
  | 'NO_DUTY';

export const RESTRICTION_TEXT: Record<ChangeRestriction, string> = {
  PROJECT_INACTIVE: 'Projekt inaktiv: nur Austragen möglich',
  UNKNOWN_PERSON: 'Person nicht mehr vorhanden: nur Austragen möglich',
  NOT_ASSIGNED: 'im Monat nicht dem Projekt zugeordnet: nur Austragen möglich',
  INACTIVE: 'Person deaktiviert: nur Austragen möglich',
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
  /** Whether a choice may target a date/kind without a duty (open #88 decision). */
  newDuties: boolean;
};

/**
 * Restriction of a choice that differs from the server state. Taking someone
 * off a duty and returning to the server state are always offered.
 */
export function changeRestriction(context: PlannerContext, slot: SlotBase, choice: Choice): ChangeRestriction | null {
  if (choice === null || choice === slot.role) return null;
  if (!context.projectActive) return 'PROJECT_INACTIVE';
  if (context.employee === null) return 'UNKNOWN_PERSON';
  if (!context.assigned) return 'NOT_ASSIGNED';
  if (context.employee.status !== 'ACTIVE') return 'INACTIVE';
  if (!employedOn(context.employee, slot.date)) return 'NOT_EMPLOYED';
  if (!eligibleForShift(context.employee, slot.kind)) return 'NOT_ELIGIBLE_FOR_SHIFT';
  if (slot.dutyId === null && !context.newDuties) return 'NO_DUTY';
  return null;
}

/**
 * A rejected save's finding for one date (and kind, if known). Frontend
 * categories named after the existing staffing codes; the #88 contract decides
 * how the server reports them. Texts stay neutral (no absence reason).
 */
export type DayIssueReason =
  | 'EMPLOYEE_UNAVAILABLE'
  | 'DUTY_ASSIGNMENT_CONFLICT'
  | 'EMPLOYEE_NOT_ELIGIBLE_FOR_SHIFT'
  | 'EMPLOYEE_NOT_EMPLOYED_FOR_DAY'
  | 'CHANGED_ON_SERVER'
  | 'REJECTED';

export type DayIssue = { date: DateOnly; kind: ShiftKind | null; reason: DayIssueReason };

export const DAY_ISSUE_TEXT: Record<DayIssueReason, string> = {
  EMPLOYEE_UNAVAILABLE: 'An diesem Tag nicht verfügbar.',
  DUTY_ASSIGNMENT_CONFLICT: 'Überschneidet sich zeitlich mit einem anderen Dienst dieser Person.',
  EMPLOYEE_NOT_ELIGIBLE_FOR_SHIFT: 'Nicht für diese Dienstart freigegeben.',
  EMPLOYEE_NOT_EMPLOYED_FOR_DAY: 'An diesem Tag nicht beschäftigt.',
  CHANGED_ON_SERVER: 'Inzwischen geändert. Laden Sie den aktuellen Stand.',
  REJECTED: 'Diese Auswahl wurde nicht angenommen.',
};

/** Issues that still apply after the admin changed one slot (an edited slot's finding is outdated). */
export function issuesAfterEdit(issues: readonly DayIssue[], date: DateOnly, kind: ShiftKind): DayIssue[] {
  return issues.filter((issue) => issue.date !== date || (issue.kind !== null && issue.kind !== kind));
}

const ROLE = DUTY_ROLE_LABELS;

/** Summary line of one change, e.g. `Tagdienst: neu eingeplant als Schichtleitung`. */
export function changeText(change: Pick<SlotChange, 'slot' | 'after' | 'status'>): string {
  const kind = SHIFT_TYPE_LABELS[change.slot.kind];
  switch (change.status) {
    case 'added':
      return `${kind}: neu eingeplant als ${ROLE[change.after!]}${change.slot.dutyId === null ? ' (Dienst noch nicht angelegt)' : ''}`;
    case 'removed':
      return `${kind}: ausgetragen (bisher ${ROLE[change.slot.role!]})`;
    case 'role-changed':
      return `${kind}: Funktion geändert von ${ROLE[change.slot.role!]} zu ${ROLE[change.after!]}`;
  }
}

/** State of one slot in words (accessible description and day details). */
export function slotStateText(slot: SlotBase, after: Choice): string {
  const parts: string[] = [];
  switch (statusOf(slot.role, after)) {
    case 'unchanged':
      parts.push(after === null ? 'nicht eingeplant' : `eingeplant als ${ROLE[after]}`);
      break;
    case 'added':
      parts.push(`neu eingeplant als ${ROLE[after!]}, noch nicht gespeichert`);
      break;
    case 'removed':
      parts.push(`wird ausgetragen, bisher ${ROLE[slot.role!]}, noch nicht gespeichert`);
      break;
    case 'role-changed':
      parts.push(`Funktion geändert zu ${ROLE[after!]}, bisher ${ROLE[slot.role!]}, noch nicht gespeichert`);
      break;
  }
  if (slot.dutyId === null) parts.push('Dienst noch nicht angelegt');
  if (slot.unavailable) parts.push('Hinweis: nicht verfügbar');
  return parts.join('; ');
}

/** What changed on the server under a choice, in words. */
export function conflictText(conflict: SlotConflict, now: SlotBase): string {
  switch (conflict.kind) {
    case 'created':
      return 'Der Dienst wurde inzwischen angelegt.';
    case 'removed':
      return 'Der Dienst wurde inzwischen gelöscht.';
    case 'replaced':
      return 'Der Dienst wurde inzwischen gelöscht und neu angelegt.';
    case 'own':
      return `Inzwischen geändert: jetzt ${now.role === null ? 'nicht eingeplant' : `eingeplant als ${ROLE[now.role]}`}.`;
    case 'others':
      return 'Die Besetzung dieses Dienstes wurde inzwischen geändert.';
  }
}

/**
 * Frontend seam for the future atomic save (#88). It lists every changed slot
 * with the server state it was based on, so an adapter can build either a
 * desired-state or a delta request. It is NOT an approved API shape.
 */
export type EmployeeMonthChange = {
  date: DateOnly;
  kind: ShiftKind;
  dutyId: string | null;
  /** The duty version the choice was based on (null while no duty exists). */
  basedOnVersion: number | null;
  from: Choice;
  to: Choice;
};

export type EmployeeMonthCommand = {
  planId: string;
  employeeId: string;
  month: MonthKey;
  changes: readonly EmployeeMonthChange[];
};

/** The command for one save, or null when nothing is pending or a conflict is undecided. */
export function monthCommand(draft: EmployeeMonthDraft, planId: string): EmployeeMonthCommand | null {
  if (draft.choices.size === 0 || draft.conflicts.size > 0) return null;
  return {
    planId,
    employeeId: draft.base.employeeId,
    month: draft.base.month,
    changes: pendingChanges(draft).map(({ slot, after }) => ({
      date: slot.date,
      kind: slot.kind,
      dutyId: slot.dutyId,
      basedOnVersion: slot.version,
      from: slot.role,
      to: after,
    })),
  };
}

/**
 * Outcome of one atomic save attempt as the editor needs it. `rejected`
 * guarantees that nothing was saved; `unknown` (lost or unreadable answer)
 * guarantees nothing and requires a re-read before another attempt.
 */
export type EmployeeMonthSaveOutcome =
  | { kind: 'saved' }
  | { kind: 'rejected'; issues: readonly DayIssue[] }
  | { kind: 'unknown' };

/** Port to the future #88 adapter; the production route provides none yet. */
export type EmployeeMonthSave = (command: EmployeeMonthCommand) => Promise<EmployeeMonthSaveOutcome>;
