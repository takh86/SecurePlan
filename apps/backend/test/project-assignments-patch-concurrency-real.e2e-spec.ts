/**
 * SP-09 — concurrent corrections (PATCH) against REAL PostgreSQL.
 *
 * Deterministic barriers (held transaction + pg_blocking_pids), no sleeps.
 * Proves the deterministic lock order (employees by id, then projects, then
 * the assignment row), so opposing employee corrections cannot deadlock, and
 * that the employee/month invariant survives concurrent corrections/creates.
 * #64 case 1: employment dates changed concurrently are judged under the
 * correction's employee lock, in both orders.
 * #64 decision B: the same holds for moving a historical row into a future month.
 * #64 future-target status guard: status changes of the unchanged employee or
 * project are judged under the correction's employee/project locks, in both orders.
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

async function auditCount(): Promise<number> {
  return (await db().query<{ n: number }>(
    'SELECT count(*)::int AS n FROM audit_event WHERE company_id = $1',
    [tenant.companyId],
  )).rows[0].n;
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

describe('#64 case 1 — employment changes and FUTURE corrections are serialized on the employee row', () => {
  const corrections = {
    'project only': () => ({ projectId: south.projectId }),
    'month only': () => ({ monthStart: '2027-04-01' }),
    'employee only': () => ({ employeeId: jonas.employeeId }),
  };

  it.each([
    ['project only', 'mira', "employment_end = '2027-02-28'"],
    ['month only', 'mira', "employment_end = '2027-03-31'"],
    ['employee only', 'jonas', "employment_start = '2027-04-01'"],
    ['employee only', 'jonas', 'employment_start = NULL'],
  ] as const)('%s: %s\'s employment changed (%s) and committed while the correction waits: 409, nothing written', async (kind, who, set) => {
    const x = await seed(mira, north, '2027-03-01');
    const audits = await auditCount();
    const change = await begin();
    await change.client.query(`UPDATE employees SET ${set} WHERE id = $1`, [(who === 'mira' ? mira : jonas).employeeId]);
    const attempt = send('patch', `${BASE}/${x}`, admins[0], corrections[kind]());
    await waitForBlocked(change.pid);
    await finish(change, 'COMMIT');

    const response = await attempt;
    expect([response.status, response.body.code]).toEqual([409, 'EMPLOYEE_NOT_EMPLOYED_FOR_MONTH']);
    expect(await rows('2027-03-01')).toEqual([{ employee_id: mira.employeeId, project_id: north.projectId }]);
    expect(await auditCount()).toBe(audits);
  });

  it.each([
    ['evidence added and committed', 'COMMIT', "employment_start = '2027-03-31'", null],
    ['evidence removed but rolled back', 'ROLLBACK', 'employment_start = NULL', '2026-01-01'],
  ] as const)('%s while the correction waits: only committed dates count (200)', async (_label, command, set, initialStart) => {
    const x = await seed(mira, north, '2027-03-01');
    await db().query('UPDATE employees SET employment_start = $2::date WHERE id = $1', [mira.employeeId, initialStart]);
    const change = await begin();
    await change.client.query(`UPDATE employees SET ${set} WHERE id = $1`, [mira.employeeId]);
    const attempt = send('patch', `${BASE}/${x}`, admins[0], { projectId: south.projectId });
    await waitForBlocked(change.pid);
    await finish(change, command);

    expect((await attempt).status).toBe(200);
    expect(await rows('2027-03-01')).toEqual([{ employee_id: mira.employeeId, project_id: south.projectId }]);
  });

  it('other order: a change arriving while the correction holds the employee lock waits for it; no deadlock', async () => {
    const x = await seed(mira, north, '2027-03-01');
    // Gate on the stored project: the correction takes it (FOR SHARE) only AFTER locking the employees.
    const gate = await begin();
    await gate.client.query('SELECT 1 FROM projects WHERE id = $1 FOR UPDATE', [north.projectId]);
    const attempt = send('patch', `${BASE}/${x}`, admins[0], { projectId: south.projectId });
    await waitForBlocked(gate.pid);
    const change = await begin();
    const changed = change.client.query("UPDATE employees SET employment_end = '2027-02-28' WHERE id = $1", [mira.employeeId]);
    void changed.catch(() => {});
    await waitForBlocked(gate.pid, 2); // the change queues behind the correction, not beside it
    await finish(gate, 'ROLLBACK');

    // Decided on the dates committed when the correction took the lock.
    const response = await attempt;
    expect(response.status).toBe(200);
    expect(await rows('2027-03-01')).toEqual([{ employee_id: mira.employeeId, project_id: south.projectId }]);
    // The change proceeds only afterwards. Whether it may commit against a future row is #64 case 2
    // (not part of this slice; raw SQL here bypasses the employee service anyway).
    await changed;
    await finish(change, 'COMMIT');
  });
});

describe('#64 decision B — moving a historical row into a future month is judged under the same employee lock', () => {
  // The clock says December 2026: November is past, December current, March 2027 future.
  it.each([
    ['a past month', '2026-11-01'],
    ['the current month', '2026-12-01'],
  ] as const)('from %s: employment ended before the target month, committed while the move waits: 409, nothing written', async (_label, month) => {
    const x = await seed(mira, north, month);
    const audits = await auditCount();
    const change = await begin();
    await change.client.query("UPDATE employees SET employment_end = '2027-02-28' WHERE id = $1", [mira.employeeId]);
    const attempt = send('patch', `${BASE}/${x}`, admins[0], { monthStart: '2027-03-01' });
    await waitForBlocked(change.pid);
    await finish(change, 'COMMIT');

    const response = await attempt;
    expect([response.status, response.body.code]).toEqual([409, 'EMPLOYEE_NOT_EMPLOYED_FOR_MONTH']);
    expect(await rows(month)).toEqual([{ employee_id: mira.employeeId, project_id: north.projectId }]);
    expect(await rows('2027-03-01')).toEqual([]);
    expect(await auditCount()).toBe(audits);
  });

  it.each([
    ['evidence added and committed', 'COMMIT', "employment_start = '2027-03-31'", null],
    ['evidence removed but rolled back', 'ROLLBACK', 'employment_start = NULL', '2026-01-01'],
  ] as const)('%s while the move waits: only committed dates count (200, one audit entry)', async (_label, command, set, initialStart) => {
    const x = await seed(mira, north, '2026-11-01');
    await db().query('UPDATE employees SET employment_start = $2::date WHERE id = $1', [mira.employeeId, initialStart]);
    const audits = await auditCount();
    const change = await begin();
    await change.client.query(`UPDATE employees SET ${set} WHERE id = $1`, [mira.employeeId]);
    const attempt = send('patch', `${BASE}/${x}`, admins[0], { monthStart: '2027-03-01' });
    await waitForBlocked(change.pid);
    await finish(change, command);

    expect((await attempt).status).toBe(200);
    expect(await rows('2027-03-01')).toEqual([{ employee_id: mira.employeeId, project_id: north.projectId }]);
    expect(await auditCount()).toBe(audits + 1);
  });

  it('other order: an employment change arriving while the move holds the employee lock waits for it; no deadlock', async () => {
    const x = await seed(mira, north, '2026-11-01');
    // Gate on the stored project: the move takes it (FOR SHARE) only AFTER locking the employee.
    const gate = await begin();
    await gate.client.query('SELECT 1 FROM projects WHERE id = $1 FOR UPDATE', [north.projectId]);
    const attempt = send('patch', `${BASE}/${x}`, admins[0], { monthStart: '2027-03-01' });
    await waitForBlocked(gate.pid);
    const change = await begin();
    const changed = change.client.query("UPDATE employees SET employment_end = '2027-02-28' WHERE id = $1", [mira.employeeId]);
    void changed.catch(() => {});
    await waitForBlocked(gate.pid, 2); // the change queues behind the move, not beside it
    await finish(gate, 'ROLLBACK');

    // Decided on the dates committed when the move took the lock.
    expect((await attempt).status).toBe(200);
    expect(await rows('2027-03-01')).toEqual([{ employee_id: mira.employeeId, project_id: north.projectId }]);
    await changed;
    await finish(change, 'COMMIT');
  });

  it('a move and a create for the same employee and target month: exactly one wins, one audit entry', async () => {
    const x = await seed(mira, north, '2026-11-01');
    const audits = await auditCount();
    const gate = await begin();
    await gate.client.query('SELECT 1 FROM employees WHERE id = $1 FOR UPDATE', [mira.employeeId]);
    const move = send('patch', `${BASE}/${x}`, admins[0], { monthStart: '2027-04-01' });
    const creation = send('post', BASE, admins[1], { employeeId: mira.employeeId, projectId: south.projectId, monthStart: '2027-04-01' });
    await waitForBlocked(gate.pid, 2);
    await finish(gate, 'ROLLBACK');

    const responses = await Promise.all([move, creation]);
    expect(responses.filter((response) => response.status < 300)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409).map((response) => response.body.code))
      .toEqual(['PROJECT_ASSIGNMENT_CONFLICT']);
    expect(await rows('2027-04-01')).toHaveLength(1);
    expect(await auditCount()).toBe(audits + 1);
  });
});

describe('#64 future-target status guard — status changes of unchanged references are serialized on their rows', () => {
  // The clock says December 2026: November is past, December current, January 2027 and later future.
  const ref = (table: 'employees' | 'projects') => (table === 'employees' ? mira.employeeId : north.projectId);

  it.each([
    ['a past month', '2026-11-01', 'employees', 'DEACTIVATED', 'EMPLOYEE_INACTIVE'],
    ['a past month', '2026-11-01', 'projects', 'INACTIVE', 'PROJECT_INACTIVE'],
    ['a past month', '2026-11-01', 'projects', 'ARCHIVED', 'PROJECT_INACTIVE'],
    ['the current month', '2026-12-01', 'employees', 'DEACTIVATED', 'EMPLOYEE_INACTIVE'],
    ['the current month', '2026-12-01', 'projects', 'ARCHIVED', 'PROJECT_INACTIVE'],
    ['a future month', '2027-01-01', 'employees', 'DEACTIVATED', 'EMPLOYEE_INACTIVE'],
    ['a future month', '2027-01-01', 'projects', 'INACTIVE', 'PROJECT_INACTIVE'],
  ] as const)('from %s (%s): %s set to %s and committed while the move waits: 409 %s, nothing written', async (_label, month, table, status, code) => {
    const x = await seed(mira, north, month);
    const audits = await auditCount();
    const change = await begin();
    await change.client.query(`UPDATE ${table} SET status = $2 WHERE id = $1`, [ref(table), status]);
    const attempt = send('patch', `${BASE}/${x}`, admins[0], { monthStart: '2027-03-01' });
    await waitForBlocked(change.pid);
    await finish(change, 'COMMIT');

    const response = await attempt;
    expect([response.status, response.body.code]).toEqual([409, code]);
    expect(await rows(month)).toEqual([{ employee_id: mira.employeeId, project_id: north.projectId }]);
    expect(await rows('2027-03-01')).toEqual([]);
    expect(await auditCount()).toBe(audits);
  });

  it.each([
    ['employees', 'DEACTIVATED'],
    ['projects', 'ARCHIVED'],
  ] as const)('%s set to %s but rolled back while the move waits: only committed status counts (200, one audit entry)', async (table, status) => {
    const x = await seed(mira, north, '2026-11-01');
    const audits = await auditCount();
    const change = await begin();
    await change.client.query(`UPDATE ${table} SET status = $2 WHERE id = $1`, [ref(table), status]);
    const attempt = send('patch', `${BASE}/${x}`, admins[0], { monthStart: '2027-03-01' });
    await waitForBlocked(change.pid);
    await finish(change, 'ROLLBACK');

    expect((await attempt).status).toBe(200);
    expect(await rows('2027-03-01')).toEqual([{ employee_id: mira.employeeId, project_id: north.projectId }]);
    expect(await auditCount()).toBe(audits + 1);
  });

  it.each([
    ['employees', 'DEACTIVATED'],
    ['projects', 'INACTIVE'],
  ] as const)('other order: %s set to %s while the move holds its locks waits for it; no deadlock', async (table, status) => {
    const x = await seed(mira, north, '2026-11-01');
    // Gate on the assignment row: the move locks it (FOR UPDATE) only AFTER the employee and the project.
    const gate = await begin();
    await gate.client.query('SELECT 1 FROM project_assignments WHERE id = $1 FOR UPDATE', [x]);
    const attempt = send('patch', `${BASE}/${x}`, admins[0], { monthStart: '2027-03-01' });
    await waitForBlocked(gate.pid);
    const change = await begin();
    const changed = change.client.query(`UPDATE ${table} SET status = $2 WHERE id = $1`, [ref(table), status]);
    void changed.catch(() => {});
    await waitForBlocked(gate.pid, 2); // the change queues behind the move, not beside it
    await finish(gate, 'ROLLBACK');

    // Decided on the status committed when the move took its locks.
    expect((await attempt).status).toBe(200);
    expect(await rows('2027-03-01')).toEqual([{ employee_id: mira.employeeId, project_id: north.projectId }]);
    await changed;
    await finish(change, 'COMMIT');
  });
});
