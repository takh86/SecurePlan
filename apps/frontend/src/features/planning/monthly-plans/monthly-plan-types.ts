import type { ShiftKind } from '../../projects/shift-configuration-api';
import type { StatusTone } from '../../../shared/ui/StatusBadge';

/**
 * Planning resources exactly as returned by `/api/v1/monthly-plans`: SP-11
 * create/read plus the SP-12 single-duty read, edit (PATCH), removal (DELETE)
 * and edit leases (ADR-0006), and the SP-13 First Publish answer (a plan).
 */
export type MonthlyPlanStatus = 'UNPUBLISHED' | 'PUBLISHED';

/** Duty-scoped function of one member; never an account role. */
export type DutyRole = 'EMPLOYEE' | 'SHIFT_LEAD';

export type AssignmentSource = 'NORMAL' | 'REPLACEMENT';

export type MonthlyPlan = {
  id: string;
  projectId: string;
  /** First day of the planning month, `YYYY-MM-01`. */
  monthStart: string;
  status: MonthlyPlanStatus;
  /** Canonical UTC instant of the first publication, or null. */
  publishedAt: string | null;
};

export type MonthlyPlanPage = {
  items: MonthlyPlan[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
};

/** A current ACTIVE membership of one duty. */
export type DutyAssignment = {
  id: string;
  employeeId: string;
  dutyRole: DutyRole;
  source: AssignmentSource;
};

/**
 * E-04: a member who is factually unavailable on the duty date. Deliberately
 * neutral: the API never says why (no sickness or leave marker).
 */
export type AvailabilityConflict = {
  code: 'EMPLOYEE_UNAVAILABLE';
  assignmentId: string;
  employeeId: string;
};

/** API term "MonthlyPlanEntry": one duty with its current members. */
export type Duty = {
  id: string;
  dutyDate: string;
  shiftKind: ShiftKind;
  /** Canonical UTC instants (second precision), resolved by the server at creation. */
  startsAt: string;
  endsAt: string;
  /** Optimistic-concurrency token: every edit and removal sends it as `Expected-Version`. */
  version: number;
  assignments: DutyAssignment[];
  availabilityConflicts: AvailabilityConflict[];
};

export type DutyAssignmentInput = { employeeId: string; dutyRole: DutyRole };

export type CreateDutyInput = {
  dutyDate: string;
  shiftKind: ShiftKind;
  assignments: DutyAssignmentInput[];
};

/**
 * SP-12 PATCH body: only the changed dimensions. `assignments` is the complete
 * resulting roster (members not listed are removed), never a delta.
 */
export type UpdateDutyInput = {
  dutyDate?: string;
  shiftKind?: ShiftKind;
  assignments?: DutyAssignmentInput[];
};

/**
 * ADR-0006 edit lease as granted to the holder. `expiresAt` is the server's
 * instant (microseconds preserved); the token stays in memory only.
 */
export type EditLeaseGrant = { leaseToken: string; expiresAt: string };

export const PLAN_STATUS: Record<MonthlyPlanStatus, { label: string; tone: StatusTone }> = {
  UNPUBLISHED: { label: 'Unveröffentlicht', tone: 'info' },
  PUBLISHED: { label: 'Veröffentlicht', tone: 'success' },
};

export const DUTY_ROLE_LABELS: Record<DutyRole, string> = {
  EMPLOYEE: 'Mitarbeitende',
  SHIFT_LEAD: 'Schichtleitung',
};

/** Fixed display order of the duty roles in selects. */
export const DUTY_ROLES: readonly DutyRole[] = ['EMPLOYEE', 'SHIFT_LEAD'];

/** Navigation state the new plan page reads once to confirm the creation. */
export const PLAN_CREATED_STATE = { notice: 'plan-created' } as const;
