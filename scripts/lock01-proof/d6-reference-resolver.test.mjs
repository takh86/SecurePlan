/**
 * SP11A-R1 D6 reference fixtures. REVIEW-ONLY ORACLE built on Intl.DateTimeFormat; it is NOT the proposed
 * production resolver (that is Temporal ZonedDateTime.from with disambiguation:'compatible', overflow:'reject').
 * Purpose: pin the exact UTC expectations and rejection cases so the production implementation can be
 * checked against the same table. Run: node --test scripts/lock01-proof/d6-reference-resolver.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const fmtCache = new Map();
function offsetMs(utcMs, zone) {
  let f = fmtCache.get(zone);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); fmtCache.set(zone, f); }
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}
/** compatible: gap -> later (shift forward by gap length); fold -> earlier (first occurrence). */
export function resolve(local, zone) {
  const [d, t] = local.split('T'); const [y, mo, da] = d.split('-').map(Number); const [h, mi] = t.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, da, h, mi, 0);
  const before = offsetMs(wall - 86_400_000, zone); const after = offsetMs(wall + 86_400_000, zone);
  const valid = [...new Set([before, after])].map((o) => wall - o).filter((u) => offsetMs(u, zone) === wall - u);
  if (valid.length === 0) return wall - before;      // gap: pre-transition offset moves the instant later
  return Math.min(...valid);                          // fold: earlier instant
}
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const B = 'Europe/Berlin'; const NY = 'America/New_York'; const LH = 'Australia/Lord_Howe';

const POINTS = [
  ['Berlin spring gap 02:30', '2026-03-29T02:30', B, '2026-03-29T01:30:00Z'],
  ['Berlin repeated hour first occurrence', '2026-10-25T02:30', B, '2026-10-25T00:30:00Z'],
  ['New York spring gap', '2026-03-08T02:30', NY, '2026-03-08T07:30:00Z'],
  ['New York repeated hour first occurrence', '2026-11-01T01:30', NY, '2026-11-01T05:30:00Z'],
  ['New York unambiguous 02:30 on fall-back day', '2026-11-01T02:30', NY, '2026-11-01T07:30:00Z'],
  ['Lord Howe half-hour gap', '2026-10-04T02:15', LH, '2026-10-03T15:45:00Z'],
];
for (const [name, local, zone, utc] of POINTS) test(`point: ${name}`, () => assert.equal(iso(resolve(local, zone)), utc));

const NIGHTS = [
  ['Berlin spring NIGHT', '2026-03-28T18:00', '2026-03-29T06:00', B, '2026-03-28T17:00:00Z', '2026-03-29T04:00:00Z', 11],
  ['Berlin autumn NIGHT', '2026-10-24T18:00', '2026-10-25T06:00', B, '2026-10-24T16:00:00Z', '2026-10-25T05:00:00Z', 13],
  ['NY spring NIGHT', '2026-03-07T18:00', '2026-03-08T06:00', NY, '2026-03-07T23:00:00Z', '2026-03-08T10:00:00Z', 11],
  ['NY autumn NIGHT', '2026-10-31T18:00', '2026-11-01T06:00', NY, '2026-10-31T22:00:00Z', '2026-11-01T11:00:00Z', 13],
];
for (const [name, a, b, zone, ua, ub, hours] of NIGHTS) test(`interval: ${name}`, () => {
  const s = resolve(a, zone); const e = resolve(b, zone);
  assert.equal(iso(s), ua); assert.equal(iso(e), ub); assert.equal((e - s) / 3_600_000, hours);
});

test('collapsed Berlin interval 02:30 -> 03:30 on gap day has zero duration (must be rejected)', () => {
  assert.equal(resolve('2026-03-29T02:30', B), resolve('2026-03-29T03:30', B));
});
test('negative Berlin interval 02:30 -> 03:15 on gap day ends before start (must be rejected)', () => {
  assert.equal((resolve('2026-03-29T03:15', B) - resolve('2026-03-29T02:30', B)) / 60_000, -15);
});
test('ordinary 12h night', () => {
  assert.equal((resolve('2026-06-10T06:00', B) - resolve('2026-06-09T18:00', B)) / 3_600_000, 12);
});
