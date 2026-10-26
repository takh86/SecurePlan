/**
 * SP-09 correction guard for planning data (Phase 8.4 D-8.4-13).
 *
 * A correction must never invalidate monthly plans, duties or plan
 * assignments. Those tables do not exist before SP-10/SP-11, but their absence
 * is NOT treated as proof that a correction is safe: the moment any of them
 * exists, corrections fail closed (409 PROJECT_ASSIGNMENT_CORRECTION_CONFLICT)
 * until SP-11 replaces this guard with the real dependency check and its tests.
 */
import { ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';

type Queryable = Pick<PoolClient, 'query'>;

export const PLANNING_TABLES = ['monthly_plans', 'duties', 'plan_assignments'] as const;

export async function assertPlanningDependencyCheckImplemented(client: Queryable): Promise<void> {
  const present = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n
     FROM unnest($1::text[]) AS t(name)
     WHERE to_regclass('public.' || t.name) IS NOT NULL`,
    [[...PLANNING_TABLES]],
  );
  if (present.rows[0].n > 0) {
    throw new ConflictException({ code: 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT' });
  }
}
