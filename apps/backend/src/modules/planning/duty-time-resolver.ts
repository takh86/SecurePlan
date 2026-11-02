/**
 * D6 duty-time resolver (PO D6 / ADR-0003 N-1; SP11A-R1 T6).
 *
 * The ONLY module that imports the Temporal polyfill (exact pin
 * @js-temporal/polyfill 0.5.1; native Temporal is absent on Node 24). Swapping
 * the implementation needs no call-site change. Policy, approved by the PO:
 * - nonexistent local time (spring-forward gap) -> forward by the exact offset gap;
 * - repeated local time (fall-back fold)        -> the FIRST occurrence (earlier instant);
 * Temporal's `disambiguation: 'compatible'` is exactly that policy, and
 * `overflow: 'reject'` refuses impossible civil values instead of normalizing.
 * Each endpoint is resolved on its own local calendar date: duty_date is the
 * start date; the end moves to the next day only when end_local < start_local
 * (the approved NIGHT wrap; a DAY shift always ends later on the same day).
 *
 * Offsets come from the runtime's ICU time-zone data, so tzdata is a runtime
 * property (recorded in the boot log). Stored UTC snapshots are authoritative:
 * nothing here is ever called to recompute an existing duty.
 */
import { Logger } from '@nestjs/common';
import { Temporal } from '@js-temporal/polyfill';

/** 0001-01-01T00:00:00Z .. 9999-12-31T23:59:59Z: the range the database and RFC 3339 can carry. */
const MIN_EPOCH_SECONDS = -62_135_596_800;
const MAX_EPOCH_SECONDS = 253_402_300_799;

export type EndpointClassification = 'NORMAL' | 'GAP' | 'FOLD';
export type ResolvedEndpoint = Readonly<{ epochSeconds: number; classification: EndpointClassification }>;

/** The stored company time zone is not a recognised IANA zone: a server-side data defect (sanitized 500). */
export class DutyTimeZoneError extends Error {
  constructor() {
    super('Company time zone is not a recognised IANA zone');
    this.name = 'DutyTimeZoneError';
  }
}

function civil(localDate: string, localTime: string) {
  const [year, month, day] = localDate.split('-').map(Number);
  const [hour, minute] = localTime.split(':').map(Number);
  return { year, month, day, hour, minute };
}

function zoned(zone: string, fields: ReturnType<typeof civil>, disambiguation: 'compatible' | 'earlier' | 'later') {
  return Temporal.ZonedDateTime.from({ timeZone: zone, ...fields }, { disambiguation, overflow: 'reject' });
}

/** IANA names only: Temporal would also accept fixed offsets such as "+01:00". */
function assertZone(zone: string): void {
  if (!/^[A-Za-z]/.test(zone)) throw new DutyTimeZoneError();
  try {
    Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(zone);
  } catch {
    throw new DutyTimeZoneError();
  }
}

function epochSeconds(value: Temporal.ZonedDateTime): number {
  const seconds = value.epochMilliseconds / 1000;
  // Minute inputs plus whole-second offsets always land on whole seconds.
  if (!Number.isInteger(seconds)) throw new Error('Duty endpoint is not on a whole second');
  return seconds;
}

/**
 * Resolves one local wall-clock endpoint (YYYY-MM-DD, HH:mm) of the company
 * zone. The classification is checked explicitly: a FOLD maps back to the same
 * wall time from both candidate instants, a GAP from neither.
 */
export function resolveDutyEndpoint(input: { zone: string; localDate: string; localTime: string }): ResolvedEndpoint {
  assertZone(input.zone);
  const fields = civil(input.localDate, input.localTime);
  const earlier = zoned(input.zone, fields, 'earlier');
  const later = zoned(input.zone, fields, 'later');
  // An ordinary wall time has exactly one instant: both candidates coincide.
  if (earlier.epochNanoseconds === later.epochNanoseconds) {
    return { epochSeconds: epochSeconds(earlier), classification: 'NORMAL' };
  }
  const wall = Temporal.PlainDateTime.from(fields);
  const classification: EndpointClassification =
    Temporal.PlainDateTime.compare(earlier.toPlainDateTime(), wall) === 0 ? 'FOLD' : 'GAP';
  // Self-check of the approved policy: 'compatible' must pick gap -> later, fold -> earlier.
  const chosen = zoned(input.zone, fields, 'compatible');
  if (chosen.epochNanoseconds !== (classification === 'FOLD' ? earlier : later).epochNanoseconds) {
    throw new Error('Duty time resolver disagrees with the approved D6 policy');
  }
  return { epochSeconds: epochSeconds(chosen), classification };
}

function nextCivilDate(localDate: string): string {
  return Temporal.PlainDate.from(localDate).add({ days: 1 }).toString();
}

function isoSeconds(epochSeconds: number): string {
  // toISOString renders years 0001..9999 with four digits; drop the milliseconds.
  return new Date(epochSeconds * 1000).toISOString().replace('.000Z', 'Z');
}

export type ResolvedInterval = Readonly<{ startsAt: string; endsAt: string }>;

/**
 * Resolves a duty's UTC interval, or null when the saved configuration cannot
 * produce a valid interval for this date (non-positive or unrepresentable):
 * the caller answers 409 DUTY_TIME_RANGE_INVALID and writes nothing.
 */
export function resolveDutyInterval(input: {
  zone: string;
  dutyDate: string;
  startLocal: string;
  endLocal: string;
}): ResolvedInterval | null {
  // HH:mm strings compare chronologically.
  const endDate = input.endLocal < input.startLocal ? nextCivilDate(input.dutyDate) : input.dutyDate;
  const start = resolveDutyEndpoint({ zone: input.zone, localDate: input.dutyDate, localTime: input.startLocal });
  const end = resolveDutyEndpoint({ zone: input.zone, localDate: endDate, localTime: input.endLocal });
  if (end.epochSeconds <= start.epochSeconds) return null;
  if (start.epochSeconds < MIN_EPOCH_SECONDS || end.epochSeconds > MAX_EPOCH_SECONDS) return null;
  return { startsAt: isoSeconds(start.epochSeconds), endsAt: isoSeconds(end.epochSeconds) };
}

/** The four approved D6 goldens (PO decision record and ADR-0003 addendum). */
export const D6_GOLDENS = [
  { zone: 'Europe/Berlin', localDate: '2026-03-29', localTime: '02:30', utc: '2026-03-29T01:30:00Z' },
  { zone: 'Europe/Berlin', localDate: '2026-10-25', localTime: '02:30', utc: '2026-10-25T00:30:00Z' },
  { zone: 'America/New_York', localDate: '2026-03-08', localTime: '02:30', utc: '2026-03-08T07:30:00Z' },
  { zone: 'America/New_York', localDate: '2026-11-01', localTime: '01:30', utc: '2026-11-01T05:30:00Z' },
] as const;

/**
 * Boot self-test: fails closed (the application does not start) if the runtime
 * no longer reproduces the approved goldens, e.g. after an ICU/tzdata or
 * library change. Logs the runtime time-zone data versions it ran on.
 */
export function assertDutyTimeResolverReady(logger = new Logger('DutyTimeResolver')): void {
  for (const golden of D6_GOLDENS) {
    const actual = isoSeconds(resolveDutyEndpoint(golden).epochSeconds);
    if (actual !== golden.utc) throw new Error('Duty time resolver failed its D6 golden self-test');
  }
  logger.log(JSON.stringify({
    event: 'planning.resolver.ready',
    node: process.versions.node,
    icu: process.versions.icu,
    tz: process.versions.tz,
  }));
}
