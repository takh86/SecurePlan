/**
 * SecurePlan SP-05 — SessionService integration (real PostgreSQL).
 * Run with 0004_sessions.sql applied:
 * npm run test:e2e --workspace=backend -- session-service-real.e2e-spec.ts
 *
 * Each test owns a single transaction and rolls it back. No real accounts,
 * production data, cookies, or network calls are involved.
 */
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg, { type PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../src/database/database.service.js';
import {
  SessionService,
  assertSessionCsrf,
  type CreateSessionInput,
} from '../src/auth/session.service.js';

const { Pool } = pg;
const INITIAL_TIME = new Date('2026-10-19T12:00:00.000Z');
const VERIFIED_HASH = 'synthetic-verified-hash-v1';

class TestableSessionService extends SessionService {
  private instant = new Date(INITIAL_TIME);

  setTime(instant: Date): void {
    this.instant = instant;
  }

  protected override now(): Date {
    return new Date(this.instant);
  }
}

type Fixture = { companyA: string; companyB: string; accountA: string; accountB: string };
let pool: InstanceType<typeof Pool> | undefined;
let client: PoolClient | undefined;
let fixture: Fixture;
let service: TestableSessionService;

function db(): PoolClient {
  if (!client) throw new Error('Test transaction not initialized');
  return client;
}

function credentials(
  values: Partial<CreateSessionInput> = {},
): CreateSessionInput {
  return {
    accountId: fixture.accountA,
    companyId: fixture.companyA,
    verifiedPasswordHash: VERIFIED_HASH,
    ...values,
  };
}

async function expectSessionError(
  operation: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(operation).rejects.toMatchObject({
    response: { code },
  });
}

const plus = (ms: number) => new Date(INITIAL_TIME.getTime() + ms);
const HOUR_MS = 60 * 60 * 1000;

describe('SP-05 — SessionService (real PostgreSQL)', () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
    }
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000, max: 2 });
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    if (!pool) throw new Error('PostgreSQL pool unavailable');
    client = await pool.connect();
    await db().query('BEGIN');
    fixture = {
      companyA: randomUUID(),
      companyB: randomUUID(),
      accountA: randomUUID(),
      accountB: randomUUID(),
    };
    await db().query(
      `INSERT INTO companies (id, name, status, time_zone)
       VALUES ($1, 'SP05 Test Company A', 'ACTIVE', 'Europe/Berlin'),
              ($2, 'SP05 Test Company B', 'ACTIVE', 'Europe/Berlin')`,
      [fixture.companyA, fixture.companyB],
    );
    await db().query(
      `INSERT INTO accounts
         (id, company_id, email, account_scope, role, status, password_hash)
       VALUES ($1, $2, $3, 'TENANT', 'EMPLOYEE', 'ACTIVE', $7),
              ($4, $5, $6, 'TENANT', 'COMPANY_ADMIN', 'ACTIVE', $7)`,
      [
        fixture.accountA,
        fixture.companyA,
        `sp05-${randomUUID()}@secureplan.invalid`,
        fixture.accountB,
        fixture.companyB,
        `sp05-${randomUUID()}@secureplan.invalid`,
        VERIFIED_HASH,
      ],
    );

    // The test-only adapter binds SessionService's transaction callback to the
    // same client/transaction as the fixtures; no committed rows leak out.
    const isolatedDatabase = {
      withTransaction: async <T>(work: (tx: PoolClient) => Promise<T>): Promise<T> => work(db()),
    } as unknown as DatabaseService;
    service = new TestableSessionService(isolatedDatabase);
  });

  afterEach(async () => {
    if (!client) return;
    try {
      await client.query('ROLLBACK');
    } finally {
      client.release();
      client = undefined;
    }
  });

  it('01: stores SHA-256 token hash, not the raw cookie token', async () => {
    const created = await service.createForAccount(credentials());
    const digest = createHash('sha256').update(created.rawToken, 'utf8').digest();
    const result = await db().query<{
      token_hash: Buffer;
      csrf_secret: Buffer;
      created_at: Date;
      absolute_expires_at: Date;
    }>('SELECT token_hash, csrf_secret, created_at, absolute_expires_at FROM sessions WHERE token_hash = $1', [digest]);
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].token_hash).toEqual(digest);
    expect(result.rows[0].csrf_secret.toString('base64url')).toBe(created.csrfToken);
    expect(result.rows[0].absolute_expires_at.getTime() - result.rows[0].created_at.getTime()).toBe(7 * 24 * HOUR_MS);
  });

  it('02: creates distinct sessions for one account', async () => {
    const first = await service.createForAccount(credentials());
    const second = await service.createForAccount(credentials());
    expect(first.rawToken).not.toBe(second.rawToken);
    expect(first.csrfToken).not.toBe(second.csrfToken);
    const result = await db().query('SELECT id FROM sessions WHERE account_id = $1', [fixture.accountA]);
    expect(result.rowCount).toBe(2);
  });

  it('03: uses the ADMIN 12-hour absolute lifetime from the live role', async () => {
    const created = await service.createForAccount(credentials({
      companyId: fixture.companyB,
      accountId: fixture.accountB,
    }));
    expect(created.absoluteExpiresAt).toEqual(plus(12 * HOUR_MS));
  });

  it('04: refuses inactive accounts and companies', async () => {
    await db().query("UPDATE accounts SET status='DEACTIVATED' WHERE id = $1", [fixture.accountA]);
    await expectSessionError(service.createForAccount(credentials()), 'INVALID_CREDENTIALS');
    await db().query("UPDATE accounts SET status='ACTIVE' WHERE id = $1", [fixture.accountA]);
    await db().query("UPDATE companies SET status='SUSPENDED' WHERE id = $1", [fixture.companyA]);
    await expectSessionError(service.createForAccount(credentials()), 'INVALID_CREDENTIALS');
    // E2E files can run concurrently against the same PostgreSQL database.
    // Only sessions belonging to this test's two synthetic companies matter.
    const remaining = await db().query(
      'SELECT id FROM sessions WHERE company_id IN ($1, $2)',
      [fixture.companyA, fixture.companyB],
    );
    expect(remaining.rowCount).toBe(0);
  });

  it('05: rejects wrong tenant/account combination', async () => {
    await expectSessionError(service.createForAccount(credentials({ companyId: fixture.companyB })), 'INVALID_CREDENTIALS');
  });

  it('06: rejects credentials verified before a password-reset race', async () => {
    await db().query("UPDATE accounts SET password_hash = 'new-hash-after-reset' WHERE id = $1", [fixture.accountA]);
    await expectSessionError(service.createForAccount(credentials()), 'INVALID_CREDENTIALS');
  });

  it('07: validates and touches an active EMPLOYEE session', async () => {
    const created = await service.createForAccount(credentials());
    service.setTime(plus(HOUR_MS));
    const validated = await service.validateAndTouch(created.rawToken);
    expect(validated).toMatchObject({
      accountId: fixture.accountA,
      companyId: fixture.companyA,
      role: 'EMPLOYEE',
      csrfToken: created.csrfToken,
    });
    const result = await db().query<{last_seen_at: Date}>('SELECT last_seen_at FROM sessions WHERE id = $1', [validated.sessionId]);
    expect(result.rows[0].last_seen_at).toEqual(plus(HOUR_MS));
  });

  it('08: expires an EMPLOYEE after 8 hours idle (even though absolute expiry is later)', async () => {
    const created = await service.createForAccount(credentials());
    service.setTime(plus(8 * HOUR_MS));
    await expectSessionError(service.validateAndTouch(created.rawToken), 'SESSION_EXPIRED');
  });

  it('09: expires an ADMIN at absolute expiry even with recent activity', async () => {
    const created = await service.createForAccount(credentials({companyId: fixture.companyB, accountId: fixture.accountB}));
    // Create a recent activity row at minute 11h59 without extending absolute expiry.
    await db().query('UPDATE sessions SET last_seen_at = $1 WHERE account_id = $2', [plus(12 * HOUR_MS - 60_000), fixture.accountB]);
    service.setTime(plus(12 * HOUR_MS));
    await expectSessionError(service.validateAndTouch(created.rawToken), 'SESSION_EXPIRED');
  });

  it('10: revocation is permanent; an old cookie is rejected', async () => {
    const created = await service.createForAccount(credentials());
    expect(await service.revoke(created.rawToken)).toBe(true);
    expect(await service.revoke(created.rawToken)).toBe(false);
    await expectSessionError(service.validateAndTouch(created.rawToken), 'SESSION_REVOKED');
  });

  it('11: checks CURRENT role on each request (not role at login)', async () => {
    const created = await service.createForAccount(credentials());
    await db().query("UPDATE accounts SET role = 'COMPANY_ADMIN' WHERE id = $1", [fixture.accountA]);
    service.setTime(plus(31 * 60_000));
    await expectSessionError(service.validateAndTouch(created.rawToken), 'SESSION_EXPIRED');
  });

  it('12: rejects malformed and unknown tokens', async () => {
    await expectSessionError(service.validateAndTouch('malformed-token'), 'SESSION_REQUIRED');
    await expectSessionError(service.validateAndTouch(Buffer.alloc(32, 99).toString('base64url')), 'SESSION_REQUIRED');
  });

  it('13: compares separate CSRF tokens and rejects mismatch', async () => {
    const created = await service.createForAccount(credentials());
    expect(() => assertSessionCsrf(created.csrfToken, created.csrfToken)).not.toThrow();
    expect(() => assertSessionCsrf(undefined, created.csrfToken)).toThrow();
    expect(() => assertSessionCsrf(Buffer.alloc(32, 1).toString('base64url'), created.csrfToken)).toThrow();
    expect(created.rawToken).not.toBe(created.csrfToken);
  });

  it('14: can revoke every session inside a caller-owned account transaction', async () => {
    const first = await service.createForAccount(credentials());
    const second = await service.createForAccount(credentials());
    await db().query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [fixture.accountA]);
    const count = await service.revokeAllForAccountInTransaction(db(), fixture.companyA, fixture.accountA);
    expect(count).toBe(2);
    await expectSessionError(service.validateAndTouch(first.rawToken), 'SESSION_REVOKED');
    await expectSessionError(service.validateAndTouch(second.rawToken), 'SESSION_REVOKED');
  });

  it('15: denies sessions when the company is suspended after login', async () => {
    const created = await service.createForAccount(credentials());
    await db().query("UPDATE companies SET status = 'SUSPENDED' WHERE id = $1", [fixture.companyA]);
    await expectSessionError(service.validateAndTouch(created.rawToken), 'SESSION_REVOKED');
  });
});
