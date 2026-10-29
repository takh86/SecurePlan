import { correctionStatusConflict } from './project-assignments.service.js';

describe('#64 — correctionStatusConflict (future-target status guard; history keeps D2)', () => {
  // Current month in the company's time zone, as correct() reads it.
  const CURRENT = '2026-12-01';
  const ACTIVE = { status: 'ACTIVE' };
  const DEACTIVATED = { status: 'DEACTIVATED' };
  const INACTIVE = { status: 'INACTIVE' };
  const ARCHIVED = { status: 'ARCHIVED' };

  it.each([
    // [label, employeeChanged, projectChanged, resulting employee, resulting project, target month, expected]
    // The source month is irrelevant: FUTURE→FUTURE and past/current→FUTURE are judged alike.
    ['month only, everything ACTIVE', false, false, ACTIVE, ACTIVE, '2027-02-01', null],
    ['month only, unchanged DEACTIVATED employee', false, false, DEACTIVATED, ACTIVE, '2027-02-01', 'EMPLOYEE_INACTIVE'],
    ['month only, unchanged INACTIVE project', false, false, ACTIVE, INACTIVE, '2027-02-01', 'PROJECT_INACTIVE'],
    ['month only, unchanged ARCHIVED project', false, false, ACTIVE, ARCHIVED, '2027-02-01', 'PROJECT_INACTIVE'],
    ['project changed to ACTIVE, unchanged DEACTIVATED employee', false, true, DEACTIVATED, ACTIVE, '2027-02-01', 'EMPLOYEE_INACTIVE'],
    ['employee changed to ACTIVE, unchanged INACTIVE project', true, false, ACTIVE, INACTIVE, '2027-02-01', 'PROJECT_INACTIVE'],
    ['employee changed to ACTIVE, unchanged ARCHIVED project', true, false, ACTIVE, ARCHIVED, '2027-02-01', 'PROJECT_INACTIVE'],
    ['employee changed to DEACTIVATED', true, false, DEACTIVATED, ACTIVE, '2027-02-01', 'EMPLOYEE_INACTIVE'],
    ['project changed to INACTIVE', false, true, ACTIVE, INACTIVE, '2027-02-01', 'PROJECT_INACTIVE'],
    ['both changed to ACTIVE', true, true, ACTIVE, ACTIVE, '2027-02-01', null],
    ['both not ACTIVE: the employee is reported first', false, false, DEACTIVATED, INACTIVE, '2027-02-01', 'EMPLOYEE_INACTIVE'],
    ['first month after the current one (year boundary)', false, false, ACTIVE, INACTIVE, '2027-01-01', 'PROJECT_INACTIVE'],
  ] as const)('future target: %s', (_label, employeeChanged, projectChanged, employee, project, month, expected) => {
    expect(correctionStatusConflict(employeeChanged, projectChanged, employee, project, month, CURRENT)).toBe(expected);
  });

  it.each([
    // Target month within history (past or current month, also from a future month back): D2 unchanged.
    ['past month, unchanged DEACTIVATED employee and INACTIVE project', false, false, DEACTIVATED, INACTIVE, '2026-10-01', null],
    ['current month, unchanged DEACTIVATED employee and INACTIVE project', false, false, DEACTIVATED, INACTIVE, CURRENT, null],
    ['current month, unchanged ARCHIVED project', false, false, ACTIVE, ARCHIVED, CURRENT, null],
    ['project changed to ACTIVE, unchanged DEACTIVATED employee', false, true, DEACTIVATED, ACTIVE, '2026-10-01', null],
    ['employee changed to ACTIVE, unchanged INACTIVE project', true, false, ACTIVE, INACTIVE, '2026-10-01', null],
    ['employee changed to DEACTIVATED', true, false, DEACTIVATED, ACTIVE, '2026-10-01', 'EMPLOYEE_INACTIVE'],
    ['project changed to INACTIVE', false, true, ACTIVE, INACTIVE, CURRENT, 'PROJECT_INACTIVE'],
    ['both changed, neither ACTIVE: the employee is reported first', true, true, DEACTIVATED, INACTIVE, '2026-10-01', 'EMPLOYEE_INACTIVE'],
  ] as const)('target within history: %s', (_label, employeeChanged, projectChanged, employee, project, month, expected) => {
    expect(correctionStatusConflict(employeeChanged, projectChanged, employee, project, month, CURRENT)).toBe(expected);
  });
});
