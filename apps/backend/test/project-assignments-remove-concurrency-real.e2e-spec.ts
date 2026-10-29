/**
 * #73 — concurrent removal (DELETE) of FUTURE month assignments against REAL
 * PostgreSQL, and the version under concurrency (TL sign-off S-2 R2).
 *
 * Deterministic barriers, no sleeps: a held test transaction locks one row a
 * request needs LATER in its lock order (actor -> employee -> project ->
 * assignment), so the order of the two contenders is fixed; the wait itself
 * is proven through pg_blocking_pids (waitForBlocked). Raw UPDATEs below are
 * simulated foreign writers that apply the production touch expression
 * PROJECT_ASSIGNMENT_TOUCH, as every application writer must.
 * The pinned clock says December 2026: 2027 months are FUTURE.
 * Synthetic data only; migrated LOCAL PostgreSQL.
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { SessionService } from '../src/auth/session.service.js';
import { BusinessAuditService, type BusinessAuditEntry } from '../src/modules/audit/business-audit.service.js';
import { PROJECT_ASSIGNMENT_TOUCH } from '../src/modules/workforce/project-assignments/project-assignment.mapper.js';
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
import { FailingAudit, ORIGIN, RecordingDelivery, bootEmployeesApp } from './helpers/employees-test-app.js';

const BASE = '/api/v1/project-assignments';
const MID_DEC = () => new Date('2026-12-15T12:00:00Z');
const VERSION_SQL = '(extract(epoch FROM updated_at) * 1000000)::bigint::text';

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

type Method = 'post' | 'patch' | 'delete';

/** Starts a request NOW and tracks it so a failing test can never leak it. */
function send(method: Method, path: string, session: SyntheticSession, options: { body?: object; version?: number } = {}) {
  let pending = request(app!.getHttpServer())[method](path)
    .set('Origin', ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf);
  if (options.version !== undefined) pending = pending.set('Expected-Version', String(options.version));
  const promise = Promise.resolve(options.body ? pending.send(options.body) : pending);
  inFlight.add(promise);
  void promise.finally(() => inFlight.delete(promise)).catch(() => {});
  return promise;
}

const removal = (id: string, version: number, admin = admins[0]) => send('delete', `${BASE}/${id}`, admin, { version });
const correction = (id: string, body: object, admin = admins[1]) => send('patch', `${BASE}/${id}`, admin, { body });

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

/**
 * At least `count` backends (transitively) wait on a lock held by `holderPid`
 * (pg_blocking_pids) and report wait_event_type Lock. pg_stat_activity is a
 * per-query snapshot that can lag behind, so both are polling conditions.
 */
async function waitForBlocked(holderPid: number, count = 1, maxChecks = 4000): Promise<void> {
  for (let check = 0; check < maxChecks; check += 1) {
    const result = await db().query(
      `WITH RECURSIVE waiters(pid) AS (
         SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))
         UNION
         SELECT a.pid FROM pg_stat_activity a JOIN waiters w ON w.pid = ANY(pg_blocking_pids(a.pid))
       )
       SELECT w.pid FROM waiters w JOIN pg_stat_activity a ON a.pid = w.pid WHERE a.wait_event_type = 'Lock'`,
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

async function versionOf(id: string): Promise<number | null> {
  const { rows } = await db().query<{ version: string }>(`SELECT ${VERSION_SQL} AS version FROM project_assignments WHERE id = $1`, [id]);
  return rows.length === 0 ? null : Number(rows[0].version);
}

async function row(id: string) {
  return (await db().query<{ employee_id: string; project_id: string; month: string }>(
    'SELECT employee_id, project_id, planning_month::text AS month FROM project_assignments WHERE id = $1',
    [id],
  )).rows[0] ?? null;
}

async function audits(action: string): Promise<{ resource_id: string }[]> {
  return (await db().query<{ resource_id: string }>(
    'SELECT resource_id FROM audit_event WHERE company_id = $1 AND action = $2 ORDER BY occurred_at, id',
    [tenant.companyId, action],
  )).rows;
}

/** Simulated foreign writer: the production UPDATE shape, holding its row lock until finished. */
async function touchRow(transaction: Held, id: string, projectId: string): Promise<void> {
  await transaction.client.query(
    `UPDATE project_assignments SET project_id = $2, ${PROJECT_ASSIGNMENT_TOUCH} WHERE id = $1`,
    [id, projectId],
  );
}

const outcome = (response: { status: number; body: { code?: string } }) =>
  `${response.status}${response.body.code ? ` ${response.body.code}` : ''}`;
const outcomes = (responses: { status: number; body: { code?: string } }[]) => responses.map(outcome).sort();

beforeAll(() => {
  pool = openLocalTestPool(16);
  sessions = realSessionService(db());
  previousOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
});

beforeEach(async () => {
  tenant = await createSyntheticTenant(db(), '#73 REMOVE Concurrency');
  createdCompanies.push(tenant.companyId);
  mira = await createSyntheticEmployee(db(), tenant.employee, 'K-001', { start: '2026-01-01' });
  jonas = await createSyntheticEmployee(
    db(), await createSyntheticAccount(db(), tenant.companyId, 'EMPLOYEE'), 'K-002', { start: '2026-01-01' },
  );
  north = await createSyntheticProject(db(), tenant.companyId, 'Objekt Nord');
  south = await createSyntheticProject(db(), tenant.companyId, 'Objekt Süd');
  admins = await Promise.all([1, 2, 3, 4].map(() => createSyntheticSession(sessions, tenant.admin)));
  app = await bootEmployeesApp(new RecordingDelivery(), { clock: MID_DEC });
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
    throw new Error(`#73 REMOVE concurrency cleanup FAILED for companies ${ids.join(', ')}`, { cause: error });
  }
});

afterAll(async () => {
  await pool?.end();
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousOrigin;
});

/** Real audit writer whose FIRST removal audit fails (that transaction rolls back); later ones succeed. */
class FailFirstRemovalAudit extends BusinessAuditService {
  failed = false;

  override async recordBusinessAction(
    client: Parameters<BusinessAuditService['recordBusinessAction']>[0],
    entry: BusinessAuditEntry,
  ): Promise<void> {
    if (entry.action === 'PROJECT_ASSIGNMENT_REMOVED' && !this.failed) {
      this.failed = true;
      throw new Error('synthetic audit failure (first removal)');
    }
    await super.recordBusinessAction(client, entry);
  }
}

describe('#73 API-CON-08 — two removals of the same row with the same version', () => {
  it('serialized on the employee lock: one 204 with one audit event, the other 404', async () => {
    const x = await seed(mira, north, '2027-03-01');
    const version = (await versionOf(x))!;
    const gate = await begin();
    await gate.client.query('SELECT 1 FROM employees WHERE id = $1 FOR UPDATE', [mira.employeeId]);
    const first = removal(x, version, admins[0]);
    const second = removal(x, version, admins[1]);
    await waitForBlocked(gate.pid, 2);
    await finish(gate, 'ROLLBACK');

    expect(outcomes(await Promise.all([first, second]))).toEqual(['204', '404 RESOURCE_NOT_FOUND']);
    expect(await row(x)).toBeNull();
    expect(await audits('PROJECT_ASSIGNMENT_REMOVED')).toEqual([{ resource_id: x }]);
  });

  it('the first removal rolls back (audit failure): the waiting second one removes the unchanged row (204, one audit)', async () => {
    if (app) await app.close();
    app = await bootEmployeesApp(new RecordingDelivery(), { clock: MID_DEC, audit: new FailFirstRemovalAudit() });
    const x = await seed(mira, north, '2027-03-01');
    const version = (await versionOf(x))!;
    const gate = await begin();
    await gate.client.query('SELECT 1 FROM employees WHERE id = $1 FOR UPDATE', [mira.employeeId]);
    const first = removal(x, version, admins[0]);
    const second = removal(x, version, admins[1]);
    await waitForBlocked(gate.pid, 2);
    await finish(gate, 'ROLLBACK');

    expect(outcomes(await Promise.all([first, second]))).toEqual(['204', '500 INTERNAL_ERROR']);
    expect(await row(x)).toBeNull();
    expect(await audits('PROJECT_ASSIGNMENT_REMOVED')).toEqual([{ resource_id: x }]);
  });
});

describe('#73 API-CON-09 — removal against a correction of the same row, both orders', () => {
  const corrections = {
    'employee change': () => ({ employeeId: jonas.employeeId }),
    'future month change': () => ({ monthStart: '2027-05-01' }),
    'move into history': () => ({ monthStart: '2026-11-01' }),
  };

  it.each(Object.keys(corrections) as (keyof typeof corrections)[])(
    'correction first (%s), committed while the removal waits: removal 409 PROJECT_ASSIGNMENT_CONFLICT, no removal audit',
    async (kind) => {
      const x = await seed(mira, north, '2027-03-01');
      const version = (await versionOf(x))!;
      // Gate on the row: the correction holds employee and project locks and waits on it ...
      const gate = await begin();
      await gate.client.query('SELECT 1 FROM project_assignments WHERE id = $1 FOR UPDATE', [x]);
      const patched = correction(x, corrections[kind]());
      await waitForBlocked(gate.pid);
      // ... and the removal, after its lock-free read, queues behind the correction's employee lock.
      const removed = removal(x, version);
      await waitForBlocked(gate.pid, 2);
      await finish(gate, 'ROLLBACK');

      const [patchResponse, removeResponse] = await Promise.all([patched, removed]);
      expect([outcome(patchResponse), outcome(removeResponse)]).toEqual(['200', '409 PROJECT_ASSIGNMENT_CONFLICT']);
      expect(await row(x)).not.toBeNull();
      expect(await audits('PROJECT_ASSIGNMENT_REMOVED')).toEqual([]);
    },
  );

  it.each(Object.keys(corrections) as (keyof typeof corrections)[])(
    'removal first (%s waits): removal 204, then the correction 404 and no correction audit',
    async (kind) => {
      const x = await seed(mira, north, '2027-03-01');
      const version = (await versionOf(x))!;
      const gate = await begin();
      await gate.client.query('SELECT 1 FROM project_assignments WHERE id = $1 FOR UPDATE', [x]);
      const removed = removal(x, version);
      await waitForBlocked(gate.pid);
      const patched = correction(x, corrections[kind]());
      await waitForBlocked(gate.pid, 2);
      await finish(gate, 'ROLLBACK');

      const [removeResponse, patchResponse] = await Promise.all([removed, patched]);
      expect([outcome(removeResponse), outcome(patchResponse)]).toEqual(['204', '404 RESOURCE_NOT_FOUND']);
      expect(await row(x)).toBeNull();
      expect(await audits('PROJECT_ASSIGNMENT_CORRECTED')).toEqual([]);
      expect(await audits('PROJECT_ASSIGNMENT_REMOVED')).toEqual([{ resource_id: x }]);
    },
  );

  it('the correction first but rolled back (audit failure): the removal sees the unchanged row and removes it (204)', async () => {
    if (app) await app.close();
    app = await bootEmployeesApp(new RecordingDelivery(), { clock: MID_DEC, audit: new FailingAudit('PROJECT_ASSIGNMENT_CORRECTED') });
    const x = await seed(mira, north, '2027-03-01');
    const version = (await versionOf(x))!;
    const gate = await begin();
    await gate.client.query('SELECT 1 FROM project_assignments WHERE id = $1 FOR UPDATE', [x]);
    const patched = correction(x, { projectId: south.projectId });
    await waitForBlocked(gate.pid);
    const removed = removal(x, version);
    await waitForBlocked(gate.pid, 2);
    await finish(gate, 'ROLLBACK');

    const [patchResponse, removeResponse] = await Promise.all([patched, removed]);
    expect([outcome(patchResponse), outcome(removeResponse)]).toEqual(['500 INTERNAL_ERROR', '204']);
    expect(await row(x)).toBeNull();
  });
});

describe('#73 API-CON-10 / API-PROJ-27 — a change committed between the lock-free read and the row lock', () => {
  it('(a) another tuple: removal 409 by the tuple recheck', async () => {
    const x = await seed(mira, north, '2027-03-01');
    const version = (await versionOf(x))!;
    const writer = await begin();
    await writer.client.query('SELECT 1 FROM employees WHERE id = $1 FOR UPDATE', [mira.employeeId]);
    const removed = removal(x, version);
    await waitForBlocked(writer.pid); // the removal has read the row and waits for the employee lock
    await touchRow(writer, x, south.projectId);
    await finish(writer, 'COMMIT');

    expect(outcome(await removed)).toBe('409 PROJECT_ASSIGNMENT_CONFLICT');
    expect(await row(x)).toMatchObject({ project_id: south.projectId });
  });

  it('(b) A -> B -> A: the tuple matches again, the version does not: removal 409, nothing removed', async () => {
    const x = await seed(mira, north, '2027-03-01');
    const version = (await versionOf(x))!;
    const writer = await begin();
    await writer.client.query('SELECT 1 FROM employees WHERE id = $1 FOR UPDATE', [mira.employeeId]);
    const removed = removal(x, version);
    await waitForBlocked(writer.pid);
    await touchRow(writer, x, south.projectId);
    await touchRow(writer, x, north.projectId);
    await finish(writer, 'COMMIT');

    expect(outcome(await removed)).toBe('409 PROJECT_ASSIGNMENT_CONFLICT');
    expect(await row(x)).toMatchObject({ employee_id: mira.employeeId, project_id: north.projectId, month: '2027-03-01' });
    expect(await versionOf(x)).toBeGreaterThan(version);
    expect(await audits('PROJECT_ASSIGNMENT_REMOVED')).toEqual([]);
  });

  it('API-PROJ-27: a genuine no-op PATCH waiting through A -> B -> A answers the LOCKED (newest) version', async () => {
    const x = await seed(mira, north, '2027-03-01');
    const stale = (await versionOf(x))!;
    const writer = await begin();
    await writer.client.query('SELECT 1 FROM employees WHERE id = $1 FOR UPDATE', [mira.employeeId]);
    const noop = correction(x, { projectId: north.projectId });
    await waitForBlocked(writer.pid); // the PATCH has read the row lock-free (version `stale`)
    await touchRow(writer, x, south.projectId);
    await touchRow(writer, x, north.projectId);
    await finish(writer, 'COMMIT');

    const response = await noop;
    expect(response.status).toBe(200);
    const current = (await versionOf(x))!;
    expect(current).toBeGreaterThan(stale);
    expect(response.body).toEqual({ id: x, employeeId: mira.employeeId, projectId: north.projectId, monthStart: '2027-03-01', version: current });
    // The answered version really removes; the one read before the wait does not.
    expect(outcome(await removal(x, stale))).toBe('409 PROJECT_ASSIGNMENT_CONFLICT');
    expect(outcome(await removal(x, response.body.version))).toBe('204');
  });
});

describe('#73 API-CON-11 — removal against a create for the same employee and month, both orders', () => {
  it('removal first: removal 204, then the create finds the month free (201)', async () => {
    const x = await seed(mira, north, '2027-03-01');
    const version = (await versionOf(x))!;
    // NO KEY UPDATE on the removal's project: the removal holds the employee lock and waits here.
    const gate = await begin();
    await gate.client.query('SELECT 1 FROM projects WHERE id = $1 FOR NO KEY UPDATE', [north.projectId]);
    const removed = removal(x, version);
    await waitForBlocked(gate.pid);
    const created = send('post', BASE, admins[1], { body: { employeeId: mira.employeeId, projectId: south.projectId, monthStart: '2027-03-01' } });
    await waitForBlocked(gate.pid, 2);
    await finish(gate, 'ROLLBACK');

    const [removeResponse, createResponse] = await Promise.all([removed, created]);
    expect([outcome(removeResponse), outcome(createResponse)]).toEqual(['204', '201']);
    expect(await row(x)).toBeNull();
    expect(await row(createResponse.body.id)).toMatchObject({ employee_id: mira.employeeId, project_id: south.projectId, month: '2027-03-01' });
  });

  it('create first: the create is 409 (month taken), then the removal 204', async () => {
    const x = await seed(mira, north, '2027-03-01');
    const version = (await versionOf(x))!;
    // NO KEY UPDATE on the create's project: the create holds the employee lock and waits here.
    const gate = await begin();
    await gate.client.query('SELECT 1 FROM projects WHERE id = $1 FOR NO KEY UPDATE', [south.projectId]);
    const created = send('post', BASE, admins[1], { body: { employeeId: mira.employeeId, projectId: south.projectId, monthStart: '2027-03-01' } });
    await waitForBlocked(gate.pid);
    const removed = removal(x, version);
    await waitForBlocked(gate.pid, 2);
    await finish(gate, 'ROLLBACK');

    const [createResponse, removeResponse] = await Promise.all([created, removed]);
    expect([outcome(createResponse), outcome(removeResponse)]).toEqual(['409 PROJECT_ASSIGNMENT_CONFLICT', '204']);
    expect(await row(x)).toBeNull();
    expect(await audits('PROJECT_ASSIGNMENT_CREATED')).toEqual([]);
  });
});

describe('#73 API-CON-12 — removal against employment changes and deactivation (serialized on the employee row)', () => {
  const employeeWrite = (kind: 'employment' | 'deactivation', admin: SyntheticSession) =>
    kind === 'employment'
      ? send('patch', `/api/v1/employees/${mira.employeeId}`, admin, { body: { employmentEnd: '2027-02-28' } })
      : send('post', `/api/v1/employees/${mira.employeeId}/deactivate`, admin, { body: {} });

  it.each(['employment', 'deactivation'] as const)('removal first, the %s change waits on its employee lock: both succeed', async (kind) => {
    const x = await seed(mira, north, '2027-03-01');
    const kept = await seed(mira, south, '2027-04-01');
    const keptVersion = await versionOf(kept);
    const gate = await begin();
    await gate.client.query('SELECT 1 FROM projects WHERE id = $1 FOR NO KEY UPDATE', [north.projectId]);
    const removed = removal(x, (await versionOf(x))!);
    await waitForBlocked(gate.pid);
    const changed = employeeWrite(kind, admins[1]);
    await waitForBlocked(gate.pid, 2); // the employee write queues behind the removal's employee lock
    await finish(gate, 'ROLLBACK');

    const [removeResponse, changeResponse] = await Promise.all([removed, changed]);
    expect([outcome(removeResponse), outcome(changeResponse)]).toEqual(['204', '200']);
    expect(await row(x)).toBeNull();
    // Employee writes never touch assignments: the other row's version is unchanged.
    expect(await versionOf(kept)).toBe(keptVersion);
  });

  it.each(['employment', 'deactivation'] as const)('the %s change first (held): the removal waits, then succeeds unchanged by status', async (kind) => {
    const x = await seed(mira, north, '2027-03-01');
    const version = (await versionOf(x))!;
    const change = await begin();
    await change.client.query(
      kind === 'employment'
        ? "UPDATE employees SET employment_end = '2027-02-28' WHERE id = $1"
        : "UPDATE employees SET status = 'DEACTIVATED' WHERE id = $1",
      [mira.employeeId],
    );
    const removed = removal(x, version);
    await waitForBlocked(change.pid);
    await finish(change, 'COMMIT');

    expect(outcome(await removed)).toBe('204');
    expect(await row(x)).toBeNull();
  });
});

describe('#73 API-CON-13 — removal against a project status change (SHARE vs NO KEY UPDATE)', () => {
  it('removal first, the status PATCH waits on the removal\'s project lock: both succeed', async () => {
    const x = await seed(mira, north, '2027-03-01');
    const gate = await begin();
    await gate.client.query('SELECT 1 FROM project_assignments WHERE id = $1 FOR UPDATE', [x]);
    const removed = removal(x, (await versionOf(x))!);
    await waitForBlocked(gate.pid);
    const statusChange = send('patch', `/api/v1/projects/${north.projectId}`, admins[1], { body: { status: 'INACTIVE' } });
    await waitForBlocked(gate.pid, 2);
    await finish(gate, 'ROLLBACK');

    const [removeResponse, statusResponse] = await Promise.all([removed, statusChange]);
    expect([outcome(removeResponse), outcome(statusResponse)]).toEqual(['204', '200']);
    expect(await row(x)).toBeNull();
  });

  it('status change first (held, ARCHIVED): the removal waits on the project lock, then succeeds', async () => {
    const x = await seed(mira, north, '2027-03-01');
    const change = await begin();
    await change.client.query("UPDATE projects SET status = 'ARCHIVED' WHERE id = $1", [north.projectId]);
    const removed = removal(x, (await versionOf(x))!);
    await waitForBlocked(change.pid);
    await finish(change, 'COMMIT');

    expect(outcome(await removed)).toBe('204');
  });
});

describe('#73 API-CON-14 — stress: swapping corrections and removals together', () => {
  it('no deadlock, no 500; every 204 has exactly one removal audit and every refusal none', async () => {
    const allowed = new Set(['200', '204', '404 RESOURCE_NOT_FOUND', '409 PROJECT_ASSIGNMENT_CONFLICT']);
    for (const [round, month] of ['2027-03-01', '2027-04-01', '2027-05-01', '2027-06-01', '2027-07-01'].entries()) {
      const nextMonth = `2027-${String(8 + round).padStart(2, '0')}-01`;
      const x = await seed(mira, north, month);
      const y = await seed(jonas, south, nextMonth);
      const [vx, vy] = [(await versionOf(x))!, (await versionOf(y))!];
      const removedBefore = (await audits('PROJECT_ASSIGNMENT_REMOVED')).length;
      const correctedBefore = (await audits('PROJECT_ASSIGNMENT_CORRECTED')).length;
      const gate = await begin();
      await gate.client.query('SELECT 1 FROM employees WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[mira.employeeId, jonas.employeeId]]);
      const requests = [
        { kind: 'patch', id: x, promise: correction(x, { employeeId: jonas.employeeId }, admins[0]) },
        { kind: 'patch', id: y, promise: correction(y, { employeeId: mira.employeeId }, admins[1]) },
        { kind: 'delete', id: x, promise: removal(x, vx, admins[2]) },
        { kind: 'delete', id: y, promise: removal(y, vy, admins[3]) },
      ];
      await waitForBlocked(gate.pid, 4);
      await finish(gate, 'ROLLBACK');

      const responses = await Promise.all(requests.map((entry) => entry.promise));
      for (const response of responses) expect(allowed, outcome(response)).toContain(outcome(response));
      const removedIds = requests.filter((entry, index) => entry.kind === 'delete' && responses[index].status === 204).map((entry) => entry.id);
      const corrections = responses.filter((response, index) => requests[index].kind === 'patch' && response.status === 200).length;
      expect((await audits('PROJECT_ASSIGNMENT_REMOVED')).slice(removedBefore).map((entry) => entry.resource_id).sort()).toEqual(removedIds.sort());
      expect((await audits('PROJECT_ASSIGNMENT_CORRECTED')).length - correctedBefore).toBe(corrections);
      for (const id of [x, y]) expect((await row(id)) === null).toBe(removedIds.includes(id));
      // The employee/month invariant holds for whatever survived.
      const duplicates = await db().query(
        `SELECT employee_id, planning_month FROM project_assignments WHERE company_id = $1
         GROUP BY 1, 2 HAVING count(*) > 1`,
        [tenant.companyId],
      );
      expect(duplicates.rows).toEqual([]);
    }
  });
});

describe('#73 API-CON-15 — the touch rule under concurrency and clock skew (production UPDATE expression)', () => {
  it.each(['COMMIT', 'ROLLBACK'] as const)('two writers of one row, the first one %s: the version only moves forward', async (command) => {
    const x = await seed(mira, north, '2027-03-01');
    // Stored value a day ahead of the database clock: clock_timestamp() alone would move backwards.
    await db().query("UPDATE project_assignments SET updated_at = clock_timestamp() + interval '1 day' WHERE id = $1", [x]);
    const v0 = (await versionOf(x))!;
    const first = await begin();
    await touchRow(first, x, south.projectId);
    const v1 = Number((await first.client.query<{ version: string }>(`SELECT ${VERSION_SQL} AS version FROM project_assignments WHERE id = $1`, [x])).rows[0].version);
    const second = await begin();
    const waiting = touchRow(second, x, north.projectId);
    void waiting.catch(() => {});
    await waitForBlocked(first.pid);
    await finish(first, command);
    await waiting;
    await finish(second, 'COMMIT');

    const v2 = (await versionOf(x))!;
    expect(v1).toBe(v0 + 1);
    // After COMMIT the waiting UPDATE re-evaluates on the committed row (v1 + 1); after ROLLBACK on the original (v0 + 1).
    expect(v2).toBe(command === 'COMMIT' ? v1 + 1 : v0 + 1);
    if (command === 'COMMIT') expect(outcome(await removal(x, v1))).toBe('409 PROJECT_ASSIGNMENT_CONFLICT');
    expect(outcome(await removal(x, v0))).toBe('409 PROJECT_ASSIGNMENT_CONFLICT');
    expect(outcome(await removal(x, v2))).toBe('204');
  });
});
