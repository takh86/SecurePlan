import { describe, expect, it } from 'vitest';
import {
  EMPTY_FORM,
  serverFieldErrors,
  toCreateInput,
  toUpdateInput,
  validateEmployeeForm,
  valuesFromEmployee,
} from './employee-form';
import { employee, httpError } from './employees.test-support';

const valid = {
  ...EMPTY_FORM,
  employeeCode: ' A-100 ',
  firstName: ' Mira ',
  lastName: 'Beispiel',
  email: ' mira@secureplan.test ',
  shiftEligibility: 'DAY' as const,
};

describe('SP-07 — employee form model', () => {
  it('requires the contract fields and mirrors the server rules', () => {
    expect(Object.keys(validateEmployeeForm(EMPTY_FORM, 'create')).sort())
      .toEqual(['email', 'employeeCode', 'firstName', 'lastName', 'shiftEligibility']);
    expect(validateEmployeeForm(valid, 'create')).toEqual({});
    expect(validateEmployeeForm({ ...valid, employeeCode: '-x' }, 'create')).toHaveProperty('employeeCode');
    expect(validateEmployeeForm({ ...valid, employeeCode: 'X'.repeat(31) }, 'create')).toHaveProperty('employeeCode');
    expect(validateEmployeeForm({ ...valid, firstName: ' A ' }, 'create')).toHaveProperty('firstName');
    expect(validateEmployeeForm({ ...valid, email: 'kein-at' }, 'create')).toHaveProperty('email');
    // E-mail is not part of the edit form.
    expect(validateEmployeeForm({ ...valid, email: '' }, 'edit')).toEqual({});
    expect(validateEmployeeForm({ ...valid, employmentStart: '2026-05-01', employmentEnd: '2026-04-30' }, 'edit'))
      .toEqual({ employmentEnd: 'Das Beschäftigungsende darf nicht vor dem Beginn liegen.' });
  });

  it('creates a trimmed body without empty optional fields', () => {
    expect(toCreateInput(valid)).toEqual({
      employeeCode: 'A-100',
      firstName: 'Mira',
      lastName: 'Beispiel',
      email: 'mira@secureplan.test',
      shiftEligibility: 'DAY',
    });
    expect(toCreateInput({ ...valid, employmentStart: '2026-11-01' })).toHaveProperty('employmentStart', '2026-11-01');
  });

  it('patches only changed fields and clears dates with null', () => {
    const original = employee();
    const unchanged = valuesFromEmployee(original);
    expect(toUpdateInput(unchanged, original)).toEqual({});
    expect(toUpdateInput({ ...unchanged, firstName: ' Mira ' }, original)).toEqual({});
    expect(toUpdateInput({ ...unchanged, employeeCode: 'A-002', employmentStart: '', shiftEligibility: 'NIGHT' }, original))
      .toEqual({ employeeCode: 'A-002', employmentStart: null, shiftEligibility: 'NIGHT' });
  });

  it('maps server errors to fields; e-mail conflicts stay neutral', () => {
    expect(serverFieldErrors(httpError(409, 'EMPLOYEE_CODE_ALREADY_EXISTS'))).toEqual({
      employeeCode: 'Diese Mitarbeiter-ID ist in Ihrem Unternehmen bereits vergeben.',
    });
    expect(serverFieldErrors(httpError(409, 'EMAIL_ALREADY_IN_USE'))).toEqual({
      email: 'Diese E-Mail-Adresse kann nicht verwendet werden.',
    });
    expect(serverFieldErrors(httpError(400, 'VALIDATION_FAILED', [
      { pointer: '#/lastName', code: 'TOO_SHORT' },
      { pointer: '#/companyId', code: 'REQUIRED' },
    ]))).toEqual({ lastName: 'Der Wert ist zu kurz.' });
    expect(serverFieldErrors(httpError(500, 'INTERNAL_ERROR'))).toBeNull();
    expect(serverFieldErrors(new Error('x'))).toBeNull();
  });
});
