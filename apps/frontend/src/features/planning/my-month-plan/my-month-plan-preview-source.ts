import { systemClock, type Clock } from '../../../shared/time/clock';
import { addMonths, currentMonth } from '../../../shared/time/month';
import { buildMyMonthPlanFixture } from './my-month-plan-fixtures';
import type { MyMonthPlanSource } from './my-month-plan-types';

/**
 * Preview adapter: synthetic plans exist only for the clock's current and next
 * month; every other month behaves like "no published plan". No network call,
 * no persistence, no invented endpoint.
 */
export function createMyMonthPlanPreviewSource(clock: Clock): MyMonthPlanSource {
  return {
    kind: 'preview',
    load: (month) => {
      const current = currentMonth(clock);
      if (month === current) return Promise.resolve(buildMyMonthPlanFixture(month, 'Demo-Objekt Nord'));
      if (month === addMonths(current, 1)) return Promise.resolve(buildMyMonthPlanFixture(month, 'Demo-Objekt Hafen'));
      return Promise.resolve(null);
    },
  };
}

export const defaultMyMonthPlanSource = createMyMonthPlanPreviewSource(systemClock);
