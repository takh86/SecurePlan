import { describe, expect, it } from 'vitest';
import { parseApiError } from './api-error';

function problem(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/problem+json', 'x-correlation-id': 'req-a2' },
  });
}

const VALIDATION = {
  type: 'about:blank',
  title: 'Conflict',
  status: 409,
  detail: 'The employee month could not be saved. Review the conflicts.',
  code: 'EMPLOYEE_MONTH_SAVE_CONFLICT',
  correlationId: 'req-a2',
  atomic: true,
  stage: 'VALIDATION',
  conflicts: [
    { date: '2026-12-03', shiftKind: 'DAY', reason: 'EMPLOYEE_UNAVAILABLE' },
    { date: '2026-12-03', shiftKind: 'NIGHT', reason: 'PRESERVED_ROSTER_CONFLICT' },
    { date: '2026-12-10', shiftKind: 'DAY', reason: 'PROJECT_CLOSED_WEEKDAY' },
  ],
};

describe('A2 — atomic employee-month conflict extension (A2-GATE-1)', () => {
  it('keeps the allowlisted stage and dated reasons of EMPLOYEE_MONTH_SAVE_CONFLICT, never server text', async () => {
    const error = await parseApiError(problem(409, VALIDATION));
    expect(error.code).toBe('EMPLOYEE_MONTH_SAVE_CONFLICT');
    expect(error.employeeMonthConflict).toEqual({
      stage: 'VALIDATION',
      conflicts: [
        { date: '2026-12-03', shiftKind: 'DAY', reason: 'EMPLOYEE_UNAVAILABLE' },
        { date: '2026-12-03', shiftKind: 'NIGHT', reason: 'PRESERVED_ROSTER_CONFLICT' },
        { date: '2026-12-10', shiftKind: 'DAY', reason: 'PROJECT_CLOSED_WEEKDAY' },
      ],
    });
    expect(JSON.stringify(error.employeeMonthConflict)).not.toContain('Review the conflicts');
  });

  it('accepts PRECONDITION only with PLAN_CONCURRENT_MODIFICATION, also with an empty list', async () => {
    const stale = await parseApiError(problem(409, {
      code: 'PLAN_CONCURRENT_MODIFICATION', atomic: true, stage: 'PRECONDITION',
      conflicts: [{ date: '2026-12-04', shiftKind: 'NIGHT', reason: 'PLAN_CONCURRENT_MODIFICATION' }],
    }));
    expect(stale.employeeMonthConflict).toEqual({ stage: 'PRECONDITION', conflicts: [{ date: '2026-12-04', shiftKind: 'NIGHT', reason: 'PLAN_CONCURRENT_MODIFICATION' }] });
    const unidentified = await parseApiError(problem(409, { code: 'PLAN_CONCURRENT_MODIFICATION', atomic: true, stage: 'PRECONDITION', conflicts: [] }));
    expect(unidentified.employeeMonthConflict).toEqual({ stage: 'PRECONDITION', conflicts: [] });
    // The SP-12 duty conflict carries no extension and stays as before.
    expect((await parseApiError(problem(409, { code: 'PLAN_CONCURRENT_MODIFICATION' }))).employeeMonthConflict).toBeUndefined();
  });

  const malformed: [string, Record<string, unknown>][] = [
    ['without atomic', { atomic: undefined }],
    ['an unknown stage', { stage: 'COMMIT' }],
    ['PRECONDITION under the save-conflict code', { stage: 'PRECONDITION' }],
    ['a free-text reason', { conflicts: [{ date: '2026-12-03', shiftKind: 'DAY', reason: 'Krank bis Freitag' }] }],
    ['a reason of another stage', { conflicts: [{ date: '2026-12-03', shiftKind: 'DAY', reason: 'ACTIVE_DUTY_EDIT' }] }],
    ['an impossible date', { conflicts: [{ date: '2026-02-30', shiftKind: 'DAY', reason: 'EMPLOYEE_UNAVAILABLE' }] }],
    ['an unknown shift kind', { conflicts: [{ date: '2026-12-03', shiftKind: 'BOTH', reason: 'EMPLOYEE_UNAVAILABLE' }] }],
    ['a duplicate slot', { conflicts: [VALIDATION.conflicts[0], VALIDATION.conflicts[0]] }],
    ['an unsorted list', { conflicts: [VALIDATION.conflicts[2], VALIDATION.conflicts[0]] }],
    ['more than 62 entries', { conflicts: Array.from({ length: 63 }, (_, index) => ({ date: '2026-12-01', shiftKind: 'DAY', reason: `R${index}` })) }],
    ['a non-array list', { conflicts: 'none' }],
  ];
  it.each(malformed)('drops an extension with %s as a unit (the refusal itself stays)', async (_name, change) => {
    const error = await parseApiError(problem(409, { ...VALIDATION, ...change }));
    expect(error.code).toBe('EMPLOYEE_MONTH_SAVE_CONFLICT');
    expect(error.employeeMonthConflict).toBeUndefined();
  });

  it('trusts the new code only with 409 and never attaches the extension to other codes', async () => {
    expect((await parseApiError(problem(400, VALIDATION))).code).toBeNull();
    const other = await parseApiError(problem(409, { ...VALIDATION, code: 'DUTY_ASSIGNMENT_CONFLICT' }));
    expect(other.code).toBe('DUTY_ASSIGNMENT_CONFLICT');
    expect(other.employeeMonthConflict).toBeUndefined();
  });
});
