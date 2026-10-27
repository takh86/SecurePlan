/**
 * Explicit API <-> database mapping for the project shift configuration.
 * API: DAY/NIGHT, camelCase, HH:mm. DB: TAG/NACHT, snake_case, time(0).
 * An unknown stored shift kind is a server defect and fails closed (500).
 */
import type { ProjectShiftConfigurationResponse, ShiftKind, ShiftRuleResponse } from './shift-configuration.types.js';

export type ShiftRuleRow = {
  id: string;
  shift_kind: string;
  start_local: string;
  end_local: string;
  effective_from_month: string;
};

/**
 * Times and dates are rendered by PostgreSQL (time::text is HH:MM:SS), never via
 * JS Date. `alias` qualifies the columns in joins (a fixed identifier, never input).
 */
export function shiftRuleColumns(alias?: string): string {
  const c = alias ? `${alias}.` : '';
  return `${c}id, ${c}shift_kind,
    left(${c}start_local::text, 5) AS start_local,
    left(${c}end_local::text, 5) AS end_local,
    to_char(${c}effective_from_month, 'YYYY-MM-DD') AS effective_from_month`;
}

/** Deterministic order: DAY before NIGHT. */
export function shiftRuleOrder(alias?: string): string {
  return `CASE ${alias ? `${alias}.` : ''}shift_kind WHEN 'TAG' THEN 0 ELSE 1 END`;
}

const KIND_TO_DB: Record<ShiftKind, string> = { DAY: 'TAG', NIGHT: 'NACHT' };
const KIND_FROM_DB = new Map(Object.entries(KIND_TO_DB).map(([api, db]) => [db, api as ShiftKind]));

export function shiftKindToDb(value: ShiftKind): string {
  return KIND_TO_DB[value];
}

export function shiftKindFromDb(value: string): ShiftKind {
  const mapped = KIND_FROM_DB.get(value);
  if (mapped === undefined) throw new Error('Unexpected shift kind in database');
  return mapped;
}

export function toShiftRuleResponse(row: ShiftRuleRow): ShiftRuleResponse {
  return {
    id: row.id,
    shiftKind: shiftKindFromDb(row.shift_kind),
    startLocal: row.start_local,
    endLocal: row.end_local,
  };
}

/**
 * Builds the response from the rows of ONE version. No rows means no version
 * (A-SP08b-01): effectiveFromMonth null and an empty shift list.
 */
export function toShiftConfigurationResponse(
  projectId: string,
  rows: readonly ShiftRuleRow[],
): ProjectShiftConfigurationResponse {
  if (rows.length === 0) return { projectId, effectiveFromMonth: null, shifts: [] };
  const month = rows[0].effective_from_month;
  if (rows.some((row) => row.effective_from_month !== month)) {
    throw new Error('Shift rules of different versions mixed');
  }
  return { projectId, effectiveFromMonth: month, shifts: rows.map(toShiftRuleResponse) };
}
