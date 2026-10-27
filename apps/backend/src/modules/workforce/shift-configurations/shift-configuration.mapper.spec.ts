import { isApprovedErrorCode } from '../../../common/errors/error-contract.js';
import {
  shiftKindFromDb,
  shiftKindToDb,
  toShiftConfigurationResponse,
  type ShiftRuleRow,
} from './shift-configuration.mapper.js';

const PROJECT = '01890a5d-ac96-774b-bcce-b302099a8057';
const row = (overrides: Partial<ShiftRuleRow>): ShiftRuleRow => ({
  id: '6f1ad9a6-3a0c-4b7c-9c5e-0d4f2a1e8b11',
  shift_kind: 'TAG',
  start_local: '06:00',
  end_local: '18:00',
  effective_from_month: '2027-01-01',
  ...overrides,
});

describe('SP-08b — shift kind mapping (API DAY/NIGHT <-> DB TAG/NACHT)', () => {
  it('maps both directions explicitly', () => {
    expect([shiftKindToDb('DAY'), shiftKindToDb('NIGHT')]).toEqual(['TAG', 'NACHT']);
    expect([shiftKindFromDb('TAG'), shiftKindFromDb('NACHT')]).toEqual(['DAY', 'NIGHT']);
  });

  it('an unknown stored value is a server defect and fails closed', () => {
    for (const value of ['DAY', 'NIGHT', 'BOTH', 'tag', '']) {
      expect(() => shiftKindFromDb(value), value).toThrow('Unexpected shift kind in database');
    }
  });
});

describe('SP-08b — response (A-SP08b-01)', () => {
  it('no version: effectiveFromMonth null and an empty shift list', () => {
    expect(toShiftConfigurationResponse(PROJECT, [])).toEqual({ projectId: PROJECT, effectiveFromMonth: null, shifts: [] });
  });

  it('one version: its month and its rules in API vocabulary, without internal fields', () => {
    const night = row({ id: '0b4e2c1a-1111-4c2d-9e3f-aaaaaaaaaaaa', shift_kind: 'NACHT', start_local: '18:00', end_local: '06:00' });
    expect(toShiftConfigurationResponse(PROJECT, [row({}), night])).toEqual({
      projectId: PROJECT,
      effectiveFromMonth: '2027-01-01',
      shifts: [
        { id: row({}).id, shiftKind: 'DAY', startLocal: '06:00', endLocal: '18:00' },
        { id: night.id, shiftKind: 'NIGHT', startLocal: '18:00', endLocal: '06:00' },
      ],
    });
  });

  it('rows of different versions are never merged into one response', () => {
    expect(() => toShiftConfigurationResponse(PROJECT, [row({}), row({ shift_kind: 'NACHT', effective_from_month: '2027-03-01' })]))
      .toThrow('Shift rules of different versions mixed');
  });
});

describe('SP-08b — error contract (Phase 8.5 catalogue, no new codes)', () => {
  it('uses only catalogued code/status pairs', () => {
    for (const [code, status] of [
      ['SHIFT_CONFIGURATION_INVALID', 400],
      ['SHIFT_CONFIGURATION_CONFLICT', 409],
      ['INVALID_MONTH_START', 400],
      ['PROJECT_INACTIVE', 409],
      ['RESOURCE_NOT_FOUND', 404],
    ] as const) {
      expect(isApprovedErrorCode(code, status), code).toBe(true);
    }
    // SHIFT_CONFIGURATION_MISSING stays reserved for duty creation (SP-11); it is not a GET result.
    expect(isApprovedErrorCode('SHIFT_CONFIGURATION_MISSING', 409)).toBe(true);
  });
});
