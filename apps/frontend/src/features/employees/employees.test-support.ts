/**
 * Test support for SP-07 screens: an in-memory SessionApi that records every
 * request and answers through a handler, plus synthetic employee records.
 * Not part of the application bundle (only imported by *.test.tsx files).
 */
import { ApiError, type FieldError, type KnownErrorCode } from '../../shared/api/api-error';
import type { SessionApi, SessionRequest } from '../auth/session-api';
import type { Employee, EmployeePage } from './employee-types';

export type RecordedRequest = { path: string; method: string; body: unknown };
export type Handler = (request: RecordedRequest) => unknown;

export function fakeSessionApi(handler: Handler) {
  const requests: RecordedRequest[] = [];
  const api: SessionApi = {
    async request<T>(path: string, options: SessionRequest = {}): Promise<T> {
      const recorded = { path, method: options.method ?? 'GET', body: options.body };
      requests.push(recorded);
      return (await handler(recorded)) as T;
    },
  };
  return { api, requests };
}

export function httpError(
  status: number,
  code: KnownErrorCode | null,
  fieldErrors: FieldError[] = [],
  correlationId: string | null = 'req-sp07-1',
): ApiError {
  return new ApiError('http', status, code, correlationId, fieldErrors);
}

export const EMPLOYEE_ID = '6f1ad9a6-3a0c-4b7c-9c5e-0d4f2a1e8b11';

export function employee(overrides: Partial<Employee> = {}): Employee {
  return {
    id: EMPLOYEE_ID,
    employeeCode: 'A-001',
    firstName: 'Mira',
    lastName: 'Beispiel',
    employmentStart: '2026-11-01',
    employmentEnd: null,
    shiftEligibility: 'BOTH',
    status: 'ACTIVE',
    email: 'mira.beispiel@secureplan.test',
    accountStatus: 'PENDING_ACTIVATION',
    ...overrides,
  };
}

export function page(items: Employee[], overrides: Partial<EmployeePage['pagination']> = {}): EmployeePage {
  const totalItems = overrides.totalItems ?? items.length;
  return {
    items,
    pagination: {
      page: 1,
      pageSize: 25,
      totalItems,
      totalPages: Math.ceil(totalItems / 25),
      ...overrides,
    },
  };
}

/** A promise the test resolves/rejects explicitly (pending states). */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
