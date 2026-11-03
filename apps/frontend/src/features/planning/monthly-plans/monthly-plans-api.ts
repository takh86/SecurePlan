/**
 * Monthly-plan API client: exactly the routes the backend provides. SP-11:
 * list/create/read plans, list/create duties. SP-12 (ADR-0006): read one duty,
 * edit it (PATCH) and remove it (DELETE) under `Expected-Version` and an edit
 * lease, and acquire/renew/release that lease. SP-13: the First Publish of a
 * plan (bodyless POST under an Idempotency-Key; there is no re-publish).
 * Tenant, role, status and instants are never sent: the server derives them.
 * Responses are shape-checked, so a malformed payload never reaches the UI.
 * Writes are never retried here; lease tokens and idempotency keys travel only
 * as headers.
 */
import { ApiError } from '../../../shared/api/api-error';
import { MAX_PAGE_SIZE, loadAllPages } from '../../../shared/data/load-all-pages';
import type { MonthKey } from '../../../shared/time/month';
import type { SessionApi } from '../../auth/session-api';
import { monthStartOf } from '../../projects/project-assignments-api';
import type { ShiftKind } from '../../projects/shift-configuration-api';
import type {
  AvailabilityConflict,
  CreateDutyInput,
  Duty,
  DutyAssignment,
  EditLeaseGrant,
  MonthlyPlan,
  MonthlyPlanPage,
  UpdateDutyInput,
} from './monthly-plan-types';

const BASE = '/api/v1/monthly-plans';

export interface MonthlyPlansApi {
  /** Every plan of the company for one month (all pages). */
  listMonth(month: MonthKey, signal?: AbortSignal): Promise<MonthlyPlan[]>;
  get(planId: string, signal?: AbortSignal): Promise<MonthlyPlan>;
  /** Creates an UNPUBLISHED plan; the server rejects a second plan for the same project and month. */
  create(projectId: string, month: MonthKey): Promise<MonthlyPlan>;
  /** All live duties of a plan (bounded, unpaginated collection). */
  listDuties(planId: string, signal?: AbortSignal): Promise<Duty[]>;
  /** Creates one duty with its initial members; never retried automatically. */
  createDuty(planId: string, input: CreateDutyInput): Promise<Duty>;
  /** SP-12: the current state of one live duty of this plan. */
  getDuty(planId: string, dutyId: string, signal?: AbortSignal): Promise<Duty>;
  /**
   * SP-12: applies `changes` only if the duty still has `expectedVersion` and the
   * caller holds the duty's edit lease. Never retried automatically.
   */
  updateDuty(planId: string, dutyId: string, changes: UpdateDutyInput, expectedVersion: number, leaseToken: string): Promise<Duty>;
  /** SP-12: removes the duty (and releases its lease) under the same preconditions. Never retried. */
  removeDuty(planId: string, dutyId: string, expectedVersion: number, leaseToken: string): Promise<void>;
  /** ADR-0006: acquires (or, for the same account, rotates) the duty's edit lease. */
  acquireLease(planId: string, dutyId: string): Promise<EditLeaseGrant>;
  /** ADR-0006: extends a live lease held with `leaseToken`; the token itself does not change. */
  renewLease(planId: string, dutyId: string, leaseToken: string): Promise<EditLeaseGrant>;
  /** ADR-0006: releases the lease; `keepalive` lets the request outlive a closing page. */
  releaseLease(planId: string, dutyId: string, leaseToken: string, options?: { keepalive?: boolean }): Promise<void>;
  /**
   * SP-13 First Publish (UNPUBLISHED -> PUBLISHED): a POST with no body at all,
   * the session's CSRF token and `idempotencyKey`. The caller keeps ONE key per
   * confirmed decision and resends it unchanged when the outcome is unknown; the
   * server then replays the completed result instead of publishing twice.
   * Resolves only with this plan as PUBLISHED (fresh or replayed). Never retried here.
   */
  publish(planId: string, idempotencyKey: string): Promise<MonthlyPlan>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_START = /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-01$/;
const DATE = /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
// The server renders instants itself: UTC, second precision, `Z` suffix.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
// ADR-0006: lease expiry keeps PostgreSQL microseconds.
const LEASE_EXPIRY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const LEASE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
// Phase 8.7: 8-128 visible ASCII characters (a UUIDv4 qualifies).
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new ApiError('invalid-response', null, null, null);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && INSTANT.test(value) && Number.isFinite(Date.parse(value));
}

export function toMonthlyPlan(value: unknown): MonthlyPlan {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !isId(value.projectId) ||
    typeof value.monthStart !== 'string' ||
    !MONTH_START.test(value.monthStart) ||
    (value.status !== 'UNPUBLISHED' && value.status !== 'PUBLISHED') ||
    !(value.publishedAt === null || isInstant(value.publishedAt)) ||
    // CR-03: the first publication sets publishedAt; an unpublished plan has none.
    (value.status === 'PUBLISHED') !== (value.publishedAt !== null)
  ) {
    invalid();
  }
  // Only the known fields are kept.
  return {
    id: value.id as string,
    projectId: value.projectId as string,
    monthStart: value.monthStart as string,
    status: value.status as MonthlyPlan['status'],
    publishedAt: value.publishedAt as string | null,
  };
}

function toPlanPage(value: unknown): MonthlyPlanPage {
  if (!isRecord(value) || !Array.isArray(value.items) || !isRecord(value.pagination)) invalid();
  const { page, pageSize, totalItems, totalPages } = value.pagination as Record<string, unknown>;
  if (![page, pageSize, totalItems, totalPages].every((n) => Number.isInteger(n) && (n as number) >= 0)) invalid();
  return {
    items: (value.items as unknown[]).map(toMonthlyPlan),
    pagination: {
      page: page as number,
      pageSize: pageSize as number,
      totalItems: totalItems as number,
      totalPages: totalPages as number,
    },
  };
}

function toAssignment(value: unknown): DutyAssignment {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !isId(value.employeeId) ||
    (value.dutyRole !== 'EMPLOYEE' && value.dutyRole !== 'SHIFT_LEAD') ||
    (value.source !== 'NORMAL' && value.source !== 'REPLACEMENT')
  ) {
    invalid();
  }
  return {
    id: value.id as string,
    employeeId: value.employeeId as string,
    dutyRole: value.dutyRole as DutyAssignment['dutyRole'],
    source: value.source as DutyAssignment['source'],
  };
}

export function toDuty(value: unknown): Duty {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    typeof value.dutyDate !== 'string' ||
    !DATE.test(value.dutyDate) ||
    (value.shiftKind !== 'DAY' && value.shiftKind !== 'NIGHT') ||
    !isInstant(value.startsAt) ||
    !isInstant(value.endsAt) ||
    // A resolved duty interval is never empty or reversed.
    Date.parse(value.endsAt) <= Date.parse(value.startsAt) ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) <= 0 ||
    !Array.isArray(value.assignments) ||
    !Array.isArray(value.availabilityConflicts)
  ) {
    invalid();
  }
  const assignments = (value.assignments as unknown[]).map(toAssignment);
  const employees = new Set(assignments.map((member) => member.employeeId.toLowerCase()));
  // One live membership per employee and duty.
  if (employees.size !== assignments.length) invalid();
  const availabilityConflicts = (value.availabilityConflicts as unknown[]).map((item): AvailabilityConflict => {
    if (!isRecord(item) || item.code !== 'EMPLOYEE_UNAVAILABLE' || !isId(item.assignmentId) || !isId(item.employeeId)) {
      invalid();
    }
    // A conflict always names a current member of THIS duty.
    const member = assignments.find((candidate) => sameId(candidate.id, item.assignmentId as string));
    if (!member || !sameId(member.employeeId, item.employeeId as string)) invalid();
    // Only the documented fields: no reason, status or absence marker can reach the UI.
    return { code: 'EMPLOYEE_UNAVAILABLE', assignmentId: item.assignmentId as string, employeeId: item.employeeId as string };
  });
  if (new Set(availabilityConflicts.map((conflict) => conflict.assignmentId.toLowerCase())).size !== availabilityConflicts.length) {
    invalid();
  }
  return {
    id: value.id as string,
    dutyDate: value.dutyDate as string,
    shiftKind: value.shiftKind as ShiftKind,
    startsAt: value.startsAt as string,
    endsAt: value.endsAt as string,
    version: value.version as number,
    assignments,
    availabilityConflicts,
  };
}

const KIND_ORDER: Record<ShiftKind, number> = { DAY: 0, NIGHT: 1 };

/** API order: by date, DAY before NIGHT (stable for locally added duties). */
export function sortDuties(duties: readonly Duty[]): Duty[] {
  return [...duties].sort((a, b) =>
    a.dutyDate === b.dutyDate ? KIND_ORDER[a.shiftKind] - KIND_ORDER[b.shiftKind] : a.dutyDate.localeCompare(b.dutyDate));
}

function planPath(planId: string): string {
  return `${BASE}/${encodeURIComponent(planId)}`;
}

function dutyPath(planId: string, dutyId: string): string {
  return `${planPath(planId)}/entries/${encodeURIComponent(dutyId)}`;
}

/** Lease grant: canonical token and a parseable expiry; nothing else is kept. */
export function toLeaseGrant(value: unknown): EditLeaseGrant {
  if (
    !isRecord(value) ||
    typeof value.leaseToken !== 'string' ||
    !LEASE_TOKEN.test(value.leaseToken) ||
    typeof value.expiresAt !== 'string' ||
    !LEASE_EXPIRY.test(value.expiresAt) ||
    !Number.isFinite(Date.parse(value.expiresAt))
  ) {
    invalid();
  }
  return { leaseToken: value.leaseToken as string, expiresAt: value.expiresAt as string };
}

/** True when `duty` has exactly the members (and roles) of `roster`. */
function hasRoster(duty: Duty, roster: readonly { employeeId: string; dutyRole: string }[]): boolean {
  const requested = new Map(roster.map((member) => [member.employeeId.toLowerCase(), member.dutyRole]));
  return duty.assignments.length === requested.size
    && duty.assignments.every((member) => requested.get(member.employeeId.toLowerCase()) === member.dutyRole);
}

export function createMonthlyPlansApi(api: SessionApi): MonthlyPlansApi {
  return {
    async listMonth(month, signal) {
      const monthStart = monthStartOf(month);
      const plans = await loadAllPages(async (page) => {
        const params = new URLSearchParams({ monthStart, pageSize: String(MAX_PAGE_SIZE) });
        if (page > 1) params.set('page', String(page));
        return toPlanPage(await api.request<unknown>(`${BASE}?${params.toString()}`, { signal }));
      });
      // A plan of another month would be a contract defect; so would two plans of one project.
      if (plans.some((plan) => plan.monthStart !== monthStart)) invalid();
      if (new Set(plans.map((plan) => plan.projectId.toLowerCase())).size !== plans.length) invalid();
      return plans;
    },
    async get(planId, signal) {
      const plan = toMonthlyPlan(await api.request<unknown>(planPath(planId), { signal }));
      if (!sameId(plan.id, planId)) invalid();
      return plan;
    },
    async create(projectId, month) {
      const monthStart = monthStartOf(month);
      const plan = toMonthlyPlan(await api.request<unknown>(BASE, { method: 'POST', body: { projectId, monthStart } }));
      // The server creates exactly the requested plan, unpublished.
      if (!sameId(plan.projectId, projectId) || plan.monthStart !== monthStart || plan.status !== 'UNPUBLISHED') invalid();
      return plan;
    },
    async listDuties(planId, signal) {
      const value = await api.request<unknown>(`${planPath(planId)}/entries`, { signal });
      if (!isRecord(value) || !Array.isArray(value.items)) invalid();
      const duties = (value.items as unknown[]).map(toDuty);
      // At most one live duty per date and kind.
      if (new Set(duties.map((duty) => `${duty.dutyDate}|${duty.shiftKind}`)).size !== duties.length) invalid();
      return sortDuties(duties);
    },
    async createDuty(planId, input) {
      // Only the three documented fields; members exactly as selected.
      const body = {
        dutyDate: input.dutyDate,
        shiftKind: input.shiftKind,
        assignments: input.assignments.map(({ employeeId, dutyRole }) => ({ employeeId, dutyRole })),
      };
      const duty = toDuty(await api.request<unknown>(`${planPath(planId)}/entries`, { method: 'POST', body }));
      // The answer must be the requested duty with exactly the requested members and roles.
      if (duty.dutyDate !== body.dutyDate || duty.shiftKind !== body.shiftKind || !hasRoster(duty, body.assignments)) {
        invalid();
      }
      return duty;
    },
    async getDuty(planId, dutyId, signal) {
      const duty = toDuty(await api.request<unknown>(dutyPath(planId, dutyId), { signal }));
      if (!sameId(duty.id, dutyId)) invalid();
      return duty;
    },
    async updateDuty(planId, dutyId, changes, expectedVersion, leaseToken) {
      // Only the documented, changed fields; the roster is sent complete.
      const body: UpdateDutyInput = {};
      if (changes.dutyDate !== undefined) body.dutyDate = changes.dutyDate;
      if (changes.shiftKind !== undefined) body.shiftKind = changes.shiftKind;
      if (changes.assignments !== undefined) {
        body.assignments = changes.assignments.map(({ employeeId, dutyRole }) => ({ employeeId, dutyRole }));
      }
      const duty = toDuty(await api.request<unknown>(dutyPath(planId, dutyId), {
        method: 'PATCH', body, expectedVersion, editLeaseToken: leaseToken,
      }));
      // The answer is this duty, at least at the confirmed version, carrying exactly the requested changes.
      if (
        !sameId(duty.id, dutyId) ||
        duty.version < expectedVersion ||
        (body.dutyDate !== undefined && duty.dutyDate !== body.dutyDate) ||
        (body.shiftKind !== undefined && duty.shiftKind !== body.shiftKind) ||
        (body.assignments !== undefined && !hasRoster(duty, body.assignments))
      ) {
        invalid();
      }
      return duty;
    },
    async removeDuty(planId, dutyId, expectedVersion, leaseToken) {
      await api.request<unknown>(dutyPath(planId, dutyId), { method: 'DELETE', expectedVersion, editLeaseToken: leaseToken });
    },
    async acquireLease(planId, dutyId) {
      return toLeaseGrant(await api.request<unknown>(`${dutyPath(planId, dutyId)}/edit-lease`, { method: 'POST' }));
    },
    async renewLease(planId, dutyId, leaseToken) {
      const grant = toLeaseGrant(await api.request<unknown>(`${dutyPath(planId, dutyId)}/edit-lease`, {
        method: 'PUT', editLeaseToken: leaseToken,
      }));
      // A renewal extends the same lease; a different token would be a contract defect.
      if (grant.leaseToken !== leaseToken) invalid();
      return grant;
    },
    async releaseLease(planId, dutyId, leaseToken, options = {}) {
      await api.request<unknown>(`${dutyPath(planId, dutyId)}/edit-lease`, {
        method: 'DELETE', editLeaseToken: leaseToken, keepalive: options.keepalive,
      });
    },
    async publish(planId, idempotencyKey) {
      // Checked before sending; the key itself is never part of an error message.
      if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new Error('Idempotency-Key has an invalid format');
      const plan = toMonthlyPlan(await api.request<unknown>(`${planPath(planId)}/publish`, {
        method: 'POST', noBody: true, idempotencyKey,
      }));
      // The answer is this plan, published; toMonthlyPlan already requires publishedAt with PUBLISHED.
      if (!sameId(plan.id, planId) || plan.status !== 'PUBLISHED') invalid();
      return plan;
    },
  };
}
