import type { Clock } from './clock';

/** Calendar month in `YYYY-MM` form, e.g. `2026-12`. */
export type MonthKey = string;
/** Calendar date without time or zone in `YYYY-MM-DD` form. */
export type DateOnly = string;

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
// Planning months outside this range are treated as invalid input, not as data.
const MIN_YEAR = 2000;
const MAX_YEAR = 2099;

// Date-only values are formatted in UTC so neither the browser time zone nor a
// DST change can shift a displayed day.
const monthLabelFormat = new Intl.DateTimeFormat('de-DE', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const dateFormat = new Intl.DateTimeFormat('de-DE', {
  weekday: 'short',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
});

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}

function toMonthKey(year: number, month: number): MonthKey {
  return `${pad(year, 4)}-${pad(month, 2)}`;
}

function toDateOnly(year: number, month: number, day: number): DateOnly {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function monthParts(month: MonthKey): [number, number] {
  const [year, monthNumber] = month.split('-').map(Number);
  return [year, monthNumber];
}

function utcDate(date: DateOnly): Date {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/** Returns the month for a strictly formatted `YYYY-MM` value, otherwise `null`. */
export function parseMonth(value: string | undefined): MonthKey | null {
  if (value === undefined) return null;
  const match = MONTH_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  return year >= MIN_YEAR && year <= MAX_YEAR ? value : null;
}

/** Month of the clock's local calendar date. */
export function currentMonth(clock: Clock): MonthKey {
  const now = clock();
  return toMonthKey(now.getFullYear(), now.getMonth() + 1);
}

/** Local calendar date of the clock. */
export function todayOf(clock: Clock): DateOnly {
  const now = clock();
  return toDateOnly(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function addMonths(month: MonthKey, delta: number): MonthKey {
  const [year, monthNumber] = monthParts(month);
  const index = year * 12 + (monthNumber - 1) + delta;
  return toMonthKey(Math.floor(index / 12), (index % 12) + 1);
}

export function daysInMonth(month: MonthKey): number {
  const [year, monthNumber] = monthParts(month);
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

/** The given day of the month, or `null` if the month has no such day. */
export function dateInMonth(month: MonthKey, day: number): DateOnly | null {
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth(month)) return null;
  const [year, monthNumber] = monthParts(month);
  return toDateOnly(year, monthNumber, day);
}

export function addDays(date: DateOnly, delta: number): DateOnly {
  const shifted = utcDate(date);
  shifted.setUTCDate(shifted.getUTCDate() + delta);
  return toDateOnly(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/** German month label, e.g. `Januar 2027`. */
export function formatMonthLabel(month: MonthKey): string {
  const [year, monthNumber] = monthParts(month);
  return monthLabelFormat.format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}

/** German date with weekday, e.g. `Do., 31.12.2026`. */
export function formatDate(date: DateOnly): string {
  return dateFormat.format(utcDate(date));
}
