import { ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { requireRow } from '../../../auth/authorization/require-row.js';
import {
  EMPLOYMENT_PERIOD_CONFLICT, MAX_EMPLOYMENT_CONFLICTS, safeEmploymentPeriodConflict,
} from '../../../common/errors/employment-period-conflict.js';

type Period = { employment_start: string | null; employment_end: string | null };
export type EmploymentPeriodImpact = {
  newlyUncoveredHistoricalAssignmentCount: number;
  evaluatedAt: string;
  companyCurrentMonth: string;
  companyTimeZone: string;
};

function exactCount(value: string): number {
  const count = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(count) || count < 0) {
    throw new Error('Invalid employment impact count');
  }
  return count;
}

/**
 * Call only AFTER the separate employee FOR UPDATE statement has completed.
 * Supported assignment writers hold conflicting employee NO KEY UPDATE locks.
 * A fresh READ COMMITTED statement sees a writer committed during that wait;
 * a CTE containing both the locking read and this scan would use a stale snapshot.
 * No assignment/project locks or writes: arbitrary SQL bypassing the protocol
 * is not protected by this application invariant.
 */
export async function checkEmploymentPeriodImpact(
  client: Pick<PoolClient, 'query'>,
  companyId: string,
  employeeId: string,
  before: Period,
  next: Period,
  evaluatedAt: string,
): Promise<EmploymentPeriodImpact> {
  const company = requireRow(await client.query<{ current_month: string | null; time_zone: string }>(
    `SELECT c.time_zone,
            CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names AS tz WHERE tz.name = c.time_zone)
                 THEN to_char(date_trunc('month', $2::timestamptz AT TIME ZONE c.time_zone), 'YYYY-MM-DD')
                 ELSE NULL END AS current_month
     FROM companies AS c WHERE c.id = $1`,
    [companyId, evaluatedAt],
  ));
  // The actor recheck already holds the company row SHARE until commit.
  if (company.current_month === null) throw new Error('Invalid company IANA time zone');
  const summary = requireRow(await client.query<{
    future_count: string; historical_count: string; conflicts: unknown;
  }>(
    `WITH newly_uncovered AS (
       SELECT pa.id, pa.planning_month
       FROM project_assignments AS pa
       WHERE pa.company_id = $1 AND pa.employee_id = $2
         AND $4::date IS NOT NULL
         AND $4::date <= (pa.planning_month + interval '1 month' - interval '1 day')::date
         AND ($5::date IS NULL OR $5::date >= pa.planning_month)
         AND NOT ($6::date IS NOT NULL
                  AND $6::date <= (pa.planning_month + interval '1 month' - interval '1 day')::date
                  AND ($7::date IS NULL OR $7::date >= pa.planning_month))
     )
     SELECT count(*) FILTER (WHERE planning_month > $3::date)::text AS future_count,
            count(*) FILTER (WHERE planning_month <= $3::date)::text AS historical_count,
            (SELECT coalesce(jsonb_agg(jsonb_build_object(
                       'assignmentId', sample.id,
                       'monthStart', to_char(sample.planning_month, 'YYYY-MM-DD'))
                       ORDER BY sample.planning_month, sample.id), '[]'::jsonb)
             FROM (SELECT id, planning_month FROM newly_uncovered
                   WHERE planning_month > $3::date
                   ORDER BY planning_month, id LIMIT $8) AS sample) AS conflicts
     FROM newly_uncovered`,
    [companyId, employeeId, company.current_month, before.employment_start, before.employment_end,
      next.employment_start, next.employment_end, MAX_EMPLOYMENT_CONFLICTS],
  ));
  const conflictCount = exactCount(summary.future_count);
  const historicalCount = exactCount(summary.historical_count);
  if (conflictCount > 0) {
    const conflict = safeEmploymentPeriodConflict({ conflictCount, conflictingAssignments: summary.conflicts });
    if (conflict === undefined) throw new Error('Invalid employment conflict summary');
    throw new ConflictException({ code: EMPLOYMENT_PERIOD_CONFLICT, ...conflict });
  }
  return {
    newlyUncoveredHistoricalAssignmentCount: historicalCount,
    evaluatedAt,
    companyCurrentMonth: company.current_month,
    companyTimeZone: company.time_zone,
  };
}
