import { describe, expect, it } from 'vitest';
import {
  SUGGESTED_SHIFT_TIMES,
  endsNextDay,
  initialShiftForm,
  isSameShiftForm,
  toShiftInputs,
  validateShiftForm,
  type ShiftFormValues,
} from './shift-configuration-form';

const PROJECT = '7a2be0c4-1d3e-4f5a-8b6c-9d0e1f2a3b4c';
const values = (day: Partial<ShiftFormValues['DAY']>, night: Partial<ShiftFormValues['NIGHT']> = {}): ShiftFormValues => ({
  DAY: { enabled: true, startLocal: '06:00', endLocal: '18:00', ...day },
  NIGHT: { enabled: true, startLocal: '18:00', endLocal: '06:00', ...night },
});

describe('SP-08b — initial form values', () => {
  it('nothing configured: the suggestion is pre-filled and marked as such', () => {
    expect(initialShiftForm({ projectId: PROJECT, effectiveFromMonth: null, shifts: [] }, '2026-12')).toEqual({
      basis: 'suggestion',
      values: {
        DAY: { enabled: true, ...SUGGESTED_SHIFT_TIMES.DAY },
        NIGHT: { enabled: true, ...SUGGESTED_SHIFT_TIMES.NIGHT },
      },
    });
  });

  it('an earlier version is inherited; a kind missing from it starts unselected', () => {
    const configuration = {
      projectId: PROJECT,
      effectiveFromMonth: '2026-10',
      shifts: [{ id: 's-1', shiftKind: 'DAY' as const, startLocal: '07:00', endLocal: '19:00' }],
    };
    expect(initialShiftForm(configuration, '2026-12')).toEqual({
      basis: 'inherited',
      values: { DAY: { enabled: true, startLocal: '07:00', endLocal: '19:00' }, NIGHT: { enabled: false, startLocal: '', endLocal: '' } },
    });
    expect(initialShiftForm(configuration, '2026-10').basis).toBe('own');
  });
});

describe('SP-08b — client validation mirrors the API', () => {
  it('accepts a day shift on one day and a night shift with or without wrapping', () => {
    expect(validateShiftForm(values({}))).toEqual({});
    expect(validateShiftForm(values({ startLocal: '00:00', endLocal: '23:59' }, { startLocal: '00:00', endLocal: '06:00' }))).toEqual({});
  });

  it('at least one kind; the configuration cannot be removed completely', () => {
    expect(validateShiftForm(values({ enabled: false }, { enabled: false })).kinds).toContain('mindestens eine Schichtart');
    // A selected kind needs both times ...
    expect(validateShiftForm(values({ enabled: false }, { startLocal: '', endLocal: '' }))).toMatchObject({
      'NIGHT.startLocal': expect.any(String),
      'NIGHT.endLocal': expect.any(String),
    });
    // ... an unselected one is not validated (and not sent).
    expect(validateShiftForm(values({}, { enabled: false, startLocal: 'x', endLocal: '' }))).toEqual({});
  });

  it('HH:mm only: no seconds, no 24:00, no single-digit hours', () => {
    for (const time of ['6:00', '24:00', '06:60', '06:00:00', '0600', '']) {
      expect(validateShiftForm(values({ startLocal: time }))['DAY.startLocal'], time).toContain('HH:MM');
    }
    // Surrounding spaces are tolerated and trimmed for the request.
    expect(validateShiftForm(values({ startLocal: ' 06:00 ' }))).toEqual({});
  });

  it('start and end must differ; a day shift may not wrap past midnight (also not to 00:00)', () => {
    expect(validateShiftForm(values({ endLocal: '06:00' }))['DAY.endLocal']).toBe('Beginn und Ende müssen sich unterscheiden.');
    expect(validateShiftForm(values({}, { endLocal: '18:00' }))['NIGHT.endLocal']).toBe('Beginn und Ende müssen sich unterscheiden.');
    expect(validateShiftForm(values({ startLocal: '18:00', endLocal: '06:00' }))['DAY.endLocal']).toContain('am selben Tag');
    expect(validateShiftForm(values({ startLocal: '18:00', endLocal: '00:00' }))['DAY.endLocal']).toContain('am selben Tag');
  });
});

describe('SP-08b — payload and helpers', () => {
  it('sends every selected kind, DAY before NIGHT, with trimmed times', () => {
    expect(toShiftInputs(values({ startLocal: ' 07:00' }, { enabled: false }))).toEqual([
      { shiftKind: 'DAY', startLocal: '07:00', endLocal: '18:00' },
    ]);
    expect(toShiftInputs(values({})).map((rule) => rule.shiftKind)).toEqual(['DAY', 'NIGHT']);
  });

  it('detects changes and next-day ends', () => {
    expect(isSameShiftForm(values({}), values({}))).toBe(true);
    expect(isSameShiftForm(values({}), values({ endLocal: '17:00' }))).toBe(false);
    expect(isSameShiftForm(values({}), values({}, { enabled: false }))).toBe(false);
    expect(endsNextDay({ startLocal: '18:00', endLocal: '06:00' })).toBe(true);
    expect(endsNextDay({ startLocal: '00:00', endLocal: '06:00' })).toBe(false);
  });
});
