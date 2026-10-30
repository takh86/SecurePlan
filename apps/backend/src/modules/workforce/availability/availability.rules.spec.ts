import { describe, expect, it } from 'vitest';
import { assertConfirmation, assertEmployment, normalizeSelection, previewDays, selectedDays, selectionDigest, validCivilDate } from './availability.rules.js';
import { AvailabilityOperation as Op, AvailabilityStatus as Status, ConflictPolicy as Policy } from './availability.types.js';
import { parseIdempotencyKey } from './availability.controller.js';

const selection = { operation: Op.SET, status: Status.SICK, fromDate: '2026-10-01', toDate: '2027-01-01' };
describe('SP-10 calendar and explicit intent contracts', () => {
  it('counts 93 inclusive civil days across a year, independent of DST', () => {
    expect(selectedDays(selection)).toHaveLength(93);
    expect(() => selectedDays({ ...selection, toDate: '2027-01-02' })).toThrow();
    expect(() => selectedDays({ ...selection, toDate: '2026-09-30' })).toThrow();
    expect(selectedDays({ ...selection, fromDate: '2028-02-28', toDate: '2028-03-01' })).toEqual(['2028-02-28', '2028-02-29', '2028-03-01']);
  });
  it.each(['0001-01-01', '0099-12-31', '2000-02-29', '9999-12-31'])('supports canonical date %s', (day) => expect(validCivilDate(day)).toBe(true));
  it.each(['0000-01-01', '10000-01-01', '2027-02-29', '2100-02-29', '2026-04-31', '2026-1-01', '2026-10-01T00:00:00Z'])('rejects date %s', (day) => expect(validCivilDate(day)).toBe(false));
  it('defaults policy semantically and fingerprints normalized property order', () => {
    const a = normalizeSelection(selection);
    const b = normalizeSelection({ ...selection, conflictPolicy: Policy.REJECT });
    expect(a.conflictPolicy).toBe(Policy.REJECT);
    expect(selectionDigest('a', a)).toEqual(selectionDigest('a', b));
  });
  it('rejects implicit destructive confirmation and forbidden clear fields', () => {
    expect(() => assertConfirmation({ ...selection, conflictPolicy: Policy.REPLACE }, undefined)).toThrow();
    expect(() => assertConfirmation({ ...selection, operation: Op.CLEAR }, 'REPLACE')).toThrow();
    expect(() => normalizeSelection({ ...selection, operation: Op.CLEAR })).toThrow();
    expect(() => assertConfirmation(selection, 'CLEAR')).toThrow();
  });
  it('distinguishes create, no-op, default reject, replace and missing clear', () => {
    const days = ['2026-10-01', '2026-10-02', '2026-10-03'];
    const current = new Map([[days[1], Status.SICK], [days[2], Status.LEAVE]]);
    expect(previewDays(normalizeSelection(selection), days, current).map((d) => d.effect)).toEqual(['CREATE', 'UNCHANGED', 'CONFLICT']);
    expect(previewDays({ ...selection, conflictPolicy: Policy.REPLACE }, days, current).map((d) => d.effect)).toEqual(['CREATE', 'UNCHANGED', 'REPLACE']);
    expect(previewDays({ ...selection, operation: Op.CLEAR }, days, current).map((d) => d.effect)).toEqual(['UNCHANGED', 'CLEAR', 'CLEAR']);
  });
  it('requires documented start, inclusive optional end, and strictly-past inactive SET', () => {
    const day = { ...selection, fromDate: '2026-10-29', toDate: '2026-10-29' };
    const person = { status: 'DEACTIVATED', employment_start: '2026-10-29', employment_end: '2026-10-29' };
    expect(() => assertEmployment(day, person, '2026-10-30')).not.toThrow();
    expect(() => assertEmployment(day, person, '2026-10-29')).toThrow();
    expect(() => assertEmployment(day, { ...person, status: 'ACTIVE', employment_start: null }, '2026-10-30')).toThrow();
    expect(() => assertEmployment({ ...day, operation: Op.CLEAR }, { ...person, employment_start: null }, '2026-10-29')).not.toThrow();
  });
});
describe('SP-10 raw Idempotency-Key boundary', () => {
  it.each(['abcdefgh', 'a'.repeat(128), 'key,with,commas'])('accepts exactly one visible-ASCII key %s', (key) => {
    expect(parseIdempotencyKey({ headers: { 'idempotency-key': key }, rawHeaders: ['Idempotency-Key', key] })).toBe(key);
  });
  it.each(['', 'short', 'a'.repeat(129), 'has space', 'ümlaut-key'])('rejects invalid key %s', (key) => {
    expect(() => parseIdempotencyKey({ headers: { 'idempotency-key': key }, rawHeaders: ['Idempotency-Key', key] })).toThrow();
  });
  it('rejects repeated identical raw headers and missing key', () => {
    expect(() => parseIdempotencyKey({ headers: {}, rawHeaders: [] })).toThrow();
    expect(() => parseIdempotencyKey({ headers: { 'idempotency-key': 'abcdefgh, abcdefgh' },
      rawHeaders: ['Idempotency-Key', 'abcdefgh', 'idempotency-key', 'abcdefgh'] })).toThrow();
  });
});
