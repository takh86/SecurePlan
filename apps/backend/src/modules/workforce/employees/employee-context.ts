/** Workforce public transaction contract; no repository access by Workflow. */
import { ForbiddenException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../../../auth/authorization/tenant-context.js';
type Transaction = Pick<PoolClient, 'query'>;
export type EmployeeSummary = {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
};
export async function currentEmployee(
  c: Transaction,
  t: TenantContext,
  lockedId?: string,
): Promise<EmployeeSummary> {
  if (lockedId)
    await c.query(
      'SELECT id FROM public.employees WHERE company_id=$1 AND id=$2 FOR SHARE',
      [t.companyId, lockedId],
    );
  const row = (
    await c.query<EmployeeSummary>(
      `SELECT id,employee_number AS "employeeCode",first_name AS "firstName",last_name AS "lastName"
    FROM public.employees WHERE company_id=$1 AND account_id=$2 AND status='ACTIVE'`,
      [t.companyId, t.accountId],
    )
  ).rows[0];
  if (!row || (lockedId && row.id !== lockedId))
    throw new ForbiddenException({ code: 'ACTION_FORBIDDEN' });
  return row;
}
export async function employeeSummary(
  c: Transaction,
  companyId: string,
  employeeId: string,
): Promise<EmployeeSummary> {
  const row = (
    await c.query<EmployeeSummary>(
      `SELECT id,employee_number AS "employeeCode",first_name AS "firstName",last_name AS "lastName"
    FROM public.employees WHERE company_id=$1 AND id=$2`,
      [companyId, employeeId],
    )
  ).rows[0];
  if (!row) throw new Error('Missing historical employee');
  return row;
}
