import { describe, expect, it } from 'vitest';
import { ApiError, describeApiError, parseApiError } from './api-error';

function problem(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/problem+json', 'x-correlation-id': 'req-1' },
  });
}

describe('SP-07 — field errors and employee codes', () => {
  it('keeps only well-formed pointer/subcode pairs from VALIDATION_FAILED, never server text', async () => {
    const error = await parseApiError(problem(400, {
      code: 'VALIDATION_FAILED',
      errors: [
        { pointer: '#/employeeCode', code: 'TOO_LONG', detail: '<b>server text</b>' },
        { pointer: 'employeeCode', code: 'TOO_LONG' },
        { pointer: '#/email', code: 'MADE_UP' },
        { pointer: '#/firstName', code: 'REQUIRED' },
        'garbage',
      ],
    }));
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.fieldErrors).toEqual([
      { pointer: '#/employeeCode', code: 'TOO_LONG' },
      { pointer: '#/firstName', code: 'REQUIRED' },
    ]);
    expect(JSON.stringify(error.fieldErrors)).not.toContain('server text');
  });

  it('ignores errors[] on other codes', async () => {
    const error = await parseApiError(problem(409, { code: 'EMPLOYEE_CODE_ALREADY_EXISTS', errors: [{ pointer: '#/x', code: 'REQUIRED' }] }));
    expect(error.code).toBe('EMPLOYEE_CODE_ALREADY_EXISTS');
    expect(error.fieldErrors).toEqual([]);
  });

  it('trusts the new codes only with their catalogued status', async () => {
    expect((await parseApiError(problem(409, { code: 'EMAIL_ALREADY_IN_USE' }))).code).toBe('EMAIL_ALREADY_IN_USE');
    expect((await parseApiError(problem(400, { code: 'EMAIL_ALREADY_IN_USE' }))).code).toBeNull();
    expect((await parseApiError(problem(400, { code: 'EMPTY_PATCH' }))).code).toBe('EMPTY_PATCH');
    expect((await parseApiError(problem(409, { code: 'EMPLOYEE_INACTIVE' }))).code).toBe('EMPLOYEE_INACTIVE');
  });

  it('describes e-mail conflicts neutrally (no hint where the address is registered)', () => {
    const text = describeApiError(new ApiError('http', 409, 'EMAIL_ALREADY_IN_USE', 'req-1'));
    expect(text.title).toBe('E-Mail-Adresse nicht verwendbar');
    expect(`${text.title} ${text.description}`).not.toMatch(/Unternehmen|Firma|anderen|existiert|registriert/i);
    expect(text.correlationId).toBe('req-1');
  });

  it('trusts the SP-11 dependency codes only as 409, with specific texts and no retry', async () => {
    for (const code of ['PROJECT_HAS_FUTURE_DUTIES', 'EMPLOYMENT_PERIOD_EXCLUDES_FUTURE_DUTIES'] as const) {
      expect((await parseApiError(problem(409, { code }))).code).toBe(code);
      expect((await parseApiError(problem(400, { code }))).code).toBeNull();
      const text = describeApiError(new ApiError('http', 409, code, 'req-11'));
      expect(text.title, code).not.toBe('Konflikt');
      expect(text.canRetry, code).toBe(false);
      expect(text.correlationId).toBe('req-11');
    }
  });

  it('SP-11 PR-2: trusts the planning creation codes only with their catalogued status', async () => {
    const byStatus = {
      400: ['INVALID_DATE', 'DUTY_DATE_OUTSIDE_PLAN_MONTH'],
      409: [
        'MONTHLY_PLAN_ALREADY_EXISTS',
        'DUTY_ALREADY_EXISTS',
        'SHIFT_CONFIGURATION_MISSING',
        'DUTY_TIME_RANGE_INVALID',
        'EMPLOYEE_NOT_ASSIGNED_TO_PROJECT_MONTH',
        'EMPLOYEE_NOT_ELIGIBLE_FOR_SHIFT',
        'EMPLOYEE_UNAVAILABLE',
        'DUTY_ASSIGNMENT_CONFLICT',
      ],
    } as const;
    for (const [status, codes] of Object.entries(byStatus)) {
      for (const code of codes) {
        expect((await parseApiError(problem(Number(status), { code }))).code, code).toBe(code);
        expect((await parseApiError(problem(Number(status) === 400 ? 409 : 400, { code }))).code, code).toBeNull();
      }
    }
    // Codes of later slices stay untrusted until a UI handles them.
    expect((await parseApiError(problem(409, { code: 'CANCELLATION_ALREADY_EXISTS' }))).code).toBeNull();
  });

  it('SP-13: trusts MONTHLY_PLAN_ALREADY_PUBLISHED only with its catalogued 409', async () => {
    expect((await parseApiError(problem(409, { code: 'MONTHLY_PLAN_ALREADY_PUBLISHED' }))).code).toBe('MONTHLY_PLAN_ALREADY_PUBLISHED');
    for (const status of [400, 404, 500]) {
      expect((await parseApiError(problem(status, { code: 'MONTHLY_PLAN_ALREADY_PUBLISHED' }))).code, String(status)).toBeNull();
    }
  });

  it('A1: trusts the planning-writer calendar codes only with their catalogued 409', async () => {
    for (const code of ['PROJECT_CALENDAR_MISSING', 'PROJECT_CLOSED_WEEKDAY', 'EMPLOYEE_DAILY_SHIFT_CONFLICT'] as const) {
      expect((await parseApiError(problem(409, { code }))).code, code).toBe(code);
      for (const status of [400, 404, 500]) {
        expect((await parseApiError(problem(status, { code }))).code, `${code} ${status}`).toBeNull();
      }
    }
    // The calendar-write codes are not consumed by any screen yet and stay untrusted.
    for (const code of ['PROJECT_CALENDAR_INVALID', 'PROJECT_CALENDAR_CONCURRENT_MODIFICATION', 'PROJECT_CALENDAR_DEPENDENCY_CONFLICT']) {
      const status = code === 'PROJECT_CALENDAR_INVALID' ? 400 : 409;
      expect((await parseApiError(problem(status, { code }))).code, code).toBeNull();
    }
  });

  it('has German texts for every SP-07 code', () => {
    const codes = [
      'EMPLOYEE_CODE_ALREADY_EXISTS',
      'EMPLOYEE_INACTIVE',
      'EMPLOYEE_HAS_FUTURE_ASSIGNMENTS',
      'EMPTY_PATCH',
      'EMPLOYMENT_DATE_CONFLICT',
    ] as const;
    const statuses = { EMPTY_PATCH: 400, EMPLOYMENT_DATE_CONFLICT: 400 } as Record<string, number>;
    for (const code of codes) {
      const text = describeApiError(new ApiError('http', statuses[code] ?? 409, code, null));
      expect(text.title, code).not.toBe('Konflikt');
      expect(text.title, code).not.toBe('Eingaben überprüfen');
      expect(text.canRetry, code).toBe(false);
    }
  });
});
