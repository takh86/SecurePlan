/**
 * SP-07 — concurrency, locking, rollback and activation-delivery failure of the
 * employee write paths against REAL PostgreSQL (SP-06 case 14 on a real
 * business resource).
 *
 * Interleavings are forced with deterministic barriers (a held transaction +
 * pg_blocking_pids), never with sleeps. The bounded "stress smoke" at the end
 * only increases confidence; it does not prove deadlock freedom.
 *
 * Requires a migrated LOCAL PostgreSQL (0001–0006); synthetic fixtures only.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { SessionService } from '../src/auth/session.service.js';
import type { TenantContext } from '../src/auth/authorization/tenant-context.js';
import { DatabaseService } from '../src/database/database.service.js';
import { AccountLifecycleService } from '../src/modules/identity/account-lifecycle.service.js';
import { EmployeesService } from '../src/modules/workforce/employees/employees.service.js';
import type { CreateEmployeeDto } from '../src/modules/workforce/employees/dto/employee.dto.js';
import {
  backendPid,
  createSyntheticAccount,
  createSyntheticEmployee,
  createSyntheticSession,
  createSyntheticTenant,
  openLocalTestPool,
  realSessionService,
  removeSyntheticTenants,
  type SyntheticAccount,
  type SyntheticEmployee,
  type SyntheticSession,
  type SyntheticTenant,
  type TestPool,
} from './helpers/synthetic-tenants.js';
import { FailingAudit, ORIGIN, RecordingDelivery, bootEmployeesApp } from './helpers/employees-test-app.js';

const BASE = '/api/v1/employees';

let pool: TestPool | undefined;
let sessions: SessionService;
let tenantA: SyntheticTenant;
let employeeA: SyntheticEmployee;
let adminA: SyntheticSession;
let secondAdmin: SyntheticAccount;
let secondAdminSession: SyntheticSession;
let app: INestApplication<App> | undefined;
let delivery: RecordingDelivery;
const createdCompanies: string[] = [];
let previousOrigin: string | undefined;

type Held = { client: PoolClient; pid: number; open: boolean };
const held: Held[] = [];
const inFlight = new Set<Promise<unknown>>();

function db(): TestPool {
  if (!pool) throw new Error('Test database is unavailable');
  return pool;
}

const http = () => request(app!.getHttpServer());

/** Starts a request NOW and tracks it so a failing test can never leak it. */
function send<T>(operation: () => PromiseLike<T>): Promise<T> {
  const promise = Promise.resolve(operation());
  inFlight.add(promise);
  void promise.finally(() => inFlight.delete(promise)).catch(() => {});
  return promise;
}

function write(method: 'post' | 'patch', path: string, session: SyntheticSession, body: object = {}) {
  return send(() => http()[method](path)
    .set('Origin', ORIGIN)
    .set('Cookie', session.cookie)
    .set('X-CSRF-Token', session.csrf)
    .send(body));
}

function tenantContext(member: SyntheticAccount): TenantContext {
  return Object.freeze({
    sessionId: randomUUID(),
    accountId: member.accountId,
    companyId: member.companyId,
    role: member.role,
  });
}

async function begin(): Promise<Held> {
  const client = await db().connect();
  const transaction: Held = { client, pid: 0, open: true };
  held.push(transaction);
  await client.query('BEGIN');
  // Safety net: a regression must fail, not hang the suite.
  await client.query("SET LOCAL lock_timeout = '10s'");
  transaction.pid = await backendPid(client);
  return transaction;
}

async function commit(transaction: Held): Promise<void> {
  transaction.open = false;
  try {
    await transaction.client.query('COMMIT');
    transaction.client.release();
  } catch (error) {
    transaction.client.release(true);
    throw error;
  }
}

async function rollback(transaction: Held): Promise<void> {
  if (!transaction.open) return;
  transaction.open = false;
  try {
    await transaction.client.query('ROLLBACK');
    transaction.client.release();
  } catch {
    transaction.client.release(true);
  }
}

/**
 * Resolves with the pids of the backends that (transitively) wait on a lock
 * held by `holderPid`, once there are at least `count` of them. Transitive,
 * because PostgreSQL queues row-lock waiters: the second waiter on a row is
 * reported as blocked by the FIRST WAITER, not by the holder. No sleeps: the
 * bounded loop only re-reads server state.
 */
async function waitForBlocked(holderPid: number, count = 1, maxChecks = 4000): Promise<number[]> {
  for (let check = 0; check < maxChecks; check += 1) {
    const result = await db().query<{ pid: number }>(
      `WITH RECURSIVE waiters(pid) AS (
         SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))
         UNION
         SELECT a.pid FROM pg_stat_activity a JOIN waiters w ON w.pid = ANY(pg_blocking_pids(a.pid))
       )
       SELECT pid FROM waiters ORDER BY pid`,
      [holderPid],
    );
    if (result.rows.length >= count) return result.rows.map((row) => row.pid);
  }
  const snapshot = await db().query(
    `SELECT pid, state, wait_event_type, pg_blocking_pids(pid) AS blocked_by, left(query, 60) AS query
     FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`,
  );
  throw new Error(`Fewer than ${count} backend(s) ever blocked on ${holderPid}: ${JSON.stringify(snapshot.rows)}`);
}

async function employeeRow(employeeId: string) {
  return (await db().query(
    `SELECT employee_number, status, deactivated_at, employment_end::text AS employment_end
     FROM employees WHERE id = $1`,
    [employeeId],
  )).rows[0];
}

async function accountStatus(accountId: string): Promise<string> {
  return (await db().query('SELECT status FROM accounts WHERE id = $1', [accountId])).rows[0].status;
}

async function liveSessions(accountId: string): Promise<number> {
  return (await db().query(
    'SELECT count(*)::int AS n FROM sessions WHERE account_id = $1 AND revoked_at IS NULL',
    [accountId],
  )).rows[0].n;
}

async function auditCount(companyId: string, action: string, resourceId?: string): Promise<number> {
  return (await db().query(
    `SELECT count(*)::int AS n FROM audit_event
     WHERE company_id = $1 AND action = $2 AND ($3::uuid IS NULL OR resource_id = $3)`,
    [companyId, action, resourceId ?? null],
  )).rows[0].n;
}

/** A further employee (own EMPLOYEE account + employee row + live session) in tenant A. */
async function extraEmployee(): Promise<{ employee: SyntheticEmployee; session: SyntheticSession }> {
  const member = await createSyntheticAccount(db(), tenantA.companyId, 'EMPLOYEE');
  const employee = await createSyntheticEmployee(db(), member);
  return { employee, session: await createSyntheticSession(sessions, member) };
}

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    employeeCode: `C-${randomUUID().slice(0, 8)}`,
    firstName: 'Kim',
    lastName: 'Muster',
    email: `sp07-c-${randomUUID()}@secureplan.invalid`,
    shiftEligibility: 'BOTH',
    ...overrides,
  };
}

beforeAll(() => {
  pool = openLocalTestPool(12);
  sessions = realSessionService(db());
  previousOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
});

beforeEach(async () => {
  tenantA = await createSyntheticTenant(db(), 'SP07 Concurrency');
  createdCompanies.push(tenantA.companyId);
  employeeA = await createSyntheticEmployee(db(), tenantA.employee, 'K-001');
  adminA = await createSyntheticSession(sessions, tenantA.admin);
  secondAdmin = await createSyntheticAccount(db(), tenantA.companyId, 'COMPANY_ADMIN');
  secondAdminSession = await createSyntheticSession(sessions, secondAdmin);
  delivery = new RecordingDelivery();
});

afterEach(async () => {
  // Order matters: release held locks, let in-flight work settle, then close.
  for (const transaction of held.splice(0).reverse()) await rollback(transaction);
  await Promise.allSettled(inFlight);
  if (app) await app.close();
  app = undefined;
  const ids = createdCompanies.splice(0);
  try {
    await removeSyntheticTenants(db(), ids);
  } catch (error) {
    throw new Error(`SP-07 fixture cleanup FAILED for companies ${ids.join(', ')}`, { cause: error });
  }
});

afterAll(async () => {
  await pool?.end();
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousOrigin;
});

describe('SP-07 — concurrent writes', () => {
  beforeEach(async () => {
    app = await bootEmployeesApp(delivery);
  });

  it('same-code race: the UNIQUE constraint decides; the loser rolls back its provisioned account', async () => {
    // A competing, still uncommitted create of RACE-1 (own account) holds the unique key.
    const competitor = await begin();
    const competitorAccount = randomUUID();
    await competitor.client.query(
      `INSERT INTO accounts (id, company_id, email, account_scope, role, status)
       VALUES ($1, $2, $3, 'TENANT', 'EMPLOYEE', 'PENDING_ACTIVATION')`,
      [competitorAccount, tenantA.companyId, `sp07-race-${randomUUID()}@secureplan.invalid`],
    );
    await competitor.client.query(
      `INSERT INTO employees (company_id, account_id, employee_number, first_name, last_name, shift_eligibility)
       VALUES ($1, $2, 'RACE-1', 'Race', 'Winner', 'TAG')`,
      [tenantA.companyId, competitorAccount],
    );

    const loserEmail = `sp07-loser-${randomUUID()}@secureplan.invalid`;
    const attempt = write('post', BASE, adminA, createBody({ employeeCode: 'RACE-1', email: loserEmail }));
    // Barrier: the HTTP create passed its pre-check and now waits on the unique index.
    await waitForBlocked(competitor.pid);
    await commit(competitor);

    const response = await attempt;
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('EMPLOYEE_CODE_ALREADY_EXISTS');
    const leftovers = await db().query('SELECT count(*)::int AS n FROM accounts WHERE email = $1', [loserEmail]);
    expect(leftovers.rows[0].n).toBe(0);
    const winners = await db().query(
      "SELECT count(*)::int AS n FROM employees WHERE company_id = $1 AND employee_number = 'RACE-1'",
      [tenantA.companyId],
    );
    expect(winners.rows[0].n).toBe(1);
    expect(delivery.sent).toEqual([]);
  });

  it('same-code race over HTTP: exactly one 201 and one 409, exactly one new account', async () => {
    const emails = [`sp07-r1-${randomUUID()}@secureplan.invalid`, `sp07-r2-${randomUUID()}@secureplan.invalid`];
    const responses = await Promise.all([
      write('post', BASE, adminA, createBody({ employeeCode: 'RACE-2', email: emails[0] })),
      write('post', BASE, secondAdminSession, createBody({ employeeCode: 'RACE-2', email: emails[1] })),
    ]);
    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([201, 409]);
    expect(responses.find((response) => response.status === 409)?.body.code).toBe('EMPLOYEE_CODE_ALREADY_EXISTS');
    const accounts = await db().query('SELECT count(*)::int AS n FROM accounts WHERE email = ANY($1)', [emails]);
    expect(accounts.rows[0].n).toBe(1);
  });

  it('two admins deactivating the same employee: one 200, one 409 EMPLOYEE_INACTIVE, one audit pair', async () => {
    const lock = await begin();
    await lock.client.query('SELECT id FROM employees WHERE id = $1 FOR UPDATE', [employeeA.employeeId]);
    const first = write('post', `${BASE}/${employeeA.employeeId}/deactivate`, adminA);
    const second = write('post', `${BASE}/${employeeA.employeeId}/deactivate`, secondAdminSession);
    // Barrier: both service transactions wait on the same employee row.
    await waitForBlocked(lock.pid, 2);
    await rollback(lock);

    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 409]);
    expect(responses.find((response) => response.status === 409)?.body.code).toBe('EMPLOYEE_INACTIVE');
    expect(await auditCount(tenantA.companyId, 'EMPLOYEE_DEACTIVATED', employeeA.employeeId)).toBe(1);
    expect(await auditCount(tenantA.companyId, 'ACCOUNT_DEACTIVATED', tenantA.employee.accountId)).toBe(1);
  });

  it('PATCH racing a deactivation serializes on the employee row: both apply, nothing is lost', async () => {
    const lock = await begin();
    await lock.client.query('SELECT id FROM employees WHERE id = $1 FOR UPDATE', [employeeA.employeeId]);
    const patch = write('patch', `${BASE}/${employeeA.employeeId}`, adminA, { employmentEnd: '2026-12-31' });
    const deactivation = write('post', `${BASE}/${employeeA.employeeId}/deactivate`, secondAdminSession);
    await waitForBlocked(lock.pid, 2);
    await rollback(lock);

    const responses = await Promise.all([patch, deactivation]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await employeeRow(employeeA.employeeId)).toMatchObject({
      status: 'DEACTIVATED',
      employment_end: '2026-12-31',
    });
  });
});

describe('SP-07 — actor revalidation inside the business write (SP-06 deferred case)', () => {
  let service: EmployeesService;

  beforeEach(async () => {
    app = await bootEmployeesApp(delivery);
    service = app.get(EmployeesService);
  });

  it('actor deactivated while the deactivation write waits: 401 SESSION_REVOKED, nothing written', async () => {
    const changer = await begin();
    await changer.client.query("UPDATE accounts SET status = 'DEACTIVATED' WHERE id = $1", [tenantA.admin.accountId]);
    const attempt = send(() => service.deactivate(tenantContext(tenantA.admin), employeeA.employeeId, randomUUID()));
    // Barrier: assertActorInTransaction waits on the changer's account row lock.
    await waitForBlocked(changer.pid);
    await commit(changer);

    await expect(attempt).rejects.toMatchObject({ status: 401, response: { code: 'SESSION_REVOKED' } });
    expect(await employeeRow(employeeA.employeeId)).toMatchObject({ status: 'ACTIVE', deactivated_at: null });
    expect(await accountStatus(tenantA.employee.accountId)).toBe('ACTIVE');
    expect(await auditCount(tenantA.companyId, 'EMPLOYEE_DEACTIVATED')).toBe(0);
  });

  it('actor downgraded to EMPLOYEE while the create waits: 403 ACTION_FORBIDDEN, no employee or account', async () => {
    const email = `sp07-downgrade-${randomUUID()}@secureplan.invalid`;
    const changer = await begin();
    await changer.client.query("UPDATE accounts SET role = 'EMPLOYEE' WHERE id = $1", [tenantA.admin.accountId]);
    const attempt = send(() => service.create(
      tenantContext(tenantA.admin),
      createBody({ employeeCode: 'DOWN-1', email }) as CreateEmployeeDto,
      randomUUID(),
    ));
    await waitForBlocked(changer.pid);
    await commit(changer);

    await expect(attempt).rejects.toMatchObject({ status: 403, response: { code: 'ACTION_FORBIDDEN' } });
    expect((await db().query('SELECT count(*)::int AS n FROM accounts WHERE email = $1', [email])).rows[0].n).toBe(0);
    expect((await db().query("SELECT count(*)::int AS n FROM employees WHERE employee_number = 'DOWN-1'")).rows[0].n)
      .toBe(0);
    expect(delivery.sent).toEqual([]);
  });
});

describe('SP-07 — deactivation vs. the target employee’s own session activity', () => {
  beforeEach(async () => {
    app = await bootEmployeesApp(delivery);
  });

  it('target session validation holds the account lock first: deactivation waits, then revokes it', async () => {
    const target = await createSyntheticSession(sessions, tenantA.employee);
    // Same locks and order as SessionService.validateAndTouch: account, then session.
    const validation = await begin();
    await validation.client.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [tenantA.employee.accountId]);
    await validation.client.query('SELECT id FROM sessions WHERE account_id = $1 FOR UPDATE', [tenantA.employee.accountId]);

    const deactivation = write('post', `${BASE}/${employeeA.employeeId}/deactivate`, adminA);
    await waitForBlocked(validation.pid);
    await commit(validation);

    expect((await deactivation).status).toBe(200);
    const denied = await send(() => http().get('/api/v1/me').set('Cookie', target.cookie));
    expect(denied.status).toBe(401);
    expect(denied.body.code).toBe('SESSION_REVOKED');
  });

  it('deactivation holds the account lock first: the real validateAndTouch waits, then fails closed', async () => {
    const target = await createSyntheticSession(sessions, tenantA.employee);
    // Pause the deactivation AFTER it locked the target account: hold the target's session row.
    const sessionLock = await begin();
    await sessionLock.client.query('SELECT id FROM sessions WHERE account_id = $1 FOR UPDATE', [tenantA.employee.accountId]);

    const deactivation = write('post', `${BASE}/${employeeA.employeeId}/deactivate`, adminA);
    const [deactivationPid] = await waitForBlocked(sessionLock.pid);
    // The target's next request: real SessionService SQL, blocked by the deactivation's account lock.
    const validation = send(() => sessions.validateAndTouch(target.rawToken));
    await waitForBlocked(deactivationPid);
    await rollback(sessionLock);

    expect((await deactivation).status).toBe(200);
    await expect(validation).rejects.toMatchObject({ status: 401, response: { code: 'SESSION_REVOKED' } });
    expect(await liveSessions(tenantA.employee.accountId)).toBe(0);
  });

  it('stress smoke: 8 rounds of deactivation racing the target’s own requests never deadlock or 500', async () => {
    for (let round = 0; round < 8; round += 1) {
      const { employee, session } = await extraEmployee();
      const [deactivation, me] = await Promise.all([
        write('post', `${BASE}/${employee.employeeId}/deactivate`, adminA),
        send(() => http().get('/api/v1/me').set('Cookie', session.cookie)),
      ]);
      expect(deactivation.status).toBe(200);
      // Either the request finished before the deactivation, or it was revoked.
      expect([200, 401]).toContain(me.status);
      expect(await liveSessions(employee.account.accountId)).toBe(0);
    }
  });
});

describe('SP-07 — rollback on partial failure', () => {
  it('create: a failing audit insert leaves no employee, no account, no token and sends nothing', async () => {
    app = await bootEmployeesApp(delivery, { audit: new FailingAudit('ACCOUNT_PROVISIONED') });
    const email = `sp07-rollback-${randomUUID()}@secureplan.invalid`;
    const response = await write('post', BASE, adminA, createBody({ employeeCode: 'RB-1', email }));
    expect(response.status).toBe(500);
    expect(response.body.code).toBe('INTERNAL_ERROR');

    const state = await db().query(
      `SELECT (SELECT count(*)::int FROM accounts WHERE email = $1) AS accounts,
              (SELECT count(*)::int FROM employees WHERE company_id = $2 AND employee_number = 'RB-1') AS employees,
              (SELECT count(*)::int FROM account_tokens WHERE company_id = $2) AS tokens,
              (SELECT count(*)::int FROM audit_event WHERE company_id = $2) AS audit`,
      [email, tenantA.companyId],
    );
    expect(state.rows[0]).toEqual({ accounts: 0, employees: 0, tokens: 0, audit: 0 });
    expect(delivery.sent).toEqual([]);
  });

  it('deactivate: a failing final audit insert keeps employee, account, sessions and tokens intact', async () => {
    app = await bootEmployeesApp(delivery, { audit: new FailingAudit('ACCOUNT_DEACTIVATED') });
    const target = await createSyntheticSession(sessions, tenantA.employee);
    await db().query(
      `INSERT INTO account_tokens (company_id, account_id, purpose, token_hash, expires_at)
       VALUES ($1, $2, 'PASSWORD_RESET', $3, now() + INTERVAL '1 hour')`,
      [tenantA.companyId, tenantA.employee.accountId, randomBytes(32)],
    );

    const response = await write('post', `${BASE}/${employeeA.employeeId}/deactivate`, adminA);
    expect(response.status).toBe(500);
    expect(await employeeRow(employeeA.employeeId)).toMatchObject({ status: 'ACTIVE', deactivated_at: null });
    expect(await accountStatus(tenantA.employee.accountId)).toBe('ACTIVE');
    expect(await liveSessions(tenantA.employee.accountId)).toBe(1);
    const tokens = await db().query(
      'SELECT count(*)::int AS n FROM account_tokens WHERE account_id = $1 AND revoked_at IS NULL',
      [tenantA.employee.accountId],
    );
    expect(tokens.rows[0].n).toBe(1);
    expect((await send(() => http().get('/api/v1/me').set('Cookie', target.cookie))).status).toBe(200);
  });

  it('update: a failing audit insert keeps the previous master data', async () => {
    app = await bootEmployeesApp(delivery, { audit: new FailingAudit('EMPLOYEE_UPDATED') });
    const response = await write('patch', `${BASE}/${employeeA.employeeId}`, adminA, { employeeCode: 'K-999' });
    expect(response.status).toBe(500);
    expect((await employeeRow(employeeA.employeeId)).employee_number).toBe('K-001');
  });
});

describe('SP-07 — activation delivery failure and internal recovery', () => {
  beforeEach(async () => {
    app = await bootEmployeesApp(delivery);
  });

  it('delivery failure: employee stays created, the undeliverable token is revoked and the failure audited', async () => {
    delivery.fail = true;
    const response = await write('post', BASE, adminA, createBody());
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ status: 'ACTIVE', accountStatus: 'PENDING_ACTIVATION' });

    const tokens = await db().query(
      `SELECT t.revoked_at IS NOT NULL AS revoked, t.used_at
       FROM account_tokens t JOIN employees e ON e.company_id = t.company_id AND e.account_id = t.account_id
       WHERE e.id = $1`,
      [response.body.id],
    );
    expect(tokens.rows).toEqual([{ revoked: true, used_at: null }]);
    const audit = await db().query(
      `SELECT new_values FROM audit_event
       WHERE company_id = $1 AND action = 'ACCOUNT_ACTIVATION_DELIVERY_FAILED' AND correlation_id = $2`,
      [tenantA.companyId, response.headers['x-correlation-id']],
    );
    expect(audit.rows).toEqual([{ new_values: { tokenRevoked: true } }]);
    expect(delivery.sent).toEqual([]);
  });

  it('internal reissue starts a new token lifecycle; only the newest link activates the account', async () => {
    const created = await write('post', BASE, adminA, createBody());
    expect(created.status).toBe(201);
    const firstToken = delivery.tokenFor(created.body.email);
    const accountId = (await db().query('SELECT account_id FROM employees WHERE id = $1', [created.body.id]))
      .rows[0].account_id as string;

    const accounts = app!.get(AccountLifecycleService);
    const database = app!.get(DatabaseService);
    const reissued = await database.withTransaction((client) =>
      accounts.reissueActivation(client, tenantA.companyId, accountId));
    expect(reissued?.email).toBe(created.body.email);
    expect(reissued?.activation.rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const password = `Synthetic-${randomBytes(12).toString('hex')}`;
    const stale = await send(() => http().post('/api/v1/auth/activate').send({ token: firstToken, password }));
    expect(stale.status).toBe(400);
    const fresh = await send(() => http().post('/api/v1/auth/activate')
      .send({ token: reissued!.activation.rawToken, password }));
    expect(fresh.status).toBe(200);
    expect(await accountStatus(accountId)).toBe('ACTIVE');

    // Once active (or deactivated), there is nothing to reissue.
    expect(await database.withTransaction((client) =>
      accounts.reissueActivation(client, tenantA.companyId, accountId))).toBeNull();
    expect(await database.withTransaction((client) =>
      accounts.reissueActivation(client, tenantA.companyId, tenantA.employee.accountId))).toBeNull();
  });
});
