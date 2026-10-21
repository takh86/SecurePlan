import type { ShiftView } from '../shift/shift-view';
import { formatDate } from '../time/month';

/**
 * Start/end of a shift. Preview data is labelled "Beispielzeit" so synthetic
 * example times are never mistaken for approved shift rules.
 */
export function ShiftTime({ shift, example }: { shift: ShiftView; example: boolean }) {
  return (
    <span className="shift-time">
      <span className="shift-time__label">{example ? 'Beispielzeit' : 'Dienstzeit'}:</span>{' '}
      {shift.start} – {shift.end}
      {shift.endDate !== shift.date && ` (${formatDate(shift.endDate)})`}
    </span>
  );
}
