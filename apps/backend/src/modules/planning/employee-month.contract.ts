import {
  BadRequestException,
  ConflictException,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isUUID } from 'class-validator';
import { validCivilDate } from '../workforce/availability/availability.rules.js';
import type { MonthlyPlanResponse } from './monthly-plan.types.js';

export type Kind = 'DAY' | 'NIGHT';
export type Role = 'EMPLOYEE' | 'SHIFT_LEAD';
export type Token = { id: string; version: number };
export type Desired = { state: 'OFF' } | { state: Kind; role: Role };
export type SaveEmployeeMonth = {
  expectedPlan: {
    status: 'UNPUBLISHED' | 'PUBLISHED';
    publishedAt: string | null;
  };
  expectedCreationContext: string;
  expectedCalendar: Token | null;
  days: {
    date: string;
    expected: { day: Token | null; night: Token | null };
    desired: Desired;
  }[];
};
export type Assignment = {
  id: string;
  dutyRole: Role;
  source: 'NORMAL' | 'REPLACEMENT';
};
export type ReadSlot = {
  dutyId: string;
  version: number;
  startsAt: string;
  endsAt: string;
  assignment: Assignment | null;
};
export type SaveResult = {
  commandId: string;
  outcome: 'APPLIED' | 'NO_OP';
  completedAt: string;
  plan: MonthlyPlanResponse;
  employeeId: string;
  counts: {
    createdDuties: number;
    changedDuties: number;
    addedMemberships: number;
    removedMemberships: number;
    updatedMemberships: number;
  };
  changes: (ReadSlot & { date: string; shiftKind: Kind })[];
};
export type Calendar = null | {
  id: string;
  version: number;
  effectiveFromMonth: string;
  operatingWeekdays: number[];
};
export const hashTuple = (tuple: unknown): string =>
  createHash('sha256').update(JSON.stringify(tuple), 'utf8').digest('hex');
export function creationFingerprint(
  projectId: string,
  monthStart: string,
  zone: string,
  rules: readonly {
    id: string;
    kind: Kind;
    month: string;
    start: string;
    end: string;
  }[],
  calendar: Calendar,
): string {
  const sorted = [...rules].sort((a, b) =>
    a.kind === b.kind ? 0 : a.kind === 'DAY' ? -1 : 1,
  );
  return hashTuple([
    'EMPLOYEE_MONTH_CREATION_V1',
    projectId.toLowerCase(),
    monthStart,
    zone,
    sorted.length
      ? [
          sorted[0].month,
          sorted.map((r) => [r.id.toLowerCase(), r.kind, r.start, r.end]),
        ]
      : null,
    calendar === null
      ? null
      : [
          calendar.id.toLowerCase(),
          calendar.version,
          calendar.effectiveFromMonth,
          [...calendar.operatingWeekdays].sort((a, b) => a - b),
        ],
    'D6_V1',
  ]);
}
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export const exact = (
  v: unknown,
  keys: string[],
): v is Record<string, unknown> =>
  isRecord(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
export const uuid = (v: unknown): v is string =>
  typeof v === 'string' && isUUID(v, 'all');
const positive = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const token = (v: unknown): v is Token | null =>
  v === null ||
  (exact(v, ['id', 'version']) && uuid(v.id) && positive(v.version));
const date = (v: unknown): v is string =>
  typeof v === 'string' && validCivilDate(v);
const instant = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{6})?Z$/.test(v) &&
  date(v.slice(0, 10)) &&
  v.slice(11, 19) <= '23:59:59' &&
  /^\d{2}:[0-5]\d:[0-5]\d$/.test(v.slice(11, 19));
function planState(v: unknown): boolean {
  return (
    isRecord(v) &&
    ((v.status === 'UNPUBLISHED' && v.publishedAt === null) ||
      (v.status === 'PUBLISHED' &&
        instant(v.publishedAt) &&
        v.publishedAt.length === 20))
  );
}
export function parseSave(v: unknown): SaveEmployeeMonth {
  const rejectUnknown = (value: unknown, keys: string[]) => {
    if (
      isRecord(value) &&
      Object.keys(value).some((key) => !keys.includes(key))
    )
      throw new BadRequestException({ code: 'UNKNOWN_FIELD' });
  };
  const invalid = (pointer = '#/days'): never => {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      errors: [{ pointer, code: 'INVALID_FORMAT' }],
    });
  };
  if (!isRecord(v))
    throw new BadRequestException({ code: 'INVALID_REQUEST_BODY' });
  rejectUnknown(v, [
    'expectedPlan',
    'expectedCreationContext',
    'expectedCalendar',
    'days',
  ]);
  rejectUnknown(v.expectedPlan, ['status', 'publishedAt']);
  rejectUnknown(v.expectedCalendar, ['id', 'version']);
  if (
    !exact(v, [
      'expectedPlan',
      'expectedCreationContext',
      'expectedCalendar',
      'days',
    ])
  )
    invalid('#/expectedPlan');
  if (
    !exact(v.expectedPlan, ['status', 'publishedAt']) ||
    !planState(v.expectedPlan)
  )
    invalid('#/expectedPlan');
  if (
    typeof v.expectedCreationContext !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.expectedCreationContext)
  )
    invalid('#/expectedCreationContext');
  if (!token(v.expectedCalendar)) invalid('#/expectedCalendar');
  if (!Array.isArray(v.days) || v.days.length < 28 || v.days.length > 31)
    invalid();
  const input = v as Record<string, unknown>;
  const days = (input.days as unknown[]).map((d, i) => {
    rejectUnknown(d, ['date', 'expected', 'desired']);
    if (isRecord(d)) {
      rejectUnknown(d.expected, ['day', 'night']);
      if (isRecord(d.expected))
        for (const value of Object.values(d.expected))
          rejectUnknown(value, ['id', 'version']);
      rejectUnknown(
        d.desired,
        isRecord(d.desired) && d.desired.state === 'OFF'
          ? ['state']
          : ['state', 'role'],
      );
    }
    if (
      !exact(d, ['date', 'expected', 'desired']) ||
      !date(d.date) ||
      !exact(d.expected, ['day', 'night']) ||
      !token(d.expected.day) ||
      !token(d.expected.night) ||
      !isRecord(d.desired)
    )
      return invalid(`#/days/${i}`);
    const want = d.desired;
    if (
      want.state === 'OFF'
        ? !exact(want, ['state'])
        : !exact(want, ['state', 'role']) ||
          !(['DAY', 'NIGHT'] as unknown[]).includes(want.state) ||
          !(['EMPLOYEE', 'SHIFT_LEAD'] as unknown[]).includes(want.role)
    )
      invalid(`#/days/${i}/desired`);
    const normalize = (t: unknown): Token | null =>
      t === null
        ? null
        : { id: (t as Token).id.toLowerCase(), version: (t as Token).version };
    return {
      date: d.date,
      expected: {
        day: normalize(d.expected.day),
        night: normalize(d.expected.night),
      },
      desired: want as Desired,
    };
  });
  if (new Set(days.map((d) => d.date)).size !== days.length) invalid();
  const c = input.expectedCalendar as Token | null;
  return {
    expectedPlan: input.expectedPlan as SaveEmployeeMonth['expectedPlan'],
    expectedCreationContext: input.expectedCreationContext as string,
    expectedCalendar:
      c === null ? null : { id: c.id.toLowerCase(), version: c.version },
    days: days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
  };
}
@Injectable()
export class SaveEmployeeMonthPipe implements PipeTransform {
  transform(value: unknown): SaveEmployeeMonth {
    return parseSave(value);
  }
}
export function requestFingerprint(
  planId: string,
  employeeId: string,
  v: SaveEmployeeMonth,
): string {
  const t = (x: Token | null) =>
    x === null ? null : [x.id.toLowerCase(), x.version];
  return hashTuple([
    'EMPLOYEE_MONTH_SAVE_V2',
    planId.toLowerCase(),
    employeeId.toLowerCase(),
    [v.expectedPlan.status, v.expectedPlan.publishedAt],
    v.expectedCreationContext,
    t(v.expectedCalendar),
    [...v.days]
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((d) => [
        d.date,
        t(d.expected.day),
        t(d.expected.night),
        d.desired.state === 'OFF' ? ['OFF'] : [d.desired.state, d.desired.role],
      ]),
  ]);
}
export const REASONS = [
  'PLAN_CONCURRENT_MODIFICATION',
  'ACTIVE_DUTY_EDIT',
  'PRESERVED_ROSTER_CONFLICT',
  'PROJECT_INACTIVE',
  'PROJECT_CALENDAR_MISSING',
  'PROJECT_CLOSED_WEEKDAY',
  'SHIFT_CONFIGURATION_MISSING',
  'DUTY_TIME_RANGE_INVALID',
  'EMPLOYEE_INACTIVE',
  'EMPLOYEE_NOT_EMPLOYED_FOR_DAY',
  'EMPLOYEE_NOT_ASSIGNED_TO_PROJECT_MONTH',
  'EMPLOYEE_NOT_ELIGIBLE_FOR_SHIFT',
  'EMPLOYEE_UNAVAILABLE',
  'EMPLOYEE_DAILY_SHIFT_CONFLICT',
  'DUTY_ASSIGNMENT_CONFLICT',
] as const;
export type Reason = (typeof REASONS)[number];
export type SlotConflict = { date: string; shiftKind: Kind; reason: Reason };
export function saveConflict(
  stage: 'LEASE' | 'PRECONDITION' | 'VALIDATION',
  conflicts: SlotConflict[] = [],
): never {
  throw new ConflictException({
    code:
      stage === 'PRECONDITION'
        ? 'PLAN_CONCURRENT_MODIFICATION'
        : 'EMPLOYEE_MONTH_SAVE_CONFLICT',
    atomic: true,
    stage,
    conflicts: conflicts.sort((a, b) =>
      a.date === b.date
        ? a.shiftKind === b.shiftKind
          ? 0
          : a.shiftKind === 'DAY'
            ? -1
            : 1
        : a.date < b.date
          ? -1
          : 1,
    ),
  });
}
/** Rebuild the allowlisted extension; never spread exception payloads. */
export function safeSaveConflict(
  v: unknown,
): { atomic: true; stage: string; conflicts: SlotConflict[] } | undefined {
  if (
    !isRecord(v) ||
    v.atomic !== true ||
    !(['LEASE', 'PRECONDITION', 'VALIDATION'] as unknown[]).includes(v.stage) ||
    !Array.isArray(v.conflicts) ||
    v.conflicts.length > 62
  )
    return;
  const seen = new Set<string>();
  for (const c of v.conflicts) {
    if (
      !exact(c, ['date', 'shiftKind', 'reason']) ||
      !date(c.date) ||
      !(['DAY', 'NIGHT'] as unknown[]).includes(c.shiftKind) ||
      !(REASONS as readonly unknown[]).includes(c.reason)
    )
      return;
    const key = `${c.date}/${String(c.shiftKind)}`;
    if (seen.has(key)) return;
    seen.add(key);
  }
  return {
    atomic: true,
    stage: String(v.stage),
    conflicts: v.conflicts.map((c) => ({
      date: c.date,
      shiftKind: c.shiftKind,
      reason: c.reason,
    })),
  };
}
/** Fail closed on stored receipts as well as newly encoded results. */
export function decodeSaveResult(
  v: unknown,
  planId: string,
  employeeId: string,
): SaveResult {
  const fail = (): never => {
    throw new Error('Invalid employee-month receipt');
  };
  if (
    !exact(v, [
      'commandId',
      'outcome',
      'completedAt',
      'plan',
      'employeeId',
      'counts',
      'changes',
    ]) ||
    !uuid(v.commandId) ||
    !instant(v.completedAt) ||
    !['APPLIED', 'NO_OP'].includes(String(v.outcome)) ||
    v.employeeId !== employeeId ||
    !exact(v.plan, [
      'id',
      'projectId',
      'monthStart',
      'status',
      'publishedAt',
    ]) ||
    v.plan.id !== planId ||
    !uuid(v.plan.projectId) ||
    !date(v.plan.monthStart) ||
    !v.plan.monthStart.endsWith('-01') ||
    !planState(v.plan) ||
    !exact(v.counts, [
      'createdDuties',
      'changedDuties',
      'addedMemberships',
      'removedMemberships',
      'updatedMemberships',
    ]) ||
    !Object.values(v.counts).every(
      (n) =>
        typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 62,
    ) ||
    !Array.isArray(v.changes) ||
    v.changes.length > 62 ||
    Buffer.byteLength(JSON.stringify(v), 'utf8') > 131072
  )
    return fail();
  const result = v as unknown as SaveResult;
  let previous = '';
  const dutyIds = new Set<string>();
  for (const c of result.changes) {
    if (
      !exact(c, [
        'date',
        'shiftKind',
        'dutyId',
        'version',
        'startsAt',
        'endsAt',
        'assignment',
      ]) ||
      !date(c.date) ||
      c.date.slice(0, 7) !== result.plan.monthStart.slice(0, 7) ||
      !['DAY', 'NIGHT'].includes(c.shiftKind) ||
      !uuid(c.dutyId) ||
      dutyIds.has(c.dutyId) ||
      !positive(c.version) ||
      !instant(c.startsAt) ||
      !instant(c.endsAt) ||
      c.endsAt <= c.startsAt
    )
      return fail();
    const key = `${c.date}/${c.shiftKind === 'DAY' ? '0' : '1'}`;
    if (key <= previous) return fail();
    previous = key;
    dutyIds.add(c.dutyId);
    if (
      c.assignment !== null &&
      (!exact(c.assignment, ['id', 'dutyRole', 'source']) ||
        !uuid(c.assignment.id) ||
        !['EMPLOYEE', 'SHIFT_LEAD'].includes(c.assignment.dutyRole) ||
        !['NORMAL', 'REPLACEMENT'].includes(c.assignment.source))
    )
      return fail();
  }
  const n = result.counts;
  if (
    n.createdDuties + n.changedDuties !== result.changes.length ||
    n.addedMemberships + n.removedMemberships + n.updatedMemberships !==
      result.changes.length ||
    (result.outcome === 'NO_OP') !== (result.changes.length === 0)
  )
    return fail();
  return result;
}
