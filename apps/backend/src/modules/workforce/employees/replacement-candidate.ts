/** Workforce-owned SQL facts. Fixed aliases: e candidate, d saved target duty. */
import type { PoolClient } from 'pg';
export const replacementCandidateJoin = `JOIN public.employees e ON e.company_id=d.company_id AND e.id=$2 AND e.account_id=$3`;
export const replacementCandidateFacts = `
 e.status='ACTIVE' AS candidate_active,
 (e.employment_start IS NOT NULL AND e.employment_start<=d.duty_date AND (e.employment_end IS NULL OR e.employment_end>=d.duty_date)) AS employed,
 (e.shift_eligibility='BOTH' OR e.shift_eligibility=d.shift_kind) AS suitable,
 EXISTS(SELECT 1 FROM public.project_assignments m WHERE m.company_id=d.company_id AND m.employee_id=e.id AND m.project_id=d.project_id AND m.planning_month=d.planning_month) AS linked,
 NOT EXISTS(SELECT 1 FROM public.employee_availability_days v WHERE v.company_id=d.company_id AND v.employee_id=e.id AND v.day=d.duty_date AND v.status IN ('SICK','LEAVE')) AS available`;
/** P then M. The previously held E fence protects a missing monthly tuple too. */
export async function lockReplacementProject(
  c: PoolClient,
  company: string,
  employee: string,
  project: string,
  month: string,
) {
  await c.query(
    'SELECT id FROM public.projects WHERE company_id=$1 AND id=$2 FOR SHARE',
    [company, project],
  );
  await c.query(
    'SELECT id FROM public.project_assignments WHERE company_id=$1 AND employee_id=$2 AND project_id=$3 AND planning_month=$4::date ORDER BY id FOR SHARE',
    [company, employee, project, month],
  );
}
