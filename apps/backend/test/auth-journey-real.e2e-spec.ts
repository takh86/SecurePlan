/**
 * SecurePlan SP-05 — Real HTTP -> NestJS -> PostgreSQL auth journey.
 *
 * Synthetic fixtures only. Writes are committed for cross-connection HTTP
 * requests, then removed with a per-test cleanup transaction.
 *
 * This test deliberately forwards Secure cookies through Supertest over HTTP
 * to exercise server-side behavior. It is NOT browser/TLS verification.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { hashPassword } from '../src/auth/password-hasher.js';
import { PASSWORD_DENYLIST } from '../src/auth/local-password-denylist.js';

const { Pool } = pg;
const ORIGIN = 'https://localhost:8443';
const PASSWORD = 'SP05 Synthetic Journey Passphrase 2026!';
const COOKIE_NAME = '__Host-secureplan_session';
// Dedicated synthetic key for this test file. Never used for live accounts.
// Isolated from the other SEC-01 tests and local runtime counters.
const TEST_HMAC_KEY = '95'.repeat(32);

function counterDigest(scope: 'ACCOUNT' | 'IP', identifier: string): Buffer {
  return createHmac('sha256', Buffer.from(TEST_HMAC_KEY, 'hex'))
    .update(`secureplan:login:${scope}:v1\0${identifier}`)
    .digest();
}

type Fixture = {
  companyId: string;
  accountId: string;
  email: string;
};

let pool: InstanceType<typeof Pool> | undefined;
let app: INestApplication<App> | undefined;
let fixture: Fixture | undefined;
let passwordHash: string;
let previousOrigin: string | undefined;
let previousHmacKey: string | undefined;

function db(): InstanceType<typeof Pool> {
  if (!pool) throw new Error('Test database is not ready');
  return pool;
}
function http(): INestApplication<App> {
  if (!app) throw new Error('Test app is not ready');
  return app;
}
function credentials() {
  if (!fixture) throw new Error('Test fixture is not ready');
  return { email: fixture.email, password: PASSWORD };
}

function cookieFromLogin(response: { headers: Record<string, unknown> }): { cookie: string; token: string } {
  const header = response.headers['set-cookie'];
  const first = Array.isArray(header) ? header[0] : header;
  if (typeof first !== 'string') throw new Error('Expected Set-Cookie header');
  expect(first).toContain('HttpOnly');
  expect(first).toContain('Secure');
  expect(first).toContain('SameSite=Lax');
  expect(first).toContain('Path=/');
  expect(first).not.toMatch(/(?:^|;)\s*Domain=/i);
  const cookie = first.split(';', 1)[0];
  const prefix = `${COOKIE_NAME}=`;
  expect(cookie.startsWith(prefix)).toBe(true);
  const token = cookie.slice(prefix.length);
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return { cookie, token };
}

async function login() {
  const response = await request(http().getHttpServer())
    .post('/api/v1/auth/login')
    .set('Origin', ORIGIN)
    .send(credentials())
    .expect(200);
  const { cookie, token } = cookieFromLogin(response);
  const csrf = response.headers['x-csrf-token'];
  expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(csrf).not.toBe(token);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).toEqual({
    accountId: fixture!.accountId,
    companyId: fixture!.companyId,
    email: fixture!.email,
    role: 'EMPLOYEE',
  });
  expect(response.text).not.toContain(token);
  expect(response.text).not.toContain(csrf);
  return { cookie, token, csrf: csrf as string };
}

async function countSessions(): Promise<number> {
  const result = await db().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM sessions WHERE company_id = $1 AND account_id = $2',
    [fixture!.companyId, fixture!.accountId],
  );
  return Number(result.rows[0].count);
}

describe('SP-05 — Full authentication journey (real PostgreSQL)', () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
    }
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    // Destructive fixture cleanup is allowed only against a local/test DB.
    // For a remote CI database, introduce an explicit, reviewed test-only gate.
    const databaseHost = new URL(process.env.DATABASE_URL).hostname;
    if (!['localhost', '127.0.0.1', '[::1]', 'postgres'].includes(databaseHost)) {
      throw new Error('SP-05 integration tests require a local PostgreSQL instance');
    }
    previousOrigin = process.env.APP_ORIGIN;
    previousHmacKey = process.env.SECUREPLAN_LOGIN_HMAC_KEY;
    process.env.APP_ORIGIN = ORIGIN;
    process.env.SECUREPLAN_LOGIN_HMAC_KEY = TEST_HMAC_KEY;
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 5000 });
    passwordHash = await hashPassword(PASSWORD);
  });

  afterAll(async () => {
    await pool?.end();
    if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = previousOrigin;
    if (previousHmacKey === undefined) delete process.env.SECUREPLAN_LOGIN_HMAC_KEY;
    else process.env.SECUREPLAN_LOGIN_HMAC_KEY = previousHmacKey;
  });

  beforeEach(async () => {
    fixture = {
      companyId: randomUUID(),
      accountId: randomUUID(),
      email: `sp05-${randomUUID()}@secureplan.invalid`,
    };

    // Real HTTP handlers use independent pooled DB connections. Fixture
    // creation must therefore commit BEFORE issuing HTTP requests.
    const client = await db().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO companies (id, name, status, time_zone)
         VALUES ($1, 'SP05 Synthetic Integration', 'ACTIVE', 'Europe/Berlin')`,
        [fixture.companyId],
      );
      await client.query(
        `INSERT INTO accounts
           (id, company_id, email, account_scope, role, status, password_hash)
         VALUES ($1, $2, $3, 'TENANT', 'EMPLOYEE', 'ACTIVE', $4)`,
        [fixture.accountId, fixture.companyId, fixture.email, passwordHash],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    // Only bypass the unrelated activation-password denylist fixture.
    // LoginService, SessionService, their SQL and guards remain REAL.
    const testingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PASSWORD_DENYLIST)
      .useValue(new Set<string>())
      .compile();
    app = testingModule.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(async () => {
    try {
      if (app) await app.close();
    } finally {
      app = undefined;
    }

    if (!fixture || !pool) return;
    const client = await db().connect();
    try {
      await client.query('BEGIN');
      // Remove only synthetic test-key buckets, never live local-runtime counters.
      await client.query(
        `DELETE FROM login_abuse_counters
         WHERE scope = 'ACCOUNT' AND identifier_hash = $1`,
        [counterDigest('ACCOUNT', fixture.email.trim().toLowerCase())],
      );
      for (const peer of ['127.0.0.1', '::1']) {
        await client.query(
          `DELETE FROM login_abuse_counters
           WHERE scope = 'IP' AND identifier_hash = $1`,
          [counterDigest('IP', peer)],
        );
      }
      await client.query('DELETE FROM sessions WHERE company_id = $1', [fixture.companyId]);
      await client.query('DELETE FROM account_tokens WHERE company_id = $1', [fixture.companyId]);
      await client.query('DELETE FROM audit_event WHERE company_id = $1', [fixture.companyId]);
      await client.query('DELETE FROM accounts WHERE company_id = $1', [fixture.companyId]);
      await client.query('DELETE FROM companies WHERE id = $1', [fixture.companyId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
      fixture = undefined;
    }
  });

  it('01: login -> /me -> logout -> old cookie is rejected', async () => {
    const session = await login();
    expect(await countSessions()).toBe(1);

    const stored = await db().query<{ token_hash: Buffer; revoked_at: Date | null }>(
      'SELECT token_hash, revoked_at FROM sessions WHERE company_id = $1 AND account_id = $2',
      [fixture!.companyId, fixture!.accountId],
    );
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0].token_hash).toEqual(createHash('sha256').update(session.token).digest());
    expect(stored.rows[0].revoked_at).toBeNull();

    const me = await request(http().getHttpServer())
      .get('/api/v1/me').set('Cookie', session.cookie).expect(200);
    expect(me.body).toEqual({
      accountId: fixture!.accountId,
      companyId: fixture!.companyId,
      email: fixture!.email,
      role: 'EMPLOYEE',
    });
    expect(me.headers['x-csrf-token']).toBe(session.csrf);
    expect(me.text).not.toContain(session.token);

    const loggedOut = await request(http().getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Origin', ORIGIN)
      .set('Cookie', session.cookie)
      .set('X-CSRF-Token', session.csrf)
      .send({})
      .expect(204);
    expect(loggedOut.text).toBe('');
    const cleared = loggedOut.headers['set-cookie'];
    const clearedHeader = Array.isArray(cleared) ? cleared[0] : cleared;
    expect(clearedHeader).toContain(`${COOKIE_NAME}=;`);
    expect(clearedHeader).toContain('Max-Age=0');

    const after = await db().query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM sessions WHERE company_id = $1 AND account_id = $2',
      [fixture!.companyId, fixture!.accountId],
    );
    expect(after.rows[0].revoked_at).not.toBeNull();
    const replay = await request(http().getHttpServer())
      .get('/api/v1/me').set('Cookie', session.cookie).expect(401);
    expect(replay.body.code).toBe('SESSION_REVOKED');
  });

  it('02: rejected CSRF never revokes; correct CSRF succeeds afterward', async () => {
    const session = await login();
    const denied = await request(http().getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Origin', ORIGIN)
      .set('Cookie', session.cookie)
      .set('X-CSRF-Token', 'x'.repeat(43))
      .send({})
      .expect(403);
    expect(denied.body.code).toBe('CSRF_VALIDATION_FAILED');

    const active = await db().query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM sessions WHERE company_id = $1 AND account_id = $2',
      [fixture!.companyId, fixture!.accountId],
    );
    expect(active.rows[0].revoked_at).toBeNull();
    await request(http().getHttpServer())
      .get('/api/v1/me').set('Cookie', session.cookie).expect(200);

    await request(http().getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Origin', ORIGIN).set('Cookie', session.cookie)
      .set('X-CSRF-Token', session.csrf).send({}).expect(204);
  });

  it('03: account deactivation blocks an already-open session', async () => {
    const session = await login();
    await db().query(
      "UPDATE accounts SET status = 'DEACTIVATED' WHERE id = $1 AND company_id = $2",
      [fixture!.accountId, fixture!.companyId],
    );
    const response = await request(http().getHttpServer())
      .get('/api/v1/me').set('Cookie', session.cookie).expect(401);
    expect(response.body.code).toBe('SESSION_REVOKED');
  });

  it('04: logout revokes only the presented session, not another device', async () => {
    const first = await login();
    const second = await login();
    expect(second.token).not.toBe(first.token);
    expect(await countSessions()).toBe(2);

    await request(http().getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Origin', ORIGIN).set('Cookie', first.cookie)
      .set('X-CSRF-Token', first.csrf).send({}).expect(204);

    await request(http().getHttpServer())
      .get('/api/v1/me').set('Cookie', first.cookie).expect(401);
    await request(http().getHttpServer())
      .get('/api/v1/me').set('Cookie', second.cookie).expect(200);
  });

  it('05: bad password yields neutral 401 and no new session', async () => {
    const response = await request(http().getHttpServer())
      .post('/api/v1/auth/login').set('Origin', ORIGIN)
      .send({ ...credentials(), password: 'not-the-right-password' })
      .expect(401);
    expect(response.body.code).toBe('INVALID_CREDENTIALS');
    expect(response.text).not.toContain(PASSWORD);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(await countSessions()).toBe(0);
  });

  it('06: absent Origin is rejected without creating a session', async () => {
    const response = await request(http().getHttpServer())
      .post('/api/v1/auth/login').send(credentials()).expect(403);
    expect(response.body.code).toBe('CSRF_VALIDATION_FAILED');
    expect(await countSessions()).toBe(0);
  });
});
