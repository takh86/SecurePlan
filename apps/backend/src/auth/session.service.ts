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
import type { TenantContext } from './authorization/tenant-context.js';

const TOKEN_BYTES = 32;
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const HOUR_MS = 60 * 60 * 1000;
const SESSION_POLICY: Readonly<Record<TenantRole, { idleMs: number; absoluteMs: number }>> = {
  COMPANY_ADMIN: { idleMs: 30 * 60 * 1000, absoluteMs: 12 * HOUR_MS },
  EMPLOYEE: { idleMs: 8 * HOUR_MS, absoluteMs: 7 * 24 * HOUR_MS },
};

/** Identity-owned check under A/C locks. Revocation writers require A UPDATE;
 * no session lock, touch or account upgrade is allowed at a later planning tier.
 * Call again after business-lock waits to evaluate expiry with a fresh clock.
 */
export async function assertSessionInTransaction(client: Pick<PoolClient, 'query'>, tenant: TenantContext): Promise<void> {
  const { rows: [session] } = await client.query<{ revoked_at: Date | null; expired: boolean }>(
    `SELECT revoked_at, (clock_timestamp() >= least(absolute_expires_at, created_at + $4::double precision * interval '1 millisecond')
      OR clock_timestamp() >= last_seen_at + $5::double precision * interval '1 millisecond'
      OR clock_timestamp() < last_seen_at) AS expired
     FROM sessions WHERE company_id = $1 AND account_id = $2 AND id = $3`,
    [tenant.companyId, tenant.accountId, tenant.sessionId, SESSION_POLICY[tenant.role].absoluteMs, SESSION_POLICY[tenant.role].idleMs],
  );
  if (!session || session.revoked_at !== null) unauthorized('SESSION_REVOKED');
  if (session.expired) unauthorized('SESSION_EXPIRED');
}

type SessionErrorCode = 'SESSION_REQUIRED' | 'SESSION_EXPIRED' | 'SESSION_REVOKED';

type TrustedAccount = { role: string };
type LiveAccount = TrustedAccount & { email: string };
type LocatedSession = { company_id: string; account_id: string };
type LockedSession = {
  id: string;
  company_id: string;
  account_id: string;
  csrf_secret: Buffer;
  absolute_expires_at: Date;
  revoked_at: Date | null;
  /** Computed by PostgreSQL on the database clock while the row lock is held (SP-115). */
  expired: boolean;
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

      const rawToken = randomBytes(TOKEN_BYTES).toString('base64url');
      const digest = createHash('sha256').update(rawToken, 'utf8').digest();
      const csrfSecret = randomBytes(TOKEN_BYTES);

      // SP-115: every session instant is a database-clock value, the same clock that assertSessionInTransaction
      // compares against. The application clock is never written into a session row.
      const inserted = await client.query<{ absolute_expires_at: Date }>(
        `WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at)
         INSERT INTO sessions
           (company_id, account_id, token_hash, csrf_secret,
            created_at, last_seen_at, absolute_expires_at)
         SELECT $1, $2, $3, $4, moment.at, moment.at,
                moment.at + ($5::double precision * interval '1 millisecond')
         FROM moment
         RETURNING absolute_expires_at`,
        [input.companyId, input.accountId, digest, csrfSecret, SESSION_POLICY[role].absoluteMs],
      );

      // Returned only once the INSERT succeeded and the transaction commits.
      return {
        rawToken,
        csrfToken: csrfSecret.toString('base64url'),
        absoluteExpiresAt: inserted.rows[0].absolute_expires_at,
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

      // SP-115: expiry is evaluated by PostgreSQL on the database clock, the same predicate as
      // assertSessionInTransaction. clock_timestamp() is read per row while its lock is held, so the
      // clock is captured after every lock wait above and never from the application.
      const locked = await client.query<LockedSession>(
        `SELECT id, company_id, account_id, csrf_secret, absolute_expires_at, revoked_at,
                (clock_timestamp() >= least(absolute_expires_at, created_at + $4::double precision * interval '1 millisecond')
                 OR clock_timestamp() >= last_seen_at + $5::double precision * interval '1 millisecond'
                 OR clock_timestamp() < last_seen_at) AS expired
         FROM sessions
         WHERE token_hash = $1 AND company_id = $2 AND account_id = $3
         FOR UPDATE`,
        [digest, companyId, accountId, SESSION_POLICY[role].absoluteMs, SESSION_POLICY[role].idleMs],
      );
      if (locked.rowCount !== 1) unauthorized('SESSION_REQUIRED');
      const session = locked.rows[0];
      if (session.revoked_at !== null) unauthorized('SESSION_REVOKED');
      if (session.expired) unauthorized('SESSION_EXPIRED');

      const updated = await client.query(
        `UPDATE sessions
         SET last_seen_at = clock_timestamp()
         WHERE id = $1
           AND revoked_at IS NULL
           AND absolute_expires_at > clock_timestamp()
           AND last_seen_at <= clock_timestamp()
         RETURNING id`,
        [session.id],
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
        'UPDATE sessions SET revoked_at = clock_timestamp() WHERE id = $1 AND revoked_at IS NULL',
        [session.rows[0].id],
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
      `UPDATE sessions SET revoked_at = clock_timestamp()
       WHERE company_id = $1 AND account_id = $2 AND revoked_at IS NULL`,
      [companyId, accountId],
    );
    return result.rowCount ?? 0;
  }
}
