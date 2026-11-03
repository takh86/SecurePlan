/**
 * UX A10 (Phase 5.6 WF-DEC-01, 5.7 §7.3): view model of the employee-by-day
 * month matrix. Pure functions over the API data; no business rule is decided
 * here. A cell shows the duties a person is a member of on that duty date
 * (the duty's local `dutyDate`, never a browser-derived day), so a night duty
 * appears on the day it starts.
 */
import { SHIFT_TYPE_LABELS } from '../../../shared/shift/shift-view';
import { dateInMonth, daysInMonth, type DateOnly, type MonthKey } from '../../../shared/time/month';
import { fullName, type Employee } from '../../employees/employee-types';
import type { ProjectAssignment } from '../../projects/project-assignments-api';
import type { ShiftKind } from '../../projects/shift-configuration-api';
import { DUTY_ROLE_LABELS, type Duty, type DutyAssignment } from './monthly-plan-types';

/** One membership shown in a cell. */
export type MatrixEntry = { duty: Duty; member: DutyAssignment; unavailable: boolean };

export type MatrixRow = {
  /** Lower-case employee id (stable key). */
  key: string;
  employeeId: string;
  /** Null when the member is not among the company's employees any more (unknown person). */
  employee: Employee | null;
  name: string;
  code: string | null;
  /** Assigned to this project for the plan month (A09). */
  assigned: boolean;
  inactive: boolean;
  /** Memberships by duty date, DAY before NIGHT. */
  cells: ReadonlyMap<DateOnly, readonly MatrixEntry[]>;
  /** At least one membership is reported as unavailable (neutral E-04 hint). */
  hasConflict: boolean;
};

export const UNKNOWN_PERSON = 'Unbekannte Person';

const SHORT_KIND: Record<ShiftKind, string> = { DAY: 'Tag', NIGHT: 'Nacht' };
const KIND_ORDER: Record<ShiftKind, number> = { DAY: 0, NIGHT: 1 };

const collator = new Intl.Collator('de-DE', { sensitivity: 'base' });
const longDate = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'long', timeZone: 'UTC' });
const weekdayShort = new Intl.DateTimeFormat('de-DE', { weekday: 'short', timeZone: 'UTC' });

function utc(date: DateOnly): Date {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/** Every calendar day of the month, in order. */
export function matrixDays(month: MonthKey): DateOnly[] {
  return Array.from({ length: daysInMonth(month) }, (_, index) => dateInMonth(month, index + 1)!);
}

/** `Do., 3. Dezember` – the date part of a cell's accessible name. */
export function spokenDate(date: DateOnly): string {
  return longDate.format(utc(date));
}

/** Column header parts: weekday (`Do`) and day of month (`03`). */
export function dayHeader(date: DateOnly): { weekday: string; day: string; weekend: boolean } {
  const value = utc(date);
  return {
    weekday: weekdayShort.format(value).replace('.', ''),
    day: date.slice(8, 10),
    weekend: value.getUTCDay() === 0 || value.getUTCDay() === 6,
  };
}

/**
 * Rows: every employee assigned to the project for the plan month, plus every
 * member of a duty in this plan (e.g. a person whose assignment changed later).
 * Sorted by last name, first name; unknown persons last.
 */
export function buildMatrixRows(
  employees: readonly Employee[],
  assignments: readonly ProjectAssignment[],
  duties: readonly Duty[],
  projectId: string,
  monthStart: string,
): MatrixRow[] {
  const byId = new Map(employees.map((employee) => [employee.id.toLowerCase(), employee]));
  const assigned = new Set(
    assignments
      .filter((item) => item.monthStart === monthStart && item.projectId.toLowerCase() === projectId.toLowerCase())
      .map((item) => item.employeeId.toLowerCase()),
  );
  const cells = new Map<string, Map<DateOnly, MatrixEntry[]>>();
  const ids = new Map<string, string>();
  for (const key of assigned) ids.set(key, byId.get(key)?.id ?? key);
  for (const duty of duties) {
    const unavailable = new Set(duty.availabilityConflicts.map((conflict) => conflict.assignmentId.toLowerCase()));
    for (const member of duty.assignments) {
      const key = member.employeeId.toLowerCase();
      if (!ids.has(key)) ids.set(key, member.employeeId);
      const byDate = cells.get(key) ?? new Map<DateOnly, MatrixEntry[]>();
      cells.set(key, byDate);
      const entries = byDate.get(duty.dutyDate) ?? [];
      entries.push({ duty, member, unavailable: unavailable.has(member.id.toLowerCase()) });
      entries.sort((a, b) => KIND_ORDER[a.duty.shiftKind] - KIND_ORDER[b.duty.shiftKind]);
      byDate.set(duty.dutyDate, entries);
    }
  }
  const rows: MatrixRow[] = [...ids].map(([key, employeeId]) => {
    const employee = byId.get(key) ?? null;
    const rowCells = cells.get(key) ?? new Map<DateOnly, MatrixEntry[]>();
    return {
      key,
      employeeId,
      employee,
      name: employee ? fullName(employee) : UNKNOWN_PERSON,
      code: employee?.employeeCode ?? null,
      assigned: assigned.has(key),
      inactive: employee?.status === 'INACTIVE',
      cells: rowCells,
      hasConflict: [...rowCells.values()].some((entries) => entries.some((entry) => entry.unavailable)),
    };
  });
  return rows.sort((a, b) => {
    if ((a.employee === null) !== (b.employee === null)) return a.employee === null ? 1 : -1;
    if (a.employee && b.employee) {
      return collator.compare(a.employee.lastName, b.employee.lastName)
        || collator.compare(a.employee.firstName, b.employee.firstName)
        || a.key.localeCompare(b.key);
    }
    return a.key.localeCompare(b.key);
  });
}

/** Search (name or employee code) and the "only hints" filter. */
export function filterRows(rows: readonly MatrixRow[], query: string, onlyConflicts: boolean): MatrixRow[] {
  const needle = query.trim().toLocaleLowerCase('de-DE');
  return rows.filter((row) =>
    (!onlyConflicts || row.hasConflict)
    && (needle === '' || row.name.toLocaleLowerCase('de-DE').includes(needle) || (row.code ?? '').toLocaleLowerCase('de-DE').includes(needle)));
}

/** Visible short text of a cell: `Tag`, `Nacht`, `Tag + Nacht` or `–` (free). */
export function cellText(entries: readonly MatrixEntry[] | undefined): string {
  if (!entries || entries.length === 0) return '–';
  return entries.map((entry) => SHORT_KIND[entry.duty.shiftKind]).join(' + ');
}

function entryText(entry: MatrixEntry): string {
  const parts = [SHIFT_TYPE_LABELS[entry.duty.shiftKind]];
  if (entry.member.dutyRole === 'SHIFT_LEAD') parts.push(DUTY_ROLE_LABELS.SHIFT_LEAD);
  if (entry.member.source === 'REPLACEMENT') parts.push('Ersatz');
  if (entry.unavailable) parts.push('nicht verfügbar');
  return parts.join(', ');
}

/** Accessible name (5.7): person, date and current state, e.g. `Mira Beispiel, Do., 3. Dezember: Tagdienst, Schichtleitung`. */
export function cellName(name: string, date: DateOnly, entries: readonly MatrixEntry[] | undefined): string {
  const state = !entries || entries.length === 0 ? 'frei' : entries.map(entryText).join('; ');
  return `${name}, ${spokenDate(date)}: ${state}`;
}

/** The live duties of one date by kind. */
export function dutiesOn(duties: readonly Duty[], date: DateOnly): Partial<Record<ShiftKind, Duty>> {
  const result: Partial<Record<ShiftKind, Duty>> = {};
  for (const duty of duties) if (duty.dutyDate === date) result[duty.shiftKind] = duty;
  return result;
}

function peopleCount(count: number): string {
  return count === 0 ? 'ohne Besetzung' : count === 1 ? '1 Person' : `${count} Personen`;
}

/** Visible text of the per-day duty row: e.g. `T2 N0`, or `–` without duties. */
export function dayText(day: Partial<Record<ShiftKind, Duty>>): string {
  const parts = (['DAY', 'NIGHT'] as const)
    .filter((kind) => day[kind])
    .map((kind) => `${kind === 'DAY' ? 'T' : 'N'}${day[kind]!.assignments.length}`);
  return parts.length === 0 ? '–' : parts.join(' ');
}

/** Accessible name of the per-day duty cell, e.g. `Do., 3. Dezember: Tagdienst, 2 Personen; kein Nachtdienst`. */
export function dayName(date: DateOnly, day: Partial<Record<ShiftKind, Duty>>): string {
  const parts = (['DAY', 'NIGHT'] as const).map((kind) => {
    const duty = day[kind];
    return duty ? `${SHIFT_TYPE_LABELS[kind]}, ${peopleCount(duty.assignments.length)}` : `kein ${SHIFT_TYPE_LABELS[kind]}`;
  });
  return `${spokenDate(date)}: ${parts.join('; ')}`;
}
