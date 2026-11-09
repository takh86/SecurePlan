/**
 * Test support for the SP-19 work queue: synthetic payloads shaped exactly like
 * the documented API responses. Only imported by *.test.ts(x) files.
 * All names, identifiers and times are invented.
 */
import type { IdentityContext } from '../../auth/auth-api';
import type { SessionApi, SessionRequest } from '../../auth/session-api';
import {
  type AdminOffer,
  type CaseContext,
  type OffersPage,
  type Pagination,
  type QueueItem,
  type QueuePage,
} from './work-queue-types';

export const COMPANY_ID = '70000000-0000-4000-8000-000000000001';
export const ADMIN_ACCOUNT_ID = '70000000-0000-4000-8000-000000000002';
export const IDENTITY: IdentityContext = {
  accountId: ADMIN_ACCOUNT_ID,
  companyId: COMPANY_ID,
  email: 'admin@secureplan.test',
  role: 'COMPANY_ADMIN',
};

export const CANCELLATION_ID = '71000000-0000-4000-8000-000000000001';
export const NEED_ID = '71000000-0000-4000-8000-000000000002';
export const DUTY_ID = '71000000-0000-4000-8000-000000000003';
export const PROJECT_ID = '71000000-0000-4000-8000-000000000004';
export const EMPLOYEE_ID = '71000000-0000-4000-8000-000000000005';
export const ASSIGNMENT_ID = '71000000-0000-4000-8000-000000000006';

export const EVALUATED_AT = '2026-12-15T10:00:00.000Z';

const ARBITRARY_EMPLOYEE = { id: EMPLOYEE_ID, employeeCode: 'P-100', firstName: 'Testperson', lastName: 'Eins' };

/** Night duty 18:00–06:00 in Europe/Berlin (17:00Z–05:00Z in December): the end is on the next day. */
export function duty(overrides: Partial<QueueItem['duty']> = {}): QueueItem['duty'] {
  return {
    id: DUTY_ID,
    dutyDate: '2026-12-16',
    shiftKind: 'NIGHT',
    startsAt: '2026-12-16T17:00:00Z',
    endsAt: '2026-12-17T05:00:00Z',
    ...overrides,
  };
}

export function queueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    type: 'CANCELLATION_REQUEST',
    cancellationRequestId: CANCELLATION_ID,
    replacementNeedId: NEED_ID,
    duty: duty(),
    requestingEmployee: ARBITRARY_EMPLOYEE,
    cancellationStatus: 'OPEN',
    replacementNeedStatus: 'OPEN',
    openOfferCount: 3,
    eligibleOpenOfferCount: 1,
    project: { id: PROJECT_ID, name: 'Testprojekt Nord' },
    monthStart: '2026-12-01',
    timeZone: 'Europe/Berlin',
    createdAt: '2026-12-15T09:30:00.000Z',
    ...overrides,
  };
}

export function pagination(totalItems: number, page = 1, pageSize = 25): Pagination {
  return { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) };
}

/** A complete page for `items` (the totals must match the rows the server would return). */
export function queuePage(items: QueueItem[], totalItems = items.length, page = 1): QueuePage {
  return { items, pagination: pagination(totalItems, page), evaluatedAt: EVALUATED_AT };
}

export function offer(overrides: Partial<AdminOffer> = {}): AdminOffer {
  return {
    id: '72000000-0000-4000-8000-000000000001',
    needId: NEED_ID,
    employee: { id: '72000000-0000-4000-8000-000000000002', employeeCode: 'O-200', firstName: 'Angebot', lastName: 'Zwei' },
    status: 'OPEN',
    createdAt: '2026-12-15T10:05:00.000Z',
    decidedAt: null,
    reviewEligibility: 'ELIGIBLE',
    ...overrides,
  };
}

export function caseContext(overrides: Partial<CaseContext> = {}): CaseContext {
  const dutyRef = duty();
  return {
    cancellation: {
      id: CANCELLATION_ID,
      assignmentId: ASSIGNMENT_ID,
      employee: ARBITRARY_EMPLOYEE,
      duty: dutyRef,
      status: 'OPEN',
      createdAt: '2026-12-15T09:30:00.000Z',
      decidedAt: null,
      replacementNeed: { id: NEED_ID, status: 'OPEN', resolvedAt: null },
    },
    need: {
      id: NEED_ID,
      cancellationRequestId: CANCELLATION_ID,
      duty: dutyRef,
      status: 'OPEN',
      resolvedAt: null,
      openOfferCount: 3,
      project: { id: PROJECT_ID, name: 'Testprojekt Nord' },
      timeZone: 'Europe/Berlin',
    },
    monthStart: '2026-12-01',
    dutyRemoved: false,
    originalAssignmentActive: true,
    eligibleOpenOfferCount: 1,
    evaluatedAt: EVALUATED_AT,
    ...overrides,
  };
}

export function offersPage(items: AdminOffer[], context: CaseContext = caseContext(), totalItems = items.length, page = 1): OffersPage {
  return { items, pagination: pagination(totalItems, page), context };
}

/** Three offers covering every review state: eligible, not eligible, and not applicable (already withdrawn). */
export function threeOffers(): AdminOffer[] {
  return [
    offer({
      id: '72000000-0000-4000-8000-000000000010',
      employee: { id: '72000000-0000-4000-8000-000000000011', employeeCode: 'O-201', firstName: 'Erika', lastName: 'Erste' },
      createdAt: '2026-12-15T10:00:00.000Z',
      reviewEligibility: 'ELIGIBLE',
    }),
    offer({
      id: '72000000-0000-4000-8000-000000000020',
      employee: { id: '72000000-0000-4000-8000-000000000021', employeeCode: 'O-202', firstName: 'Max', lastName: 'Zweiter' },
      createdAt: '2026-12-15T10:01:00.000Z',
      reviewEligibility: 'INELIGIBLE',
    }),
    offer({
      id: '72000000-0000-4000-8000-000000000030',
      employee: { id: '72000000-0000-4000-8000-000000000031', employeeCode: 'O-203', firstName: 'Lena', lastName: 'Dritte' },
      status: 'WITHDRAWN',
      createdAt: '2026-12-15T10:02:00.000Z',
      decidedAt: '2026-12-15T10:03:00.000Z',
      reviewEligibility: 'NOT_APPLICABLE',
    }),
  ];
}

export type Recorded = { path: string; method: string };

/** Records every request; the handler answers by path. Unsafe methods are recorded too, to prove none is sent. */
export function recordingApi(handler: (path: string, options: SessionRequest) => unknown | Promise<unknown>) {
  const requests: Recorded[] = [];
  const api: SessionApi = {
    async request<T>(path: string, options: SessionRequest = {}): Promise<T> {
      requests.push({ path, method: options.method ?? 'GET' });
      return (await handler(path, options)) as T;
    },
  };
  return { api, requests };
}
