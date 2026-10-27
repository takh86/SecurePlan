/**
 * SP-08 project API client. Uses only the endpoints the backend provides;
 * tenant and role are never sent (the server derives them from the session).
 * Responses are shape-checked so a malformed payload never reaches the UI.
 */
import { ApiError } from '../../shared/api/api-error';
import type { SessionApi } from '../auth/session-api';
import type { Project, ProjectListQuery, ProjectPage, UpdateProjectInput } from './project-types';

const BASE = '/api/v1/projects';

export interface ProjectsApi {
  list(query: ProjectListQuery, signal?: AbortSignal): Promise<ProjectPage>;
  get(id: string, signal?: AbortSignal): Promise<Project>;
  create(name: string): Promise<Project>;
  update(id: string, changes: UpdateProjectInput): Promise<Project>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new ApiError('invalid-response', null, null, null);
}

function toProject(value: unknown): Project {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    !['ACTIVE', 'INACTIVE'].includes(value.status as string)
  ) {
    invalid();
  }
  // Only the known fields are kept.
  return { id: value.id as string, name: value.name as string, status: value.status as Project['status'] };
}

export function toProjectPage(value: unknown): ProjectPage {
  if (!isRecord(value) || !Array.isArray(value.items) || !isRecord(value.pagination)) invalid();
  const { page, pageSize, totalItems, totalPages } = value.pagination as Record<string, unknown>;
  if (![page, pageSize, totalItems, totalPages].every((n) => Number.isInteger(n) && (n as number) >= 0)) invalid();
  return {
    items: (value.items as unknown[]).map(toProject),
    pagination: {
      page: page as number,
      pageSize: pageSize as number,
      totalItems: totalItems as number,
      totalPages: totalPages as number,
    },
  };
}

/** Query string without `?`; default values are omitted. Also used for the page URL. */
export function projectListSearch(query: ProjectListQuery): string {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.page && query.page > 1) params.set('page', String(query.page));
  if (query.pageSize) params.set('pageSize', String(query.pageSize));
  return params.toString();
}

/** URL search params are user input: keep only values the API accepts. */
export function parseProjectListQuery(params: URLSearchParams): ProjectListQuery {
  const status = params.get('status');
  const page = Number(params.get('page'));
  return {
    ...(status === 'ACTIVE' || status === 'INACTIVE' ? { status } : {}),
    ...(Number.isInteger(page) && page > 1 && page <= 1_000_000 ? { page } : {}),
  };
}

function projectPath(id: string): string {
  return `${BASE}/${encodeURIComponent(id)}`;
}

export function createProjectsApi(api: SessionApi): ProjectsApi {
  return {
    async list(query, signal) {
      const search = projectListSearch(query);
      return toProjectPage(await api.request<unknown>(search ? `${BASE}?${search}` : BASE, { signal }));
    },
    async get(id, signal) {
      return toProject(await api.request<unknown>(projectPath(id), { signal }));
    },
    async create(name) {
      return toProject(await api.request<unknown>(BASE, { method: 'POST', body: { name } }));
    },
    async update(id, changes) {
      return toProject(await api.request<unknown>(projectPath(id), { method: 'PATCH', body: changes }));
    },
  };
}
