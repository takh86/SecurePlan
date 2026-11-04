/**
 * SP11A-R1 T6 differential test: the production adapter against an independent
 * Intl.DateTimeFormat oracle over the Appendix-E matrix (13 zones incl. 30/45-min
 * and negative-DST zones, every offset transition 2020-2040, every local minute
 * from 4 h before to 4 h after each transition). Any mismatch fails the build.
 *
 * Both sides read the runtime's ICU offsets, so agreement proves the gap/fold
 * policy implementation, not tzdata correctness (tzdata is a runtime property).
 */
import { createHash } from 'node:crypto';
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

type OffsetAt = (utcMs: number) => number;
type Transition = { t: number; previous: number; offset: number };

/**
 * Reference discovery: every 15-minute grid point (counted from `from`) whose
 * offset differs from the grid point before it. This is sound for any rules
 * whose transitions are at least 15 minutes apart, but costs ~9.6 million ICU
 * probes (~30 s) for the full matrix.
 */
function exhaustiveTransitions(offsetAt: OffsetAt, from: number, until: number): Transition[] {
  const found: Transition[] = [];
  let previous = offsetAt(from);
  for (let t = from + STEP; t < until; t += STEP) {
    const offset = offsetAt(t);
    if (offset === previous) continue;
    found.push({ t, previous, offset });
    previous = offset;
  }
  return found;
}

/**
 * Fast discovery: probe once per day and bisect on the same 15-minute grid
 * inside each day whose end offset differs from its start offset.
 *
 * NOT sound on its own: a day containing two transitions with a net-zero
 * offset change (e.g. +00 -> +01 -> +00) has equal end offsets and is skipped
 * silently, and no assertion on the transitions it does find can notice that.
 * Its result is used only through discoverTransitions, which accepts it only
 * when it reproduces a list that the exhaustive scan confirmed.
 */
const COARSE_STEP = 96 * STEP;
function dailyTransitions(offsetAt: OffsetAt, from: number, until: number): Transition[] {
  const found: Transition[] = [];
  let lo = from;
  let previous = offsetAt(from);
  while (lo + STEP < until) {
    const hi = Math.min(lo + COARSE_STEP, until - STEP);
    if (offsetAt(hi) === previous) {
      lo = hi;
      continue;
    }
    // Invariant: offset(a) === previous, offset(b) !== previous; a and b stay on the grid.
    let a = lo;
    let b = hi;
    while (b - a > STEP) {
      const mid = a + Math.floor((b - a) / STEP / 2) * STEP;
      if (offsetAt(mid) === previous) a = mid;
      else b = mid;
    }
    const offset = offsetAt(b);
    found.push({ t: b, previous, offset });
    previous = offset;
    lo = b;
  }
  return found;
}

type Discovery = { mode: 'verified-baseline' | 'exhaustive'; sha256: string; transitions: Array<[string, Transition[]]> };
function digest(transitions: Array<[string, Transition[]]>): string {
  const lines = transitions.flatMap(([label, list]) => list.map(({ t, previous, offset }) => `${label} ${t} ${previous} ${offset}`));
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * Uses the fast daily scan only when the runtime's ICU/tzdata versions are a
 * verified baseline AND the fast result reproduces, digest for digest, the
 * transition list that the exhaustive 15-minute scan produced on that baseline.
 * Any other runtime (new tzdata, other ICU) or any digest difference falls back
 * to the exhaustive scan, so a tzdata update cannot shrink the matrix silently.
 * The fast path relies on the ICU and tzdata version strings identifying the
 * offset data; a build that patches tzdata without changing its version string
 * is outside what this check can see.
 */
function discoverTransitions(
  sources: ReadonlyArray<readonly [string, OffsetAt]>,
  baseline: string,
  verified: Readonly<Record<string, string>>,
  from = FROM,
  until = UNTIL,
): Discovery {
  const pinned = verified[baseline];
  if (pinned !== undefined) {
    const fast = sources.map(([label, offsetAt]): [string, Transition[]] => [label, dailyTransitions(offsetAt, from, until)]);
    const sha256 = digest(fast);
    if (sha256 === pinned) return { mode: 'verified-baseline', sha256, transitions: fast };
  }
  const full = sources.map(([label, offsetAt]): [string, Transition[]] => [label, exhaustiveTransitions(offsetAt, from, until)]);
  return { mode: 'exhaustive', sha256: digest(full), transitions: full };
}

/**
 * `${process.versions.icu}/${process.versions.tz}` -> SHA-256 of the transition
 * list the EXHAUSTIVE 15-minute scan produced for ZONES on that runtime
 * ("zone t previous offset" lines joined by "\n"). Add an entry only from an
 * exhaustive run on that exact runtime; this test logs both values.
 */
const VERIFIED_BASELINES: Readonly<Record<string, string>> = {
  // Node 24.21.0, local run 2026-11-04: 315 transitions.
  '78.3/2026c': '1cc593c4a75b19c622e939e43dc6af7c7f00dafa3c988a99839bb8e6079f2b5d',
};

describe('D6 differential: production adapter vs. Intl oracle (Appendix-E matrix)', () => {
  it('agrees on every local minute around every transition 2020-2040 in 13 zones', () => {
    let comparisons = 0;
    let transitions = 0;
    const mismatches: string[] = [];
    const baseline = `${process.versions.icu ?? 'none'}/${process.versions.tz ?? 'none'}`;
    const discovery = discoverTransitions(
      ZONES.map((zone) => [zone, (utcMs: number) => offsetMs(utcMs, zone)] as const),
      baseline,
      VERIFIED_BASELINES,
    );
    for (const [zone, found] of discovery.transitions) {
      for (const { t, previous, offset } of found) {
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
      }
    }
    expect(mismatches).toEqual([]);
    // Guards against a silently shrunken matrix (e.g. a runtime without these zones' rules).
    expect(transitions).toBeGreaterThanOrEqual(300);
    expect(comparisons).toBe(transitions * 481);
    console.info(JSON.stringify({
      event: 'planning.differential.checked', zones: ZONES.length, transitions, comparisons,
      discovery: discovery.mode, baseline, transitionsSha256: discovery.sha256,
    }));
  }, 300_000);
});

describe('D6 transition discovery: the fast daily scan is accepted only when verified', () => {
  // Synthetic zone: +00, then +01 from 06:00 to 18:00 UTC on one day, then +00 again.
  const day = Date.UTC(2030, 0, 10);
  const hour = 3_600_000;
  const pair: OffsetAt = (utcMs) => (utcMs >= day + 6 * hour && utcMs < day + 18 * hour ? hour : 0);
  const from = day - DAY;
  const until = day + 2 * DAY;
  const bothChanges = [
    { t: day + 6 * hour, previous: 0, offset: hour },
    { t: day + 18 * hour, previous: hour, offset: 0 },
  ];
  const sha256OfBoth = digest([['synthetic', bothChanges]]);

  it('documents the blind spot: the daily scan alone misses a net-zero pair inside one day', () => {
    expect(dailyTransitions(pair, from, until)).toEqual([]);
    expect(exhaustiveTransitions(pair, from, until)).toEqual(bothChanges);
  });

  it('falls back to the exhaustive scan for an unknown baseline or an unreproduced digest', () => {
    const unknown = discoverTransitions([['synthetic', pair]], 'icu-x/tz-unknown', {}, from, until);
    expect(unknown.mode).toBe('exhaustive');
    expect(unknown.transitions).toEqual([['synthetic', bothChanges]]);

    // A registered baseline whose confirmed list contains the pair: the fast scan
    // does not reproduce its digest, so the pair is still found and tested.
    const changed = discoverTransitions([['synthetic', pair]], 'known', { known: sha256OfBoth }, from, until);
    expect(changed.mode).toBe('exhaustive');
    expect(changed.sha256).toBe(sha256OfBoth);
    expect(changed.transitions).toEqual([['synthetic', bothChanges]]);
  });

  it('uses the fast scan only when it reproduces the verified digest exactly', () => {
    const single: OffsetAt = (utcMs) => (utcMs >= day + 6 * hour ? hour : 0);
    const expected = digest([['synthetic', [bothChanges[0]]]]);
    const verified = discoverTransitions([['synthetic', single]], 'known', { known: expected }, from, until);
    expect(verified.mode).toBe('verified-baseline');
    expect(verified.transitions).toEqual([['synthetic', [bothChanges[0]]]]);
  });
});
