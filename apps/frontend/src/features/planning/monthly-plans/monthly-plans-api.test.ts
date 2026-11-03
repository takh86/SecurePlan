import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../shared/api/api-error';
import { fakeSessionApi } from '../../employees/employees.test-support';
import { createMonthlyPlansApi, sortDuties, toDuty, toMonthlyPlan } from './monthly-plans-api';

// Synthetic example records, not business rules.
const PLAN = '0b5f0c1e-2d3a-4b4c-8d5e-6f7a8b9c0d1e';
const PROJECT = '7a2be0c4-1d3e-4f5a-8b6c-9d0e1f2a3b4c';
const EMPLOYEE = '6f1ad9a6-3a0c-4b7c-9c5e-0d4f2a1e8b11';
const SECOND = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const MEMBER = 'a1111111-1111-4111-8111-111111111111';
const DUTY = 'd1111111-1111-4111-8111-111111111111';

const planJson = (overrides: Record<string, unknown> = {}) => ({
  id: PLAN, projectId: PROJECT, monthStart: '2026-12-01', status: 'UNPUBLISHED', publishedAt: null, ...overrides,
});
const dutyJson = (overrides: Record<string, unknown> = {}) => ({
  id: DUTY,
  dutyDate: '2026-12-03',
  shiftKind: 'DAY',
  startsAt: '2026-12-03T05:00:00Z',
  endsAt: '2026-12-03T17:00:00Z',
  version: 1,
  assignments: [{ id: MEMBER, employeeId: EMPLOYEE, dutyRole: 'SHIFT_LEAD', source: 'NORMAL' }],
  availabilityConflicts: [],
  ...overrides,
});
const pageJson = (items: unknown[], totalPages = 1, page = 1) => ({
  items, pagination: { page, pageSize: 100, totalItems: items.length, totalPages },
});

function invalidResponse(error: unknown): boolean {
  return error instanceof ApiError && error.kind === 'invalid-response';
}

describe('SP-11 PR-2 — monthly plan response validation', () => {
  it('keeps only the documented plan fields and enforces the CR-03 lifecycle shape', () => {
    expect(toMonthlyPlan({ ...planJson(), companyId: 'x', version: 3 })).toEqual(planJson());
    expect(toMonthlyPlan(planJson({ status: 'PUBLISHED', publishedAt: '2026-11-30T12:00:00Z' })).status).toBe('PUBLISHED');
    for (const broken of [
      planJson({ status: 'DRAFT' }),
      planJson({ monthStart: '2026-12-02' }),
      planJson({ monthStart: '2026-13-01' }),
      planJson({ id: 'not-a-uuid' }),
      planJson({ status: 'PUBLISHED', publishedAt: null }),
      planJson({ publishedAt: '2026-11-30T12:00:00Z' }),
      planJson({ status: 'PUBLISHED', publishedAt: '30.11.2026' }),
    ]) {
      expect(() => toMonthlyPlan(broken), JSON.stringify(broken)).toThrow(ApiError);
    }
  });

  it('accepts a duty with members and neutral conflicts; never keeps extra conflict data', () => {
    const parsed = toDuty(dutyJson({
      availabilityConflicts: [{ code: 'EMPLOYEE_UNAVAILABLE', assignmentId: MEMBER, employeeId: EMPLOYEE, status: 'SICK' }],
      timeZone: 'Europe/Berlin',
    }));
    expect(parsed.availabilityConflicts).toEqual([{ code: 'EMPLOYEE_UNAVAILABLE', assignmentId: MEMBER, employeeId: EMPLOYEE }]);
    expect(JSON.stringify(parsed)).not.toMatch(/SICK|LEAVE|timeZone/);
  });

  it.each([
    ['an unknown shift kind', { shiftKind: 'EARLY' }],
    ['a local (non-UTC) instant', { startsAt: '2026-12-03T06:00:00+01:00' }],
    ['an empty interval', { endsAt: '2026-12-03T05:00:00Z' }],
    ['a reversed interval', { startsAt: '2026-12-03T18:00:00Z' }],
    ['a non-integer version', { version: 1.5 }],
    ['an unsafe version', { version: 2 ** 53 }],
    ['a zero version', { version: 0 }],
    ['an impossible date', { dutyDate: '2026-12-32' }],
    ['an unknown duty role', { assignments: [{ id: MEMBER, employeeId: EMPLOYEE, dutyRole: 'ADMIN', source: 'NORMAL' }] }],
    ['the same employee twice', {
      assignments: [
        { id: MEMBER, employeeId: EMPLOYEE, dutyRole: 'EMPLOYEE', source: 'NORMAL' },
        { id: DUTY, employeeId: EMPLOYEE.toUpperCase(), dutyRole: 'EMPLOYEE', source: 'NORMAL' },
      ],
    }],
    ['a conflict for a non-member', { availabilityConflicts: [{ code: 'EMPLOYEE_UNAVAILABLE', assignmentId: DUTY, employeeId: EMPLOYEE }] }],
    ['a conflict naming another employee', { availabilityConflicts: [{ code: 'EMPLOYEE_UNAVAILABLE', assignmentId: MEMBER, employeeId: SECOND }] }],
    ['a reason code instead of the neutral one', { availabilityConflicts: [{ code: 'EMPLOYEE_SICK', assignmentId: MEMBER, employeeId: EMPLOYEE }] }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => toDuty(dutyJson(overrides))).toThrow(ApiError);
  });

  it('orders duties by date, DAY before NIGHT', () => {
    const night = toDuty(dutyJson({ id: 'd2222222-2222-4222-8222-222222222222', shiftKind: 'NIGHT', startsAt: '2026-12-03T17:00:00Z', endsAt: '2026-12-04T05:00:00Z' }));
    const day = toDuty(dutyJson());
    const earlier = toDuty(dutyJson({ id: 'd3333333-3333-4333-8333-333333333333', dutyDate: '2026-12-01', startsAt: '2026-12-01T05:00:00Z', endsAt: '2026-12-01T17:00:00Z' }));
    expect(sortDuties([night, day, earlier]).map((item) => item.id)).toEqual([earlier.id, day.id, night.id]);
  });
});

describe('SP-11 PR-2 — monthly plan requests', () => {
  it('reads every page of one month and never sends tenant or role', async () => {
    const second = planJson({ id: 'e1111111-1111-4111-8111-111111111111', projectId: SECOND });
    const { api, requests } = fakeSessionApi((request) =>
      request.path.includes('page=2') ? pageJson([second], 2, 2) : pageJson([planJson()], 2));
    const plans = await createMonthlyPlansApi(api).listMonth('2026-12');
    expect(plans.map((item) => item.id)).toEqual([PLAN, second.id]);
    expect(requests.map((request) => [request.method, request.path])).toEqual([
      ['GET', '/api/v1/monthly-plans?monthStart=2026-12-01&pageSize=100'],
      ['GET', '/api/v1/monthly-plans?monthStart=2026-12-01&pageSize=100&page=2'],
    ]);
  });

  it('rejects a month list that contains another month or two plans of one project', async () => {
    for (const items of [[planJson({ monthStart: '2027-01-01' })], [planJson(), planJson({ id: 'e1111111-1111-4111-8111-111111111111' })]]) {
      const { api } = fakeSessionApi(() => pageJson(items));
      await expect(createMonthlyPlansApi(api).listMonth('2026-12')).rejects.toSatisfy(invalidResponse);
    }
  });

  it('creates a plan with exactly projectId and monthStart and checks the answer', async () => {
    const { api, requests } = fakeSessionApi(() => planJson());
    const created = await createMonthlyPlansApi(api).create(PROJECT, '2026-12');
    expect(created.status).toBe('UNPUBLISHED');
    expect(requests).toEqual([{ path: '/api/v1/monthly-plans', method: 'POST', body: { projectId: PROJECT, monthStart: '2026-12-01' } }]);

    for (const answer of [planJson({ monthStart: '2027-01-01' }), planJson({ projectId: SECOND })]) {
      const { api: other } = fakeSessionApi(() => answer);
      await expect(createMonthlyPlansApi(other).create(PROJECT, '2026-12')).rejects.toSatisfy(invalidResponse);
    }
  });

  it('reads one plan by encoded id and rejects an answer for another plan', async () => {
    const { api, requests } = fakeSessionApi(() => planJson());
    await createMonthlyPlansApi(api).get(PLAN);
    expect(requests[0].path).toBe(`/api/v1/monthly-plans/${PLAN}`);
    const { api: other } = fakeSessionApi(() => planJson({ id: 'e1111111-1111-4111-8111-111111111111' }));
    await expect(createMonthlyPlansApi(other).get(PLAN)).rejects.toSatisfy(invalidResponse);
    const { api: encoded, requests: sent } = fakeSessionApi(() => planJson());
    await createMonthlyPlansApi(encoded).get('a/b?c').catch(() => undefined);
    expect(sent[0].path).toBe('/api/v1/monthly-plans/a%2Fb%3Fc');
  });

  it('lists duties sorted and rejects two live duties in one slot', async () => {
    const night = dutyJson({ id: 'd2222222-2222-4222-8222-222222222222', shiftKind: 'NIGHT', startsAt: '2026-12-03T17:00:00Z', endsAt: '2026-12-04T05:00:00Z' });
    const { api, requests } = fakeSessionApi(() => ({ items: [night, dutyJson()] }));
    const duties = await createMonthlyPlansApi(api).listDuties(PLAN);
    expect(duties.map((item) => item.shiftKind)).toEqual(['DAY', 'NIGHT']);
    expect(requests).toEqual([{ path: `/api/v1/monthly-plans/${PLAN}/entries`, method: 'GET', body: undefined }]);
    const { api: twice } = fakeSessionApi(() => ({ items: [dutyJson(), dutyJson({ id: 'd2222222-2222-4222-8222-222222222222' })] }));
    await expect(createMonthlyPlansApi(twice).listDuties(PLAN)).rejects.toSatisfy(invalidResponse);
  });

  it('creates a duty with only date, kind and the selected members', async () => {
    const { api, requests } = fakeSessionApi(() => dutyJson());
    await createMonthlyPlansApi(api).createDuty(PLAN, {
      dutyDate: '2026-12-03',
      shiftKind: 'DAY',
      assignments: [{ employeeId: EMPLOYEE, dutyRole: 'SHIFT_LEAD', extra: 'x' } as never],
    });
    expect(requests).toEqual([{
      path: `/api/v1/monthly-plans/${PLAN}/entries`,
      method: 'POST',
      body: { dutyDate: '2026-12-03', shiftKind: 'DAY', assignments: [{ employeeId: EMPLOYEE, dutyRole: 'SHIFT_LEAD' }] },
    }]);
  });

  it.each([
    ['another date', dutyJson({ dutyDate: '2026-12-04', startsAt: '2026-12-04T05:00:00Z', endsAt: '2026-12-04T17:00:00Z' })],
    ['another kind', dutyJson({ shiftKind: 'NIGHT' })],
    ['another role', dutyJson({ assignments: [{ id: MEMBER, employeeId: EMPLOYEE, dutyRole: 'EMPLOYEE', source: 'NORMAL' }] })],
    ['a missing member', dutyJson({ assignments: [] })],
    ['an extra member', dutyJson({
      assignments: [
        { id: MEMBER, employeeId: EMPLOYEE, dutyRole: 'SHIFT_LEAD', source: 'NORMAL' },
        { id: DUTY, employeeId: SECOND, dutyRole: 'EMPLOYEE', source: 'NORMAL' },
      ],
    })],
  ])('rejects a created duty with %s than requested', async (_label, answer) => {
    const { api } = fakeSessionApi(() => answer);
    await expect(createMonthlyPlansApi(api).createDuty(PLAN, {
      dutyDate: '2026-12-03', shiftKind: 'DAY', assignments: [{ employeeId: EMPLOYEE, dutyRole: 'SHIFT_LEAD' }],
    })).rejects.toSatisfy(invalidResponse);
  });
});

describe('SP-12 — single duty, edits, removal and edit leases (ADR-0006)', () => {
  const TOKEN = 'T'.repeat(42) + '_';
  const DUTY_URL = `/api/v1/monthly-plans/${PLAN}/entries/${DUTY}`;
  const LEASE_URL = `${DUTY_URL}/edit-lease`;
  const leaseJson = (overrides: Record<string, unknown> = {}) => ({ leaseToken: TOKEN, expiresAt: '2026-12-03T08:02:00.123456Z', ...overrides });

  it('reads one duty of the plan and rejects an answer for another duty', async () => {
    const { api, requests } = fakeSessionApi(() => dutyJson());
    expect((await createMonthlyPlansApi(api).getDuty(PLAN, DUTY)).id).toBe(DUTY);
    expect(requests).toEqual([{ path: DUTY_URL, method: 'GET', body: undefined }]);
    const { api: other } = fakeSessionApi(() => dutyJson({ id: 'd2222222-2222-4222-8222-222222222222' }));
    await expect(createMonthlyPlansApi(other).getDuty(PLAN, DUTY)).rejects.toSatisfy(invalidResponse);
  });

  it('PATCH sends only the changed fields, Expected-Version and the lease token as headers', async () => {
    const answer = dutyJson({ version: 2, assignments: [{ id: MEMBER, employeeId: EMPLOYEE, dutyRole: 'EMPLOYEE', source: 'NORMAL' }] });
    const { api, requests } = fakeSessionApi(() => answer);
    await createMonthlyPlansApi(api).updateDuty(PLAN, DUTY, {
      assignments: [{ employeeId: EMPLOYEE, dutyRole: 'EMPLOYEE', extra: true } as never],
    }, 1, TOKEN);
    expect(requests).toEqual([{
      path: DUTY_URL,
      method: 'PATCH',
      body: { assignments: [{ employeeId: EMPLOYEE, dutyRole: 'EMPLOYEE' }] },
      expectedVersion: 1,
      editLeaseToken: TOKEN,
    }]);
    // The token travels only as a header: never in the path or body.
    expect(JSON.stringify(requests[0].body)).not.toContain(TOKEN);
    expect(requests[0].path).not.toContain(TOKEN);
  });

  // The requested move: 4 Dec, night duty (synthetic instants).
  const moved = { dutyDate: '2026-12-04', shiftKind: 'NIGHT', startsAt: '2026-12-04T17:00:00Z', endsAt: '2026-12-05T05:00:00Z', version: 3 };

  it('accepts the requested move at a newer version', async () => {
    const { api } = fakeSessionApi(() => dutyJson(moved));
    const saved = await createMonthlyPlansApi(api).updateDuty(PLAN, DUTY, { dutyDate: '2026-12-04', shiftKind: 'NIGHT' }, 2, TOKEN);
    expect([saved.dutyDate, saved.shiftKind, saved.version]).toEqual(['2026-12-04', 'NIGHT', 3]);
  });

  it.each([
    ['another duty', dutyJson({ ...moved, id: 'd2222222-2222-4222-8222-222222222222' })],
    ['an older version', dutyJson({ ...moved, version: 1 })],
    ['another date than requested', dutyJson({ ...moved, dutyDate: '2026-12-05', startsAt: '2026-12-05T17:00:00Z', endsAt: '2026-12-06T05:00:00Z' })],
    ['another kind than requested', dutyJson({ ...moved, shiftKind: 'DAY', startsAt: '2026-12-04T05:00:00Z', endsAt: '2026-12-04T17:00:00Z' })],
  ])('rejects a PATCH answer with %s', async (_label, answer) => {
    const { api } = fakeSessionApi(() => answer);
    await expect(createMonthlyPlansApi(api).updateDuty(PLAN, DUTY, { dutyDate: '2026-12-04', shiftKind: 'NIGHT' }, 2, TOKEN))
      .rejects.toSatisfy(invalidResponse);
  });

  it('DELETE of a duty carries Expected-Version and the token; no body', async () => {
    const { api, requests } = fakeSessionApi(() => undefined);
    await createMonthlyPlansApi(api).removeDuty(PLAN, DUTY, 7, TOKEN);
    expect(requests).toEqual([{ path: DUTY_URL, method: 'DELETE', body: undefined, expectedVersion: 7, editLeaseToken: TOKEN }]);
  });

  it('acquire/renew/release use the lease sub-resource; renew and release send the token, acquire none', async () => {
    const { api, requests } = fakeSessionApi((request) => (request.method === 'DELETE' ? undefined : leaseJson()));
    const plans = createMonthlyPlansApi(api);
    expect(await plans.acquireLease(PLAN, DUTY)).toEqual(leaseJson());
    expect(await plans.renewLease(PLAN, DUTY, TOKEN)).toEqual(leaseJson());
    await plans.releaseLease(PLAN, DUTY, TOKEN, { keepalive: true });
    expect(requests).toEqual([
      { path: LEASE_URL, method: 'POST', body: undefined },
      { path: LEASE_URL, method: 'PUT', body: undefined, editLeaseToken: TOKEN },
      { path: LEASE_URL, method: 'DELETE', body: undefined, editLeaseToken: TOKEN, keepalive: true },
    ]);
  });

  it.each([
    ['a short token', leaseJson({ leaseToken: 'abc' })],
    ['a token with padding', leaseJson({ leaseToken: `${'T'.repeat(42)}=` })],
    ['a missing expiry', leaseJson({ expiresAt: undefined })],
    ['a local-time expiry', leaseJson({ expiresAt: '2026-12-03T09:02:00+01:00' })],
    ['an impossible expiry', leaseJson({ expiresAt: '2026-13-03T08:02:00Z' })],
  ])('rejects a lease grant with %s', async (_label, answer) => {
    const { api } = fakeSessionApi(() => answer);
    await expect(createMonthlyPlansApi(api).acquireLease(PLAN, DUTY)).rejects.toSatisfy(invalidResponse);
  });

  it('a renewal must extend the same token (rotation would be a contract defect)', async () => {
    const { api } = fakeSessionApi(() => leaseJson({ leaseToken: 'U'.repeat(43) }));
    await expect(createMonthlyPlansApi(api).renewLease(PLAN, DUTY, TOKEN)).rejects.toSatisfy(invalidResponse);
  });

  it('keeps only the two documented lease fields', async () => {
    const { api } = fakeSessionApi(() => leaseJson({ ownerAccountId: EMPLOYEE, tokenHash: 'x' }));
    expect(await createMonthlyPlansApi(api).acquireLease(PLAN, DUTY)).toEqual(leaseJson());
  });
});
