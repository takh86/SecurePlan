/**
 * SP-07 form model. Client checks mirror the server contract for fast
 * feedback only; the server stays authoritative and its field errors win.
 */
import { ApiError, type FieldErrorCode } from '../../shared/api/api-error';
import type { CreateEmployeeInput, Employee, ShiftEligibility, UpdateEmployeeInput } from './employee-types';

export type FormMode = 'create' | 'edit';

export type EmployeeFormValues = {
  employeeCode: string;
  firstName: string;
  lastName: string;
  email: string;
  employmentStart: string;
  employmentEnd: string;
  shiftEligibility: ShiftEligibility | '';
};

export type FieldName = keyof EmployeeFormValues;
export type FieldErrors = Partial<Record<FieldName, string>>;

/** Display order; also the order in which focus searches for the first error. */
export const FIELD_ORDER: readonly FieldName[] = [
  'employeeCode',
  'firstName',
  'lastName',
  'email',
  'employmentStart',
  'employmentEnd',
  'shiftEligibility',
];

export const EMPTY_FORM: EmployeeFormValues = {
  employeeCode: '',
  firstName: '',
  lastName: '',
  email: '',
  employmentStart: '',
  employmentEnd: '',
  shiftEligibility: '',
};

const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function valuesFromEmployee(employee: Employee): EmployeeFormValues {
  return {
    employeeCode: employee.employeeCode,
    firstName: employee.firstName,
    lastName: employee.lastName,
    email: employee.email,
    employmentStart: employee.employmentStart ?? '',
    employmentEnd: employee.employmentEnd ?? '',
    shiftEligibility: employee.shiftEligibility,
  };
}

function nameError(value: string, label: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return `Bitte ${label} eingeben.`;
  if (trimmed.length < 2) return `${label} muss mindestens 2 Zeichen lang sein.`;
  if (trimmed.length > 50) return `${label} darf höchstens 50 Zeichen lang sein.`;
  return undefined;
}

export function validateEmployeeForm(values: EmployeeFormValues, mode: FormMode): FieldErrors {
  const errors: FieldErrors = {};
  const code = values.employeeCode.trim();
  if (!code) errors.employeeCode = 'Bitte eine Mitarbeiter-ID eingeben.';
  else if (code.length > 30) errors.employeeCode = 'Die Mitarbeiter-ID darf höchstens 30 Zeichen lang sein.';
  else if (!CODE_PATTERN.test(code)) {
    errors.employeeCode = 'Nur Buchstaben, Ziffern sowie . _ - verwenden; mit Buchstabe oder Ziffer beginnen.';
  }
  const first = nameError(values.firstName, 'Vorname');
  if (first) errors.firstName = first;
  const last = nameError(values.lastName, 'Nachname');
  if (last) errors.lastName = last;

  if (mode === 'create') {
    const email = values.email.trim();
    if (!email) errors.email = 'Bitte eine E-Mail-Adresse eingeben.';
    else if (email.length > 254 || !EMAIL_PATTERN.test(email)) errors.email = 'Bitte eine gültige E-Mail-Adresse eingeben.';
  }
  if (values.employmentStart && !DATE_PATTERN.test(values.employmentStart)) {
    errors.employmentStart = 'Bitte ein gültiges Datum eingeben.';
  }
  if (values.employmentEnd && !DATE_PATTERN.test(values.employmentEnd)) {
    errors.employmentEnd = 'Bitte ein gültiges Datum eingeben.';
  }
  if (
    !errors.employmentStart && !errors.employmentEnd &&
    values.employmentStart && values.employmentEnd && values.employmentEnd < values.employmentStart
  ) {
    errors.employmentEnd = 'Das Beschäftigungsende darf nicht vor dem Beginn liegen.';
  }
  if (!values.shiftEligibility) errors.shiftEligibility = 'Bitte eine Schicht-Eignung auswählen.';
  return errors;
}

export function toCreateInput(values: EmployeeFormValues): CreateEmployeeInput {
  return {
    employeeCode: values.employeeCode.trim(),
    firstName: values.firstName.trim(),
    lastName: values.lastName.trim(),
    email: values.email.trim(),
    ...(values.employmentStart ? { employmentStart: values.employmentStart } : {}),
    shiftEligibility: values.shiftEligibility as ShiftEligibility,
  };
}

/** Only fields that differ from the loaded record; an empty object means "nothing changed". */
export function toUpdateInput(values: EmployeeFormValues, original: Employee): UpdateEmployeeInput {
  const changes: UpdateEmployeeInput = {};
  const code = values.employeeCode.trim();
  const first = values.firstName.trim();
  const last = values.lastName.trim();
  const start = values.employmentStart || null;
  const end = values.employmentEnd || null;
  if (code !== original.employeeCode) changes.employeeCode = code;
  if (first !== original.firstName) changes.firstName = first;
  if (last !== original.lastName) changes.lastName = last;
  if (start !== original.employmentStart) changes.employmentStart = start;
  if (end !== original.employmentEnd) changes.employmentEnd = end;
  if (values.shiftEligibility && values.shiftEligibility !== original.shiftEligibility) {
    changes.shiftEligibility = values.shiftEligibility;
  }
  return changes;
}

const SUBCODE_TEXT: Record<FieldErrorCode, string> = {
  REQUIRED: 'Dieses Feld ist erforderlich.',
  INVALID_TYPE: 'Der Wert ist ungültig.',
  INVALID_FORMAT: 'Das Format ist ungültig.',
  INVALID_UUID: 'Der Wert ist ungültig.',
  INVALID_ENUM: 'Bitte eine gültige Option wählen.',
  TOO_SHORT: 'Der Wert ist zu kurz.',
  TOO_LONG: 'Der Wert ist zu lang.',
  OUT_OF_RANGE: 'Der Wert liegt außerhalb des erlaubten Bereichs.',
  DUPLICATE_ITEM: 'Der Wert ist doppelt.',
};

/**
 * Maps a server error to field messages where the contract allows it.
 * Returns null when the error is not field-specific (show it as an alert).
 */
export function serverFieldErrors(error: unknown): FieldErrors | null {
  if (!(error instanceof ApiError)) return null;
  switch (error.code) {
    case 'EMPLOYEE_CODE_ALREADY_EXISTS':
      return { employeeCode: 'Diese Mitarbeiter-ID ist in Ihrem Unternehmen bereits vergeben.' };
    case 'EMAIL_ALREADY_IN_USE':
      // Neutral on purpose: never reveal where the address is registered.
      return { email: 'Diese E-Mail-Adresse kann nicht verwendet werden.' };
    case 'EMPLOYMENT_DATE_CONFLICT':
      return { employmentEnd: 'Das Beschäftigungsende darf nicht vor dem Beginn liegen.' };
    case 'VALIDATION_FAILED': {
      const errors: FieldErrors = {};
      for (const item of error.fieldErrors) {
        const field = item.pointer.slice(2) as FieldName;
        if ((FIELD_ORDER as readonly string[]).includes(field) && !errors[field]) {
          errors[field] = SUBCODE_TEXT[item.code];
        }
      }
      return Object.keys(errors).length > 0 ? errors : null;
    }
    default:
      return null;
  }
}
