import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MePlanningStatisticsController } from './me-planning-statistics.controller.js';
import {
  aggregatePlanningStatistics,
  MePlanningStatisticsService,
} from './me-planning-statistics.service.js';
import type { MeMonthlyPlansReadService } from './me-monthly-plans-read.service.js';
import type {
  MyDuty,
  MyMonthlyPlansResponse,
} from './me-monthly-plan.types.js';
import type { TenantContext } from '../../auth/authorization/tenant-context.js';

const month = '2026-12-01';
function model(
  slots: [string, MyDuty['shiftKind']][][],
): MyMonthlyPlansResponse {
  return {
    items: slots.map((duties) => ({
      planId: randomUUID(),
      project: { id: randomUUID(), name: 'Synthetic' },
      monthStart: month,
      duties: duties.map(([dutyDate, shiftKind], i) => ({
        dutyId: randomUUID(),
        assignmentId: randomUUID(),
        version: 1,
        dutyDate,
        shiftKind,
        startsAt: '2026-12-31T17:00:00Z',
        endsAt: '2027-01-01T05:00:00Z',
        timeZone: i % 2 ? 'America/New_York' : 'Europe/Berlin',
        dutyRole: i % 2 ? 'SHIFT_LEAD' : 'EMPLOYEE',
      })),
    })),
  };
}
const expected = (days: number, day: number, night: number) => ({
  monthStart: month,
  plannedWorkdays: days,
  dayShiftCount: day,
  nightShiftCount: night,
});
describe('SP15 U01-U04 synchronous authorized reduction', () => {
  it.each([[], [[]], [[], []]].map((slots) => ({ slots })))(
    'uses identical zero semantics for authorized empty shapes $slots',
    ({ slots }) => {
      expect(aggregatePlanningStatistics(model(slots), month)).toEqual(
        expected(0, 0, 0),
      );
    },
  );
  it('deduplicates saved dates globally without suppressing independent shifts or mutating the read', () => {
    // Broader read-model arithmetic; this does not assert current writer reachability.
    const data = model([
      [['2026-12-04', 'DAY']],
      [['2026-12-04', 'DAY']],
      [['2026-12-05', 'NIGHT']],
    ]);
    const before = structuredClone(data);
    expect(aggregatePlanningStatistics(data, month)).toEqual(expected(2, 2, 1));
    expect(data).toEqual(before);
    expect(
      aggregatePlanningStatistics(
        model([[['2026-12-04', 'DAY']], [['2026-12-04', 'NIGHT']]]),
        month,
      ),
    ).toEqual(expected(1, 1, 1));
  });
  it.each([
    '0001-01-01',
    '0099-01-01',
    '2000-02-29',
    '2026-03-29',
    '2026-10-25',
    '9999-12-31',
  ])(
    'counts saved civil date %s independently of instants/zone/DST',
    (date) => {
      const m = `${date.slice(0, 7)}-01`;
      expect(
        aggregatePlanningStatistics(model([[[date, 'NIGHT']]]), m),
      ).toEqual({ ...expected(1, 0, 1), monthStart: m });
    },
  );
  it('controller and adapter pass trusted context and required query unchanged; delegate once', async () => {
    const tenant: TenantContext = {
      sessionId: randomUUID(),
      accountId: randomUUID(),
      companyId: randomUUID(),
      role: 'EMPLOYEE',
    };
    const read = vi.fn().mockResolvedValue(model([[['2026-12-31', 'NIGHT']]]));
    const service = new MePlanningStatisticsService({
      read,
    } as unknown as MeMonthlyPlansReadService);
    const controller = new MePlanningStatisticsController(service);
    expect(await controller.read(tenant, { monthStart: month })).toEqual(
      expected(1, 0, 1),
    );
    expect(read).toHaveBeenCalledExactlyOnceWith(tenant, month);
  });
  it.each(['authorization', 'SQL', 'schema', 'mapper'])(
    'never converts %s failure into zeros',
    async (message) => {
      const error = new Error(message),
        read = vi.fn().mockRejectedValue(error);
      const service = new MePlanningStatisticsService({
        read,
      } as unknown as MeMonthlyPlansReadService);
      await expect(service.read({} as TenantContext, month)).rejects.toBe(
        error,
      );
      expect(read).toHaveBeenCalledTimes(1);
    },
  );
});
