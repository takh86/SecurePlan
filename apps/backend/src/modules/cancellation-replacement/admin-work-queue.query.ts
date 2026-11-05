/** Admin read projections. Every query runs as one READ COMMITTED statement. */
const core = `WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at),
cases AS MATERIALIZED (
 SELECT r.id AS request_id,r.assignment_id,r.employee_id AS requester_id,r.duty_id,
 r.status AS request_status,r.created_at AS request_created,r.decided_at,
 n.id AS need_id,n.status AS need_status,n.created_at AS need_created,n.resolved_at,
 a.id IS NOT NULL AND a.state='ACTIVE' AND a.removed_at IS NULL AS original_active,
 d.removed_at IS NOT NULL AS duty_removed,d.duty_date,d.shift_kind,d.starts_at,d.ends_at,d.time_zone,
 d.planning_month,d.project_id,pr.name AS project_name,
 e.employee_number,e.first_name,e.last_name,
 COALESCE(n.id IS NOT NULL AND a.id IS NOT NULL AND d.id IS NOT NULL AND p.id IS NOT NULL
   AND pr.id IS NOT NULL AND e.id IS NOT NULL AND
   CASE WHEN r.status='OPEN' THEN n.status='OPEN' AND a.state='ACTIVE' AND a.removed_at IS NULL AND d.removed_at IS NULL AND p.status='PUBLISHED'
        WHEN r.status='APPROVED' AND n.status='OPEN_UNFILLED' THEN a.state='REMOVED' AND a.removed_at IS NOT NULL AND p.status='PUBLISHED'
        WHEN r.status='APPROVED' THEN n.status='RESOLVED'
        WHEN r.status IN ('WITHDRAWN','REJECTED','OBSOLETE') THEN n.status='CLOSED'
        ELSE false END,false) AS valid
 FROM public.cancellation_requests r
 LEFT JOIN public.replacement_needs n ON n.company_id=r.company_id AND n.cancellation_request_id=r.id AND n.duty_id=r.duty_id
 LEFT JOIN public.plan_assignments a ON a.company_id=r.company_id AND a.id=r.assignment_id AND a.employee_id=r.employee_id AND a.duty_id=r.duty_id
 LEFT JOIN public.duties d ON d.company_id=r.company_id AND d.id=r.duty_id
 LEFT JOIN public.monthly_plans p ON p.company_id=d.company_id AND p.id=d.monthly_plan_id AND p.project_id=d.project_id AND p.planning_month=d.planning_month
 LEFT JOIN public.projects pr ON pr.company_id=d.company_id AND pr.id=d.project_id
 LEFT JOIN public.employees e ON e.company_id=r.company_id AND e.id=r.employee_id
 WHERE r.company_id=$1 AND ($2::uuid IS NULL OR r.id=$2) AND ($3::uuid IS NULL OR n.id=$3)
),
offers AS MATERIALIZED (
 SELECT o.id,o.need_id,o.employee_id,o.status,o.created_at,o.decided_at,
 e.id IS NOT NULL AND e.candidate_account_id IS NOT NULL AS related,
 e.employee_number,e.first_name,e.last_name,
 CASE WHEN o.status<>'OPEN' OR c.request_status<>'OPEN' OR c.need_status<>'OPEN' OR c.duty_removed THEN 'NOT_APPLICABLE'
 WHEN COALESCE(c.valid AND e.id<>c.requester_id AND e.status='ACTIVE'
 AND e.candidate_account_status='ACTIVE' AND e.candidate_account_scope='TENANT' AND e.candidate_account_role='EMPLOYEE'
 AND pr.status='ACTIVE' AND c.starts_at>moment.at
 AND e.employment_start IS NOT NULL AND e.employment_start<=c.duty_date
 AND (e.employment_end IS NULL OR e.employment_end>=c.duty_date)
 AND (e.shift_eligibility='BOTH' OR e.shift_eligibility=c.shift_kind)
 AND EXISTS(SELECT 1 FROM public.project_assignments m WHERE m.company_id=$1 AND m.employee_id=e.id AND m.project_id=c.project_id AND m.planning_month=c.planning_month)
 AND NOT EXISTS(SELECT 1 FROM public.employee_availability_days v WHERE v.company_id=$1 AND v.employee_id=e.id AND v.day=c.duty_date AND v.status IN ('SICK','LEAVE'))
 AND NOT EXISTS(SELECT 1 FROM public.plan_assignments x WHERE x.company_id=$1 AND x.employee_id=e.id AND x.duty_id=c.duty_id AND x.state='ACTIVE' AND x.removed_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM public.plan_assignments x JOIN public.duties other ON other.company_id=x.company_id AND other.id=x.duty_id
   WHERE x.company_id=$1 AND x.employee_id=e.id AND x.state='ACTIVE' AND x.removed_at IS NULL AND other.removed_at IS NULL
   AND ((other.starts_at<c.ends_at AND other.ends_at>c.starts_at) OR (other.project_id=c.project_id AND other.duty_date=c.duty_date AND other.shift_kind<>c.shift_kind))),false)
 THEN 'ELIGIBLE' ELSE 'INELIGIBLE' END AS review_eligibility
 FROM cases c JOIN public.replacement_offers o ON o.company_id=$1 AND o.need_id=c.need_id
 LEFT JOIN LATERAL (
   SELECT candidate.id,candidate.status,candidate.shift_eligibility,candidate.employment_start,candidate.employment_end,
     candidate.employee_number,candidate.first_name,candidate.last_name,
     account.id AS candidate_account_id,account.status AS candidate_account_status,
     account.account_scope AS candidate_account_scope,account.role AS candidate_account_role
   FROM public.employees candidate
   LEFT JOIN LATERAL (
     SELECT a.id,a.status,a.account_scope,a.role FROM public.accounts a
     WHERE a.id=candidate.account_id AND a.company_id=$1 LIMIT 1
   ) account ON true
   WHERE candidate.id=o.employee_id AND candidate.company_id=$1 LIMIT 1
 ) e ON true
 LEFT JOIN public.projects pr ON pr.company_id=$1 AND pr.id=c.project_id CROSS JOIN moment
), enriched AS MATERIALIZED (
 SELECT c.*,
 (SELECT count(*)::int FROM offers o WHERE o.need_id=c.need_id AND o.status='OPEN') AS open_count,
 (SELECT count(*)::int FROM offers o WHERE o.need_id=c.need_id AND o.review_eligibility='ELIGIBLE') AS eligible_count,
 jsonb_build_object('id',c.duty_id,'dutyDate',to_char(c.duty_date,'YYYY-MM-DD'),
  'shiftKind',CASE c.shift_kind WHEN 'TAG' THEN 'DAY' WHEN 'NACHT' THEN 'NIGHT' END,
  'startsAt',to_char(c.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'endsAt',to_char(c.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')) AS duty,
 jsonb_build_object('id',c.requester_id,'employeeCode',c.employee_number,'firstName',c.first_name,'lastName',c.last_name) AS employee,
 jsonb_build_object('id',c.project_id,'name',c.project_name) AS project
 FROM cases c
), diagnostics AS MATERIALIZED (
 SELECT EXISTS(SELECT 1 FROM cases WHERE NOT valid) OR EXISTS(SELECT 1 FROM offers WHERE NOT related)
 OR EXISTS(SELECT 1 FROM offers o JOIN cases c ON c.need_id=o.need_id
   WHERE (o.status='OPEN' AND c.need_status IN ('CLOSED','RESOLVED'))
      OR (o.status='SELECTED' AND c.need_status<>'RESOLVED')) AS invalid
), stamp AS (SELECT to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS value FROM moment)`;

const cancellation = `jsonb_build_object('id',c.request_id,'assignmentId',c.assignment_id,'employee',c.employee,'duty',c.duty,
 'status',c.request_status,'createdAt',to_char(c.request_created AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'decidedAt',to_char(c.decided_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'replacementNeed',jsonb_build_object('id',c.need_id,'status',c.need_status,'resolvedAt',to_char(c.resolved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) `;
const need = `jsonb_build_object('id',c.need_id,'cancellationRequestId',c.request_id,'duty',c.duty,'status',c.need_status,
 'resolvedAt',to_char(c.resolved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'openOfferCount',c.open_count,'project',c.project,'timeZone',c.time_zone)`;

/** Sort fragments are fixed literals selected by validated values. */
export function queueSql(sortBy: 'createdAt' | 'dutyDate', sortOrder: 'asc' | 'desc'): string {
 const direction = sortOrder === 'asc' ? 'ASC' : 'DESC';
 const order = sortBy === 'createdAt'
   ? `queue_created ${direction}, row_id ASC, kind ASC`
   : `duty_date ${direction}, starts_at ASC, row_id ASC, kind ASC`;
 return `${core}, actionable AS MATERIALIZED (
 SELECT c.*,CASE WHEN request_status='OPEN' THEN 'CANCELLATION_REQUEST' ELSE 'REPLACEMENT_NEED' END AS kind,
 CASE WHEN request_status='OPEN' THEN request_id ELSE need_id END AS row_id,
 CASE WHEN request_status='OPEN' THEN request_created ELSE need_created END AS queue_created
 FROM enriched c WHERE valid AND ((request_status='OPEN' AND need_status='OPEN') OR
 (request_status='APPROVED' AND need_status='OPEN_UNFILLED' AND NOT duty_removed))
), filtered AS MATERIALIZED (
 SELECT * FROM actionable WHERE ($4::uuid IS NULL OR project_id=$4) AND ($5::date IS NULL OR planning_month=$5)
 AND ($6::text IS NULL OR kind=$6) AND ($7::text IS NULL OR ($7='WITH_ELIGIBLE' AND eligible_count>0) OR ($7='WITHOUT_ELIGIBLE' AND eligible_count=0))
), page AS (SELECT * FROM filtered ORDER BY ${order} LIMIT $8 OFFSET $9)
 SELECT (SELECT invalid FROM diagnostics) AS invalid,
 ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM public.projects WHERE company_id=$1 AND id=$4)) AS project_visible,
 (SELECT count(*)::int FROM filtered) AS total,(SELECT value FROM stamp) AS evaluated_at,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('type',kind,'cancellationRequestId',request_id,'replacementNeedId',need_id,
 'duty',duty,'requestingEmployee',employee,'cancellationStatus',request_status,'replacementNeedStatus',need_status,
 'openOfferCount',open_count,'eligibleOpenOfferCount',eligible_count,'project',project,'monthStart',to_char(planning_month,'YYYY-MM-DD'),
 'timeZone',time_zone,'createdAt',to_char(queue_created AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY ${order}) FROM page),'[]'::jsonb) AS items`;
}

export const detailSql = `${core}, selected AS MATERIALIZED (SELECT * FROM enriched),
filtered_offers AS MATERIALIZED (SELECT * FROM offers WHERE ($4::text IS NULL OR status=$4)),
page AS (SELECT * FROM filtered_offers ORDER BY created_at,id LIMIT $5 OFFSET $6)
SELECT (SELECT invalid FROM diagnostics) AS invalid,(SELECT count(*)::int FROM selected) AS found,
 (SELECT count(*)::int FROM filtered_offers) AS total,
 (SELECT jsonb_build_object('cancellation',${cancellation},'need',${need},
 'monthStart',to_char(c.planning_month,'YYYY-MM-DD'),'dutyRemoved',c.duty_removed,
 'originalAssignmentActive',c.original_active,'eligibleOpenOfferCount',c.eligible_count,
 'evaluatedAt',(SELECT value FROM stamp)) FROM selected c) AS context,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'needId',need_id,
 'employee',jsonb_build_object('id',employee_id,'employeeCode',employee_number,'firstName',first_name,'lastName',last_name),
 'status',status,'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'decidedAt',to_char(decided_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'reviewEligibility',review_eligibility) ORDER BY created_at,id) FROM page),'[]'::jsonb) AS items`;
