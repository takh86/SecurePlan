/**
 * Display of the canonical UTC instants of a duty.
 *
 * Known gap: no API exposes the company's IANA time zone, and the duty
 * response carries only UTC instants. The UI therefore shows them in the
 * device's time zone and always names that zone, so a device in another zone
 * can never present a shifted time as the company's local time. The instants
 * themselves come from the server and are never recalculated here.
 */
import { formatDate, type DateOnly } from '../../../shared/time/month';

export type InstantParts = { date: DateOnly; time: string; zone: string };

/** The device's IANA time zone (e.g. `Europe/Berlin`). */
export function deviceTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('de-DE', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

/** Local calendar date, `HH:mm` and short zone name of an instant in `timeZone`. */
export function instantParts(instant: string, timeZone: string): InstantParts {
  const parts = formatter(timeZone).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return {
    date: `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`,
    time: `${part('hour')}:${part('minute')}`,
    zone: part('timeZoneName'),
  };
}

export type DutyTimeView = {
  start: InstantParts;
  end: InstantParts;
  /** Human-readable range, e.g. `18:00 – 06:00 (Fr., 01.01.2027) MEZ`. */
  text: string;
};

/**
 * Range text relative to the duty date: a start on another local date or an
 * end on a later local date is named explicitly, and the zone appears once
 * (or per endpoint when a DST change lies inside the duty).
 */
export function dutyTimeView(duty: { dutyDate: DateOnly; startsAt: string; endsAt: string }, timeZone: string): DutyTimeView {
  const start = instantParts(duty.startsAt, timeZone);
  const end = instantParts(duty.endsAt, timeZone);
  const startText = start.date === duty.dutyDate ? start.time : `${formatDate(start.date)}, ${start.time}`;
  const endText = end.date === start.date ? end.time : `${end.time} (${formatDate(end.date)})`;
  const text = start.zone === end.zone
    ? `${startText} – ${endText} ${start.zone}`
    : `${startText} ${start.zone} – ${endText} ${end.zone}`;
  return { start, end, text };
}

/** `Do., 31.12.2026, 12:00 MEZ` for a single instant (e.g. the publication time). */
export function formatInstant(instant: string, timeZone: string): string {
  const parts = instantParts(instant, timeZone);
  return `${formatDate(parts.date)}, ${parts.time} ${parts.zone}`;
}
