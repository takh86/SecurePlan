/**
 * SP-09 month-assignment API client (create/read). Uses only the endpoints the
 * backend provides; tenant and role are never sent. Responses are shape-checked.
 */
import { ApiError } from '../../shared/api/api-error';
import { MAX_PAGE_SIZE, loadAllPages } from '../../shared/data/load-all-pages';
import type { MonthKey } from '../../shared/time/month';
import type { SessionApi } from '../auth/session-api';

const BASE = '/api/v1/project-assignments';

/** Month assignment as returned by the API; `monthStart` is `YYYY-MM-01`. */
export type ProjectAssignment = {
  id: string;
  employeeId: string;
  projectId: string;
  monthStart: string;
};

export type CreateProjectAssignmentInput = Omit<ProjectAssignment, 'id'>;

export interface ProjectAssignmentsApi {
  /** All assignments of the company for one month (every page). */
  listMonth(month: MonthKey, signal?: AbortSignal): Promise<ProjectAssignment[]>;
  create(input: CreateProjectAssignmentInput): Promise<ProjectAssignment>;
}

/** API month value for a `YYYY-MM` month: its first calendar day. */
export function monthStartOf(month: MonthKey): string {
  return `${month}-01`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new ApiError('invalid-response', null, null, null);
}

function toAssignment(value: unknown): ProjectAssignment {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.employeeId !== 'string' ||
    typeof value.projectId !== 'string' ||
    typeof value.monthStart !== 'string' ||
    !/^\d{4}-\d{2}-01$/.test(value.monthStart)
  ) {
    invalid();
  }
  // Only the known fields are kept.
  return {
    id: value.id as string,
    employeeId: value.employeeId as string,
    projectId: value.projectId as string,
    monthStart: value.monthStart as string,
  };
}

function toPage(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.items) || !isRecord(value.pagination)) invalid();
  const { totalPages } = value.pagination as Record<string, unknown>;
  if (!Number.isInteger(totalPages) || (totalPages as number) < 0) invalid();
  return { items: (value.items as unknown[]).map(toAssignment), pagination: { totalPages: totalPages as number } };
}

export function createProjectAssignmentsApi(api: SessionApi): ProjectAssignmentsApi {
  return {
    async listMonth(month, signal) {
      const monthStart = monthStartOf(month);
      const assignments = await loadAllPages(async (page) => {
        const params = new URLSearchParams({ monthStart, pageSize: String(MAX_PAGE_SIZE) });
        if (page > 1) params.set('page', String(page));
        return toPage(await api.request<unknown>(`${BASE}?${params.toString()}`, { signal }));
      });
      // A server answer for another month would be a contract defect.
      if (assignments.some((assignment) => assignment.monthStart !== monthStart)) invalid();
      return assignments;
    },
    async create(input) {
      const { employeeId, projectId, monthStart } = input;
      return toAssignment(await api.request<unknown>(BASE, { method: 'POST', body: { employeeId, projectId, monthStart } }));
    },
  };
}
