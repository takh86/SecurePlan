/**
 * SP-09 month-assignment API client (create/read/correct, and since #73 remove
 * for months after the company's current month; the server decides). Uses
 * only the endpoints the backend provides; tenant and role are never sent.
 * Responses are shape-checked.
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
  /**
   * #73: opaque concurrency token (positive safe integer); a removal sends the
   * version the admin confirmed. Kept in memory only, never stored or put in a URL.
   */
  version: number;
};

export type CreateProjectAssignmentInput = Omit<ProjectAssignment, 'id' | 'version'>;

/** PATCH body: only the changed business dimensions. */
export type UpdateProjectAssignmentInput = Partial<CreateProjectAssignmentInput>;

export interface ProjectAssignmentsApi {
  /** All assignments of the company for one month (every page). */
  listMonth(month: MonthKey, signal?: AbortSignal): Promise<ProjectAssignment[]>;
  create(input: CreateProjectAssignmentInput): Promise<ProjectAssignment>;
  /** Corrects one assignment; the server re-validates the complete result. */
  update(assignmentId: string, changes: UpdateProjectAssignmentInput): Promise<ProjectAssignment>;
  /**
   * Removes one assignment, only if it still has `expectedVersion` (#73).
   * Never retried automatically: a refusal or an unknown outcome needs a reload.
   */
  remove(assignmentId: string, expectedVersion: number): Promise<void>;
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

/** Shared response validation for monthly reads and employee discovery. */
export function toAssignment(value: unknown): ProjectAssignment {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.employeeId !== 'string' ||
    typeof value.projectId !== 'string' ||
    typeof value.monthStart !== 'string' ||
    !/^\d{4}-\d{2}-01$/.test(value.monthStart) ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) <= 0
  ) {
    invalid();
  }
  // Only the known fields are kept.
  return {
    id: value.id as string,
    employeeId: value.employeeId as string,
    projectId: value.projectId as string,
    monthStart: value.monthStart as string,
    version: value.version as number,
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
    async update(assignmentId, changes) {
      // Only the three allowed fields, and only those that were given.
      const body: UpdateProjectAssignmentInput = {};
      if (changes.employeeId !== undefined) body.employeeId = changes.employeeId;
      if (changes.projectId !== undefined) body.projectId = changes.projectId;
      if (changes.monthStart !== undefined) body.monthStart = changes.monthStart;
      const saved = toAssignment(
        await api.request<unknown>(`${BASE}/${encodeURIComponent(assignmentId)}`, { method: 'PATCH', body }),
      );
      // An answer for another record would be a contract defect.
      if (saved.id !== assignmentId) invalid();
      return saved;
    },
    async remove(assignmentId, expectedVersion) {
      const answer = await api.request<unknown>(`${BASE}/${encodeURIComponent(assignmentId)}`, {
        method: 'DELETE',
        expectedVersion,
      });
      // 204 has no representation; any body would be a contract defect.
      if (answer !== undefined) invalid();
    },
  };
}
