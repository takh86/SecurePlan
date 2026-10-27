/**
 * SP-09 — concurrent corrections (PATCH) against REAL PostgreSQL.
 *
 * Deterministic barriers (held transaction + pg_blocking_pids), no sleeps.
 * Proves the deterministic lock order (employees by id, then projects, then
 * the assignment row), so opposing employee corrections cannot deadlock, and
 * that the employee/month invariant survives concurrent corrections/creates.
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { SessionService } from '../src/auth/session.service.js';
import {
  backendPid,
  createSyntheticAccount,
  createSyntheticEmployee,
  createSyntheticProject,
  createSyntheticSession,
  createSyntheticTenant,
  openLocalTestPool,
  realSessionService,
  removeSyntheticTenants,
  type SyntheticEmployee,
  type SyntheticProject,
  type SyntheticSession,
  type SyntheticTenant,
  type TestPool,
} from './helpers/synthetic-tenants.js';
import { ORIGIN, RecordingDelivery, bootEmployeesApp } from './helpers/employees-test-app.js';

const BASE = '/api/v1/project-assignments';

let pool: TestPool | undefined;
let sessions: SessionService;
let app: INestApplication<App> | undefined;
let tenant: SyntheticTenant;
let mira: SyntheticEmployee;
let jonas: SyntheticEmployee;
let north: SyntheticProject;
let south: SyntheticProject;
let admins: SyntheticSession[];
const createdCompanies: string[] = [];
let previousOrigin: string | undefined;

type Held = { client: PoolClient; pid: number; open: boolean };
const held: Held[] = [];
const inFlight = new Set<Promise<unknown>>();

function db(): TestPool {
  if (!pool) throw new Error('Test database is unavailable');
  return pool;
}

/** Starts a request NOW and tracks it so a failing test can never leak it. */
function send(method: 'post' | 'patch', path: string, session: SyntheticSession, body: object) {
  const promise = Promise.resolve(
    request(app!.getHttpServer())[method](path)
      .set('Origin', ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send(body),
  );
  inFlight.add(promise);
  void promise.finally(() => inFlight.delete(promise)).catch(() => {});
  return promise;
}

async function begin(): Promise<Held> {
  const client = await db().connect();
  const transaction: Held = { client, pid: 0, open: true };
  held.push(transaction);
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '10s'");
  transaction.pid = await backendPid(client);
  return transaction;
}

async function finish(transaction: Held, command: 'COMMIT' | 'ROLLBACK'): Promise<void> {
  if (!transaction.open) return;
  transaction.open = false;
  try {
    await transaction.client.query(command);
    transaction.client.release();
  } catch (error) {
    transaction.client.release(true);
    if (command === 'COMMIT') throw error;
  }
}

/** At least `count` backends (transitively) wait on a lock held by `holderPid`. */
async function waitForBlocked(holderPid: number, count = 1, maxChecks = 4000): Promise<void> {
  for (let check = 0; check < maxChecks; check += 1) {
    const result = await db().query(
      `WITH RECURSIVE waiters(pid) AS (
         SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))
         UNION
         SELECT a.pid FROM pg_stat_activity a JOIN waiters w ON w.pid = ANY(pg_blocking_pids(a.pid))
       )
       SELECT pid FROM waiters`,
      [holderPid],
    );
    if (result.rows.length >= count) return;
  }
  throw new Error(`Fewer than ${count} backend(s) ever blocked on ${holderPid}`);
}

async function seed(employee: SyntheticEmployee, project: SyntheticProject, month: string): Promise<string> {
  const id = randomUUID();
  await db().query(
    `INSERT INTO project_assignments (id, company_id, employee_id, project_id, planning_month)
     VALUES ($1, $2, $3, $4, $5::date)`,
    [id, tenant.companyId, employee.employeeId, project.projectId, month],
  );
  return id;
}

async function rows(month: string) {
  return (await db().query<{ employee_id: string; project_id: string }>(
    `SELECT employee_id, project_id FROM project_assignments WHERE company_id = $1 AND planning_month = $2::date`,
    [tenant.companyId, month],
  )).rows;
}

const codes = (responses: { status: number; body: { code?: string } }[]) =>
  responses.map((response) => `${response.status}${response.body.code ? ` ${response.body.code}` : ''}`).sort();

beforeAll(() => {
  pool = openLocalTestPool(14);
  sessions = realSessionService(db());
  previousOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
});

beforeEach(async () => {
  tenant = await createSyntheticTenant(db(), 'SP09 PATCH Concurrency');
  createdCompanies.push(tenant.companyId);
  mira = await createSyntheticEmployee(db(), tenant.employee, 'K-001', { start: '2026-01-01' });
  jonas = await createSyntheticEmployee(
    db(), await createSyntheticAccount(db(), tenant.companyId, 'EMPLOYEE'), 'K-002', { start: '2026-01-01' },
  );
  north = await createSyntheticProject(db(), tenant.companyId, 'Objekt Nord');
  south = await createSyntheticProject(db(), tenant.companyId, 'Objekt Süd');
  admins = await Promise.all([1, 2, 3].map(() => createSyntheticSession(sessions, tenant.admin)));
  // Pinned to December 2026: all months used below (2027) are FUTURE corrections.
  app = await bootEmployeesApp(new RecordingDelivery(), { clock: () => new Date('2026-12-15T12:00:00Z') });
});

afterEach(async () => {
  for (const transaction of held.splice(0).reverse()) await finish(transaction, 'ROLLBACK');
  await Promise.allSettled(inFlight);
  if (app) await app.close();
  app = undefined;
  const ids = createdCompanies.splice(0);
  try {
    await removeSyntheticTenants(db(), ids);
  } catch (error) {
    throw new Error(`SP-09 PATCH concurrency cleanup FAILED for companies ${ids.join(', ')}`, { cause: error });
  }
});

afterAll(async () => {
  await pool?.end();
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousOrigin;
});

describe('SP-09 PATCH — opposing employee corrections (D4)', () => {
  it('two corrections that swap employees in opposite directions both succeed: no deadlock, no 500', async () => {
    const x = await seed(mira, north, '2027-03-01'); // mira -> jonas
    const y = await seed(jonas, south, '2027-04-01'); // jonas -> mira
    // Barrier: both requests queue behind a lock the test holds on an involved employee.
    const gate = await begin();
    await gate.client.query('SELECT 1 FROM employees WHERE id = $1 FOR UPDATE', [mira.employeeId]);
    const first = send('patch', `${BASE}/${x}`, admins[0], { employeeId: jonas.employeeId });
    const second = send('patch', `${BASE}/${y}`, admins[1], { employeeId: mira.employeeId });
    await waitForBlocked(gate.pid, 2);
    await finish(gate, 'ROLLBACK');

    const responses = await Promise.all([first, second]);
    expect(codes(responses)).toEqual(['200', '200']);
    expect((await rows('2027-03-01'))[0].employee_id).toBe(jonas.employeeId);
    expect((await rows('2027-04-01'))[0].employee_id).toBe(mira.employeeId);
  });

  it('opposing corrections that target the same slots: exactly the invariant-safe outcome, never a 500', async () => {
    const x = await seed(mira, north, '2027-03-01');
    const y = await seed(jonas, south, '2027-03-01');
    // x wants jonas, y wants mira in the SAME month: each would collide with the other's current row.
    const gate = await begin();
    await gate.client.query('SELECT 1 FROM employees WHERE id = $1 FOR UPDATE', [jonas.employeeId]);
    const first = send('patch', `${BASE}/${x}`, admins[0], { employeeId: jonas.employeeId });
    const second = send('patch', `${BASE}/${y}`, admins[1], { employeeId: mira.employeeId });
    await waitForBlocked(gate.pid, 2);
    await finish(gate, 'ROLLBACK');

    const responses = await Promise.all([first, second]);
    expect(codes(responses)).toEqual(['409 PROJECT_ASSIGNMENT_CONFLICT', '409 PROJECT_ASSIGNMENT_CONFLICT']);
    expect((await rows('2027-03-01')).map((row) => row.employee_id).sort()).toEqual([mira.employeeId, jonas.employeeId].sort());
  });
});

describe('SP-09 PATCH — one project per employee and month under concurrency', () => {
  it('two corrections moving different rows of one employee into the same month: exactly one wins', async () => {
    const x = await seed(mira, north, '2027-03-01');
    const y = await seed(mira, south, '2027-05-01');
    const gate = await begin();
    await gate.client.query('SELECT 1 FROM employees WHERE id = $1 FOR UPDATE', [mira.employeeId]);
    const first = send('patch', `${BASE}/${x}`, admins[0], { monthStart: '2027-04-01' });
    const second = send('patch', `${BASE}/${y}`, admins[1], { monthStart: '2027-04-01' });
    await waitForBlocked(gate.pid, 2);
    await finish(gate, 'ROLLBACK');

    expect(codes(await Promise.all([first, second]))).toEqual(['200', '409 PROJECT_ASSIGNMENT_CONFLICT']);
    expect(await rows('2027-04-01')).toHaveLength(1);
  });

  it('a correction and a create fighting for the same employee/month: exactly one wins', async () => {
    const x = await seed(mira, north, '2027-03-01');
    const gate = await begin();
    await gate.client.query('SELECT 1 FROM employees WHERE id = $1 FOR UPDATE', [mira.employeeId]);
    const correction = send('patch', `${BASE}/${x}`, admins[0], { monthStart: '2027-04-01' });
    const creation = send('post', BASE, admins[1], { employeeId: mira.employeeId, projectId: south.projectId, monthStart: '2027-04-01' });
    await waitForBlocked(gate.pid, 2);
    await finish(gate, 'ROLLBACK');

    const responses = await Promise.all([correction, creation]);
    const winners = responses.filter((response) => response.status < 300);
    const losers = responses.filter((response) => response.status === 409);
    expect([winners.length, losers.length]).toEqual([1, 1]);
    expect(losers[0].body.code).toBe('PROJECT_ASSIGNMENT_CONFLICT');
    expect(await rows('2027-04-01')).toHaveLength(1);
  });

  it('the row is changed behind the correction\'s back: 409, never a blind overwrite', async () => {
    const x = await seed(mira, north, '2027-03-01');
    const other = await begin();
    await other.client.query(
      "UPDATE project_assignments SET planning_month = '2027-06-01' WHERE id = $1",
      [x],
    );
    const attempt = send('patch', `${BASE}/${x}`, admins[0], { projectId: south.projectId });
    await waitForBlocked(other.pid);
    await finish(other, 'COMMIT');

    const response = await attempt;
    expect([response.status, response.body.code]).toEqual([409, 'PROJECT_ASSIGNMENT_CONFLICT']);
    expect((await rows('2027-06-01'))[0].project_id).toBe(north.projectId);
  });
});

describe('SP-09 PATCH — lifecycle changes are observed', () => {
  it('an employee deactivated while the correction waits: 409 EMPLOYEE_INACTIVE, row unchanged', async () => {
    const x = await seed(mira, north, '2027-03-01');
    const deactivation = await begin();
    await deactivation.client.query("UPDATE employees SET status = 'DEACTIVATED' WHERE id = $1", [jonas.employeeId]);
    const attempt = send('patch', `${BASE}/${x}`, admins[0], { employeeId: jonas.employeeId });
    await waitForBlocked(deactivation.pid);
    await finish(deactivation, 'COMMIT');

    const response = await attempt;
    expect([response.status, response.body.code]).toEqual([409, 'EMPLOYEE_INACTIVE']);
    expect((await rows('2027-03-01'))[0].employee_id).toBe(mira.employeeId);
  });

  it('a target project switched to INACTIVE while the correction waits: 409 PROJECT_INACTIVE, row unchanged', async () => {
    const x = await seed(mira, north, '2027-03-01');
    const statusChange = await begin();
    await statusChange.client.query("UPDATE projects SET status = 'INACTIVE' WHERE id = $1", [south.projectId]);
    const attempt = send('patch', `${BASE}/${x}`, admins[0], { projectId: south.projectId });
    await waitForBlocked(statusChange.pid);
    await finish(statusChange, 'COMMIT');

    const response = await attempt;
    expect([response.status, response.body.code]).toEqual([409, 'PROJECT_INACTIVE']);
    expect((await rows('2027-03-01'))[0].project_id).toBe(north.projectId);
  });
});
