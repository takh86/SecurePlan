import { correctionEmploymentConflict, employmentCovers } from './project-assignments.service.js';

describe('SP-09 ? employmentCovers (historical employee corrections)', () => {
  const covers = (start: string | null, end: string | null, month: string) =>
    employmentCovers({ employment_start: start, employment_end: end }, month);

  it('missing employment start is "no evidence", never valid', () => {
    expect(covers(null, null, '2026-10-01')).toBe(false);
    expect(covers(null, '2027-01-01', '2026-10-01')).toBe(false);
  });

  it('requires an overlap with the whole calendar month; boundaries are inclusive', () => {
    expect(covers('2026-01-01', null, '2026-10-01')).toBe(true);
    expect(covers('2026-10-31', null, '2026-10-01')).toBe(true); // starts on the last day
    expect(covers('2026-11-01', null, '2026-10-01')).toBe(false); // starts the day after
    expect(covers('2025-01-01', '2026-10-01', '2026-10-01')).toBe(true); // ends on the first day
    expect(covers('2025-01-01', '2026-09-30', '2026-10-01')).toBe(false); // ended the day before
  });

  it('knows month lengths, including leap February', () => {
    expect(covers('2028-02-29', null, '2028-02-01')).toBe(true);
    expect(covers('2027-02-29', null, '2027-02-01')).toBe(false); // not a real date; compares after Feb 28
    expect(covers('2028-03-01', null, '2028-02-01')).toBe(false);
  });
});

describe('#64 — correctionEmploymentConflict (FUTURE 1a, HISTORICAL→FUTURE decision B, HISTORICAL D2 unchanged)', () => {
  // Synthetic employment periods; only the RESULTING employee and month are passed in.
  const period = (start: string | null, end: string | null = null) => ({ employment_start: start, employment_end: end });
  const NO_EVIDENCE = period(null);
  // Current month in the company's time zone, as correct() reads it.
  const CURRENT = '2026-12-01';

  it.each([
    // [label, employeeChanged, resulting employment, resulting month, expected]
    ['project only, employed', false, period('2020-01-01'), '2027-02-01', null],
    ['project only, employment ended before the month', false, period('2020-01-01', '2027-01-31'), '2027-02-01', 'EMPLOYEE_NOT_EMPLOYED_FOR_MONTH'],
    ['project only, no employment start', false, NO_EVIDENCE, '2027-02-01', 'EMPLOYEE_NOT_EMPLOYED_FOR_MONTH'],
    ['month only, target month covered (end on its 1st)', false, period('2020-01-01', '2027-03-01'), '2027-03-01', null],
    ['month only, target month not covered', false, period('2020-01-01', '2027-02-28'), '2027-03-01', 'EMPLOYEE_NOT_EMPLOYED_FOR_MONTH'],
    ['employee only, hired on the last day of the month', true, period('2027-02-28'), '2027-02-01', null],
    ['employee only, hired the day after the month', true, period('2027-03-01'), '2027-02-01', 'EMPLOYEE_NOT_EMPLOYED_FOR_MONTH'],
    ['employee only, no employment start', true, period(null, '2030-12-31'), '2027-02-01', 'EMPLOYEE_NOT_EMPLOYED_FOR_MONTH'],
    ['combined, leap February covered', true, period('2028-02-29'), '2028-02-01', null],
    ['combined, target month after the employment end', true, period('2020-01-01', '2028-01-31'), '2028-02-01', 'EMPLOYEE_NOT_EMPLOYED_FOR_MONTH'],
  ] as const)('FUTURE %s', (_label, employeeChanged, employment, month, expected) => {
    expect(correctionEmploymentConflict('FUTURE', employeeChanged, employment, month, CURRENT)).toBe(expected);
  });

  it.each([
    // Target month within history (past or current month): an unchanged employee is never checked.
    ['project or month only, no evidence', false, NO_EVIDENCE, '2026-10-01', null],
    ['project or month only, employment ended before the month', false, period('2020-01-01', '2026-09-30'), '2026-10-01', null],
    ['into the current month, employment ended before it', false, period('2020-01-01', '2026-11-30'), CURRENT, null],
    // D2: a newly referenced employee keeps its own code.
    ['employee changed, covered', true, period('2026-10-31', '2026-10-31'), '2026-10-01', null],
    ['employee changed, no evidence', true, NO_EVIDENCE, '2026-10-01', 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT'],
    ['employee changed, left before the month', true, period('2025-01-01', '2026-09-30'), '2026-10-01', 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT'],
  ] as const)('HISTORICAL %s', (_label, employeeChanged, employment, month, expected) => {
    expect(correctionEmploymentConflict('HISTORICAL', employeeChanged, employment, month, CURRENT)).toBe(expected);
  });

  it.each([
    // Decision B: the unchanged employee is checked for the FUTURE target month, with POST's code.
    ['unchanged employee, no evidence', false, NO_EVIDENCE, '2027-01-01', 'EMPLOYEE_NOT_EMPLOYED_FOR_MONTH'],
    ['unchanged employee, end without start', false, period(null, '2030-12-31'), '2027-01-01', 'EMPLOYEE_NOT_EMPLOYED_FOR_MONTH'],
    ['unchanged employee, left on the last day of the current month', false, period('2020-01-01', '2026-12-31'), '2027-01-01', 'EMPLOYEE_NOT_EMPLOYED_FOR_MONTH'],
    ['unchanged employee, ends on the 1st of the target month', false, period('2020-01-01', '2027-01-01'), '2027-01-01', null],
    ['unchanged employee, hired on the last day of the target month', false, period('2027-01-31'), '2027-01-01', null],
    ['unchanged employee, hired the day after the target month', false, period('2027-02-01'), '2027-01-01', 'EMPLOYEE_NOT_EMPLOYED_FOR_MONTH'],
    ['unchanged employee, leap February covered', false, period('2028-02-29'), '2028-02-01', null],
    ['unchanged employee, month before a leap-day hire', false, period('2028-02-29'), '2028-01-01', 'EMPLOYEE_NOT_EMPLOYED_FOR_MONTH'],
    // The historical employee-change contract (D2 code) is kept, checked for the target month.
    ['employee changed, covered', true, period('2027-01-31'), '2027-01-01', null],
    ['employee changed, no evidence', true, NO_EVIDENCE, '2027-01-01', 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT'],
    ['employee changed, left before the target month', true, period('2020-01-01', '2026-12-31'), '2027-01-01', 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT'],
  ] as const)('HISTORICAL→FUTURE %s', (_label, employeeChanged, employment, month, expected) => {
    expect(correctionEmploymentConflict('HISTORICAL', employeeChanged, employment, month, CURRENT)).toBe(expected);
  });
});
