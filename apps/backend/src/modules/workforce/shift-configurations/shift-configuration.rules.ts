/**
 * Pure SP-08b rules (ADR-0003). Times are canonical HH:mm strings, which
 * compare chronologically as plain strings.
 */
import { ShiftKind } from './shift-configuration.types.js';

export type ShiftRule = { shiftKind: ShiftKind; startLocal: string; endLocal: string };

/**
 * O-2: start and end must differ; a DAY shift ends later on the same calendar
 * day; a NIGHT shift may (but need not) wrap past midnight. The nominal
 * wall-clock duration is then always > 0 and < 24 h; real durations on DST
 * days are resolved in SP-11 (open decision N-1).
 */
export function hasValidTimeRelation(rule: ShiftRule): boolean {
  if (rule.startLocal === rule.endLocal) return false;
  return rule.shiftKind === ShiftKind.NIGHT || rule.endLocal > rule.startLocal;
}

/** Same shift kinds with the same times, independent of order. */
export function isSameShiftSet(current: readonly ShiftRule[], desired: readonly ShiftRule[]): boolean {
  if (current.length !== desired.length) return false;
  return desired.every((wanted) =>
    current.some(
      (rule) =>
        rule.shiftKind === wanted.shiftKind && rule.startLocal === wanted.startLocal && rule.endLocal === wanted.endLocal,
    ),
  );
}
