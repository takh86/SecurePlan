/** SP-05 — real-PostgreSQL LoginService tests; synthetic and rollback-only. */
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg, { type PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../src/database/database.service.js';
import { SessionService } from '../src/auth/session.service.js';
import { LoginService } from '../src/auth/login.service.js';
import { hashPassword } from '../src/auth/password-hasher.js';

const { Pool } = pg;
const PASSWORD = 'SecurePlan Synthetic Test Password 2026!';
let pool: InstanceType<typeof Pool> | undefined;
let client: PoolClient | undefined;
let passwordHash: string;
let companyId: string;
let accountId: string;
let service: LoginService;

function db(): PoolClient {
  if (!client) throw new Error('No open test transaction');
  return client;
}

const invalidCredentials = { response: { code: 'INVALID_CREDENTIALS' } };
const loginDto = () => ({ email: 'test@secureplan.invalid', password: PASSWORD });

describe('SP-05 — LoginService (real PostgreSQL)', () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
    }
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    passwordHash = await hashPassword(PASSWORD);
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    if (!pool) throw new Error('Missing PostgreSQL pool');
    client = await pool.connect();
    await db().query('BEGIN');
    companyId = randomUUID();
    accountId = randomUUID();
    await db().query(
      `INSERT INTO companies (id, name, status, time_zone)
       VALUES ($1, 'Synthetic Login Test', 'ACTIVE', 'Europe/Berlin')`,
      [companyId],
    );
    await db().query(
      `INSERT INTO accounts
         (id, company_id, email, account_scope, role, status, password_hash)
       VALUES ($1, $2, $3, 'TENANT', 'EMPLOYEE', 'ACTIVE', $4)`,
      [accountId, companyId, 'test@secureplan.invalid', passwordHash],
    );

    // Bind existing services to the fixture's rollback-only transaction.
    const transactionAdapter = {
      withTransaction: async <T>(work: (tx: PoolClient) => Promise<T>): Promise<T> => work(db()),
    } as DatabaseService;
    service = new LoginService(transactionAdapter, new SessionService(transactionAdapter));
  });

  afterEach(async () => {
    if (!client) return;
    try {
      await db().query('ROLLBACK');
    } finally {
      client.release();
      client = undefined;
    }
  });

  it('01: valid credentials create a fresh server-side session', async () => {
    const identity = await service.login(loginDto());
    expect(identity).toMatchObject({ accountId, companyId, role: 'EMPLOYEE' });
    expect(identity.rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(identity.csrfToken).not.toEqual(identity.rawToken);
    const hash = createHash('sha256').update(identity.rawToken).digest();
    const stored = await db().query<{ token_hash: Buffer }>(
      'SELECT token_hash FROM sessions WHERE company_id = $1 AND account_id = $2',
      [companyId, accountId],
    );
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0].token_hash).toEqual(hash);
  });

  it('02: wrong password gets neutral 401 and creates no session', async () => {
    await expect(service.login({ ...loginDto(), password: 'wrong password' }))
      .rejects.toMatchObject(invalidCredentials);
    const result = await db().query('SELECT id FROM sessions WHERE account_id = $1', [accountId]);
    expect(result.rowCount).toBe(0);
  });

  it('03: unknown email gets same error without creating a session', async () => {
    await expect(service.login({ ...loginDto(), email: 'missing@secureplan.invalid' }))
      .rejects.toMatchObject(invalidCredentials);
  });

  it('04: inactive account gets same error', async () => {
    await db().query("UPDATE accounts SET status = 'DEACTIVATED' WHERE id = $1", [accountId]);
    await expect(service.login(loginDto())).rejects.toMatchObject(invalidCredentials);
  });

  it('05: suspended company gets same error', async () => {
    await db().query("UPDATE companies SET status = 'SUSPENDED' WHERE id = $1", [companyId]);
    await expect(service.login(loginDto())).rejects.toMatchObject(invalidCredentials);
  });

  it('06: case-insensitive email is accepted', async () => {
    const identity = await service.login({ ...loginDto(), email: 'TEST@SECUREPLAN.INVALID' });
    expect(identity.accountId).toBe(accountId);
  });
});
