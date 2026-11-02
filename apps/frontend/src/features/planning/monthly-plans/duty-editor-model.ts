/**
 * Draft model of the SP-12 duty editor. The draft is always compared with the
 * server state it was opened on (`base`), so a PATCH sends only real changes
 * and the admin can always see what is still unsaved. Roster eligibility here
 * is a UX aid (see duty-eligibility.ts); the server re-validates the complete
 * resulting roster before every effective change.
 */
import { SHIFT_TYPE_LABELS } from '../../../shared/shift/shift-view';
import { formatDate, type DateOnly } from '../../../shared/time/month';
import { fullName, type Employee } from '../../employees/employee-types';
import type { ProjectAssignment } from '../../projects/project-assignments-api';
import type { ShiftKind } from '../../projects/shift-configuration-api';
import { INELIGIBILITY_TEXT, ineligibility } from './duty-eligibility';
import { DUTY_ROLE_LABELS, type Duty, type DutyAssignmentInput, type DutyRole, type UpdateDutyInput } from './monthly-plan-types';
import { UNKNOWN_PERSON } from './planning-matrix';

/** Draft roster keyed by lower-case employee id. */
export type RosterDraft = Readonly<Record<string, DutyAssignmentInput>>;
export type DutyDraft = { dutyDate: DateOnly; shiftKind: ShiftKind; roster: RosterDraft };

export function draftOf(duty: Duty): DutyDraft {
  const roster: Record<string, DutyAssignmentInput> = {};
  for (const member of duty.assignments) {
    roster[member.employeeId.toLowerCase()] = { employeeId: member.employeeId, dutyRole: member.dutyRole };
  }
  return { dutyDate: duty.dutyDate, shiftKind: duty.shiftKind, roster };
}

function sameRoster(duty: Duty, roster: RosterDraft): boolean {
  const keys = Object.keys(roster);
  return duty.assignments.length === keys.length
    && duty.assignments.every((member) => roster[member.employeeId.toLowerCase()]?.dutyRole === member.dutyRole);
}

/** True when `duty` shows exactly the drafted date, kind and roster (lost-response check). */
export function matchesDraft(duty: Duty, draft: DutyDraft): boolean {
  return duty.dutyDate === draft.dutyDate && duty.shiftKind === draft.shiftKind && sameRoster(duty, draft.roster);
}

/**
 * PATCH body with only the changed dimensions; `{}` when nothing changed.
 * The roster is sent complete: existing members first (stable order), then additions.
 */
export function dutyChanges(base: Duty, draft: DutyDraft): UpdateDutyInput {
  const changes: UpdateDutyInput = {};
  if (draft.dutyDate !== base.dutyDate) changes.dutyDate = draft.dutyDate;
  if (draft.shiftKind !== base.shiftKind) changes.shiftKind = draft.shiftKind;
  if (!sameRoster(base, draft.roster)) {
    const existing = base.assignments
      .map((member) => draft.roster[member.employeeId.toLowerCase()])
      .filter((member): member is DutyAssignmentInput => member !== undefined);
    const known = new Set(base.assignments.map((member) => member.employeeId.toLowerCase()));
    const added = Object.entries(draft.roster).filter(([key]) => !known.has(key)).map(([, member]) => member);
    changes.assignments = [...existing, ...added].map(({ employeeId, dutyRole }) => ({ employeeId, dutyRole }));
  }
  return changes;
}

export function hasChanges(changes: UpdateDutyInput): boolean {
  return changes.dutyDate !== undefined || changes.shiftKind !== undefined || changes.assignments !== undefined;
}

/** Human-readable list of what the draft would change (shown before saving, on conflicts and before discarding). */
export function describeChanges(base: Duty, draft: DutyDraft, nameOf: (employeeId: string) => string): string[] {
  const lines: string[] = [];
  if (draft.dutyDate !== base.dutyDate) lines.push(`Datum: ${formatDate(base.dutyDate)} → ${formatDate(draft.dutyDate)}`);
  if (draft.shiftKind !== base.shiftKind) {
    lines.push(`Dienstart: ${SHIFT_TYPE_LABELS[base.shiftKind]} → ${SHIFT_TYPE_LABELS[draft.shiftKind]}`);
  }
  const before = new Map(base.assignments.map((member) => [member.employeeId.toLowerCase(), member]));
  for (const [key, member] of Object.entries(draft.roster)) {
    const old = before.get(key);
    if (!old) {
      const role = member.dutyRole === 'SHIFT_LEAD' ? ` (${DUTY_ROLE_LABELS.SHIFT_LEAD})` : '';
      lines.push(`Eingeplant: ${nameOf(member.employeeId)}${role}`);
    } else if (old.dutyRole !== member.dutyRole) {
      lines.push(`Funktion: ${nameOf(member.employeeId)} → ${DUTY_ROLE_LABELS[member.dutyRole]}`);
    }
  }
  for (const [key, old] of before) {
    if (!draft.roster[key]) lines.push(`Ausgetragen: ${nameOf(old.employeeId)}`);
  }
  return lines;
}

/** Why a person cannot (or should not stay) in this duty, by the static rules; null when fine. */
export type RosterReason = 'INACTIVE' | 'NOT_EMPLOYED' | 'NOT_ELIGIBLE_FOR_SHIFT' | 'NOT_ASSIGNED' | 'UNKNOWN';

export const ROSTER_REASON_TEXT: Record<RosterReason, string> = {
  ...INELIGIBILITY_TEXT,
  NOT_ASSIGNED: 'im Planmonat nicht diesem Projekt zugeordnet',
  UNKNOWN: 'nicht mehr in der Mitarbeiterliste',
};

export type RosterOption = {
  key: string;
  employeeId: string;
  name: string;
  code: string | null;
  /** In the draft roster. */
  selected: boolean;
  /** In the duty as opened. */
  stored: boolean;
  role: DutyRole;
  /** Static rule this person fails for the drafted date and kind. */
  reason: RosterReason | null;
  /** Reported unavailable on the stored duty date (neutral; only while the date is unchanged). */
  unavailable: boolean;
  /** May be ticked: eligible, or already in the duty as opened (restoring is allowed). */
  selectable: boolean;
  /** The person whose matrix cell opened the editor. */
  focus: boolean;
};

export type RosterView = {
  /** Draft and stored members plus all selectable persons; the focused person first, then by name. */
  options: RosterOption[];
  /** Assigned persons that the static rules exclude for this date and kind (not members). */
  excluded: { key: string; name: string; reason: RosterReason }[];
};

const collator = new Intl.Collator('de-DE', { sensitivity: 'base' });

export function rosterView(
  base: Duty,
  draft: DutyDraft,
  employees: readonly Employee[],
  assignments: readonly ProjectAssignment[],
  projectId: string,
  monthStart: string,
  focusEmployeeId: string | null,
): RosterView {
  const byId = new Map(employees.map((employee) => [employee.id.toLowerCase(), employee]));
  const assigned = new Set(
    assignments
      .filter((item) => item.monthStart === monthStart && item.projectId.toLowerCase() === projectId.toLowerCase())
      .map((item) => item.employeeId.toLowerCase()),
  );
  const stored = new Map(base.assignments.map((member) => [member.employeeId.toLowerCase(), member]));
  const unavailable = new Set(
    draft.dutyDate === base.dutyDate ? base.availabilityConflicts.map((conflict) => conflict.employeeId.toLowerCase()) : [],
  );
  const focusKey = focusEmployeeId?.toLowerCase() ?? null;
  const keys = new Set([...assigned, ...stored.keys(), ...Object.keys(draft.roster)]);
  if (focusKey) keys.add(focusKey);

  const options: RosterOption[] = [];
  const excluded: RosterView['excluded'] = [];
  for (const key of keys) {
    const employee = byId.get(key) ?? null;
    const reason: RosterReason | null = employee === null
      ? 'UNKNOWN'
      : ineligibility(employee, draft.dutyDate, draft.shiftKind) ?? (assigned.has(key) ? null : 'NOT_ASSIGNED');
    const selected = draft.roster[key] !== undefined;
    const isStored = stored.has(key);
    const option: RosterOption = {
      key,
      employeeId: employee?.id ?? stored.get(key)?.employeeId ?? draft.roster[key]?.employeeId ?? key,
      name: employee ? fullName(employee) : UNKNOWN_PERSON,
      code: employee?.employeeCode ?? null,
      selected,
      stored: isStored,
      role: draft.roster[key]?.dutyRole ?? stored.get(key)?.dutyRole ?? 'EMPLOYEE',
      reason,
      unavailable: unavailable.has(key),
      selectable: reason === null || isStored,
      focus: key === focusKey,
    };
    // Excluded assigned persons are only listed separately unless they are (or were) members or in focus.
    if (reason !== null && !selected && !isStored && !option.focus) {
      if (reason !== 'NOT_ASSIGNED' && reason !== 'UNKNOWN') excluded.push({ key, name: option.name, reason });
      continue;
    }
    options.push(option);
  }
  const byName = (a: { name: string; key: string }, b: { name: string; key: string }) => {
    const left = byId.get(a.key);
    const right = byId.get(b.key);
    if (left && right) {
      return collator.compare(left.lastName, right.lastName) || collator.compare(left.firstName, right.firstName) || a.key.localeCompare(b.key);
    }
    return left ? -1 : right ? 1 : a.key.localeCompare(b.key);
  };
  options.sort((a, b) => (a.focus === b.focus ? byName(a, b) : a.focus ? -1 : 1));
  excluded.sort(byName);
  return { options, excluded };
}
