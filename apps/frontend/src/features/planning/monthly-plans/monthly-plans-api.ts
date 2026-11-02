/**
 * SP-11 PR-1 monthly-plan API client: exactly the five routes the backend
 * provides (list/create/read plans, list/create duties). No publish, edit,
 * removal or lease call exists. Tenant, role, status, instants and versions are
 * never sent: the server derives them. Responses are shape-checked, so a
 * malformed payload never reaches the UI.
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
  MonthlyPlan,
  MonthlyPlanPage,
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
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_START = /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-01$/;
const DATE = /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
// The server renders instants itself: UTC, second precision, `Z` suffix.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

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
      const requested = new Map(body.assignments.map((member) => [member.employeeId.toLowerCase(), member.dutyRole]));
      if (
        duty.dutyDate !== body.dutyDate ||
        duty.shiftKind !== body.shiftKind ||
        duty.assignments.length !== requested.size ||
        duty.assignments.some((member) => requested.get(member.employeeId.toLowerCase()) !== member.dutyRole)
      ) {
        invalid();
      }
      return duty;
    },
  };
}
