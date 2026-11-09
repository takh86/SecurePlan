import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { isCivilDate } from '../../common/time/civil-time.js';
import { validationSubcodeDetails, type ValidationSubcode } from '../../common/errors/error-contract.js';
import type { CancellationResponse } from './cancellation.types.js';
import type { ReplacementOffer } from './replacement-offers.store.js';

type Query = Record<string, unknown>;
export type QueueQuery = {
  projectId: string | null;
  monthStart: string | null;
  type: 'CANCELLATION_REQUEST' | 'REPLACEMENT_NEED' | null;
  offerPresence: 'WITH_ELIGIBLE' | 'WITHOUT_ELIGIBLE' | null;
  page: number;
  pageSize: number;
  sortBy: 'createdAt' | 'dutyDate';
  sortOrder: 'asc' | 'desc';
};
export type OffersQuery = {
  status: 'OPEN' | 'SELECTED' | 'NOT_SELECTED' | 'INVALIDATED' | 'WITHDRAWN' | null;
  page: number;
  pageSize: number;
};
export type AdminNeed = {
  id: string;
  cancellationRequestId: string;
  duty: CancellationResponse['duty'];
  status: CancellationResponse['replacementNeed']['status'];
  resolvedAt: string | null;
  openOfferCount: number;
  project: { id: string; name: string };
  timeZone: string;
  /** SP-20: the Expected-Version for the selection command; monotonic, starts at 1. */
  concurrencyVersion: number;
  /** SP-20: the selected offer of a RESOLVED need; null otherwise. */
  selectedOfferId: string | null;
};
export type AdminQueueItem = {
  type: 'CANCELLATION_REQUEST' | 'REPLACEMENT_NEED';
  cancellationRequestId: string;
  replacementNeedId: string;
  duty: CancellationResponse['duty'];
  requestingEmployee: CancellationResponse['employee'];
  cancellationStatus: CancellationResponse['status'];
  replacementNeedStatus: AdminNeed['status'];
  openOfferCount: number;
  eligibleOpenOfferCount: number;
  project: AdminNeed['project'];
  monthStart: string;
  timeZone: string;
  createdAt: string;
};
export type AdminOffer = ReplacementOffer & { reviewEligibility: 'ELIGIBLE' | 'INELIGIBLE' | 'NOT_APPLICABLE' };
export type AdminOfferContext = {
  cancellation: CancellationResponse;
  need: AdminNeed;
  monthStart: string;
  dutyRemoved: boolean;
  originalAssignmentActive: boolean;
  eligibleOpenOfferCount: number;
  /** SP-20: CONSISTENT only when the case's links (selected offer, membership) agree; INCONSISTENT is surfaced, never hidden. */
  consistency: 'CONSISTENT' | 'INCONSISTENT';
  /** SP-20: the active replacement membership of the duty, if any. */
  replacementAssignment: { id: string; employeeId: string; source: 'REPLACEMENT'; state: 'ACTIVE' } | null;
  evaluatedAt: string;
};
function invalid(field?: string, subcode: ValidationSubcode = 'INVALID_FORMAT'): never {
  throw new BadRequestException({ code: 'VALIDATION_FAILED', ...(field ? {
    errors: [{ pointer: `#/query/${field}`, code: subcode, detail: validationSubcodeDetails[subcode] }],
  } : {}) });
}
function keys(query: Query, allowed: readonly string[]) {
  if (Object.keys(query).some((key) => !allowed.includes(key))) invalid();
}
function choice<T extends string>(field: string, value: unknown, values: readonly T[]): T | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !values.includes(value as T)) invalid(field, 'INVALID_ENUM');
  return value as T;
}
function positive(field: string, value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) invalid(field);
  if (!Number.isSafeInteger(Number(value)) || Number(value) > maximum) invalid(field, 'OUT_OF_RANGE');
  return Number(value);
}
function pagination(query: Query) {
  return {
    page: positive('page', query.page, 1, Math.floor(Number.MAX_SAFE_INTEGER / 100)),
    pageSize: positive('pageSize', query.pageSize, 25, 100),
  };
}
export function queueQuery(query: Query): QueueQuery {
  keys(query, ['projectId', 'monthStart', 'type', 'offerPresence', 'page', 'pageSize', 'sortBy', 'sortOrder']);
  const project = query.projectId;
  if (project !== undefined && (typeof project !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(project))) invalid('projectId', 'INVALID_UUID');
  const month = query.monthStart;
  if (month !== undefined && (!isCivilDate(month) || !month.endsWith('-01'))) invalid('monthStart');
  return {
    projectId: typeof project === 'string' ? project.toLowerCase() : null,
    monthStart: typeof month === 'string' ? month : null,
    type: choice('type', query.type, ['CANCELLATION_REQUEST', 'REPLACEMENT_NEED']),
    offerPresence: choice('offerPresence', query.offerPresence, ['WITH_ELIGIBLE', 'WITHOUT_ELIGIBLE']),
    ...pagination(query),
    sortBy: choice('sortBy', query.sortBy, ['createdAt', 'dutyDate']) ?? 'createdAt',
    sortOrder: choice('sortOrder', query.sortOrder, ['asc', 'desc']) ?? 'asc',
  };
}
export function offersQuery(query: Query): OffersQuery {
  keys(query, ['status', 'page', 'pageSize']);
  return { status: choice('status', query.status, ['OPEN', 'SELECTED', 'NOT_SELECTED', 'INVALIDATED', 'WITHDRAWN']), ...pagination(query) };
}
export function assertEmptyGetBody(request: Request): void {
  if (request.headers['transfer-encoding'] !== undefined || Number(request.headers['content-length'] ?? 0) > 0)
    throw new BadRequestException({ code: 'INVALID_REQUEST_BODY' });
}
export function assertNoAdminQuery(query: Query): void { keys(query, []); }
