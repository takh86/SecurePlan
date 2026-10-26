/**
 * Explicit API <-> database mapping for projects.
 * API v1 status: ACTIVE/INACTIVE. DB additionally allows ARCHIVED (physical
 * design), which no API v1 path writes; reading it is a server defect and
 * fails closed (500), like any other unknown stored value.
 */
import type { ProjectResponse, ProjectSortField, ProjectStatus } from './project.types.js';

export type ProjectRow = {
  id: string;
  name: string;
  status: string;
};

export const PROJECT_COLUMNS = 'id, name, status';

/** Whitelisted ORDER BY columns; client input never reaches SQL text. */
export const PROJECT_SORT_COLUMNS: Record<ProjectSortField, string> = {
  name: 'name',
  status: 'status',
};

const API_STATUSES: readonly string[] = ['ACTIVE', 'INACTIVE'] satisfies ProjectStatus[];

export function projectStatusFromDb(value: string): ProjectStatus {
  if (!API_STATUSES.includes(value)) throw new Error('Unexpected project status in database');
  return value as ProjectStatus;
}

export function toProjectResponse(row: ProjectRow): ProjectResponse {
  return { id: row.id, name: row.name, status: projectStatusFromDb(row.status) };
}
