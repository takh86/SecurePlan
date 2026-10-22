/**
 * Identity module public contract for other modules (provisionAccount,
 * deactivateAccount, invalidateSessions). Workforce never touches `accounts`,
 * `account_tokens` or `sessions` directly; it calls this service instead.
 *
 * Every method runs on the CALLER's transaction client, so the business change
 * and the account change commit or roll back together. Lock order is the one
 * SessionService relies on: account row first, then its sessions/tokens.
 */
import { ConflictException, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { generateAccountToken } from '../../auth/account-token.js';
import { SessionService } from '../../auth/session.service.js';
import { uniqueViolationConstraint } from '../../common/database/unique-violation.js';

export const ACCOUNT_STATUSES = ['PENDING_ACTIVATION', 'ACTIVE', 'DEACTIVATED'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export type AccountSummary = Readonly<{ email: string; status: AccountStatus }>;

/** Raw token lives in memory only, for exactly one delivery attempt. */
export type PendingActivation = Readonly<{ tokenId: string; rawToken: string }>;

export type ProvisionedAccount = Readonly<{
  accountId: string;
  email: string;
  activation: PendingActivation;
}>;

export type AccountDeactivation = Readonly<{
  email: string;
  previousStatus: AccountStatus;
  revokedSessions: number;
  revokedTokens: number;
}>;

function accountStatus(value: string): AccountStatus {
  if (!(ACCOUNT_STATUSES as readonly string[]).includes(value)) {
    throw new Error('Unexpected account status in database');
  }
  return value as AccountStatus;
}

/** Server-side normalization; lookups and the unique index use lower(email). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

@Injectable()
export class AccountLifecycleService {
  constructor(private readonly sessions: SessionService) {}

  /**
   * New personal EMPLOYEE account in PENDING_ACTIVATION plus a 24-hour,
   * single-use activation token (stored as SHA-256 digest only). Role, scope
   * and company are server-controlled; no password is accepted here.
   */
  async provisionEmployeeAccount(
    client: PoolClient,
    companyId: string,
    email: string,
  ): Promise<ProvisionedAccount> {
    const normalized = normalizeEmail(email);
    let accountId: string;
    try {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO accounts (company_id, email, account_scope, role, status)
         VALUES ($1, $2, 'TENANT', 'EMPLOYEE', 'PENDING_ACTIVATION')
         RETURNING id`,
        [companyId, normalized],
      );
      accountId = inserted.rows[0].id;
    } catch (error) {
      // E-mail is unique across ALL tenants (approved baseline). The 409 can
      // therefore reveal that an address is enrolled elsewhere; see SP-07 notes.
      if (uniqueViolationConstraint(error) === 'uq_accounts_email_lower') {
        throw new ConflictException({ code: 'EMAIL_ALREADY_IN_USE' });
      }
      throw error;
    }
    const activation = await this.insertActivationToken(client, companyId, accountId);
    return { accountId, email: normalized, activation };
  }

  /**
   * Deactivates the account, revokes ALL its sessions and every unused token
   * in the same transaction. Idempotent for an already DEACTIVATED account.
   */
  async deactivateAccount(
    client: PoolClient,
    companyId: string,
    accountId: string,
  ): Promise<AccountDeactivation> {
    const locked = await client.query<{ email: string; status: string }>(
      `SELECT email, status FROM accounts
       WHERE company_id = $1 AND id = $2 AND account_scope = 'TENANT'
       FOR UPDATE`,
      [companyId, accountId],
    );
    // The composite FK guarantees the pairing; a miss is a server defect.
    if (locked.rowCount !== 1) throw new Error('Linked tenant account not found');
    const previousStatus = accountStatus(locked.rows[0].status);

    if (previousStatus !== 'DEACTIVATED') {
      await client.query(
        `UPDATE accounts SET status = 'DEACTIVATED', updated_at = clock_timestamp()
         WHERE company_id = $1 AND id = $2`,
        [companyId, accountId],
      );
    }
    const revokedSessions = await this.sessions.revokeAllForAccountInTransaction(
      client,
      companyId,
      accountId,
    );
    const tokens = await client.query(
      `UPDATE account_tokens SET revoked_at = clock_timestamp()
       WHERE company_id = $1 AND account_id = $2
         AND used_at IS NULL AND revoked_at IS NULL`,
      [companyId, accountId],
    );
    return {
      email: locked.rows[0].email,
      previousStatus,
      revokedSessions,
      revokedTokens: tokens.rowCount ?? 0,
    };
  }

  /** E-mail and status for accounts of ONE tenant; foreign IDs are simply absent. */
  async accountSummaries(
    client: Pick<PoolClient, 'query'>,
    companyId: string,
    accountIds: readonly string[],
  ): Promise<Map<string, AccountSummary>> {
    const summaries = new Map<string, AccountSummary>();
    if (accountIds.length === 0) return summaries;
    const result = await client.query<{ id: string; email: string; status: string }>(
      `SELECT id, email, status FROM accounts
       WHERE company_id = $1 AND id = ANY($2::uuid[])`,
      [companyId, [...accountIds]],
    );
    for (const row of result.rows) {
      summaries.set(row.id, { email: row.email, status: accountStatus(row.status) });
    }
    return summaries;
  }

  /**
   * After a delivery failure the raw token is gone, so the stored digest must
   * not stay usable. Returns false if the token was already used or revoked.
   */
  async revokeUndeliveredActivation(
    client: PoolClient,
    companyId: string,
    accountId: string,
    tokenId: string,
  ): Promise<boolean> {
    await client.query(
      'SELECT id FROM accounts WHERE company_id = $1 AND id = $2 FOR UPDATE',
      [companyId, accountId],
    );
    const revoked = await client.query(
      `UPDATE account_tokens SET revoked_at = clock_timestamp()
       WHERE company_id = $1 AND account_id = $2 AND id = $3
         AND used_at IS NULL AND revoked_at IS NULL`,
      [companyId, accountId, tokenId],
    );
    return revoked.rowCount === 1;
  }

  /**
   * Internal recovery only (no HTTP endpoint): starts a NEW token lifecycle for
   * an account that is still waiting for activation. All older unused tokens
   * are revoked first. Returns null when the account is not (or no longer)
   * pending, e.g. activated or deactivated meanwhile.
   */
  async reissueActivation(
    client: PoolClient,
    companyId: string,
    accountId: string,
  ): Promise<{ email: string; activation: PendingActivation } | null> {
    const pending = await client.query<{ email: string }>(
      `SELECT email FROM accounts
       WHERE company_id = $1 AND id = $2 AND account_scope = 'TENANT'
         AND status = 'PENDING_ACTIVATION' AND password_hash IS NULL
       FOR UPDATE`,
      [companyId, accountId],
    );
    if (pending.rowCount !== 1) return null;
    await client.query(
      `UPDATE account_tokens SET revoked_at = clock_timestamp()
       WHERE company_id = $1 AND account_id = $2
         AND used_at IS NULL AND revoked_at IS NULL`,
      [companyId, accountId],
    );
    const activation = await this.insertActivationToken(client, companyId, accountId);
    return { email: pending.rows[0].email, activation };
  }

  private async insertActivationToken(
    client: PoolClient,
    companyId: string,
    accountId: string,
  ): Promise<PendingActivation> {
    const { rawToken, tokenHash } = generateAccountToken();
    const token = await client.query<{ id: string }>(
      `INSERT INTO account_tokens (company_id, account_id, purpose, token_hash, expires_at)
       VALUES ($1, $2, 'EMAIL_VERIFICATION', $3, clock_timestamp() + INTERVAL '24 hours')
       RETURNING id`,
      [companyId, accountId, tokenHash],
    );
    return { tokenId: token.rows[0].id, rawToken };
  }
}
