import type { StatusTone } from '../../shared/ui/StatusBadge';

/** Employee resource as returned by the SP-07 API (`/api/v1/employees`). */
export type ShiftEligibility = 'DAY' | 'NIGHT' | 'BOTH';
export type EmployeeStatus = 'ACTIVE' | 'INACTIVE';
export type AccountStatus = 'PENDING_ACTIVATION' | 'ACTIVE' | 'DEACTIVATED';

export type Employee = {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  employmentStart: string | null;
  employmentEnd: string | null;
  shiftEligibility: ShiftEligibility;
  status: EmployeeStatus;
  email: string;
  accountStatus: AccountStatus;
};

export type EmployeePage = {
  items: Employee[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
};

export type EmployeeListQuery = {
  q?: string;
  status?: EmployeeStatus;
  page?: number;
};

export type CreateEmployeeInput = {
  employeeCode: string;
  firstName: string;
  lastName: string;
  email: string;
  employmentStart?: string;
  shiftEligibility: ShiftEligibility;
};

/** PATCH body: only changed fields. E-mail is not editable here. */
export type UpdateEmployeeInput = Partial<{
  employeeCode: string;
  firstName: string;
  lastName: string;
  employmentStart: string | null;
  employmentEnd: string | null;
  shiftEligibility: ShiftEligibility;
}>;

export const SHIFT_ELIGIBILITY_LABELS: Record<ShiftEligibility, string> = {
  DAY: 'Tag',
  NIGHT: 'Nacht',
  BOTH: 'Tag und Nacht',
};

export const EMPLOYEE_STATUS: Record<EmployeeStatus, { label: string; tone: StatusTone }> = {
  ACTIVE: { label: 'Aktiv', tone: 'success' },
  INACTIVE: { label: 'Deaktiviert', tone: 'neutral' },
};

export const ACCOUNT_STATUS: Record<AccountStatus, { label: string; tone: StatusTone }> = {
  PENDING_ACTIVATION: { label: 'Aktivierung ausstehend', tone: 'attention' },
  ACTIVE: { label: 'Konto aktiv', tone: 'success' },
  DEACTIVATED: { label: 'Konto gesperrt', tone: 'neutral' },
};

export function fullName(employee: Pick<Employee, 'firstName' | 'lastName'>): string {
  return `${employee.firstName} ${employee.lastName}`;
}
