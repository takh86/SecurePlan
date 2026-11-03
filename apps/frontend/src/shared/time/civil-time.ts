/** Gregorian and named-zone primitives shared by identity and personal plan reads. */
export function isCivilDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
export function isUtcSecond(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\dZ$/.test(value) && isCivilDate(value.slice(0, 10));
}
export function isNamedTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z][^\s]*$/.test(value)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); return true; } catch { return false; }
}
export function parsePlanMonth(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}$/.test(value) && isCivilDate(`${value}-01`) ? value : null;
}
export function stepPlanMonth(month: string, delta: -1 | 1): string | null {
  const [year, number] = month.split('-').map(Number);
  const index = (year - 1) * 12 + number - 1 + delta;
  if (index < 0 || index >= 9999 * 12) return null;
  return `${String(Math.floor(index / 12) + 1).padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}`;
}
function civilInstant(date: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const result = new Date(0);
  result.setUTCFullYear(year, month - 1, day);
  result.setUTCHours(0, 0, 0, 0);
  return result;
}
export function planMonthLabel(month: string): string {
  return `${new Intl.DateTimeFormat('de-DE', { month: 'long', timeZone: 'UTC' }).format(civilInstant(`${month}-01`))} ${month.slice(0, 4)}`;
}
export function planDateLabel(date: string): string {
  const weekday = new Intl.DateTimeFormat('de-DE', { weekday: 'short', timeZone: 'UTC' }).format(civilInstant(date));
  return `${weekday}, ${date.slice(8)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;
}
export function zonedDutyTime(instant: string, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)!.value;
  return { date: `${value('year').padStart(4, '0')}-${value('month')}-${value('day')}`, time: `${value('hour')}:${value('minute')}` };
}
