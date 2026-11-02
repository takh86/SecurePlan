/**
 * Planning public contract for workforce writers (SP11A-R1 T3/T4, PO D2-D5).
 *
 * Each predicate:
 * - runs on the caller's transaction client AFTER the caller's own LOCK-01-L1
 *   parent locks (employee, project, monthly assignment) have been acquired.
 *   It is a NEW statement, so READ COMMITTED sees every dependency committed by
 *   a writer the caller waited for. Never fold it into the locking statement;
 * - first validates the planning schema signature (ABSENT/INVALID fail closed);
 * - takes no row locks on planning rows: every dependency-changing planning
 *   writer holds a conflicting parent lock, so a plain read is sufficient;
 * - filters by the trusted company on every relation.
 *
 * "Live" = duty not tombstoned (removed_at IS NULL) and membership ACTIVE. Both
 * plan states (UNPUBLISHED and PUBLISHED) count; retained removed rows never do.
 * "Unresolved future" (C7) = live and ends_at > evaluatedAt, which includes
 * in-progress shifts and an overnight shift that started yesterday; at
 * ends_at = evaluatedAt the duty has finished. evaluatedAt is one clock read
 * taken by the caller after all of its lock waits.
 */
import type { PoolClient } from 'pg';
import { assertPlanningSchemaComplete } from './planning-schema.js';

type Queryable = Pick<PoolClient, 'query'>;

/** Employee/project/month tuple of a monthly project assignment (monthStart = YYYY-MM-01). */
export type AssignmentTuple = Readonly<{ employeeId: string; projectId: string; monthStart: string }>;

/** Employment period as stored (YYYY-MM-DD or null). */
export type EmploymentPeriod = Readonly<{ employment_start: string | null; employment_end: string | null }>;

async function exists(client: Queryable, sql: string, values: unknown[]): Promise<boolean> {
  const result = await client.query<{ found: boolean }>(`SELECT EXISTS (${sql}) AS found`, values);
  return result.rows[0].found === true;
}

/**
 * D2: does a live membership depend on this employee/project/month tuple?
 * Callers pass the old tuple and, for a PATCH, the resulting tuple; each is
 * checked on its own (a match must agree on all three members).
 */
export async function hasLiveAssignmentDependency(
  client: Queryable,
  companyId: string,
  tuples: readonly AssignmentTuple[],
): Promise<boolean> {
  await assertPlanningSchemaComplete(client);
  for (const tuple of tuples) {
    const found = await exists(
      client,
      `SELECT 1
       FROM plan_assignments AS pa
       JOIN duties AS d ON d.company_id = pa.company_id AND d.id = pa.duty_id
       WHERE pa.company_id = $1 AND pa.employee_id = $2 AND pa.state = 'ACTIVE'
         AND d.removed_at IS NULL AND d.project_id = $3 AND d.planning_month = $4::date`,
      [companyId, tuple.employeeId, tuple.projectId, tuple.monthStart],
    );
    if (found) return true;
  }
  return false;
}

/**
 * D3: does a live saved duty of the project (staffed or empty) lie in the
 * effective interval [month, next later effective month of the project)? An
 * open end applies when no later version exists. The caller holds the project
 * NO KEY UPDATE lock, which also serializes every configuration version writer.
 */
export async function hasLiveDutiesInConfigurationInterval(
  client: Queryable,
  companyId: string,
  projectId: string,
  month: string,
): Promise<boolean> {
  await assertPlanningSchemaComplete(client);
  return exists(
    client,
    `SELECT 1
     FROM duties AS d
     WHERE d.company_id = $1 AND d.project_id = $2 AND d.removed_at IS NULL
       AND d.duty_date >= $3::date
       AND d.duty_date < coalesce(
         (SELECT min(sc.effective_from_month) FROM shift_configurations AS sc
          WHERE sc.company_id = $1 AND sc.project_id = $2 AND sc.effective_from_month > $3::date),
         'infinity'::date)`,
    [companyId, projectId, month],
  );
}

/** D4: unresolved future duties (empty ones included) of the project. */
export async function hasUnresolvedFutureDuties(
  client: Queryable,
  companyId: string,
  projectId: string,
  evaluatedAt: string,
): Promise<boolean> {
  await assertPlanningSchemaComplete(client);
  return exists(
    client,
    `SELECT 1 FROM duties AS d
     WHERE d.company_id = $1 AND d.project_id = $2 AND d.removed_at IS NULL
       AND d.ends_at > $3::timestamptz`,
    [companyId, projectId, evaluatedAt],
  );
}

/**
 * D5: would the employment change NEWLY exclude a live future membership?
 * covered(period, duty_date) is the inclusive per-day rule on the duty's local
 * start date (null end = open; null start = no evidence). Duties already
 * uncovered before the change never block an unrelated correction.
 */
export async function hasNewlyExcludedFutureDuties(
  client: Queryable,
  companyId: string,
  employeeId: string,
  evaluatedAt: string,
  before: EmploymentPeriod,
  next: EmploymentPeriod,
): Promise<boolean> {
  await assertPlanningSchemaComplete(client);
  return exists(
    client,
    `SELECT 1
     FROM plan_assignments AS pa
     JOIN duties AS d ON d.company_id = pa.company_id AND d.id = pa.duty_id
     WHERE pa.company_id = $1 AND pa.employee_id = $2 AND pa.state = 'ACTIVE'
       AND d.removed_at IS NULL AND d.ends_at > $3::timestamptz
       AND $4::date IS NOT NULL AND $4::date <= d.duty_date
       AND ($5::date IS NULL OR $5::date >= d.duty_date)
       AND NOT ($6::date IS NOT NULL AND $6::date <= d.duty_date
                AND ($7::date IS NULL OR $7::date >= d.duty_date))`,
    [companyId, employeeId, evaluatedAt, before.employment_start, before.employment_end,
      next.employment_start, next.employment_end],
  );
}

/** Employee deactivation (separate rule, D-8.4-11): any live future membership blocks. */
export async function hasFutureDutyMemberships(
  client: Queryable,
  companyId: string,
  employeeId: string,
  evaluatedAt: string,
): Promise<boolean> {
  await assertPlanningSchemaComplete(client);
  return exists(
    client,
    `SELECT 1
     FROM plan_assignments AS pa
     JOIN duties AS d ON d.company_id = pa.company_id AND d.id = pa.duty_id
     WHERE pa.company_id = $1 AND pa.employee_id = $2 AND pa.state = 'ACTIVE'
       AND d.removed_at IS NULL AND d.ends_at > $3::timestamptz`,
    [companyId, employeeId, evaluatedAt],
  );
}
