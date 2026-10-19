/** SP05-SEC-01 — real PostgreSQL limiter + real HTTP, mocked credentials.
 * Failures do not depend on password hashing latency or real accounts.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Test } from '@nestjs/testing';
import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { LoginService } from '../src/auth/login.service.js';
import { PASSWORD_DENYLIST } from '../src/auth/local-password-denylist.js';
import { configureApp } from '../src/configure-app.js';

const ORIGIN = 'https://localhost:8443';
const KEY = '93'.repeat(32); // Only for synthetic tests.
const { Pool } = pg;
let app: INestApplication<App> | undefined;
let db: InstanceType<typeof Pool>;
let email: string;
let oldOrigin: string | undefined;
let oldKey: string | undefined;
const fakeLogin = vi.fn().mockImplementation(() => {
  throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS' });
});

function keyForAccount(value: string): Buffer {
  return createHmac('sha256', Buffer.from(KEY, 'hex'))
    .update(`secureplan:login:ACCOUNT:v1\0${value}`).digest();
}
function keyForIp(value: string): Buffer {
  return createHmac('sha256', Buffer.from(KEY, 'hex'))
    .update(`secureplan:login:IP:v1\0${value}`).digest();
}
function payload() {
  return { email, password: 'Synthetic incorrect password' };
}
function postLogin() {
  return request(app!.getHttpServer()).post('/api/v1/auth/login')
    .set('Origin', ORIGIN).send(payload());
}
async function allowNextAttempt() {
  await db.query(
    `UPDATE login_abuse_counters SET next_allowed_at = clock_timestamp() - interval '1 second'
     WHERE scope = 'ACCOUNT' AND identifier_hash = $1`,
    [keyForAccount(email)],
  );
}

describe('SP05 SEC-01 — HTTP 429 with real DB counters', () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
    }
    if (!process.env.DATABASE_URL) throw new Error('Local DATABASE_URL missing');
    const host = new URL(process.env.DATABASE_URL).hostname;
    if (!['localhost', '127.0.0.1', '[::1]', 'postgres'].includes(host)) {
      throw new Error('Local database required for cleanup');
    }
    oldOrigin = process.env.APP_ORIGIN;
    oldKey = process.env.SECUREPLAN_LOGIN_HMAC_KEY;
    process.env.APP_ORIGIN = ORIGIN;
    process.env.SECUREPLAN_LOGIN_HMAC_KEY = KEY;
    db = new Pool({ connectionString: process.env.DATABASE_URL });
  });
  afterAll(async () => {
    await db?.end();
    if (oldOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = oldOrigin;
    if (oldKey === undefined) delete process.env.SECUREPLAN_LOGIN_HMAC_KEY;
    else process.env.SECUREPLAN_LOGIN_HMAC_KEY = oldKey;
  });
  afterEach(async () => {
    if (app) await app.close();
    await db.query('DELETE FROM login_abuse_counters WHERE scope=$1 AND identifier_hash=$2',
      ['ACCOUNT', keyForAccount(email)]);
    // Supertest connects to loopback, normalized from IPv4/IPv6-mapped address.
    for (const value of ['127.0.0.1', '::1']) {
      await db.query('DELETE FROM login_abuse_counters WHERE scope=$1 AND identifier_hash=$2',
        ['IP', keyForIp(value)]);
    }
  });

  it('01: initial invalid credentials return neutral 401; next attempt gets safe 429 + Retry-After', async () => {
    email = `sp05-${randomUUID()}@secureplan.invalid`;
    fakeLogin.mockClear();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PASSWORD_DENYLIST).useValue(new Set<string>())
      .overrideProvider(LoginService).useValue({ login: fakeLogin })
      .compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();

    const invalid = await postLogin().expect(401);
    expect(invalid.body.code).toBe('INVALID_CREDENTIALS');
    expect(invalid.text).not.toContain(payload().password);
    const limited = await postLogin().expect(429);
    expect(limited.body.code).toBe('LOGIN_RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(fakeLogin).toHaveBeenCalledTimes(1);
  });

  it('02: fifth failure enforces fixed-window limit across HTTP requests', async () => {
    email = `sp05-${randomUUID()}@secureplan.invalid`;
    fakeLogin.mockClear();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PASSWORD_DENYLIST).useValue(new Set<string>())
      .overrideProvider(LoginService).useValue({ login: fakeLogin })
      .compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();

    for (let i = 0; i < 5; i++) {
      const failed = await postLogin().expect(401);
      expect(failed.body.code).toBe('INVALID_CREDENTIALS');
      if (i < 4) await allowNextAttempt();
    }
    const limited = await postLogin().expect(429);
    expect(limited.body.code).toBe('LOGIN_RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(30);
    expect(fakeLogin).toHaveBeenCalledTimes(5);
  });
});
