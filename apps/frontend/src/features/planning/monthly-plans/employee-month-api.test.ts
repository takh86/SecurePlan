import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../shared/api/api-error';
import { fakeSessionApi } from '../../employees/employees.test-support';
import {
  createEmployeeMonthApi,
  isoWeekday,
  planDates,
  toEmployeeMonthRead,
  toSaveResult,
  toSaveResultLookup,
  type SaveEmployeeMonthBody,
} from './employee-month-api';
import { buildSaveBody } from './employee-month-save';
import { emptyDraft, monthBaseFromRead, paint } from './employee-month-draft';
import { CALENDAR_ID, FINGERPRINT, MON_TO_FRI, monthModel, readFixture, wireRead } from './employee-month.test-support';
import { MIRA_ID, PLAN_ID } from './monthly-planning.test-support';

const DUTY = 'd0000000-0000-4000-8000-00000000d003';
const NIGHT = 'd0000000-0000-4000-8000-00000000e004';

function wire(spec: Parameters<typeof monthModel>[0] = {}) {
  return wireRead(monthModel(spec)) as Record<string, any>;
}

function decode(value: unknown) {
  return toEmployeeMonthRead(value, PLAN_ID, MIRA_ID);
}

function invalidResponse(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return error instanceof ApiError && error.kind === 'invalid-response';
  }
  return false;
}

describe('A2 employee-month read decoder', () => {
  it('accepts the full month for exactly this plan and employee, with its slot tokens and neutral facts', () => {
    const read = decode(wire({ calendar: MON_TO_FRI, unavailable: [9, 2], day: { 3: { dutyId: DUTY, version: 4, role: 'SHIFT_LEAD' } } }));
    expect(read.plan).toEqual({ id: PLAN_ID, projectId: expect.any(String), monthStart: '2026-12-01', status: 'UNPUBLISHED', publishedAt: null });
    expect(read.creationContextFingerprint).toBe(FINGERPRINT);
    expect(read.calendar).toEqual({ id: CALENDAR_ID, version: 1, effectiveFromMonth: '2026-01-01', operatingWeekdays: MON_TO_FRI });
    expect(read.unavailableDates).toEqual(['2026-12-02', '2026-12-09']);
    expect(read.days).toHaveLength(31);
    expect(read.days[2]).toEqual({
      date: '2026-12-03',
      day: { dutyId: DUTY, version: 4, startsAt: '2026-12-03T05:00:00Z', endsAt: '2026-12-03T17:00:00Z', assignment: { id: expect.any(String), dutyRole: 'SHIFT_LEAD', source: 'NORMAL' } },
      night: null,
      currentState: 'DAY',
      operatingState: 'OPEN',
      violations: [],
    });
    // 5 December 2026 is a Saturday: closed in the example calendar.
    expect(read.days[4]).toMatchObject({ operatingState: 'CLOSED', violations: ['PROJECT_CLOSED_WEEKDAY'] });
  });

  it('accepts MISSING, a stored Tag + Nacht (INVALID_DUAL), a published plan and February with 28 days', () => {
    const missing = decode(wire({ calendar: null }));
    expect(missing.calendar).toBeNull();
    expect(missing.days.every((day) => day.operatingState === 'MISSING')).toBe(true);
    const dual = decode(wire({ day: { 7: { role: 'EMPLOYEE' } }, night: { 7: { role: 'SHIFT_LEAD' } } }));
    expect(dual.days[6]).toMatchObject({ currentState: 'INVALID_DUAL', violations: ['INVALID_DUAL'] });
    expect(decode(wire({ status: 'PUBLISHED' })).plan.status).toBe('PUBLISHED');
    expect(decode(wire({ month: '2027-02' })).days).toHaveLength(28);
  });

  const cases: [string, (value: Record<string, any>) => void][] = [
    ['another plan', (v) => { v.plan.id = 'ffffffff-0000-4000-8000-000000000000'; }],
    ['another employee', (v) => { v.employeeId = 'ffffffff-0000-4000-8000-000000000000'; }],
    ['a published plan without publishedAt', (v) => { v.plan.status = 'PUBLISHED'; }],
    ['an uppercase or short fingerprint', (v) => { v.creationContextFingerprint = 'A'.repeat(64); }],
    ['MISSING with an effective version', (v) => { v.operatingCalendar = { state: 'MISSING', effective: v.operatingCalendar.effective }; }],
    ['CONFIGURED without a version', (v) => { v.operatingCalendar = { state: 'CONFIGURED', effective: null }; }],
    ['an empty weekday set', (v) => { v.operatingCalendar.effective.operatingWeekdays = []; }],
    ['a duplicate weekday', (v) => { v.operatingCalendar.effective.operatingWeekdays = [1, 1]; }],
    ['weekday 0', (v) => { v.operatingCalendar.effective.operatingWeekdays = [0, 1]; }],
    ['a calendar version effective after the month', (v) => { v.operatingCalendar.effective.effectiveFromMonth = '2027-01-01'; }],
    ['a missing date', (v) => { v.days.pop(); }],
    ['dates out of order', (v) => { [v.days[0], v.days[1]] = [v.days[1], v.days[0]]; }],
    ['an unavailable date of another month', (v) => { v.unavailableDates = ['2027-01-01']; }],
    ['a duplicate unavailable date', (v) => { v.unavailableDates = ['2026-12-02', '2026-12-02']; }],
    ['a version 0', (v) => { v.days[2].day.version = 0; }],
    ['an unsafe version', (v) => { v.days[2].day.version = Number.MAX_SAFE_INTEGER + 1; }],
    ['a reversed interval', (v) => { v.days[2].day.endsAt = v.days[2].day.startsAt; }],
    ['a slot without assignment field', (v) => { delete v.days[2].day.assignment; }],
    ['an unknown role', (v) => { v.days[2].day.assignment = { id: DUTY, dutyRole: 'BOSS', source: 'NORMAL' }; }],
    ['one duty in two slots', (v) => { v.days[2].night = { ...v.days[2].day, assignment: null }; }],
    ['a current state that disagrees with the slots', (v) => { v.days[2].currentState = 'OFF'; }],
    ['an operating state that disagrees with the calendar', (v) => { v.days[2].operatingState = 'CLOSED'; }],
    ['a missing violation', (v) => { v.days[4].violations = []; }],
    ['an extra violation', (v) => { v.days[2].violations = ['INVALID_DUAL']; }],
  ];
  it.each(cases)('rejects %s as a malformed answer', (_name, mutate) => {
    const value = wire({ calendar: MON_TO_FRI, day: { 3: { dutyId: DUTY, version: 4, role: 'EMPLOYEE' } } });
    mutate(value);
    expect(invalidResponse(() => decode(value))).toBe(true);
  });

  it('computes plan dates and ISO weekdays without a time zone', () => {
    expect(planDates('2028-02-01')).toHaveLength(29);
    expect(planDates('2026-12-01')[30]).toBe('2026-12-31');
    expect([isoWeekday('2026-12-07'), isoWeekday('2026-12-13')]).toEqual([1, 7]);
  });
});

/** A body for December 2026: TAG on the 3rd (existing empty duty), FREI on the 4th (existing night membership). */
function sampleBody(): SaveEmployeeMonthBody {
  const read = readFixture({ day: { 3: { dutyId: DUTY, version: 4, role: null } }, night: { 4: { dutyId: NIGHT, version: 2, role: 'EMPLOYEE' } } });
  let draft = emptyDraft(monthBaseFromRead(read));
  draft = paint(draft, '2026-12-03', 'DAY');
  draft = paint(draft, '2026-12-04', 'FREE');
  draft = paint(draft, '2026-12-10', 'NIGHT');
  return buildSaveBody(draft);
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    commandId: 'c0000000-0000-4000-8000-000000000001',
    outcome: 'APPLIED',
    completedAt: '2026-11-25T10:00:00.123456Z',
    plan: { id: PLAN_ID, projectId: '7a2be0c4-1d3e-4f5a-8b6c-9d0e1f2a3b4c', monthStart: '2026-12-01', status: 'UNPUBLISHED', publishedAt: null as string | null },
    employeeId: MIRA_ID,
    counts: { createdDuties: 1, changedDuties: 2, addedMemberships: 2, removedMemberships: 1, updatedMemberships: 0 },
    changes: [
      { date: '2026-12-03', shiftKind: 'DAY', dutyId: DUTY, version: 5, startsAt: '2026-12-03T05:00:00Z', endsAt: '2026-12-03T17:00:00Z', assignment: { id: 'a1000000-0000-4000-8000-000000000001', dutyRole: 'EMPLOYEE', source: 'NORMAL' } },
      { date: '2026-12-04', shiftKind: 'NIGHT', dutyId: NIGHT, version: 3, startsAt: '2026-12-04T17:00:00Z', endsAt: '2026-12-05T05:00:00Z', assignment: null },
      { date: '2026-12-10', shiftKind: 'NIGHT', dutyId: 'd0000000-0000-4000-8000-000000000a10', version: 1, startsAt: '2026-12-10T17:00:00Z', endsAt: '2026-12-11T05:00:00Z', assignment: { id: 'a1000000-0000-4000-8000-000000000002', dutyRole: 'EMPLOYEE', source: 'NORMAL' } },
    ],
    ...overrides,
  };
}

describe('A2 save receipt decoder', () => {
  it('accepts a receipt that answers exactly the request', () => {
    const result = toSaveResult(receipt(), PLAN_ID, MIRA_ID, sampleBody());
    expect(result.outcome).toBe('APPLIED');
    expect(result.changes.map((change) => [change.date, change.shiftKind, change.version])).toEqual([
      ['2026-12-03', 'DAY', 5], ['2026-12-04', 'NIGHT', 3], ['2026-12-10', 'NIGHT', 1],
    ]);
  });

  it('accepts a NO_OP receipt without changes', () => {
    const counts = { createdDuties: 0, changedDuties: 0, addedMemberships: 0, removedMemberships: 0, updatedMemberships: 0 };
    expect(toSaveResult(receipt({ outcome: 'NO_OP', counts, changes: [] }), PLAN_ID, MIRA_ID, sampleBody()).outcome).toBe('NO_OP');
  });

  const cases: [string, (value: ReturnType<typeof receipt>) => void][] = [
    ['another plan', (v) => { v.plan = { ...v.plan, id: 'ffffffff-0000-4000-8000-000000000000' }; }],
    ['another employee', (v) => { v.employeeId = 'ffffffff-0000-4000-8000-000000000000'; }],
    ['another month', (v) => { v.plan = { ...v.plan, monthStart: '2027-01-01' }; }],
    ['a lifecycle the request did not expect', (v) => { v.plan = { ...v.plan, status: 'PUBLISHED', publishedAt: '2026-11-20T08:00:00Z' }; }],
    ['an unknown outcome', (v) => { v.outcome = 'PARTIAL'; }],
    ['NO_OP with changes', (v) => { v.outcome = 'NO_OP'; }],
    ['counts that do not add up', (v) => { v.counts = { ...v.counts, createdDuties: 2, changedDuties: 1 }; }],
    ['membership counts that do not add up', (v) => { v.counts = { ...v.counts, removedMemberships: 0 }; }],
    ['changes out of order', (v) => { v.changes = [v.changes[1], v.changes[0], v.changes[2]]; }],
    ['a change for a date outside the request', (v) => { v.changes[2] = { ...v.changes[2], date: '2027-01-10' }; }],
    ['a changed duty that is not the expected one', (v) => { v.changes[0] = { ...v.changes[0], dutyId: 'd0000000-0000-4000-8000-0000000000ff' }; }],
    ['a changed duty without a higher version', (v) => { v.changes[0] = { ...v.changes[0], version: 4 }; }],
    ['a created duty not at version 1', (v) => { v.changes[2] = { ...v.changes[2], version: 2 }; }],
    ['a membership the request did not ask for', (v) => { v.changes[1] = { ...v.changes[1], assignment: { id: 'a1000000-0000-4000-8000-000000000009', dutyRole: 'EMPLOYEE', source: 'NORMAL' } }; }],
    ['a role the request did not ask for', (v) => { v.changes[0] = { ...v.changes[0], assignment: { id: 'a1000000-0000-4000-8000-000000000001', dutyRole: 'SHIFT_LEAD', source: 'NORMAL' } }; }],
    ['a duplicated duty', (v) => { v.changes[2] = { ...v.changes[2], dutyId: DUTY }; }],
    ['a completedAt that is no instant', (v) => { v.completedAt = 'yesterday'; }],
  ];
  it.each(cases)('rejects %s', (_name, mutate) => {
    const value = receipt();
    mutate(value);
    expect(invalidResponse(() => toSaveResult(value, PLAN_ID, MIRA_ID, sampleBody()))).toBe(true);
  });

  it('decodes the four lookup states and checks a COMPLETED receipt against the request', () => {
    const body = sampleBody();
    expect(toSaveResultLookup({ state: 'COMPLETED', result: receipt() }, PLAN_ID, MIRA_ID, body).state).toBe('COMPLETED');
    expect(toSaveResultLookup({ state: 'IN_PROGRESS', retryAfterSeconds: 1 }, PLAN_ID, MIRA_ID, body)).toEqual({ state: 'IN_PROGRESS', retryAfterSeconds: 1 });
    expect(toSaveResultLookup({ state: 'NOT_COMPLETED' }, PLAN_ID, MIRA_ID, body)).toEqual({ state: 'NOT_COMPLETED' });
    expect(toSaveResultLookup({ state: 'UNKNOWN' }, PLAN_ID, MIRA_ID, body)).toEqual({ state: 'UNKNOWN' });
    expect(invalidResponse(() => toSaveResultLookup({ state: 'COMPLETED', result: receipt({ employeeId: PLAN_ID }) }, PLAN_ID, MIRA_ID, body))).toBe(true);
    expect(invalidResponse(() => toSaveResultLookup({ state: 'IN_PROGRESS' }, PLAN_ID, MIRA_ID, body))).toBe(true);
    expect(invalidResponse(() => toSaveResultLookup({ state: 'DONE' }, PLAN_ID, MIRA_ID, body))).toBe(true);
  });
});

describe('A2 employee-month client', () => {
  it('reads, saves with the key header and looks up the outcome on exactly the documented routes', async () => {
    const body = sampleBody();
    const { api, requests } = fakeSessionApi((request) => {
      if (request.path.endsWith('/save')) return receipt();
      if (request.path.endsWith('/save-result')) return { state: 'UNKNOWN' };
      return wire();
    });
    const client = createEmployeeMonthApi(api);
    await client.read(PLAN_ID, MIRA_ID);
    await client.save(PLAN_ID, MIRA_ID, 'key-00000001', body);
    await client.saveResult(PLAN_ID, MIRA_ID, 'key-00000001', body);
    const base = `/api/v1/monthly-plans/${PLAN_ID}/employee-months/${MIRA_ID}`;
    expect(requests).toEqual([
      { path: base, method: 'GET', body: undefined },
      { path: `${base}/save`, method: 'POST', body, idempotencyKey: 'key-00000001' },
      { path: `${base}/save-result`, method: 'GET', body: undefined, idempotencyKey: 'key-00000001' },
    ]);
    // The body carries only the documented fields: no tenant, other people, sources or times.
    expect(Object.keys(requests[1].body as object).sort()).toEqual(['days', 'expectedCalendar', 'expectedCreationContext', 'expectedPlan']);
  });

  it('refuses a malformed key before sending', async () => {
    const { api, requests } = fakeSessionApi(() => receipt());
    const client = createEmployeeMonthApi(api);
    await expect(client.save(PLAN_ID, MIRA_ID, 'short', sampleBody())).rejects.toThrow('Idempotency-Key has an invalid format');
    await expect(client.saveResult(PLAN_ID, MIRA_ID, 'with space key', sampleBody())).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it('turns a receipt for another employee into a malformed answer, never a success', async () => {
    const { api } = fakeSessionApi(() => receipt({ employeeId: 'ffffffff-0000-4000-8000-000000000000' }));
    await expect(createEmployeeMonthApi(api).save(PLAN_ID, MIRA_ID, 'key-00000001', sampleBody()))
      .rejects.toMatchObject({ kind: 'invalid-response' });
  });
});
