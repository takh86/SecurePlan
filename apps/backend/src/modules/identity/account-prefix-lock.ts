/**
 * LOCK-01-L1 account prefix (SP11A-R1 T1, DEC-1.1/1.2/1.4).
 *
 * Global rank order: A accounts -> C company -> I command -> E employees -> P
 * projects -> M monthly links -> L plan lifecycle -> D duties -> A2 memberships
 * -> Q lease -> W workflow -> Z audit/children. This helper acquires tiers A
 * and C explicitly and sequentially, then re-asserts the acting account:
 *
 * 1. every participating account (the actor plus target accounts, deduplicated,
 *    in UUID order) is locked in its own statement at its FINAL strength: the
 *    actor FOR SHARE, any target FOR UPDATE, actor == target once FOR UPDATE.
 *    No SHARE->UPDATE upgrade ever happens;
 * 2. the company row FOR SHARE in its own statement (same relative order as
 *    SessionService: account, then company);
 * 3. the actor is revalidated from the locked row with the precedence of
 *    assertActorInTransaction: 401 SESSION_REVOKED, then 403 ACTION_FORBIDDEN
 *    (live role differs from the context role, or is not allowed).
 *
 * Every NEW SP-11 writer and employee deactivation uses this helper. The legacy
 * joined helper (assertActorInTransaction) stays only for already-shipped
 * writers; it is cycle-free solely because the company row is a SHARE-only leaf
 * (DEC-1.2, enforced by company-lock-tripwire.spec.ts).
 *
 * A target account must be discovered by a NON-locking read before this call;
 * a caller that later finds a different target must abort and never lock the
 * newly discovered account late.
 */
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { TenantContext, TenantRole } from '../../auth/authorization/tenant-context.js';

type Queryable = Pick<PoolClient, 'query'>;

type LockedAccount = { role: string; status: string; account_scope: string };

export async function lockAccountsPrefix(
  client: Queryable,
  tenant: TenantContext,
  allowedRoles: readonly TenantRole[],
  targetAccountIds: readonly string[] = [],
): Promise<void> {
  const targets = new Set(targetAccountIds.map((id) => id.toLowerCase()));
  const actorId = tenant.accountId.toLowerCase();
  const ordered = [...new Set([actorId, ...targets])].sort();

  let actor: LockedAccount | undefined;
  for (const accountId of ordered) {
    // The lock mode is an internal literal, never request input.
    const mode = targets.has(accountId) ? 'UPDATE' : 'SHARE';
    const locked = await client.query<LockedAccount>(
      `SELECT role, status, account_scope FROM accounts
       WHERE company_id = $1 AND id = $2
       FOR ${mode}`,
      [tenant.companyId, accountId],
    );
    if (accountId === actorId) {
      actor = locked.rows[0];
    } else if (locked.rowCount !== 1) {
      // Targets come from a tenant-scoped composite-FK row: a miss is a server defect.
      throw new Error('lockAccountsPrefix: target account not found');
    }
  }

  const company = await client.query<{ status: string }>(
    'SELECT status FROM companies WHERE id = $1 FOR SHARE',
    [tenant.companyId],
  );

  if (
    actor === undefined ||
    actor.account_scope !== 'TENANT' ||
    actor.status !== 'ACTIVE' ||
    company.rows[0]?.status !== 'ACTIVE'
  ) {
    throw new UnauthorizedException({ code: 'SESSION_REVOKED' });
  }
  // A role change since session validation invalidates the whole context.
  if (actor.role !== tenant.role) throw new ForbiddenException({ code: 'ACTION_FORBIDDEN' });
  if (!(allowedRoles as readonly string[]).includes(actor.role)) {
    throw new ForbiddenException({ code: 'ACTION_FORBIDDEN' });
  }
}
