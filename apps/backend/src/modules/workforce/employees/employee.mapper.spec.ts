import {
  eligibilityFromDb,
  eligibilityToDb,
  statusFromDb,
  statusToDb,
  toEmployeeResponse,
  type EmployeeRow,
} from './employee.mapper.js';

const row: EmployeeRow = {
  id: '6f1ad9a6-3a0c-4b7c-9c5e-0d4f2a1e8b11',
  account_id: '0b9e3c55-6d3e-4a8e-9a77-5b3f6e1c2d44',
  employee_number: 'A-001',
  first_name: 'Synthetic',
  last_name: 'Employee',
  employment_start: '2026-11-01',
  employment_end: null,
  shift_eligibility: 'NACHT',
  status: 'DEACTIVATED',
};

describe('SP-07 — employee API <-> DB mapping', () => {
  it('maps shift eligibility both ways (DAY/NIGHT/BOTH <-> TAG/NACHT/BOTH)', () => {
    expect(eligibilityToDb('DAY')).toBe('TAG');
    expect(eligibilityToDb('NIGHT')).toBe('NACHT');
    expect(eligibilityToDb('BOTH')).toBe('BOTH');
    expect(eligibilityFromDb('TAG')).toBe('DAY');
    expect(eligibilityFromDb('NACHT')).toBe('NIGHT');
    expect(eligibilityFromDb('BOTH')).toBe('BOTH');
  });

  it('maps employee status both ways (INACTIVE <-> DEACTIVATED)', () => {
    expect(statusToDb('ACTIVE')).toBe('ACTIVE');
    expect(statusToDb('INACTIVE')).toBe('DEACTIVATED');
    expect(statusFromDb('ACTIVE')).toBe('ACTIVE');
    expect(statusFromDb('DEACTIVATED')).toBe('INACTIVE');
  });

  it('fails closed on unknown stored values instead of guessing', () => {
    expect(() => eligibilityFromDb('DAY')).toThrow('Unexpected shift eligibility in database');
    expect(() => statusFromDb('INACTIVE')).toThrow('Unexpected employee status in database');
  });

  it('builds exactly the approved response fields, never tenant or account internals', () => {
    const response = toEmployeeResponse(row, { email: 'synthetic@secureplan.invalid', status: 'DEACTIVATED' });
    expect(response).toEqual({
      id: row.id,
      employeeCode: 'A-001',
      firstName: 'Synthetic',
      lastName: 'Employee',
      employmentStart: '2026-11-01',
      employmentEnd: null,
      shiftEligibility: 'NIGHT',
      status: 'INACTIVE',
      email: 'synthetic@secureplan.invalid',
      accountStatus: 'DEACTIVATED',
    });
    expect(response).not.toHaveProperty('accountId');
    expect(response).not.toHaveProperty('companyId');
  });

  it('treats a missing account summary as a server defect', () => {
    expect(() => toEmployeeResponse(row, undefined)).toThrow('Employee account summary missing');
  });
});
