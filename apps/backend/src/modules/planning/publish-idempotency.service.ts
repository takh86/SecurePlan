/**
 * Phase 8.7 claim / business-commit protocol, restricted to INITIAL_PUBLISH.
 * A short committed claim survives a crash before business work. Its attempt ID
 * fences an old claimant after recovery. The same nonwaiting I advisory lock is
 * held through the business transaction; recovery can never steal a live writer,
 * even when its claimed_at exceeds the stale threshold. Its row lock is taken
 * before E/P/M/L/D and retained through atomic completion. No raw key is stored.
 */
import { ConflictException, Injectable, type OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../../auth/authorization/tenant-context.js';
import { DatabaseService } from '../../database/database.service.js';
import { lockAccountsPrefix } from '../identity/account-prefix-lock.js';
import { toMonthlyPlanResponse, type MonthlyPlanRow } from './monthly-plan.mapper.js';
import type { MonthlyPlanResponse } from './monthly-plan.types.js';
import { PLANNING_WRITER_TIMEOUTS } from './planning-locks.js';
import { assertSessionInTransaction } from '../../auth/session.service.js';

const OPERATION = 'INITIAL_PUBLISH';
const digest = (value: string) => createHash('sha256').update(value).digest();
const inProgress = (): never => { throw new ConflictException({ code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS' }); };

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
type Reservation = { id: string; attempt_id: string; state: string; request_hash: Buffer;
  result_plan_id: string | null; unexpired: boolean; stale: boolean };
type Claim = { id: string; attempt_id: string };
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
      const { rows: [row] } = await client.query<{ held: boolean }>('SELECT pg_try_advisory_xact_lock($1::bigint) AS held', [lockId]);
      if (!row.held) inProgress();
    };
    const enter = async (client: PoolClient) => {
      await client.query(PLANNING_WRITER_TIMEOUTS);
      await lockAccountsPrefix(client, tenant, ['COMPANY_ADMIN']);
      await assertSessionInTransaction(client, tenant);
      return visible(client); // schema/tenant/project concealment before replay
    };

    const claimed = await this.database.withTransaction<{ claim: Claim } | { result: MonthlyPlanResponse; replayed: true }>(async (client) => {
      const plan = await enter(client);
      await reserveLock(client);
      const prior = (await client.query<Reservation>(
        `SELECT id, attempt_id, state, request_hash, result_plan_id,
          expires_at > clock_timestamp() AS unexpired,
          claimed_at <= clock_timestamp() - $5::int * INTERVAL '1 second' AS stale
         FROM public.idempotency_records
         WHERE company_id = $1 AND actor_account_id = $2 AND operation = $3 AND key_hash = $4 FOR UPDATE`,
        [...scope, stale],
      )).rows[0];
      if (prior) {
        if (prior.unexpired && !prior.request_hash.equals(requestHash)) {
          throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST' });
        }
        if (prior.state === 'COMPLETED' && prior.unexpired) {
          await assertSessionInTransaction(client, tenant);
          if (prior.result_plan_id !== plan.id || plan.status !== 'PUBLISHED' || plan.published_at === null) {
            throw new Error('Inconsistent completed publish result');
          }
          return { result: toMonthlyPlanResponse(plan), replayed: true as const };
        }
        // Age alone never proves abandonment. reserveLock proved no executing
        // transaction still holds I. FAILED was marked only after rollback;
        // every recovered attempt still revalidates lifecycle before any write.
        if (prior.state === 'IN_PROGRESS' && !prior.stale) inProgress();
        const reset = await client.query<Claim>(
          `WITH moment AS (SELECT clock_timestamp() AS at)
           UPDATE public.idempotency_records SET attempt_id = gen_random_uuid(), state = 'IN_PROGRESS',
             request_hash = $3, result_plan_id = NULL, completed_at = NULL, claimed_at = moment.at,
             expires_at = moment.at + $4::int * INTERVAL '1 second'
           FROM moment WHERE company_id = $1 AND id = $2 RETURNING id, attempt_id`,
          [tenant.companyId, prior.id, requestHash, retention],
        );
        return { claim: reset.rows[0] };
      }
      const inserted = await client.query<Claim>(
        `WITH moment AS (SELECT clock_timestamp() AS at)
         INSERT INTO public.idempotency_records (company_id, actor_account_id, operation, key_hash, request_hash, created_at, claimed_at, expires_at)
         SELECT $1, $2, $3, $4, $5, at, at, at + $6::int * INTERVAL '1 second' FROM moment RETURNING id, attempt_id`,
        [...scope, requestHash, retention],
      );
      return { claim: inserted.rows[0] };
    });
    if ('result' in claimed) return claimed;
    const claim = claimed.claim;
    try {
      return await this.database.withTransaction(async (client) => {
        await enter(client);
        await reserveLock(client);
        const locked = await client.query<Claim>(
          `SELECT id, attempt_id FROM public.idempotency_records
           WHERE company_id = $1 AND actor_account_id = $2 AND operation = $3 AND key_hash = $4
             AND id = $5 AND attempt_id = $6 AND state = 'IN_PROGRESS' FOR UPDATE`,
          [...scope, claim.id, claim.attempt_id],
        );
        if (locked.rowCount !== 1) inProgress();
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
