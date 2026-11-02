/**
 * Explicit API <-> database mapping for monthly plans and duties (SP11A-R1 T2 B7).
 * API: DAY/NIGHT, EMPLOYEE/SHIFT_LEAD. DB: TAG/NACHT, MITARBEITER/SCHICHTLEITER.
 * Dates and instants are rendered by PostgreSQL, never via JS Date parsing.
 * An unknown stored value is a server defect and fails closed (500).
 */
import { shiftKindFromDb } from '../workforce/shift-configurations/shift-configuration.mapper.js';
import type {
  AssignmentSource,
  AvailabilityConflict,
  DutyAssignmentResponse,
  DutyRole,
  MonthlyPlanEntryResponse,
  MonthlyPlanResponse,
  MonthlyPlanStatus,
} from './monthly-plan.types.js';

export type MonthlyPlanRow = {
  id: string;
  project_id: string;
  month_start: string;
  status: string;
  published_at: string | null;
};

/** `alias` is a fixed identifier, never input. */
export function monthlyPlanColumns(alias: string): string {
  return `${alias}.id, ${alias}.project_id,
    to_char(${alias}.planning_month, 'YYYY-MM-DD') AS month_start,
    ${alias}.status,
    to_char(${alias}.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS published_at`;
}

export type DutyRow = {
  id: string;
  duty_date: string;
  shift_kind: string;
  starts_at: string;
  ends_at: string;
  version: string;
};

export function dutyColumns(alias: string): string {
  return `${alias}.id, to_char(${alias}.duty_date, 'YYYY-MM-DD') AS duty_date, ${alias}.shift_kind,
    to_char(${alias}.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
    to_char(${alias}.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at,
    ${alias}.concurrency_version::text AS version`;
}

/** Deterministic API order DAY before NIGHT (the stored words sort the other way). */
export function dutyOrder(alias: string): string {
  return `${alias}.duty_date ASC, CASE ${alias}.shift_kind WHEN 'TAG' THEN 0 ELSE 1 END ASC, ${alias}.id ASC`;
}

export type MembershipRow = {
  id: string;
  duty_id: string;
  employee_id: string;
  duty_function: string;
  source: string;
};

const STATUSES: readonly string[] = ['UNPUBLISHED', 'PUBLISHED'];
const ROLE_TO_DB: Record<DutyRole, string> = { EMPLOYEE: 'MITARBEITER', SHIFT_LEAD: 'SCHICHTLEITER' };
const ROLE_FROM_DB = new Map(Object.entries(ROLE_TO_DB).map(([api, db]) => [db, api as DutyRole]));
const SOURCES: readonly string[] = ['NORMAL', 'REPLACEMENT'];

export function dutyRoleToDb(role: DutyRole): string {
  return ROLE_TO_DB[role];
}

function dutyRoleFromDb(value: string): DutyRole {
  const role = ROLE_FROM_DB.get(value);
  if (role === undefined) throw new Error('Unexpected duty function in database');
  return role;
}

/** Strict: a positive decimal without leading zeros that round-trips as a safe integer. */
export function toDutyVersion(value: string): number {
  const version = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(version) || String(version) !== value) {
    throw new Error('Unexpected duty version in database');
  }
  return version;
}

export function toMonthlyPlanResponse(row: MonthlyPlanRow): MonthlyPlanResponse {
  if (!STATUSES.includes(row.status)) throw new Error('Unexpected monthly plan status in database');
  return {
    id: row.id,
    projectId: row.project_id,
    monthStart: row.month_start,
    status: row.status as MonthlyPlanStatus,
    publishedAt: row.published_at,
  };
}

export function toDutyAssignmentResponse(row: MembershipRow): DutyAssignmentResponse {
  if (!SOURCES.includes(row.source)) throw new Error('Unexpected assignment source in database');
  return {
    id: row.id,
    employeeId: row.employee_id,
    dutyRole: dutyRoleFromDb(row.duty_function),
    source: row.source as AssignmentSource,
  };
}

/** Members ordered by employee, then membership id (stable across reads). */
export function toMonthlyPlanEntryResponse(
  duty: DutyRow,
  members: readonly MembershipRow[],
  unavailable: ReadonlySet<string>,
): MonthlyPlanEntryResponse {
  const ordered = [...members].sort((a, b) =>
    a.employee_id === b.employee_id ? a.id.localeCompare(b.id) : a.employee_id.localeCompare(b.employee_id));
  const availabilityConflicts: AvailabilityConflict[] = ordered
    .filter((member) => unavailable.has(availabilityKey(member.employee_id, duty.duty_date)))
    .map((member) => ({ code: 'EMPLOYEE_UNAVAILABLE', assignmentId: member.id, employeeId: member.employee_id }));
  return {
    id: duty.id,
    dutyDate: duty.duty_date,
    shiftKind: shiftKindFromDb(duty.shift_kind),
    startsAt: duty.starts_at,
    endsAt: duty.ends_at,
    version: toDutyVersion(duty.version),
    assignments: ordered.map(toDutyAssignmentResponse),
    availabilityConflicts,
  };
}

/** Key of one employee/day absence fact as returned by the Workforce neutral read. */
export function availabilityKey(employeeId: string, day: string): string {
  return `${employeeId}|${day}`;
}
