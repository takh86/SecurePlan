/** Read-only pre-rollout inventory. Explicit connection only; no guessed policy or cleanup. */
import pg from 'pg';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
try {
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const result = await client.query(`WITH facts AS (
    SELECT d.company_id, d.project_id, d.planning_month,
      CASE WHEN c.id IS NULL THEN 'MISSING' ELSE 'CLOSED' END AS violation
    FROM public.duties d LEFT JOIN LATERAL (
      SELECT id, weekday_mask FROM public.project_operating_calendars
      WHERE company_id = d.company_id AND project_id = d.project_id AND effective_from_month <= d.planning_month
      ORDER BY effective_from_month DESC LIMIT 1
    ) c ON true WHERE d.removed_at IS NULL AND (c.id IS NULL OR
      (c.weekday_mask::int & (1 << (extract(isodow FROM d.duty_date)::int - 1))) = 0)
    UNION ALL
    SELECT d.company_id, d.project_id, d.planning_month, 'DUAL_ASSIGNMENT' FROM public.duties d
    JOIN public.plan_assignments pa ON pa.company_id = d.company_id AND pa.duty_id = d.id
    WHERE d.removed_at IS NULL AND pa.state = 'ACTIVE'
    GROUP BY d.company_id, d.project_id, d.planning_month, d.duty_date, pa.employee_id
    HAVING count(DISTINCT d.shift_kind) > 1
  ) SELECT company_id, project_id, to_char(planning_month, 'YYYY-MM-DD') AS month, violation, count(*)::int AS count
    FROM facts GROUP BY company_id, project_id, planning_month, violation ORDER BY company_id, project_id, month, violation`);
  // Include projects without duties: an empty findings list alone does not mean
  // that creation or First Publish is ready. Historical empty plans also need coverage.
  const projects = await client.query(`SELECT p.company_id, p.id AS project_id, p.status,
    to_char(date_trunc('month', clock_timestamp() AT TIME ZONE c.time_zone), 'YYYY-MM-DD') AS current_month,
    (SELECT to_char(min(d.planning_month), 'YYYY-MM-DD') FROM duties d
      WHERE d.company_id = p.company_id AND d.project_id = p.id AND d.removed_at IS NULL) AS earliest_live_duty_month,
    (SELECT count(*)::int FROM project_operating_calendars v
      WHERE v.company_id = p.company_id AND v.project_id = p.id) AS calendar_versions,
    ARRAY(SELECT to_char(m.planning_month, 'YYYY-MM-DD') FROM monthly_plans m
      WHERE m.company_id = p.company_id AND m.project_id = p.id AND NOT EXISTS (
        SELECT 1 FROM project_operating_calendars v WHERE v.company_id = p.company_id
          AND v.project_id = p.id AND v.effective_from_month <= m.planning_month)
      ORDER BY m.planning_month) AS missing_plan_months
    FROM projects p JOIN companies c ON c.id = p.company_id ORDER BY p.company_id, p.id`);
  await client.query('COMMIT');
  console.log(JSON.stringify({ kind: 'project-calendar-legacy-inventory', findings: result.rows, projects: projects.rows }, null, 2));
} catch {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Read-only project calendar inventory failed.'); process.exitCode = 1;
} finally { await client.end(); }
