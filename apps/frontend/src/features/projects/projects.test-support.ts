/**
 * Test support for SP-08/SP-09 project screens: synthetic example records and
 * an in-memory company that answers the documented endpoints and keeps state
 * across reloads. Records are examples, not business rules.
 * Not part of the application bundle (only imported by *.test.tsx files).
 */
import type { Clock } from '../../shared/time/clock';
import { employee, httpError, type Handler, type RecordedRequest } from '../employees/employees.test-support';
import type { Employee } from '../employees/employee-types';
import type { ProjectAssignment } from './project-assignments-api';
import type { Project, ProjectPage } from './project-types';

/** Fixed "today" for deterministic month defaults: 15.12.2026, local midday. */
export const DECEMBER_2026: Clock = () => new Date(2026, 11, 15, 12, 0, 0);

export const PROJECT_ID = '7a2be0c4-1d3e-4f5a-8b6c-9d0e1f2a3b4c';

/** Synthetic example project. */
export function project(overrides: Partial<Project> = {}): Project {
  return { id: PROJECT_ID, name: 'Demo-Objekt Hafen', status: 'ACTIVE', ...overrides };
}

export function projectPage(items: Project[], overrides: Partial<ProjectPage['pagination']> = {}): ProjectPage {
  const totalItems = overrides.totalItems ?? items.length;
  const pageSize = overrides.pageSize ?? 25;
  return {
    items,
    pagination: { page: 1, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize), ...overrides },
  };
}

function paged<T>(items: T[], params: URLSearchParams) {
  const pageSize = Number(params.get('pageSize') ?? 25);
  const page = Number(params.get('page') ?? 1);
  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    pagination: { page, pageSize, totalItems: items.length, totalPages: Math.ceil(items.length / pageSize) },
  };
}

type CompanyState = { projects: Project[]; employees: Employee[]; assignments: ProjectAssignment[] };

/**
 * In-memory company behind the documented endpoints. Business outcomes of
 * POST /project-assignments follow the API contract (409 codes) so screens can
 * be tested end to end; `fail` lets a test inject an error for one request.
 */
export function fakeCompany(initial: Partial<CompanyState> = {}) {
  const state: CompanyState = {
    projects: initial.projects ?? [project()],
    employees: initial.employees ?? [employee()],
    assignments: initial.assignments ?? [],
  };
  let failNext: ((request: RecordedRequest) => unknown) | null = null;
  let nextId = 1;

  const handler: Handler = (request) => {
    if (failNext) {
      const injected = failNext(request);
      if (injected !== undefined) {
        failNext = null;
        throw injected;
      }
    }
    const [pathname, search = ''] = request.path.split('?');
    const params = new URLSearchParams(search);
    const projectMatch = /^\/api\/v1\/projects\/([^/]+)$/.exec(pathname);

    if (pathname === '/api/v1/projects' && request.method === 'GET') {
      const status = params.get('status');
      return paged(state.projects.filter((item) => !status || item.status === status), params);
    }
    if (pathname === '/api/v1/projects' && request.method === 'POST') {
      const created: Project = {
        id: `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
        name: (request.body as { name: string }).name,
        status: 'ACTIVE',
      };
      state.projects.push(created);
      return created;
    }
    if (projectMatch && request.method === 'GET') {
      const found = state.projects.find((item) => item.id === decodeURIComponent(projectMatch[1]));
      if (!found) throw httpError(404, 'RESOURCE_NOT_FOUND');
      return found;
    }
    if (projectMatch && request.method === 'PATCH') {
      const index = state.projects.findIndex((item) => item.id === decodeURIComponent(projectMatch[1]));
      if (index < 0) throw httpError(404, 'RESOURCE_NOT_FOUND');
      state.projects[index] = { ...state.projects[index], ...(request.body as Partial<Project>) };
      return state.projects[index];
    }
    if (pathname === '/api/v1/employees' && request.method === 'GET') return paged(state.employees, params);
    if (pathname === '/api/v1/project-assignments' && request.method === 'GET') {
      const monthStart = params.get('monthStart');
      return paged(state.assignments.filter((item) => item.monthStart === monthStart), params);
    }
    if (pathname === '/api/v1/project-assignments' && request.method === 'POST') {
      const body = request.body as Omit<ProjectAssignment, 'id'>;
      const person = state.employees.find((item) => item.id === body.employeeId);
      const target = state.projects.find((item) => item.id === body.projectId);
      if (!person || !target) throw httpError(404, 'RESOURCE_NOT_FOUND');
      if (person.status !== 'ACTIVE') throw httpError(409, 'EMPLOYEE_INACTIVE');
      if (target.status !== 'ACTIVE') throw httpError(409, 'PROJECT_INACTIVE');
      const existing = state.assignments.find(
        (item) => item.employeeId === body.employeeId && item.monthStart === body.monthStart,
      );
      if (existing) {
        throw httpError(409, existing.projectId === body.projectId ? 'PROJECT_ASSIGNMENT_ALREADY_EXISTS' : 'PROJECT_ASSIGNMENT_CONFLICT');
      }
      const created = { id: `a-${nextId++}`, ...body };
      state.assignments.push(created);
      return created;
    }
    throw new Error(`Unexpected request ${request.method} ${request.path}`);
  };

  return {
    state,
    handler,
    /** The next request for which `match` returns an error fails with it. */
    fail(match: (request: RecordedRequest) => unknown) {
      failNext = match;
    },
  };
}
