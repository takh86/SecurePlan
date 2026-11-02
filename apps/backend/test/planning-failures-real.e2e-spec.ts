/**
 * Planning authority races and technical failures over HTTP + real PG17.
 * Test-only database/audit hooks gate real transactions; SQL errors below
 * come from PostgreSQL lock/deadlock/serialization machinery, not mock codes.
 */
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types.js';
import { DatabaseService } from '../src/database/database.service.js';
import { BusinessAuditService, type BusinessAuditEntry } from '../src/modules/audit/business-audit.service.js';
import { PLANNING_WRITER_TIMEOUTS } from '../src/modules/planning/planning-locks.js';
import {
  backendPid, createSyntheticProject, createSyntheticSession, createSyntheticTenant,
  realSessionService, removeSyntheticTenants,
  type SyntheticProject, type SyntheticSession, type SyntheticTenant, type TestPool,
} from './helpers/synthetic-tenants.js';
import { ORIGIN, RecordingDelivery, bootEmployeesApp } from './helpers/employees-test-app.js';
import { STANDARD_SHIFTS, createStaff, insertPlan, insertProjectAssignment, insertShiftConfiguration, planningState } from './helpers/planning-fixtures.js';
import { isolatedPlanningDatabase } from './helpers/isolated-planning-database.js';

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

/** Only planning write transactions change isolation or enter the gate. */
class ObservedDatabase extends DatabaseService {
  beforePlanning?: (client: PoolClient) => Promise<void>;
  serializable = false;
  planningCalls = 0;

  override withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return super.withTransaction((client) => work(new Proxy(client, {
      get: (target, key) => {
        if (key === 'query') return async (sql: string, values?: unknown[]) => {
          if (sql === PLANNING_WRITER_TIMEOUTS) {
            this.planningCalls += 1;
            if (this.serializable) await target.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
            const result = await target.query(sql);
            await this.beforePlanning?.(target);
            return result;
          }
          return target.query(sql, values);
        };
        const value: unknown = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    })));
  }
}

class ObservedAudit extends BusinessAuditService {
  hook?: (client: PoolClient, entry: BusinessAuditEntry, occurrence: number) => Promise<void>;
  private counts = new Map<string, number>();
  override async recordBusinessAction(client: PoolClient, entry: BusinessAuditEntry): Promise<void> {
    await super.recordBusinessAction(client, entry);
    const occurrence = (this.counts.get(entry.action) ?? 0) + 1;
    this.counts.set(entry.action, occurrence);
    await this.hook?.(client, entry, occurrence);
  }
}

let pool: TestPool;
let app: INestApplication<App>;
let database: ObservedDatabase;
let audit: ObservedAudit;
let tenant: SyntheticTenant;
let session: SyntheticSession;
let project: SyntheticProject;
let spare: SyntheticProject;
let planId: string;
let roster: { employeeId: string; dutyRole: string }[];
let previousOrigin: string | undefined;
let previousDatabase: string | undefined;
let isolated: Awaited<ReturnType<typeof isolatedPlanningDatabase>>;
const companies: string[] = [];
const held: PoolClient[] = [];
const releases: (() => void)[] = [];
const pending: Promise<unknown>[] = [];

async function begin(): Promise<PoolClient> {
  const client = await pool.connect();
  held.push(client);
  await client.query("BEGIN; SET LOCAL lock_timeout = '12s'; SET LOCAL deadlock_timeout = '10s'");
  return client;
}

async function finish(client: PoolClient, outcome: 'COMMIT' | 'ROLLBACK'): Promise<void> {
  const index = held.indexOf(client);
  if (index < 0) return;
  held.splice(index, 1);
  try { await client.query(outcome); } finally { client.release(); }
}

async function blocked(holderPid: number, waiterPid?: number): Promise<void> {
  const until = Date.now() + 4000;
  while (Date.now() < until) {
    const result = await pool.query(`SELECT 1 FROM pg_stat_activity
      WHERE $1::int = ANY(pg_blocking_pids(pid)) AND ($2::int IS NULL OR pid = $2)`, [holderPid, waiterPid ?? null]);
    if (result.rowCount) return;
  }
  throw new Error('Planning transaction did not enter the expected lock wait');
}

type Operation = 'plan' | 'duty';
function send(operation: Operation): Promise<Response> {
  const response = request(app.getHttpServer()).post(operation === 'plan' ? '/api/v1/monthly-plans' : `/api/v1/monthly-plans/${planId}/entries`)
    .set('Origin', ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf)
    .send(operation === 'plan' ? { projectId: project.projectId, monthStart: '2027-04-01' }
      : { dutyDate: '2027-03-10', shiftKind: 'DAY', assignments: roster }).then((value) => value);
  pending.push(response.catch(() => {}));
  return response;
}

function lastEvent(operation: Operation, entry: BusinessAuditEntry, occurrence: number) {
  return operation === 'plan' ? entry.action === 'MONTHLY_PLAN_CREATED'
    : entry.action === 'DUTY_MEMBERSHIP_ADDED' && occurrence === 2;
}

function sanitized(response: Response) {
  expect([response.status, response.body.code]).toEqual([500, 'INTERNAL_ERROR']);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(response.body.correlationId).toBe(response.headers['x-correlation-id']);
  expect(Object.keys(response.body).sort()).toEqual(['code', 'correlationId', 'detail', 'instance', 'status', 'title', 'type']);
  expect(JSON.stringify(response.body)).not.toMatch(/SELECT|UPDATE|INSERT|55P03|40P01|40001|sp79|synthetic/);
}

beforeAll(async () => {
  previousDatabase = process.env.DATABASE_URL;
  isolated = await isolatedPlanningDatabase();
  pool = isolated.pool;
  process.env.DATABASE_URL = isolated.connectionString;
  previousOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
}, 30_000);
beforeEach(async () => {
  tenant = await createSyntheticTenant(pool, 'SP79 failures');
  companies.push(tenant.companyId);
  session = await createSyntheticSession(realSessionService(pool), tenant.admin);
  project = await createSyntheticProject(pool, tenant.companyId, 'SP79 planning');
  spare = await createSyntheticProject(pool, tenant.companyId, 'SP79 error probe');
  await insertShiftConfiguration(pool, tenant.companyId, project.projectId, '2027-01-01', STANDARD_SHIFTS);
  planId = await insertPlan(pool, tenant.companyId, project.projectId, '2027-03-01');
  roster = [];
  for (let i = 0; i < 2; i += 1) {
    const staff = await createStaff(pool, tenant.companyId);
    roster.push({ employeeId: staff.employeeId, dutyRole: 'EMPLOYEE' });
    await insertProjectAssignment(pool, tenant.companyId, staff.employeeId, project.projectId, '2027-03-01');
  }
  database = new ObservedDatabase();
  audit = new ObservedAudit();
  app = await bootEmployeesApp(new RecordingDelivery(), { database, audit });
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  while (held.length > 0) await finish(held[0], 'ROLLBACK');
  await Promise.allSettled(pending.splice(0));
  await app?.close();
});
afterAll(async () => {
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousOrigin;
  await removeSyntheticTenants(pool, companies);
  await isolated.close();
  if (previousDatabase === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabase;
});

const changes = [
  ['account deactivation', 'accounts', "status = 'DEACTIVATED'", 'SESSION_REVOKED', 401],
  ['role downgrade', 'accounts', "role = 'EMPLOYEE'", 'ACTION_FORBIDDEN', 403],
  ['company suspension', 'companies', "status = 'SUSPENDED'", 'SESSION_REVOKED', 401],
] as const;

describe.each(['plan', 'duty'] as const)('%s: authority changes after HTTP authentication', (operation) => {
  it.each(changes)('%s commits while the command waits: refuse without business/audit writes', async (_name, table, change, code, status) => {
    const entered = latch(); const proceed = latch(); releases.push(proceed.release);
    database.beforePlanning = async () => { entered.release(); await proceed.promise; };
    const response = send(operation);
    await entered.promise; // The real global session/CSRF/role guard has completed.
    const before = await planningState(pool, tenant.companyId);
    const changer = await begin();
    await changer.query(`UPDATE ${table} SET ${change} WHERE id = $1`, [table === 'companies' ? tenant.companyId : tenant.admin.accountId]);
    const holder = await backendPid(changer);
    proceed.release();
    await blocked(holder);
    await finish(changer, 'COMMIT');
    const result = await response;
    expect([result.status, result.body.code]).toEqual([status, code]);
    const after = await planningState(pool, tenant.companyId);
    expect({ ...after, accounts: before.accounts }).toEqual(before);
    expect(database.planningCalls).toBe(1);
  });

  it.each(changes)('%s rolls back while the command waits: command succeeds on the restored state', async (_name, table, change) => {
    const entered = latch(); const proceed = latch(); releases.push(proceed.release);
    database.beforePlanning = async () => { entered.release(); await proceed.promise; };
    const response = send(operation);
    await entered.promise;
    const changer = await begin();
    await changer.query(`UPDATE ${table} SET ${change} WHERE id = $1`, [table === 'companies' ? tenant.companyId : tenant.admin.accountId]);
    const holder = await backendPid(changer);
    proceed.release();
    await blocked(holder);
    await finish(changer, 'ROLLBACK');
    expect((await response).status).toBe(201);
    expect(database.planningCalls).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM audit_event WHERE company_id = $1', [tenant.companyId])).rows[0].n)
      .toBe(operation === 'plan' ? 1 : 3);
  });

  it.each(changes)('%s waits when planning already holds authority protection; planning commits first', async (_name, table, change) => {
    const entered = latch(); const proceed = latch(); releases.push(proceed.release);
    let workerPid = 0;
    audit.hook = async (client, entry, n) => {
      if (!lastEvent(operation, entry, n)) return;
      workerPid = await backendPid(client); entered.release(); await proceed.promise;
    };
    const response = send(operation);
    await entered.promise;
    const changer = await begin();
    const changerPid = await backendPid(changer);
    const updating = changer.query(`UPDATE ${table} SET ${change} WHERE id = $1`, [table === 'companies' ? tenant.companyId : tenant.admin.accountId]);
    pending.push(updating.catch(() => {}));
    await blocked(workerPid, changerPid);
    proceed.release();
    expect((await response).status).toBe(201);
    await updating;
    await finish(changer, 'COMMIT');
    expect(database.planningCalls).toBe(1);
  });
});

describe.each(['plan', 'duty'] as const)('%s: real PostgreSQL technical failures after business + audit inserts', (operation) => {
  it('a deployment search_path excluding public fails closed without business or audit writes', async () => {
    const before = await planningState(pool, tenant.companyId);
    database.beforePlanning = async (client) => { await client.query('SET LOCAL search_path = pg_catalog'); };
    sanitized(await send(operation));
    expect(await planningState(pool, tenant.companyId)).toEqual(before);
  });

  it.each([
    ['RLS', 'ALTER TABLE public.plan_assignments ENABLE ROW LEVEL SECURITY'],
    ['forced RLS', 'ALTER TABLE public.duties FORCE ROW LEVEL SECURITY'],
    ['unlogged table', 'ALTER TABLE public.plan_assignments SET UNLOGGED'],
    ['inherited child', 'CREATE TABLE public.sp79_child () INHERITS (public.duties)'],
    ['temporary shadow', 'CREATE TEMP TABLE duties (LIKE public.duties) ON COMMIT DROP'],
    ['suppressing trigger', `CREATE FUNCTION public.sp79_suppress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER sp79_suppress BEFORE INSERT ON public.duties FOR EACH ROW EXECUTE FUNCTION public.sp79_suppress()`],
  ])('unsupported schema: %s produces the approved sanitized 500 and transaction rollback', async (_name, ddl) => {
    const before = await planningState(pool, tenant.companyId);
    database.beforePlanning = async (client) => { await client.query(ddl); };
    sanitized(await send(operation));
    expect(await planningState(pool, tenant.companyId)).toEqual(before);
    // DDL was on the same real transaction and must have rolled back as well.
    database.beforePlanning = undefined;
    expect((await send(operation)).status).toBe(201);
  });

  it.each(['55P03', '40P01', '40001'] as const)('%s is sanitized, rolls back every earlier row/event and is never replayed', async (code) => {
    database.serializable = code === '40001';
    const before = await planningState(pool, tenant.companyId);
    const blocker = await begin();
    const blockerPid = await backendPid(blocker);
    if (code !== '40001') await blocker.query('SELECT 1 FROM projects WHERE id = $1 FOR UPDATE', [spare.projectId]);
    const entered = latch();
    let observedCode: string | undefined;
    let workerPid = 0;
    audit.hook = async (client, entry, n) => {
      if (!lastEvent(operation, entry, n)) return;
      workerPid = await backendPid(client);
      expect((await client.query("SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement")).rows[0])
        .toEqual({ lock: '5s', statement: '15s' });
      if (code === '40P01') await client.query("SET LOCAL deadlock_timeout = '100ms'");
      if (code === '40001') {
        await blocker.query('UPDATE projects SET name = name || $2 WHERE id = $1', [spare.projectId, ' changed']);
        await finish(blocker, 'COMMIT');
      }
      entered.release();
      try {
        // SERIALIZABLE sees a version changed since its initial snapshot;
        // other variants wait on the explicitly held probe row.
        await client.query('SELECT 1 FROM projects WHERE id = $1 FOR UPDATE', [spare.projectId]);
      } catch (error) {
        observedCode = (error as { code?: string }).code;
        throw error;
      }
    };
    const response = send(operation);
    await entered.promise;
    if (code === '40P01') {
      await blocked(blockerPid, workerPid);
      // Complete the cycle deliberately. Only the app's 100 ms detector runs
      // before the blocker's 10 s detector, making the app the victim.
      const inverted = blocker.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [tenant.admin.accountId]);
      pending.push(inverted.catch(() => {}));
    }
    sanitized(await response);
    expect(observedCode).toBe(code);
    await finish(blocker, 'ROLLBACK');
    expect(await planningState(pool, tenant.companyId)).toEqual(before);
    expect(database.planningCalls).toBe(1);
  }, 20_000);

  it('a later application failure rolls back all inserted events, including both membership events', async () => {
    const before = await planningState(pool, tenant.companyId);
    audit.hook = async (_client, entry, n) => { if (lastEvent(operation, entry, n)) throw new Error('synthetic late audit failure'); };
    sanitized(await send(operation));
    expect(await planningState(pool, tenant.companyId)).toEqual(before);
    expect(database.planningCalls).toBe(1);
  });
});
