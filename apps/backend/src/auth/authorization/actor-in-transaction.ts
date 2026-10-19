/**
 * SP-06 — re-assert the acting account INSIDE a tenant-scoped write transaction.
 *
 * AccessControlGuard validates the session in its own, already committed
 * transaction. A role change, account deactivation or company suspension
 * committed after the guard but before a later write would otherwise go
 * unnoticed (TOCTOU). Mutating tenant services must therefore call this first,
 * on the same client/transaction as their scoped write.
 *
 * FOR SHARE on the account and company rows blocks concurrent status/role
 * UPDATEs until the write commits; an UPDATE committed first is observed here
 * (READ COMMITTED re-evaluates the WHERE clause after the lock wait).
 * Lock order matches SessionService: account before company.
 *
 * Fail-closed rules:
 * - account/company no longer ACTIVE (or pairing invalid) -> 401 SESSION_REVOKED
 * - live role differs from the role in TenantContext      -> 403 ACTION_FORBIDDEN
 *   (in EITHER direction; services may branch on tenant.role, so a stale
 *   context must never be used, even if the live role is also allowed)
 * - live role not in allowedRoles                         -> 403 ACTION_FORBIDDEN
 *
 * Session revocation/expiry is NOT re-checked here (see SP-06 review notes):
 * the request was authenticated at entry by AccessControlGuard. Logout and
 * revocation lock the account row FOR UPDATE, so they wait for an in-flight
 * write that already holds this FOR SHARE lock; a revocation committed between
 * the guard and this call is not detected.
 */
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { TenantContext, TenantRole } from './tenant-context.js';

type Queryable = Pick<PoolClient, 'query'>;

export async function assertActorInTransaction(
  client: Queryable,
  tenant: TenantContext,
  allowedRoles: readonly TenantRole[],
): Promise<void> {
  const actor = await client.query<{ role: string }>(
    `SELECT a.role
     FROM accounts AS a
     JOIN companies AS c ON c.id = a.company_id
     WHERE a.id = $1 AND a.company_id = $2
       AND a.account_scope = 'TENANT'
       AND a.status = 'ACTIVE' AND c.status = 'ACTIVE'
     FOR SHARE OF a, c`,
    [tenant.accountId, tenant.companyId],
  );
  if (actor.rowCount !== 1) {
    throw new UnauthorizedException({ code: 'SESSION_REVOKED' });
  }
  const liveRole = actor.rows[0].role;
  // A role change since session validation invalidates the whole context.
  if (liveRole !== tenant.role) {
    throw new ForbiddenException({ code: 'ACTION_FORBIDDEN' });
  }
  if (!(allowedRoles as readonly string[]).includes(liveRole)) {
    throw new ForbiddenException({ code: 'ACTION_FORBIDDEN' });
  }
}
