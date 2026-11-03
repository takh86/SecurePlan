import { ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';

/** I tier: nonwaiting admission covers absent keys; collisions only refuse work. */
export async function reservationLock(
  client: PoolClient,
  lockId: string,
): Promise<void> {
  if (!(await tryReservationLock(client, lockId)))
    throw new ConflictException({ code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS' });
}
export async function tryReservationLock(
  client: PoolClient,
  lockId: string,
): Promise<boolean> {
  const {
    rows: [row],
  } = await client.query<{ held: boolean }>(
    'SELECT pg_try_advisory_xact_lock($1::bigint) AS held',
    [lockId],
  );
  return row.held;
}
/** Row fence is retained through business writes, audits and receipt completion. */
export async function lockAttempt(
  client: PoolClient,
  companyId: string,
  actorId: string,
  operation: string,
  keyHash: Buffer,
  id: string,
  attempt: string,
): Promise<void> {
  const row = await client.query(
    `SELECT id FROM public.idempotency_records WHERE company_id=$1 AND actor_account_id=$2 AND operation=$3
      AND key_hash=$4 AND id=$5 AND attempt_id=$6 AND state='IN_PROGRESS' FOR UPDATE`,
    [companyId, actorId, operation, keyHash, id, attempt],
  );
  if (row.rowCount !== 1)
    throw new ConflictException({ code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS' });
}
