/** SP05-SEC-01: PostgreSQL-backed, process-shared login abuse control.
 * No raw identifiers are stored in the database or included in errors/logs.
 * The IP is taken from the direct TCP peer, never client-supplied headers.
 */
import { HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service.js';

export const LOGIN_WINDOW_MS = 15 * 60_000;
const ACCOUNT_FAILURE_LIMIT = 5;
const IP_ATTEMPT_LIMIT = 60;
const MAX_PENDING = 5;
type Scope = 'ACCOUNT' | 'IP';
export type LoginOutcome = 'success' | 'failure' | 'aborted';

export type LoginAttemptReservation = Readonly<{
  accountHash: Buffer;
  windowStartedAt: Date;
}>;

type Counter = {
  window_started_at: Date;
  attempts: number;
  failures: number;
  pending: number;
  next_allowed_at: Date | null;
  db_now: Date;
};

export class LoginRateLimitedError extends HttpException {
  constructor(public readonly retryAfterSeconds: number) {
    super({ code: 'LOGIN_RATE_LIMITED' }, 429);
  }
}

/** Production must provide a stable, private 32-byte random key (64 hex chars).
 * Do not generate a fresh key per request/worker: that would reset counters.
 */
export function assertLoginAbuseConfig(): void {
  if (!/^[a-fA-F0-9]{64}$/.test(process.env.SECUREPLAN_LOGIN_HMAC_KEY ?? '')) {
    throw new Error('Login abuse HMAC key is not configured correctly');
  }
}

function keyFor(scope: Scope, value: string): Buffer {
  assertLoginAbuseConfig();
  const key = Buffer.from(process.env.SECUREPLAN_LOGIN_HMAC_KEY!, 'hex');
  return createHmac('sha256', key).update(`secureplan:login:${scope}:v1\0${value}`).digest();
}

export function canonicalPeerAddress(address: string | undefined): string {
  if (!address) return 'unknown-peer';
  const value = address.startsWith('::ffff:') ? address.slice(7) : address;
  return isIP(value) ? value.toLowerCase() : 'unknown-peer';
}

function secondsUntil(target: Date, now: Date): number {
  return Math.max(1, Math.ceil((target.getTime() - now.getTime()) / 1_000));
}

function windowEnd(start: Date): Date {
  return new Date(start.getTime() + LOGIN_WINDOW_MS);
}

async function lockedCounter(client: PoolClient, scope: Scope, hash: Buffer): Promise<Counter> {
  await client.query(
    `INSERT INTO login_abuse_counters (scope, identifier_hash)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [scope, hash],
  );
  const result = await client.query<Counter>(
    `SELECT window_started_at, attempts, failures, pending, next_allowed_at,
            clock_timestamp() AS db_now
     FROM login_abuse_counters
     WHERE scope = $1 AND identifier_hash = $2
     FOR UPDATE`,
    [scope, hash],
  );
  if (result.rowCount !== 1) throw new Error('Login limiter state missing');
  const row = result.rows[0];
  if (row.db_now.getTime() - row.window_started_at.getTime() >= LOGIN_WINDOW_MS) {
    await client.query(
      `UPDATE login_abuse_counters
       SET window_started_at = $3, attempts = 0, failures = 0,
           pending = 0, next_allowed_at = NULL
       WHERE scope = $1 AND identifier_hash = $2`,
      [scope, hash, row.db_now],
    );
    return { window_started_at: row.db_now, attempts: 0, failures: 0,
      pending: 0, next_allowed_at: null, db_now: row.db_now };
  }
  return row;
}

@Injectable()
export class LoginAbuseService {
  constructor(private readonly database: DatabaseService) {}

  /** Charge the IP counter, then reserve an account validation slot.
   * Two transactions mean Argon2id runs with NO DB row locks held.
   */
  async beginAttempt(email: string, peerAddress: string | undefined): Promise<LoginAttemptReservation> {
    const canonicalEmail = email.trim().toLowerCase();
    const ipHash = keyFor('IP', canonicalPeerAddress(peerAddress));
    const accountHash = keyFor('ACCOUNT', canonicalEmail);

    await this.database.withTransaction(async (client) => {
      const ip = await lockedCounter(client, 'IP', ipHash);
      if (ip.attempts >= IP_ATTEMPT_LIMIT) {
        throw new LoginRateLimitedError(secondsUntil(windowEnd(ip.window_started_at), ip.db_now));
      }
      await client.query(
        `UPDATE login_abuse_counters SET attempts = attempts + 1
         WHERE scope = 'IP' AND identifier_hash = $1`,
        [ipHash],
      );
    });

    return this.database.withTransaction(async (client) => {
      const account = await lockedCounter(client, 'ACCOUNT', accountHash);
      // Also cap outstanding password verifications. Parallel brute-force
      // requests cannot overrun the threshold before results are recorded.
      if (account.failures >= ACCOUNT_FAILURE_LIMIT) {
        throw new LoginRateLimitedError(
          secondsUntil(windowEnd(account.window_started_at), account.db_now),
        );
      }
      // Pending verification is transient; do not claim a 15-minute lockout.
      if (account.pending >= MAX_PENDING ||
          account.failures + account.pending >= ACCOUNT_FAILURE_LIMIT) {
        throw new LoginRateLimitedError(1);
      }
      if (account.next_allowed_at && account.next_allowed_at > account.db_now) {
        throw new LoginRateLimitedError(secondsUntil(account.next_allowed_at, account.db_now));
      }
      await client.query(
        `UPDATE login_abuse_counters
         SET attempts = attempts + 1, pending = pending + 1
         WHERE scope = 'ACCOUNT' AND identifier_hash = $1`,
        [accountHash],
      );
      return { accountHash, windowStartedAt: account.window_started_at };
    });
  }

  /** Every started attempt MUST be finalized, including unexpected errors.
   * Late completions never corrupt counters in a newer 15-minute window.
   */
  async finishAttempt(reservation: LoginAttemptReservation, outcome: LoginOutcome): Promise<void> {
    await this.database.withTransaction(async (client) => {
      const result = await client.query<Counter>(
        `SELECT window_started_at, attempts, failures, pending, next_allowed_at,
                clock_timestamp() AS db_now
         FROM login_abuse_counters
         WHERE scope = 'ACCOUNT' AND identifier_hash = $1
         FOR UPDATE`,
        [reservation.accountHash],
      );
      if (result.rowCount !== 1) throw new ServiceUnavailableException({ code: 'SERVICE_UNAVAILABLE' });
      const row = result.rows[0];
      if (row.window_started_at.getTime() !== reservation.windowStartedAt.getTime()) return;
      if (row.pending <= 0) throw new ServiceUnavailableException({ code: 'SERVICE_UNAVAILABLE' });
      if (outcome === 'failure') {
        const failures = row.failures + 1;
        const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(failures - 1, 5));
        await client.query(
          `UPDATE login_abuse_counters
           SET pending = pending - 1, failures = $2, next_allowed_at = $3
           WHERE scope = 'ACCOUNT' AND identifier_hash = $1`,
          [reservation.accountHash, failures, new Date(row.db_now.getTime() + delayMs)],
        );
      } else if (outcome === 'success') {
        // A valid password clears failures, but never the independent IP counter.
        await client.query(
          `UPDATE login_abuse_counters
           SET pending = pending - 1, failures = 0, next_allowed_at = NULL
           WHERE scope = 'ACCOUNT' AND identifier_hash = $1`,
          [reservation.accountHash],
        );
      } else {
        await client.query(
          `UPDATE login_abuse_counters SET pending = pending - 1
           WHERE scope = 'ACCOUNT' AND identifier_hash = $1`,
          [reservation.accountHash],
        );
      }
    });
  }
}
