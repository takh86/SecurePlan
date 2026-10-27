import { describe, expect, it } from 'vitest';
import { earliestPossibleCompanyMonth, isCertainlyPastMonth } from './company-month';

// All instants are absolute (UTC, "Z"), so results do not depend on the time zone of the test runner.
const at = (iso: string) => new Date(iso);

describe('SP-08b F-2 — earliest possible company month (UTC-12 .. UTC+14)', () => {
  it('is the UTC month of "now - 12 h"', () => {
    expect(earliestPossibleCompanyMonth(at('2026-12-15T12:00:00Z'))).toBe('2026-12');
    // 1 Nov 11:59 UTC is still 31 Oct 23:59 at UTC-12.
    expect(earliestPossibleCompanyMonth(at('2026-11-01T11:59:59Z'))).toBe('2026-10');
    // From 1 Nov 12:00 UTC on, every zone (also UTC-12) is in November.
    expect(earliestPossibleCompanyMonth(at('2026-11-01T12:00:00Z'))).toBe('2026-11');
  });

  it('year boundary', () => {
    expect(earliestPossibleCompanyMonth(at('2027-01-01T11:59:59Z'))).toBe('2026-12');
    expect(earliestPossibleCompanyMonth(at('2027-01-01T12:00:00Z'))).toBe('2027-01');
  });

  it('UTC+14 being already in the next month does not make the previous month "past"', () => {
    // 31 Oct 10:00 UTC = 1 Nov 00:00 at UTC+14, but 30 Oct 22:00 at UTC-12.
    const now = at('2026-10-31T10:00:00Z');
    expect(isCertainlyPastMonth('2026-10', now)).toBe(false);
    expect(isCertainlyPastMonth('2026-09', now)).toBe(true);
  });
});

describe('SP-08b F-2 — certainly past months', () => {
  it('browser Berlin (already November), company New York (still October): October is NOT locked', () => {
    // 2026-11-01T03:30Z = Berlin 04:30 on 1 Nov, New York 23:30 on 31 Oct.
    expect(isCertainlyPastMonth('2026-10', at('2026-11-01T03:30:00Z'))).toBe(false);
  });

  it('browser Berlin (still October), company Tokyo (already November): October is offered; the server decides', () => {
    // 2026-10-31T16:00Z = Berlin 17:00 on 31 Oct, Tokyo 01:00 on 1 Nov.
    expect(isCertainlyPastMonth('2026-10', at('2026-10-31T16:00:00Z'))).toBe(false);
  });

  it('real historical months stay locked; the current and future months never are', () => {
    const now = at('2026-12-15T12:00:00Z');
    expect(isCertainlyPastMonth('2026-11', now)).toBe(true);
    expect(isCertainlyPastMonth('2025-12', now)).toBe(true);
    expect(isCertainlyPastMonth('2026-12', now)).toBe(false);
    expect(isCertainlyPastMonth('2027-01', now)).toBe(false);
  });

  it('does not depend on the local time zone methods of Date', () => {
    const now = at('2026-11-01T03:30:00Z');
    // A Date whose LOCAL fields would claim November everywhere must not change the UTC-based result.
    const local = Object.assign(new Date(now.getTime()), { getMonth: () => 10, getFullYear: () => 2026 });
    expect(isCertainlyPastMonth('2026-10', local)).toBe(false);
  });
});
