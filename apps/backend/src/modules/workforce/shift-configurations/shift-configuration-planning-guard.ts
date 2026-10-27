/**
 * SP-08b TEMPORARY planning guard for shift-configuration changes (ADR-0003, O-8).
 *
 * A changed shift configuration must never silently contradict existing
 * monthly plans or duties. Those tables do not exist before SP-11, but their
 * absence is NOT treated as proof that a change is safe: the moment any of them
 * exists, every effective change fails closed (409 SHIFT_CONFIGURATION_CONFLICT)
 * until SP-11 replaces this guard with the real project/month dependency check
 * (docs/datenbank/shift-configuration-sp11-handoff.md). GET and true no-op
 * PATCHes never reach this guard.
 *
 * Deliberately conservative: both the plural (physical design) and the singular
 * (logical design) table names count. The SP-09 guard is intentionally separate
 * and unchanged.
 */
import { ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';

type Queryable = Pick<PoolClient, 'query'>;

export const SHIFT_GUARD_PLANNING_TABLES = [
  'monthly_plans',
  'monthly_plan',
  'duties',
  'duty',
  'plan_assignments',
  'plan_assignment',
  'duty_assignments',
  'duty_assignment',
] as const;

export async function assertShiftConfigurationPlanningCheckImplemented(client: Queryable): Promise<void> {
  const present = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n
     FROM unnest($1::text[]) AS t(name)
     WHERE to_regclass('public.' || t.name) IS NOT NULL`,
    [[...SHIFT_GUARD_PLANNING_TABLES]],
  );
  if (present.rows[0].n > 0) {
    throw new ConflictException({ code: 'SHIFT_CONFIGURATION_CONFLICT' });
  }
}
