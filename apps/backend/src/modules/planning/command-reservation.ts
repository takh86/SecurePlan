/** Shared durable claim protocol; each operation owns visibility, FK prefix and result codec. */
import { ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../../auth/authorization/tenant-context.js';
import { reservationLock } from './idempotency-lock.js';

export type CommandClaim = { id: string; attempt_id: string };
export type CommandReservation = CommandClaim & {
  state: string;
  request_hash: Buffer;
  result_plan_id: string | null;
  context_plan_id?: string;
  context_employee_id?: string;
  result_json?: unknown;
  result_schema_version?: number | null;
  unexpired: boolean;
  stale: boolean;
};

export async function reserveCommand<Result>(
  c: PoolClient,
  input: {
    tenant: TenantContext;
    operation: string;
    keyHash: Buffer;
    requestHash: Buffer;
    lockId: string;
    retention: number;
    stale: number;
    context?: { planId: string; employeeId: string };
    beforeWrite?: () => Promise<void>;
    replay: (prior: CommandReservation) => Promise<Result>;
  },
): Promise<{ claim: CommandClaim } | { result: Result; replayed: true }> {
  const {
    tenant: t,
    operation,
    keyHash,
    requestHash,
    lockId,
    retention,
    stale,
    context,
  } = input;
  const scope = [t.companyId, t.accountId, operation, keyHash];
  await reservationLock(c, lockId);
  // INITIAL_PUBLISH remains usable with its original 0013 columns and codec.
  const extra = context
    ? ',context_plan_id,context_employee_id,result_json,result_schema_version'
    : '';
  const prior = (
    await c.query<CommandReservation>(
      `SELECT id,attempt_id,state,request_hash,result_plan_id${extra},
    expires_at>clock_timestamp() AS unexpired,claimed_at<=clock_timestamp()-$5::int*interval '1 second' AS stale
    FROM public.idempotency_records WHERE company_id=$1 AND actor_account_id=$2 AND operation=$3 AND key_hash=$4 FOR UPDATE`,
      [...scope, stale],
    )
  ).rows[0];
  if (prior?.unexpired && !prior.request_hash.equals(requestHash))
    throw new ConflictException({
      code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
    });
  if (prior?.state === 'COMPLETED' && prior.unexpired)
    return { result: await input.replay(prior), replayed: true };
  if (prior?.state === 'IN_PROGRESS' && !prior.stale)
    throw new ConflictException({ code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS' });
  // Operation-specific context parents are acquired before implicit FK checks.
  await input.beforeWrite?.();
  if (prior) {
    const fields = context
      ? ',context_plan_id=$5,context_employee_id=$6,result_json=NULL,result_schema_version=NULL'
      : '';
    const r = await c.query<CommandClaim>(
      `WITH moment AS (SELECT clock_timestamp() AS at)
      UPDATE public.idempotency_records SET attempt_id=gen_random_uuid(),state='IN_PROGRESS',request_hash=$3,
      result_plan_id=NULL,completed_at=NULL,claimed_at=at,expires_at=at+$4::int*interval '1 second'${fields}
      FROM moment WHERE company_id=$1 AND id=$2 RETURNING id,attempt_id`,
      [
        t.companyId,
        prior.id,
        requestHash,
        retention,
        ...(context ? [context.planId, context.employeeId] : []),
      ],
    );
    return { claim: r.rows[0] };
  }
  const columns = context ? ',context_plan_id,context_employee_id' : '';
  const values = context ? ',$7,$8' : '';
  const r = await c.query<CommandClaim>(
    `WITH moment AS (SELECT clock_timestamp() AS at)
    INSERT INTO public.idempotency_records(company_id,actor_account_id,operation,key_hash,request_hash,created_at,claimed_at,expires_at${columns})
    SELECT $1,$2,$3,$4,$5,at,at,at+$6::int*interval '1 second'${values} FROM moment RETURNING id,attempt_id`,
    [
      ...scope,
      requestHash,
      retention,
      ...(context ? [context.planId, context.employeeId] : []),
    ],
  );
  return { claim: r.rows[0] };
}
