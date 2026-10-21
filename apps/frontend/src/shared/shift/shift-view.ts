import type { DateOnly } from '../time/month';

export type ShiftType = 'DAY' | 'NIGHT';

/**
 * UI view model of one planned shift (a planned assignment, not attendance).
 * `endDate` is explicit so the UI never derives shift rules on its own.
 */
export interface ShiftView {
  date: DateOnly;
  type: ShiftType;
  /** Wall-clock start, `HH:MM`. */
  start: string;
  /** Wall-clock end, `HH:MM`. */
  end: string;
  endDate: DateOnly;
}

export const SHIFT_TYPE_LABELS: Record<ShiftType, string> = {
  DAY: 'Tagdienst',
  NIGHT: 'Nachtdienst',
};
