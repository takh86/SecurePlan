import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { DatabaseService } from '../src/database/database.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { generateAccountToken } from '../src/auth/account-token.js';
import { verifyPassword } from '../src/auth/password-hasher.js';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import type { PoolClient } from 'pg';
import { vi } from 'vitest';
import { PasswordPolicyService } from '../src/auth/password-policy.service.js';
import { ServiceUnavailableException } from '@nestjs/common';
import { PASSWORD_DENYLIST } from '../src/auth/local-password-denylist.js';
import { BusinessAuditService, type BusinessAuditEntry } from '../src/modules/audit/business-audit.service.js';

const PASSWORD = 'SecurePlan Strong Test Passphrase 2026!';

type FixtureOptions = {
  expired?: boolean;
  revoked?: boolean;
  purpose?: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';
  status?: 'PENDING_ACTIVATION' | 'ACTIVE' | 'DEACTIVATED';
  passwordHash?: string;
};

describe('SP-04 — Real account activation integration', () => {
  let database: DatabaseService;
  let authService: AuthService;
  let passwordPolicy: PasswordPolicyService;
  const assertAllowed = vi
    .fn<(password: string) => Promise<void>>()
    .mockResolvedValue(undefined);
  const fixtureCompanies: string[] = [];

  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      process.loadEnvFile('../../.env');
    }

    database = new DatabaseService();
    passwordPolicy = new PasswordPolicyService(new Set<string>());

    passwordPolicy.assertAllowed = assertAllowed;

    authService = new AuthService(database, passwordPolicy, new BusinessAuditService());
  });

  afterEach(async () => {
    assertAllowed.mockReset().mockResolvedValue(undefined);
    for (const companyId of fixtureCompanies.splice(0)) {
      await database.withTransaction(async (client) => {
        await client.query('DELETE FROM audit_event WHERE company_id = $1', [
          companyId,
        ]);

        await client.query('DELETE FROM account_tokens WHERE company_id = $1', [
          companyId,
        ]);

        await client.query('DELETE FROM accounts WHERE company_id = $1', [
          companyId,
        ]);

        await client.query('DELETE FROM companies WHERE id = $1', [companyId]);
      });
    }
  });

  afterAll(async () => {
    if (database) {
      await database.onApplicationShutdown();
    }
  });

  async function createFixture(options: FixtureOptions = {}) {
    const companyId = randomUUID();
    const accountId = randomUUID();
    const { rawToken, tokenHash } = generateAccountToken();

    const createdAt = new Date(Date.now() - 2 * 60 * 60_000);

    const expiresAt = options.expired
      ? new Date(Date.now() - 60 * 60_000)
      : new Date(Date.now() + 60 * 60_000);

    fixtureCompanies.push(companyId);

    await database.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO companies (id, name, status, time_zone)
         VALUES ($1, 'Activation Test', 'ACTIVE', 'Europe/Berlin')`,
        [companyId],
      );

      await client.query(
        `INSERT INTO accounts (
          id, company_id, email, account_scope, role, status, password_hash
        )
        VALUES (
          $1, $2, $3, 'TENANT', 'EMPLOYEE', $4, $5
        )`,
        [
          accountId,
          companyId,
          `${accountId}@secureplan.invalid`,
          options.status ?? 'PENDING_ACTIVATION',
          options.passwordHash ?? null,
        ],
      );

      await client.query(
        `INSERT INTO account_tokens (
          company_id,
          account_id,
          purpose,
          token_hash,
          created_at,
          expires_at,
          revoked_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          companyId,
          accountId,
          options.purpose ?? 'EMAIL_VERIFICATION',
          tokenHash,
          createdAt,
          expiresAt,
          options.revoked ? new Date() : null,
        ],
      );
    });

    return { companyId, accountId, rawToken };
  }

  async function getState(fixture: { companyId: string; accountId: string }) {
    return database.withTransaction(async (client) => {
      const account = await client.query<{
        status: string;
        password_hash: string | null;
        email_verified_at: Date | null;
      }>(
        `SELECT status, password_hash, email_verified_at
         FROM accounts
         WHERE id = $1`,
        [fixture.accountId],
      );

      const token = await client.query<{
        used_at: Date | null;
        revoked_at: Date | null;
        token_hash: Buffer;
      }>(
        `SELECT used_at, revoked_at, token_hash
        FROM account_tokens
        WHERE company_id = $1 AND account_id = $2`,
        [fixture.companyId, fixture.accountId],
      );
      const audit = await client.query<{
        old_values: unknown;
        new_values: unknown;
      }>(
        `SELECT old_values, new_values
         FROM audit_event
         WHERE company_id = $1
           AND resource_id = $2
           AND action = 'ACCOUNT_ACTIVATED'`,
        [fixture.companyId, fixture.accountId],
      );

      return {
        account: account.rows[0],
        token: token.rows[0],
        auditCount: audit.rows.length,
        auditValues: audit.rows,
      };
    });
  }

  /** Complete audit rows of the fixture account, for correlation and privacy checks. */
  async function auditRows(fixture: { companyId: string; accountId: string }) {
    const result = await database.withTransaction((client) =>
      client.query<{
        company_id: string;
        actor_account_id: string | null;
        action: string;
        resource_type: string;
        resource_id: string;
        old_values: unknown;
        new_values: unknown;
        correlation_id: string;
      }>(
        `SELECT company_id, actor_account_id, action, resource_type, resource_id,
                old_values, new_values, correlation_id
         FROM audit_event
         WHERE company_id = $1 AND resource_id = $2`,
        [fixture.companyId, fixture.accountId],
      ),
    );
    return result.rows;
  }

  const activationRequest = (token: string) => ({
    token,
    password: PASSWORD,
  });

  const invalidTokenError = {
    response: {
      code: 'ACTIVATION_TOKEN_INVALID_OR_EXPIRED',
    },
  };

  it('activates an account and consumes its token with an audit event', async () => {
    const fixture = await createFixture();

    await authService.activate(activationRequest(fixture.rawToken), randomUUID());

    const state = await getState(fixture);

    expect(state.account.status).toBe('ACTIVE');
    expect(state.account.email_verified_at).not.toBeNull();
    expect(state.account.password_hash).toMatch(/^\$argon2id\$/);

    expect(await verifyPassword(state.account.password_hash!, PASSWORD)).toBe(
      true,
    );

    expect(state.token.used_at).not.toBeNull();
    expect(state.auditCount).toBe(1);
    expect(state.token.token_hash.byteLength).toBe(32);
    expect(state.token.token_hash.equals(Buffer.from(fixture.rawToken))).toBe(
      false,
    );
    expect(state.auditValues).toEqual([
      {
        old_values: { status: 'PENDING_ACTIVATION' },
        new_values: { status: 'ACTIVE' },
      },
    ]);
  });

  it('records the activation through the audit service with the request correlation ID and no secrets', async () => {
    const fixture = await createFixture();
    const correlationId = randomUUID();

    await authService.activate(activationRequest(fixture.rawToken), correlationId);

    const rows = await auditRows(fixture);
    expect(rows).toEqual([
      {
        company_id: fixture.companyId,
        actor_account_id: fixture.accountId,
        action: 'ACCOUNT_ACTIVATED',
        resource_type: 'ACCOUNT',
        resource_id: fixture.accountId,
        old_values: { status: 'PENDING_ACTIVATION' },
        new_values: { status: 'ACTIVE' },
        correlation_id: correlationId,
      },
    ]);
    // Privacy: neither the password, the raw token, its hash, the password hash nor the e-mail address.
    const stored = JSON.stringify(rows);
    const { account } = await getState(fixture);
    for (const secret of [
      PASSWORD,
      fixture.rawToken,
      account.password_hash!,
      `${fixture.accountId}@secureplan.invalid`,
    ]) {
      expect(stored).not.toContain(secret);
    }
    expect(stored).not.toMatch(/argon2|token|password|email/i);
  });

  it('rolls back activation and token consumption when the audit service rejects', async () => {
    const fixture = await createFixture();
    class RejectingAudit extends BusinessAuditService {
      override recordBusinessAction(_client: unknown, entry: BusinessAuditEntry): Promise<void> {
        return Promise.reject(new Error(`Simulated ${entry.action} audit failure`));
      }
    }
    const service = new AuthService(database, passwordPolicy, new RejectingAudit());

    await expect(
      service.activate(activationRequest(fixture.rawToken), randomUUID()),
    ).rejects.toThrow('Simulated ACCOUNT_ACTIVATED audit failure');

    const state = await getState(fixture);
    expect(state.account.status).toBe('PENDING_ACTIVATION');
    expect(state.account.password_hash).toBeNull();
    expect(state.account.email_verified_at).toBeNull();
    expect(state.token.used_at).toBeNull();
    expect(state.auditCount).toBe(0);

    // The token stays usable: a later activation with a working audit succeeds.
    await authService.activate(activationRequest(fixture.rawToken), randomUUID());
    expect((await getState(fixture)).account.status).toBe('ACTIVE');
  });

  it('rejects replaying an already consumed token', async () => {
    const fixture = await createFixture();

    await authService.activate(activationRequest(fixture.rawToken), randomUUID());

    await expect(
      authService.activate(activationRequest(fixture.rawToken), randomUUID()),
    ).rejects.toMatchObject(invalidTokenError);

    const state = await getState(fixture);

    expect(state.account.status).toBe('ACTIVE');
    expect(state.auditCount).toBe(1);
  });

  it.each([
    {
      label: 'an expired token',
      options: { expired: true },
    },
    {
      label: 'a revoked token',
      options: { revoked: true },
    },
    {
      label: 'a PASSWORD_RESET token',
      options: { purpose: 'PASSWORD_RESET' as const },
    },
  ])('rejects $label without changing account state', async ({ options }) => {
    const fixture = await createFixture(options);

    await expect(
      authService.activate(activationRequest(fixture.rawToken), randomUUID()),
    ).rejects.toMatchObject(invalidTokenError);

    const state = await getState(fixture);

    expect(state.account.status).toBe('PENDING_ACTIVATION');
    expect(state.account.password_hash).toBeNull();
    expect(state.token.used_at).toBeNull();
    expect(state.auditCount).toBe(0);
  });

  it.each([
    { label: 'an active account', options: { status: 'ACTIVE' as const } },
    {
      label: 'a deactivated account',
      options: { status: 'DEACTIVATED' as const },
    },
    {
      label: 'an account with an existing password',
      options: { passwordHash: 'synthetic-existing-hash' },
    },
  ])('does not activate $label', async ({ options }) => {
    const fixture = await createFixture(options);
    const before = await getState(fixture);

    await expect(
      authService.activate(activationRequest(fixture.rawToken), randomUUID()),
    ).rejects.toMatchObject(invalidTokenError);

    const after = await getState(fixture);
    expect(after).toEqual(before);
    expect(assertAllowed).not.toHaveBeenCalled();
  });

  it.each(['malformed', 'c'.repeat(43)])(
    'rejects an unknown or malformed token before checking the password',
    async (token) => {
      await expect(
        authService.activate(activationRequest(token), randomUUID()),
      ).rejects.toMatchObject(invalidTokenError);
      expect(assertAllowed).not.toHaveBeenCalled();
    },
  );

  it.each(['expiry', 'revocation', 'deactivation'])(
    'rechecks %s after the password check',
    async (change) => {
      const fixture = await createFixture();
      assertAllowed.mockImplementationOnce(async () => {
        await database.withTransaction(async (client) => {
          if (change === 'deactivation') {
            await client.query(
              "UPDATE accounts SET status = 'DEACTIVATED' WHERE id = $1",
              [fixture.accountId],
            );
          } else if (change === 'expiry') {
            await client.query(
              "UPDATE account_tokens SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE account_id = $1",
              [fixture.accountId],
            );
          } else {
            await client.query(
              'UPDATE account_tokens SET revoked_at = clock_timestamp() WHERE account_id = $1',
              [fixture.accountId],
            );
          }
        });
      });

      await expect(
        authService.activate(activationRequest(fixture.rawToken), randomUUID()),
      ).rejects.toMatchObject(invalidTokenError);
      const state = await getState(fixture);
      expect(state.account.status).toBe(
        change === 'deactivation' ? 'DEACTIVATED' : 'PENDING_ACTIVATION',
      );
      expect(state.account.password_hash).toBeNull();
      expect(state.token.used_at).toBeNull();
      expect(state.auditCount).toBe(0);
    },
  );

  it('keeps the token usable after a fail-closed password check', async () => {
    const fixture = await createFixture();
    assertAllowed.mockRejectedValueOnce(
      new ServiceUnavailableException({ code: 'SERVICE_UNAVAILABLE' }),
    );

    await expect(
      authService.activate(activationRequest(fixture.rawToken), randomUUID()),
    ).rejects.toMatchObject({ status: 503 });
    const state = await getState(fixture);
    expect(state.account.status).toBe('PENDING_ACTIVATION');
    expect(state.account.password_hash).toBeNull();
    expect(state.token.used_at).toBeNull();
    expect(state.auditCount).toBe(0);

    await authService.activate(activationRequest(fixture.rawToken), randomUUID());
    expect((await getState(fixture)).account.status).toBe('ACTIVE');
  });

  it('allows exactly one concurrent activation', async () => {
    const fixture = await createFixture();
    const correlationIds = [randomUUID(), randomUUID()];

    const results = await Promise.allSettled(
      correlationIds.map((correlationId) =>
        authService.activate(activationRequest(fixture.rawToken), correlationId),
      ),
    );

    expect(results.map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);

    const failure = results.find((result) => result.status === 'rejected');

    if (failure?.status === 'rejected') {
      expect(failure.reason).toMatchObject(invalidTokenError);
    }

    const state = await getState(fixture);

    expect(state.account.status).toBe('ACTIVE');
    expect(state.token.used_at).not.toBeNull();
    expect(state.auditCount).toBe(1);
    expect(state.account.password_hash).toMatch(/^\$argon2id\$/);
    expect(state.token.revoked_at).toBeNull();
    // The single audit row belongs to the request that won.
    const winner = correlationIds[results.findIndex((result) => result.status === 'fulfilled')];
    expect((await auditRows(fixture)).map((row) => row.correlation_id)).toEqual([winner]);
  });
  it('activates an account through the real HTTP API', async () => {
    const fixture = await createFixture();

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PASSWORD_DENYLIST)
      .useValue(new Set<string>())
      .overrideProvider(PasswordPolicyService)
      .useValue(passwordPolicy)
      .compile();

    const app = moduleFixture.createNestApplication();
    configureApp(app);

    try {
      await app.init();

      const spoofed = '00000000-0000-4000-8000-000000000000';
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/activate')
        .set('X-Correlation-ID', spoofed)
        .send(activationRequest(fixture.rawToken))
        .expect(200);

      const state = await getState(fixture);

      expect(state.account.status).toBe('ACTIVE');
      expect(state.account.password_hash).toMatch(/^\$argon2id\$/);
      expect(state.token.used_at).not.toBeNull();
      expect(state.auditCount).toBe(1);
      // Public contract unchanged: 200 with an empty body. The audit row carries the
      // server-generated request ID from the response header, never the client's value.
      expect(response.text).toBe('');
      const correlationId: unknown = response.headers['x-correlation-id'];
      if (typeof correlationId !== 'string') throw new Error('Expected an X-Correlation-ID header');
      expect(correlationId).not.toBe(spoofed);
      expect((await auditRows(fixture)).map((row) => row.correlation_id)).toEqual([correlationId]);
    } finally {
      await app.close();
    }
  });
  it('rolls back activation when audit persistence fails', async () => {
    const fixture = await createFixture();

    // Inject a failure only when the service writes the audit event.
    // All other queries execute against the real PostgreSQL database.
    const failingDatabase = {
      withTransaction: <T>(
        work: (client: PoolClient) => Promise<T>,
      ): Promise<T> =>
        database.withTransaction(async (client) => {
          const testClient = new Proxy(client, {
            get(target, property) {
              if (property === 'query') {
                return (sql: string, values?: unknown[]) => {
                  if (/^\s*INSERT\s+INTO\s+audit_event\b/i.test(sql)) {
                    return Promise.reject(
                      new Error('Simulated audit write failure'),
                    );
                  }

                  return target.query(sql, values);
                };
              }

              return Reflect.get(target, property, target);
            },
          });

          return work(testClient);
        }),
    } as unknown as DatabaseService;

    const service = new AuthService(failingDatabase, passwordPolicy, new BusinessAuditService());

    await expect(
      service.activate(activationRequest(fixture.rawToken), randomUUID()),
    ).rejects.toThrow('Simulated audit write failure');

    const state = await getState(fixture);

    expect(state.account.status).toBe('PENDING_ACTIVATION');
    expect(state.account.password_hash).toBeNull();
    expect(state.account.email_verified_at).toBeNull();
    expect(state.token.used_at).toBeNull();
    expect(state.auditCount).toBe(0);
  });
});
