/** Strict civil values: never normalize invalid dates or infer a browser zone. */
export function isCivilDate(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^(?!0000)\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(value)
  )
    return false;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return (
    day >= 1 &&
    day <=
      [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  );
}

export function isUtcSecond(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\dZ$/.test(value) &&
    isCivilDate(value.slice(0, 10))
  );
}

export function isNamedTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z][^\s]*$/.test(value))
    return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}
