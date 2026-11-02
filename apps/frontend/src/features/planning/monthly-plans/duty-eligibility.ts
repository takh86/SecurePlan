/**
 * Pre-selection of employees for a new duty. It mirrors only the static
 * staffing rules the server checks (SP-11 PR-1): the employee is ACTIVE, the
 * documented employment covers the duty date (a missing start is no evidence),
 * the employee is assigned to this project for the plan month, and the shift
 * eligibility allows the duty kind.
 *
 * This is a UX aid, not a business rule of its own: the server re-validates
 * every member under locks and alone decides absence (neutral
 * EMPLOYEE_UNAVAILABLE) and overlapping duties (DUTY_ASSIGNMENT_CONFLICT).
 * The planning UI deliberately reads no absence data, so it can never show
 * whether someone is sick or on leave.
 */
import type { Employee } from '../../employees/employee-types';
import type { ProjectAssignment } from '../../projects/project-assignments-api';
import type { ShiftKind } from '../../projects/shift-configuration-api';

/** Why an employee assigned to the project cannot be selected for this duty. */
export type IneligibilityReason = 'INACTIVE' | 'NOT_EMPLOYED' | 'NOT_ELIGIBLE_FOR_SHIFT';

export const INELIGIBILITY_TEXT: Record<IneligibilityReason, string> = {
  INACTIVE: 'deaktiviert',
  NOT_EMPLOYED: 'am Diensttag nicht beschäftigt',
  NOT_ELIGIBLE_FOR_SHIFT: 'nicht für diese Dienstart freigegeben',
};

export type DutyCandidates = {
  /** Selectable employees, sorted by name. */
  eligible: Employee[];
  /** Employees of this project and month that the static rules exclude, sorted by name. */
  ineligible: { employee: Employee; reason: IneligibilityReason }[];
};

const collator = new Intl.Collator('de-DE', { sensitivity: 'base' });

function byName(a: Employee, b: Employee): number {
  return collator.compare(a.lastName, b.lastName) || collator.compare(a.firstName, b.firstName) || a.id.localeCompare(b.id);
}

/** Inclusive on both ends; `YYYY-MM-DD` strings compare chronologically. */
export function employedOn(employee: Pick<Employee, 'employmentStart' | 'employmentEnd'>, date: string): boolean {
  return employee.employmentStart !== null && employee.employmentStart <= date
    && (employee.employmentEnd === null || employee.employmentEnd >= date);
}

export function eligibleForShift(employee: Pick<Employee, 'shiftEligibility'>, kind: ShiftKind): boolean {
  return employee.shiftEligibility === 'BOTH' || employee.shiftEligibility === kind;
}

/** First failing rule, in the server's precedence order; null when selectable. */
export function ineligibility(employee: Employee, dutyDate: string, kind: ShiftKind): IneligibilityReason | null {
  if (employee.status !== 'ACTIVE') return 'INACTIVE';
  if (!employedOn(employee, dutyDate)) return 'NOT_EMPLOYED';
  if (!eligibleForShift(employee, kind)) return 'NOT_ELIGIBLE_FOR_SHIFT';
  return null;
}

/**
 * Candidates among the employees assigned to `projectId` in the month starting
 * `monthStart`. Employees of other projects are not listed at all.
 */
export function dutyCandidates(
  employees: readonly Employee[],
  assignments: readonly ProjectAssignment[],
  projectId: string,
  monthStart: string,
  dutyDate: string,
  kind: ShiftKind,
): DutyCandidates {
  const assigned = new Set(
    assignments
      .filter((assignment) => assignment.monthStart === monthStart && assignment.projectId.toLowerCase() === projectId.toLowerCase())
      .map((assignment) => assignment.employeeId.toLowerCase()),
  );
  const eligible: Employee[] = [];
  const ineligible: DutyCandidates['ineligible'] = [];
  for (const employee of [...employees].sort(byName)) {
    if (!assigned.has(employee.id.toLowerCase())) continue;
    const reason = ineligibility(employee, dutyDate, kind);
    if (reason === null) eligible.push(employee);
    else ineligible.push({ employee, reason });
  }
  return { eligible, ineligible };
}
