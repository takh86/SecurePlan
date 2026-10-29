import { ApiError } from '../../shared/api/api-error';
import type { SessionApi } from '../auth/session-api';
import {
  createProjectAssignmentsApi,
  toAssignment,
  type ProjectAssignment,
  type ProjectAssignmentsApi,
} from '../projects/project-assignments-api';

export type FutureProjectAssignment = ProjectAssignment & {
  projectName: string | null;
  projectStatus: 'ACTIVE' | 'INACTIVE' | null;
};

export type FutureAssignmentPage = {
  items: FutureProjectAssignment[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
};

export interface EmployeeFutureAssignmentsApi {
  list(employeeId: string, page: number, signal?: AbortSignal): Promise<FutureAssignmentPage>;
  remove: ProjectAssignmentsApi['remove'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new ApiError('invalid-response', null, null, null);
}

export function createEmployeeFutureAssignmentsApi(api: SessionApi): EmployeeFutureAssignmentsApi {
  return {
    async list(employeeId, requestedPage, signal) {
      const params = new URLSearchParams({ page: String(requestedPage), pageSize: '25' });
      const value = await api.request<unknown>(
        `/api/v1/employees/${encodeURIComponent(employeeId)}/future-project-assignments?${params}`,
        { signal },
      );
      if (!isRecord(value) || !Array.isArray(value.items) || !isRecord(value.pagination)) invalid();
      const { page, pageSize, totalItems, totalPages } = value.pagination;
      if (
        ![page, pageSize, totalItems, totalPages].every((n) => Number.isSafeInteger(n) && (n as number) >= 0) ||
        page !== requestedPage ||
        pageSize !== 25 ||
        totalPages !== Math.ceil((totalItems as number) / 25) ||
        value.items.length > 25
      )
        invalid();
      const expectedItems = Math.max(0, Math.min(25, (totalItems as number) - (requestedPage - 1) * 25));
      if (value.items.length !== expectedItems) invalid();
      const items = value.items.map((item: unknown): FutureProjectAssignment => {
        const assignment = toAssignment(item);
        if (!isRecord(item) || assignment.employeeId.toLowerCase() !== employeeId.toLowerCase()) invalid();
        const hidden = item.projectName === null && item.projectStatus === null;
        const visible =
          typeof item.projectName === 'string' &&
          (item.projectStatus === 'ACTIVE' || item.projectStatus === 'INACTIVE');
        if (!hidden && !visible) invalid();
        return {
          ...assignment,
          projectName: item.projectName as string | null,
          projectStatus: item.projectStatus as FutureProjectAssignment['projectStatus'],
        };
      });
      return {
        items,
        pagination: {
          page: page as number,
          pageSize: pageSize as number,
          totalItems: totalItems as number,
          totalPages: totalPages as number,
        },
      };
    },
    // Same DELETE wire contract, CSRF/Expected-Version and no-retry behavior as #73.
    remove: createProjectAssignmentsApi(api).remove,
  };
}
