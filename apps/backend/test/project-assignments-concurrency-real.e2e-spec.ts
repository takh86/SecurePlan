/**
 * SP-09 — concurrent month assignments against REAL PostgreSQL.
 *
 * Interleavings are forced with deterministic barriers (a held transaction +
 * pg_blocking_pids), never with sleeps. They prove that concurrent writes
 * cannot silently violate "at most one project per employee and month", and
 * that a concurrent employee deactivation or project status change is
 * observed instead of being bypassed.
 *
 * Requires a migrated LOCAL PostgreSQL (0001–0008); synthetic fixtures only.
 */
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { SessionService } from '../src/auth/session.service.js';
import {
  backendPid,
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
const NOV = '2026-11-01';

let pool: TestPool | undefined;
let sessions: SessionService;
let app: INestApplication<App> | undefined;
let tenantA: SyntheticTenant;
let employeeA: SyntheticEmployee;
let north: SyntheticProject;
let south: SyntheticProject;
let adminA: SyntheticSession;
let secondAdmin: SyntheticSession;
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
function assign(session: SyntheticSession, project: SyntheticProject, monthStart = NOV) {
  const promise = Promise.resolve(
    request(app!.getHttpServer()).post(BASE)
      .set('Origin', ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf)
      .send({ employeeId: employeeA.employeeId, projectId: project.projectId, monthStart }),
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
  // Safety net: a regression must fail, not hang the suite.
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

/**
 * Resolves once at least `count` backends (transitively) wait on a lock held
 * by `holderPid`. Transitive, because PostgreSQL queues row-lock waiters: the
 * second waiter is reported as blocked by the FIRST WAITER, not the holder.
 */
async function waitForBlocked(holderPid: number, count = 1, maxChecks = 4000): Promise<void> {
  for (let check = 0; check < maxChecks; check += 1) {
    const result = await db().query<{ pid: number }>(
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

async function rows() {
  return (await db().query<{ project_id: string }>(
    'SELECT project_id FROM project_assignments WHERE company_id = $1 AND employee_id = $2 AND planning_month = $3::date',
    [tenantA.companyId, employeeA.employeeId, NOV],
  )).rows;
}

async function auditCount(): Promise<number> {
  return (await db().query(
    "SELECT count(*)::int AS n FROM audit_event WHERE company_id = $1 AND action = 'PROJECT_ASSIGNMENT_CREATED'",
    [tenantA.companyId],
  )).rows[0].n;
}

beforeAll(() => {
  pool = openLocalTestPool(12);
  sessions = realSessionService(db());
  previousOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
});

beforeEach(async () => {
  tenantA = await createSyntheticTenant(db(), 'SP09 Concurrency');
  createdCompanies.push(tenantA.companyId);
  employeeA = await createSyntheticEmployee(db(), tenantA.employee, 'K-001', { start: '2026-01-01' });
  north = await createSyntheticProject(db(), tenantA.companyId, 'Objekt Nord');
  south = await createSyntheticProject(db(), tenantA.companyId, 'Objekt Süd');
  adminA = await createSyntheticSession(sessions, tenantA.admin);
  secondAdmin = await createSyntheticSession(sessions, tenantA.admin);
  app = await bootEmployeesApp(new RecordingDelivery());
});

afterEach(async () => {
  // Order matters: release held locks, let in-flight work settle, then close.
  for (const transaction of held.splice(0).reverse()) await finish(transaction, 'ROLLBACK');
  await Promise.allSettled(inFlight);
  if (app) await app.close();
  app = undefined;
  const ids = createdCompanies.splice(0);
  try {
    await removeSyntheticTenants(db(), ids);
  } catch (error) {
    throw new Error(`SP-09 fixture cleanup FAILED for companies ${ids.join(', ')}`, { cause: error });
  }
});

afterAll(async () => {
  await pool?.end();
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousOrigin;
});

describe('SP-09 — concurrent duplicate assignments', () => {
  it.each([
    ['different projects', () => south, 'PROJECT_ASSIGNMENT_CONFLICT'],
    ['the same project', () => north, 'PROJECT_ASSIGNMENT_ALREADY_EXISTS'],
  ] as const)('two admins assign the employee to %s at once: exactly one wins, one row', async (_label, second, code) => {
    // Barrier: both requests queue on the employee row lock held by the test.
    const gate = await begin();
    await gate.client.query('SELECT 1 FROM employees WHERE id = $1 FOR UPDATE', [employeeA.employeeId]);
    const first = assign(adminA, north);
    const other = assign(secondAdmin, second());
    await waitForBlocked(gate.pid, 2);
    await finish(gate, 'ROLLBACK');

    const responses = await Promise.all([first, other]);
    const statuses = responses.map((response) => response.status).sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);
    const loser = responses.find((response) => response.status === 409)!;
    expect(loser.body.code).toBe(code);
    expect(await rows()).toHaveLength(1);
    expect(await auditCount()).toBe(1);
  });

  it('a racing insert that bypasses the pre-check is stopped by the UNIQUE constraint and mapped to 409', async () => {
    // A competing, still uncommitted assignment holds the unique key.
    const competitor = await begin();
    await competitor.client.query(
      'INSERT INTO project_assignments (company_id, employee_id, project_id, planning_month) VALUES ($1, $2, $3, $4::date)',
      [tenantA.companyId, employeeA.employeeId, north.projectId, NOV],
    );
    const attempt = assign(adminA, south);
    // Barrier: the HTTP create passed its pre-check and now waits on the unique index.
    await waitForBlocked(competitor.pid);
    await finish(competitor, 'COMMIT');

    const response = await attempt;
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('PROJECT_ASSIGNMENT_CONFLICT');
    expect((await rows()).map((row) => row.project_id)).toEqual([north.projectId]);
    expect(await auditCount()).toBe(0);
  });

  it('two raw inserts without the application: the second one fails with a unique violation', async () => {
    const first = await begin();
    await first.client.query(
      'INSERT INTO project_assignments (company_id, employee_id, project_id, planning_month) VALUES ($1, $2, $3, $4::date)',
      [tenantA.companyId, employeeA.employeeId, north.projectId, NOV],
    );
    const second = await begin();
    const pending = second.client.query(
      'INSERT INTO project_assignments (company_id, employee_id, project_id, planning_month) VALUES ($1, $2, $3, $4::date)',
      [tenantA.companyId, employeeA.employeeId, south.projectId, NOV],
    );
    pending.catch(() => {});
    await waitForBlocked(first.pid);
    await finish(first, 'COMMIT');
    await expect(pending).rejects.toMatchObject({ code: '23505', constraint: 'uq_project_assignments__employee_month' });
    await finish(second, 'ROLLBACK');
    expect(await rows()).toHaveLength(1);
  });
});

describe('SP-09 — concurrent lifecycle changes are observed, not bypassed', () => {
  it('an employee deactivation committed while the create waits yields 409 EMPLOYEE_INACTIVE and no row', async () => {
    const deactivation = await begin();
    await deactivation.client.query(
      "UPDATE employees SET status = 'DEACTIVATED', deactivated_at = now() WHERE id = $1",
      [employeeA.employeeId],
    );
    const attempt = assign(adminA, north);
    await waitForBlocked(deactivation.pid);
    await finish(deactivation, 'COMMIT');

    const response = await attempt;
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('EMPLOYEE_INACTIVE');
    expect(await rows()).toEqual([]);
  });

  it.each([
    ['moved after the month', "employment_start = '2027-01-01'", 409, 'EMPLOYEE_NOT_EMPLOYED_FOR_MONTH'],
    ['ended before the month', "employment_end = '2026-10-31'", 409, 'EMPLOYEE_NOT_EMPLOYED_FOR_MONTH'],
    ['widened to cover the month (was start-less)', "employment_start = '2026-01-01'", 201, undefined],
  ] as const)('F-1: employment period %s while the create waits is observed under the row lock', async (_label, set, status, code) => {
    if (status === 201) {
      await db().query('UPDATE employees SET employment_start = NULL WHERE id = $1', [employeeA.employeeId]);
    }
    const change = await begin();
    await change.client.query(`UPDATE employees SET ${set} WHERE id = $1`, [employeeA.employeeId]);
    const attempt = assign(adminA, north);
    await waitForBlocked(change.pid);
    await finish(change, 'COMMIT');

    const response = await attempt;
    expect(response.status).toBe(status);
    if (code) {
      expect(response.body.code).toBe(code);
      expect(await rows()).toEqual([]);
      expect(await auditCount()).toBe(0);
    } else {
      expect(await rows()).toHaveLength(1);
      expect(await auditCount()).toBe(1);
    }
  });

  it('a project switched to INACTIVE while the create waits yields 409 PROJECT_INACTIVE and no row', async () => {
    const statusChange = await begin();
    await statusChange.client.query("UPDATE projects SET status = 'INACTIVE' WHERE id = $1", [north.projectId]);
    const attempt = assign(adminA, north);
    await waitForBlocked(statusChange.pid);
    await finish(statusChange, 'COMMIT');

    const response = await attempt;
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('PROJECT_INACTIVE');
    expect(await rows()).toEqual([]);
  });
});

describe('SP-09 — bounded stress smoke (confidence only, not a proof)', () => {
  it('many parallel creates for one employee/month across two projects leave exactly one row', async () => {
    const extraSessions = await Promise.all(
      Array.from({ length: 6 }, () => createSyntheticSession(sessions, tenantA.admin)),
    );
    const responses = await Promise.all(
      extraSessions.map((session, index) => assign(session, index % 2 === 0 ? north : south)),
    );
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    for (const response of responses.filter((candidate) => candidate.status !== 201)) {
      expect(response.status).toBe(409);
      expect(['PROJECT_ASSIGNMENT_CONFLICT', 'PROJECT_ASSIGNMENT_ALREADY_EXISTS']).toContain(response.body.code);
    }
    expect(await rows()).toHaveLength(1);
  });
});
