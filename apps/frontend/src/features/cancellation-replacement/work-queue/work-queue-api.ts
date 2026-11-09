/**
 * SP-19 administrative read client (`docs/api/admin-work-queue.openapi.json`).
 * Read-only: no command is defined here. Responses are untrusted input and are
 * checked strictly; a malformed payload becomes an `invalid-response` error and
 * never reaches the UI.
 */
import { ApiError } from '../../../shared/api/api-error';
import type { SessionApi } from '../../auth/session-api';
import { isCivilDate, isNamedTimeZone, isUtcSecond, parsePlanMonth } from '../../../shared/time/civil-time';
import {
  CANCELLATION_STATUSES_LIST,
  PAGE_SIZE,
  type AdminOffer,
  type CaseCancellation,
  type CaseContext,
  type CaseNeed,
  type DutyRef,
  type EmployeeRef,
  type NeedStatus,
  type OffersPage,
  type OffersQuery,
  type Pagination,
  type ProjectRef,
  type QueueItem,
  type QueuePage,
  type QueueQuery,
  type QueueSortBy,
  type ReviewEligibility,
  type SelectionResult,
  type SortOrder,
} from './work-queue-types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Largest page the UI accepts from the URL; the API accepts more, the UI does not need it. */
const MAX_UI_PAGE = 1_000_000;

const CASE_TYPES = ['CANCELLATION_REQUEST', 'REPLACEMENT_NEED'] as const;
const OFFER_PRESENCE = ['WITH_ELIGIBLE', 'WITHOUT_ELIGIBLE'] as const;
const SORT_BY = ['createdAt', 'dutyDate'] as const;
const SORT_ORDER = ['asc', 'desc'] as const;
const NEED_STATUSES = ['OPEN', 'OPEN_UNFILLED', 'RESOLVED', 'CLOSED'] as const;
const OFFER_STATUSES = ['OPEN', 'SELECTED', 'NOT_SELECTED', 'INVALIDATED', 'WITHDRAWN'] as const;
const ELIGIBILITY = ['ELIGIBLE', 'INELIGIBLE', 'NOT_APPLICABLE'] as const;

function invalid(): never {
  throw new ApiError('invalid-response', 200, null, null);
}

/** Exactly the documented keys: no missing and no extra properties. */
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const r = value as Record<string, unknown>;
  if (Object.keys(r).length !== keys.length || keys.some((key) => !Object.hasOwn(r, key))) invalid();
  return r;
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid();
  return value;
}

function text(value: unknown): string {
  if (typeof value !== 'string') invalid();
  return value;
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

function millis(value: unknown): string {
  const s = text(value);
  // A pattern-valid but impossible date (e.g. month 13) parses to NaN; toISOString() would throw a RangeError.
  if (!MILLIS.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString() !== s) invalid();
  return s;
}

function nullableMillis(value: unknown): string | null {
  return value === null ? null : millis(value);
}

function utcSecond(value: unknown): string {
  if (!isUtcSecond(value)) invalid();
  return value;
}

function civilDate(value: unknown): string {
  if (!isCivilDate(value)) invalid();
  return value;
}

function zone(value: unknown): string {
  if (!isNamedTimeZone(value)) invalid();
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) invalid();
  return value as T;
}

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function employee(value: unknown): EmployeeRef {
  const e = record(value, ['id', 'employeeCode', 'firstName', 'lastName']);
  return { id: uuid(e.id), employeeCode: text(e.employeeCode), firstName: text(e.firstName), lastName: text(e.lastName) };
}

function duty(value: unknown): DutyRef {
  const d = record(value, ['id', 'dutyDate', 'shiftKind', 'startsAt', 'endsAt']);
  const startsAt = utcSecond(d.startsAt);
  const endsAt = utcSecond(d.endsAt);
  // Same fixed-width UTC format, so string order is chronological order.
  if (endsAt <= startsAt) invalid();
  return {
    id: uuid(d.id),
    dutyDate: civilDate(d.dutyDate),
    shiftKind: oneOf(d.shiftKind, ['DAY', 'NIGHT'] as const),
    startsAt,
    endsAt,
  };
}

function project(value: unknown): ProjectRef {
  const p = record(value, ['id', 'name']);
  return { id: uuid(p.id), name: text(p.name) };
}

function pagination(value: unknown, page: number, pageSize: number): Pagination {
  const p = record(value, ['page', 'pageSize', 'totalItems', 'totalPages']);
  const totalItems = count(p.totalItems);
  const totalPages = count(p.totalPages);
  if (p.page !== page || p.pageSize !== pageSize || totalPages !== Math.ceil(totalItems / pageSize)) invalid();
  return { page, pageSize, totalItems, totalPages };
}

/** Rows a page must contain for the reported totals. */
function expectedRows(p: Pagination): number {
  return Math.max(0, Math.min(p.pageSize, p.totalItems - (p.page - 1) * p.pageSize));
}

function queueItem(value: unknown): QueueItem {
  const i = record(value, [
    'type',
    'cancellationRequestId',
    'replacementNeedId',
    'duty',
    'requestingEmployee',
    'cancellationStatus',
    'replacementNeedStatus',
    'openOfferCount',
    'eligibleOpenOfferCount',
    'project',
    'monthStart',
    'timeZone',
    'createdAt',
  ]);
  const type = oneOf(i.type, CASE_TYPES);
  const cancellationStatus = oneOf(i.cancellationStatus, CANCELLATION_STATUSES_LIST);
  const replacementNeedStatus = oneOf(i.replacementNeedStatus, NEED_STATUSES);
  const dutyRef = duty(i.duty);
  const monthStart = civilDate(i.monthStart);
  const openOfferCount = count(i.openOfferCount);
  const eligibleOpenOfferCount = count(i.eligibleOpenOfferCount);
  // Actionable rows only: a cancellation row has an open request and an open need;
  // a replacement row has an approved cancellation and an unfilled need.
  const consistent =
    type === 'CANCELLATION_REQUEST'
      ? cancellationStatus === 'OPEN' && replacementNeedStatus === 'OPEN'
      : cancellationStatus === 'APPROVED' && replacementNeedStatus === 'OPEN_UNFILLED';
  if (
    !consistent ||
    !monthStart.endsWith('-01') ||
    monthStart !== `${dutyRef.dutyDate.slice(0, 7)}-01` ||
    eligibleOpenOfferCount > openOfferCount
  )
    invalid();
  return {
    type,
    cancellationRequestId: uuid(i.cancellationRequestId),
    replacementNeedId: uuid(i.replacementNeedId),
    duty: dutyRef,
    requestingEmployee: employee(i.requestingEmployee),
    cancellationStatus,
    replacementNeedStatus,
    openOfferCount,
    eligibleOpenOfferCount,
    project: project(i.project),
    monthStart,
    timeZone: zone(i.timeZone),
    createdAt: millis(i.createdAt),
  };
}

/** Parses one queue response for the page that was requested. */
export function parseQueuePage(value: unknown, page: number, pageSize = PAGE_SIZE): QueuePage {
  const r = record(value, ['items', 'pagination', 'evaluatedAt']);
  if (!Array.isArray(r.items)) invalid();
  const pages = pagination(r.pagination, page, pageSize);
  if (r.items.length !== expectedRows(pages)) invalid();
  const seen = new Set<string>();
  const items = r.items.map((raw) => {
    const item = queueItem(raw);
    // One actionable row per replacement need.
    const key = item.replacementNeedId.toLowerCase();
    if (seen.has(key)) invalid();
    seen.add(key);
    return item;
  });
  return { items, pagination: pages, evaluatedAt: millis(r.evaluatedAt) };
}

function offer(value: unknown, needId: string): AdminOffer {
  const o = record(value, ['id', 'needId', 'employee', 'status', 'createdAt', 'decidedAt', 'reviewEligibility']);
  const status = oneOf(o.status, OFFER_STATUSES);
  const reviewEligibility: ReviewEligibility = oneOf(o.reviewEligibility, ELIGIBILITY);
  const createdAt = millis(o.createdAt);
  const decidedAt = nullableMillis(o.decidedAt);
  if (
    !sameId(uuid(o.needId), needId) ||
    (status === 'OPEN') !== (decidedAt === null) ||
    (decidedAt !== null && decidedAt < createdAt) ||
    // Eligibility only exists for an open offer on an open case.
    (status !== 'OPEN' && reviewEligibility !== 'NOT_APPLICABLE')
  )
    invalid();
  return {
    id: uuid(o.id),
    needId: uuid(o.needId),
    employee: employee(o.employee),
    status,
    createdAt,
    decidedAt,
    reviewEligibility,
  };
}

function cancellation(value: unknown): CaseCancellation {
  const c = record(value, ['id', 'assignmentId', 'employee', 'duty', 'status', 'createdAt', 'decidedAt', 'replacementNeed']);
  const n = record(c.replacementNeed, ['id', 'status', 'resolvedAt']);
  const replacementNeedStatus: NeedStatus = oneOf(n.status, NEED_STATUSES);
  const resolvedAt = nullableMillis(n.resolvedAt);
  if ((replacementNeedStatus === 'RESOLVED') !== (resolvedAt !== null)) invalid();
  return {
    id: uuid(c.id),
    assignmentId: uuid(c.assignmentId),
    employee: employee(c.employee),
    duty: duty(c.duty),
    status: oneOf(c.status, CANCELLATION_STATUSES_LIST),
    createdAt: millis(c.createdAt),
    decidedAt: nullableMillis(c.decidedAt),
    replacementNeed: { id: uuid(n.id), status: replacementNeedStatus, resolvedAt },
  };
}

function need(value: unknown): CaseNeed {
  const n = record(value, ['id', 'cancellationRequestId', 'duty', 'status', 'resolvedAt', 'openOfferCount', 'project', 'timeZone', 'concurrencyVersion', 'selectedOfferId']);
  const status = oneOf(n.status, NEED_STATUSES);
  const resolvedAt = nullableMillis(n.resolvedAt);
  const selectedOfferId = n.selectedOfferId === null ? null : uuid(n.selectedOfferId);
  const concurrencyVersion = n.concurrencyVersion;
  if ((status === 'RESOLVED') !== (resolvedAt !== null) || (status === 'RESOLVED') !== (selectedOfferId !== null)) invalid();
  if (!Number.isSafeInteger(concurrencyVersion) || (concurrencyVersion as number) < 1) invalid();
  return {
    id: uuid(n.id),
    cancellationRequestId: uuid(n.cancellationRequestId),
    duty: duty(n.duty),
    status,
    resolvedAt,
    openOfferCount: count(n.openOfferCount),
    project: project(n.project),
    timeZone: zone(n.timeZone),
    concurrencyVersion: concurrencyVersion as number,
    selectedOfferId,
  };
}

function replacementAssignment(value: unknown): CaseContext['replacementAssignment'] {
  if (value === null) return null;
  const a = record(value, ['id', 'employeeId', 'source', 'state']);
  if (a.source !== 'REPLACEMENT' || a.state !== 'ACTIVE') invalid();
  return { id: uuid(a.id), employeeId: uuid(a.employeeId), source: 'REPLACEMENT', state: 'ACTIVE' };
}

function caseContext(value: unknown, needId: string): CaseContext {
  const c = record(value, ['cancellation', 'need', 'monthStart', 'dutyRemoved', 'originalAssignmentActive', 'eligibleOpenOfferCount', 'evaluatedAt', 'consistency', 'replacementAssignment']);
  const cancellationRef = cancellation(c.cancellation);
  const needRef = need(c.need);
  const monthStart = civilDate(c.monthStart);
  const eligibleOpenOfferCount = count(c.eligibleOpenOfferCount);
  if (c.consistency !== 'CONSISTENT' && c.consistency !== 'INCONSISTENT') invalid();
  // The context describes one case: the need, its cancellation and the duty must agree.
  if (
    !sameId(needRef.id, needId) ||
    !sameId(cancellationRef.replacementNeed.id, needRef.id) ||
    !sameId(needRef.cancellationRequestId, cancellationRef.id) ||
    !sameId(needRef.duty.id, cancellationRef.duty.id) ||
    cancellationRef.replacementNeed.status !== needRef.status ||
    monthStart !== `${needRef.duty.dutyDate.slice(0, 7)}-01` ||
    typeof c.dutyRemoved !== 'boolean' ||
    typeof c.originalAssignmentActive !== 'boolean' ||
    eligibleOpenOfferCount > needRef.openOfferCount
  )
    invalid();
  return {
    cancellation: cancellationRef,
    need: needRef,
    monthStart,
    dutyRemoved: c.dutyRemoved,
    originalAssignmentActive: c.originalAssignmentActive,
    eligibleOpenOfferCount,
    consistency: c.consistency,
    replacementAssignment: replacementAssignment(c.replacementAssignment),
    evaluatedAt: millis(c.evaluatedAt),
  };
}

/** SP-20 selection answer: the fields the case view needs; the rest of the server object is ignored by design. */
export function parseSelectionResult(value: unknown, needId: string): SelectionResult {
  const r = record(value, ['needId', 'cancellationRequestId', 'status', 'decidedAt', 'needVersion', 'selectedOffer', 'otherOffers', 'originalAssignment', 'replacementAssignment', 'duty']);
  const selected = record(r.selectedOffer, ['id', 'status', 'employee']);
  if (!sameId(uuid(r.needId), needId) || selected.status !== 'SELECTED' || !Number.isSafeInteger(r.needVersion)) invalid();
  return {
    needId: uuid(r.needId),
    cancellationRequestId: uuid(r.cancellationRequestId),
    needVersion: r.needVersion as number,
    selectedOfferId: uuid(selected.id),
  };
}

/** Parses one offers response; `status` is the requested filter, if any. */
export function parseOffersPage(value: unknown, needId: string, query: OffersQuery, pageSize = PAGE_SIZE): OffersPage {
  const r = record(value, ['items', 'pagination', 'context']);
  if (!Array.isArray(r.items)) invalid();
  const pages = pagination(r.pagination, query.page, pageSize);
  if (r.items.length !== expectedRows(pages)) invalid();
  let previous = '';
  const items = r.items.map((raw) => {
    const item = offer(raw, needId);
    // Documented order: created_at, then id.
    const key = `${item.createdAt}\0${item.id.toLowerCase()}`;
    if (key <= previous || (query.status !== null && item.status !== query.status)) invalid();
    previous = key;
    return item;
  });
  return { items, pagination: pages, context: caseContext(r.context, needId) };
}

// ---------------------------------------------------------------------------
// URL state. Search parameters are user input: only validated values survive.
// ---------------------------------------------------------------------------

function pick<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function pageFrom(value: string | null): number {
  const page = Number(value ?? '1');
  return Number.isSafeInteger(page) && page >= 1 && page <= MAX_UI_PAGE ? page : 1;
}

export function parseQueueQuery(params: URLSearchParams): QueueQuery {
  const projectId = params.get('projectId');
  const month = params.get('month');
  return {
    type: pick(params.get('type'), CASE_TYPES),
    offerPresence: pick(params.get('offerPresence'), OFFER_PRESENCE),
    projectId: projectId !== null && UUID.test(projectId) ? projectId.toLowerCase() : null,
    month: month !== null && parsePlanMonth(month) !== null ? month : null,
    page: pageFrom(params.get('page')),
    sortBy: pick<QueueSortBy>(params.get('sortBy'), SORT_BY) ?? 'createdAt',
    sortOrder: pick<SortOrder>(params.get('sortOrder'), SORT_ORDER) ?? 'asc',
  };
}

/** Query string without `?`; defaults are omitted so the default view has a clean URL. */
export function queueSearch(query: QueueQuery): string {
  const params = new URLSearchParams();
  if (query.type) params.set('type', query.type);
  if (query.offerPresence) params.set('offerPresence', query.offerPresence);
  if (query.projectId) params.set('projectId', query.projectId);
  if (query.month) params.set('month', query.month);
  if (query.sortBy !== 'createdAt') params.set('sortBy', query.sortBy);
  if (query.sortOrder !== 'asc') params.set('sortOrder', query.sortOrder);
  if (query.page > 1) params.set('page', String(query.page));
  return params.toString();
}

export function parseOffersQuery(params: URLSearchParams): OffersQuery {
  return {
    status: pick(params.get('status'), OFFER_STATUSES),
    page: pageFrom(params.get('page')),
  };
}

export function offersSearch(query: OffersQuery): string {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.page > 1) params.set('page', String(query.page));
  return params.toString();
}

export function isCaseId(value: string | undefined): value is string {
  return value !== undefined && UUID.test(value);
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface WorkQueueApi {
  queue(query: QueueQuery, signal?: AbortSignal): Promise<QueuePage>;
  offers(needId: string, query: OffersQuery, signal?: AbortSignal): Promise<OffersPage>;
  /** SP-20: selects one eligible offer. `expectedVersion` is the need version the administrator saw. */
  select(needId: string, input: SelectionInput, signal?: AbortSignal): Promise<SelectionResult>;
}

export type SelectionInput = { offerId: string; expectedVersion: number; idempotencyKey: string };

export function createWorkQueueApi(api: SessionApi): WorkQueueApi {
  return {
    async queue(query, signal) {
      const params = new URLSearchParams();
      if (query.type) params.set('type', query.type);
      if (query.offerPresence) params.set('offerPresence', query.offerPresence);
      if (query.projectId) params.set('projectId', query.projectId);
      if (query.month) params.set('monthStart', `${query.month}-01`);
      params.set('page', String(query.page));
      params.set('pageSize', String(PAGE_SIZE));
      params.set('sortBy', query.sortBy);
      params.set('sortOrder', query.sortOrder);
      return parseQueuePage(await api.request<unknown>(`/api/v1/admin/work-queue?${params}`, { signal }), query.page);
    },
    async offers(needId, query, signal) {
      if (!isCaseId(needId)) invalid();
      const params = new URLSearchParams();
      if (query.status) params.set('status', query.status);
      params.set('page', String(query.page));
      params.set('pageSize', String(PAGE_SIZE));
      const path = `/api/v1/replacement-needs/${encodeURIComponent(needId)}/offers?${params}`;
      return parseOffersPage(await api.request<unknown>(path, { signal }), needId, query);
    },
    async select(needId, input, signal) {
      // Client-side shape check only; the server re-checks every precondition under its locks.
      if (!isCaseId(needId) || !isCaseId(input.offerId) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) invalid();
      const path = `/api/v1/replacement-needs/${encodeURIComponent(needId)}/selection`;
      return parseSelectionResult(
        await api.request<unknown>(path, {
          method: 'POST',
          body: { offerId: input.offerId },
          expectedVersion: input.expectedVersion,
          idempotencyKey: input.idempotencyKey,
          signal,
        }),
        needId,
      );
    },
  };
}
