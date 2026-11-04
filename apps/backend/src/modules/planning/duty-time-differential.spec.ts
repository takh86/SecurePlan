/**
 * SP11A-R1 T6 differential test: the production adapter against an independent
 * Intl.DateTimeFormat oracle over the Appendix-E matrix (13 zones incl. 30/45-min
 * and negative-DST zones, every offset transition 2020-2040, every local minute
 * from 4 h before to 4 h after each transition). Any mismatch fails the build.
 *
 * Both sides read the runtime's ICU offsets, so agreement proves the gap/fold
 * policy implementation, not tzdata correctness (tzdata is a runtime property).
 */
import { resolveDutyEndpoint } from './duty-time-resolver.js';

const ZONES = [
  'Europe/Berlin', 'America/New_York', 'Australia/Lord_Howe', 'Asia/Kathmandu', 'Africa/Casablanca',
  'Europe/Dublin', 'Pacific/Chatham', 'Asia/Tehran', 'America/Sao_Paulo', 'Australia/Sydney', 'UTC',
  'Asia/Kolkata', 'America/St_Johns',
] as const;
const FROM = Date.UTC(2020, 0, 1);
const UNTIL = Date.UTC(2041, 0, 1);
const STEP = 15 * 60_000;
const DAY = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
function offsetMs(utcMs: number, zone: string): number {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', hour: '2-digit', timeZoneName: 'longOffset',
    });
    formatters.set(zone, format);
  }
  // Ask ICU for its numeric offset directly. Every 15-minute discovery probe
  // and every oracle candidate is retained; avoid allocating full civil-date
  // parts and rebuilding a UTC Date for millions of probes.
  const name = format.formatToParts(utcMs).find((part) => part.type === 'timeZoneName')?.value ?? '';
  if (name === 'GMT') return 0;
  const match = /^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(name);
  if (!match) throw new Error(`Unexpected Intl numeric offset: ${name}`);
  return (match[1] === '-' ? -1 : 1) * (+match[2] * 3600 + +match[3] * 60 + +(match[4] ?? 0)) * 1000;
}

/** Oracle of the approved policy: gap -> pre-transition offset (later instant); fold -> earliest valid instant. */
function oracle(wall: number, zone: string): number {
  const before = offsetMs(wall - DAY, zone);
  const after = offsetMs(wall + DAY, zone);
  const valid = [...new Set([before, after])].map((offset) => wall - offset).filter((utc) => offsetMs(utc, zone) === wall - utc);
  return valid.length === 0 ? wall - before : Math.min(...valid);
}

const pad = (value: number) => String(value).padStart(2, '0');

/**
 * Every offset transition of `zone` in [FROM, UNTIL), reported as the first
 * 15-minute grid point (counted from FROM) whose offset differs from the grid
 * point before it, which is exactly what a full 15-minute scan reports.
 *
 * A full scan costs ~9.6 million ICU probes (~30 s). Instead, probe once per
 * day and bisect on the same 15-minute grid inside each day whose end offset
 * changed. This finds the same transitions as long as no two transitions of
 * one zone fall within the same day. The caller asserts a minimum gap of more
 * than two coarse steps, so a runtime whose rules violate that assumption fails
 * the test instead of shrinking the matrix. On Node 24.21.0 (ICU 78.3,
 * tz 2026c) both methods yield the same 315 transitions, and the smallest
 * same-zone gap is 35 days.
 */
const COARSE_STEP = 96 * STEP;
function* transitionsOf(zone: string): Generator<{ t: number; previous: number; offset: number }> {
  let lo = FROM;
  let previous = offsetMs(FROM, zone);
  while (lo + STEP < UNTIL) {
    const hi = Math.min(lo + COARSE_STEP, UNTIL - STEP);
    if (offsetMs(hi, zone) === previous) {
      lo = hi;
      continue;
    }
    // Invariant: offset(a) === previous, offset(b) !== previous; a and b stay on the grid.
    let a = lo;
    let b = hi;
    while (b - a > STEP) {
      const mid = a + Math.floor((b - a) / STEP / 2) * STEP;
      if (offsetMs(mid, zone) === previous) a = mid;
      else b = mid;
    }
    const offset = offsetMs(b, zone);
    yield { t: b, previous, offset };
    previous = offset;
    lo = b;
  }
}

describe('D6 differential: production adapter vs. Intl oracle (Appendix-E matrix)', () => {
  it('agrees on every local minute around every transition 2020-2040 in 13 zones', () => {
    let comparisons = 0;
    let transitions = 0;
    let minSameZoneGap = Infinity;
    const mismatches: string[] = [];
    for (const zone of ZONES) {
      let lastTransition: number | undefined;
      for (const { t, previous, offset } of transitionsOf(zone)) {
        transitions += 1;
        if (lastTransition !== undefined) minSameZoneGap = Math.min(minSameZoneGap, t - lastTransition);
        lastTransition = t;
        const firstWall = t + Math.min(offset, previous) - 4 * 3_600_000;
        for (let minute = 0; minute <= 8 * 60; minute += 1) {
          const wall = firstWall + minute * 60_000;
          const w = new Date(wall);
          const localDate = `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}`;
          const localTime = `${pad(w.getUTCHours())}:${pad(w.getUTCMinutes())}`;
          const actual = resolveDutyEndpoint({ zone, localDate, localTime }).epochSeconds * 1000;
          comparisons += 1;
          if (actual !== oracle(wall, zone) && mismatches.length < 10) mismatches.push(`${zone} ${localDate}T${localTime}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
    // Guards against a silently shrunken matrix (e.g. a runtime without these zones' rules).
    expect(transitions).toBeGreaterThanOrEqual(300);
    expect(comparisons).toBe(transitions * 481);
    // Guards the coarse-discovery assumption (see transitionsOf).
    expect(minSameZoneGap).toBeGreaterThan(2 * COARSE_STEP);
    console.info(JSON.stringify({ event: 'planning.differential.checked', zones: ZONES.length, transitions, comparisons }));
  }, 300_000);
});
