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
 * The table names are classified centrally (planning-table-classification.ts)
 * and shared with the SP-09 guard, so the two guards cannot diverge again.
 */
import { ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { countPlanningRelations } from '../planning-guard/planning-table-classification.js';

type Queryable = Pick<PoolClient, 'query'>;

export async function assertShiftConfigurationPlanningCheckImplemented(client: Queryable): Promise<void> {
  if (await countPlanningRelations(client) > 0) {
    throw new ConflictException({ code: 'SHIFT_CONFIGURATION_CONFLICT' });
  }
}
