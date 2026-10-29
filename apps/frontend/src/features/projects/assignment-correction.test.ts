import { describe, expect, it } from 'vitest';
import { ApiError } from '../../shared/api/api-error';
import {
  MONTH_FORMAT_ERROR,
  correctionChanges,
  initialCorrection,
  isSameCorrection,
  serverCorrectionErrors,
  validateCorrection,
} from './assignment-correction';

// Synthetic example values, not business rules.
const december = { id: 'a-1', employeeId: 'e-1', projectId: 'p-1', monthStart: '2026-12-01', version: 1793260800000001 };

describe('SP-09 — assignment correction values', () => {
  it('starts from the persisted assignment', () => {
    expect(initialCorrection(december)).toEqual({ employeeId: 'e-1', projectId: 'p-1', month: '2026-12' });
  });

  it('sends only the changed dimensions; unchanged values give an empty body (no-op)', () => {
    const base = initialCorrection(december);
    expect(correctionChanges(december, base)).toEqual({});
    expect(correctionChanges(december, { ...base, month: ' 2026-12 ' })).toEqual({});
    expect(correctionChanges(december, { ...base, employeeId: 'e-2' })).toEqual({ employeeId: 'e-2' });
    expect(correctionChanges(december, { ...base, projectId: 'p-2' })).toEqual({ projectId: 'p-2' });
    expect(correctionChanges(december, { employeeId: 'e-2', projectId: 'p-2', month: '2027-03' }))
      .toEqual({ employeeId: 'e-2', projectId: 'p-2', monthStart: '2027-03-01' });
  });

  it.each([
    ['December -> January (year boundary)', december, '2027-01', '2027-01-01'],
    ['January -> December (back over the year boundary)', { ...december, monthStart: '2027-01-01' }, '2026-12', '2026-12-01'],
    ['February of a leap year', december, '2028-02', '2028-02-01'],
    ['the previous year, same month', december, '2025-12', '2025-12-01'],
  ] as const)('%s: the month is sent as its first calendar day', (_name, assignment, month, monthStart) => {
    expect(correctionChanges(assignment, { ...initialCorrection(assignment), month })).toEqual({ monthStart });
  });

  it.each(['', '2027-13', '2027-00', '2027-1', '01.2027', '2027-01-01', '1999-12', '2100-01', 'Januar'])(
    'rejects the month text %j before any request', (month) => {
      expect(validateCorrection({ employeeId: 'e-1', projectId: 'p-1', month })).toEqual({ month: MONTH_FORMAT_ERROR });
    },
  );

  it('requires a person and a project; a valid month passes', () => {
    expect(validateCorrection({ employeeId: '', projectId: '', month: '2027-01' })).toEqual({
      employeeId: 'Bitte wählen Sie eine Person aus.',
      projectId: 'Bitte wählen Sie ein Projekt aus.',
    });
    expect(validateCorrection({ employeeId: 'e-1', projectId: 'p-1', month: ' 2027-01 ' })).toEqual({});
  });

  it('detects unsaved input; surrounding spaces in the month are not a change', () => {
    const base = initialCorrection(december);
    expect(isSameCorrection(base, { ...base })).toBe(true);
    expect(isSameCorrection(base, { ...base, month: '2026-12 ' })).toBe(true);
    expect(isSameCorrection(base, { ...base, month: '2027-01' })).toBe(false);
    expect(isSameCorrection(base, { ...base, projectId: 'p-2' })).toBe(false);
  });

  it('maps safe server field pointers and INVALID_MONTH_START to the fields; other errors to none', () => {
    const validation = new ApiError('http', 400, 'VALIDATION_FAILED', null, [
      { pointer: '#/employeeId', code: 'INVALID_UUID' },
      { pointer: '#/monthStart', code: 'INVALID_FORMAT' },
      { pointer: '#/companyId', code: 'INVALID_UUID' },
    ]);
    expect(Object.keys(serverCorrectionErrors(validation)).sort()).toEqual(['employeeId', 'month']);
    expect(serverCorrectionErrors(new ApiError('http', 400, 'INVALID_MONTH_START', null))).toEqual({ month: MONTH_FORMAT_ERROR });
    expect(serverCorrectionErrors(new ApiError('http', 409, 'PROJECT_ASSIGNMENT_CONFLICT', null))).toEqual({});
    expect(serverCorrectionErrors(new Error('x'))).toEqual({});
  });
});
