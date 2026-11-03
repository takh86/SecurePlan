import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertMyPlanMonth,
  toMyMonthlyPlansResponse,
  type OwnPlanRow,
} from './me-monthly-plans-read.service.js';
import {
  isCivilDate,
  isUtcSecond,
  isNamedTimeZone,
} from '../../common/time/civil-time.js';
import { MY_MONTHLY_PLANS_QUERY } from './me-monthly-plans.query.js';

function sentinel(): OwnPlanRow {
  return {
    internal_owner_id: randomUUID(),
    plan_id: null,
    project_id: null,
    project_name: null,
    month_start: null,
    duty_id: null,
    duty_date: null,
    shift_kind: null,
    duty_function: null,
    time_zone: null,
    starts_at: null,
    ends_at: null,
  };
}
describe('SP14 structural ownership and civil mapping U1-U3/C1', () => {
  it.each(['0001-01-01', '0099-01-01', '2000-02-01', '9999-12-01'])(
    'accepts full-range first day %s',
    (month) => expect(() => assertMyPlanMonth(month)).not.toThrow(),
  );
  it.each(['0000-01-01', '2026-13-01', '2026-02-30', '1900-02-29'])(
    'rejects impossible civil date %s',
    (month) => expect(() => assertMyPlanMonth(month)).toThrow(),
  );
  it('classifies semantic non-first separately and maps no-owner vs no-plan', () => {
    expect(() => assertMyPlanMonth('2026-12-02')).toThrow();
    expect(() => toMyMonthlyPlansResponse([], '2026-12-01')).toThrow();
    expect(toMyMonthlyPlansResponse([sentinel()], '2026-12-01')).toEqual({
      items: [],
    });
    const row = {
      ...sentinel(),
      plan_id: randomUUID(),
      project_id: randomUUID(),
      project_name: 'Synthetic',
      month_start: '2026-12-01',
    };
    expect(
      toMyMonthlyPlansResponse([row], '2026-12-01').items[0].duties,
    ).toEqual([]);
    expect(
      JSON.stringify(toMyMonthlyPlansResponse([row], '2026-12-01')),
    ).not.toContain(row.internal_owner_id);
  });
  it('maps only own safe fields, rejects corrupt snapshots and duplicate duties', () => {
    const row: OwnPlanRow = {
      ...sentinel(),
      plan_id: randomUUID(),
      project_id: randomUUID(),
      project_name: 'Synthetic',
      month_start: '2026-12-01',
      duty_id: randomUUID(),
      duty_date: '2026-12-31',
      shift_kind: 'NACHT',
      duty_function: 'SCHICHTLEITER',
      time_zone: 'Europe/Berlin',
      starts_at: '2026-12-31T17:00:00Z',
      ends_at: '2027-01-01T05:00:00Z',
    };
    expect(
      toMyMonthlyPlansResponse([row], '2026-12-01').items[0].duties[0],
    ).toEqual({
      dutyId: row.duty_id,
      dutyDate: row.duty_date,
      shiftKind: 'NIGHT',
      dutyRole: 'SHIFT_LEAD',
      timeZone: row.time_zone,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
    });
    for (const change of [
      { shift_kind: 'INVALID' },
      { duty_function: 'INVALID' },
      { time_zone: '+01:00' },
      { duty_date: '2026-02-30' },
      { ends_at: row.starts_at },
      { starts_at: '2026-12-31T24:00:00Z' },
    ])
      expect(() =>
        toMyMonthlyPlansResponse([{ ...row, ...change }], '2026-12-01'),
      ).toThrow();
    expect(() => toMyMonthlyPlansResponse([row, row], '2026-12-01')).toThrow();
  });
  it('uses only the six approved projection relations and existing schema', () => {
    expect(
      [
        ...new Set(
          [
            ...MY_MONTHLY_PLANS_QUERY.matchAll(
              /(?:FROM|JOIN)\s+public\.([a-z_]+)/gi,
            ),
          ].map((match) => match[1]),
        ),
      ].sort(),
    ).toEqual([
      'duties',
      'employees',
      'monthly_plans',
      'plan_assignments',
      'project_assignments',
      'projects',
    ]);
    const service = readFileSync(
      new URL('./me-monthly-plans-read.service.ts', import.meta.url),
      'utf8',
    );
    expect(service).toContain(
      "lockAccountsPrefix(client, tenant, ['EMPLOYEE'])",
    );
    expect(service.match(/await assertSessionInTransaction/g)).toHaveLength(2);
    expect(MY_MONTHLY_PLANS_QUERY).not.toContain('internal_company_time_zone');
  });
  it('uses exact civil/UTC/zone validation without normalization', () => {
    expect(isCivilDate('2000-02-29')).toBe(true);
    expect(isCivilDate('2026-04-31')).toBe(false);
    expect(isUtcSecond('2026-02-30T00:00:00Z')).toBe(false);
    expect(isUtcSecond('0099-01-01T00:00:00Z')).toBe(true);
    expect(isNamedTimeZone('UTC')).toBe(true);
    expect(isNamedTimeZone('+01:00')).toBe(false);
  });
});
