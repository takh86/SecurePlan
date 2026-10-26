/** Explicit API <-> database mapping for project assignments. */
import type { ProjectAssignmentResponse } from './project-assignment.types.js';

export type ProjectAssignmentRow = {
  id: string;
  employee_id: string;
  project_id: string;
  month_start: string;
};

/** Dates are rendered by PostgreSQL as YYYY-MM-DD; never via JS Date (time-zone shifts). */
export const PROJECT_ASSIGNMENT_COLUMNS = `
  id, employee_id, project_id,
  to_char(planning_month, 'YYYY-MM-DD') AS month_start`;

/** True for a strictly formatted calendar date that is the first day of its month. */
export function isMonthStart(date: string): boolean {
  return /^\d{4}-\d{2}-01$/.test(date);
}

export function toProjectAssignmentResponse(row: ProjectAssignmentRow): ProjectAssignmentResponse {
  return {
    id: row.id,
    employeeId: row.employee_id,
    projectId: row.project_id,
    monthStart: row.month_start,
  };
}
