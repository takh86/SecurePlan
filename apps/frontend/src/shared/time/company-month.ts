import type { MonthKey } from './month';

/**
 * The company's IANA time zone is not available to the client (no API exposes
 * it), so the client cannot know the company's current month at a month
 * boundary. Supported time zones range from UTC-12 to UTC+14: the company's
 * local time is never earlier than "now - 12 h" in UTC. The month of that
 * instant is therefore the EARLIEST month the company can currently be in.
 *
 * Only UTC methods are used: neither the browser's time zone nor any fixed
 * zone (e.g. Europe/Berlin) influences the result.
 */
const MAX_NEGATIVE_UTC_OFFSET_MS = 12 * 60 * 60 * 1000;
const MAX_POSITIVE_UTC_OFFSET_MS = 14 * 60 * 60 * 1000;

function utcMonth(instant: Date): MonthKey {
  const year = instant.getUTCFullYear();
  const month = instant.getUTCMonth() + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

export function earliestPossibleCompanyMonth(now: Date): MonthKey {
  return utcMonth(new Date(now.getTime() - MAX_NEGATIVE_UTC_OFFSET_MS));
}

/** The LATEST month the company can currently be in (local time is never later than now + 14 h). */
export function latestPossibleCompanyMonth(now: Date): MonthKey {
  return utcMonth(new Date(now.getTime() + MAX_POSITIVE_UTC_OFFSET_MS));
}

/**
 * #73 R2-a hint for actions allowed only in months AFTER the company's current
 * month (removing an assignment):
 * - `never`: not after the current month in any supported time zone;
 * - `always`: after it in every supported time zone;
 * - `uncertain`: the about 26 h around a month change in which only the
 *   company's time zone decides.
 * A hint only: with a correct device clock no removable month is hidden, and
 * the server decides with the real company time zone in every case.
 */
export function futureMonthCertainty(month: MonthKey, now: Date): 'never' | 'uncertain' | 'always' {
  if (month <= earliestPossibleCompanyMonth(now)) return 'never';
  return month > latestPossibleCompanyMonth(now) ? 'always' : 'uncertain';
}

/**
 * True only for a month that is in the past in EVERY supported time zone.
 * Used solely to show the shift configuration read-only; the server decides
 * writes with the real company time zone (a month in the boundary window is
 * offered, and the server may still refuse it).
 */
export function isCertainlyPastMonth(month: MonthKey, now: Date): boolean {
  return month < earliestPossibleCompanyMonth(now);
}
