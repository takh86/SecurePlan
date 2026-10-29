/** Explicit API <-> database mapping for project assignments. */
import type { ProjectAssignmentResponse } from './project-assignment.types.js';

export type ProjectAssignmentRow = {
  id: string;
  employee_id: string;
  project_id: string;
  month_start: string;
  /** bigint as node-pg delivers it: a decimal string, converted only by toAssignmentVersion. */
  version: string;
};

/**
 * #73 concurrency token (TL sign-off S-2 R2): `updated_at` in epoch
 * microseconds. EXTRACT returns numeric, so the value is exact; never use
 * float `date_part` or JS Date (milliseconds only). Strictly increasing per
 * row because every effective UPDATE applies PROJECT_ASSIGNMENT_TOUCH.
 */
export function assignmentVersionSql(updatedAt: string): string {
  return `(extract(epoch FROM ${updatedAt}) * 1000000)::bigint`;
}

/**
 * The only `updated_at` assignment an UPDATE of project_assignments may use:
 * at least 1 µs after the stored value, even under a frozen or backward clock.
 * A genuine no-op issues no UPDATE at all, so its version stays.
 */
export const PROJECT_ASSIGNMENT_TOUCH =
  "updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')";

/** Dates are rendered by PostgreSQL as YYYY-MM-DD; never via JS Date (time-zone shifts). */
export const PROJECT_ASSIGNMENT_COLUMNS = `
  id, employee_id, project_id,
  to_char(planning_month, 'YYYY-MM-DD') AS month_start,
  ${assignmentVersionSql('updated_at')} AS version`;

/** True for a strictly formatted calendar date that is the first day of its month. */
export function isMonthStart(date: string): boolean {
  return /^\d{4}-\d{2}-01$/.test(date);
}

/**
 * Strict conversion of the database version to the API number: a positive
 * decimal without leading zeros, a safe integer, and an exact round trip.
 * Anything else is a server defect (500); an unsafe value never leaves.
 */
export function toAssignmentVersion(value: unknown): number {
  if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)) {
    const version = Number(value);
    if (Number.isSafeInteger(version) && String(version) === value) return version;
  }
  throw new Error('Project assignment version is outside the supported range');
}

export function toProjectAssignmentResponse(row: ProjectAssignmentRow): ProjectAssignmentResponse {
  return {
    id: row.id,
    employeeId: row.employee_id,
    projectId: row.project_id,
    monthStart: row.month_start,
    version: toAssignmentVersion(row.version),
  };
}
