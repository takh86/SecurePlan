/** Employee ownership projection; Identity authority is checked on the same transaction. */
export const MY_MONTHLY_PLANS_QUERY = String.raw`WITH owner AS (
  SELECT e.id AS employee_id, e.company_id
  FROM public.employees e
  WHERE e.company_id = $1::uuid AND e.account_id = $2::uuid
    AND e.status = 'ACTIVE'
), own_duties AS (
  SELECT d.id AS duty_id, d.company_id, d.project_id,
         d.monthly_plan_id AS plan_id, d.planning_month,
         d.duty_date, d.shift_kind, d.starts_at, d.ends_at,
         d.time_zone, pa.duty_function, pa.id AS assignment_id, d.concurrency_version::text AS version
  FROM owner o
  JOIN public.plan_assignments pa
    ON pa.company_id = o.company_id AND pa.employee_id = o.employee_id
   AND pa.state = 'ACTIVE' AND pa.removed_at IS NULL
  JOIN public.duties d
    ON d.company_id = pa.company_id AND d.id = pa.duty_id
   AND d.removed_at IS NULL
  JOIN public.monthly_plans mp
    ON mp.company_id = d.company_id AND mp.id = d.monthly_plan_id
   AND mp.project_id = d.project_id AND mp.planning_month = d.planning_month
   AND mp.status = 'PUBLISHED'
  JOIN public.projects p
    ON p.company_id = mp.company_id AND p.id = mp.project_id
   AND p.status IN ('ACTIVE', 'INACTIVE')
  WHERE pa.company_id = $1::uuid AND d.company_id = $1::uuid
    AND mp.company_id = $1::uuid AND p.company_id = $1::uuid
    AND d.planning_month = $3::date AND mp.planning_month = $3::date
), visible_plan_ids AS (
  -- P1 APPROVED: only the owner's monthly project link can establish empty-plan visibility.
  SELECT mp.company_id, mp.id AS plan_id
  FROM owner o
  JOIN public.project_assignments link
    ON link.company_id = o.company_id AND link.employee_id = o.employee_id
   AND link.planning_month = $3::date
  JOIN public.monthly_plans mp
    ON mp.company_id = link.company_id AND mp.project_id = link.project_id
   AND mp.planning_month = link.planning_month AND mp.status = 'PUBLISHED'
  JOIN public.projects p
    ON p.company_id = mp.company_id AND p.id = mp.project_id
   AND p.status IN ('ACTIVE', 'INACTIVE')
  WHERE link.company_id = $1::uuid AND mp.company_id = $1::uuid
    AND p.company_id = $1::uuid
  UNION
  -- Memberships independently establish ownership. No current link required.
  SELECT od.company_id, od.plan_id FROM own_duties od
  WHERE od.company_id = $1::uuid
), visible_plans AS (
  SELECT mp.company_id, mp.id AS plan_id, mp.project_id,
         mp.planning_month, p.name AS project_name
  FROM visible_plan_ids v
  JOIN public.monthly_plans mp
    ON mp.company_id = v.company_id AND mp.id = v.plan_id
   AND mp.planning_month = $3::date AND mp.status = 'PUBLISHED'
  JOIN public.projects p
    ON p.company_id = mp.company_id AND p.id = mp.project_id
   AND p.status IN ('ACTIVE', 'INACTIVE')
  WHERE v.company_id = $1::uuid AND mp.company_id = $1::uuid
    AND p.company_id = $1::uuid
)
SELECT o.employee_id AS internal_owner_id,
       vp.plan_id, vp.project_id, vp.project_name,
       to_char(vp.planning_month, 'YYYY-MM-DD') AS month_start,
       od.assignment_id, od.version, od.duty_id, to_char(od.duty_date, 'YYYY-MM-DD') AS duty_date,
       od.shift_kind, od.duty_function, od.time_zone,
       to_char(od.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
       to_char(od.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at
FROM owner o
LEFT JOIN visible_plans vp ON vp.company_id = o.company_id
LEFT JOIN own_duties od
  ON od.company_id = vp.company_id AND od.plan_id = vp.plan_id
 AND od.project_id = vp.project_id AND od.planning_month = vp.planning_month
ORDER BY vp.planning_month ASC, vp.project_id ASC, vp.plan_id ASC,
         od.duty_date ASC,
         CASE od.shift_kind WHEN 'TAG' THEN 0 WHEN 'NACHT' THEN 1 ELSE 2 END ASC,
         od.duty_id ASC;`;
