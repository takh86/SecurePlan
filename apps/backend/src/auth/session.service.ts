/**
 * SecurePlan SP-05 — server-side, opaque-cookie sessions.
 *
 * Integration boundary: this service NEVER sets cookies or accepts a role from
 * the client. AuthService must verify a password before createForAccount().
 * The HTTP layer must enforce HTTPS, Origin and CSRF, then set the Secure,
 * HttpOnly, SameSite=Lax, host-only cookie (Path=/).
 */
import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service.js';
import { isTenantRole, type TenantRole } from './authorization/tenant-context.js';

const TOKEN_BYTES = 32;
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const HOUR_MS = 60 * 60 * 1000;
const SESSION_POLICY: Readonly<Record<TenantRole, { idleMs: number; absoluteMs: number }>> = {
  COMPANY_ADMIN: { idleMs: 30 * 60 * 1000, absoluteMs: 12 * HOUR_MS },
  EMPLOYEE: { idleMs: 8 * HOUR_MS, absoluteMs: 7 * 24 * HOUR_MS },
};

type SessionErrorCode = 'SESSION_REQUIRED' | 'SESSION_EXPIRED' | 'SESSION_REVOKED';

type TrustedAccount = { role: string };
type LiveAccount = TrustedAccount & { email: string };
type LocatedSession = { company_id: string; account_id: string };
type LockedSession = {
  id: string;
  company_id: string;
  account_id: string;
  csrf_secret: Buffer;
  created_at: Date;
  last_seen_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
};

export type CreateSessionInput = {
  /** Server-resolved IDs AFTER password verification; never trust client IDs. */
  companyId: string;
  accountId: string;
  /** Exact Argon2id hash that AuthService has just successfully verified. */
  verifiedPasswordHash: string;
};

export type CreatedSession = {
  /** Keep out of logs/database/JSON. HTTP layer sets the HttpOnly cookie. */
  rawToken: string;
  /** CSRF header value, distinct from the session token. */
  csrfToken: string;
  absoluteExpiresAt: Date;
};

export type ValidatedSession = {
  sessionId: string;
  accountId: string;
  companyId: string;
  /** Always obtained from live accounts row, not from a browser cookie. */
  role: TenantRole;
  email: string;
  csrfToken: string;
  absoluteExpiresAt: Date;
};

function unauthorized(code: SessionErrorCode): never {
  throw new UnauthorizedException({ code });
}

function invalidCredentials(): never {
  throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS' });
}

function tokenHash(rawToken: string): Buffer | null {
  if (!TOKEN_FORMAT.test(rawToken)) return null;
  return createHash('sha256').update(rawToken, 'utf8').digest();
}

function trustedRole(value: string): TenantRole | null {
  return isTenantRole(value) ? value : null;
}

/** No timing-dependent early equality comparison for CSRF secrets. */
export function assertSessionCsrf(
  received: string | undefined,
  expected: string,
): void {
  if (
    !received ||
    !TOKEN_FORMAT.test(received) ||
    !TOKEN_FORMAT.test(expected)
  ) {
    throw new ForbiddenException({ code: 'CSRF_VALIDATION_FAILED' });
  }
  const actual = Buffer.from(received, 'base64url');
  const wanted = Buffer.from(expected, 'base64url');
  if (
    actual.length !== TOKEN_BYTES ||
    wanted.length !== TOKEN_BYTES ||
    !timingSafeEqual(actual, wanted)
  ) {
    throw new ForbiddenException({ code: 'CSRF_VALIDATION_FAILED' });
  }
}

@Injectable()
export class SessionService {
  constructor(private readonly database: DatabaseService) {}

  /** Override in tests to precisely simulate idle/absolute expiration. */
  protected now(): Date {
    return new Date();
  }

  /** Call ONLY after AuthService has verified the password. */
  async createForAccount(input: CreateSessionInput): Promise<CreatedSession> {
    return this.database.withTransaction(async (client) => {
      // Recheck the exact verified password hash under the account lock, so a
      // concurrent password reset cannot create a session for old credentials.
      // Company lock prevents a concurrent SUSPENDED status change from being
      // overlooked during this transaction.
      const owner = await client.query<TrustedAccount>(
        `SELECT a.role
         FROM accounts AS a
         JOIN companies AS c ON c.id = a.company_id
         WHERE a.id = $1
           AND a.company_id = $2
           AND a.account_scope = 'TENANT'
           AND a.status = 'ACTIVE'
           AND c.status = 'ACTIVE'
           AND a.password_hash = $3
         FOR UPDATE OF a
         FOR SHARE OF c`,
        [input.accountId, input.companyId, input.verifiedPasswordHash],
      );

      if (owner.rowCount !== 1) invalidCredentials();
      const role = trustedRole(owner.rows[0].role);
      if (role === null) invalidCredentials();

      const now = this.now();
      const expiresAt = new Date(now.getTime() + SESSION_POLICY[role].absoluteMs);
      const rawToken = randomBytes(TOKEN_BYTES).toString('base64url');
      const digest = createHash('sha256').update(rawToken, 'utf8').digest();
      const csrfSecret = randomBytes(TOKEN_BYTES);

      await client.query(
        `INSERT INTO sessions
           (company_id, account_id, token_hash, csrf_secret,
            created_at, last_seen_at, absolute_expires_at)
         VALUES ($1, $2, $3, $4, $5, $5, $6)`,
        [input.companyId, input.accountId, digest, csrfSecret, now, expiresAt],
      );

      // Returned only once the INSERT succeeded and the transaction commits.
      return {
        rawToken,
        csrfToken: csrfSecret.toString('base64url'),
        absoluteExpiresAt: expiresAt,
      };
    });
  }

  /**
   * Validates the opaque cookie against live DB state AND updates idle activity.
   * Account -> Session lock ordering prevents resurrection after concurrent
   * logout, password reset or account deactivation.
   */
  async validateAndTouch(rawToken: string): Promise<ValidatedSession> {
    const digest = tokenHash(rawToken);
    if (!digest) unauthorized('SESSION_REQUIRED');

    return this.database.withTransaction(async (client) => {
      // Unlocked lookup only finds the parent locking key; it grants no access.
      const locator = await client.query<LocatedSession>(
        'SELECT company_id, account_id FROM sessions WHERE token_hash = $1',
        [digest],
      );
      if (locator.rowCount !== 1) unauthorized('SESSION_REQUIRED');
      const { company_id: companyId, account_id: accountId } = locator.rows[0];

      // All authority comes from the CURRENT parent rows.
      const owner = await client.query<LiveAccount>(
        `SELECT a.role, a.email
         FROM accounts AS a
         JOIN companies AS c ON c.id = a.company_id
         WHERE a.id = $1 AND a.company_id = $2
           AND a.account_scope = 'TENANT'
           AND a.status = 'ACTIVE' AND c.status = 'ACTIVE'
         FOR UPDATE OF a
         FOR SHARE OF c`,
        [accountId, companyId],
      );
      if (owner.rowCount !== 1) unauthorized('SESSION_REVOKED');
      const role = trustedRole(owner.rows[0].role);
      if (role === null) unauthorized('SESSION_REVOKED');

      const locked = await client.query<LockedSession>(
        `SELECT id, company_id, account_id, csrf_secret,
                created_at, last_seen_at, absolute_expires_at, revoked_at
         FROM sessions
         WHERE token_hash = $1 AND company_id = $2 AND account_id = $3
         FOR UPDATE`,
        [digest, companyId, accountId],
      );
      if (locked.rowCount !== 1) unauthorized('SESSION_REQUIRED');
      const session = locked.rows[0];
      if (session.revoked_at !== null) unauthorized('SESSION_REVOKED');

      // Capture the clock AFTER acquiring row locks, not before waiting.
      const now = this.now();
      const time = now.getTime();
      if (
        time >= Math.min(
          session.absolute_expires_at.getTime(),
          session.created_at.getTime() + SESSION_POLICY[role].absoluteMs,
        ) ||
        time >= session.last_seen_at.getTime() + SESSION_POLICY[role].idleMs ||
        time < session.last_seen_at.getTime()
      ) {
        unauthorized('SESSION_EXPIRED');
      }

      const updated = await client.query(
        `UPDATE sessions
         SET last_seen_at = $1
         WHERE id = $2
           AND revoked_at IS NULL
           AND absolute_expires_at > $1
           AND last_seen_at <= $1
         RETURNING id`,
        [now, session.id],
      );
      if (updated.rowCount !== 1) unauthorized('SESSION_REVOKED');

      return {
        sessionId: session.id,
        accountId,
        companyId,
        role,
        email: owner.rows[0].email,
        csrfToken: session.csrf_secret.toString('base64url'),
        absoluteExpiresAt: session.absolute_expires_at,
      };
    });
  }

  /** Revoke one cookie session; false means missing, malformed or already revoked. */
  async revoke(rawToken: string): Promise<boolean> {
    const digest = tokenHash(rawToken);
    if (!digest) return false;

    return this.database.withTransaction(async (client) => {
      const locator = await client.query<LocatedSession>(
        'SELECT company_id, account_id FROM sessions WHERE token_hash = $1',
        [digest],
      );
      if (locator.rowCount !== 1) return false;
      const { company_id: companyId, account_id: accountId } = locator.rows[0];

      // Lock ordering: account before session. Does not require ACTIVE state:
      // logout/revocation must still work for deactivated accounts.
      await client.query(
        'SELECT id FROM accounts WHERE company_id = $1 AND id = $2 FOR UPDATE',
        [companyId, accountId],
      );
      const session = await client.query<{ id: string; revoked_at: Date | null }>(
        `SELECT id, revoked_at FROM sessions
         WHERE company_id = $1 AND account_id = $2 AND token_hash = $3
         FOR UPDATE`,
        [companyId, accountId, digest],
      );
      if (session.rowCount !== 1 || session.rows[0].revoked_at !== null) return false;

      const result = await client.query(
        'UPDATE sessions SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL',
        [this.now(), session.rows[0].id],
      );
      return result.rowCount === 1;
    });
  }

  /**
   * Use inside the SAME transaction as deactivation/password reset.
   * Caller must lock the account row first to preserve the shared lock order.
   */
  async revokeAllForAccountInTransaction(
    client: PoolClient,
    companyId: string,
    accountId: string,
  ): Promise<number> {
    const result = await client.query(
      `UPDATE sessions SET revoked_at = $3
       WHERE company_id = $1 AND account_id = $2 AND revoked_at IS NULL`,
      [companyId, accountId, this.now()],
    );
    return result.rowCount ?? 0;
  }
}
