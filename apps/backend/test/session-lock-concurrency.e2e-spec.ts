/**
 * SP-05 SEC-02: real PostgreSQL row-lock compatibility tests.
 * Requires local SecurePlan PostgreSQL with migration 0004 applied.
 * Fixtures are synthetic and cleaned up by company_id.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg, { type PoolClient } from 'pg';
import {
  afterAll, afterEach, beforeAll, beforeEach, describe, expect, it,
} from 'vitest';
import type { DatabaseService } from '../src/database/database.service.js';
import { SessionService } from '../src/auth/session.service.js';

const { Pool } = pg;
const PASSWORD_HASH = 'synthetic-lock-test-verified-hash';

type Fixture = {
  companyId: string;
  accountA: string;
  accountB: string;
};

let pool: InstanceType<typeof Pool> | undefined;
let fixture: Fixture | undefined;
let sessions: SessionService;

function database(): InstanceType<typeof Pool> {
  if (!pool) throw new Error('Test database is unavailable');
  return pool;
}

async function withTransaction<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await database().connect();
  try {
    await client.query('BEGIN');
    // This timeout detects unexpected row-lock waits without relying on
    // arbitrary wall-clock performance assertions.
    await client.query("SET LOCAL lock_timeout = '1500ms'");
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function withHeldCompanyShare(
  work: () => Promise<void>,
): Promise<void> {
  const blocker = await database().connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT id FROM companies WHERE id = $1 FOR SHARE',
      [fixture!.companyId],
    );
    // While this transaction holds FOR SHARE, another FOR SHARE should be
    // compatible. FOR UPDATE of the same company row would time out.
    await work();
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    blocker.release();
  }
}

function forAccount(accountId: string) {
  return {
    accountId,
    companyId: fixture!.companyId,
    verifiedPasswordHash: PASSWORD_HASH,
  };
}

describe('SP-05 SEC-02 — company locking (real PostgreSQL)', () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
    }
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing');
    const target = new URL(process.env.DATABASE_URL);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ||
      target.pathname !== '/secureplan'
    ) {
      throw new Error('This test requires local SecurePlan PostgreSQL');
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 6,
      connectionTimeoutMillis: 5000,
    });
    // Only the transaction wrapper is test-specific; all SQL inside
    // SessionService runs unchanged against the real database.
    sessions = new SessionService({ withTransaction } as unknown as DatabaseService);
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    fixture = {
      companyId: randomUUID(),
      accountA: randomUUID(),
      accountB: randomUUID(),
    };
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO companies (id, name, status, time_zone)
         VALUES ($1, 'SP05 Synthetic Lock Test', 'ACTIVE', 'Europe/Berlin')`,
        [fixture!.companyId],
      );
      await client.query(
        `INSERT INTO accounts
           (id, company_id, email, account_scope, role, status, password_hash)
         VALUES
           ($1, $3, $4, 'TENANT', 'EMPLOYEE', 'ACTIVE', $6),
           ($2, $3, $5, 'TENANT', 'EMPLOYEE', 'ACTIVE', $6)`,
        [
          fixture!.accountA,
          fixture!.accountB,
          fixture!.companyId,
          `sp05-lock-${randomUUID()}@secureplan.invalid`,
          `sp05-lock-${randomUUID()}@secureplan.invalid`,
          PASSWORD_HASH,
        ],
      );
    });
  });

  afterEach(async () => {
    if (!fixture || !pool) return;
    try {
      await withTransaction(async (client) => {
        await client.query('DELETE FROM sessions WHERE company_id = $1', [fixture!.companyId]);
        await client.query('DELETE FROM accounts WHERE company_id = $1', [fixture!.companyId]);
        await client.query('DELETE FROM companies WHERE id = $1', [fixture!.companyId]);
      });
    } finally {
      fixture = undefined;
    }
  });

  it('01: two concurrent session creations do not require a company-exclusive lock', async () => {
    await withHeldCompanyShare(async () => {
      const [first, second] = await Promise.all([
        sessions.createForAccount(forAccount(fixture!.accountA)),
        sessions.createForAccount(forAccount(fixture!.accountB)),
      ]);
      expect(first.rawToken).not.toBe(second.rawToken);
    });
    const count = await database().query<{ count: string }>(
      'SELECT count(*)::text AS count FROM sessions WHERE company_id = $1',
      [fixture!.companyId],
    );
    expect(Number(count.rows[0].count)).toBe(2);
  });

  it('02: two concurrent validations share the company lock while touching independent sessions', async () => {
    const first = await sessions.createForAccount(forAccount(fixture!.accountA));
    const second = await sessions.createForAccount(forAccount(fixture!.accountB));

    await withHeldCompanyShare(async () => {
      const validated = await Promise.all([
        sessions.validateAndTouch(first.rawToken),
        sessions.validateAndTouch(second.rawToken),
      ]);
      expect(validated.map((v) => v.accountId).sort()).toEqual(
        [fixture!.accountA, fixture!.accountB].sort(),
      );
    });
  });

  it('03: a shared company lock blocks a concurrent status UPDATE', async () => {
    const holder = await database().connect();
    const writer = await database().connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT id FROM companies WHERE id = $1 FOR SHARE',
        [fixture!.companyId],
      );
      await writer.query('BEGIN');
      await writer.query("SET LOCAL lock_timeout = '250ms'");
      await expect(writer.query(
        "UPDATE companies SET status = 'SUSPENDED' WHERE id = $1",
        [fixture!.companyId],
      )).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await writer.query('ROLLBACK').catch(() => {});
      await holder.query('ROLLBACK').catch(() => {});
      writer.release();
      holder.release();
    }
  });

  it('04: a committed company suspension still revokes existing session access', async () => {
    const created = await sessions.createForAccount(forAccount(fixture!.accountA));
    await withTransaction((client) => client.query(
      "UPDATE companies SET status = 'SUSPENDED' WHERE id = $1",
      [fixture!.companyId],
    ).then(() => undefined));

    await expect(sessions.validateAndTouch(created.rawToken)).rejects.toMatchObject({
      response: { code: 'SESSION_REVOKED' },
    });
    await expect(sessions.createForAccount(forAccount(fixture!.accountB))).rejects.toMatchObject({
      response: { code: 'INVALID_CREDENTIALS' },
    });
  });
});
