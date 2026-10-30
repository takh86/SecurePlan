import { describe, expect, it } from 'vitest';
import { createAvailabilityApi, rangeCount, type AvailabilitySelection } from './availability-api';
import { fakeSessionApi, EMPLOYEE_ID } from './employees.test-support';
import { createSessionApi } from '../auth/session-api';
import { vi } from 'vitest';

const input: AvailabilitySelection = { operation: 'SET', fromDate: '2026-10-28', toDate: '2026-10-29', status: 'SICK' };
const preview = () => ({ ...input, conflictPolicy: 'REJECT', employeeId: EMPLOYEE_ID, previewToken: 't'.repeat(43),
  expiresAt: new Date(Date.now() + 600_000).toISOString(), canCommit: true,
  days: ['2026-10-28', '2026-10-29'].map((day) => ({ day, currentStatus: null, effect: 'CREATE' })) });
describe('SP-10 API shape and command boundary', () => {
  it('reads a month and strips extra server fields', async () => {
    const { api, requests } = fakeSessionApi(() => ({ items: [{ employeeId: EMPLOYEE_ID, day: '2026-10-28', status: 'SICK', unexpected: 'private' }] }));
    expect(await createAvailabilityApi(api).list(EMPLOYEE_ID, '2026-10-01')).toEqual([{ employeeId: EMPLOYEE_ID, day: '2026-10-28', status: 'SICK' }]);
    expect(requests[0].path).toBe(`/api/v1/employees/${EMPLOYEE_ID}/availability?monthStart=2026-10-01`);
  });
  it.each([
    [{ employeeId: EMPLOYEE_ID, day: '2026-11-01', status: 'SICK' }],
    [{ employeeId: 'foreign', day: '2026-10-01', status: 'SICK' }],
    [{ employeeId: EMPLOYEE_ID, day: '2026-10-01', status: 'KRANK' }],
    [{ employeeId: EMPLOYEE_ID, day: '2026-10-01', status: 'SICK' }, { employeeId: EMPLOYEE_ID, day: '2026-10-01', status: 'LEAVE' }],
  ])('refuses malformed month results %j', async (...items) => {
    const { api } = fakeSessionApi(() => ({ items }));
    await expect(createAvailabilityApi(api).list(EMPLOYEE_ID, '2026-10-01')).rejects.toMatchObject({ kind: 'invalid-response' });
  });
  it('accepts a bound complete preview and sends no tenant identifiers', async () => {
    const { api, requests } = fakeSessionApi(() => preview());
    expect((await createAvailabilityApi(api).preview(EMPLOYEE_ID, input)).days).toHaveLength(2);
    expect(requests[0]).toEqual({ path: `/api/v1/employees/${EMPLOYEE_ID}/availability/preview`, method: 'POST', body: input });
  });
  it.each(['employee', 'missing-day', 'wrong-effect', 'wrong-status', 'bad-token', 'canCommit', 'wrong-policy'])('rejects unbound/invalid preview %s', async (kind) => {
    const response = preview();
    if (kind === 'employee') response.employeeId = 'foreign';
    if (kind === 'missing-day') response.days.pop();
    if (kind === 'wrong-effect') response.days[0].effect = 'REPLACE';
    if (kind === 'wrong-status') response.status = 'LEAVE';
    if (kind === 'bad-token') response.previewToken = 'short';
    if (kind === 'canCommit') response.canCommit = false;
    if (kind === 'wrong-policy') response.conflictPolicy = 'REPLACE';
    const { api } = fakeSessionApi(() => response);
    await expect(createAvailabilityApi(api).preview(EMPLOYEE_ID, input)).rejects.toMatchObject({ kind: 'invalid-response' });
  });
  it('sends one idempotency key, original intent and exact retry body', async () => {
    const { api, requests } = fakeSessionApi(() => ({ employeeId: EMPLOYEE_ID, changedDayCount: 2, unchangedDayCount: 0 }));
    const client = createAvailabilityApi(api); const body = { ...input, previewToken: 't'.repeat(43) };
    await client.commit(EMPLOYEE_ID, body, 'same-intent-key'); await client.commit(EMPLOYEE_ID, body, 'same-intent-key');
    expect(requests[0]).toEqual(requests[1]); expect(requests[0].idempotencyKey).toBe('same-intent-key');
  });
  it('rejects result counts that could falsely acknowledge a complete batch', async () => {
    const { api } = fakeSessionApi(() => ({ employeeId: EMPLOYEE_ID, changedDayCount: 1, unchangedDayCount: 0 }));
    await expect(createAvailabilityApi(api).commit(EMPLOYEE_ID, { ...input, previewToken: 't'.repeat(43) }, 'key-1234')).rejects.toMatchObject({ kind: 'invalid-response' });
  });
  it('calendar bounds are inclusive across leap/year dates', () => {
    expect(rangeCount('2026-10-01', '2027-01-01')).toBe(93);
    expect(rangeCount('2026-10-01', '2027-01-02')).toBe(94);
    expect(rangeCount('2028-02-28', '2028-03-01')).toBe(3);
    expect(rangeCount('2027-02-29', '2027-03-01')).toBe(0);
  });
  it('the session transport actually emits Idempotency-Key and CSRF without an implicit retry', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ employeeId: EMPLOYEE_ID, changedDayCount: 2, unchangedDayCount: 0 }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    try {
      await createSessionApi('csrf-synthetic', vi.fn()).request('/api/v1/employees/test/availability/batch', { method: 'POST', body: {}, idempotencyKey: 'one-key-only' });
      expect(fetch).toHaveBeenCalledTimes(1);
      const headers = new Headers(fetch.mock.calls[0][1].headers);
      expect(headers.get('Idempotency-Key')).toBe('one-key-only'); expect(headers.get('X-CSRF-Token')).toBe('csrf-synthetic');
    } finally { vi.unstubAllGlobals(); }
  });
});
