import { describe, expect, it } from 'vitest';
import { employee } from '../../employees/employees.test-support';
import type { ProjectAssignment } from '../../projects/project-assignments-api';
import { dutyCandidates, employedOn, ineligibility } from './duty-eligibility';

// Synthetic example records, not business rules.
const PROJECT = '7a2be0c4-1d3e-4f5a-8b6c-9d0e1f2a3b4c';
const OTHER_PROJECT = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const assignment = (employeeId: string, projectId = PROJECT, monthStart = '2026-12-01'): ProjectAssignment =>
  ({ id: `x-${employeeId}-${projectId}-${monthStart}`, employeeId, projectId, monthStart, version: 1 });

describe('SP-11 PR-2 — duty pre-selection (mirrors the server rules; the server decides)', () => {
  it('employment covers the duty date inclusively; a missing start is no evidence', () => {
    const bounded = { employmentStart: '2026-12-01', employmentEnd: '2026-12-31' };
    expect(employedOn(bounded, '2026-11-30')).toBe(false);
    expect(employedOn(bounded, '2026-12-01')).toBe(true);
    expect(employedOn(bounded, '2026-12-31')).toBe(true);
    expect(employedOn(bounded, '2027-01-01')).toBe(false);
    expect(employedOn({ employmentStart: null, employmentEnd: null }, '2026-12-15')).toBe(false);
    expect(employedOn({ employmentStart: '2020-01-01', employmentEnd: null }, '2099-12-31')).toBe(true);
  });

  it('reports the first failing rule in the server precedence order', () => {
    expect(ineligibility(employee({ status: 'INACTIVE', employmentStart: null, shiftEligibility: 'DAY' }), '2026-12-03', 'NIGHT')).toBe('INACTIVE');
    expect(ineligibility(employee({ employmentStart: null, shiftEligibility: 'DAY' }), '2026-12-03', 'NIGHT')).toBe('NOT_EMPLOYED');
    expect(ineligibility(employee({ employmentStart: '2020-01-01', shiftEligibility: 'DAY' }), '2026-12-03', 'NIGHT')).toBe('NOT_ELIGIBLE_FOR_SHIFT');
    expect(ineligibility(employee({ employmentStart: '2020-01-01', shiftEligibility: 'NIGHT' }), '2026-12-03', 'NIGHT')).toBeNull();
    expect(ineligibility(employee({ employmentStart: '2020-01-01', shiftEligibility: 'BOTH' }), '2026-12-03', 'DAY')).toBeNull();
  });

  it('offers only employees of this project and month, sorted by name, and explains the excluded ones', () => {
    const anna = employee({ id: 'e-anna', firstName: 'Anna', lastName: 'Zander', employmentStart: '2020-01-01' });
    const ben = employee({ id: 'e-ben', firstName: 'Ben', lastName: 'Ähnlich', employmentStart: '2020-01-01', shiftEligibility: 'DAY' });
    const cora = employee({ id: 'e-cora', firstName: 'Cora', lastName: 'Bauer', employmentStart: '2020-01-01' });
    const dana = employee({ id: 'e-dana', firstName: 'Dana', lastName: 'Cramer', employmentStart: '2020-01-01' });
    const assignments = [
      assignment('e-anna'),
      assignment('e-ben'),
      assignment('E-CORA'), // ids are compared case-insensitively
      assignment('e-dana', OTHER_PROJECT),
      assignment('e-dana', PROJECT, '2027-01-01'),
    ];
    const day = dutyCandidates([anna, ben, cora, dana], assignments, PROJECT.toUpperCase(), '2026-12-01', '2026-12-03', 'DAY');
    expect(day.eligible.map((item) => item.firstName)).toEqual(['Ben', 'Cora', 'Anna']);
    expect(day.ineligible).toEqual([]);

    const night = dutyCandidates([anna, ben, cora, dana], assignments, PROJECT, '2026-12-01', '2026-12-03', 'NIGHT');
    expect(night.eligible.map((item) => item.firstName)).toEqual(['Cora', 'Anna']);
    expect(night.ineligible).toEqual([{ employee: ben, reason: 'NOT_ELIGIBLE_FOR_SHIFT' }]);
  });

  it('applies the employment end at the month boundary (last day in, next day out)', () => {
    const leaving = employee({ id: 'e-lea', employmentStart: '2020-01-01', employmentEnd: '2026-12-15' });
    const assignments = [assignment('e-lea')];
    expect(dutyCandidates([leaving], assignments, PROJECT, '2026-12-01', '2026-12-15', 'DAY').eligible).toHaveLength(1);
    expect(dutyCandidates([leaving], assignments, PROJECT, '2026-12-01', '2026-12-16', 'DAY').ineligible)
      .toEqual([{ employee: leaving, reason: 'NOT_EMPLOYED' }]);
  });
});
