/**
 * SP-08b — concurrent shift-configuration writes against REAL PostgreSQL.
 *
 * Interleavings are forced with deterministic barriers (a held transaction +
 * pg_blocking_pids), never with sleeps. They prove:
 * - two PATCHes for the same project and month are serialized by the project
 *   row lock; the stored set is always exactly one complete request
 *   (LAST-WRITER-WINS, both effective changes audited). There is no
 *   Expected-Version precondition in the v1 contract, so the later admin does
 *   overwrite the earlier one; the lock only rules out mixed/partial sets;
 * - a concurrent project deactivation is observed in both lock orders;
 * - a concurrent month assignment on the same project waits and completes
 *   (no deadlock).
 *
 * Requires a migrated LOCAL PostgreSQL (0001–0009); synthetic fixtures only.
 */
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
  type SyntheticProject,
  type SyntheticSession,
  type SyntheticTenant,
  type TestPool,
} from './helpers/synthetic-tenants.js';
import { ORIGIN, RecordingDelivery, bootEmployeesApp } from './helpers/employees-test-app.js';

const MONTH = '2027-01-01';
const DAY = { shiftKind: 'DAY', startLocal: '06:00', endLocal: '18:00' } as const;
const NIGHT = { shiftKind: 'NIGHT', startLocal: '18:00', endLocal: '06:00' } as const;
const FIRST = { effectiveFromMonth: MONTH, shifts: [DAY, NIGHT] };
const SECOND = { effectiveFromMonth: MONTH, shifts: [{ shiftKind: 'DAY', startLocal: '07:00', endLocal: '19:00' }] };

let pool: TestPool | undefined;
let sessions: SessionService;
let app: INestApplication<App> | undefined;
let tenantA: SyntheticTenant;
let north: SyntheticProject;
let adminA: SyntheticSession;
/** A second COMPANY_ADMIN account, so both requests pass their own session guard and meet at the project lock. */
let otherAdmin: SyntheticSession;
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
function track(pending: request.Test) {
  const promise = Promise.resolve(pending);
  inFlight.add(promise);
  void promise.finally(() => inFlight.delete(promise)).catch(() => {});
  return promise;
}

function unsafe(method: 'patch' | 'post', url: string, session: SyntheticSession, body: object) {
  return track(
    request(app!.getHttpServer())[method](url)
      .set('Origin', ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf)
      .send(body),
  );
}

const replaceShifts = (session: SyntheticSession, body: object) =>
  unsafe('patch', `/api/v1/projects/${north.projectId}/shift-configuration`, session, body);

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
 * by `holderPid`. Transitive, because PostgreSQL queues lock waiters: the
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

async function storedSet() {
  return (await db().query(
    `SELECT shift_kind, left(start_local::text, 5) AS start_local, left(end_local::text, 5) AS end_local
     FROM shift_configurations WHERE project_id = $1 AND effective_from_month = $2::date ORDER BY shift_kind DESC`,
    [north.projectId, MONTH],
  )).rows;
}

async function audits(action: string) {
  return (await db().query<{ old_values: unknown; new_values: unknown }>(
    'SELECT old_values, new_values FROM audit_event WHERE company_id = $1 AND action = $2',
    [tenantA.companyId, action],
  )).rows;
}

const asStored = (body: { shifts: { shiftKind: string; startLocal: string; endLocal: string }[] }) =>
  body.shifts.map((s) => ({ shift_kind: s.shiftKind === 'DAY' ? 'TAG' : 'NACHT', start_local: s.startLocal, end_local: s.endLocal }));

beforeAll(() => {
  pool = openLocalTestPool(12);
  sessions = realSessionService(db());
  previousOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
});

beforeEach(async () => {
  tenantA = await createSyntheticTenant(db(), 'SP08b Concurrency');
  createdCompanies.push(tenantA.companyId);
  north = await createSyntheticProject(db(), tenantA.companyId, 'Objekt Nord');
  adminA = await createSyntheticSession(sessions, tenantA.admin);
  otherAdmin = await createSyntheticSession(sessions, await createSyntheticAccount(db(), tenantA.companyId, 'COMPANY_ADMIN'));
  // Clock: 15 Dec 2026, so January 2027 is a writable future month.
  app = await bootEmployeesApp(new RecordingDelivery(), { clock: () => new Date('2026-12-15T12:00:00Z') });
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
    throw new Error(`SP-08b fixture cleanup FAILED for companies ${ids.join(', ')}`, { cause: error });
  }
});

afterAll(async () => {
  await pool?.end();
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousOrigin;
});

describe('SP-08b — concurrent PATCHes on the same project and month', () => {
  it('different sets: serialized, the stored set is exactly the LAST writer\'s complete request; both changes audited as a chain', async () => {
    // Barrier: both requests queue on the project row lock held by the test.
    const gate = await begin();
    await gate.client.query('SELECT 1 FROM projects WHERE id = $1 FOR UPDATE', [north.projectId]);
    const first = replaceShifts(adminA, FIRST);
    const second = replaceShifts(otherAdmin, SECOND);
    await waitForBlocked(gate.pid, 2);
    await finish(gate, 'ROLLBACK');

    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);

    // Lock order decides who is last; the audit chain reveals it: the earlier writer
    // created the version (old = null), the later one replaced exactly that result.
    const chain = await audits('SHIFT_CONFIGURATION_UPDATED');
    expect(chain).toHaveLength(2);
    const created = chain.find((entry) => entry.old_values === null);
    const replaced = chain.find((entry) => entry.old_values !== null);
    expect(created && replaced).toBeTruthy();
    expect(replaced!.old_values).toEqual(created!.new_values);

    const last = replaced!.new_values as typeof FIRST;
    expect([FIRST, SECOND]).toContainEqual(last);
    // Never a mix such as the DAY of one request with the NIGHT of the other.
    expect(await storedSet()).toEqual(asStored(last));
    // The last writer's own response shows exactly the stored set (structural compare: JSONB reorders keys).
    const answered = responses.map((response) => response.body.shifts.map(
      ({ shiftKind, startLocal, endLocal }: { shiftKind: string; startLocal: string; endLocal: string }) => ({ shiftKind, startLocal, endLocal }),
    ));
    expect(answered).toContainEqual(last.shifts);
  });

  it('identical sets: one write and one no-op, a single audit entry', async () => {
    const gate = await begin();
    await gate.client.query('SELECT 1 FROM projects WHERE id = $1 FOR UPDATE', [north.projectId]);
    const first = replaceShifts(adminA, FIRST);
    const second = replaceShifts(otherAdmin, { effectiveFromMonth: MONTH, shifts: [NIGHT, DAY] });
    await waitForBlocked(gate.pid, 2);
    await finish(gate, 'ROLLBACK');

    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses[0].body).toEqual(responses[1].body);
    expect(await audits('SHIFT_CONFIGURATION_UPDATED')).toHaveLength(1);
    expect(await storedSet()).toEqual(asStored(FIRST));
  });
});

describe('SP-08b — PATCH against a concurrent project deactivation', () => {
  it('deactivation commits first: the waiting PATCH observes INACTIVE (409), writes nothing', async () => {
    // Barrier: an uncommitted status change holds the project row (as the project PATCH does).
    const gate = await begin();
    await gate.client.query("UPDATE projects SET status = 'INACTIVE', updated_at = clock_timestamp() WHERE id = $1", [north.projectId]);
    const attempt = replaceShifts(adminA, FIRST);
    await waitForBlocked(gate.pid);
    await finish(gate, 'COMMIT');

    const response = await attempt;
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('PROJECT_INACTIVE');
    expect(await storedSet()).toEqual([]);
    expect(await audits('SHIFT_CONFIGURATION_UPDATED')).toHaveLength(0);
  });

  it('PATCH holds the project lock first: the deactivation waits, then both complete in that order', async () => {
    // Barrier: an uncommitted competing row on the same (project, month, kind) key.
    // The PATCH passes all checks, holds the project lock and waits in INSERT ... ON CONFLICT.
    const gate = await begin();
    await gate.client.query(
      `INSERT INTO shift_configurations (company_id, project_id, effective_from_month, shift_kind, start_local, end_local)
       VALUES ($1, $2, $3::date, 'TAG', '05:00', '17:00')`,
      [tenantA.companyId, north.projectId, MONTH],
    );
    const shiftPatch = replaceShifts(adminA, FIRST);
    await waitForBlocked(gate.pid);
    const deactivate = unsafe('patch', `/api/v1/projects/${north.projectId}`, otherAdmin, { status: 'INACTIVE' });
    await waitForBlocked(gate.pid, 2);
    await finish(gate, 'ROLLBACK');

    const [shift, project] = await Promise.all([shiftPatch, deactivate]);
    expect(shift.status).toBe(200);
    expect(project.status).toBe(200);
    expect(project.body.status).toBe('INACTIVE');
    // The configuration was written while the project was still ACTIVE ...
    expect(await storedSet()).toEqual(asStored(FIRST));
    expect(await audits('SHIFT_CONFIGURATION_UPDATED')).toHaveLength(1);
    expect(await audits('PROJECT_UPDATED')).toHaveLength(1);
    // ... and from now on INACTIVE blocks further writes.
    const blocked = await replaceShifts(adminA, SECOND);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('PROJECT_INACTIVE');
  });
});

describe('SP-08b — PATCH against a concurrent month assignment on the same project', () => {
  it('the assignment waits for the shift PATCH and then completes; no deadlock', async () => {
    const employee = await createSyntheticEmployee(db(), tenantA.employee, 'K-001', { start: '2026-01-01' });
    const gate = await begin();
    await gate.client.query(
      `INSERT INTO shift_configurations (company_id, project_id, effective_from_month, shift_kind, start_local, end_local)
       VALUES ($1, $2, $3::date, 'NACHT', '19:00', '07:00')`,
      [tenantA.companyId, north.projectId, MONTH],
    );
    const shiftPatch = replaceShifts(adminA, FIRST);
    await waitForBlocked(gate.pid);
    // Employee lock (NO KEY UPDATE) then project FOR SHARE: waits behind the shift PATCH.
    const assign = unsafe('post', '/api/v1/project-assignments', otherAdmin, {
      employeeId: employee.employeeId, projectId: north.projectId, monthStart: MONTH,
    });
    await waitForBlocked(gate.pid, 2);
    await finish(gate, 'ROLLBACK');

    const [shift, assignment] = await Promise.all([shiftPatch, assign]);
    expect(shift.status).toBe(200);
    expect(assignment.status).toBe(201);
    expect(await storedSet()).toEqual(asStored(FIRST));
  });
});
