/** SP05-SEC-01 — real PostgreSQL, synthetic identifiers, no real user data.
 * Validates shared atomic counters independently of the HTTP mock boundary.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/database/database.service.js';
import { LoginAbuseService, LoginRateLimitedError } from '../src/auth/login-abuse.service.js';

const KEY = '91'.repeat(32); // Synthetic test-only HMAC key; never use in deployment.
let db: DatabaseService;
let dbSecond: DatabaseService;
let limiterA: LoginAbuseService;
let limiterB: LoginAbuseService;
let email: string;
let ip: string;
let previousKey: string | undefined;
const tracked = new Set<string>();

function digest(scope: 'ACCOUNT' | 'IP', value: string): Buffer {
  return createHmac('sha256', Buffer.from(KEY, 'hex'))
    .update(`secureplan:login:${scope}:v1\0${value}`).digest();
}
function trackEmail(value: string): string {
  tracked.add(`ACCOUNT:${value}`);
  return value;
}
function trackIp(value: string): string {
  tracked.add(`IP:${value}`);
  return value;
}
async function state(scope: 'ACCOUNT' | 'IP', value: string) {
  return db.withTransaction(async (client) => {
    const result = await client.query<{
      attempts: number; failures: number; pending: number;
      next_allowed_at: Date | null; identifier_hash: Buffer;
    }>(
      `SELECT attempts, failures, pending, next_allowed_at, identifier_hash
       FROM login_abuse_counters WHERE scope=$1 AND identifier_hash=$2`,
      [scope, digest(scope, value)],
    );
    return result.rows[0];
  });
}
async function clearCooldown(): Promise<void> {
  await db.withTransaction(async (client) => {
    await client.query(
      `UPDATE login_abuse_counters SET next_allowed_at = clock_timestamp() - interval '1 second'
       WHERE scope='ACCOUNT' AND identifier_hash=$1`,
      [digest('ACCOUNT', email)],
    );
  });
}
async function attemptFailure(service = limiterA): Promise<void> {
  const ticket = await service.beginAttempt(email, ip);
  await service.finishAttempt(ticket, 'failure');
}
async function assertBlocked(call: Promise<unknown>): Promise<LoginRateLimitedError> {
  try {
    await call;
  } catch (caught) {
    expect(caught).toBeInstanceOf(LoginRateLimitedError);
    const error = caught as LoginRateLimitedError;
    expect(error.getStatus()).toBe(429);
    expect(error.getResponse()).toEqual({ code: 'LOGIN_RATE_LIMITED' });
    expect(error.retryAfterSeconds).toBeGreaterThan(0);
    return error;
  }
  throw new Error('Expected LOGIN_RATE_LIMITED');
}

describe('SP05 SEC-01 — PostgreSQL login rate limiting', () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
    }
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing');
    const host = new URL(process.env.DATABASE_URL).hostname;
    if (!['localhost', '127.0.0.1', '[::1]', 'postgres'].includes(host)) {
      throw new Error('Only the local/CI test database may be used');
    }
    previousKey = process.env.SECUREPLAN_LOGIN_HMAC_KEY;
    process.env.SECUREPLAN_LOGIN_HMAC_KEY = KEY;
    db = new DatabaseService();
    limiterA = new LoginAbuseService(db);
    // A second service instance uses the same PostgreSQL counters.
    dbSecond = new DatabaseService();
    limiterB = new LoginAbuseService(dbSecond);
  });
  beforeEach(() => {
    tracked.clear();
    email = trackEmail(`sp05-${randomUUID()}@secureplan.invalid`);
    ip = trackIp('198.51.100.23');
  });
  afterEach(async () => {
    for (const entry of tracked) {
      const colon = entry.indexOf(':');
      const scope = entry.slice(0, colon) as 'ACCOUNT' | 'IP';
      const value = entry.slice(colon + 1);
      await db.withTransaction(async (client) => {
        await client.query(
          'DELETE FROM login_abuse_counters WHERE scope=$1 AND identifier_hash=$2',
          [scope, digest(scope, value)],
        );
      });
    }
  });
  afterAll(async () => {
    await db?.onApplicationShutdown();
    await dbSecond?.onApplicationShutdown();
    if (previousKey === undefined) delete process.env.SECUREPLAN_LOGIN_HMAC_KEY;
    else process.env.SECUREPLAN_LOGIN_HMAC_KEY = previousKey;
  });

  it('01: stores only 32-byte HMAC identifiers, not plaintext emails/IPs', async () => {
    const ticket = await limiterA.beginAttempt(email, ip);
    await limiterA.finishAttempt(ticket, 'failure');
    expect((await state('ACCOUNT', email)).identifier_hash.byteLength).toBe(32);
    expect((await state('IP', ip)).identifier_hash.byteLength).toBe(32);
    expect((await state('ACCOUNT', email)).failures).toBe(1);
  });

  it('02: exponential delay is enforced without sleeps; five failures block for the window', async () => {
    for (let failure = 1; failure <= 5; failure++) {
      await attemptFailure();
      const row = await state('ACCOUNT', email);
      expect(row.failures).toBe(failure);
      if (failure < 5) {
        const blocked = await assertBlocked(limiterB.beginAttempt(email, ip));
        expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
        await clearCooldown(); // Move only fixture state, not wall clock.
      }
    }
    const blocked = await assertBlocked(limiterB.beginAttempt(email, ip));
    expect(blocked.retryAfterSeconds).toBeGreaterThan(30);
    expect((await state('ACCOUNT', email)).failures).toBe(5);
  });

  it('03: successful passwords clear account failures, but do not clear IP attempts', async () => {
    await attemptFailure();
    await clearCooldown();
    const ticket = await limiterA.beginAttempt(email, ip);
    await limiterA.finishAttempt(ticket, 'success');
    expect((await state('ACCOUNT', email)).failures).toBe(0);
    expect((await state('ACCOUNT', email)).pending).toBe(0);
    expect((await state('IP', ip)).attempts).toBe(2);
    const next = await limiterA.beginAttempt(email, ip);
    await limiterA.finishAttempt(next, 'success');
  });

  it('04: two users on the same IP have independent account-failure limits', async () => {
    await attemptFailure();
    const other = trackEmail(`sp05-${randomUUID()}@secureplan.invalid`);
    const ticket = await limiterB.beginAttempt(other, ip);
    await limiterB.finishAttempt(ticket, 'success');
    expect((await state('ACCOUNT', other)).failures).toBe(0);
    expect((await state('ACCOUNT', email)).failures).toBe(1);
  });

  it('05: 60 requests per IP are shared between accounts and the 61st is denied', async () => {
    for (let i = 0; i < 60; i++) {
      const id = trackEmail(`sp05-${randomUUID()}@secureplan.invalid`);
      const ticket = await limiterA.beginAttempt(id, ip);
      await limiterA.finishAttempt(ticket, 'success');
    }
    await assertBlocked(limiterB.beginAttempt(trackEmail('another@secureplan.invalid'), ip));
    expect((await state('IP', ip)).attempts).toBe(60);
  });

  it('06: simultaneous wrong-password reservations cannot overrun the five-slot cap', async () => {
    const outcomes = await Promise.allSettled(
      Array.from({ length: 9 }, () => limiterA.beginAttempt(email, ip)),
    );
    const admitted = outcomes.filter((item) => item.status === 'fulfilled');
    const denied = outcomes.filter((item) => item.status === 'rejected');
    expect(admitted).toHaveLength(5);
    expect(denied).toHaveLength(4);
    for (const item of denied) {
      if (item.status === 'rejected') expect(item.reason).toBeInstanceOf(LoginRateLimitedError);
    }
    for (const item of admitted) {
      if (item.status === 'fulfilled') await limiterB.finishAttempt(item.value, 'failure');
    }
    expect((await state('ACCOUNT', email)).failures).toBe(5);
    expect((await state('ACCOUNT', email)).pending).toBe(0);
  });

  it('07: failure recorded in one service immediately limits a second instance', async () => {
    await attemptFailure(limiterA);
    await assertBlocked(limiterB.beginAttempt(email, ip));
  });

  it('08: expired 15-minute window resets both failure count and cooldown', async () => {
    await attemptFailure();
    await db.withTransaction(async (client) => {
      await client.query(
        `UPDATE login_abuse_counters SET window_started_at=clock_timestamp()-interval '16 minutes'
         WHERE scope='ACCOUNT' AND identifier_hash=$1`,
        [digest('ACCOUNT', email)],
      );
    });
    const ticket = await limiterB.beginAttempt(email, ip);
    expect((await state('ACCOUNT', email)).failures).toBe(0);
    await limiterB.finishAttempt(ticket, 'success');
  });

  it('09: aborted internal errors release reservations without counting failures', async () => {
    const ticket = await limiterA.beginAttempt(email, ip);
    await limiterA.finishAttempt(ticket, 'aborted');
    expect((await state('ACCOUNT', email)).pending).toBe(0);
    expect((await state('ACCOUNT', email)).failures).toBe(0);
  });
});
