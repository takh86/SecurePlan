import { syntheticExampleShift } from '../../../shared/preview/synthetic-shift-times';
import type { ShiftType } from '../../../shared/shift/shift-view';
import { dateInMonth, daysInMonth, type MonthKey } from '../../../shared/time/month';
import type { DutyStatus, MyMonthPlan } from './my-month-plan-types';

/**
 * Synthetic in-memory fixtures for the personal month plan UI preview only.
 * The duty pattern, project names and shift times are invented examples, not
 * an API payload and not approved planning or shift rules.
 */
const SYNTHETIC_DUTY_PATTERN: ReadonlyArray<{ day: number | 'last'; type: ShiftType; status?: DutyStatus }> = [
  { day: 2, type: 'DAY' },
  { day: 3, type: 'DAY' },
  { day: 6, type: 'NIGHT' },
  { day: 7, type: 'NIGHT' },
  { day: 11, type: 'DAY' },
  { day: 14, type: 'DAY', status: 'CANCELLATION_REQUESTED' },
  { day: 18, type: 'NIGHT' },
  { day: 22, type: 'DAY' },
  { day: 25, type: 'NIGHT' },
  // Last day of the month: shows a night shift ending in the next month or year.
  { day: 'last', type: 'NIGHT' },
];

export function buildMyMonthPlanFixture(month: MonthKey, projectName: string): MyMonthPlan {
  const duties = SYNTHETIC_DUTY_PATTERN.flatMap((entry) => {
    const date = dateInMonth(month, entry.day === 'last' ? daysInMonth(month) : entry.day);
    if (date === null) return [];
    return [{
      reference: `VORSCHAU-${date}`,
      shift: syntheticExampleShift(date, entry.type),
      projectName,
      status: entry.status ?? 'PLANNED',
    }];
  });
  return { duties };
}
