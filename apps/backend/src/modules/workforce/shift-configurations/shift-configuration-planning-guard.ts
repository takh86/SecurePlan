/**
 * SP-08b planning guard for shift-configuration changes (ADR-0003 O-8, PO D3).
 *
 * SP-11 replaced the temporary fail-closed guard with the real dependency
 * check (SP11A-R1 T3): an effective replacement of the version of month M is
 * refused with 409 SHIFT_CONFIGURATION_CONFLICT when a live saved duty of the
 * project (UNPUBLISHED or PUBLISHED plan, staffed or empty) lies in
 * [M, next later effective month), regardless of shift kind. Stored duty
 * snapshots are never recalculated.
 *
 * Call only after the project NO KEY UPDATE lock and the no-op return (GET and
 * true no-op PATCHes never reach it). An absent, partial or altered planning
 * schema fails closed with a sanitized 500 (planning-schema.ts).
 */
import { ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { hasLiveDutiesInConfigurationInterval } from '../../planning/planning-dependencies.js';

type Queryable = Pick<PoolClient, 'query'>;

export async function assertNoSavedDutiesForConfiguration(
  client: Queryable,
  companyId: string,
  projectId: string,
  month: string,
): Promise<void> {
  if (await hasLiveDutiesInConfigurationInterval(client, companyId, projectId, month)) {
    throw new ConflictException({ code: 'SHIFT_CONFIGURATION_CONFLICT' });
  }
}
