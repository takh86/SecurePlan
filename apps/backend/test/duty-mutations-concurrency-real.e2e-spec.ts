/** Real PG17 waits, both orders/outcomes. No sleeps or mocked lock errors. */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types.js';
import { DatabaseService } from '../src/database/database.service.js';
import { BusinessAuditService, type BusinessAuditAction, type BusinessAuditEntry } from '../src/modules/audit/business-audit.service.js';
import { lockAccountsPrefix } from '../src/modules/identity/account-prefix-lock.js';
import { PLANNING_WRITER_TIMEOUTS } from '../src/modules/planning/planning-locks.js';
import { ORIGIN, RecordingDelivery, bootEmployeesApp } from './helpers/employees-test-app.js';
import { backendPid, createSyntheticProject, openLocalTestPool, removeSyntheticTenants, type TestPool, type SyntheticSession } from './helpers/synthetic-tenants.js';
import { adminContext, insertDuty, insertMembership, planningState } from './helpers/planning-fixtures.js';
import { dutyMutationFixture, dutyPath, MUTATION_DAY, MUTATION_MONTH, MUTATION_NOW, type DutyMutationFixture } from './helpers/duty-mutation-fixtures.js';

function latch() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
class ObservedDatabase extends DatabaseService {
  serializable = false;
  beforeCommand?: (client: PoolClient) => Promise<void>;
  employeeSets: string[][] = [];
  override withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return super.withTransaction((client) => work(new Proxy(client, {
      get: (target, key) => {
        if (key === 'query') return async (sql: string, params?: unknown[]) => {
          if (sql === PLANNING_WRITER_TIMEOUTS) {
            if (this.serializable) await target.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
            const hook = this.beforeCommand; this.beforeCommand = undefined; await hook?.(target);
          }
          if (sql.includes('FROM employees') && sql.includes('FOR NO KEY UPDATE') && Array.isArray(params?.[1])) this.employeeSets.push(params[1] as string[]);
          return target.query(sql, params);
        };
        const value: unknown = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    })));
  }
}
class ProbeAudit extends BusinessAuditService {
  fail?: BusinessAuditAction;
  hook?: (client: PoolClient, entry: BusinessAuditEntry) => Promise<void>;
  attempts = 0;
  override async recordBusinessAction(client: PoolClient, entry: BusinessAuditEntry): Promise<void> {
    await super.recordBusinessAction(client, entry);
    if (entry.action === 'DUTY_UPDATED' || entry.action === 'DUTY_REMOVED') this.attempts += 1;
    if (this.fail === entry.action) { this.fail = undefined; await client.query('SELECT 1 / 0'); }
    await this.hook?.(client, entry);
  }
}
type Held = { client: PoolClient; pid: number; open: boolean };
let pool: TestPool;
let app: INestApplication<App> | undefined;
let database: ObservedDatabase;
let audit: ProbeAudit;
let f: DutyMutationFixture;
let token: string;
let previousOrigin: string | undefined;
const companies: string[] = [];
const held: Held[] = [];
const pending = new Set<Promise<unknown>>();
const releases: (() => void)[] = [];
const result = (r: Response) => [r.status, r.body?.code ?? null];

function send(method: 'post' | 'put' | 'patch' | 'delete', path = dutyPath(f), body?: object,
  options: { session?: SyntheticSession; token?: string; version?: string; key?: string } = {}): Promise<Response> {
  const session = options.session ?? f.admin;
  const operation = request(app!.getHttpServer())[method](path).set('Origin', ORIGIN).set('Cookie', session.cookie)
    .set('X-CSRF-Token', session.csrf).set('Expected-Version', options.version ?? '1');
  if (options.token ?? token) operation.set('Edit-Lease-Token', options.token ?? token);
  if (options.key) operation.set('Idempotency-Key', options.key);
  if (body !== undefined) operation.send(body);
  const flight = operation.then((value) => value);
  pending.add(flight); void flight.finally(() => pending.delete(flight)).catch(() => {});
  return flight;
}
async function boot(clock = MUTATION_NOW) {
  if (app) await app.close();
  database = new ObservedDatabase(); audit = new ProbeAudit();
  app = await bootEmployeesApp(new RecordingDelivery(), { database, audit, clock: () => new Date(clock) });
}
async function acquire(dutyId = f.dutyId, session = f.admin): Promise<string> {
  const response = await send('post', `${dutyPath(f, dutyId)}/edit-lease`, undefined, { session });
  expect(response.status).toBe(200); return response.body.leaseToken;
}
async function begin(): Promise<Held> {
  const client = await pool.connect(); const tx = { client, pid: 0, open: true }; held.push(tx);
  await client.query("BEGIN; SET LOCAL lock_timeout = '10s'; SET LOCAL deadlock_timeout = '10s'");
  tx.pid = await backendPid(client); return tx;
}
async function finish(tx: Held, command: 'COMMIT' | 'ROLLBACK') {
  if (!tx.open) return; tx.open = false;
  try { await tx.client.query(command); } finally { tx.client.release(); }
}
async function waiters(pid: number, count = 1): Promise<void> {
  const until = Date.now() + 4000;
  while (Date.now() < until) {
    const response = await pool.query(`WITH RECURSIVE waiting(pid) AS (
      SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))
      UNION SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid = ANY(pg_blocking_pids(a.pid))) SELECT pid FROM waiting`, [pid]);
    if (response.rows.length >= count) return;
  }
  throw new Error('Expected deterministic PostgreSQL lock wait was not observed');
}
async function race(table: 'employees' | 'projects', id: string, first: () => Promise<Response>, second: () => Promise<Response>) {
  const gate = await begin(); await gate.client.query(`SELECT 1 FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
  const one = first(); void one.catch(() => {}); await waiters(gate.pid);
  const two = second(); void two.catch(() => {}); await waiters(gate.pid, 2);
  await finish(gate, 'ROLLBACK'); return Promise.all([one, two]);
}
const core = async () => { const { duties, members, leases, audit: records } = await planningState(pool, f.tenant.companyId); return { duties, members, leases, audit: records }; };
async function assignmentVersion(): Promise<string> {
  const response = await request(app!.getHttpServer()).get(`/api/v1/project-assignments?monthStart=${MUTATION_MONTH}&employeeId=${f.mira.employeeId}`).set('Cookie', f.admin2.cookie);
  expect(response.status).toBe(200);
  return String(response.body.items.find((item: { id: string }) => item.id === f.assignment).version);
}

beforeAll(() => { pool = openLocalTestPool(14); previousOrigin = process.env.APP_ORIGIN; process.env.APP_ORIGIN = ORIGIN; });
beforeEach(async () => { f = await dutyMutationFixture(pool, companies); token = ''; });
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const tx of held.splice(0)) await finish(tx, 'ROLLBACK');
  await Promise.allSettled(pending);
  await app?.close(); app = undefined;
});
afterAll(async () => {
  try { await removeSyntheticTenants(pool, companies); } finally { await pool.end(); }
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previousOrigin;
});

type Pair = {
  name: string; gate: 'employees' | 'projects'; clock?: string;
  setup?: () => Promise<void>; mutation: () => Promise<Response>; other: () => Promise<Response>;
  otherAudit: BusinessAuditAction; afterMutation: (string | number | null)[]; afterOther: (string | number | null)[];
};
const unstaff = async () => { await pool.query("UPDATE plan_assignments SET state = 'REMOVED', removed_at = clock_timestamp() WHERE duty_id = $1", [f.dutyId]); };
const pastDuty = async () => { await pool.query("UPDATE duties SET duty_date = '2027-01-10', starts_at = '2027-01-10T05:00:00Z', ends_at = '2027-01-10T17:00:00Z' WHERE id = $1", [f.dutyId]); };
const toFuture = () => send('patch', dutyPath(f), { dutyDate: MUTATION_DAY });
const PAIRS: Pair[] = [
  { name: 'D2 assignment correction vs membership addition', gate: 'employees', setup: unstaff,
    mutation: () => send('patch', dutyPath(f), { assignments: [{ employeeId: f.mira.employeeId, dutyRole: 'EMPLOYEE' }] }),
    other: () => send('patch', `/api/v1/project-assignments/${f.assignment}`, { monthStart: '2027-02-01' }, { session: f.admin2 }),
    otherAudit: 'PROJECT_ASSIGNMENT_CORRECTED', afterMutation: [409, 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT'], afterOther: [409, 'EMPLOYEE_NOT_ASSIGNED_TO_PROJECT_MONTH'] },
  { name: 'D2 assignment deletion vs membership addition', gate: 'employees', setup: unstaff,
    mutation: () => send('patch', dutyPath(f), { assignments: [{ employeeId: f.mira.employeeId, dutyRole: 'EMPLOYEE' }] }),
    other: async () => {
      return send('delete', `/api/v1/project-assignments/${f.assignment}`, undefined, { session: f.admin2, version: await assignmentVersion() });
    },
    otherAudit: 'PROJECT_ASSIGNMENT_REMOVED', afterMutation: [409, 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT'], afterOther: [409, 'EMPLOYEE_NOT_ASSIGNED_TO_PROJECT_MONTH'] },
  { name: 'D3 unrelated configuration interval vs duty edit', gate: 'projects',
    mutation: () => send('patch', dutyPath(f), { assignments: [{ employeeId: f.mira.employeeId, dutyRole: 'SHIFT_LEAD' }] }),
    other: () => send('patch', `/api/v1/projects/${f.project.projectId}/shift-configuration`, { effectiveFromMonth: '2027-02-01', shifts: [{ shiftKind: 'DAY', startLocal: '07:00', endLocal: '19:00' }] }, { session: f.admin2 }),
    otherAudit: 'SHIFT_CONFIGURATION_UPDATED', afterMutation: [200, null], afterOther: [200, null] },
  { name: 'D4 deactivation vs past-to-future duty edit', gate: 'projects', clock: '2027-01-15T12:00:00Z', setup: pastDuty,
    mutation: toFuture, other: () => send('patch', `/api/v1/projects/${f.project.projectId}`, { status: 'INACTIVE' }, { session: f.admin2 }),
    otherAudit: 'PROJECT_UPDATED', afterMutation: [409, 'PROJECT_HAS_FUTURE_DUTIES'], afterOther: [409, 'PROJECT_INACTIVE'] },
  { name: 'D5 employment bounds vs past-to-future duty edit', gate: 'employees', clock: '2027-01-15T12:00:00Z', setup: pastDuty,
    mutation: toFuture, other: () => send('patch', `/api/v1/employees/${f.mira.employeeId}`, { employmentEnd: '2027-01-19' }, { session: f.admin2 }),
    otherAudit: 'EMPLOYEE_UPDATED', afterMutation: [409, 'EMPLOYMENT_PERIOD_EXCLUDES_FUTURE_DUTIES'], afterOther: [409, 'EMPLOYEE_NOT_EMPLOYED_FOR_DAY'] },
  { name: 'employee deactivation vs past-to-future duty edit', gate: 'employees', clock: '2027-01-15T12:00:00Z', setup: pastDuty,
    mutation: toFuture, other: () => send('post', `/api/v1/employees/${f.mira.employeeId}/deactivate`, undefined, { session: f.admin2 }),
    otherAudit: 'EMPLOYEE_DEACTIVATED', afterMutation: [409, 'EMPLOYEE_HAS_FUTURE_ASSIGNMENTS'], afterOther: [409, 'EMPLOYEE_INACTIVE'] },
];

describe('SP-12 — actual workforce/mutation pairs in both orders and outcomes', () => {
  for (const pair of PAIRS) for (const mutationFirst of [true, false]) for (const rollback of [false, true]) {
    it(`${pair.name}; ${mutationFirst ? 'mutation' : 'workforce'} first ${rollback ? 'ROLLBACK' : 'COMMIT'}`, async () => {
      await pair.setup?.(); await boot(pair.clock); token = await acquire();
      if (rollback) audit.fail = mutationFirst ? 'DUTY_UPDATED' : pair.otherAudit;
      const [first, second] = await race(pair.gate, pair.gate === 'employees' ? f.mira.employeeId : f.project.projectId,
        mutationFirst ? pair.mutation : pair.other, mutationFirst ? pair.other : pair.mutation);
      const firstSuccess = !mutationFirst && pair.otherAudit === 'PROJECT_ASSIGNMENT_REMOVED' ? 204 : 200;
      expect(result(first)).toEqual(rollback ? [500, 'INTERNAL_ERROR'] : [firstSuccess, null]);
      expect(result(second)).toEqual(rollback ? [mutationFirst && pair.otherAudit === 'PROJECT_ASSIGNMENT_REMOVED' ? 204 : 200, null] : mutationFirst ? pair.afterMutation : pair.afterOther);
      expect((await pool.query(`SELECT count(*)::int AS n FROM plan_assignments pa LEFT JOIN duties d ON d.company_id=pa.company_id AND d.id=pa.duty_id
        WHERE pa.company_id=$1 AND (d.id IS NULL OR (pa.state='ACTIVE' AND d.removed_at IS NOT NULL))`, [f.tenant.companyId])).rows[0].n).toBe(0);
    });
  }
});

describe('SP-12 — competing edits, removal, membership sets and live slots', () => {
  for (const first of ['patch', 'delete'] as const) for (const second of ['patch', 'delete'] as const) for (const rollback of [false, true]) {
    it(`${first} vs ${second}; first ${rollback ? 'ROLLBACK' : 'COMMIT'} never overwrites a stale version`, async () => {
      await boot(); token = await acquire();
      if (rollback) audit.fail = first === 'patch' ? 'DUTY_UPDATED' : 'DUTY_REMOVED';
      const one = () => send(first, dutyPath(f), first === 'patch' ? { dutyDate: '2027-01-21' } : undefined);
      const two = () => send(second, dutyPath(f), second === 'patch' ? { dutyDate: '2027-01-22' } : undefined);
      const responses = await race('employees', f.mira.employeeId, one, two);
      expect(result(responses[0])).toEqual(rollback ? [500, 'INTERNAL_ERROR'] : [first === 'patch' ? 200 : 204, null]);
      expect(result(responses[1])).toEqual(rollback ? [second === 'patch' ? 200 : 204, null]
        : first === 'delete' ? [404, 'RESOURCE_NOT_FOUND'] : [409, 'PLAN_CONCURRENT_MODIFICATION']);
      expect((await pool.query('SELECT concurrency_version::int AS version FROM duties WHERE id=$1', [f.dutyId])).rows[0].version).toBe(2);
    });
  }

  it.each([true, false])('two distinct Admin accounts; holder first = %s; foreign token cannot mutate', async (holderFirst) => {
    await boot(); token = await acquire();
    const owner = () => send('patch', dutyPath(f), { dutyDate: '2027-01-21' });
    const foreign = () => send('patch', dutyPath(f), { dutyDate: '2027-01-22' }, { session: f.admin2 });
    const responses = await race('employees', f.mira.employeeId, holderFirst ? owner : foreign, holderFirst ? foreign : owner);
    expect(responses.map(result)).toEqual(holderFirst ? [[200, null], [409, 'EDIT_LEASE_NOT_HELD']] : [[409, 'EDIT_LEASE_NOT_HELD'], [200, null]]);
  });

  it.each(['COMMIT', 'ROLLBACK'] as const)('membership discovery drift, stand-in writer %s: no late employee lock or unsafe write', async (command) => {
    await boot(); token = await acquire();
    const writer = await begin();
    await lockAccountsPrefix(writer.client, adminContext(f.second), ['COMPANY_ADMIN']);
    await writer.client.query('SELECT 1 FROM employees WHERE company_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR NO KEY UPDATE', [f.tenant.companyId, [f.mira.employeeId, f.jonas.employeeId].sort()]);
    await writer.client.query('SELECT 1 FROM projects WHERE id=$1 FOR SHARE', [f.project.projectId]);
    await writer.client.query('SELECT 1 FROM project_assignments WHERE company_id=$1 AND planning_month=$2::date ORDER BY id FOR SHARE', [f.tenant.companyId, MUTATION_MONTH]);
    await writer.client.query('SELECT 1 FROM monthly_plans WHERE id=$1 FOR SHARE', [f.planId]);
    await writer.client.query('SELECT 1 FROM duties WHERE id=$1 FOR UPDATE', [f.dutyId]);
    // Negative control: intentionally omit the version bump so identity-set
    // comparison, rather than the ordinary version guard, must detect drift.
    await writer.client.query("INSERT INTO plan_assignments(company_id,duty_id,employee_id,duty_function) VALUES($1,$2,$3,'MITARBEITER')", [f.tenant.companyId, f.dutyId, f.jonas.employeeId]);
    const changed = send('patch', dutyPath(f), { assignments: [{ employeeId: f.mira.employeeId, dutyRole: 'SHIFT_LEAD' }] });
    await waiters(writer.pid); await finish(writer, command);
    expect(result(await changed)).toEqual(command === 'COMMIT' ? [409, 'PLAN_CONCURRENT_MODIFICATION'] : [200, null]);
    expect(database.employeeSets).toEqual([[f.mira.employeeId]]);
  });

  it.each([true, false])('opposite membership transfers lock the same employee union in UUID order; first duty = %s', async (forward) => {
    await boot(); token = await acquire();
    const secondDuty = await insertDuty(pool, { companyId: f.tenant.companyId, projectId: f.project.projectId, planId: f.planId, month: MUTATION_MONTH,
      dutyDate: '2027-01-21', startsAt: '2027-01-21T05:00:00Z', endsAt: '2027-01-21T17:00:00Z' });
    await insertMembership(pool, f.tenant.companyId, secondDuty, f.jonas.employeeId);
    const secondToken = await acquire(secondDuty, f.admin2);
    const one = () => send('patch', dutyPath(f), { assignments: [{ employeeId: f.jonas.employeeId, dutyRole: 'EMPLOYEE' }] });
    const two = () => send('patch', dutyPath(f, secondDuty), { assignments: [{ employeeId: f.mira.employeeId, dutyRole: 'EMPLOYEE' }] }, { session: f.admin2, token: secondToken });
    const responses = await race('employees', [f.mira.employeeId, f.jonas.employeeId].sort()[0], forward ? one : two, forward ? two : one);
    expect(responses.map(result)).toEqual([[200, null], [200, null]]);
    expect(database.employeeSets).toEqual([[f.mira.employeeId, f.jonas.employeeId].sort(), [f.mira.employeeId, f.jonas.employeeId].sort()]);
  });

  it('two empty duties racing for one live slot return one success and one sanitized duplicate conflict', async () => {
    await unstaff(); await boot(); token = await acquire();
    const secondDuty = await insertDuty(pool, { companyId: f.tenant.companyId, projectId: f.project.projectId, planId: f.planId, month: MUTATION_MONTH,
      dutyDate: '2027-01-21', startsAt: '2027-01-21T05:00:00Z', endsAt: '2027-01-21T17:00:00Z' });
    const otherToken = await acquire(secondDuty, f.admin2);
    const responses = await race('projects', f.project.projectId,
      () => send('patch', dutyPath(f), { dutyDate: '2027-01-22' }),
      () => send('patch', dutyPath(f, secondDuty), { dutyDate: '2027-01-22' }, { session: f.admin2, token: otherToken }));
    expect(responses.map(result).sort((a,b) => Number(a[0])-Number(b[0]))).toEqual([[200, null], [409, 'DUTY_ALREADY_EXISTS']]);
  });
});

describe('SP-12 — lease wait/expiry and duty removal dependencies', () => {
  it('a command admitted under a valid lease holds D/Q through commit even if expiry passes before audit completion', async () => {
    await boot(); token = await acquire(); const arrived = latch(); const resume = latch(); releases.push(resume.release); let pid = 0;
    audit.hook = async (client, entry) => {
      if (entry.action !== 'DUTY_UPDATED') return;
      // Fixture-only clock-advance equivalent, after admission and real audit:
      // no wall-clock sleeps, and the admitted transaction still owns D/Q.
      await client.query("UPDATE edit_leases SET acquired_at=clock_timestamp()-interval '180 seconds', expires_at=clock_timestamp()-interval '1 second' WHERE duty_id=$1", [f.dutyId]);
      pid = await backendPid(client); arrived.release(); await resume.promise;
    };
    const mutation = send('patch', dutyPath(f), { dutyDate: '2027-01-21' }); await arrived.promise;
    const takeover = send('post', `${dutyPath(f)}/edit-lease`, undefined, { session: f.admin2 });
    await waiters(pid); resume.release();
    expect(result(await mutation)).toEqual([200, null]);
    const next = await takeover; expect(next.status).toBe(200);
    expect(result(await send('patch', dutyPath(f), { dutyDate: '2027-01-22' }, { session: f.admin2, token: next.body.leaseToken }))).toEqual([409, 'PLAN_CONCURRENT_MODIFICATION']);
  });
  it.each(['COMMIT', 'ROLLBACK'] as const)('acquire reevaluates expiry after a Q upsert wait; expiry writer %s', async (command) => {
    await boot(); token = await acquire(); const writer = await begin();
    await writer.client.query('SELECT 1 FROM edit_leases WHERE duty_id=$1 FOR UPDATE', [f.dutyId]);
    const acquiring = send('post', `${dutyPath(f)}/edit-lease`, undefined, { session: f.admin2 });
    await waiters(writer.pid);
    await writer.client.query("UPDATE edit_leases SET acquired_at=clock_timestamp()-interval '180 seconds', expires_at=clock_timestamp()-interval '1 second' WHERE duty_id=$1", [f.dutyId]);
    await finish(writer, command);
    expect(result(await acquiring)).toEqual(command === 'COMMIT' ? [200, null] : [409, 'RESOURCE_EDIT_LOCKED']);
  });
  it.each(['COMMIT', 'ROLLBACK'] as const)('competing acquire on an absent slot, first %s', async (command) => {
    await boot();
    const writer = await begin(); await writer.client.query('SELECT 1 FROM duties WHERE id=$1 FOR UPDATE', [f.dutyId]);
    await writer.client.query("INSERT INTO edit_leases(company_id,duty_id,owner_account_id,token_hash,expires_at) VALUES($1,$2,$3,decode(repeat('ab',32),'hex'),clock_timestamp()+interval '120 seconds')", [f.tenant.companyId, f.dutyId, f.tenant.admin.accountId]);
    const acquiring = send('post', `${dutyPath(f)}/edit-lease`, undefined, { session: f.admin2 });
    await waiters(writer.pid); await finish(writer, command);
    expect(result(await acquiring)).toEqual(command === 'COMMIT' ? [409, 'RESOURCE_EDIT_LOCKED'] : [200, null]);
    expect((await pool.query('SELECT count(*)::int AS n FROM edit_leases WHERE duty_id=$1', [f.dutyId])).rows[0].n).toBe(1);
  });

  for (const method of ['patch', 'delete', 'put'] as const) for (const command of ['COMMIT', 'ROLLBACK'] as const) {
    it(`${method} uses a fresh expiry check after the Q wait; expiry writer ${command}`, async () => {
      await boot(); token = await acquire();
      const writer = await begin();
      // Test-only expiry writer never asks for a parent: it cannot form a cycle.
      await writer.client.query('SELECT 1 FROM edit_leases WHERE duty_id=$1 FOR UPDATE', [f.dutyId]);
      const response = send(method, dutyPath(f) + (method === 'put' ? '/edit-lease' : ''), method === 'patch' ? { dutyDate: '2027-01-21' } : undefined);
      await waiters(writer.pid);
      await writer.client.query("UPDATE edit_leases SET acquired_at=clock_timestamp()-interval '180 seconds', expires_at=clock_timestamp()-interval '1 second' WHERE duty_id=$1", [f.dutyId]);
      await finish(writer, command);
      expect(result(await response)).toEqual(command === 'COMMIT' ? [409, 'EDIT_LEASE_NOT_HELD'] : [method === 'delete' ? 204 : 200, null]);
    });
  }

  for (const dependency of ['configuration', 'assignment', 'project', 'employment', 'deactivation'] as const) for (const rollback of [false, true]) {
    it(`remove first ${rollback ? 'ROLLBACK' : 'COMMIT'}; fresh ${dependency} dependency scan`, async () => {
      await boot(); token = await acquire(); if (rollback) audit.fail = 'DUTY_REMOVED';
      const others = {
        configuration: () => send('patch', `/api/v1/projects/${f.project.projectId}/shift-configuration`, { effectiveFromMonth: MUTATION_MONTH, shifts: [{ shiftKind: 'DAY', startLocal: '07:00', endLocal: '19:00' }] }, { session: f.admin2 }),
        assignment: async () => send('delete', `/api/v1/project-assignments/${f.assignment}`, undefined, { session: f.admin2, version: await assignmentVersion() }),
        project: () => send('patch', `/api/v1/projects/${f.project.projectId}`, { status: 'INACTIVE' }, { session: f.admin2 }),
        employment: () => send('patch', `/api/v1/employees/${f.mira.employeeId}`, { employmentEnd: '2027-01-19' }, { session: f.admin2 }),
        deactivation: () => send('post', `/api/v1/employees/${f.mira.employeeId}/deactivate`, undefined, { session: f.admin2 }),
      };
      const conflicts = { configuration: 'SHIFT_CONFIGURATION_CONFLICT', assignment: 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT', project: 'PROJECT_HAS_FUTURE_DUTIES', employment: 'EMPLOYMENT_PERIOD_EXCLUDES_FUTURE_DUTIES', deactivation: 'EMPLOYEE_HAS_FUTURE_ASSIGNMENTS' };
      const isProject = dependency === 'configuration' || dependency === 'project';
      const [one, two] = await race(isProject ? 'projects' : 'employees', isProject ? f.project.projectId : f.mira.employeeId, () => send('delete'), others[dependency]);
      expect(result(one)).toEqual(rollback ? [500, 'INTERNAL_ERROR'] : [204, null]);
      expect(result(two)).toEqual(rollback ? [409, conflicts[dependency]] : [dependency === 'assignment' ? 204 : 200, null]);
    });
  }
});

describe('SP-12 — absence and lifecycle prefix proofs', () => {
  for (const absenceFirst of [true, false]) for (const rollback of [false, true]) {
    it(`actual availability commit vs edit; ${absenceFirst ? 'absence' : 'edit'} first ${rollback ? 'ROLLBACK' : 'COMMIT'}`, async () => {
      await pastDuty(); await boot('2027-01-15T12:00:00Z'); token = await acquire();
      const input = { operation: 'SET', fromDate: MUTATION_DAY, toDate: MUTATION_DAY, status: 'SICK' };
      const path = `/api/v1/employees/${f.mira.employeeId}/availability`;
      const preview = await send('post', `${path}/preview`, input, { session: f.admin2 });
      expect(preview.status).toBe(200);
      const absence = () => send('post', `${path}/batch`, { ...input, previewToken: preview.body.previewToken }, { session: f.admin2, key: randomUUID() });
      if (rollback) audit.fail = absenceFirst ? 'EMPLOYEE_AVAILABILITY_SET' : 'DUTY_UPDATED';
      const responses = await race('employees', f.mira.employeeId, absenceFirst ? absence : toFuture, absenceFirst ? toFuture : absence);
      expect(result(responses[0])).toEqual(rollback ? [500, 'INTERNAL_ERROR'] : [200, null]);
      expect(result(responses[1])).toEqual(!rollback && absenceFirst ? [409, 'EMPLOYEE_UNAVAILABLE'] : [200, null]);
      // A later fact reports a neutral conflict; it never rewrites the duty.
      if (!rollback && !absenceFirst) {
        const shown = await request(app!.getHttpServer()).get(dutyPath(f)).set('Cookie', f.admin.cookie);
        expect(shown.body).toMatchObject({ version: 2, dutyDate: MUTATION_DAY });
        expect(shown.body.availabilityConflicts).toHaveLength(1);
      }
    });
  }

  async function lifecyclePrefix(tx: Held) {
    await lockAccountsPrefix(tx.client, adminContext(f.second), ['COMPANY_ADMIN']);
    await tx.client.query('SELECT 1 FROM employees WHERE company_id=$1 AND id=$2 FOR NO KEY UPDATE', [f.tenant.companyId, f.mira.employeeId]);
    await tx.client.query('SELECT 1 FROM projects WHERE company_id=$1 AND id=$2 FOR SHARE', [f.tenant.companyId, f.project.projectId]);
    await tx.client.query('SELECT 1 FROM project_assignments WHERE company_id=$1 AND id=$2 FOR SHARE', [f.tenant.companyId, f.assignment]);
    await tx.client.query('SELECT 1 FROM monthly_plans WHERE company_id=$1 AND id=$2 FOR UPDATE', [f.tenant.companyId, f.planId]);
    return (await tx.client.query('SELECT concurrency_version::int AS version FROM duties WHERE company_id=$1 AND id=$2', [f.tenant.companyId, f.dutyId])).rows[0].version;
  }
  for (const mutationFirst of [true, false]) for (const command of ['COMMIT', 'ROLLBACK'] as const) {
    it(`test-only lifecycle reader with full prefix; ${mutationFirst ? 'mutation' : 'lifecycle'} first ${command}`, async () => {
      await boot(); token = await acquire();
      const lifecycle = await begin();
      if (mutationFirst) {
        const arrived = latch(); const resume = latch(); releases.push(resume.release); let pid = 0;
        audit.hook = async (client, entry) => {
          if (entry.action !== 'DUTY_UPDATED') return;
          pid = await backendPid(client); arrived.release(); await resume.promise;
          if (command === 'ROLLBACK') await client.query('SELECT 1 / 0');
        };
        const mutation = toFutureEdit(); await arrived.promise;
        // An ordinary editor holds only L SHARE: compatible SHARE succeeds;
        // exclusive lifecycle access cannot pass it.
        const probe = await begin();
        await probe.client.query('SELECT 1 FROM monthly_plans WHERE id=$1 FOR SHARE NOWAIT', [f.planId]);
        await probe.client.query('SAVEPOINT exclusive_probe');
        await expect(probe.client.query('SELECT 1 FROM monthly_plans WHERE id=$1 FOR UPDATE NOWAIT', [f.planId])).rejects.toMatchObject({ code: '55P03' });
        await probe.client.query('ROLLBACK TO SAVEPOINT exclusive_probe'); await finish(probe, 'ROLLBACK');
        const observing = lifecyclePrefix(lifecycle); await waiters(pid); resume.release();
        expect(result(await mutation)).toEqual(command === 'COMMIT' ? [200, null] : [500, 'INTERNAL_ERROR']);
        expect(await observing).toBe(command === 'COMMIT' ? 2 : 1); await finish(lifecycle, 'COMMIT');
      } else {
        expect(await lifecyclePrefix(lifecycle)).toBe(1);
        const mutation = toFutureEdit(); await waiters(lifecycle.pid); await finish(lifecycle, command);
        expect(result(await mutation)).toEqual([200, null]);
      }
    });
  }
  function toFutureEdit() { return send('patch', dutyPath(f), { dutyDate: '2027-01-21' }); }
});

describe('SP-12 — real technical failure rollback without replay', () => {
  for (const operation of ['patch', 'delete'] as const) for (const code of ['55P03', '40P01', '40001'] as const) {
    it(`${operation}: PostgreSQL ${code} after domain/audit writes is sanitized and atomic`, async () => {
      await boot(); token = await acquire(); database.serializable = code === '40001';
      const spare = await createSyntheticProject(pool, f.tenant.companyId, 'SP12 failure probe');
      const before = await core(); const blocker = await begin();
      if (code !== '40001') await blocker.client.query('SELECT 1 FROM projects WHERE id=$1 FOR UPDATE', [spare.projectId]);
      const arrived = latch(); let observed: string | undefined;
      audit.hook = async (client, entry) => {
        if (entry.action !== (operation === 'patch' ? 'DUTY_UPDATED' : 'DUTY_REMOVED')) return;
        expect((await client.query("SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement")).rows[0]).toEqual({ lock: '5s', statement: '15s' });
        if (code === '40P01') await client.query("SET LOCAL deadlock_timeout='100ms'");
        if (code === '40001') {
          await blocker.client.query("UPDATE projects SET name=name || ' changed' WHERE id=$1", [spare.projectId]);
          await finish(blocker, 'COMMIT');
        }
        arrived.release();
        try { await client.query('SELECT 1 FROM projects WHERE id=$1 FOR UPDATE', [spare.projectId]); }
        catch (error) { observed = (error as { code?: string }).code; throw error; }
      };
      const response = send(operation, dutyPath(f), operation === 'patch' ? { dutyDate: '2027-01-21' } : undefined);
      await arrived.promise;
      if (code === '40P01') {
        await waiters(blocker.pid);
        // Deliberate test-only inversion creates a real deadlock; the app's
        // shorter detector selects it as victim. Production adds no late locks.
        await blocker.client.query('SELECT 1 FROM duties WHERE id=$1 FOR UPDATE', [f.dutyId]);
      }
      const finished = await response;
      expect(result(finished)).toEqual([500, 'INTERNAL_ERROR']);
      expect(observed).toBe(code); expect(audit.attempts).toBe(1);
      expect(JSON.stringify(finished.body)).not.toMatch(/SELECT|55P03|40P01|40001|token_hash|constraint|deadlock/);
      expect(finished.body.correlationId).toBe(finished.headers['x-correlation-id']);
      await finish(blocker, 'ROLLBACK'); expect(await core()).toEqual(before);
    }, 15_000);
  }
});

describe('SP-12 — authority revalidation after HTTP authentication', () => {
  it.each(['patch', 'delete', 'lease'] as const)('%s fails closed when an unsupported workflow relation appears', async (operation) => {
    await boot(); token = await acquire(); const before = await core();
    database.beforeCommand = async (client) => { await client.query('CREATE TEMP TABLE cancellation_requests(id uuid) ON COMMIT DROP'); };
    const execute = () => operation === 'lease' ? send('post', `${dutyPath(f)}/edit-lease`)
      : send(operation, dutyPath(f), operation === 'patch' ? { dutyDate: '2027-01-21' } : undefined);
    const value = await execute(); expect(result(value)).toEqual([500, 'INTERNAL_ERROR']); expect(await core()).toEqual(before);
    expect((await execute()).status).toBe(operation === 'delete' ? 204 : 200);
  });
  for (const operation of ['patch', 'delete', 'lease'] as const) for (const change of ['role', 'account', 'company'] as const) for (const command of ['COMMIT', 'ROLLBACK'] as const) {
    it(`${operation}: ${change} ${command} between authentication and account prefix`, async () => {
      await boot(); token = await acquire(); const before = await core();
      const arrived = latch(); const resume = latch(); releases.push(resume.release);
      database.beforeCommand = async () => { arrived.release(); await resume.promise; };
      const response = operation === 'lease' ? send('post', `${dutyPath(f)}/edit-lease`)
        : send(operation, dutyPath(f), operation === 'patch' ? { dutyDate: '2027-01-21' } : undefined);
      await arrived.promise;
      const changer = await begin();
      if (change === 'company') await changer.client.query("UPDATE companies SET status='SUSPENDED' WHERE id=$1", [f.tenant.companyId]);
      else await changer.client.query(change === 'role'
        ? "UPDATE accounts SET role='EMPLOYEE' WHERE company_id=$1 AND id=$2"
        : "UPDATE accounts SET status='DEACTIVATED' WHERE company_id=$1 AND id=$2", [f.tenant.companyId, f.tenant.admin.accountId]);
      await finish(changer, command); resume.release();
      const value = await response;
      expect(result(value)).toEqual(command === 'COMMIT' ? [change === 'role' ? 403 : 401, change === 'role' ? 'ACTION_FORBIDDEN' : 'SESSION_REVOKED']
        : [operation === 'delete' ? 204 : 200, null]);
      if (command === 'COMMIT') expect(await core()).toEqual(before);
    });
  }
});
