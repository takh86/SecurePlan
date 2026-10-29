import {
  PROJECT_ASSIGNMENT_TOUCH,
  assignmentVersionSql,
  isMonthStart,
  toAssignmentVersion,
  toProjectAssignmentResponse,
} from './project-assignment.mapper.js';

describe('SP-09 — project assignment mapper', () => {
  it('recognizes only the first day of a month (input already format-validated)', () => {
    expect(isMonthStart('2026-11-01')).toBe(true);
    expect(isMonthStart('2027-01-01')).toBe(true);
    expect(isMonthStart('2026-11-15')).toBe(false);
    expect(isMonthStart('2026-11-10')).toBe(false);
    expect(isMonthStart('2026-11-01T00:00:00Z')).toBe(false);
  });

  it('maps a stored row to the v1 response without tenant fields', () => {
    expect(toProjectAssignmentResponse({
      id: 'a-1', employee_id: 'e-1', project_id: 'p-1', month_start: '2026-11-01', version: '1793260800123456',
    })).toEqual({ id: 'a-1', employeeId: 'e-1', projectId: 'p-1', monthStart: '2026-11-01', version: 1793260800123456 });
  });
});

describe('#73 — version mapping (U-1, fail closed)', () => {
  it.each([
    ['1', 1],
    ['1793260800123456', 1793260800123456],
    ['9007199254740991', Number.MAX_SAFE_INTEGER],
  ])('accepts %s exactly', (text, expected) => {
    expect(toAssignmentVersion(text)).toBe(expected);
  });

  it.each([
    ['epoch 0', '0'],
    ['2^53 (first unsafe value)', '9007199254740992'],
    ['leading zero', '01'],
    ['negative (before 1970)', '-1'],
    ['fraction', '1.5'],
    ['empty', ''],
    ['17 digits', '10000000000000000'],
  ])('rejects %s', (_label, text) => {
    expect(() => toAssignmentVersion(text)).toThrow('outside the supported range');
  });

  it.each([
    ['a number (would have lost precision already)', 1793260800123456],
    ['a bigint', 1793260800123456n],
    ['null', null],
    ['undefined', undefined],
    ['a Date', new Date('2026-10-29T08:00:00.123Z')],
  ])('rejects a non-string: %s', (_label, value) => {
    expect(() => toAssignmentVersion(value)).toThrow('outside the supported range');
  });

  it('builds the version from numeric EXTRACT and the touch rule from GREATEST (never float date_part)', () => {
    expect(assignmentVersionSql('pa.updated_at')).toBe('(extract(epoch FROM pa.updated_at) * 1000000)::bigint');
    expect(assignmentVersionSql('updated_at')).not.toMatch(/date_part/i);
    expect(PROJECT_ASSIGNMENT_TOUCH)
      .toBe("updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')");
  });
});
