/**
 * SP-09 correction/removal guard for planning data (Phase 8.4 D-8.4-13, PO D2).
 *
 * SP-11 replaced the temporary fail-closed guard with the real dependency
 * check (SP11A-R1 T3): an effective monthly PATCH or future DELETE is refused
 * with 409 PROJECT_ASSIGNMENT_CORRECTION_CONFLICT when a live membership of an
 * UNPUBLISHED or PUBLISHED plan depends on the old tuple or (PATCH) on the
 * resulting tuple. Nothing is auto-moved, removed or reassigned.
 *
 * Call only after the caller holds its employee (NO KEY UPDATE), project
 * (SHARE) and assignment-row (UPDATE) locks, after the no-op return and the
 * historical/version/month checks. An absent, partial or altered planning
 * schema fails closed with a sanitized 500 (planning-schema.ts), never with
 * this business 409.
 */
import { ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { hasLiveAssignmentDependency, type AssignmentTuple } from '../../planning/planning-dependencies.js';

type Queryable = Pick<PoolClient, 'query'>;

export async function assertNoPlanningDependency(
  client: Queryable,
  companyId: string,
  tuples: readonly AssignmentTuple[],
): Promise<void> {
  if (await hasLiveAssignmentDependency(client, companyId, tuples)) {
    throw new ConflictException({ code: 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT' });
  }
}
