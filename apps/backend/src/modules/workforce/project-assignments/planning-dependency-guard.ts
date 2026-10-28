/**
 * SP-09 correction guard for planning data (Phase 8.4 D-8.4-13).
 *
 * A correction must never invalidate monthly plans, duties or plan
 * assignments. Those tables do not exist before SP-10/SP-11, but their absence
 * is NOT treated as proof that a correction is safe: the moment any of them
 * exists, corrections fail closed (409 PROJECT_ASSIGNMENT_CORRECTION_CONFLICT)
 * until SP-11 replaces this guard with the real dependency check and its tests.
 * The table names are classified centrally (planning-table-classification.ts)
 * and shared with the SP-08b guard.
 */
import { ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { countPlanningRelations } from '../planning-guard/planning-table-classification.js';

type Queryable = Pick<PoolClient, 'query'>;

export async function assertPlanningDependencyCheckImplemented(client: Queryable): Promise<void> {
  if (await countPlanningRelations(client) > 0) {
    throw new ConflictException({ code: 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT' });
  }
}
