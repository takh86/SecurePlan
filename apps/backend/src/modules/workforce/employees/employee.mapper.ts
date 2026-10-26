/**
 * Explicit API <-> database vocabulary mapping for employees.
 * API: DAY/NIGHT/BOTH, ACTIVE/INACTIVE, employeeCode.
 * DB:  TAG/NACHT/BOTH, ACTIVE/DEACTIVATED, employee_number.
 * An unknown stored value is a server defect and fails closed (500).
 */
import type { AccountSummary } from '../../identity/account-lifecycle.service.js';
import type {
  EmployeeResponse,
  EmployeeSortField,
  EmployeeStatus,
  ShiftEligibility,
} from './employee.types.js';

export type EmployeeRow = {
  id: string;
  account_id: string;
  employee_number: string;
  first_name: string;
  last_name: string;
  employment_start: string | null;
  employment_end: string | null;
  shift_eligibility: string;
  status: string;
};

/** Dates are rendered by PostgreSQL as YYYY-MM-DD; never via JS Date (time-zone shifts). */
export const EMPLOYEE_COLUMNS = `
  id, account_id, employee_number, first_name, last_name,
  to_char(employment_start, 'YYYY-MM-DD') AS employment_start,
  to_char(employment_end, 'YYYY-MM-DD') AS employment_end,
  shift_eligibility, status`;

const ELIGIBILITY_TO_DB: Record<ShiftEligibility, string> = { DAY: 'TAG', NIGHT: 'NACHT', BOTH: 'BOTH' };
const STATUS_TO_DB: Record<EmployeeStatus, string> = { ACTIVE: 'ACTIVE', INACTIVE: 'DEACTIVATED' };

/** Whitelisted ORDER BY columns; client input never reaches SQL text. */
export const SORT_COLUMNS: Record<EmployeeSortField, string> = {
  employeeCode: 'employee_number',
  firstName: 'first_name',
  lastName: 'last_name',
  status: 'status',
};

function invert<T extends string>(map: Record<T, string>): Map<string, T> {
  return new Map(Object.entries(map).map(([api, db]) => [db as string, api as T]));
}

const ELIGIBILITY_FROM_DB = invert(ELIGIBILITY_TO_DB);
const STATUS_FROM_DB = invert(STATUS_TO_DB);

function fromDb<T>(map: Map<string, T>, value: string, what: string): T {
  const mapped = map.get(value);
  if (mapped === undefined) throw new Error(`Unexpected ${what} in database`);
  return mapped;
}

export function eligibilityToDb(value: ShiftEligibility): string {
  return ELIGIBILITY_TO_DB[value];
}

export function statusToDb(value: EmployeeStatus): string {
  return STATUS_TO_DB[value];
}

export function eligibilityFromDb(value: string): ShiftEligibility {
  return fromDb(ELIGIBILITY_FROM_DB, value, 'shift eligibility');
}

export function statusFromDb(value: string): EmployeeStatus {
  return fromDb(STATUS_FROM_DB, value, 'employee status');
}

export function toEmployeeResponse(row: EmployeeRow, account: AccountSummary | undefined): EmployeeResponse {
  // Every employee has exactly one account in the same tenant (composite FK).
  if (!account) throw new Error('Employee account summary missing');
  return {
    id: row.id,
    employeeCode: row.employee_number,
    firstName: row.first_name,
    lastName: row.last_name,
    employmentStart: row.employment_start,
    employmentEnd: row.employment_end,
    shiftEligibility: eligibilityFromDb(row.shift_eligibility),
    status: statusFromDb(row.status),
    email: account.email,
    accountStatus: account.status,
  };
}
