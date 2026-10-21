import type { ShiftType, ShiftView } from '../shift/shift-view';
import { addDays, type DateOnly } from '../time/month';

/**
 * SYNTHETIC EXAMPLE values for UI previews only.
 * NOT an approved shift rule; real times are project-specific and come from the future API.
 */
export const SYNTHETIC_EXAMPLE_SHIFT_TIMES: Record<ShiftType, { start: string; end: string; endsNextDay: boolean }> = {
  DAY: { start: '06:00', end: '18:00', endsNextDay: false },
  NIGHT: { start: '18:00', end: '06:00', endsNextDay: true },
};

/** Builds a preview shift from the synthetic example times above. Preview fixtures only. */
export function syntheticExampleShift(date: DateOnly, type: ShiftType): ShiftView {
  const times = SYNTHETIC_EXAMPLE_SHIFT_TIMES[type];
  return {
    date,
    type,
    start: times.start,
    end: times.end,
    endDate: times.endsNextDay ? addDays(date, 1) : date,
  };
}
