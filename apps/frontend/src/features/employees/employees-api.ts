/**
 * SP-07 employee API client. Uses only the endpoints the backend provides;
 * tenant and role are never sent (the server derives them from the session).
 * Responses are shape-checked so a malformed payload never reaches the UI.
 */
import { ApiError } from '../../shared/api/api-error';
import type { SessionApi } from '../auth/session-api';
import type {
  CreateEmployeeInput,
  Employee,
  EmployeeListQuery,
  EmployeePage,
  UpdateEmployeeInput,
} from './employee-types';

const BASE = '/api/v1/employees';

export interface EmployeesApi {
  list(query: EmployeeListQuery, signal?: AbortSignal): Promise<EmployeePage>;
  get(id: string, signal?: AbortSignal): Promise<Employee>;
  create(input: CreateEmployeeInput): Promise<Employee>;
  update(id: string, changes: UpdateEmployeeInput): Promise<Employee>;
  deactivate(id: string): Promise<Employee>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isNullableDate = (value: unknown) =>
  value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value));

function invalid(): never {
  throw new ApiError('invalid-response', null, null, null);
}

function toEmployee(value: unknown): Employee {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.employeeCode !== 'string' ||
    typeof value.firstName !== 'string' ||
    typeof value.lastName !== 'string' ||
    typeof value.email !== 'string' ||
    !isNullableDate(value.employmentStart) ||
    !isNullableDate(value.employmentEnd) ||
    !['DAY', 'NIGHT', 'BOTH'].includes(value.shiftEligibility as string) ||
    !['ACTIVE', 'INACTIVE'].includes(value.status as string) ||
    !['PENDING_ACTIVATION', 'ACTIVE', 'DEACTIVATED'].includes(value.accountStatus as string)
  ) {
    invalid();
  }
  // Only the known fields are kept.
  return {
    id: value.id as string,
    employeeCode: value.employeeCode as string,
    firstName: value.firstName as string,
    lastName: value.lastName as string,
    employmentStart: value.employmentStart as string | null,
    employmentEnd: value.employmentEnd as string | null,
    shiftEligibility: value.shiftEligibility as Employee['shiftEligibility'],
    status: value.status as Employee['status'],
    email: value.email as string,
    accountStatus: value.accountStatus as Employee['accountStatus'],
  };
}

function toPage(value: unknown): EmployeePage {
  if (!isRecord(value) || !Array.isArray(value.items) || !isRecord(value.pagination)) invalid();
  const { page, pageSize, totalItems, totalPages } = value.pagination as Record<string, unknown>;
  if (![page, pageSize, totalItems, totalPages].every((n) => Number.isInteger(n) && (n as number) >= 0)) invalid();
  return {
    items: (value.items as unknown[]).map(toEmployee),
    pagination: {
      page: page as number,
      pageSize: pageSize as number,
      totalItems: totalItems as number,
      totalPages: totalPages as number,
    },
  };
}

/** Query string without `?`; default values are omitted. Also used for the page URL. */
export function listQuerySearch(query: EmployeeListQuery): string {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.status) params.set('status', query.status);
  if (query.page && query.page > 1) params.set('page', String(query.page));
  if (query.pageSize) params.set('pageSize', String(query.pageSize));
  return params.toString();
}

/** URL search params are user input: keep only values the API accepts. */
export function parseListQuery(params: URLSearchParams): EmployeeListQuery {
  const q = params.get('q')?.trim() ?? '';
  const status = params.get('status');
  const page = Number(params.get('page'));
  return {
    ...(q.length >= 2 && q.length <= 100 ? { q } : {}),
    ...(status === 'ACTIVE' || status === 'INACTIVE' ? { status } : {}),
    ...(Number.isInteger(page) && page > 1 ? { page } : {}),
  };
}

/** The plain list URL stays `/api/v1/employees`. */
export function employeeListPath(query: EmployeeListQuery): string {
  const search = listQuerySearch(query);
  return search ? `${BASE}?${search}` : BASE;
}

function employeePath(id: string): string {
  return `${BASE}/${encodeURIComponent(id)}`;
}

export function createEmployeesApi(api: SessionApi): EmployeesApi {
  return {
    async list(query, signal) {
      return toPage(await api.request<unknown>(employeeListPath(query), { signal }));
    },
    async get(id, signal) {
      return toEmployee(await api.request<unknown>(employeePath(id), { signal }));
    },
    async create(input) {
      return toEmployee(await api.request<unknown>(BASE, { method: 'POST', body: input }));
    },
    async update(id, changes) {
      return toEmployee(await api.request<unknown>(employeePath(id), { method: 'PATCH', body: changes }));
    },
    async deactivate(id) {
      return toEmployee(await api.request<unknown>(`${employeePath(id)}/deactivate`, { method: 'POST', body: {} }));
    },
  };
}
