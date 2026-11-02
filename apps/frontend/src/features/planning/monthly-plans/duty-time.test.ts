import { describe, expect, it } from 'vitest';
import { dutyTimeView, formatInstant, instantParts } from './duty-time';

// Synthetic example instants (as the server renders them), not business rules.
describe('SP-11 PR-2 — duty time display (server instants, explicit zone)', () => {
  it('shows a day duty in the given zone with its short zone name', () => {
    const view = dutyTimeView({ dutyDate: '2026-12-03', startsAt: '2026-12-03T05:00:00Z', endsAt: '2026-12-03T17:00:00Z' }, 'Europe/Berlin');
    expect(view.text).toBe('06:00 – 18:00 MEZ');
    expect(view.start).toEqual({ date: '2026-12-03', time: '06:00', zone: 'MEZ' });
  });

  it('names the end date of a night duty across the year boundary', () => {
    const view = dutyTimeView({ dutyDate: '2026-12-31', startsAt: '2026-12-31T17:00:00Z', endsAt: '2027-01-01T05:00:00Z' }, 'Europe/Berlin');
    expect(view.text).toBe('18:00 – 06:00 (Fr., 01.01.2027) MEZ');
  });

  it('names both zones when the duty spans the end of daylight saving time (13 real hours)', () => {
    const view = dutyTimeView({ dutyDate: '2026-10-24', startsAt: '2026-10-24T16:00:00Z', endsAt: '2026-10-25T05:00:00Z' }, 'Europe/Berlin');
    expect(view.text).toBe('18:00 MESZ – 06:00 (So., 25.10.2026) MEZ');
  });

  it('shows the same instant differently on a device in another zone, never as company time', () => {
    const view = dutyTimeView({ dutyDate: '2026-12-03', startsAt: '2026-12-03T04:00:00Z', endsAt: '2026-12-03T16:00:00Z' }, 'America/New_York');
    // 04:00Z is still the previous evening on the US east coast: both dates are named.
    expect(view.text).toMatch(/^Mi\., 02\.12\.2026, 23:00 – 11:00 \(Do\., 03\.12\.2026\) \S+$/);
    expect(view.text).not.toContain('MEZ');
    const utc = dutyTimeView({ dutyDate: '2026-12-03', startsAt: '2026-12-02T23:30:00Z', endsAt: '2026-12-03T11:30:00Z' }, 'UTC');
    expect(utc.text).toBe('Mi., 02.12.2026, 23:30 – 11:30 (Do., 03.12.2026) UTC');
  });

  it('formats a single instant (e.g. a publication) with date and zone', () => {
    expect(formatInstant('2026-11-30T12:00:00Z', 'Europe/Berlin')).toBe('Mo., 30.11.2026, 13:00 MEZ');
    expect(instantParts('2027-03-28T01:30:00Z', 'Europe/Berlin')).toEqual({ date: '2027-03-28', time: '03:30', zone: 'MESZ' });
  });
});
