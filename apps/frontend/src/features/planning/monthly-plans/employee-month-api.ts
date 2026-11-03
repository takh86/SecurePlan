/**
 * A2 employee-month Save client (#88). Contract: A2-GATE-1, adopted 2026-11-03
 * (`docs/api/employee-month-save.md`, `docs/api/employee-month-save.openapi.json`;
 * backend #95). MonthlyPlanningSection constructs this client for the live page.
 *
 * - GET  /monthly-plans/{planId}/employee-months/{employeeId}: one consistent
 *   read of the whole month for one employee (both slots per date with exact
 *   duty ID/version, the employee's own assignment only, lifecycle, creation
 *   checksum, effective calendar, neutral unavailable dates).
 * - POST …/save: ONE atomic command with the complete desired month, every slot
 *   precondition and an Idempotency-Key; 200 only after COMMIT.
 * - GET  …/save-result: outcome query for the same key; never executes a save.
 *
 * Every answer is shape-checked. A receipt is also checked against the exact
 * request it answers, so a malformed or foreign answer is never shown as
 * success. Nothing is retried here; keys travel only as headers.
 */
import { ApiError } from '../../../shared/api/api-error';
import { daysInMonth, dateInMonth, type DateOnly } from '../../../shared/time/month';
import type { SessionApi } from '../../auth/session-api';
import type { ShiftKind } from '../../projects/shift-configuration-api';
import type { AssignmentSource, DutyRole, MonthlyPlan, MonthlyPlanStatus } from './monthly-plan-types';
import { toMonthlyPlan } from './monthly-plans-api';

export type SlotToken = { id: string; version: number };

/** The selected employee's live membership in one slot (never another person's). */
export type MonthAssignment = { id: string; dutyRole: DutyRole; source: AssignmentSource };

/** One live duty slot (possibly empty or staffed only by others). */
export type MonthSlot = {
  dutyId: string;
  version: number;
  startsAt: string;
  endsAt: string;
  assignment: MonthAssignment | null;
};

export type MonthDayState = 'OFF' | 'DAY' | 'NIGHT' | 'INVALID_DUAL';
export type OperatingState = 'OPEN' | 'CLOSED' | 'MISSING';
export type MonthViolation = 'INVALID_DUAL' | 'PROJECT_CLOSED_WEEKDAY' | 'PROJECT_CALENDAR_MISSING';

export type MonthDay = {
  date: DateOnly;
  day: MonthSlot | null;
  night: MonthSlot | null;
  currentState: MonthDayState;
  operatingState: OperatingState;
  violations: readonly MonthViolation[];
};

export type MonthCalendar = {
  id: string;
  version: number;
  effectiveFromMonth: string;
  /** ISO weekdays 1 (Monday) … 7 (Sunday), ascending. */
  operatingWeekdays: readonly number[];
};

export type EmployeeMonthRead = {
  plan: MonthlyPlan;
  employeeId: string;
  /** Opaque server checksum; only ever sent back as `expectedCreationContext`. */
  creationContextFingerprint: string;
  /** The effective calendar of the plan month, or null when it is MISSING. */
  calendar: MonthCalendar | null;
  /** Neutral facts for this employee only: no status, reason or absence kind. */
  unavailableDates: readonly DateOnly[];
  /** Every date of the plan month, ascending. */
  days: readonly MonthDay[];
};

export type DesiredDay = { state: 'OFF' } | { state: ShiftKind; role: DutyRole };

/** The exact request body of POST …/save (all fields required, nothing else). */
export type SaveEmployeeMonthBody = {
  expectedPlan: { status: MonthlyPlanStatus; publishedAt: string | null };
  expectedCreationContext: string;
  expectedCalendar: SlotToken | null;
  days: readonly {
    date: DateOnly;
    expected: { day: SlotToken | null; night: SlotToken | null };
    desired: DesiredDay;
  }[];
};

export type SaveChange = MonthSlot & { date: DateOnly; shiftKind: ShiftKind };

export type SaveCounts = {
  createdDuties: number;
  changedDuties: number;
  addedMemberships: number;
  removedMemberships: number;
  updatedMemberships: number;
};

/** Immutable receipt of a committed command (fresh or replayed under the same key). */
export type SaveResult = {
  commandId: string;
  outcome: 'APPLIED' | 'NO_OP';
  completedAt: string;
  plan: MonthlyPlan;
  employeeId: string;
  counts: SaveCounts;
  changes: readonly SaveChange[];
};

/**
 * Outcome of a key, by the server's evidence: COMPLETED (receipt), IN_PROGRESS,
 * NOT_COMPLETED (proven failed) or UNKNOWN (no or expired evidence; this is
 * NOT proof that nothing was saved).
 */
export type SaveResultLookup =
  | { state: 'COMPLETED'; result: SaveResult }
  | { state: 'IN_PROGRESS'; retryAfterSeconds: number }
  | { state: 'NOT_COMPLETED' }
  | { state: 'UNKNOWN' };

export interface EmployeeMonthApi {
  read(planId: string, employeeId: string, signal?: AbortSignal): Promise<EmployeeMonthRead>;
  /** One attempt; resolves only with a receipt that answers exactly `body`. Never retried here. */
  save(planId: string, employeeId: string, idempotencyKey: string, body: SaveEmployeeMonthBody): Promise<SaveResult>;
  /** Outcome of the attempt sent with `idempotencyKey` and `body`; a COMPLETED receipt is checked against `body`. */
  saveResult(planId: string, employeeId: string, idempotencyKey: string, body: SaveEmployeeMonthBody): Promise<SaveResultLookup>;
}

const BASE = '/api/v1/monthly-plans';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const MONTH_START = /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-01$/;
// Duty instants are second precision; a receipt's completedAt keeps PostgreSQL microseconds.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
// Phase 8.7: 8-128 visible ASCII characters (a UUIDv4 qualifies).
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,128}$/;
const MAX_SLOTS = 62;
const COUNT_KEYS = ['createdDuties', 'changedDuties', 'addedMemberships', 'removedMemberships', 'updatedMemberships'] as const;

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

function isVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && INSTANT.test(value) && Number.isFinite(Date.parse(value));
}

/** Every date of the plan month, ascending. */
export function planDates(monthStart: string): DateOnly[] {
  const month = monthStart.slice(0, 7);
  return Array.from({ length: daysInMonth(month) }, (_, index) => dateInMonth(month, index + 1)!);
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a civil date; no time zone is involved. */
export function isoWeekday(date: DateOnly): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
}

function toAssignment(value: unknown): MonthAssignment {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    (value.dutyRole !== 'EMPLOYEE' && value.dutyRole !== 'SHIFT_LEAD') ||
    (value.source !== 'NORMAL' && value.source !== 'REPLACEMENT')
  ) {
    invalid();
  }
  return { id: value.id as string, dutyRole: value.dutyRole as DutyRole, source: value.source as AssignmentSource };
}

function toSlot(value: unknown): MonthSlot | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !isId(value.dutyId) ||
    !isVersion(value.version) ||
    !isInstant(value.startsAt) ||
    !isInstant(value.endsAt) ||
    // A resolved duty interval is never empty or reversed.
    Date.parse(value.endsAt) <= Date.parse(value.startsAt) ||
    !('assignment' in value)
  ) {
    invalid();
  }
  return {
    dutyId: value.dutyId as string,
    version: value.version as number,
    startsAt: value.startsAt as string,
    endsAt: value.endsAt as string,
    assignment: value.assignment === null ? null : toAssignment(value.assignment),
  };
}

function toCalendar(value: unknown, monthStart: string): MonthCalendar | null {
  if (!isRecord(value)) invalid();
  if (value.state === 'MISSING') {
    if (value.effective !== null) invalid();
    return null;
  }
  const effective = value.effective;
  if (
    value.state !== 'CONFIGURED' ||
    !isRecord(effective) ||
    !isId(effective.id) ||
    !isVersion(effective.version) ||
    typeof effective.effectiveFromMonth !== 'string' ||
    !MONTH_START.test(effective.effectiveFromMonth) ||
    // The effective version of a month starts in that month or before.
    effective.effectiveFromMonth > monthStart ||
    !Array.isArray(effective.operatingWeekdays)
  ) {
    invalid();
  }
  const weekdays = effective.operatingWeekdays as unknown[];
  if (
    weekdays.length < 1 ||
    weekdays.length > 7 ||
    !weekdays.every((day) => Number.isInteger(day) && (day as number) >= 1 && (day as number) <= 7) ||
    new Set(weekdays).size !== weekdays.length
  ) {
    invalid();
  }
  return {
    id: effective.id as string,
    version: effective.version as number,
    effectiveFromMonth: effective.effectiveFromMonth as string,
    operatingWeekdays: [...(weekdays as number[])].sort((a, b) => a - b),
  };
}

function expectedState(day: MonthSlot | null, night: MonthSlot | null): MonthDayState {
  if (day?.assignment && night?.assignment) return 'INVALID_DUAL';
  if (day?.assignment) return 'DAY';
  if (night?.assignment) return 'NIGHT';
  return 'OFF';
}

function expectedOperating(date: DateOnly, calendar: MonthCalendar | null): OperatingState {
  if (calendar === null) return 'MISSING';
  return calendar.operatingWeekdays.includes(isoWeekday(date)) ? 'OPEN' : 'CLOSED';
}

function expectedViolations(state: MonthDayState, operating: OperatingState): MonthViolation[] {
  return [
    ...(state === 'INVALID_DUAL' ? ['INVALID_DUAL' as const] : []),
    ...(operating === 'MISSING' ? ['PROJECT_CALENDAR_MISSING' as const] : operating === 'CLOSED' ? ['PROJECT_CLOSED_WEEKDAY' as const] : []),
  ];
}

/**
 * Strict decoder of the read projection for exactly this plan and employee.
 * Derived facts (current state, operating state, violations) must agree with
 * the slots and the calendar; any disagreement is a malformed answer, because
 * the read is the basis of every precondition sent back.
 */
export function toEmployeeMonthRead(value: unknown, planId: string, employeeId: string): EmployeeMonthRead {
  if (!isRecord(value)) invalid();
  const plan = toMonthlyPlan(value.plan);
  if (!sameId(plan.id, planId) || !isId(value.employeeId) || !sameId(value.employeeId, employeeId)) invalid();
  if (typeof value.creationContextFingerprint !== 'string' || !FINGERPRINT.test(value.creationContextFingerprint)) invalid();
  const calendar = toCalendar(value.operatingCalendar, plan.monthStart);
  const dates = planDates(plan.monthStart);
  const inMonth = new Set(dates);
  if (!Array.isArray(value.unavailableDates) || value.unavailableDates.length > dates.length) invalid();
  const unavailableDates = value.unavailableDates as unknown[];
  if (!unavailableDates.every((date) => typeof date === 'string' && inMonth.has(date)) || new Set(unavailableDates).size !== unavailableDates.length) {
    invalid();
  }
  if (!Array.isArray(value.days) || value.days.length !== dates.length) invalid();
  const slotIds = new Set<string>();
  const days = (value.days as unknown[]).map((item, index): MonthDay => {
    if (!isRecord(item) || item.date !== dates[index] || !('day' in item) || !('night' in item)) invalid();
    const date = item.date as DateOnly;
    const day = toSlot(item.day);
    const night = toSlot(item.night);
    for (const slot of [day, night]) {
      if (slot === null) continue;
      // One live duty per date and kind: a duty can never fill two slots.
      if (slotIds.has(slot.dutyId.toLowerCase())) invalid();
      slotIds.add(slot.dutyId.toLowerCase());
    }
    const currentState = expectedState(day, night);
    const operatingState = expectedOperating(date, calendar);
    const violations = expectedViolations(currentState, operatingState);
    if (
      item.currentState !== currentState ||
      item.operatingState !== operatingState ||
      !Array.isArray(item.violations) ||
      item.violations.length !== violations.length ||
      !violations.every((violation) => (item.violations as unknown[]).includes(violation))
    ) {
      invalid();
    }
    return { date, day, night, currentState, operatingState, violations };
  });
  return {
    plan,
    employeeId: value.employeeId as string,
    creationContextFingerprint: value.creationContextFingerprint as string,
    calendar,
    unavailableDates: [...(unavailableDates as DateOnly[])].sort(),
    days,
  };
}

/**
 * Strict decoder of a receipt that must answer exactly `body` on this route:
 * same plan/employee, the lifecycle the request expected, counts that add up,
 * one ascending entry per changed slot, created duties at version 1, changed
 * duties at a higher version, and the employee's membership in each changed
 * slot as requested. A replay under the same key answers the same request.
 */
export function toSaveResult(value: unknown, planId: string, employeeId: string, body: SaveEmployeeMonthBody): SaveResult {
  if (!isRecord(value) || !isId(value.commandId) || !isInstant(value.completedAt)) invalid();
  if (value.outcome !== 'APPLIED' && value.outcome !== 'NO_OP') invalid();
  const plan = toMonthlyPlan(value.plan);
  const firstDate = body.days[0]?.date;
  if (
    !sameId(plan.id, planId) ||
    !isId(value.employeeId) ||
    !sameId(value.employeeId, employeeId) ||
    plan.monthStart !== firstDate ||
    plan.status !== body.expectedPlan.status ||
    plan.publishedAt !== body.expectedPlan.publishedAt
  ) {
    invalid();
  }
  const counts = value.counts;
  if (!isRecord(counts) || !COUNT_KEYS.every((key) => Number.isSafeInteger(counts[key]) && (counts[key] as number) >= 0 && (counts[key] as number) <= MAX_SLOTS)) {
    invalid();
  }
  if (!Array.isArray(value.changes) || value.changes.length > MAX_SLOTS) invalid();
  const byDate = new Map(body.days.map((day) => [day.date, day]));
  const dutyIds = new Set<string>();
  let previous = '';
  let created = 0;
  const changes = (value.changes as unknown[]).map((item): SaveChange => {
    if (!isRecord(item) || typeof item.date !== 'string' || (item.shiftKind !== 'DAY' && item.shiftKind !== 'NIGHT')) invalid();
    const request = byDate.get(item.date as string);
    const slot = toSlot({ dutyId: item.dutyId, version: item.version, startsAt: item.startsAt, endsAt: item.endsAt, assignment: item.assignment });
    if (!request || slot === null) invalid();
    const kind = item.shiftKind as ShiftKind;
    const key = `${item.date as string}/${kind === 'DAY' ? 0 : 1}`;
    if (key <= previous || dutyIds.has(slot.dutyId.toLowerCase())) invalid();
    previous = key;
    dutyIds.add(slot.dutyId.toLowerCase());
    const expected = kind === 'DAY' ? request.expected.day : request.expected.night;
    if (expected === null) {
      created += 1;
      if (slot.version !== 1) invalid();
    } else if (!sameId(expected.id, slot.dutyId) || slot.version <= expected.version) {
      invalid();
    }
    const desired = request.desired;
    const wanted = desired.state === kind ? desired.role : null;
    if ((slot.assignment?.dutyRole ?? null) !== wanted) invalid();
    return { ...slot, date: item.date as DateOnly, shiftKind: kind };
  });
  const n = counts as SaveCounts;
  if (
    n.createdDuties !== created ||
    n.changedDuties !== changes.length - created ||
    n.addedMemberships + n.removedMemberships + n.updatedMemberships !== changes.length ||
    (value.outcome === 'NO_OP') !== (changes.length === 0)
  ) {
    invalid();
  }
  return {
    commandId: value.commandId as string,
    outcome: value.outcome as SaveResult['outcome'],
    completedAt: value.completedAt as string,
    plan,
    employeeId: value.employeeId as string,
    counts: { ...n },
    changes,
  };
}

export function toSaveResultLookup(value: unknown, planId: string, employeeId: string, body: SaveEmployeeMonthBody): SaveResultLookup {
  if (!isRecord(value)) invalid();
  switch (value.state) {
    case 'COMPLETED':
      return { state: 'COMPLETED', result: toSaveResult(value.result, planId, employeeId, body) };
    case 'IN_PROGRESS':
      if (!Number.isSafeInteger(value.retryAfterSeconds) || (value.retryAfterSeconds as number) < 1) invalid();
      return { state: 'IN_PROGRESS', retryAfterSeconds: value.retryAfterSeconds as number };
    case 'NOT_COMPLETED':
      return { state: 'NOT_COMPLETED' };
    case 'UNKNOWN':
      return { state: 'UNKNOWN' };
    default:
      return invalid();
  }
}

function monthPath(planId: string, employeeId: string): string {
  return `${BASE}/${encodeURIComponent(planId)}/employee-months/${encodeURIComponent(employeeId)}`;
}

function checkKey(idempotencyKey: string): void {
  // Checked before sending; the key itself is never part of an error message.
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new Error('Idempotency-Key has an invalid format');
}

export function createEmployeeMonthApi(api: SessionApi): EmployeeMonthApi {
  return {
    async read(planId, employeeId, signal) {
      return toEmployeeMonthRead(await api.request<unknown>(monthPath(planId, employeeId), { signal }), planId, employeeId);
    },
    async save(planId, employeeId, idempotencyKey, body) {
      checkKey(idempotencyKey);
      const answer = await api.request<unknown>(`${monthPath(planId, employeeId)}/save`, {
        method: 'POST', body, idempotencyKey,
      });
      return toSaveResult(answer, planId, employeeId, body);
    },
    async saveResult(planId, employeeId, idempotencyKey, body) {
      checkKey(idempotencyKey);
      const answer = await api.request<unknown>(`${monthPath(planId, employeeId)}/save-result`, { idempotencyKey });
      return toSaveResultLookup(answer, planId, employeeId, body);
    },
  };
}
