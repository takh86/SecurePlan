/**
 * SP-11 PR-1 LOCK-01-L1 real-table concurrency proofs against REAL PostgreSQL
 * 17 (SP11A-R1 T1 G7; acceptance rows PG-01..05, PG-08..10, PG-12; §3.5).
 *
 * Every pair runs BOTH acquisition orders and BOTH outcomes of the first
 * writer (COMMIT, ROLLBACK). Order is made deterministic without sleeps: a gate
 * transaction holds the first contended parent row (employee or project) FOR
 * UPDATE; writer 1 queues on it first, writer 2 queues behind writer 1
 * (PostgreSQL row-lock queues are transitive, checked with pg_blocking_pids);
 * then the gate rolls back. The ROLLBACK variant makes writer 1 fail AFTER it
 * holds all of its locks, through a real audit failure (sanitized 500).
 * Both writers are the real services over HTTP. Synthetic data only.
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types.js';
import type { SessionService } from '../src/auth/session.service.js';
import type { BusinessAuditAction } from '../src/modules/audit/business-audit.service.js';
import { lockAccountsPrefix } from '../src/modules/identity/account-prefix-lock.js';
import {
  backendPid,
  createSyntheticAccount,
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
import {
  STANDARD_SHIFTS,
  adminContext,
  createStaff,
  insertPlan,
  insertProjectAssignment,
  insertShiftConfiguration,
} from './helpers/planning-fixtures.js';

const NOW = '2026-12-15T12:00:00Z';

let pool: TestPool | undefined;
let sessions: SessionService;
let app: INestApplication<App> | undefined;
let tenantA: SyntheticTenant;
let adminA: SyntheticSession;
let north: SyntheticProject;
let mira: SyntheticEmployee;
let planDec: string;
let planJan: string;
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

function write(method: 'post' | 'patch', path: string, body: object = {}, session = adminA): Promise<Response> {
  return send(() => http()[method](path)
    .set('Origin', ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send(body));
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

/** Pids that (transitively) wait on `holderPid`, once there are at least `count`. */
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
  throw new Error(`Fewer than ${count} backend(s) ever blocked on ${holderPid}`);
}

async function bootApp(failOn?: BusinessAuditAction) {
  if (app) await app.close();
  app = await bootEmployeesApp(new RecordingDelivery(), {
    clock: () => new Date(NOW),
    ...(failOn ? { audit: new FailingAudit(failOn) } : {}),
  });
}

/**
 * Deterministic order: writer 1 queues first on the gated parent row, writer 2
 * behind it; the gate then rolls back without writing anything.
 */
async function race(gate: { table: 'employees' | 'projects'; id: string }, first: () => Promise<Response>, second: () => Promise<Response>) {
  const holder = await begin();
  // Fixed identifiers from this test file only.
  await holder.client.query(`SELECT 1 FROM ${gate.table} WHERE id = $1 FOR UPDATE`, [gate.id]);
  const one = first();
  await waitForBlocked(holder.pid, 1);
  const two = second();
  await waitForBlocked(holder.pid, 2);
  await finish(holder, 'ROLLBACK');
  return Promise.all([one, two]);
}

const outcome = (response: Response) => [response.status, response.body?.code ?? null];
const byStatus = (a: (string | number | null)[], b: (string | number | null)[]) => Number(a[0]) - Number(b[0]);

beforeAll(() => {
  pool = openLocalTestPool(12);
  sessions = realSessionService(db());
  previousOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
});

beforeEach(async () => {
  tenantA = await createSyntheticTenant(db(), 'SP11 race A');
  createdCompanies.push(tenantA.companyId);
  adminA = await createSyntheticSession(sessions, tenantA.admin);
  north = await createSyntheticProject(db(), tenantA.companyId, 'SP11 Nord');
  await insertShiftConfiguration(db(), tenantA.companyId, north.projectId, '2026-12-01', STANDARD_SHIFTS);
  mira = await createStaff(db(), tenantA.companyId);
  await insertProjectAssignment(db(), tenantA.companyId, mira.employeeId, north.projectId, '2026-12-01');
  planDec = await insertPlan(db(), tenantA.companyId, north.projectId, '2026-12-01');
  planJan = await insertPlan(db(), tenantA.companyId, north.projectId, '2027-01-01');
});

afterEach(async () => {
  for (const transaction of held.splice(0)) await finish(transaction, 'ROLLBACK');
  await Promise.allSettled(inFlight);
  if (app) await app.close();
  app = undefined;
});

afterAll(async () => {
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousOrigin;
  if (pool) {
    await removeSyntheticTenants(pool, createdCompanies);
    await pool.end();
  }
});

/** Staffed (mira) or empty duty creation, the planning writer of every pair. */
const createDuty = (planId: string, dutyDate: string, staffed = true, shiftKind = 'DAY') => () => write(
  'post', `/api/v1/monthly-plans/${planId}/entries`,
  { dutyDate, shiftKind, ...(staffed ? { assignments: [{ employeeId: mira.employeeId, dutyRole: 'EMPLOYEE' }] } : {}) },
);

type Pair = {
  name: string;
  gate: 'employees' | 'projects';
  setup?: () => Promise<void>;
  duty: () => () => Promise<Response>;
  dutyAudit: BusinessAuditAction;
  other: () => () => Promise<Response>;
  otherAudit: BusinessAuditAction;
  otherSuccess: number;
  /** Second writer's outcome when the FIRST writer commits. */
  afterDuty: (string | number | null)[];
  afterOther: (string | number | null)[];
};

const PAIRS: Pair[] = [
  {
    name: 'PG-02 D2: duty membership create vs monthly assignment PATCH',
    gate: 'employees',
    setup: async () => {
      await insertProjectAssignment(db(), tenantA.companyId, mira.employeeId, north.projectId, '2027-01-01');
    },
    duty: () => createDuty(planJan, '2027-01-10'),
    dutyAudit: 'DUTY_CREATED',
    other: () => async () => {
      const { rows } = await db().query("SELECT id FROM project_assignments WHERE employee_id = $1 AND planning_month = '2027-01-01'", [mira.employeeId]);
      return write('patch', `/api/v1/project-assignments/${rows[0].id}`, { monthStart: '2027-02-01' });
    },
    otherAudit: 'PROJECT_ASSIGNMENT_CORRECTED',
    otherSuccess: 200,
    afterDuty: [409, 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT'],
    afterOther: [409, 'EMPLOYEE_NOT_ASSIGNED_TO_PROJECT_MONTH'],
  },
  {
    name: 'PG-03 D5: duty membership create vs employment end PATCH',
    gate: 'employees',
    duty: () => createDuty(planDec, '2026-12-20'),
    dutyAudit: 'DUTY_CREATED',
    other: () => () => write('patch', `/api/v1/employees/${mira.employeeId}`, { employmentEnd: '2026-12-19' }),
    otherAudit: 'EMPLOYEE_UPDATED',
    otherSuccess: 200,
    afterDuty: [409, 'EMPLOYMENT_PERIOD_EXCLUDES_FUTURE_DUTIES'],
    afterOther: [409, 'EMPLOYEE_NOT_EMPLOYED_FOR_DAY'],
  },
  {
    name: 'PG-03 deactivation: duty membership create vs employee deactivation',
    gate: 'employees',
    duty: () => createDuty(planDec, '2026-12-20'),
    dutyAudit: 'DUTY_CREATED',
    other: () => () => write('post', `/api/v1/employees/${mira.employeeId}/deactivate`),
    otherAudit: 'EMPLOYEE_DEACTIVATED',
    otherSuccess: 200,
    afterDuty: [409, 'EMPLOYEE_HAS_FUTURE_ASSIGNMENTS'],
    afterOther: [409, 'EMPLOYEE_INACTIVE'],
  },
  {
    name: 'PG-04 D3: empty duty create vs shift configuration replacement',
    gate: 'projects',
    duty: () => createDuty(planJan, '2027-01-10', false),
    dutyAudit: 'DUTY_CREATED',
    other: () => () => write('patch', `/api/v1/projects/${north.projectId}/shift-configuration`, {
      effectiveFromMonth: '2026-12-01', shifts: [{ shiftKind: 'DAY', startLocal: '07:00', endLocal: '19:00' }],
    }),
    otherAudit: 'SHIFT_CONFIGURATION_UPDATED',
    otherSuccess: 200,
    afterDuty: [409, 'SHIFT_CONFIGURATION_CONFLICT'],
    afterOther: [201, null],
  },
  {
    name: 'PG-05 D4: empty duty create vs project ACTIVE -> INACTIVE',
    gate: 'projects',
    duty: () => createDuty(planJan, '2027-01-10', false),
    dutyAudit: 'DUTY_CREATED',
    other: () => () => write('patch', `/api/v1/projects/${north.projectId}`, { status: 'INACTIVE' }),
    otherAudit: 'PROJECT_UPDATED',
    otherSuccess: 200,
    afterDuty: [409, 'PROJECT_HAS_FUTURE_DUTIES'],
    afterOther: [409, 'PROJECT_INACTIVE'],
  },
  {
    name: 'PG-05 D4: staffed duty create vs project ACTIVE -> INACTIVE',
    gate: 'projects',
    setup: async () => { await insertProjectAssignment(db(), tenantA.companyId, mira.employeeId, north.projectId, '2027-01-01'); },
    duty: () => createDuty(planJan, '2027-01-10'),
    dutyAudit: 'DUTY_CREATED',
    other: () => () => write('patch', `/api/v1/projects/${north.projectId}`, { status: 'INACTIVE' }),
    otherAudit: 'PROJECT_UPDATED',
    otherSuccess: 200,
    afterDuty: [409, 'PROJECT_HAS_FUTURE_DUTIES'],
    afterOther: [409, 'PROJECT_INACTIVE'],
  },
];

describe('LOCK-01-L1 — both acquisition orders, first writer COMMIT and ROLLBACK', () => {
  for (const pair of PAIRS) {
    const gateId = () => (pair.gate === 'employees' ? mira.employeeId : north.projectId);

    it(`${pair.name}: duty first, COMMIT`, async () => {
      await pair.setup?.();
      await bootApp();
      const [first, second] = await race({ table: pair.gate, id: gateId() }, pair.duty(), pair.other());
      expect(first.status).toBe(201);
      expect(outcome(second)).toEqual(pair.afterDuty);
    });

    it(`${pair.name}: duty first, ROLLBACK`, async () => {
      await pair.setup?.();
      await bootApp(pair.dutyAudit);
      const [first, second] = await race({ table: pair.gate, id: gateId() }, pair.duty(), pair.other());
      expect(outcome(first)).toEqual([500, 'INTERNAL_ERROR']);
      expect(second.status).toBe(pair.otherSuccess);
    });

    it(`${pair.name}: other writer first, COMMIT`, async () => {
      await pair.setup?.();
      await bootApp();
      const [first, second] = await race({ table: pair.gate, id: gateId() }, pair.other(), pair.duty());
      expect(first.status).toBe(pair.otherSuccess);
      expect(outcome(second)).toEqual(pair.afterOther);
    });

    it(`${pair.name}: other writer first, ROLLBACK`, async () => {
      await pair.setup?.();
      await bootApp(pair.otherAudit);
      const [first, second] = await race({ table: pair.gate, id: gateId() }, pair.other(), pair.duty());
      expect(outcome(first)).toEqual([500, 'INTERNAL_ERROR']);
      expect(second.status).toBe(201);
    });
  }

  it('PG-04: the shift change that commits first decides the snapshot of the duty that waited', async () => {
    await bootApp();
    const [, created] = await race(
      { table: 'projects', id: north.projectId },
      () => write('patch', `/api/v1/projects/${north.projectId}/shift-configuration`, {
        effectiveFromMonth: '2026-12-01', shifts: [{ shiftKind: 'DAY', startLocal: '07:00', endLocal: '19:00' }],
      }),
      createDuty(planJan, '2027-01-10', false),
    );
    expect(created.body).toMatchObject({ startsAt: '2027-01-10T06:00:00Z', endsAt: '2027-01-10T18:00:00Z' });
  });

});

describe('PG-08 — two staffing writers for the same employee on different duties (no write skew)', () => {
  /**
   * The January NIGHT of the 31st (17:00Z -> 05:00Z) and a February DAY under a
   * February version starting 04:00 local (03:00Z) overlap by two hours; each
   * duty alone is valid.
   */
  async function overlappingSetup(): Promise<{ night: () => Promise<Response>; day: () => Promise<Response> }> {
    for (const month of ['2027-01-01', '2027-02-01']) {
      await insertProjectAssignment(db(), tenantA.companyId, mira.employeeId, north.projectId, month);
    }
    await insertShiftConfiguration(db(), tenantA.companyId, north.projectId, '2027-02-01', [{ kind: 'TAG', start: '04:00', end: '16:00' }]);
    const planFeb = await insertPlan(db(), tenantA.companyId, north.projectId, '2027-02-01');
    return { night: createDuty(planJan, '2027-01-31', true, 'NIGHT'), day: createDuty(planFeb, '2027-02-01', true, 'DAY') };
  }

  it.each([['NIGHT first', true], ['DAY first', false]] as const)('real vs real, %s: the waiting writer sees the committed membership', async (_name, nightFirst) => {
    await bootApp();
    const { night, day } = await overlappingSetup();
    const [first, second] = await race({ table: 'employees', id: mira.employeeId }, nightFirst ? night : day, nightFirst ? day : night);
    expect(first.status).toBe(201);
    expect(outcome(second)).toEqual([409, 'DUTY_ASSIGNMENT_CONFLICT']);
  });

  it.each([['COMMIT', [409, 'DUTY_ASSIGNMENT_CONFLICT']], ['ROLLBACK', [201, null]]] as const)(
    'stand-in staffing writer holding the employee lock, %s: no phantom and no missed dependency',
    async (command, expected) => {
      await bootApp();
      const { day } = await overlappingSetup();
      // The stand-in follows the protocol: employee NO KEY UPDATE, then duty + membership.
      const writer = await begin();
      await writer.client.query('SELECT 1 FROM employees WHERE id = $1 FOR NO KEY UPDATE', [mira.employeeId]);
      const dutyId = randomUUID();
      await writer.client.query(
        `INSERT INTO duties (id, company_id, project_id, monthly_plan_id, planning_month, duty_date, shift_kind, starts_at, ends_at,
           time_zone, config_effective_from_month, start_local, end_local)
         VALUES ($1, $2, $3, $4, '2027-01-01', '2027-01-31', 'NACHT', '2027-01-31T17:00:00Z', '2027-02-01T05:00:00Z', 'Europe/Berlin', '2026-12-01', '18:00', '06:00')`,
        [dutyId, tenantA.companyId, north.projectId, planJan],
      );
      await writer.client.query("INSERT INTO plan_assignments (company_id, duty_id, employee_id, duty_function) VALUES ($1, $2, $3, 'MITARBEITER')",
        [tenantA.companyId, dutyId, mira.employeeId]);
      const waiting = day();
      await waitForBlocked(writer.pid, 1);
      await finish(writer, command);
      expect(outcome(await waiting)).toEqual(expected);
    },
  );
});

describe('PG-09 — absent rows and insert-key races', () => {
  it('two concurrent plan creates for one project/month: exactly one 201 and one 409, one plan, one audit event', async () => {
    await bootApp();
    const south = await createSyntheticProject(db(), tenantA.companyId, 'SP11 Sued');
    const holder = await begin();
    await holder.client.query('SELECT 1 FROM projects WHERE id = $1 FOR UPDATE', [south.projectId]);
    const one = write('post', '/api/v1/monthly-plans', { projectId: south.projectId, monthStart: '2027-02-01' });
    const two = write('post', '/api/v1/monthly-plans', { projectId: south.projectId, monthStart: '2027-02-01' });
    await waitForBlocked(holder.pid, 2);
    await finish(holder, 'ROLLBACK');
    const statuses = (await Promise.all([one, two])).map(outcome).sort(byStatus);
    expect(statuses).toEqual([[201, null], [409, 'MONTHLY_PLAN_ALREADY_EXISTS']]);
    expect((await db().query("SELECT count(*)::int AS n FROM audit_event WHERE company_id = $1 AND action = 'MONTHLY_PLAN_CREATED'", [tenantA.companyId])).rows[0].n).toBe(1);
  });

  it('two concurrent creates of the same live slot: exactly one duty; the loser maps the unique race to DUTY_ALREADY_EXISTS', async () => {
    await bootApp();
    const holder = await begin();
    await holder.client.query('SELECT 1 FROM projects WHERE id = $1 FOR UPDATE', [north.projectId]);
    const one = createDuty(planJan, '2027-01-12', false)();
    const two = createDuty(planJan, '2027-01-12', false)();
    await waitForBlocked(holder.pid, 2);
    await finish(holder, 'ROLLBACK');
    const statuses = (await Promise.all([one, two])).map(outcome).sort(byStatus);
    expect(statuses).toEqual([[201, null], [409, 'DUTY_ALREADY_EXISTS']]);
    expect((await db().query("SELECT count(*)::int AS n FROM duties WHERE monthly_plan_id = $1 AND duty_date = '2027-01-12'", [planJan])).rows[0].n).toBe(1);
  });

  it('EL-04/SP-10: an absence fact committed by a writer holding the employee lock is seen by the waiting duty create; a rolled-back one is not', async () => {
    await bootApp();
    for (const [command, expected] of [['COMMIT', [409, 'EMPLOYEE_UNAVAILABLE']], ['ROLLBACK', [201, null]]] as const) {
      const fact = await begin();
      // Stand-in for the SP-10 commit: employee NO KEY UPDATE, then the day row.
      await fact.client.query('SELECT 1 FROM employees WHERE id = $1 FOR NO KEY UPDATE', [mira.employeeId]);
      const day = command === 'COMMIT' ? '2026-12-21' : '2026-12-22';
      await fact.client.query("INSERT INTO employee_availability_days (company_id, employee_id, day, status) VALUES ($1, $2, $3::date, 'SICK')",
        [tenantA.companyId, mira.employeeId, day]);
      const created = createDuty(planDec, day)();
      await waitForBlocked(fact.pid, 1);
      await finish(fact, command);
      expect(outcome(await created), command).toEqual(expected);
    }
  });
});

describe('PG-10 — negative control: a pre-wait snapshot is unsafe, a new statement after the wait is not', () => {
  it('a lock-and-count CTE that waited still counts 0; the fresh statement after the same wait counts 1', async () => {
    const writer = await begin();
    await writer.client.query('SELECT 1 FROM employees WHERE id = $1 FOR NO KEY UPDATE', [mira.employeeId]);
    const dutyId = randomUUID();
    await writer.client.query(
      `INSERT INTO duties (id, company_id, project_id, monthly_plan_id, planning_month, duty_date, shift_kind, starts_at, ends_at,
         time_zone, config_effective_from_month, start_local, end_local)
       VALUES ($1, $2, $3, $4, '2027-01-01', '2027-01-20', 'TAG', '2027-01-20T05:00:00Z', '2027-01-20T17:00:00Z', 'Europe/Berlin', '2026-12-01', '06:00', '18:00')`,
      [dutyId, tenantA.companyId, north.projectId, planJan],
    );
    await writer.client.query(
      "INSERT INTO plan_assignments (company_id, duty_id, employee_id, duty_function) VALUES ($1, $2, $3, 'MITARBEITER')",
      [tenantA.companyId, dutyId, mira.employeeId],
    );
    const reader = await begin();
    const stale = reader.client.query<{ n: number }>(
      `WITH locked AS (SELECT id FROM employees WHERE id = $1 FOR NO KEY UPDATE)
       SELECT (SELECT count(*)::int FROM plan_assignments WHERE employee_id = $1 AND state = 'ACTIVE') AS n FROM locked`,
      [mira.employeeId],
    );
    await waitForBlocked(writer.pid, 1);
    await finish(writer, 'COMMIT');
    expect((await stale).rows[0].n).toBe(0);
    const fresh = await reader.client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM plan_assignments WHERE employee_id = $1 AND state = 'ACTIVE'", [mira.employeeId]);
    expect(fresh.rows[0].n).toBe(1);
    await finish(reader, 'ROLLBACK');
  });
});

describe('T1 DEC-1.4 — account prefix and deactivation (§3.5 real-schema proofs)', () => {
  it('accounts are locked one by one in UUID order before anything else: a gate on the smaller id leaves the larger one free', async () => {
    const extra = [await createSyntheticAccount(db(), tenantA.companyId, 'EMPLOYEE'), await createSyntheticAccount(db(), tenantA.companyId, 'EMPLOYEE')];
    const [smaller, larger] = extra.map((account) => account.accountId).sort();
    const gate = await begin();
    await gate.client.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [smaller]);
    const worker = await begin();
    // Targets passed in descending order: the helper must still take the smaller one first.
    const locking = lockAccountsPrefix(worker.client, adminContext(tenantA.admin), ['COMPANY_ADMIN'], [larger, smaller]);
    await waitForBlocked(gate.pid, 1);
    // Wherever the actor sorts, `larger` comes after `smaller`: NOWAIT succeeds only
    // because the blocked worker has not reached it.
    const probe = await begin();
    await probe.client.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE NOWAIT', [larger]);
    await finish(probe, 'ROLLBACK');
    await finish(gate, 'ROLLBACK');
    await expect(locking).resolves.toBeUndefined();
    await finish(worker, 'ROLLBACK');
  });

  it('actor == target is locked once FOR UPDATE (no SHARE -> UPDATE upgrade) and revalidated', async () => {
    const worker = await begin();
    await lockAccountsPrefix(worker.client, adminContext(tenantA.admin), ['COMPANY_ADMIN'], [tenantA.admin.accountId.toUpperCase()]);
    const probe = await begin();
    // A SHARE request now conflicts: the single lock is the strong one.
    await expect(probe.client.query('SELECT 1 FROM accounts WHERE id = $1 FOR SHARE NOWAIT', [tenantA.admin.accountId]))
      .rejects.toMatchObject({ code: '55P03' });
    await finish(probe, 'ROLLBACK');
    await finish(worker, 'ROLLBACK');
  });

  it('a revoked actor is detected after the account wait (401) and a downgraded one (403)', async () => {
    for (const [change, code] of [["status = 'DEACTIVATED'", 'SESSION_REVOKED'], ["role = 'EMPLOYEE'", 'ACTION_FORBIDDEN']] as const) {
      const changer = await begin();
      await changer.client.query(`UPDATE accounts SET ${change} WHERE id = $1`, [tenantA.admin.accountId]);
      const worker = await begin();
      const locking = lockAccountsPrefix(worker.client, adminContext(tenantA.admin), ['COMPANY_ADMIN']);
      await waitForBlocked(changer.pid, 1);
      await finish(changer, 'COMMIT');
      await expect(locking).rejects.toMatchObject({ response: { code } });
      await finish(worker, 'ROLLBACK');
      await db().query("UPDATE accounts SET status = 'ACTIVE', role = 'COMPANY_ADMIN' WHERE id = $1", [tenantA.admin.accountId]);
    }
  });

  it('a linked account that changes between discovery and the employee lock aborts; the new account is never locked late', async () => {
    await bootApp();
    const replacement = await createSyntheticAccount(db(), tenantA.companyId, 'EMPLOYEE');
    const gate = await begin();
    await gate.client.query('SELECT 1 FROM employees WHERE id = $1 FOR UPDATE', [mira.employeeId]);
    const deactivation = write('post', `/api/v1/employees/${mira.employeeId}/deactivate`);
    await waitForBlocked(gate.pid, 1);
    // While the deactivation waits on the employee, the replacement account is still free.
    const probe = await begin();
    await probe.client.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE NOWAIT', [replacement.accountId]);
    await finish(probe, 'ROLLBACK');
    await gate.client.query('UPDATE employees SET account_id = $2 WHERE id = $1', [mira.employeeId, replacement.accountId]);
    await finish(gate, 'COMMIT');
    expect(outcome(await deactivation)).toEqual([500, 'INTERNAL_ERROR']);
    expect((await db().query('SELECT status FROM employees WHERE id = $1', [mira.employeeId])).rows[0].status).toBe('ACTIVE');
    expect((await db().query('SELECT status FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id', [[mira.account.accountId, replacement.accountId]])).rows
      .map((row) => row.status)).toEqual(['ACTIVE', 'ACTIVE']);
  });

  it('a stand-in self-service writer (own account SHARE, then employee) and the deactivation never deadlock in either order', async () => {
    await bootApp();
    for (const selfFirst of [true, false]) {
      const staff = await createStaff(db(), tenantA.companyId);
      if (selfFirst) {
        const self = await begin();
        await self.client.query('SELECT 1 FROM accounts WHERE id = $1 FOR SHARE', [staff.account.accountId]);
        await self.client.query('SELECT 1 FROM employees WHERE id = $1 FOR NO KEY UPDATE', [staff.employeeId]);
        const deactivation = write('post', `/api/v1/employees/${staff.employeeId}/deactivate`);
        await waitForBlocked(self.pid, 1);
        await finish(self, 'COMMIT');
        expect((await deactivation).status).toBe(200);
      } else {
        const gate = await begin();
        await gate.client.query('SELECT 1 FROM employees WHERE id = $1 FOR UPDATE', [staff.employeeId]);
        const deactivation = write('post', `/api/v1/employees/${staff.employeeId}/deactivate`);
        await waitForBlocked(gate.pid, 1);
        // The deactivation now holds the target account UPDATE and waits on the employee.
        const self = await begin();
        const selfLock = self.client.query('SELECT 1 FROM accounts WHERE id = $1 FOR SHARE', [staff.account.accountId]);
        await waitForBlocked(gate.pid, 2);
        await finish(gate, 'ROLLBACK');
        expect((await deactivation).status).toBe(200);
        await selfLock;
        await finish(self, 'ROLLBACK');
      }
    }
  });

  it('two admins deactivating two different employees concurrently: both succeed, no deadlock (8 rounds)', async () => {
    await bootApp();
    const secondAdmin = await createSyntheticAccount(db(), tenantA.companyId, 'COMPANY_ADMIN');
    const secondSession = await createSyntheticSession(sessions, secondAdmin);
    for (let round = 0; round < 8; round += 1) {
      const [first, second] = [await createStaff(db(), tenantA.companyId), await createStaff(db(), tenantA.companyId)];
      const responses = await Promise.all([
        write('post', `/api/v1/employees/${first.employeeId}/deactivate`),
        write('post', `/api/v1/employees/${second.employeeId}/deactivate`, {}, secondSession),
      ]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
    }
  });
});
