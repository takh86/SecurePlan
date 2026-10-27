/**
 * SP-08b shift-configuration form model (ADR-0003). The client checks mirror
 * the API rules so most mistakes are explained before a request; the server
 * stays authoritative (month rules, project status, planning guard).
 */
import { LOCAL_TIME_PATTERN, SHIFT_KINDS, type ShiftConfiguration, type ShiftKind, type ShiftRuleInput } from './shift-configuration-api';

export const SHIFT_KIND_LABELS: Record<ShiftKind, string> = {
  DAY: 'Tagschicht',
  NIGHT: 'Nachtschicht',
};

/**
 * UI SUGGESTION ONLY (BR-SHIFT-02 describes these times for the current
 * customer project, not as a system rule). Shown as clearly labelled
 * pre-filled values when nothing is configured; never saved automatically
 * and never sent unless the admin saves.
 */
export const SUGGESTED_SHIFT_TIMES: Record<ShiftKind, { startLocal: string; endLocal: string }> = {
  DAY: { startLocal: '06:00', endLocal: '18:00' },
  NIGHT: { startLocal: '18:00', endLocal: '06:00' },
};

export type ShiftFormRow = { enabled: boolean; startLocal: string; endLocal: string };
export type ShiftFormValues = Record<ShiftKind, ShiftFormRow>;

export type ShiftFieldKey = `${ShiftKind}.startLocal` | `${ShiftKind}.endLocal` | 'kinds';
export type ShiftFormErrors = Partial<Record<ShiftFieldKey, string>>;

/** Where the pre-filled values come from. */
export type ShiftFormBasis = 'suggestion' | 'inherited' | 'own';

/**
 * Initial values for editing the version of `month`:
 * - nothing configured: the labelled suggestion for both kinds;
 * - an effective version (own or inherited from an earlier month): its kinds
 *   and times; a kind missing from it starts unselected and empty.
 */
export function initialShiftForm(configuration: ShiftConfiguration, month: string): { values: ShiftFormValues; basis: ShiftFormBasis } {
  if (configuration.effectiveFromMonth === null) {
    return {
      basis: 'suggestion',
      values: {
        DAY: { enabled: true, ...SUGGESTED_SHIFT_TIMES.DAY },
        NIGHT: { enabled: true, ...SUGGESTED_SHIFT_TIMES.NIGHT },
      },
    };
  }
  const row = (kind: ShiftKind): ShiftFormRow => {
    const rule = configuration.shifts.find((item) => item.shiftKind === kind);
    return rule
      ? { enabled: true, startLocal: rule.startLocal, endLocal: rule.endLocal }
      : { enabled: false, startLocal: '', endLocal: '' };
  };
  return {
    basis: configuration.effectiveFromMonth === month ? 'own' : 'inherited',
    values: { DAY: row('DAY'), NIGHT: row('NIGHT') },
  };
}

const FORMAT_ERROR = 'Bitte geben Sie die Uhrzeit im Format HH:MM (24 Stunden) ein, z. B. 06:00.';

/** Same rules as the API (O-2/O-5): 1..2 kinds, HH:mm, start ≠ end, a day shift ends on the same day. */
export function validateShiftForm(values: ShiftFormValues): ShiftFormErrors {
  const errors: ShiftFormErrors = {};
  if (!SHIFT_KINDS.some((kind) => values[kind].enabled)) {
    errors.kinds = 'Bitte wählen Sie mindestens eine Schichtart aus. Schichtzeiten lassen sich nicht vollständig entfernen.';
  }
  for (const kind of SHIFT_KINDS) {
    const row = values[kind];
    if (!row.enabled) continue;
    const start = row.startLocal.trim();
    const end = row.endLocal.trim();
    if (!LOCAL_TIME_PATTERN.test(start)) errors[`${kind}.startLocal`] = FORMAT_ERROR;
    if (!LOCAL_TIME_PATTERN.test(end)) {
      errors[`${kind}.endLocal`] = FORMAT_ERROR;
    } else if (LOCAL_TIME_PATTERN.test(start)) {
      if (start === end) {
        errors[`${kind}.endLocal`] = 'Beginn und Ende müssen sich unterscheiden.';
      } else if (kind === 'DAY' && end < start) {
        errors[`${kind}.endLocal`] = 'Die Tagschicht endet am selben Tag: Das Ende muss nach dem Beginn liegen (spätestens 23:59).';
      }
    }
  }
  return errors;
}

/** Full-replacement payload: every selected kind, DAY before NIGHT, trimmed times. */
export function toShiftInputs(values: ShiftFormValues): ShiftRuleInput[] {
  return SHIFT_KINDS.filter((kind) => values[kind].enabled).map((kind) => ({
    shiftKind: kind,
    startLocal: values[kind].startLocal.trim(),
    endLocal: values[kind].endLocal.trim(),
  }));
}

export function isSameShiftForm(a: ShiftFormValues, b: ShiftFormValues): boolean {
  return SHIFT_KINDS.every(
    (kind) =>
      a[kind].enabled === b[kind].enabled &&
      a[kind].startLocal === b[kind].startLocal &&
      a[kind].endLocal === b[kind].endLocal,
  );
}

/** A night shift whose end is before its start ends on the following day. */
export function endsNextDay(rule: { startLocal: string; endLocal: string }): boolean {
  return rule.endLocal < rule.startLocal;
}
