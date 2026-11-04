/** Planning-owned historical discovery and final-strength lock contract for Workflow. */
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../../auth/authorization/tenant-context.js';
export type CancellationContext = {
  assignment_id: string;
  employee_id: string;
  duty_id: string;
  project_id: string;
  plan_id: string;
  planning_month: string;
  state: string;
  removed_at: Date | null;
  duty_removed_at: Date | null;
  plan_status: string;
  project_status: string;
  version: string;
  dutyDate: string;
  shiftKind: 'DAY' | 'NIGHT';
  startsAt: string;
  endsAt: string;
};
const query = `SELECT a.id AS assignment_id,a.employee_id,a.duty_id,d.project_id,d.monthly_plan_id AS plan_id,
  d.planning_month::text,a.state,a.removed_at,d.removed_at AS duty_removed_at,
  p.status AS plan_status,pr.status AS project_status,d.concurrency_version::text AS version,
  to_char(d.duty_date,'YYYY-MM-DD') AS "dutyDate",CASE d.shift_kind WHEN 'TAG' THEN 'DAY' WHEN 'NACHT' THEN 'NIGHT' END AS "shiftKind",
  to_char(d.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "startsAt",
  to_char(d.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "endsAt"
  FROM public.plan_assignments a JOIN public.duties d ON d.company_id=a.company_id AND d.id=a.duty_id
  JOIN public.monthly_plans p ON p.company_id=d.company_id AND p.id=d.monthly_plan_id AND p.project_id=d.project_id AND p.planning_month=d.planning_month
  JOIN public.projects pr ON pr.company_id=d.company_id AND pr.id=d.project_id
  WHERE a.company_id=$1 AND a.id=$2`;
export async function cancellationContext(
  c: PoolClient,
  companyId: string,
  assignmentId: string,
  ownerId?: string,
): Promise<CancellationContext> {
  const row = (
    await c.query<CancellationContext>(query, [companyId, assignmentId])
  ).rows[0];
  if (!row || (ownerId && row.employee_id !== ownerId))
    throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
  return row;
}
export async function lockCancellationContext(
  c: PoolClient,
  t: TenantContext,
  found: CancellationContext,
): Promise<CancellationContext> {
  await c.query(
    'SELECT id FROM public.projects WHERE company_id=$1 AND id=$2 FOR SHARE',
    [t.companyId, found.project_id],
  );
  // An existing own assignment establishes visibility; no new monthly-link eligibility rule.
  await c.query(
    'SELECT id FROM public.monthly_plans WHERE company_id=$1 AND id=$2 FOR SHARE',
    [t.companyId, found.plan_id],
  );
  await c.query(
    'SELECT id FROM public.duties WHERE company_id=$1 AND id=$2 FOR UPDATE',
    [t.companyId, found.duty_id],
  );
  await c.query(
    'SELECT id FROM public.plan_assignments WHERE company_id=$1 AND id=$2 FOR UPDATE',
    [t.companyId, found.assignment_id],
  );
  const row = await cancellationContext(
    c,
    t.companyId,
    found.assignment_id,
    found.employee_id,
  );
  if (
    ['project_id', 'plan_id', 'duty_id', 'planning_month'].some(
      (k) =>
        row[k as keyof CancellationContext] !==
        found[k as keyof CancellationContext],
    )
  )
    throw new Error('Planning context changed during lock discovery');
  return row;
}
export function assertCancellationEligible(
  row: CancellationContext,
  version: number,
): void {
  if (row.state !== 'ACTIVE' || row.removed_at !== null)
    throw new ConflictException({ code: 'CANCELLATION_ASSIGNMENT_NOT_ACTIVE' });
  if (
    row.duty_removed_at !== null ||
    row.plan_status !== 'PUBLISHED' ||
    !['ACTIVE', 'INACTIVE'].includes(row.project_status)
  )
    throw new ConflictException({ code: 'CANCELLATION_PLAN_CHANGED' });
  if (
    !/^[1-9][0-9]*$/.test(row.version) ||
    !Number.isSafeInteger(Number(row.version))
  )
    throw new Error('Invalid duty version');
  if (Number(row.version) !== version)
    throw new ConflictException({ code: 'PLAN_CONCURRENT_MODIFICATION' });
}

/** Planning-owned historical membership projection for a bounded personal workflow read. */
export async function cancellationAssignmentsForMonth(
  c: PoolClient,
  companyId: string,
  employeeId: string,
  monthStart: string,
): Promise<string[]> {
  return (
    await c.query<{ assignment_id: string }>(
      `SELECT a.id AS assignment_id FROM public.plan_assignments a
     JOIN public.duties d ON d.company_id=a.company_id AND d.id=a.duty_id
     WHERE a.company_id=$1 AND a.employee_id=$2 AND d.planning_month=$3::date ORDER BY a.id`,
      [companyId, employeeId, monthStart],
    )
  ).rows.map((row) => row.assignment_id);
}
