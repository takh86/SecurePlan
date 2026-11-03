/**
 * Test support for the A2 employee-month workflow (#88, contract A2-GATE-1):
 * synthetic reads in the exact wire shape and an in-memory model of the three
 * A2 routes behind a fake session API, so screen tests run through the real
 * adapter and its decoders. Records, times and outcomes are examples, not
 * business rules: duty intervals are a test simplification (not the D6
 * resolver), eligibility outcomes are scripted per slot (`invalid`), and only
 * preconditions, lease admission, idempotency records and the selected
 * employee's delta are modelled. Not part of the application bundle.
 */
import { ApiError, type EmployeeMonthConflict, type EmployeeMonthConflictReason, type KnownErrorCode } from '../../../shared/api/api-error';
import type { DateOnly } from '../../../shared/time/month';
import { fakeSessionApi, type RecordedRequest } from '../../employees/employees.test-support';
import type { ShiftKind } from '../../projects/shift-configuration-api';
import {
  createEmployeeMonthApi,
  isoWeekday,
  planDates,
  toEmployeeMonthRead,
  type EmployeeMonthRead,
  type SaveEmployeeMonthBody,
} from './employee-month-api';
import type { DutyRole, MonthlyPlan } from './monthly-plan-types';
import { HAFEN_ID, MIRA_ID, PLAN_ID } from './monthly-planning.test-support';

export const FINGERPRINT = 'a1'.repeat(32);
export const OTHER_FINGERPRINT = 'b2'.repeat(32);
export const CALENDAR_ID = '9a000000-0000-4000-8000-000000000001';
export const PUBLISHED_AT_A2 = '2026-11-20T08:00:00Z';
/** Example operating days (Mon–Fri): a test fixture, never a default. */
export const MON_TO_FRI = [1, 2, 3, 4, 5];
export const ALL_WEEK = [1, 2, 3, 4, 5, 6, 7];

let seq = 0;
function synthId(prefix: string): string {
  seq += 1;
  return `${prefix}-0000-4000-8000-${String(seq).padStart(12, '0')}`;
}
export const dutyId = () => synthId('d0000000');
const assignmentId = () => synthId('a1000000');
const commandId = () => synthId('c0000000');

export type SlotSpec = { dutyId?: string; version?: number; role?: DutyRole | null; source?: 'NORMAL' | 'REPLACEMENT' };

export type MonthSpec = {
  month?: string;
  planId?: string;
  projectId?: string;
  employeeId?: string;
  status?: MonthlyPlan['status'];
  publishedAt?: string | null;
  fingerprint?: string;
  /** Operating weekdays (ISO 1–7) of the effective calendar, or null = MISSING. */
  calendar?: number[] | null;
  calendarVersion?: number;
  /** Day numbers on which the employee is unavailable (neutral fact). */
  unavailable?: number[];
  day?: Record<number, SlotSpec>;
  night?: Record<number, SlotSpec>;
};

type ServerSlot = {
  dutyId: string;
  version: number;
  startsAt: string;
  endsAt: string;
  role: DutyRole | null;
  assignmentId: string | null;
  source: 'NORMAL' | 'REPLACEMENT';
};

export type MonthModel = {
  plan: MonthlyPlan;
  employeeId: string;
  fingerprint: string;
  calendar: { id: string; version: number; effectiveFromMonth: string; operatingWeekdays: number[] } | null;
  unavailable: Set<DateOnly>;
  /** `YYYY-MM-DD|DAY` → live slot. */
  slots: Map<string, ServerSlot>;
};

function addOneDay(date: DateOnly): DateOnly {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function interval(date: DateOnly, kind: ShiftKind): { startsAt: string; endsAt: string } {
  return kind === 'DAY'
    ? { startsAt: `${date}T05:00:00Z`, endsAt: `${date}T17:00:00Z` }
    : { startsAt: `${date}T17:00:00Z`, endsAt: `${addOneDay(date)}T05:00:00Z` };
}

function key(date: DateOnly, kind: ShiftKind): string {
  return `${date}|${kind}`;
}

export function monthModel(spec: MonthSpec = {}): MonthModel {
  const month = spec.month ?? '2026-12';
  const monthStart = `${month}-01`;
  const status = spec.status ?? 'UNPUBLISHED';
  const slots = new Map<string, ServerSlot>();
  const date = (day: number) => `${month}-${String(day).padStart(2, '0')}`;
  for (const [kind, specs] of [['DAY', spec.day], ['NIGHT', spec.night]] as const) {
    for (const [day, slot] of Object.entries(specs ?? {})) {
      const role = slot.role ?? null;
      slots.set(key(date(Number(day)), kind), {
        dutyId: slot.dutyId ?? dutyId(),
        version: slot.version ?? 1,
        ...interval(date(Number(day)), kind),
        role,
        assignmentId: role === null ? null : assignmentId(),
        source: slot.source ?? 'NORMAL',
      });
    }
  }
  const weekdays = spec.calendar === undefined ? ALL_WEEK : spec.calendar;
  return {
    plan: {
      id: spec.planId ?? PLAN_ID,
      projectId: spec.projectId ?? HAFEN_ID,
      monthStart,
      status,
      publishedAt: spec.publishedAt !== undefined ? spec.publishedAt : status === 'PUBLISHED' ? PUBLISHED_AT_A2 : null,
    },
    employeeId: spec.employeeId ?? MIRA_ID,
    fingerprint: spec.fingerprint ?? FINGERPRINT,
    calendar: weekdays === null
      ? null
      : { id: CALENDAR_ID, version: spec.calendarVersion ?? 1, effectiveFromMonth: '2026-01-01', operatingWeekdays: [...weekdays] },
    unavailable: new Set((spec.unavailable ?? []).map(date)),
    slots,
  };
}

function wireSlot(slot: ServerSlot | undefined) {
  if (!slot) return null;
  return {
    dutyId: slot.dutyId,
    version: slot.version,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    assignment: slot.role === null ? null : { id: slot.assignmentId, dutyRole: slot.role, source: slot.source },
  };
}

/** The model as the GET answer (exact A2 wire shape). */
export function wireRead(model: MonthModel): Record<string, unknown> {
  return {
    plan: { ...model.plan },
    employeeId: model.employeeId,
    creationContextFingerprint: model.fingerprint,
    operatingCalendar: model.calendar === null
      ? { state: 'MISSING', effective: null }
      : { state: 'CONFIGURED', effective: { ...model.calendar, operatingWeekdays: [...model.calendar.operatingWeekdays] } },
    unavailableDates: [...model.unavailable].sort(),
    days: planDates(model.plan.monthStart).map((date) => {
      const day = model.slots.get(key(date, 'DAY'));
      const night = model.slots.get(key(date, 'NIGHT'));
      const currentState = day?.role && night?.role ? 'INVALID_DUAL' : day?.role ? 'DAY' : night?.role ? 'NIGHT' : 'OFF';
      const operatingState = model.calendar === null
        ? 'MISSING'
        : model.calendar.operatingWeekdays.includes(isoWeekday(date)) ? 'OPEN' : 'CLOSED';
      return {
        date,
        day: wireSlot(day),
        night: wireSlot(night),
        currentState,
        operatingState,
        violations: [
          ...(currentState === 'INVALID_DUAL' ? ['INVALID_DUAL'] : []),
          ...(operatingState === 'MISSING' ? ['PROJECT_CALENDAR_MISSING'] : operatingState === 'CLOSED' ? ['PROJECT_CLOSED_WEEKDAY'] : []),
        ],
      };
    }),
  };
}

/** A decoded read for a spec (through the real decoder). */
export function readFixture(spec: MonthSpec = {}): EmployeeMonthRead {
  const model = monthModel(spec);
  return toEmployeeMonthRead(wireRead(model), model.plan.id, model.employeeId);
}

function conflict(code: KnownErrorCode, value: EmployeeMonthConflict): ApiError {
  return new ApiError('http', 409, code, 'req-a2-1', [], undefined, value);
}

export function stageError(stage: EmployeeMonthConflict['stage'], conflicts: EmployeeMonthConflict['conflicts'] = []): ApiError {
  return conflict(stage === 'PRECONDITION' ? 'PLAN_CONCURRENT_MODIFICATION' : 'EMPLOYEE_MONTH_SAVE_CONFLICT', { stage, conflicts });
}

type Receipt = { hash: string; state: 'COMPLETED' | 'FAILED' | 'IN_PROGRESS'; result?: Record<string, unknown> };

function sameToken(expected: { id: string; version: number } | null, slot: ServerSlot | undefined): boolean {
  if (expected === null) return slot === undefined;
  return slot !== undefined && slot.dutyId.toLowerCase() === expected.id.toLowerCase() && slot.version === expected.version;
}

/**
 * In-memory A2 routes for one plan and employee. Precedence follows the
 * adopted contract: structural date check → idempotency (replay, key reuse,
 * in progress) → lease admission → lifecycle/slot/calendar preconditions →
 * NO_OP → project → calendar and scripted validation → delta and receipt.
 */
export function employeeMonthServer(spec: MonthSpec = {}) {
  const model = monthModel(spec);
  const receipts = new Map<string, Receipt>();
  /** Slots with a live edit lease of another editor. */
  const leases = new Set<string>();
  /** Scripted eligibility outcome for new or changed work in a slot. */
  const invalid = new Map<string, EmployeeMonthConflictReason>();
  const log = { commits: 0, replays: 0 };
  let projectActive = true;
  let loseNextSave = false;
  let malformNextSave = false;
  let nextLookup: ((key: string) => unknown) | null = null;
  let failNext: ((request: RecordedRequest) => unknown) | null = null;
  let holdNext: { promise: Promise<void> } | null = null;

  function execute(key: string, body: SaveEmployeeMonthBody): Record<string, unknown> {
    const dates = planDates(model.plan.monthStart);
    if (body.days.length !== dates.length || body.days.some((day, index) => day.date !== dates[index])) {
      throw new ApiError('http', 400, 'DUTY_DATE_OUTSIDE_PLAN_MONTH', 'req-a2-1');
    }
    const hash = JSON.stringify(body);
    const prior = receipts.get(key);
    if (prior && prior.hash !== hash) throw new ApiError('http', 409, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST', 'req-a2-1');
    if (prior?.state === 'COMPLETED') {
      log.replays += 1;
      return prior.result!;
    }
    if (prior?.state === 'IN_PROGRESS') throw new ApiError('http', 409, 'IDEMPOTENCY_REQUEST_IN_PROGRESS', 'req-a2-1');
    receipts.set(key, { hash, state: 'IN_PROGRESS' });
    try {
      const result = apply(body);
      receipts.set(key, { hash, state: 'COMPLETED', result });
      return result;
    } catch (error) {
      receipts.set(key, { hash, state: 'FAILED' });
      throw error;
    }
  }

  function apply(body: SaveEmployeeMonthBody): Record<string, unknown> {
    const changed: { date: DateOnly; kind: ShiftKind; role: DutyRole | null; slot: ServerSlot | undefined }[] = [];
    for (const day of body.days) {
      for (const kind of ['DAY', 'NIGHT'] as const) {
        const slot = model.slots.get(key(day.date, kind));
        const role = day.desired.state === kind ? day.desired.role : null;
        if ((slot?.role ?? null) !== role) changed.push({ date: day.date, kind, role, slot });
      }
    }
    const leased = changed.filter((item) => item.slot && leases.has(key(item.date, item.kind)));
    if (leased.length > 0) {
      throw stageError('LEASE', leased.map((item) => ({ date: item.date, shiftKind: item.kind, reason: 'ACTIVE_DUTY_EDIT' as const })));
    }
    const stale = body.days.flatMap((day) => (['DAY', 'NIGHT'] as const)
      .filter((kind) => !sameToken(kind === 'DAY' ? day.expected.day : day.expected.night, model.slots.get(key(day.date, kind))))
      .map((kind) => ({ date: day.date, shiftKind: kind, reason: 'PLAN_CONCURRENT_MODIFICATION' as const })));
    const calendarToken = model.calendar === null ? null : { id: model.calendar.id, version: model.calendar.version };
    const lifecycle = body.expectedPlan.status === model.plan.status && body.expectedPlan.publishedAt === model.plan.publishedAt;
    const calendarSame = calendarToken === null || body.expectedCalendar === null
      ? calendarToken === body.expectedCalendar
      : calendarToken.id === body.expectedCalendar.id && calendarToken.version === body.expectedCalendar.version;
    const creates = changed.some((item) => !item.slot && item.role !== null);
    const creationSame = !creates || body.expectedCreationContext === model.fingerprint;
    if (stale.length > 0 || !lifecycle || !calendarSame || !creationSame) throw stageError('PRECONDITION', stale);
    if (changed.length === 0) return receipt('NO_OP', []);
    if (!projectActive) {
      throw stageError('VALIDATION', [{ date: changed[0].date, shiftKind: changed[0].kind, reason: 'PROJECT_INACTIVE' }]);
    }
    const problems = changed.flatMap((item) => {
      if (item.role === null) return [];
      const operating = model.calendar === null ? 'MISSING' : model.calendar.operatingWeekdays.includes(isoWeekday(item.date)) ? 'OPEN' : 'CLOSED';
      const reason: EmployeeMonthConflictReason | undefined = operating === 'MISSING'
        ? 'PROJECT_CALENDAR_MISSING'
        : operating === 'CLOSED' ? 'PROJECT_CLOSED_WEEKDAY' : invalid.get(key(item.date, item.kind));
      return reason ? [{ date: item.date, shiftKind: item.kind, reason }] : [];
    });
    if (problems.length > 0) throw stageError('VALIDATION', problems);
    const changes = changed.map((item) => {
      const slotKey = key(item.date, item.kind);
      const previous = item.slot;
      const next: ServerSlot = previous
        ? {
            ...previous,
            version: previous.version + 1,
            role: item.role,
            // A role change keeps the membership; a new membership gets a new id; removal tombstones it.
            assignmentId: item.role === null ? null : previous.role !== null ? previous.assignmentId : assignmentId(),
          }
        : { dutyId: dutyId(), version: 1, ...interval(item.date, item.kind), role: item.role, assignmentId: assignmentId(), source: 'NORMAL' };
      model.slots.set(slotKey, next);
      return { date: item.date, kind: item.kind, created: !previous, before: previous?.role ?? null, slot: next };
    });
    log.commits += 1;
    return receipt('APPLIED', changes);
  }

  function receipt(outcome: 'APPLIED' | 'NO_OP', changes: { date: DateOnly; kind: ShiftKind; created: boolean; before: DutyRole | null; slot: ServerSlot }[]) {
    const sorted = [...changes].sort((a, b) => (a.date === b.date ? (a.kind === 'DAY' ? -1 : 1) : a.date < b.date ? -1 : 1));
    return {
      commandId: commandId(),
      outcome,
      completedAt: '2026-11-25T10:00:00.123456Z',
      plan: { ...model.plan },
      employeeId: model.employeeId,
      counts: {
        createdDuties: sorted.filter((item) => item.created).length,
        changedDuties: sorted.filter((item) => !item.created).length,
        addedMemberships: sorted.filter((item) => item.before === null && item.slot.role !== null).length,
        removedMemberships: sorted.filter((item) => item.before !== null && item.slot.role === null).length,
        updatedMemberships: sorted.filter((item) => item.before !== null && item.slot.role !== null).length,
      },
      changes: sorted.map((item) => ({ date: item.date, shiftKind: item.kind, ...wireSlot(item.slot)! })),
    };
  }

  async function handle(request: RecordedRequest): Promise<unknown> {
    if (failNext) {
      const injected = failNext(request);
      if (injected !== undefined) {
        failNext = null;
        throw injected;
      }
    }
    const [pathname] = request.path.split('?');
    const match = /^\/api\/v1\/monthly-plans\/([^/]+)\/employee-months\/([^/]+)(\/save|\/save-result)?$/.exec(pathname);
    if (!match || decodeURIComponent(match[1]) !== model.plan.id || decodeURIComponent(match[2]) !== model.employeeId) {
      throw new ApiError('http', 404, 'RESOURCE_NOT_FOUND', 'req-a2-1');
    }
    const route = match[3] ?? '';
    if (route === '' && request.method === 'GET') return wireRead(model);
    if (route === '/save-result' && request.method === 'GET') {
      const key = request.idempotencyKey!;
      if (nextLookup) {
        const scripted = nextLookup(key);
        nextLookup = null;
        if (scripted instanceof Error) throw scripted;
        return scripted;
      }
      const record = receipts.get(key);
      if (!record) return { state: 'UNKNOWN' };
      if (record.state === 'COMPLETED') return { state: 'COMPLETED', result: record.result };
      if (record.state === 'FAILED') return { state: 'NOT_COMPLETED' };
      return { state: 'IN_PROGRESS', retryAfterSeconds: 1 };
    }
    if (route === '/save' && request.method === 'POST') {
      if (holdNext) {
        const held = holdNext;
        holdNext = null;
        await held.promise;
      }
      const result = execute(request.idempotencyKey!, request.body as SaveEmployeeMonthBody);
      if (loseNextSave) {
        // Processed and committed; the answer never arrives.
        loseNextSave = false;
        throw new ApiError('network', null, null, null);
      }
      if (malformNextSave) {
        malformNextSave = false;
        return { ...result, counts: { ...(result.counts as object), createdDuties: 99 } };
      }
      return result;
    }
    throw new ApiError('http', 404, 'RESOURCE_NOT_FOUND', 'req-a2-1');
  }

  const session = fakeSessionApi(handle);
  const saves = () => session.requests.filter((request) => request.method === 'POST');
  const lookups = () => session.requests.filter((request) => request.path.endsWith('/save-result'));
  const reads = () => session.requests.filter((request) => request.method === 'GET' && !request.path.endsWith('/save-result'));

  return {
    handler: handle,
    api: createEmployeeMonthApi(session.api),
    requests: session.requests,
    saves,
    lookups,
    reads,
    model,
    log,
    receipts,
    leases,
    invalid,
    setProjectActive(active: boolean) {
      projectActive = active;
    },
    /** The next save commits, but its answer is lost (network error). */
    loseNextSave() {
      loseNextSave = true;
    },
    /** The next save commits, but its answer is malformed. */
    malformNextSave() {
      malformNextSave = true;
    },
    /** Scripts the next save-result answer (wire JSON) or failure (an Error). */
    scriptLookup(answer: (key: string) => unknown) {
      nextLookup = answer;
    },
    /** Injects an error for the next matching request (nothing is processed). */
    failNext(inject: (request: RecordedRequest) => unknown) {
      failNext = inject;
    },
    /** Holds the next save until `release` (to observe the saving state). */
    holdNextSave() {
      let release!: () => void;
      holdNext = { promise: new Promise<void>((done) => { release = done; }) };
      return () => release();
    },
    /** Another admin changes one slot (new version; role of this employee as given). */
    changeSlot(date: DateOnly, kind: ShiftKind, role: DutyRole | null = null) {
      const previous = model.slots.get(key(date, kind));
      model.slots.set(key(date, kind), previous
        ? { ...previous, version: previous.version + 1, role, assignmentId: role === null ? null : previous.assignmentId ?? assignmentId() }
        : { dutyId: dutyId(), version: 1, ...interval(date, kind), role, assignmentId: role === null ? null : assignmentId(), source: 'NORMAL' });
    },
    /** First Publish by someone else (CR-03: later saves apply directly). */
    publish(at = PUBLISHED_AT_A2) {
      model.plan = { ...model.plan, status: 'PUBLISHED', publishedAt: at };
    },
    setCalendar(weekdays: number[] | null, version = (model.calendar?.version ?? 0) + 1) {
      model.calendar = weekdays === null
        ? null
        : { id: CALENDAR_ID, version, effectiveFromMonth: '2026-01-01', operatingWeekdays: [...weekdays] };
    },
  };
}
