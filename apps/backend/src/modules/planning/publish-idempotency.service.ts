/**
 * Phase 8.7 claim / business-commit protocol, restricted to INITIAL_PUBLISH.
 * A short committed claim survives a crash before business work. Its attempt ID
 * fences an old claimant after recovery. The same nonwaiting I advisory lock is
 * held through the business transaction; recovery can never steal a live writer,
 * even when its claimed_at exceeds the stale threshold. Its row lock is taken
 * before E/P/M/L/D and retained through atomic completion. No raw key is stored.
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../../auth/authorization/tenant-context.js';
import { DatabaseService } from '../../database/database.service.js';
import { lockAccountsPrefix } from '../identity/account-prefix-lock.js';
import { toMonthlyPlanResponse, type MonthlyPlanRow } from './monthly-plan.mapper.js';
import type { MonthlyPlanResponse } from './monthly-plan.types.js';
import { PLANNING_WRITER_TIMEOUTS } from './planning-locks.js';
import { assertSessionInTransaction } from '../../auth/session.service.js';
import { reservationLock, lockAttempt } from './idempotency-lock.js';
import { reserveCommand } from './command-reservation.js';

const OPERATION = 'INITIAL_PUBLISH';
const digest = (value: string) => createHash('sha256').update(value).digest();

function seconds(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > 2_147_483_647) {
    throw new Error('Invalid publish idempotency configuration');
  }
  return Number(raw);
}
export function publishIdempotencySettings() {
  return {
    retention: seconds('SECUREPLAN_PUBLISH_IDEMPOTENCY_RETENTION_SECONDS', 86_400),
    stale: seconds('SECUREPLAN_PUBLISH_IDEMPOTENCY_STALE_SECONDS', 300),
  };
}
type Visible = (client: PoolClient) => Promise<MonthlyPlanRow>;

@Injectable()
export class PublishIdempotencyService implements OnModuleInit {
  constructor(private readonly database: DatabaseService) {}
  onModuleInit(): void { publishIdempotencySettings(); }

  async execute(tenant: TenantContext, planId: string, key: string, visible: Visible,
    publish: (client: PoolClient) => Promise<MonthlyPlanResponse>,
  ): Promise<{ result: MonthlyPlanResponse; replayed: boolean }> {
    const { retention, stale } = publishIdempotencySettings();
    const keyHash = digest(key);
    const requestHash = digest(JSON.stringify(['initial-publish-v1', planId.toLowerCase()]));
    const scope = [tenant.companyId, tenant.accountId, OPERATION, keyHash] as const;
    // Nonwaiting lock also covers the absent reservation slot. Hash collisions
    // can only cause a temporary in-progress refusal, never cross-scope replay.
    const lockId = digest(JSON.stringify(['publish-reservation-v1', ...scope.slice(0, 3), keyHash.toString('hex')])).readBigInt64BE().toString();
    const reserveLock = async (client: PoolClient) => {
      await reservationLock(client, lockId);
    };
    const enter = async (client: PoolClient) => {
      await client.query(PLANNING_WRITER_TIMEOUTS);
      await lockAccountsPrefix(client, tenant, ['COMPANY_ADMIN']);
      await assertSessionInTransaction(client, tenant);
      return visible(client); // schema/tenant/project concealment before replay
    };

    const claimed = await this.database.withTransaction(async (client) => {
      const plan = await enter(client);
      return reserveCommand(client, {
        tenant, operation: OPERATION, keyHash, requestHash, lockId, retention, stale,
        replay: async (prior) => {
          await assertSessionInTransaction(client, tenant);
          if (prior.result_plan_id !== plan.id || plan.status !== 'PUBLISHED' || plan.published_at === null) {
            throw new Error('Inconsistent completed publish result');
          }
          return toMonthlyPlanResponse(plan);
        },
      });
    });
    if ('result' in claimed) return claimed;
    const claim = claimed.claim;
    try {
      return await this.database.withTransaction(async (client) => {
        await enter(client);
        await reserveLock(client);
        await lockAttempt(client, tenant.companyId, tenant.accountId, OPERATION, keyHash, claim.id, claim.attempt_id);
        const result = await publish(client);
        const completed = await client.query(
          `WITH moment AS (SELECT clock_timestamp() AS at)
           UPDATE public.idempotency_records SET state = 'COMPLETED', result_plan_id = $4,
             completed_at = moment.at, expires_at = moment.at + $5::int * INTERVAL '1 second'
           FROM moment WHERE company_id = $1 AND id = $2 AND attempt_id = $3 AND state = 'IN_PROGRESS'`,
          [tenant.companyId, claim.id, claim.attempt_id, result.id, retention],
        );
        if (completed.rowCount !== 1) throw new Error('Publish completion lost its reservation');
        return { result, replayed: false };
      });
    } catch (error) {
      // Separate recovery marker only. A lost COMMIT acknowledgement must never
      // overwrite COMPLETED. Failure to mark leaves a recoverable IN_PROGRESS.
      await this.database.withTransaction(async (client) => {
        await client.query(PLANNING_WRITER_TIMEOUTS);
        await lockAccountsPrefix(client, tenant, ['COMPANY_ADMIN']);
        await reserveLock(client);
        await client.query(
          `UPDATE public.idempotency_records SET state = 'FAILED'
           WHERE company_id = $1 AND actor_account_id = $2 AND id = $3 AND attempt_id = $4 AND state = 'IN_PROGRESS'`,
          [tenant.companyId, tenant.accountId, claim.id, claim.attempt_id],
        );
      }).catch(() => {});
      throw error;
    }
  }
}
