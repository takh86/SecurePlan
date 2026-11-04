import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../shared/api/api-error';
import {
  createPlanningStatisticsSource,
  parsePlanningStatistics,
} from './my-statistics-api';
import { employeeIdentity } from '../my-month-plan/my-month-plan.test-support';
const valid = {
  monthStart: '2026-12-01',
  plannedWorkdays: 2,
  dayShiftCount: 1,
  nightShiftCount: 1,
};
describe('SP15 U05 whole statistics response', () => {
  it('accepts exact counts, bounds, zeros and large independent safe integers without unsafe sums', () => {
    expect(parsePlanningStatistics(valid, valid.monthStart)).toEqual(valid);
    for (const month of [
      '0001-01-01',
      '0099-01-01',
      '2000-02-01',
      '9999-12-01',
    ]) {
      const zero = {
        monthStart: month,
        plannedWorkdays: 0,
        dayShiftCount: 0,
        nightShiftCount: 0,
      };
      expect(parsePlanningStatistics(zero, month)).toEqual(zero);
    }
    expect(
      parsePlanningStatistics(
        {
          ...valid,
          dayShiftCount: Number.MAX_SAFE_INTEGER,
          nightShiftCount: Number.MAX_SAFE_INTEGER,
        },
        valid.monthStart,
      ).plannedWorkdays,
    ).toBe(2);
  });
  it.each([
    null,
    [],
    {},
    { ...valid, status: 'PUBLISHED' },
    { ...valid, monthStart: '2027-01-01' },
    ...['plannedWorkdays', 'dayShiftCount', 'nightShiftCount'].flatMap((key) =>
      [
        undefined,
        null,
        '1',
        -1,
        0.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
      ].map((value) => ({ ...valid, [key]: value })),
    ),
    { ...valid, plannedWorkdays: 3 },
    { ...valid, plannedWorkdays: 0 },
    { ...valid, dayShiftCount: 0, nightShiftCount: 0 },
    { ...valid, plannedWorkdays: 32, dayShiftCount: 40 },
    {
      ...valid,
      monthStart: '2026-02-01',
      plannedWorkdays: 29,
      dayShiftCount: 30,
    },
  ])('rejects malformed or inconsistent response %j', (raw) => {
    try {
      parsePlanningStatistics(raw, valid.monthStart);
      throw new Error('accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).kind).toBe('invalid-response');
    }
  });
  it.each(['0000-01-01', '2026-02-30', '2026-12-02', '10000-01-01'])(
    'rejects invalid requested month %s',
    (month) => {
      expect(() =>
        parsePlanningStatistics({ ...valid, monthStart: month }, month),
      ).toThrow(ApiError);
    },
  );
  it.each(['accountId', 'companyId', 'role'])(
    'principal mismatch %s invalidates synchronously before statistics request',
    async (key) => {
      const request = vi.fn().mockResolvedValue({
        ...employeeIdentity,
        [key]:
          key === 'role'
            ? 'COMPANY_ADMIN'
            : '99999999-9999-4999-8999-999999999999',
      });
      const revalidate = vi.fn();
      await expect(
        createPlanningStatisticsSource(
          { request },
          employeeIdentity,
          revalidate,
        ).load('2026-12', new AbortController().signal),
      ).rejects.toThrow();
      expect(revalidate).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledExactlyOnceWith(
        '/api/v1/me',
        expect.anything(),
      );
    },
  );
});

it.each(['companyTimeZone', 'currentCompanyMonth'])(
  'F03 malformed me metadata %s prevents any statistics request',
  async (key) => {
    const request = vi
      .fn()
      .mockResolvedValue({ ...employeeIdentity, [key]: null });
    await expect(
      createPlanningStatisticsSource(
        { request },
        employeeIdentity,
        vi.fn(),
      ).load('2026-12', new AbortController().signal),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  },
);
it('rejects month day-count overflow and each missing field; accepts leap-day cardinality', () => {
  for (const key of Object.keys(valid)) {
    const row: Record<string, unknown> = { ...valid };
    delete row[key];
    expect(() => parsePlanningStatistics(row, valid.monthStart)).toThrow(
      ApiError,
    );
  }
  const leap = {
    monthStart: '2000-02-01',
    plannedWorkdays: 29,
    dayShiftCount: 29,
    nightShiftCount: 0,
  };
  expect(parsePlanningStatistics(leap, leap.monthStart)).toEqual(leap);
  for (const month of ['1900-02-01', '2026-02-01', '2026-04-01']) {
    const row = {
      ...leap,
      monthStart: month,
      plannedWorkdays: 31,
      dayShiftCount: 31,
    };
    expect(() => parsePlanningStatistics(row, month)).toThrow(ApiError);
  }
});
