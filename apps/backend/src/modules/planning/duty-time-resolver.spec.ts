/**
 * D6 resolver against the approved fixtures (PO D6, ADR-0003 addendum, SP11A-R1
 * proofs/dst-results.json and the proof-branch reference table). Literal UTC
 * expectations only: no Date parsing or default normalization decides a case.
 */
import {
  D6_GOLDENS,
  DutyTimeZoneError,
  assertDutyTimeResolverReady,
  resolveDutyEndpoint,
  resolveDutyInterval,
} from './duty-time-resolver.js';

const B = 'Europe/Berlin';
const NY = 'America/New_York';
const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');

describe('D6 endpoint resolution (DST-01)', () => {
  it.each(D6_GOLDENS.map((g) => [g.zone, g.localDate, g.localTime, g.utc]))(
    'approved golden %s %s %s -> %s',
    (zone, localDate, localTime, utc) => {
      expect(iso(resolveDutyEndpoint({ zone, localDate, localTime }).epochSeconds)).toBe(utc);
    },
  );

  it.each([
    ['berlin-gap', B, '2026-03-29', '02:30', '2026-03-29T01:30:00Z', 'GAP'],
    ['berlin-fold', B, '2026-10-25', '02:30', '2026-10-25T00:30:00Z', 'FOLD'],
    ['berlin-fold-end', B, '2026-10-25', '02:45', '2026-10-25T00:45:00Z', 'FOLD'],
    ['ny-gap', NY, '2026-03-08', '02:30', '2026-03-08T07:30:00Z', 'GAP'],
    ['ny-fold', NY, '2026-11-01', '01:30', '2026-11-01T05:30:00Z', 'FOLD'],
    ['ny-fold-end', NY, '2026-11-01', '01:45', '2026-11-01T05:45:00Z', 'FOLD'],
    ['ny-unambiguous-0230', NY, '2026-11-01', '02:30', '2026-11-01T07:30:00Z', 'NORMAL'],
    ['half-hour-gap Lord Howe', 'Australia/Lord_Howe', '2026-10-04', '02:15', '2026-10-03T15:45:00Z', 'GAP'],
    ['ordinary Berlin', B, '2026-06-10', '06:00', '2026-06-10T04:00:00Z', 'NORMAL'],
  ] as const)('%s', (_id, zone, localDate, localTime, utc, classification) => {
    expect(resolveDutyEndpoint({ zone, localDate, localTime })).toEqual({
      epochSeconds: Date.parse(utc) / 1000,
      classification,
    });
  });
});

describe('D6 duty intervals (DST-02)', () => {
  it.each([
    ['berlin-ordinary NIGHT', B, '2026-03-27', '18:00', '06:00', '2026-03-27T17:00:00Z', '2026-03-28T05:00:00Z', 12],
    ['berlin-spring NIGHT', B, '2026-03-28', '18:00', '06:00', '2026-03-28T17:00:00Z', '2026-03-29T04:00:00Z', 11],
    ['berlin-autumn NIGHT', B, '2026-10-24', '18:00', '06:00', '2026-10-24T16:00:00Z', '2026-10-25T05:00:00Z', 13],
    ['ny-spring NIGHT', NY, '2026-03-07', '18:00', '06:00', '2026-03-07T23:00:00Z', '2026-03-08T10:00:00Z', 11],
    ['ny-autumn NIGHT', NY, '2026-10-31', '18:00', '06:00', '2026-10-31T22:00:00Z', '2026-11-01T11:00:00Z', 13],
    ['ny-ordinary NIGHT', NY, '2026-11-02', '18:00', '06:00', '2026-11-02T23:00:00Z', '2026-11-03T11:00:00Z', 12],
    ['berlin-year-wrap NIGHT', B, '2026-12-31', '18:00', '06:00', '2026-12-31T17:00:00Z', '2027-01-01T05:00:00Z', 12],
    ['berlin DAY across nothing', B, '2026-07-01', '06:00', '18:00', '2026-07-01T04:00:00Z', '2026-07-01T16:00:00Z', 12],
    ['leap day DAY', B, '2028-02-29', '06:00', '18:00', '2028-02-29T05:00:00Z', '2028-02-29T17:00:00Z', 12],
    ['NIGHT ending on the leap day', B, '2028-02-28', '22:00', '06:00', '2028-02-28T21:00:00Z', '2028-02-29T05:00:00Z', 8],
  ] as const)('%s', (_id, zone, dutyDate, startLocal, endLocal, startsAt, endsAt, hours) => {
    const resolved = resolveDutyInterval({ zone, dutyDate, startLocal, endLocal });
    expect(resolved).toEqual({ startsAt, endsAt });
    expect((Date.parse(endsAt) - Date.parse(startsAt)) / 3_600_000).toBe(hours);
  });

  it('an end exactly at the next midnight never wraps a DAY shift: end_local < start_local alone decides', () => {
    // A NIGHT shift 18:00 -> 23:00 stays on the duty date (end later than start).
    expect(resolveDutyInterval({ zone: B, dutyDate: '2026-06-10', startLocal: '18:00', endLocal: '23:00' }))
      .toEqual({ startsAt: '2026-06-10T16:00:00Z', endsAt: '2026-06-10T21:00:00Z' });
  });
});

describe('D6 rejected intervals and invalid input (DST-03)', () => {
  it.each([
    ['collapsed Berlin gap 02:30 -> 03:30 (0 min)', B, '2026-03-29', '02:30', '03:30'],
    ['negative Berlin gap 02:30 -> 03:15 (-15 min)', B, '2026-03-29', '02:30', '03:15'],
    ['collapsed New York gap 02:30 -> 03:30', NY, '2026-03-08', '02:30', '03:30'],
    ['negative New York gap 02:30 -> 03:15', NY, '2026-03-08', '02:30', '03:15'],
    ['collapsed Lord Howe half-hour gap 02:15 -> 02:45', 'Australia/Lord_Howe', '2026-10-04', '02:15', '02:45'],
  ] as const)('%s -> null (DUTY_TIME_RANGE_INVALID)', (_name, zone, dutyDate, startLocal, endLocal) => {
    expect(resolveDutyInterval({ zone, dutyDate, startLocal, endLocal })).toBeNull();
  });

  it('the same configuration on an ordinary date resolves normally', () => {
    expect(resolveDutyInterval({ zone: B, dutyDate: '2026-03-30', startLocal: '02:30', endLocal: '03:15' }))
      .toEqual({ startsAt: '2026-03-30T00:30:00Z', endsAt: '2026-03-30T01:15:00Z' });
  });

  it('unrepresentable endpoints are rejected, the extreme representable ones are accepted', () => {
    // NIGHT on 9999-12-31 would end in year 10000.
    expect(resolveDutyInterval({ zone: B, dutyDate: '9999-12-31', startLocal: '18:00', endLocal: '06:00' })).toBeNull();
    // Berlin local mean time (+00:53:28) on 0001-01-01 starts before 0001-01-01T00:00:00Z.
    expect(resolveDutyInterval({ zone: B, dutyDate: '0001-01-01', startLocal: '00:30', endLocal: '06:00' })).toBeNull();
    // Historical offsets keep their seconds; nothing is rounded to minutes.
    expect(resolveDutyInterval({ zone: B, dutyDate: '0001-01-01', startLocal: '06:00', endLocal: '18:00' }))
      .toEqual({ startsAt: '0001-01-01T05:06:32Z', endsAt: '0001-01-01T17:06:32Z' });
    expect(resolveDutyInterval({ zone: 'UTC', dutyDate: '9999-12-31', startLocal: '06:00', endLocal: '23:59' }))
      .toEqual({ startsAt: '9999-12-31T06:00:00Z', endsAt: '9999-12-31T23:59:00Z' });
  });

  it.each([
    ['30 February', '2026-02-30', '06:00'],
    ['hour 24', '2026-01-01', '24:00'],
  ])('impossible civil values are rejected, never normalized (%s)', (_name, localDate, localTime) => {
    expect(() => resolveDutyEndpoint({ zone: B, localDate, localTime })).toThrow(RangeError);
  });

  it.each(['Mars/Base', '+01:00', '', 'Europe/Not_A_City'])('invalid company zone %j -> DutyTimeZoneError', (zone) => {
    expect(() => resolveDutyEndpoint({ zone, localDate: '2026-01-01', localTime: '06:00' })).toThrow(DutyTimeZoneError);
  });

  it('the boot self-test passes on this runtime', () => {
    expect(() => assertDutyTimeResolverReady({ log: () => undefined } as never)).not.toThrow();
  });
});
