import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../../auth/authorization/tenant-context.js';
import { assertSessionInTransaction } from '../../auth/session.service.js';
import { DatabaseService } from '../../database/database.service.js';
import { lockAccountsPrefix } from '../identity/account-prefix-lock.js';
import {
  decodeSaveResult,
  requestFingerprint,
  type SaveEmployeeMonth,
  type SaveResult,
} from './employee-month.contract.js';
import { visibleMonth } from './employee-month.store.js';
import {
  lockAttempt,
  reservationLock,
  tryReservationLock,
} from './idempotency-lock.js';
import { PLANNING_WRITER_TIMEOUTS } from './planning-locks.js';
import { assertPlanningSchemaComplete } from './planning-schema.js';
import { publishIdempotencySettings } from './publish-idempotency.service.js';
import { assertEmployeeMonthReceiptSchema } from './employee-month-receipt-schema.js';

const OP = 'EMPLOYEE_MONTH_SAVE';
const digest = (s: string) => createHash('sha256').update(s).digest();
function reservationId(t: TenantContext, keyHash: Buffer): string {
  return digest(
    JSON.stringify([
      'employee-month-reservation-v2',
      t.companyId,
      t.accountId,
      OP,
      keyHash.toString('hex'),
    ]),
  )
    .readBigInt64BE()
    .toString();
}
type Claim = { id: string; attempt_id: string };
type RecordRow = Claim & {
  state: string;
  request_hash: Buffer;
  context_plan_id: string;
  context_employee_id: string;
  result_json: unknown;
  result_schema_version: number | null;
  unexpired: boolean;
  stale: boolean;
};
@Injectable()
export class EmployeeMonthIdempotencyService {
  constructor(private readonly database: DatabaseService) {}
  private scope(t: TenantContext, key: string) {
    const keyHash = digest(key);
    const lockId = reservationId(t, keyHash);
    return {
      keyHash,
      lockId,
      values: [t.companyId, t.accountId, OP, keyHash] as const,
    };
  }
  private async enter(
    c: PoolClient,
    t: TenantContext,
    planId: string,
    employeeId: string,
  ) {
    await c.query(PLANNING_WRITER_TIMEOUTS);
    await lockAccountsPrefix(c, t, ['COMPANY_ADMIN']);
    await assertSessionInTransaction(c, t);
    await assertPlanningSchemaComplete(c);
    await assertEmployeeMonthReceiptSchema(c);
    return visibleMonth(c, t, planId, employeeId);
  }
  private async currentProject(
    c: PoolClient,
    t: TenantContext,
    projectId: string,
    planId: string,
    employeeId: string,
  ) {
    await c.query(
      'SELECT id FROM public.projects WHERE company_id=$1 AND id=$2 FOR SHARE',
      [t.companyId, projectId],
    );
    await assertSessionInTransaction(c, t);
    return visibleMonth(c, t, planId, employeeId);
  }
  async execute(
    t: TenantContext,
    planId: string,
    employeeId: string,
    key: string,
    dto: SaveEmployeeMonth,
    mutate: (c: PoolClient) => Promise<SaveResult>,
  ): Promise<{ result: SaveResult; replayed: boolean }> {
    const s = this.scope(t, key),
      requestHash = Buffer.from(
        requestFingerprint(planId, employeeId, dto),
        'hex',
      );
    const { retention, stale } = publishIdempotencySettings();
    const reserved = await this.database.withTransaction<
      { claim: Claim } | { result: SaveResult; replayed: true }
    >(async (c) => {
      const plan = await this.enter(c, t, planId, employeeId);
      await reservationLock(c, s.lockId);
      const prior = (
        await c.query<RecordRow>(
          `SELECT *, expires_at>clock_timestamp() AS unexpired,
        claimed_at<=clock_timestamp()-$5::int*interval '1 second' AS stale FROM public.idempotency_records
        WHERE company_id=$1 AND actor_account_id=$2 AND operation=$3 AND key_hash=$4 FOR UPDATE`,
          [...s.values, stale],
        )
      ).rows[0];
      if (prior?.unexpired && !prior.request_hash.equals(requestHash))
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
        });
      if (prior?.unexpired && prior.state === 'COMPLETED') {
        await this.currentProject(c, t, plan.project_id, planId, employeeId);
        if (
          prior.context_plan_id !== planId ||
          prior.context_employee_id !== employeeId ||
          prior.result_schema_version !== 2
        )
          throw new Error('Invalid receipt context');
        return {
          result: decodeSaveResult(prior.result_json, planId, employeeId),
          replayed: true,
        };
      }
      if (prior?.state === 'IN_PROGRESS' && !prior.stale)
        throw new ConflictException({
          code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS',
        });
      // Full context-FK prefix, BEFORE insertion/reset. No implicit late E lock.
      await c.query(
        'SELECT id FROM public.employees WHERE company_id=$1 AND id=$2 FOR NO KEY UPDATE',
        [t.companyId, employeeId],
      );
      await this.currentProject(c, t, plan.project_id, planId, employeeId);
      await c.query(
        'SELECT id FROM public.monthly_plans WHERE company_id=$1 AND id=$2 FOR KEY SHARE',
        [t.companyId, planId],
      );
      await assertSessionInTransaction(c, t);
      if (prior) {
        const r = await c.query<Claim>(
          `WITH moment AS (SELECT clock_timestamp() AS at)
          UPDATE public.idempotency_records SET attempt_id=gen_random_uuid(),state='IN_PROGRESS',request_hash=$3,
          context_plan_id=$4,context_employee_id=$5,result_plan_id=NULL,result_json=NULL,result_schema_version=NULL,
          completed_at=NULL,claimed_at=at,expires_at=at+$6::int*interval '1 second' FROM moment
          WHERE company_id=$1 AND id=$2 RETURNING id,attempt_id`,
          [t.companyId, prior.id, requestHash, planId, employeeId, retention],
        );
        return { claim: r.rows[0] };
      }
      const r = await c.query<Claim>(
        `WITH moment AS (SELECT clock_timestamp() AS at)
        INSERT INTO public.idempotency_records(company_id,actor_account_id,operation,key_hash,request_hash,
          context_plan_id,context_employee_id,created_at,claimed_at,expires_at)
        SELECT $1,$2,$3,$4,$5,$6,$7,at,at,at+$8::int*interval '1 second' FROM moment RETURNING id,attempt_id`,
        [...s.values, requestHash, planId, employeeId, retention],
      );
      return { claim: r.rows[0] };
    });
    if ('result' in reserved) return reserved;
    const claim = reserved.claim;
    try {
      return await this.database.withTransaction(async (c) => {
        await this.enter(c, t, planId, employeeId);
        await reservationLock(c, s.lockId);
        await lockAttempt(
          c,
          t.companyId,
          t.accountId,
          OP,
          s.keyHash,
          claim.id,
          claim.attempt_id,
        );
        const result = decodeSaveResult(await mutate(c), planId, employeeId);
        const completed = await c.query(
          `UPDATE public.idempotency_records SET state='COMPLETED',result_plan_id=$4,
          result_json=$5::jsonb,result_schema_version=2,completed_at=$6::timestamptz,
          expires_at=$6::timestamptz+$7::int*interval '1 second'
          WHERE company_id=$1 AND id=$2 AND attempt_id=$3 AND state='IN_PROGRESS'`,
          [
            t.companyId,
            claim.id,
            claim.attempt_id,
            planId,
            JSON.stringify(result),
            result.completedAt,
            retention,
          ],
        );
        if (completed.rowCount !== 1)
          throw new Error('Employee-month receipt lost its fence');
        return { result, replayed: false };
      });
    } catch (error) {
      // Ambiguous COMMIT may have succeeded. This fence can NEVER overwrite it.
      await this.database
        .withTransaction(async (c) => {
          await c.query(PLANNING_WRITER_TIMEOUTS);
          await lockAccountsPrefix(c, t, ['COMPANY_ADMIN']);
          await reservationLock(c, s.lockId);
          await c.query(
            `UPDATE public.idempotency_records SET state='FAILED'
          WHERE company_id=$1 AND actor_account_id=$2 AND id=$3 AND attempt_id=$4 AND state='IN_PROGRESS'`,
            [t.companyId, t.accountId, claim.id, claim.attempt_id],
          );
        })
        .catch(() => {});
      throw error;
    }
  }
  async lookup(
    t: TenantContext,
    planId: string,
    employeeId: string,
    key: string,
  ) {
    const s = this.scope(t, key);
    return this.database.withTransaction(async (c) => {
      const plan = await this.enter(c, t, planId, employeeId);
      await reservationLock(c, s.lockId);
      await this.currentProject(c, t, plan.project_id, planId, employeeId);
      const r = (
        await c.query<RecordRow>(
          `SELECT *,expires_at>clock_timestamp() AS unexpired FROM public.idempotency_records
        WHERE company_id=$1 AND actor_account_id=$2 AND operation=$3 AND key_hash=$4`,
          [...s.values],
        )
      ).rows[0];
      if (
        r &&
        (r.context_plan_id !== planId || r.context_employee_id !== employeeId)
      )
        throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
      if (!r || !r.unexpired) return { state: 'UNKNOWN' as const };
      if (r.state === 'COMPLETED') {
        if (r.result_schema_version !== 2)
          throw new Error('Invalid receipt version');
        return {
          state: 'COMPLETED' as const,
          result: decodeSaveResult(r.result_json, planId, employeeId),
        };
      }
      if (r.state === 'FAILED') return { state: 'NOT_COMPLETED' as const };
      return { state: 'IN_PROGRESS' as const, retryAfterSeconds: 1 };
    });
  }

  /** Explicit maintenance entry point, current principal's expired records only.
   * No route, startup cleanup or scheduler. I proves a live writer cannot be deleted.
   */
  async pruneExpired(t: TenantContext, limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    return this.database.withTransaction(async (c) => {
      await c.query(PLANNING_WRITER_TIMEOUTS);
      await lockAccountsPrefix(c, t, ['COMPANY_ADMIN']);
      await assertSessionInTransaction(c, t);
      await assertEmployeeMonthReceiptSchema(c);
      const rows = (
        await c.query<{ id: string; key_hash: Buffer }>(
          `SELECT id,key_hash FROM public.idempotency_records
        WHERE company_id=$1 AND actor_account_id=$2 AND operation=$3 AND expires_at<=clock_timestamp()
        ORDER BY expires_at,id LIMIT $4`,
          [t.companyId, t.accountId, OP, limit],
        )
      ).rows;
      let removed = 0;
      for (const row of rows) {
        if (!(await tryReservationLock(c, reservationId(t, row.key_hash))))
          continue;
        const deleted = await c.query(
          `DELETE FROM public.idempotency_records WHERE company_id=$1 AND actor_account_id=$2
          AND operation=$3 AND id=$4 AND expires_at<=clock_timestamp()`,
          [t.companyId, t.accountId, OP, row.id],
        );
        removed += deleted.rowCount ?? 0;
      }
      return removed;
    });
  }
}
