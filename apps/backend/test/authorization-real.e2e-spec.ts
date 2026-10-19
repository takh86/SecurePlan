/**
 * SP-06 — authorization foundation against REAL PostgreSQL.
 *
 * Part A drives the real AppModule (real SessionService SQL, real global
 * AccessControlGuard) with two synthetic tenants.
 * Part B proves assertActorInTransaction under concurrency with deterministic
 * transaction barriers (pg_blocking_pids), not timing.
 *
 * Requires a migrated local SecurePlan PostgreSQL (npm run db:migrate).
 */
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { PASSWORD_DENYLIST } from '../src/auth/local-password-denylist.js';
import { configureApp } from '../src/configure-app.js';
import type { SessionService } from '../src/auth/session.service.js';
import { assertActorInTransaction } from '../src/auth/authorization/actor-in-transaction.js';
import type { TenantContext, TenantRole } from '../src/auth/authorization/tenant-context.js';
import { AuthorizationProbeController } from './helpers/authorization-probe.controller.js';
import {
  backendPid,
  createSyntheticSession,
  createSyntheticTenant,
  openLocalTestPool,
  realSessionService,
  removeSyntheticTenants,
  waitUntilBlockedBy,
  type SyntheticAccount,
  type SyntheticTenant,
  type TestPool,
} from './helpers/synthetic-tenants.js';

const ORIGIN = 'https://localhost:8443';

let pool: TestPool | undefined;
let sessions: SessionService;
let tenantA: SyntheticTenant;
let tenantB: SyntheticTenant;
const createdCompanies: string[] = [];
let previousOrigin: string | undefined;

function db(): TestPool {
  if (!pool) throw new Error('Test database is unavailable');
  return pool;
}

function tenantContext(member: SyntheticAccount): TenantContext {
  return Object.freeze({
    sessionId: '00000000-0000-4000-8000-000000000000',
    accountId: member.accountId,
    companyId: member.companyId,
    role: member.role,
  });
}

async function runSql(sql: string, params: unknown[]): Promise<void> {
  await db().query(sql, params);
}

beforeAll(async () => {
  pool = openLocalTestPool(8);
  sessions = realSessionService(db());
  previousOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
});

/**
 * Removes the recorded synthetic companies. IDs are dropped from the list
 * ONLY after cleanup committed; on failure they stay recorded (and are
 * retried by the next afterEach/afterAll) and the failure names them.
 */
async function cleanupRecordedCompanies(): Promise<void> {
  if (!pool || createdCompanies.length === 0) return;
  const ids = [...createdCompanies];
  try {
    await removeSyntheticTenants(db(), ids);
  } catch (error) {
    throw new Error(
      `SP-06 synthetic fixture cleanup FAILED; still recorded company ids: ${ids.join(', ')}`,
      { cause: error },
    );
  }
  createdCompanies.splice(0, ids.length);
}

afterAll(async () => {
  try {
    await cleanupRecordedCompanies();
  } finally {
    await pool?.end();
    if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = previousOrigin;
  }
});

beforeEach(async () => {
  tenantA = await createSyntheticTenant(db(), 'Tenant A');
  createdCompanies.push(tenantA.companyId);
  tenantB = await createSyntheticTenant(db(), 'Tenant B');
  createdCompanies.push(tenantB.companyId);
});

afterEach(async () => {
  await cleanupRecordedCompanies();
});

describe('SP-06 Part A — real sessions through the global guard', () => {
  let app: INestApplication<App> | undefined;
  const http = () => request(app!.getHttpServer());

  beforeEach(async () => {
    // Only the unrelated activation denylist is replaced; DatabaseService,
    // SessionService and the global AccessControlGuard are REAL.
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [AuthorizationProbeController],
    })
      .overrideProvider(PASSWORD_DENYLIST)
      .useValue(new Set<string>())
      .compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it('R6: each tenant session resolves only its own company; spoofed input is ignored', async () => {
    const adminA = await createSyntheticSession(sessions, tenantA.admin);
    const adminB = await createSyntheticSession(sessions, tenantB.admin);

    const meA = await http().get(`/api/v1/me?companyId=${tenantB.companyId}`)
      .set('Cookie', adminA.cookie)
      .set('X-Company-Id', tenantB.companyId).set('X-Role', 'COMPANY_ADMIN')
      .expect(200);
    expect(meA.body).toEqual({
      accountId: tenantA.admin.accountId,
      companyId: tenantA.companyId,
      email: tenantA.admin.email,
      role: 'COMPANY_ADMIN',
    });

    const probeB = await http().get('/test-only/authz-probe/admin').set('Cookie', adminB.cookie).expect(200);
    expect(probeB.body).toMatchObject({ companyId: tenantB.companyId, accountId: tenantB.admin.accountId });

    // A DTO cannot carry a tenant switch either.
    const injected = await http().post('/test-only/authz-probe/admin')
      .set('Origin', ORIGIN).set('Cookie', adminA.cookie).set('X-CSRF-Token', adminA.csrf)
      .send({ companyId: tenantB.companyId }).expect(400);
    expect(injected.body.code).toBe('UNKNOWN_FIELD');
  });

  it('R1: a deactivated account loses access with the session still unrevoked', async () => {
    const employee = await createSyntheticSession(sessions, tenantA.employee);
    await http().get('/api/v1/me').set('Cookie', employee.cookie).expect(200);

    await runSql("UPDATE accounts SET status = 'DEACTIVATED' WHERE id = $1", [tenantA.employee.accountId]);

    for (const path of ['/api/v1/me', '/test-only/authz-probe/employee']) {
      const response = await http().get(path).set('Cookie', employee.cookie).expect(401);
      expect(response.body.code).toBe('SESSION_REVOKED');
    }
    // Other tenants are unaffected.
    const other = await createSyntheticSession(sessions, tenantB.employee);
    await http().get('/api/v1/me').set('Cookie', other.cookie).expect(200);
  });

  it.each(['SUSPENDED', 'DEACTIVATED'])(
    'R2: a %s company gives no usable access to any of its accounts',
    async (status) => {
      const admin = await createSyntheticSession(sessions, tenantA.admin);
      const employee = await createSyntheticSession(sessions, tenantA.employee);
      await runSql('UPDATE companies SET status = $2 WHERE id = $1', [tenantA.companyId, status]);

      for (const session of [admin, employee]) {
        const response = await http().get('/api/v1/me').set('Cookie', session.cookie).expect(401);
        expect(response.body.code).toBe('SESSION_REVOKED');
      }
      const write = await http().post('/test-only/authz-probe/admin')
        .set('Origin', ORIGIN).set('Cookie', admin.cookie).set('X-CSRF-Token', admin.csrf)
        .send({}).expect(401);
      expect(write.body.code).toBe('SESSION_REVOKED');
    },
  );

  it('R3: authorization uses the live DB role, not the role at login time', async () => {
    const admin = await createSyntheticSession(sessions, tenantA.admin);
    await http().get('/test-only/authz-probe/admin').set('Cookie', admin.cookie).expect(200);

    await runSql("UPDATE accounts SET role = 'EMPLOYEE' WHERE id = $1", [tenantA.admin.accountId]);

    const denied = await http().get('/test-only/authz-probe/admin').set('Cookie', admin.cookie).expect(403);
    expect(denied.body.code).toBe('ACTION_FORBIDDEN');
    const me = await http().get('/api/v1/me').set('Cookie', admin.cookie).expect(200);
    expect(me.body.role).toBe('EMPLOYEE');
  });

  it('R7: real logout still revokes only the caller session (SP-05 regression)', async () => {
    const first = await createSyntheticSession(sessions, tenantA.employee);
    const second = await createSyntheticSession(sessions, tenantA.employee);
    await http().post('/api/v1/auth/logout')
      .set('Origin', ORIGIN).set('Cookie', first.cookie).set('X-CSRF-Token', first.csrf)
      .send({}).expect(204);
    await http().get('/api/v1/me').set('Cookie', first.cookie).expect(401);
    await http().get('/api/v1/me').set('Cookie', second.cookie).expect(200);

    // A CSRF token from another session cannot be replayed.
    const replay = await http().post('/api/v1/auth/logout')
      .set('Origin', ORIGIN).set('Cookie', second.cookie).set('X-CSRF-Token', first.csrf)
      .send({}).expect(403);
    expect(replay.body.code).toBe('CSRF_VALIDATION_FAILED');
    await http().get('/api/v1/me').set('Cookie', second.cookie).expect(200);
  });
});

/**
 * Part B evidence levels (SP-06 review P2):
 * - "lock ordering": PostgreSQL row-lock behaviour of assertActorInTransaction,
 *   proven with pg_blocking_pids barriers.
 * - "synthetic write": a real, tenant-scoped UPDATE of the synthetic tenant's
 *   own `companies.name` (existing schema, no DDL, no audit rows) performed
 *   in the same transaction after the assertion; the COMMITTED DB state is
 *   then asserted.
 * These prove the helper's transactional contract. They do NOT prove that a
 * business service uses it correctly: that requires a real domain write and
 * is deferred to the SP-07 employee slice.
 */
describe('SP-06 Part B — assertActorInTransaction under concurrency (deterministic)', () => {
  /**
   * Transaction lifecycle rules (review: test-harness safety):
   * - every operation issued on a held client is registered in `pending`;
   * - COMMIT happens only via commit(), which the tests call solely on their
   *   explicitly verified path, and only once no operation is in flight;
   * - every other exit goes through abortAll(): cancel in-flight statements
   *   (pg_cancel_backend), wait until ALL of them settled, ROLLBACK, release.
   *   A client is never returned to the pool while a query is executing; if
   *   ROLLBACK itself fails, the connection is destroyed instead of reused.
   */
  type Held = { client: PoolClient; pid: number; open: boolean; pending: Set<Promise<unknown>> };
  const opened: Held[] = [];

  async function begin(): Promise<Held> {
    const client = await db().connect();
    const held: Held = { client, pid: 0, open: true, pending: new Set() };
    opened.push(held);
    await client.query('BEGIN');
    // Safety net only: a regression must fail, not hang the suite.
    await client.query("SET LOCAL lock_timeout = '10s'");
    held.pid = await backendPid(client);
    return held;
  }

  /**
   * Registers an operation running on `held` and reports whether it settled.
   * The returned promise never rejects unhandled; callers await `promise`.
   */
  function track<T>(held: Held, operation: Promise<T>) {
    const state = { settled: false };
    const promise = operation.finally(() => {
      state.settled = true;
      held.pending.delete(promise);
    });
    held.pending.add(promise);
    promise.catch(() => {});
    return { state, promise };
  }

  async function commit(held: Held): Promise<void> {
    if (!held.open) throw new Error('commit() on a transaction that is no longer open');
    if (held.pending.size > 0) throw new Error('commit() while an operation is still in flight');
    held.open = false;
    try {
      await held.client.query('COMMIT');
      held.client.release();
    } catch (error) {
      held.client.release(true); // destroy: state unknown
      throw error;
    }
  }

  async function abortAll(...helds: Held[]): Promise<void> {
    const open = helds.filter((held) => held.open);
    for (const held of open) held.open = false;
    // 1. Cancel whatever is still executing (no-op for idle backends).
    for (const held of open) {
      if (held.pending.size > 0) {
        await db().query('SELECT pg_cancel_backend($1)', [held.pid]).catch(() => {});
      }
    }
    // 2. Wait until every in-flight operation has settled.
    await Promise.allSettled(open.flatMap((held) => [...held.pending]));
    // 3. Roll back and release; destroy the connection if rollback fails.
    for (const held of open) {
      try {
        await held.client.query('ROLLBACK');
        held.client.release();
      } catch {
        held.client.release(true);
      }
    }
  }

  // Runs before the outer fixture cleanup: a failed test must never leave a
  // row lock or a running statement behind.
  afterEach(async () => {
    await abortAll(...opened.splice(0).reverse());
  });

  async function accountState(accountId: string) {
    const result = await db().query<{ status: string; role: string }>(
      'SELECT status, role FROM accounts WHERE id = $1',
      [accountId],
    );
    return result.rows[0];
  }

  async function companyName(companyId: string): Promise<string> {
    const result = await db().query<{ name: string }>('SELECT name FROM companies WHERE id = $1', [companyId]);
    return result.rows[0].name;
  }

  /**
   * The synthetic business write: authorize first, then a tenant-scoped,
   * parameterized UPDATE on the same transaction. Returns the marker written.
   */
  async function authorizedSyntheticWrite(
    client: PoolClient,
    tenant: TenantContext,
    allowedRoles: readonly TenantRole[],
  ): Promise<string> {
    await assertActorInTransaction(client, tenant, allowedRoles);
    const marker = `SP06 Synthetic write ${randomUUID()}`;
    const written = await client.query(
      'UPDATE companies SET name = $2, updated_at = now() WHERE id = $1 RETURNING id',
      [tenant.companyId, marker],
    );
    expect(written.rowCount).toBe(1);
    return marker;
  }

  it('baseline: an active admin passes; wrong tenant pairing and wrong role are rejected', async () => {
    const held = await begin();
    try {
      await assertActorInTransaction(held.client, tenantContext(tenantA.admin), ['COMPANY_ADMIN']);
      await expect(assertActorInTransaction(held.client, tenantContext(tenantA.employee), ['COMPANY_ADMIN']))
        .rejects.toMatchObject({ status: 403, response: { code: 'ACTION_FORBIDDEN' } });
      // Manipulated pairing: A's account with B's company does not exist.
      const forged = { ...tenantContext(tenantA.admin), companyId: tenantB.companyId };
      await expect(assertActorInTransaction(held.client, forged, ['COMPANY_ADMIN']))
        .rejects.toMatchObject({ status: 401, response: { code: 'SESSION_REVOKED' } });
      // A context claiming a role the account does not have is rejected,
      // even when that claimed role is allowed.
      const forgedRole = { ...tenantContext(tenantA.employee), role: 'COMPANY_ADMIN' as const };
      await expect(assertActorInTransaction(held.client, forgedRole, ['EMPLOYEE', 'COMPANY_ADMIN']))
        .rejects.toMatchObject({ status: 403, response: { code: 'ACTION_FORBIDDEN' } });
    } finally {
      await abortAll(held);
    }
  });

  it('P1: stale COMPANY_ADMIN context after a committed downgrade is rejected although both roles are allowed (synthetic write)', async () => {
    const staleAdmin = tenantContext(tenantA.admin); // captured as COMPANY_ADMIN
    const before = await companyName(tenantA.companyId);
    await runSql("UPDATE accounts SET role = 'EMPLOYEE' WHERE id = $1", [tenantA.admin.accountId]);

    const actor = await begin();
    try {
      await expect(authorizedSyntheticWrite(actor.client, staleAdmin, ['EMPLOYEE', 'COMPANY_ADMIN']))
        .rejects.toMatchObject({ status: 403, response: { code: 'ACTION_FORBIDDEN' } });
    } finally {
      await abortAll(actor);
    }
    expect(await companyName(tenantA.companyId)).toBe(before);

    // The same account with a context matching its live role may proceed.
    const fresh = { ...staleAdmin, role: 'EMPLOYEE' as const };
    const next = await begin();
    let marker: string;
    try {
      marker = await authorizedSyntheticWrite(next.client, fresh, ['EMPLOYEE', 'COMPANY_ADMIN']);
      await commit(next); // verified path only
    } finally {
      await abortAll(next); // no-op after a successful commit
    }
    expect(await companyName(tenantA.companyId)).toBe(marker);
  });

  it('R4a (lock ordering + synthetic write): an in-flight authorized write commits before a concurrent deactivation', async () => {
    const actor = await begin();
    const deactivator = await begin();
    const marker = `SP06 Synthetic write ${randomUUID()}`;
    try {
      await assertActorInTransaction(actor.client, tenantContext(tenantA.admin), ['COMPANY_ADMIN']);
      const deactivation = track(deactivator, deactivator.client.query(
        "UPDATE accounts SET status = 'DEACTIVATED' WHERE id = $1",
        [tenantA.admin.accountId],
      ));
      // Barrier: the deactivation is provably waiting on the actor's row lock.
      await waitUntilBlockedBy(db(), deactivator.pid, actor.pid);
      await actor.client.query('UPDATE companies SET name = $2 WHERE id = $1', [tenantA.companyId, marker]);
      expect(deactivation.state.settled).toBe(false);
      await commit(actor); // verified path: barrier held, write done, deactivation still waiting

      await deactivation.promise;
      await commit(deactivator);
    } finally {
      // Unexpected failure: cancel/settle the waiting UPDATE, roll back both.
      await abortAll(deactivator, actor);
    }

    // Committed state: the authorized write landed AND the deactivation applied after it.
    expect(await companyName(tenantA.companyId)).toBe(marker);
    expect((await accountState(tenantA.admin.accountId)).status).toBe('DEACTIVATED');
    // Any later write transaction is now rejected and writes nothing.
    const later = await begin();
    try {
      await expect(authorizedSyntheticWrite(later.client, tenantContext(tenantA.admin), ['COMPANY_ADMIN']))
        .rejects.toMatchObject({ status: 401, response: { code: 'SESSION_REVOKED' } });
    } finally {
      await abortAll(later);
    }
    expect(await companyName(tenantA.companyId)).toBe(marker);
  });

  /**
   * A change is held uncommitted; the actor's authorization provably waits on
   * it (barrier); the change commits; the actor attempt settles.
   *
   * Only on that verified path is the actor transaction deliberately sent a
   * COMMIT, so that anything an unauthorized attempt might have written would
   * persist and be caught by the committed-state assertion. (A failed
   * statement leaves the transaction aborted; PostgreSQL then answers COMMIT
   * with a ROLLBACK.) Any unexpected failure instead cancels/settles the
   * in-flight attempt and rolls both transactions back.
   */
  async function racedAgainstCommittedChange(
    change: { sql: string; params: unknown[] },
    member: SyntheticAccount,
    allowedRoles: readonly TenantRole[],
  ) {
    const before = await companyName(member.companyId);
    const changer = await begin();
    const actor = await begin();
    const writes: string[] = [];
    let outcome: unknown;
    try {
      await changer.client.query(change.sql, change.params);
      const attempt = track(actor, (async () => {
        writes.push(await authorizedSyntheticWrite(actor.client, tenantContext(member), allowedRoles));
      })());

      await waitUntilBlockedBy(db(), actor.pid, changer.pid);
      expect(attempt.state.settled).toBe(false);
      await commit(changer);
      outcome = await attempt.promise.then(() => null, (error: unknown) => error);
      // Verified path: barrier held, change committed, attempt settled.
      await commit(actor);
    } finally {
      await abortAll(actor, changer); // no-op for transactions already committed
    }
    return { outcome, writes, before, after: await companyName(member.companyId) };
  }

  it('R4b (lock ordering + synthetic write): deactivation committed while authorization waits -> 401, DB unchanged', async () => {
    const result = await racedAgainstCommittedChange({
      sql: "UPDATE accounts SET status = 'DEACTIVATED' WHERE id = $1",
      params: [tenantA.admin.accountId],
    }, tenantA.admin, ['COMPANY_ADMIN']);
    expect(result.outcome).toMatchObject({ status: 401, response: { code: 'SESSION_REVOKED' } });
    expect(result.writes).toEqual([]);
    expect(result.after).toBe(result.before);
  });

  it('R5 (lock ordering + synthetic write): role downgrade committed while authorization waits -> 403, DB unchanged', async () => {
    const result = await racedAgainstCommittedChange({
      sql: "UPDATE accounts SET role = 'EMPLOYEE' WHERE id = $1",
      params: [tenantA.admin.accountId],
    }, tenantA.admin, ['COMPANY_ADMIN']);
    expect(result.outcome).toMatchObject({ status: 403, response: { code: 'ACTION_FORBIDDEN' } });
    expect(result.writes).toEqual([]);
    expect(result.after).toBe(result.before);
  });

  it('P1 race: role downgrade committed while authorization waits, BOTH roles allowed -> 403, DB unchanged', async () => {
    const result = await racedAgainstCommittedChange({
      sql: "UPDATE accounts SET role = 'EMPLOYEE' WHERE id = $1",
      params: [tenantA.admin.accountId],
    }, tenantA.admin, ['EMPLOYEE', 'COMPANY_ADMIN']);
    expect(result.outcome).toMatchObject({ status: 403, response: { code: 'ACTION_FORBIDDEN' } });
    expect(result.writes).toEqual([]);
    expect(result.after).toBe(result.before);
  });

  it('R5b (lock ordering + synthetic write): company suspension committed while authorization waits -> 401, DB unchanged', async () => {
    const result = await racedAgainstCommittedChange({
      sql: "UPDATE companies SET status = 'SUSPENDED' WHERE id = $1",
      params: [tenantA.companyId],
    }, tenantA.admin, ['COMPANY_ADMIN']);
    expect(result.outcome).toMatchObject({ status: 401, response: { code: 'SESSION_REVOKED' } });
    expect(result.writes).toEqual([]);
    expect(result.after).toBe(result.before);
  });

  it('R4c (lock ordering + synthetic write): a rolled-back deactivation does not block a legitimate write', async () => {
    const changer = await begin();
    const actor = await begin();
    let marker: string | undefined;
    try {
      await changer.client.query("UPDATE accounts SET status = 'DEACTIVATED' WHERE id = $1", [tenantA.admin.accountId]);
      const attempt = track(actor, authorizedSyntheticWrite(actor.client, tenantContext(tenantA.admin), ['COMPANY_ADMIN']));
      await waitUntilBlockedBy(db(), actor.pid, changer.pid);
      await abortAll(changer); // the deactivation is rolled back
      marker = await attempt.promise;
      await commit(actor); // verified path: authorized write succeeded
    } finally {
      await abortAll(actor, changer);
    }
    expect(await companyName(tenantA.companyId)).toBe(marker);
    expect((await accountState(tenantA.admin.accountId)).status).toBe('ACTIVE');
  });

  it('lock ordering: tenant B status changes never block or affect tenant A authorization', async () => {
    const changer = await begin();
    const actor = await begin();
    try {
      await changer.client.query("UPDATE companies SET status = 'SUSPENDED' WHERE id = $1", [tenantB.companyId]);
      // Would wait (and time out) if B's lock were relevant to A.
      await assertActorInTransaction(actor.client, tenantContext(tenantA.admin), ['COMPANY_ADMIN']);
    } finally {
      await abortAll(actor, changer);
    }
  });
});
