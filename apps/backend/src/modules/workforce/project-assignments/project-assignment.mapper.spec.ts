import { isMonthStart, toProjectAssignmentResponse } from './project-assignment.mapper.js';

describe('SP-09 — project assignment mapper', () => {
  it('recognizes only the first day of a month (input already format-validated)', () => {
    expect(isMonthStart('2026-11-01')).toBe(true);
    expect(isMonthStart('2027-01-01')).toBe(true);
    expect(isMonthStart('2026-11-15')).toBe(false);
    expect(isMonthStart('2026-11-10')).toBe(false);
    expect(isMonthStart('2026-11-01T00:00:00Z')).toBe(false);
  });

  it('maps a stored row to the v1 response without tenant fields', () => {
    expect(toProjectAssignmentResponse({ id: 'a-1', employee_id: 'e-1', project_id: 'p-1', month_start: '2026-11-01' }))
      .toEqual({ id: 'a-1', employeeId: 'e-1', projectId: 'p-1', monthStart: '2026-11-01' });
  });
});
