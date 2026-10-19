/**
 * SecurePlan SP-05 — PostgreSQL session schema integration tests.
 * Requires migrations 0001–0004 to be applied.
 * All fixtures are synthetic. Every test transaction is rolled back.
 *
 * Run from repository root:
 * npm run test:e2e --workspace=backend -- session-persistence.e2e-spec.ts
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg, { type PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const { Pool } = pg;

type Fixture = {
  companyA: string;
  companyB: string;
  accountA: string;
  accountB: string;
};

let pool: InstanceType<typeof Pool> | undefined;
let client: PoolClient | undefined;
let fixture: Fixture;

function db(): PoolClient {
  if (!client) throw new Error('PostgreSQL test client not initialized');
  return client;
}

const insertSessionSql = `
  INSERT INTO sessions (
    company_id, account_id, token_hash, csrf_secret, absolute_expires_at
  )
  VALUES ($1, $2, $3, $4, NOW() + INTERVAL '12 hours')
  RETURNING id, account_id, revoked_at
`;

async function insertSession(
  companyId: string,
  accountId: string,
  hash: Buffer = randomBytes(32),
) {
  return db().query(insertSessionSql, [
    companyId,
    accountId,
    hash,
    randomBytes(32),
  ]);
}

async function expectDatabaseRejection(
  statement: Promise<unknown>,
  code: string,
  constraint: string,
): Promise<void> {
  // After a PostgreSQL statement fails, the transaction is aborted until ROLLBACK.
  // Each negative test makes its failing statement last.
  await expect(statement).rejects.toMatchObject({ code, constraint });
}

describe('SP-05 — Session persistence (real PostgreSQL)', () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      process.loadEnvFile(
        fileURLToPath(new URL('../../../.env', import.meta.url)),
      );
    }
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL required for PostgreSQL integration tests');
    }

    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 5000,
      max: 2,
    });

    const check = await pool.query(
      "SELECT to_regclass('public.sessions') AS session_table",
    );
    if (!check.rows[0]?.session_table) {
      throw new Error('Apply 0004_sessions.sql before running SP-05 tests');
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    if (!pool) throw new Error('PostgreSQL pool not initialized');
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
       VALUES ($1, 'SP05 Synthetic Company A', 'ACTIVE', 'Europe/Berlin'),
              ($2, 'SP05 Synthetic Company B', 'ACTIVE', 'Europe/Berlin')`,
      [fixture.companyA, fixture.companyB],
    );

    await db().query(
      `INSERT INTO accounts
         (id, company_id, email, account_scope, role, status)
       VALUES ($1, $2, $3, 'TENANT', 'EMPLOYEE', 'ACTIVE'),
              ($4, $5, $6, 'TENANT', 'EMPLOYEE', 'ACTIVE')`,
      [
        fixture.accountA,
        fixture.companyA,
        `sp05-a-${randomUUID()}@secureplan.invalid`,
        fixture.accountB,
        fixture.companyB,
        `sp05-b-${randomUUID()}@secureplan.invalid`,
      ],
    );
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

  it('01: accepts two sessions for the same account with different token hashes', async () => {
    const first = await insertSession(fixture.companyA, fixture.accountA);
    const second = await insertSession(fixture.companyA, fixture.accountA);

    expect(first.rowCount).toBe(1);
    expect(second.rowCount).toBe(1);
    expect(first.rows[0].id).not.toBe(second.rows[0].id);
    expect(first.rows[0].account_id).toBe(fixture.accountA);
    expect(second.rows[0].account_id).toBe(fixture.accountA);
    expect(first.rows[0].revoked_at).toBeNull();
  });

  it('02: rejects duplicate session token hashes (23505)', async () => {
    const hash = randomBytes(32);
    await insertSession(fixture.companyA, fixture.accountA, hash);

    await expectDatabaseRejection(
      insertSession(fixture.companyA, fixture.accountA, hash),
      '23505',
      'uq_sessions_token_hash',
    );
  });

  it('03: rejects a cross-tenant account/session association (23503)', async () => {
    await expectDatabaseRejection(
      insertSession(fixture.companyB, fixture.accountA),
      '23503',
      'fk_sessions_account',
    );
  });

  it('04: rejects token hashes not exactly 32 bytes long (23514)', async () => {
    await expectDatabaseRejection(
      insertSession(fixture.companyA, fixture.accountA, randomBytes(31)),
      '23514',
      'chk_sessions_token_hash_length',
    );
  });

  it('05: rejects absolute expiry earlier than creation (23514)', async () => {
    await expectDatabaseRejection(
      db().query(
        `INSERT INTO sessions
           (company_id, account_id, token_hash, csrf_secret, absolute_expires_at)
         VALUES ($1, $2, $3, $4, NOW() - INTERVAL '1 minute')`,
        [fixture.companyA, fixture.accountA, randomBytes(32), randomBytes(32)],
      ),
      '23514',
      'chk_sessions_absolute_expiry',
    );
  });

  it('06: rejects last_seen_at earlier than created_at (23514)', async () => {
    await expectDatabaseRejection(
      db().query(
        `INSERT INTO sessions
           (company_id, account_id, token_hash, csrf_secret, last_seen_at, absolute_expires_at)
         VALUES ($1, $2, $3, $4, NOW() - INTERVAL '1 minute', NOW() + INTERVAL '12 hours')`,
        [fixture.companyA, fixture.accountA, randomBytes(32), randomBytes(32)],
      ),
      '23514',
      'chk_sessions_last_seen',
    );
  });

  it('07: records revocation time for one session without altering another', async () => {
    const first = await insertSession(fixture.companyA, fixture.accountA);
    const second = await insertSession(fixture.companyA, fixture.accountA);

    const revoked = await db().query(
      'UPDATE sessions SET revoked_at = NOW() WHERE id = $1 RETURNING revoked_at',
      [first.rows[0].id],
    );
    expect(revoked.rows[0].revoked_at).toBeInstanceOf(Date);

    const other = await db().query(
      'SELECT revoked_at FROM sessions WHERE id = $1',
      [second.rows[0].id],
    );
    expect(other.rows[0].revoked_at).toBeNull();
  });

  it('08: exposes the approved account and expiry indexes', async () => {
    const result = await db().query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'sessions'`,
    );
    const names = result.rows.map((row: { indexname: string }) => row.indexname);
    expect(names).toContain('idx_sessions_account');
    expect(names).toContain('idx_sessions_absolute_expires');
    expect(names).toContain('uq_sessions_token_hash');
  });
});
