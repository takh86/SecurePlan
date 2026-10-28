/**
 * SP-09 correction of one month assignment: form values, client-side format
 * checks and the PATCH body. Business rules (status, employment, one project
 * per person and month, planning data) are decided by the server only.
 */
import { ApiError } from '../../shared/api/api-error';
import { parseMonth } from '../../shared/time/month';
import { monthStartOf, type ProjectAssignment, type UpdateProjectAssignmentInput } from './project-assignments-api';

/** `month` is the raw text of the month field (`YYYY-MM` once valid). */
export type CorrectionValues = { employeeId: string; projectId: string; month: string };
export type CorrectionField = keyof CorrectionValues;
export type CorrectionErrors = Partial<Record<CorrectionField, string>>;

export function initialCorrection(assignment: ProjectAssignment): CorrectionValues {
  return {
    employeeId: assignment.employeeId,
    projectId: assignment.projectId,
    month: assignment.monthStart.slice(0, 7),
  };
}

export function isSameCorrection(a: CorrectionValues, b: CorrectionValues): boolean {
  return a.employeeId === b.employeeId && a.projectId === b.projectId && a.month.trim() === b.month.trim();
}

export const MONTH_FORMAT_ERROR = 'Bitte geben Sie den Monat im Format JJJJ-MM an, z. B. 2027-01.';

/** Format checks only; whether the correction is allowed is the server's decision. */
export function validateCorrection(values: CorrectionValues): CorrectionErrors {
  const errors: CorrectionErrors = {};
  if (values.employeeId === '') errors.employeeId = 'Bitte wählen Sie eine Person aus.';
  if (values.projectId === '') errors.projectId = 'Bitte wählen Sie ein Projekt aus.';
  if (parseMonth(values.month.trim()) === null) errors.month = MONTH_FORMAT_ERROR;
  return errors;
}

/**
 * PATCH body with only the dimensions that differ from the persisted
 * assignment; an empty object means there is nothing to save.
 * Expects values that passed `validateCorrection`.
 */
export function correctionChanges(assignment: ProjectAssignment, values: CorrectionValues): UpdateProjectAssignmentInput {
  const changes: UpdateProjectAssignmentInput = {};
  if (values.employeeId !== assignment.employeeId) changes.employeeId = values.employeeId;
  if (values.projectId !== assignment.projectId) changes.projectId = values.projectId;
  const monthStart = monthStartOf(values.month.trim());
  if (monthStart !== assignment.monthStart) changes.monthStart = monthStart;
  return changes;
}

const SERVER_FIELDS: Record<string, CorrectionField> = {
  '#/employeeId': 'employeeId',
  '#/projectId': 'projectId',
  '#/monthStart': 'month',
};

/** Maps safe `errors[]` pointers (and INVALID_MONTH_START) back to the form fields. */
export function serverCorrectionErrors(error: Error): CorrectionErrors {
  const result: CorrectionErrors = {};
  if (!(error instanceof ApiError)) return result;
  for (const { pointer } of error.fieldErrors) {
    const field = SERVER_FIELDS[pointer];
    if (field) result[field] = 'Diese Angabe wurde nicht angenommen. Bitte prüfen Sie sie.';
  }
  if (error.code === 'INVALID_MONTH_START') result.month = MONTH_FORMAT_ERROR;
  return result;
}
