// Loaded by Nest at runtime; class-transformer's @Type() needs it in isolation.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { ShiftConfigurationQueryDto, UpdateShiftConfigurationDto } from './shift-configuration.dto.js';

async function errorsOf<T extends object>(type: new () => T, plain: Record<string, unknown>) {
  return validate(plainToInstance(type, plain), { whitelist: true, forbidNonWhitelisted: true });
}

/** "property" or "property.index.child" for every failing (nested) property. */
function paths(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap((error) => {
    const path = `${prefix}${error.property}`;
    const own = error.constraints ? [path] : [];
    return [...own, ...paths(error.children ?? [], `${path}.`)];
  }).sort();
}

const day = { shiftKind: 'DAY', startLocal: '06:00', endLocal: '18:00' };
const night = { shiftKind: 'NIGHT', startLocal: '18:00', endLocal: '06:00' };
const valid = { effectiveFromMonth: '2027-01-01', shifts: [day, night] };

describe('SP-08b — UpdateShiftConfigurationDto', () => {
  it('accepts one or two rules with canonical HH:mm times', async () => {
    expect(await errorsOf(UpdateShiftConfigurationDto, valid)).toEqual([]);
    expect(await errorsOf(UpdateShiftConfigurationDto, { ...valid, shifts: [night] })).toEqual([]);
    for (const time of ['00:00', '09:05', '23:59']) {
      expect(await errorsOf(UpdateShiftConfigurationDto, { ...valid, shifts: [{ ...night, startLocal: time }] }), time)
        .toEqual([]);
    }
  });

  it('requires both fields and 1..2 rules; a repeated shift kind is rejected, not deduplicated', async () => {
    expect(paths(await errorsOf(UpdateShiftConfigurationDto, {}))).toEqual(['effectiveFromMonth', 'shifts']);
    for (const shifts of [[], [day, night, day], null, 'DAY', { 0: day }]) {
      expect(paths(await errorsOf(UpdateShiftConfigurationDto, { ...valid, shifts })), JSON.stringify(shifts))
        .toContain('shifts');
    }
    const duplicate = await errorsOf(UpdateShiftConfigurationDto, { ...valid, shifts: [day, { ...day, startLocal: '07:00' }] });
    expect(duplicate.map((error) => Object.keys(error.constraints ?? {}))).toEqual([['arrayUnique']]);
  });

  it('only HH:mm in the 24-hour clock: no seconds, no 24:00, no single-digit hours', async () => {
    for (const time of ['6:00', '06:0', '24:00', '06:60', '06:00:00', '0600', '06.00', ' 06:00', '', 600]) {
      expect(paths(await errorsOf(UpdateShiftConfigurationDto, { ...valid, shifts: [{ ...day, startLocal: time }] })), String(time))
        .toEqual(['shifts.0.startLocal']);
    }
  });

  it('accepts only the API vocabulary DAY/NIGHT (not the database values TAG/NACHT)', async () => {
    for (const shiftKind of ['TAG', 'NACHT', 'day', 'BOTH', null]) {
      expect(paths(await errorsOf(UpdateShiftConfigurationDto, { ...valid, shifts: [{ ...day, shiftKind }] })), String(shiftKind))
        .toEqual(['shifts.0.shiftKind']);
    }
  });

  it('validates the effective month syntax; the first-of-month rule is a service rule', async () => {
    for (const effectiveFromMonth of ['2027-13-01', '2027-02-30', '2027-01', '2027-01-01T00:00:00Z', 20270101]) {
      expect(paths(await errorsOf(UpdateShiftConfigurationDto, { ...valid, effectiveFromMonth })), String(effectiveFromMonth))
        .toEqual(['effectiveFromMonth']);
    }
    expect(await errorsOf(UpdateShiftConfigurationDto, { ...valid, effectiveFromMonth: '2027-01-15' })).toEqual([]);
  });

  it('has no tenant, id or timestamp field, neither on the request nor inside a rule', async () => {
    for (const field of ['companyId', 'projectId', 'id', 'accountId']) {
      const errors = await errorsOf(UpdateShiftConfigurationDto, { ...valid, [field]: 'x' });
      expect(errors.map((error) => Object.keys(error.constraints ?? {}))).toEqual([['whitelistValidation']]);
    }
    const nested = await errorsOf(UpdateShiftConfigurationDto, { ...valid, shifts: [{ ...day, id: 'x' }] });
    expect(nested[0].children?.[0].children?.[0].constraints).toHaveProperty('whitelistValidation');
  });
});

describe('SP-08b — ShiftConfigurationQueryDto', () => {
  it('requires a strict effectiveForMonth date and no other parameter', async () => {
    expect(await errorsOf(ShiftConfigurationQueryDto, { effectiveForMonth: '2027-01-01' })).toEqual([]);
    expect(paths(await errorsOf(ShiftConfigurationQueryDto, {}))).toEqual(['effectiveForMonth']);
    expect(paths(await errorsOf(ShiftConfigurationQueryDto, { effectiveForMonth: ['2027-01-01', '2027-02-01'] })))
      .toEqual(['effectiveForMonth']);
    expect(paths(await errorsOf(ShiftConfigurationQueryDto, { effectiveForMonth: '2027-02-30' }))).toEqual(['effectiveForMonth']);
    expect(paths(await errorsOf(ShiftConfigurationQueryDto, { effectiveForMonth: '2027-01-01', monthStart: '2027-01-01' })))
      .toEqual(['monthStart']);
  });
});
