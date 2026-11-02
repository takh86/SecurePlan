import {
  availabilityKey,
  dutyRoleToDb,
  toDutyVersion,
  toMonthlyPlanEntryResponse,
  toMonthlyPlanResponse,
  type DutyRow,
  type MembershipRow,
} from './monthly-plan.mapper.js';

const DUTY: DutyRow = {
  id: '00000000-0000-4000-8000-0000000000d1',
  duty_date: '2026-12-10',
  shift_kind: 'NACHT',
  starts_at: '2026-12-10T17:00:00Z',
  ends_at: '2026-12-11T05:00:00Z',
  version: '1',
};
const member = (id: string, employeeId: string, fn = 'MITARBEITER'): MembershipRow =>
  ({ id, duty_id: DUTY.id, employee_id: employeeId, duty_function: fn, source: 'NORMAL' });

describe('SP-11 planning mapper', () => {
  it('maps DB vocabulary to the API and orders members by employee, then membership id', () => {
    const entry = toMonthlyPlanEntryResponse(
      DUTY,
      [member('m3', 'e2', 'SCHICHTLEITER'), member('m2', 'e1'), member('m1', 'e1')],
      new Set(),
    );
    expect(entry).toEqual({
      id: DUTY.id,
      dutyDate: '2026-12-10',
      shiftKind: 'NIGHT',
      startsAt: '2026-12-10T17:00:00Z',
      endsAt: '2026-12-11T05:00:00Z',
      version: 1,
      assignments: [
        { id: 'm1', employeeId: 'e1', dutyRole: 'EMPLOYEE', source: 'NORMAL' },
        { id: 'm2', employeeId: 'e1', dutyRole: 'EMPLOYEE', source: 'NORMAL' },
        { id: 'm3', employeeId: 'e2', dutyRole: 'SHIFT_LEAD', source: 'NORMAL' },
      ],
      availabilityConflicts: [],
    });
    expect(dutyRoleToDb('SHIFT_LEAD')).toBe('SCHICHTLEITER');
  });

  it('E-04 conflicts are neutral: only code, membership and employee; the same for any absence kind', () => {
    const entry = toMonthlyPlanEntryResponse(DUTY, [member('m1', 'e1'), member('m2', 'e2')], new Set([availabilityKey('e2', '2026-12-10')]));
    expect(entry.availabilityConflicts).toEqual([{ code: 'EMPLOYEE_UNAVAILABLE', assignmentId: 'm2', employeeId: 'e2' }]);
    expect(Object.keys(entry.availabilityConflicts[0]).sort()).toEqual(['assignmentId', 'code', 'employeeId']);
    // A fact on another day is not a conflict of this duty.
    expect(toMonthlyPlanEntryResponse(DUTY, [member('m1', 'e1')], new Set([availabilityKey('e1', '2026-12-11')]))
      .availabilityConflicts).toEqual([]);
  });

  it.each(['0', '-1', '01', '1.5', '9007199254740992', '', 'abc'])('version %j fails closed', (value) => {
    expect(() => toDutyVersion(value)).toThrow('Unexpected duty version in database');
  });

  it('accepts the largest safe version', () => {
    expect(toDutyVersion('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('unknown stored values fail closed (500), never pass through', () => {
    expect(() => toMonthlyPlanResponse({ id: 'p', project_id: 'x', month_start: '2026-12-01', status: 'DRAFT', published_at: null }))
      .toThrow('Unexpected monthly plan status in database');
    expect(() => toMonthlyPlanEntryResponse({ ...DUTY, shift_kind: 'DAY' }, [], new Set())).toThrow();
    expect(() => toMonthlyPlanEntryResponse(DUTY, [member('m1', 'e1', 'LEITER')], new Set())).toThrow('Unexpected duty function');
    expect(() => toMonthlyPlanEntryResponse(DUTY, [{ ...member('m1', 'e1'), source: 'AUTO' }], new Set()))
      .toThrow('Unexpected assignment source');
  });
});
