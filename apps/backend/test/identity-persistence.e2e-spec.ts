/**
 * SecurePlan SP-04 — PostgreSQL identity schema integration tests.
 * Requires migrations 0001 and 0002 to have been applied.
 * Each test runs in its own transaction and always rolls back.
 * Tests use synthetic fixture data only.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg, { type PoolClient } from 'pg';
// Vitest globals (describe/it/expect/hooks) are enabled in vitest.config.e2e.ts.

const { Pool } = pg;

type Fixture = {
  companyA: string;
  companyB: string;
  accountA: string;
  accountB: string;
  emailA: string;
};

let pool: InstanceType<typeof Pool> | undefined;
let client: PoolClient | undefined;
let fixture: Fixture;

function db(): PoolClient {
  if (!client) throw new Error('PostgreSQL test client is not initialized');
  return client;
}

async function expectConstraint(
  sql: string,
  values: unknown[],
  code: string,
  constraint: string,
): Promise<void> {
  // One failing statement per test: PostgreSQL can remain in the failed
  // transaction state until afterEach issues ROLLBACK.
  await expect(db().query(sql, values)).rejects.toMatchObject({
    code,
    constraint,
  });
}

async function expectNotNull(
  sql: string,
  values: unknown[],
  column: string,
): Promise<void> {
  await expect(db().query(sql, values)).rejects.toMatchObject({
    code: '23502',
    column,
  });
}

describe('SP-04 — Identity persistence (real PostgreSQL)', () => {
  beforeAll(async () => {
    // Existing e2e script doesn't load .env. Node 24 supports loadEnvFile.
    // CI can set DATABASE_URL directly, in which case we do not read a local file.
    if (!process.env.DATABASE_URL) {
      process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
    }
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required for identity persistence tests');
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 5000,
      max: 2,
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    if (!pool) throw new Error('PostgreSQL pool is not initialized');
    client = await pool.connect();
    await db().query('BEGIN');

    fixture = {
      companyA: randomUUID(),
      companyB: randomUUID(),
      accountA: randomUUID(),
      accountB: randomUUID(),
      emailA: `test-${randomUUID()}@secureplan.invalid`,
    };

    await db().query(
      `INSERT INTO companies (id, name, status, time_zone)
       VALUES ($1, 'Test Company A', 'ACTIVE', 'Europe/Berlin'),
              ($2, 'Test Company B', 'ACTIVE', 'Europe/Berlin')`,
      [fixture.companyA, fixture.companyB],
    );

    await db().query(
      `INSERT INTO accounts
         (id, company_id, email, account_scope, role, status)
       VALUES
         ($1, $2, $3, 'TENANT', 'COMPANY_ADMIN', 'PENDING_ACTIVATION'),
         ($4, $5, $6, 'TENANT', 'EMPLOYEE', 'PENDING_ACTIVATION')`,
      [
        fixture.accountA,
        fixture.companyA,
        fixture.emailA,
        fixture.accountB,
        fixture.companyB,
        `employee-${randomUUID()}@secureplan.invalid`,
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

  it('01: accepts valid companies, tenant accounts, and an activation token', async () => {
    const result = await db().query(
      `INSERT INTO account_tokens
         (company_id, account_id, purpose, token_hash, expires_at)
       VALUES ($1, $2, 'EMAIL_VERIFICATION', $3, now() + interval '24 hours')
       RETURNING purpose, octet_length(token_hash) AS hash_bytes`,
      [fixture.companyA, fixture.accountA, randomBytes(32)],
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]).toMatchObject({
      purpose: 'EMAIL_VERIFICATION',
      hash_bytes: 32,
    });
  });

  it('02: rejects an invalid company status', async () => {
    await expectConstraint(
      `INSERT INTO companies (name, status, time_zone)
       VALUES ('Invalid Company', 'BANANA', 'Europe/Berlin')`,
      [],
      '23514',
      'chk_companies_status',
    );
  });

  it('03: rejects a TENANT account without a company', async () => {
    await expectConstraint(
      `INSERT INTO accounts (email, account_scope, role, status)
       VALUES ($1, 'TENANT', 'EMPLOYEE', 'PENDING_ACTIVATION')`,
      [`no-company-${randomUUID()}@secureplan.invalid`],
      '23514',
      'chk_accounts_scope_role_company',
    );
  });

  it('04: rejects PLATFORM_ADMIN as a TENANT role', async () => {
    await expectConstraint(
      `INSERT INTO accounts (company_id, email, account_scope, role, status)
       VALUES ($1, $2, 'TENANT', 'PLATFORM_ADMIN', 'ACTIVE')`,
      [fixture.companyA, `bad-role-${randomUUID()}@secureplan.invalid`],
      '23514',
      'chk_accounts_scope_role_company',
    );
  });

  it('05: rejects a PLATFORM account linked to a company', async () => {
    await expectConstraint(
      `INSERT INTO accounts (company_id, email, account_scope, role, status)
       VALUES ($1, $2, 'PLATFORM', 'PLATFORM_ADMIN', 'ACTIVE')`,
      [fixture.companyA, `bad-platform-${randomUUID()}@secureplan.invalid`],
      '23514',
      'chk_accounts_scope_role_company',
    );
  });

  it('06: rejects the same email with different letter case across companies', async () => {
    await expectConstraint(
      `INSERT INTO accounts (company_id, email, account_scope, role, status)
       VALUES ($1, $2, 'TENANT', 'EMPLOYEE', 'ACTIVE')`,
      [fixture.companyB, fixture.emailA.toUpperCase()],
      '23505',
      'uq_accounts_email_lower',
    );
  });

  it('07: rejects a token referencing an account from another company', async () => {
    await expectConstraint(
      `INSERT INTO account_tokens
         (company_id, account_id, purpose, token_hash, expires_at)
       VALUES ($1, $2, 'EMAIL_VERIFICATION', $3, now() + interval '1 day')`,
      [fixture.companyA, fixture.accountB, randomBytes(32)],
      '23503',
      'fk_account_tokens_account',
    );
  });

  it('08: rejects a token hash shorter than 32 bytes', async () => {
    await expectConstraint(
      `INSERT INTO account_tokens
         (company_id, account_id, purpose, token_hash, expires_at)
       VALUES ($1, $2, 'EMAIL_VERIFICATION', $3, now() + interval '1 day')`,
      [fixture.companyA, fixture.accountA, randomBytes(31)],
      '23514',
      'chk_token_hash_length',
    );
  });

  it('09: rejects duplicate token hashes', async () => {
    const hash = randomBytes(32);
    await db().query(
      `INSERT INTO account_tokens
         (company_id, account_id, purpose, token_hash, expires_at)
       VALUES ($1, $2, 'EMAIL_VERIFICATION', $3, now() + interval '1 day')`,
      [fixture.companyA, fixture.accountA, hash],
    );
    await expectConstraint(
      `INSERT INTO account_tokens
         (company_id, account_id, purpose, token_hash, expires_at)
       VALUES ($1, $2, 'PASSWORD_RESET', $3, now() + interval '30 minutes')`,
      [fixture.companyA, fixture.accountA, hash],
      '23505',
      'uq_account_tokens_token_hash',
    );
  });

  it('10: rejects a token purpose outside the approved naming', async () => {
    await expectConstraint(
      `INSERT INTO account_tokens
         (company_id, account_id, purpose, token_hash, expires_at)
       VALUES ($1, $2, 'ACTIVATION', $3, now() + interval '1 day')`,
      [fixture.companyA, fixture.accountA, randomBytes(32)],
      '23514',
      'chk_account_tokens_purpose',
    );
  });

  it('11: rejects a token expiry earlier than its creation', async () => {
    await expectConstraint(
      `INSERT INTO account_tokens
         (company_id, account_id, purpose, token_hash, expires_at)
       VALUES ($1, $2, 'PASSWORD_RESET', $3, now() - interval '1 minute')`,
      [fixture.companyA, fixture.accountA, randomBytes(32)],
      '23514',
      'chk_account_tokens_expiry',
    );
  });

  it('12: requires company_id on token records', async () => {
    await expectNotNull(
      `INSERT INTO account_tokens
         (account_id, purpose, token_hash, expires_at)
       VALUES ($1, 'EMAIL_VERIFICATION', $2, now() + interval '1 day')`,
      [fixture.accountA, randomBytes(32)],
      'company_id',
    );
  });

  it('13: requires account_id on token records', async () => {
    await expectNotNull(
      `INSERT INTO account_tokens
         (company_id, purpose, token_hash, expires_at)
       VALUES ($1, 'EMAIL_VERIFICATION', $2, now() + interval '1 day')`,
      [fixture.companyA, randomBytes(32)],
      'account_id',
    );
  });

  it('14: rejects invalid account status', async () => {
    await expectConstraint(
      `INSERT INTO accounts (company_id, email, account_scope, role, status)
       VALUES ($1, $2, 'TENANT', 'EMPLOYEE', 'BANANA')`,
      [fixture.companyA, `bad-status-${randomUUID()}@secureplan.invalid`],
      '23514',
      'chk_accounts_status',
    );
  });

  it('15: accepts a PLATFORM account without a company', async () => {
    const result = await db().query(
      `INSERT INTO accounts (company_id, email, account_scope, role, status)
       VALUES (NULL, $1, 'PLATFORM', 'PLATFORM_ADMIN', 'ACTIVE')
       RETURNING company_id, account_scope, role`,
      [`platform-${randomUUID()}@secureplan.invalid`],
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]).toMatchObject({
      company_id: null,
      account_scope: 'PLATFORM',
      role: 'PLATFORM_ADMIN',
    });
  });
});
