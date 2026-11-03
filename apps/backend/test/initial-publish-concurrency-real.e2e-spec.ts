/** Actual application writers, real PostgreSQL waits, both orders and outcomes. */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types.js';
import { DatabaseService } from '../src/database/database.service.js';
import { BusinessAuditService, type BusinessAuditAction, type BusinessAuditEntry } from '../src/modules/audit/business-audit.service.js';
import { MonthlyPlansService } from '../src/modules/planning/monthly-plans.service.js';
import { SessionService } from '../src/auth/session.service.js';
import { PLANNING_WRITER_TIMEOUTS } from '../src/modules/planning/planning-locks.js';
import { ORIGIN, RecordingDelivery, bootEmployeesApp } from './helpers/employees-test-app.js';
import { backendPid, openLocalTestPool, removeSyntheticTenants, type SyntheticSession, type TestPool } from './helpers/synthetic-tenants.js';
import { dutyMutationFixture, dutyPath, MUTATION_DAY, MUTATION_MONTH, MUTATION_NOW, type DutyMutationFixture } from './helpers/duty-mutation-fixtures.js';

function latch() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
class ObservedDatabase extends DatabaseService {
  after?: (client: PoolClient, sql: string, params?: unknown[]) => Promise<void>;
  employeeSets: string[][] = [];
  override withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return super.withTransaction((client) => work(new Proxy(client, {
      get: (target, key) => {
        if (key === 'query') return async (sql: string, params?: unknown[]) => {
          const result = await target.query(sql, params);
          if (sql.includes('FROM employees') && sql.includes('FOR NO KEY UPDATE') && Array.isArray(params?.[1])) this.employeeSets.push(params[1] as string[]);
          await this.after?.(target, sql, params); return result;
        };
        const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      },
    })));
  }
}
class ProbeAudit extends BusinessAuditService {
  hook?: (client: PoolClient, entry: BusinessAuditEntry) => Promise<void>;
  override async recordBusinessAction(client: PoolClient, entry: BusinessAuditEntry) {
    await super.recordBusinessAction(client, entry); await this.hook?.(client, entry);
  }
}
let pool: TestPool;
let app: INestApplication<App> | undefined;
let database: ObservedDatabase;
let audit: ProbeAudit;
let f: DutyMutationFixture;
let token: string;
let previousOrigin: string | undefined;
const companies: string[] = [];
const pending = new Set<Promise<unknown>>();
const releases: (() => void)[] = [];
const outcome = (r: Response) => [r.status, r.body?.code ?? null];
const publishPath = () => `/api/v1/monthly-plans/${f.planId}/publish`;

function send(method: 'post' | 'patch' | 'delete', path: string, body?: object,
  options: { session?: SyntheticSession; key?: string; version?: string; lease?: string } = {}) {
  const session = options.session ?? f.admin2;
  const op = request(app!.getHttpServer())[method](path).set('Origin', ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf);
  if (options.key) op.set('Idempotency-Key', options.key);
  if (options.version) op.set('Expected-Version', options.version);
  if (options.lease) op.set('Edit-Lease-Token', options.lease);
  if (body !== undefined) op.send(body);
  const flight = op.then((response) => response); pending.add(flight);
  void flight.finally(() => pending.delete(flight)).catch(() => {}); return flight;
}
const publish = (key = randomUUID(), session = f.admin) => send('post', publishPath(), undefined, { key, session });
const edit = (body: object) => send('patch', dutyPath(f), body, { version: '1', lease: token });
async function boot(clock = MUTATION_NOW) {
  database = new ObservedDatabase(); audit = new ProbeAudit();
  app = await bootEmployeesApp(new RecordingDelivery(), { database, audit, clock: () => new Date(clock) });
  const lease = await send('post', `${dutyPath(f)}/edit-lease`); expect(lease.status).toBe(200); token = lease.body.leaseToken;
}
async function waiters(pid: number) {
  const until = Date.now() + 4000;
  while (Date.now() < until) {
    const r = await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [pid]);
    if (r.rowCount) return;
  }
  throw new Error('Expected PostgreSQL lock wait was not observed');
}
function holdAudit(action: BusinessAuditAction, rollback: boolean) {
  const arrived = latch(); const resume = latch(); releases.push(resume.release); let pid = 0;
  audit.hook = async (client, entry) => {
    if (entry.action !== action) return;
    audit.hook = undefined; pid = await backendPid(client); arrived.release(); await resume.promise;
    if (rollback) await client.query('SELECT 1/0');
  };
  return { arrived, resume, pid: () => pid };
}
function holdSql(match: (sql: string) => boolean, rollback = false) {
  const arrived = latch(); const resume = latch(); releases.push(resume.release); let pid = 0;
  database.after = async (client, sql) => {
    if (!match(sql)) return;
    database.after = undefined; pid = await backendPid(client); arrived.release(); await resume.promise;
    if (rollback) await client.query('SELECT 1/0');
  };
  return { arrived, resume, pid: () => pid };
}
async function reached(barrier: ReturnType<typeof holdAudit>, first: Promise<Response>) {
  await Promise.race([barrier.arrived.promise, first.then((r) => { throw new Error(`Writer completed before its barrier: ${r.status}/${String(r.body?.code)}`); })]);
}
async function pair(first: () => Promise<Response>, second: () => Promise<Response>, barrier: ReturnType<typeof holdAudit>) {
  const one = first(); await reached(barrier, one);
  const two = second(); await waiters(barrier.pid()); barrier.resume.release();
  return Promise.all([one, two]);
}
async function assignmentVersion() {
  const response = await request(app!.getHttpServer()).get(`/api/v1/project-assignments?monthStart=${MUTATION_MONTH}&employeeId=${f.mira.employeeId}`).set('Cookie', f.admin2.cookie);
  expect(response.status).toBe(200); return String(response.body.items.find((item: { id: string }) => item.id === f.assignment).version);
}
async function absence(operation: 'SET' | 'CLEAR') {
  const input = { operation, fromDate: MUTATION_DAY, toDate: MUTATION_DAY, ...(operation === 'SET' ? { status: 'SICK' } : {}) };
  const path = `/api/v1/employees/${f.mira.employeeId}/availability`;
  const preview = await send('post', `${path}/preview`, input); expect(preview.status).toBe(200);
  return () => send('post', `${path}/batch`, { ...input, previewToken: preview.body.previewToken, ...(operation === 'CLEAR' ? { confirmation: 'CLEAR' } : {}) }, { key: randomUUID() });
}
async function state() {
  const plan = (await pool.query('SELECT status, published_at, published_by_account_id FROM monthly_plans WHERE id=$1', [f.planId])).rows[0];
  const events = (await pool.query("SELECT count(*)::int AS n FROM audit_event WHERE company_id=$1 AND action='MONTHLY_PLAN_PUBLISHED'", [f.tenant.companyId])).rows[0].n;
  const completed = (await pool.query("SELECT count(*)::int AS n FROM idempotency_records WHERE company_id=$1 AND state='COMPLETED'", [f.tenant.companyId])).rows[0].n;
  return { plan, events, completed };
}
beforeAll(() => { pool = openLocalTestPool(12); previousOrigin = process.env.APP_ORIGIN; process.env.APP_ORIGIN = ORIGIN; });
beforeEach(async () => { f = await dutyMutationFixture(pool, companies); token = ''; });
afterEach(async () => { for (const release of releases.splice(0)) release(); await Promise.allSettled(pending); await app?.close(); app = undefined; });
afterAll(async () => {
  try { await removeSyntheticTenants(pool, companies); } finally { await pool.end(); }
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previousOrigin;
});

type PairCase = { name: string; action: BusinessAuditAction; other: () => Promise<Response>; afterOther: (number | string | null)[];
  otherStatus?: number; clock?: string; prepare?: () => Promise<void>; otherReady?: () => Promise<() => Promise<Response>> };
const cases: PairCase[] = [
  { name: 'duty time PATCH', action: 'DUTY_UPDATED', other: () => edit({ dutyDate: '2027-01-21' }), afterOther: [409, 'PLAN_CONCURRENT_MODIFICATION'] },
  { name: 'membership addition', action: 'DUTY_UPDATED', other: () => edit({ assignments: [{ employeeId: f.mira.employeeId, dutyRole: 'EMPLOYEE' }, { employeeId: f.jonas.employeeId, dutyRole: 'SHIFT_LEAD' }] }), afterOther: [409, 'PLAN_CONCURRENT_MODIFICATION'] },
  { name: 'duty DELETE', action: 'DUTY_REMOVED', other: () => send('delete', dutyPath(f), undefined, { version: '1', lease: token }), otherStatus: 204, afterOther: [409, 'PLAN_CONCURRENT_MODIFICATION'] },
  { name: 'unstaffed duty insertion', action: 'DUTY_CREATED', other: () => send('post', `/api/v1/monthly-plans/${f.planId}/entries`, { dutyDate: '2027-01-21', shiftKind: 'DAY' }), otherStatus: 201, afterOther: [409, 'PLAN_CONCURRENT_MODIFICATION'] },
  { name: 'employee eligibility writer', action: 'EMPLOYEE_UPDATED', other: () => send('patch', `/api/v1/employees/${f.mira.employeeId}`, { shiftEligibility: 'NIGHT' }), afterOther: [409, 'EMPLOYEE_NOT_ELIGIBLE_FOR_SHIFT'] },
  { name: 'historical employment bound writer', action: 'EMPLOYEE_UPDATED', clock: '2030-01-01T00:00:00Z', other: () => send('patch', `/api/v1/employees/${f.mira.employeeId}`, { employmentEnd: '2027-01-19' }), afterOther: [409, 'EMPLOYEE_NOT_EMPLOYED_FOR_DAY'] },
  { name: 'historical employee/account deactivation', action: 'EMPLOYEE_DEACTIVATED', clock: '2030-01-01T00:00:00Z', other: () => send('post', `/api/v1/employees/${f.mira.employeeId}/deactivate`), afterOther: [409, 'EMPLOYEE_INACTIVE'] },
  { name: 'historical project status writer', action: 'PROJECT_UPDATED', clock: '2030-01-01T00:00:00Z', other: () => send('patch', `/api/v1/projects/${f.project.projectId}`, { status: 'INACTIVE' }), afterOther: [409, 'PROJECT_INACTIVE'] },
  { name: 'next configuration-version insertion', action: 'SHIFT_CONFIGURATION_UPDATED', other: () => send('patch', `/api/v1/projects/${f.project.projectId}/shift-configuration`, { effectiveFromMonth: '2027-02-01', shifts: [{ shiftKind: 'DAY', startLocal: '07:00', endLocal: '19:00' }] }), afterOther: [200, null] },
  { name: 'availability SET batch', action: 'EMPLOYEE_AVAILABILITY_SET', other: () => { throw new Error('prepared below'); }, otherReady: () => absence('SET'), afterOther: [409, 'EMPLOYEE_UNAVAILABLE'] },
];
for (const scenario of cases) for (const publishFirst of [true, false]) for (const rollback of [false, true]) {
  it(`${scenario.name}: ${publishFirst ? 'publish' : 'other'} first ${rollback ? 'ROLLBACK' : 'COMMIT'}, observed blocking`, async () => {
    await scenario.prepare?.(); await boot(scenario.clock); const other = await scenario.otherReady?.() ?? scenario.other;
    const held = holdAudit(publishFirst ? 'MONTHLY_PLAN_PUBLISHED' : scenario.action, rollback);
    const responses = await pair(publishFirst ? publish : other, publishFirst ? other : publish, held);
    expect(outcome(responses[0])).toEqual(rollback ? [500, 'INTERNAL_ERROR'] : [publishFirst ? 200 : scenario.otherStatus ?? 200, null]);
    expect(outcome(responses[1])).toEqual(publishFirst ? [scenario.otherStatus ?? 200, null] : rollback ? [200, null] : scenario.afterOther);
    const published = responses.some((r, i) => (publishFirst ? i === 0 : i === 1) && r.status === 200);
    const actual = await state(); expect(actual.plan.status).toBe(published ? 'PUBLISHED' : 'UNPUBLISHED');
    expect(actual.events).toBe(published ? 1 : 0); expect(actual.completed).toBe(actual.events);
    if (!publishFirst && scenario.name === 'membership addition') {
      // The publish discovery set lacks Jonas. Drift aborts instead of acquiring
      // an employee lock after L/D, which could invert a competing writer.
      expect(database.employeeSets.at(-1)).toEqual([f.mira.employeeId]);
    }
  });
}

for (const rollback of [false, true]) {
  it(`different-key concurrent publishers: first ${rollback ? 'ROLLBACK' : 'COMMIT'}`, async () => {
    await boot(); const held = holdAudit('MONTHLY_PLAN_PUBLISHED', rollback);
    const [one, two] = await pair(publish, () => publish(randomUUID(), f.admin2), held);
    expect(outcome(one)).toEqual(rollback ? [500, 'INTERNAL_ERROR'] : [200, null]);
    expect(outcome(two)).toEqual(rollback ? [200, null] : [409, 'MONTHLY_PLAN_ALREADY_PUBLISHED']);
    const actual = await state(); expect(actual.events).toBe(1); expect(actual.completed).toBe(1);
  });
  it(`same-key HTTP publishers: first ${rollback ? 'ROLLBACK' : 'COMMIT'} yields one logical result`, async () => {
    await boot(); const held = holdAudit('MONTHLY_PLAN_PUBLISHED', rollback); const key = randomUUID();
    const [one, two] = await pair(() => publish(key), () => publish(key), held);
    expect(outcome(one)).toEqual(rollback ? [500, 'INTERNAL_ERROR'] : [200, null]);
    // Session validation may wait at A before it can reach I. On rollback the
    // durable claim may briefly remain IN_PROGRESS until its failure marker.
    if (rollback && two.status === 409) expect(two.body.code).toBe('IDEMPOTENCY_REQUEST_IN_PROGRESS');
    else { expect(two.status).toBe(200); expect(two.headers['idempotency-replayed']).toBe(String(!rollback)); }
    if (two.status === 409) expect((await publish(key)).status).toBe(200);
    const actual = await state(); expect(actual.events).toBe(1); expect(actual.completed).toBe(1);
  });
  it(`initially empty plan phantom insertion: creator first ${rollback ? 'ROLLBACK' : 'COMMIT'}`, async () => {
    await pool.query("UPDATE plan_assignments SET state='REMOVED', removed_at=clock_timestamp() WHERE duty_id=$1", [f.dutyId]);
    await pool.query('UPDATE duties SET removed_at=clock_timestamp() WHERE id=$1', [f.dutyId]);
    // No live duty to acquire a UI lease for.
    database = new ObservedDatabase(); audit = new ProbeAudit(); app = await bootEmployeesApp(new RecordingDelivery(), { database, audit });
    const held = holdAudit('DUTY_CREATED', rollback);
    const [one, two] = await pair(() => send('post', `/api/v1/monthly-plans/${f.planId}/entries`, { dutyDate: MUTATION_DAY, shiftKind: 'DAY' }), publish, held);
    expect(outcome(one)).toEqual(rollback ? [500, 'INTERNAL_ERROR'] : [201, null]);
    expect(outcome(two)).toEqual(rollback ? [200, null] : [409, 'PLAN_CONCURRENT_MODIFICATION']);
    expect((await state()).events).toBe(rollback ? 1 : 0);
  });
}

it('a stale live reservation cannot be stolen; I responds in-progress without waiting or replaying', async () => {
  await boot(); const key = randomUUID(); const held = holdAudit('MONTHLY_PLAN_PUBLISHED', false);
  const trusted = await app!.get(SessionService).validateAndTouch(f.admin.rawToken);
  database.after = async (client, sql) => {
    if (!sql.includes('INSERT INTO public.idempotency_records')) return;
    database.after = undefined;
    // Age the durable claim in its short claim transaction, before business
    // execution takes I. Recovery still cannot steal it during a live writer.
    await client.query("UPDATE idempotency_records SET claimed_at=clock_timestamp()-interval '301 seconds' WHERE company_id=$1", [f.tenant.companyId]);
  };
  const first = publish(key); await reached(held, first);
  const service = app!.get(MonthlyPlansService);
  await expect(service.publish(trusted, f.planId, key, randomUUID())).rejects.toMatchObject({ status: 409, response: { code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS' } });
  held.resume.release(); expect((await first).status).toBe(200); expect((await publish(key)).headers['idempotency-replayed']).toBe('true');
});

for (const publishFirst of [true, false]) for (const rollback of [false, true]) {
  it(`availability CLEAR: ${publishFirst ? 'refused publish' : 'clear'} first, ${rollback ? 'ROLLBACK' : 'normal outcome'}`, async () => {
    await pool.query("INSERT INTO employee_availability_days(company_id,employee_id,day,status) VALUES($1,$2,$3,'SICK')", [f.tenant.companyId, f.mira.employeeId, MUTATION_DAY]);
    await boot(); const clear = await absence('CLEAR');
    const held = publishFirst
      ? holdSql((sql) => sql.includes('FROM public.monthly_plans AS mp') && sql.includes('FOR UPDATE'), rollback)
      : holdAudit('EMPLOYEE_AVAILABILITY_CLEARED', rollback);
    const [one, two] = await pair(publishFirst ? publish : clear, publishFirst ? clear : publish, held);
    expect(outcome(one)).toEqual(rollback ? [500, 'INTERNAL_ERROR'] : publishFirst ? [409, 'EMPLOYEE_UNAVAILABLE'] : [200, null]);
    expect(outcome(two)).toEqual(publishFirst ? [200, null] : rollback ? [409, 'EMPLOYEE_UNAVAILABLE'] : [200, null]);
  });
}

for (const dependency of ['assignment correction', 'assignment deletion', 'effective configuration edit'] as const) for (const publishFirst of [true, false]) for (const failFirst of [false, true]) {
  it(`${dependency}: ${publishFirst ? 'publish' : 'guarded writer'} first, ${failFirst ? 'forced rollback' : 'normal outcome'}`, async () => {
    await boot(); const version = await assignmentVersion();
    const other = dependency === 'assignment correction'
      ? () => send('patch', `/api/v1/project-assignments/${f.assignment}`, { monthStart: '2027-02-01' }, { version })
      : dependency === 'assignment deletion'
        ? () => send('delete', `/api/v1/project-assignments/${f.assignment}`, undefined, { version })
        : () => send('patch', `/api/v1/projects/${f.project.projectId}/shift-configuration`, { effectiveFromMonth: MUTATION_MONTH, shifts: [{ shiftKind: 'DAY', startLocal: '07:00', endLocal: '19:00' }] });
    const held = publishFirst ? holdAudit('MONTHLY_PLAN_PUBLISHED', failFirst)
      : holdSql((sql) => dependency === 'effective configuration edit'
        ? sql.includes('FROM projects') && sql.includes('FOR NO KEY UPDATE')
        : sql.includes('FROM employees') && sql.includes('FOR NO KEY UPDATE'), failFirst);
    const [one, two] = await pair(publishFirst ? publish : other, publishFirst ? other : publish, held);
    const refusal = [409, dependency === 'effective configuration edit' ? 'SHIFT_CONFIGURATION_CONFLICT' : 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT'];
    expect(outcome(one)).toEqual(failFirst ? [500, 'INTERNAL_ERROR'] : publishFirst ? [200, null] : refusal);
    expect(outcome(two)).toEqual(publishFirst ? refusal : [200, null]);
    const actual = await state(); expect(actual.events).toBe(publishFirst && failFirst ? 0 : 1);
    // Guard refusal is its own rollback, never reported as a committed workforce write.
  });
}

for (const publishFirst of [true, false]) for (const rollback of [false, true]) {
  it(`absent monthly-link insertion: ${publishFirst ? 'refused publish' : 'link creator'} first ${rollback ? 'ROLLBACK' : 'normal outcome'}`, async () => {
    await pool.query('DELETE FROM project_assignments WHERE id=$1', [f.assignment]); await boot();
    const create = () => send('post', '/api/v1/project-assignments', { employeeId: f.mira.employeeId, projectId: f.project.projectId, monthStart: MUTATION_MONTH });
    const held = publishFirst ? holdSql((sql) => sql.includes('FROM public.monthly_plans AS mp') && sql.includes('FOR UPDATE'), rollback)
      : holdAudit('PROJECT_ASSIGNMENT_CREATED', rollback);
    const [one, two] = await pair(publishFirst ? publish : create, publishFirst ? create : publish, held);
    expect(outcome(one)).toEqual(rollback ? [500, 'INTERNAL_ERROR'] : publishFirst ? [409, 'EMPLOYEE_NOT_ASSIGNED_TO_PROJECT_MONTH'] : [201, null]);
    expect(outcome(two)).toEqual(publishFirst ? [201, null] : rollback ? [409, 'EMPLOYEE_NOT_ASSIGNED_TO_PROJECT_MONTH'] : [200, null]);
  });
}

it('recovered claim fences an old process paused between claim and business work', async () => {
  await boot(); const key = randomUUID(); const arrived = latch(); const resume = latch(); releases.push(resume.release); let claimed = false;
  database.after = async (client, sql) => {
    if (sql.includes('INSERT INTO public.idempotency_records')) {
      await client.query("UPDATE idempotency_records SET claimed_at=clock_timestamp()-interval '301 seconds' WHERE company_id=$1", [f.tenant.companyId]);
      claimed = true;
    } else if (claimed && sql === PLANNING_WRITER_TIMEOUTS) {
      database.after = undefined; arrived.release(); await resume.promise;
    }
  };
  const old = publish(key); await arrived.promise;
  const attempt = (await pool.query('SELECT attempt_id FROM idempotency_records WHERE company_id=$1', [f.tenant.companyId])).rows[0].attempt_id;
  const recovered = await publish(key); expect(recovered.status).toBe(200);
  expect((await pool.query('SELECT attempt_id FROM idempotency_records WHERE company_id=$1', [f.tenant.companyId])).rows[0].attempt_id).not.toBe(attempt);
  resume.release(); expect(outcome(await old)).toEqual([409, 'IDEMPOTENCY_REQUEST_IN_PROGRESS']);
  expect((await publish(key)).headers['idempotency-replayed']).toBe('true');
  const actual = await state(); expect(actual.events).toBe(1); expect(actual.completed).toBe(1);
});

it('eight real concurrent publisher rounds preserve one publication and completion without deadlocks', async () => {
  for (let round = 0; round < 8; round++) {
    if (round) { await app?.close(); app = undefined; f = await dutyMutationFixture(pool, companies); }
    await boot(); const rollback = round % 2 === 1; const held = holdAudit('MONTHLY_PLAN_PUBLISHED', rollback);
    const first = round % 4 < 2 ? f.admin : f.admin2; const second = first === f.admin ? f.admin2 : f.admin;
    const [one, two] = await pair(() => publish(randomUUID(), first), () => publish(randomUUID(), second), held);
    expect(outcome(one)).toEqual(rollback ? [500, 'INTERNAL_ERROR'] : [200, null]);
    expect(outcome(two)).toEqual(rollback ? [200, null] : [409, 'MONTHLY_PLAN_ALREADY_PUBLISHED']);
    const actual = await state(); expect(actual.events).toBe(1); expect(actual.completed).toBe(1);
  }
}, 20_000); // Eight sequential rounds; application 5s lock / 15s statement limits are unchanged.
