import { describe, expect, it } from 'vitest';
import { ApiError, type KnownErrorCode } from '../../../shared/api/api-error';
import {
  dutiesSignature,
  newIdempotencyKey,
  publishNeedsReload,
  publishOutcomeUnknown,
  publishSummary,
} from './initial-publish';
import type { Duty } from './monthly-plan-types';

// Synthetic example duties, not business rules.
const MIRA = '6f1ad9a6-3a0c-4b7c-9c5e-0d4f2a1e8b11';
const JONAS = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const day = (overrides: Partial<Duty> = {}): Duty => ({
  id: 'd1111111-1111-4111-8111-111111111111',
  dutyDate: '2026-12-03',
  shiftKind: 'DAY',
  startsAt: '2026-12-03T05:00:00Z',
  endsAt: '2026-12-03T17:00:00Z',
  version: 1,
  assignments: [
    { id: 'a1111111-1111-4111-8111-111111111111', employeeId: MIRA, dutyRole: 'SHIFT_LEAD', source: 'NORMAL' },
    { id: 'a2222222-2222-4222-8222-222222222222', employeeId: JONAS, dutyRole: 'EMPLOYEE', source: 'NORMAL' },
  ],
  availabilityConflicts: [],
  ...overrides,
});
const night = (overrides: Partial<Duty> = {}): Duty => ({
  id: 'd2222222-2222-4222-8222-222222222222',
  dutyDate: '2026-12-31',
  shiftKind: 'NIGHT',
  startsAt: '2026-12-31T17:00:00Z',
  endsAt: '2027-01-01T05:00:00Z',
  version: 3,
  assignments: [{ id: 'a3333333-3333-4333-8333-333333333333', employeeId: MIRA, dutyRole: 'EMPLOYEE', source: 'NORMAL' }],
  availabilityConflicts: [],
  ...overrides,
});
const http = (status: number, code: KnownErrorCode | null = null) => new ApiError('http', status, code, 'req-13');

describe('SP-13 First Publish — dialog summary', () => {
  it('counts duties, unstaffed duties, distinct people and neutral unavailability hints', () => {
    const conflict = { code: 'EMPLOYEE_UNAVAILABLE' as const, assignmentId: 'a2222222-2222-4222-8222-222222222222', employeeId: JONAS };
    expect(publishSummary([day({ availabilityConflicts: [conflict] }), night(), night({ id: 'd3333333-3333-4333-8333-333333333333', dutyDate: '2026-12-30', assignments: [] })]))
      .toEqual({ duties: 3, unstaffed: 1, people: 2, unavailable: 1 });
  });

  it('an empty plan is a valid summary (no minimum)', () => {
    expect(publishSummary([])).toEqual({ duties: 0, unstaffed: 0, people: 0, unavailable: 0 });
  });

  it('counts a person once regardless of id case', () => {
    expect(publishSummary([day(), night({ assignments: [{ id: 'a4', employeeId: MIRA.toUpperCase(), dutyRole: 'EMPLOYEE', source: 'NORMAL' }] })]).people).toBe(2);
  });
});

describe('SP-13 First Publish — has the plan changed since the admin saw it?', () => {
  it('ignores order and id case', () => {
    const reordered = day({ id: day().id.toUpperCase(), assignments: [...day().assignments].reverse() });
    expect(dutiesSignature([day(), night()])).toBe(dutiesSignature([night(), reordered]));
  });

  it.each([
    ['a new duty', [day(), night(), night({ id: 'd9999999-9999-4999-8999-999999999999', dutyDate: '2026-12-10' })]],
    ['a removed duty', [day()]],
    ['a new version', [day({ version: 2 }), night()]],
    ['a moved date', [day({ dutyDate: '2026-12-04' }), night()]],
    ['another kind', [day({ shiftKind: 'NIGHT' }), night()]],
    ['another interval', [day({ endsAt: '2026-12-03T18:00:00Z' }), night()]],
    ['a removed member', [day({ assignments: [day().assignments[0]] }), night()]],
    ['another role', [day({ assignments: [{ ...day().assignments[0], dutyRole: 'EMPLOYEE' }, day().assignments[1]] }), night()]],
    ['a replacement source', [day({ assignments: [day().assignments[0], { ...day().assignments[1], source: 'REPLACEMENT' }] }), night()]],
    ['a new unavailability (no new version)', [day({ availabilityConflicts: [{ code: 'EMPLOYEE_UNAVAILABLE', assignmentId: day().assignments[1].id, employeeId: JONAS }] }), night()]],
  ] as const)('detects %s', (_label, changed) => {
    expect(dutiesSignature(changed as readonly Duty[])).not.toBe(dutiesSignature([day(), night()]));
  });
});

describe('SP-13 First Publish — outcome classification', () => {
  it.each([
    ['no response', new ApiError('network', null, null, null)],
    ['an unreadable response', new ApiError('invalid-response', 200, null, null)],
    ['a technical 500', http(500, 'INTERNAL_ERROR')],
    ['a 502 gateway', http(502)],
    ['a 503', http(503, 'SERVICE_UNAVAILABLE')],
    ['rate limiting', http(429, 'RATE_LIMITED')],
    ['a running claim', http(409, 'IDEMPOTENCY_REQUEST_IN_PROGRESS')],
    ['a non-API error', new Error('unexpected')],
  ])('%s leaves the outcome unknown (keep the key)', (_label, error) => {
    expect(publishOutcomeUnknown(error)).toBe(true);
    expect(publishNeedsReload(error)).toBe(false);
  });

  it.each([
    [409, 'MONTHLY_PLAN_ALREADY_PUBLISHED', true],
    [409, 'PLAN_CONCURRENT_MODIFICATION', true],
    [409, 'PROJECT_INACTIVE', true],
    [409, 'SHIFT_CONFIGURATION_MISSING', true],
    [409, 'EMPLOYEE_UNAVAILABLE', true],
    [409, 'DUTY_ASSIGNMENT_CONFLICT', true],
    [409, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST', true],
    [404, 'RESOURCE_NOT_FOUND', true],
    [400, 'IDEMPOTENCY_KEY_INVALID', false],
    [400, 'INVALID_REQUEST_BODY', false],
    [401, 'SESSION_EXPIRED', false],
    [403, 'ACTION_FORBIDDEN', false],
    [403, 'CSRF_VALIDATION_FAILED', false],
  ] as const)('%s %s is a definitive refusal (reload: %s)', (status, code, reload) => {
    expect(publishOutcomeUnknown(http(status, code))).toBe(false);
    expect(publishNeedsReload(http(status, code))).toBe(reload);
  });

  it('creates a fresh UUIDv4 key per decision (valid Phase 8.7 syntax)', () => {
    const first = newIdempotencyKey();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first).toMatch(/^[\x21-\x7e]{8,128}$/);
    expect(newIdempotencyKey()).not.toBe(first);
  });
});
