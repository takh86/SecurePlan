/** API vocabulary of the employee resource (v1). DB values differ; see employee.mapper.ts. */
export const ShiftEligibility = { DAY: 'DAY', NIGHT: 'NIGHT', BOTH: 'BOTH' } as const;
export type ShiftEligibility = (typeof ShiftEligibility)[keyof typeof ShiftEligibility];

export const EmployeeStatus = { ACTIVE: 'ACTIVE', INACTIVE: 'INACTIVE' } as const;
export type EmployeeStatus = (typeof EmployeeStatus)[keyof typeof EmployeeStatus];

export const EmployeeSortField = {
  employeeCode: 'employeeCode',
  firstName: 'firstName',
  lastName: 'lastName',
  status: 'status',
} as const;
export type EmployeeSortField = (typeof EmployeeSortField)[keyof typeof EmployeeSortField];

export const SortOrder = { asc: 'asc', desc: 'desc' } as const;
export type SortOrder = (typeof SortOrder)[keyof typeof SortOrder];

/**
 * Response DTO. Deliberately excludes companyId, accountId, password/token
 * data, session details and internal timestamps.
 */
export type EmployeeResponse = {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  employmentStart: string | null;
  employmentEnd: string | null;
  shiftEligibility: ShiftEligibility;
  status: EmployeeStatus;
  email: string;
  accountStatus: 'PENDING_ACTIVATION' | 'ACTIVE' | 'DEACTIVATED';
};

export type EmployeePage = {
  items: EmployeeResponse[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
};
