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
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(zone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - utcMs;
}

/** Oracle of the approved policy: gap -> pre-transition offset (later instant); fold -> earliest valid instant. */
function oracle(wall: number, zone: string): number {
  const before = offsetMs(wall - DAY, zone);
  const after = offsetMs(wall + DAY, zone);
  const valid = [...new Set([before, after])].map((offset) => wall - offset).filter((utc) => offsetMs(utc, zone) === wall - utc);
  return valid.length === 0 ? wall - before : Math.min(...valid);
}

const pad = (value: number) => String(value).padStart(2, '0');

describe('D6 differential: production adapter vs. Intl oracle (Appendix-E matrix)', () => {
  it('agrees on every local minute around every transition 2020-2040 in 13 zones', () => {
    let comparisons = 0;
    let transitions = 0;
    const mismatches: string[] = [];
    for (const zone of ZONES) {
      let previous = offsetMs(FROM, zone);
      for (let t = FROM + STEP; t < UNTIL; t += STEP) {
        const offset = offsetMs(t, zone);
        if (offset === previous) continue;
        transitions += 1;
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
        previous = offset;
      }
    }
    expect(mismatches).toEqual([]);
    // Guards against a silently shrunken matrix (e.g. a runtime without these zones' rules).
    expect(transitions).toBeGreaterThanOrEqual(300);
    expect(comparisons).toBe(transitions * 481);
  }, 300_000);
});
