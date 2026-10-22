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
