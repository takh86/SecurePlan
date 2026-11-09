import { planDateLabel, zonedDutyTime } from '../../../shared/time/civil-time';
import type { DutyRef } from './work-queue-types';

/** UTC timestamp for administrative evaluation times. The label is explicit; the browser zone is never used. */
export function formatUtc(instant: string): string {
  const formatted = new Intl.DateTimeFormat('de-DE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(instant));
  return `${formatted} UTC`;
}

/**
 * Start and end of a duty in its saved time zone. The end date is shown when it
 * differs from the start date, so an overnight shift stays readable.
 */
export function dutyTimeText(duty: DutyRef, timeZone: string): string {
  const start = zonedDutyTime(duty.startsAt, timeZone);
  const end = zonedDutyTime(duty.endsAt, timeZone);
  const endDate = end.date === start.date ? '' : ` (${planDateLabel(end.date)})`;
  return `${start.time} – ${end.time}${endDate}`;
}
