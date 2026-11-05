/** Planning-owned saved-duty projection and candidate conflict facts; no Workflow dependencies. */
import type { PoolClient } from 'pg';
export const replacementPlanningJoin = `
 JOIN public.plan_assignments a ON a.company_id=r.company_id AND a.id=r.assignment_id AND a.employee_id=r.employee_id AND a.duty_id=r.duty_id
 JOIN public.duties d ON d.company_id=a.company_id AND d.id=a.duty_id
 JOIN public.monthly_plans p ON p.company_id=d.company_id AND p.id=d.monthly_plan_id AND p.project_id=d.project_id AND p.planning_month=d.planning_month
 JOIN public.projects pr ON pr.company_id=d.company_id AND pr.id=d.project_id`;
export const replacementPlanningFacts = `
 d.project_id,d.monthly_plan_id AS plan_id,d.planning_month::text,d.time_zone,pr.name AS project_name,
 d.id AS duty_id,to_char(d.duty_date,'YYYY-MM-DD') AS duty_date,
 CASE d.shift_kind WHEN 'TAG' THEN 'DAY' ELSE 'NIGHT' END AS shift_kind,
 to_char(d.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
 to_char(d.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at,
 pr.status='ACTIVE' AS project_active,p.status='PUBLISHED' AS published,
 d.removed_at IS NULL AND a.state='ACTIVE' AND a.removed_at IS NULL AS live,
 d.starts_at>moment.at AS before_start,
 NOT EXISTS(SELECT 1 FROM public.plan_assignments x WHERE x.company_id=d.company_id AND x.employee_id=$2 AND x.duty_id=d.id AND x.state='ACTIVE' AND x.removed_at IS NULL) AS unassigned,
 NOT EXISTS(SELECT 1 FROM public.plan_assignments x JOIN public.duties other ON other.company_id=x.company_id AND other.id=x.duty_id
 WHERE x.company_id=d.company_id AND x.employee_id=$2 AND x.state='ACTIVE' AND x.removed_at IS NULL AND other.removed_at IS NULL
 AND ((other.starts_at<d.ends_at AND other.ends_at>d.starts_at) OR (other.project_id=d.project_id AND other.duty_date=d.duty_date AND other.shift_kind<>d.shift_kind))) AS conflict_free`;
export type ReplacementLockContext = {
  plan_id: string;
  duty_id: string;
  assignment_id: string;
};
/** E/P/M are already held. L -> D -> A2, with deterministic assignment ordering. */
export async function lockReplacementDuty(
  c: PoolClient,
  company: string,
  employee: string,
  found: ReplacementLockContext,
) {
  await c.query(
    'SELECT id FROM public.monthly_plans WHERE company_id=$1 AND id=$2 FOR SHARE',
    [company, found.plan_id],
  );
  await c.query(
    'SELECT id FROM public.duties WHERE company_id=$1 AND id=$2 FOR UPDATE',
    [company, found.duty_id],
  );
  await c.query(
    'SELECT id FROM public.plan_assignments WHERE company_id=$1 AND (id=$2 OR (duty_id=$3 AND employee_id=$4)) ORDER BY id FOR UPDATE',
    [company, found.assignment_id, found.duty_id, employee],
  );
}
/** Historical month membership, independent of the original requester's employee. */
export const replacementHistoryDutyJoin = `JOIN public.duties d ON d.company_id=n.company_id AND d.id=n.duty_id`;
