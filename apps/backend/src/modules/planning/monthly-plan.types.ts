/**
 * SP-11 API vocabulary (Phase 8.3 DTO design; first slice per SP11A-R1 T5).
 * The database stores TAG/NACHT and MITARBEITER/SCHICHTLEITER; see monthly-plan.mapper.ts.
 */
import type { ShiftKind } from '../workforce/shift-configurations/shift-configuration.types.js';

/** CR-03: UNPUBLISHED before the first publication, PUBLISHED afterwards; no draft copy. */
export const MonthlyPlanStatus = { UNPUBLISHED: 'UNPUBLISHED', PUBLISHED: 'PUBLISHED' } as const;
export type MonthlyPlanStatus = (typeof MonthlyPlanStatus)[keyof typeof MonthlyPlanStatus];

/** Duty-scoped function of one member; never an account role. */
export const DutyRole = { EMPLOYEE: 'EMPLOYEE', SHIFT_LEAD: 'SHIFT_LEAD' } as const;
export type DutyRole = (typeof DutyRole)[keyof typeof DutyRole];

export type AssignmentSource = 'NORMAL' | 'REPLACEMENT';

export type MonthlyPlanResponse = {
  id: string;
  projectId: string;
  /** First day of the planning month, YYYY-MM-01. */
  monthStart: string;
  status: MonthlyPlanStatus;
  /** Set once by the first publication. */
  publishedAt: string | null;
};

export type MonthlyPlanPage = {
  items: MonthlyPlanResponse[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
};

/** A current ACTIVE membership; removed memberships are history and never listed. */
export type DutyAssignmentResponse = {
  id: string;
  employeeId: string;
  dutyRole: DutyRole;
  source: AssignmentSource;
};

/**
 * E-04 (ratification C9): a member who is factually unavailable on the duty
 * date. Deliberately neutral: SICK and LEAVE look identical and no reason,
 * status or absence marker is ever exposed. COMPANY_ADMIN responses only.
 */
export type AvailabilityConflict = {
  code: 'EMPLOYEE_UNAVAILABLE';
  assignmentId: string;
  employeeId: string;
};

/** API term for the Duty aggregate (Phase 8.3): one duty with its current members. */
export type MonthlyPlanEntryResponse = {
  id: string;
  dutyDate: string;
  shiftKind: ShiftKind;
  /** Canonical UTC instants with second precision, resolved once at creation (D6). */
  startsAt: string;
  endsAt: string;
  /** Optimistic-concurrency token of the duty (Phase 8.7); a positive safe integer. */
  version: number;
  assignments: DutyAssignmentResponse[];
  availabilityConflicts: AvailabilityConflict[];
};

/** Phase 8.8: the entries of one plan are a bounded, unpaginated collection. */
export type MonthlyPlanEntryCollection = { items: MonthlyPlanEntryResponse[] };
