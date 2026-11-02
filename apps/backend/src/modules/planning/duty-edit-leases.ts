import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../../auth/authorization/tenant-context.js';

type Queryable = Pick<PoolClient, 'query'>;
export type EditLeaseResponse = { leaseToken: string; expiresAt: string };

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const hash = (token: string) => createHash('sha256').update(token).digest();
function rejected(): never { throw new ConflictException({ code: 'EDIT_LEASE_NOT_HELD' }); }

/** Missing is structural 400. Token authentication happens after resource visibility. */
export function requireEditLeaseHeader(value: string | string[] | undefined): string | string[] {
  if (value === undefined) throw new BadRequestException({ code: 'EDIT_LEASE_TOKEN_REQUIRED' });
  return value;
}

function tokenHash(value: string | string[]): Buffer {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)
    || Buffer.from(value, 'base64url').toString('base64url') !== value) rejected();
  return hash(value);
}

/** Positive PostgreSQL int seconds; default TTL is 120s. Invalid config fails closed. */
export function editLeaseTtl(): number {
  const value = process.env.SECUREPLAN_EDIT_LEASE_TTL_SECONDS ?? '120';
  const seconds = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(seconds) || seconds > 2147483647) {
    throw new Error('Invalid edit lease TTL configuration');
  }
  return seconds;
}

const expiryColumn = `to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at`;

/** Caller already holds A/C/P/L/D in L1 order. Duty UPDATE protects an absent lease slot. */
export async function acquireDutyLease(client: Queryable, tenant: TenantContext, dutyId: string): Promise<EditLeaseResponse> {
  const token = randomBytes(32).toString('base64url');
  const result = await client.query<{ expires_at: string }>(
    `INSERT INTO public.edit_leases AS q (company_id, duty_id, owner_account_id, token_hash, acquired_at, expires_at)
     VALUES ($1, $2, $3, $4, clock_timestamp(), clock_timestamp() + make_interval(secs => $5))
     ON CONFLICT (company_id, duty_id) DO UPDATE
       SET owner_account_id = EXCLUDED.owner_account_id, token_hash = EXCLUDED.token_hash,
           acquired_at = clock_timestamp(), expires_at = clock_timestamp() + make_interval(secs => $5),
           renewed_at = NULL, released_at = NULL
       WHERE q.owner_account_id = $3 OR q.released_at IS NOT NULL OR q.expires_at <= clock_timestamp()
     RETURNING ${expiryColumn}`,
    [tenant.companyId, dutyId, tenant.accountId, hash(token), editLeaseTtl()],
  );
  if (result.rowCount !== 1) throw new ConflictException({ code: 'RESOURCE_EDIT_LOCKED' });
  return { leaseToken: token, expiresAt: result.rows[0].expires_at };
}

/** Fresh expiry check AFTER the Q lock wait; transaction-start timestamps are not sufficient. */
export async function assertDutyLease(
  client: Queryable, tenant: TenantContext, dutyId: string, token: string | string[], allowExpired = false,
): Promise<void> {
  const digest = tokenHash(token);
  await client.query('SELECT 1 FROM public.edit_leases WHERE company_id = $1 AND duty_id = $2 FOR UPDATE', [tenant.companyId, dutyId]);
  const result = await client.query(
    `SELECT 1 FROM public.edit_leases
     WHERE company_id = $1 AND duty_id = $2 AND owner_account_id = $3 AND token_hash = $4
       AND ($5::boolean OR (released_at IS NULL AND expires_at > clock_timestamp()))`,
    [tenant.companyId, dutyId, tenant.accountId, digest, allowExpired],
  );
  if (result.rowCount !== 1) rejected();
}

export async function renewDutyLease(client: Queryable, tenant: TenantContext, dutyId: string, token: string | string[]): Promise<EditLeaseResponse> {
  await assertDutyLease(client, tenant, dutyId, token);
  const result = await client.query<{ expires_at: string }>(
    `UPDATE public.edit_leases SET renewed_at = clock_timestamp(), expires_at = clock_timestamp() + make_interval(secs => $5)
     WHERE company_id = $1 AND duty_id = $2 AND owner_account_id = $3 AND token_hash = $4
       AND released_at IS NULL AND expires_at > clock_timestamp() RETURNING ${expiryColumn}`,
    [tenant.companyId, dutyId, tenant.accountId, tokenHash(token), editLeaseTtl()],
  );
  if (result.rowCount !== 1) rejected();
  return { leaseToken: token as string, expiresAt: result.rows[0].expires_at };
}

export async function releaseDutyLease(client: Queryable, tenant: TenantContext, dutyId: string, token: string | string[]): Promise<void> {
  // Retained matching owner+hash authenticates an expired/already released lease.
  await assertDutyLease(client, tenant, dutyId, token, true);
  await client.query(
    `UPDATE public.edit_leases SET released_at = clock_timestamp()
     WHERE company_id = $1 AND duty_id = $2 AND released_at IS NULL`,
    [tenant.companyId, dutyId],
  );
}
