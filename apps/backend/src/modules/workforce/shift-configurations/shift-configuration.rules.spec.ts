import { hasValidTimeRelation, isSameShiftSet, type ShiftRule } from './shift-configuration.rules.js';

const rule = (shiftKind: ShiftRule['shiftKind'], startLocal: string, endLocal: string): ShiftRule => ({
  shiftKind,
  startLocal,
  endLocal,
});

describe('SP-08b — time relation (O-2)', () => {
  it('a DAY shift must end later on the same calendar day', () => {
    expect(hasValidTimeRelation(rule('DAY', '06:00', '18:00'))).toBe(true);
    expect(hasValidTimeRelation(rule('DAY', '00:00', '23:59'))).toBe(true);
    expect(hasValidTimeRelation(rule('DAY', '23:58', '23:59'))).toBe(true);
    // Wrapping past midnight, including an end of exactly 00:00, is not a day shift.
    expect(hasValidTimeRelation(rule('DAY', '18:00', '06:00'))).toBe(false);
    expect(hasValidTimeRelation(rule('DAY', '18:00', '00:00'))).toBe(false);
  });

  it('a NIGHT shift may wrap past midnight, but does not have to', () => {
    expect(hasValidTimeRelation(rule('NIGHT', '18:00', '06:00'))).toBe(true);
    expect(hasValidTimeRelation(rule('NIGHT', '23:59', '00:00'))).toBe(true);
    expect(hasValidTimeRelation(rule('NIGHT', '00:00', '06:00'))).toBe(true);
  });

  it('start and end must differ for both kinds (no zero and no 24 h shift)', () => {
    expect(hasValidTimeRelation(rule('DAY', '06:00', '06:00'))).toBe(false);
    expect(hasValidTimeRelation(rule('NIGHT', '18:00', '18:00'))).toBe(false);
    expect(hasValidTimeRelation(rule('NIGHT', '00:00', '00:00'))).toBe(false);
  });
});

describe('SP-08b — no-op detection', () => {
  const day = rule('DAY', '06:00', '18:00');
  const night = rule('NIGHT', '18:00', '06:00');

  it('equal kinds and times in any order are the same set', () => {
    expect(isSameShiftSet([day, night], [night, day])).toBe(true);
    expect(isSameShiftSet([{ ...day, id: 'row-id' } as ShiftRule], [day])).toBe(true);
  });

  it('a missing, additional or retimed kind is a change; nothing stored is never a no-op', () => {
    expect(isSameShiftSet([day, night], [day])).toBe(false);
    expect(isSameShiftSet([day], [day, night])).toBe(false);
    expect(isSameShiftSet([day, night], [day, rule('NIGHT', '18:00', '06:30')])).toBe(false);
    expect(isSameShiftSet([day], [rule('NIGHT', '06:00', '18:00')])).toBe(false);
    expect(isSameShiftSet([], [day])).toBe(false);
  });
});
