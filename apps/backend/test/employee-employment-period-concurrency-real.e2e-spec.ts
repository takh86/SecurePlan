/** Case 2 real PG lock/snapshot proofs. Latches pass through real SQL, never fabricated results. */
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../src/database/database.service.js';
import { EmployeesService } from '../src/modules/workforce/employees/employees.service.js';
import {
  createSyntheticAccount, createSyntheticEmployee, createSyntheticProject, createSyntheticSession, createSyntheticTenant,
  openLocalTestPool, realSessionService, removeSyntheticTenants, backendPid,
  type SyntheticEmployee, type SyntheticProject, type SyntheticSession, type SyntheticTenant, type TestPool,
} from './helpers/synthetic-tenants.js';
import { ORIGIN, RecordingDelivery, bootEmployeesApp } from './helpers/employees-test-app.js';

const CODE = 'EMPLOYMENT_PERIOD_EXCLUDES_FUTURE_PROJECT_ASSIGNMENTS';
const ASSIGNMENTS = '/api/v1/project-assignments';
let pool: TestPool;
let app: INestApplication<App>;
let tenant: SyntheticTenant;
let employee: SyntheticEmployee;
let other: SyntheticEmployee;
let project: SyntheticProject;
let south: SyntheticProject;
let admins: SyntheticSession[];
let instant: string;
let previousOrigin: string | undefined;
const clock = vi.fn(() => new Date(instant));
const companies: string[] = [];
const flights = new Set<Promise<unknown>>();
type Held = { client: PoolClient; pid: number; open: boolean };
const held: Held[] = [];
type SqlGate = { ready: ReturnType<typeof latch>; resume: ReturnType<typeof latch>; pid: number; paused: boolean };
const gates: SqlGate[] = [];

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function within(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('SQL barrier not reached')), 4000); })]); }
  finally { clearTimeout(timer); }
}

/** Pause after/before one actual SQL statement. Every query/result is from PostgreSQL. */
function barrier(matches: (sql: string, params: unknown[]) => boolean, options: { before?: boolean; fail?: boolean } = {}): SqlGate {
  const ready = latch(); const resume = latch();
  const gate = { ready, resume, pid: 0, paused: false };
  gates.push(gate);
  const database = app.get(DatabaseService); const real = database.withTransaction.bind(database);
  vi.spyOn(database, 'withTransaction').mockImplementation((work) => real(async (client) => work(new Proxy(client, {
    get(target, key) {
      if (key !== 'query') return Reflect.get(target, key, target);
      return async (...args: unknown[]) => {
        const matched = !gate.paused && typeof args[0] === 'string' && matches(args[0], Array.isArray(args[1]) ? args[1] : []);
        if (matched) gate.paused = true;
        const pause = async () => { gate.pid = await backendPid(target); ready.resolve(); await resume.promise; if (options.fail) throw new Error('synthetic transaction rollback'); };
        if (matched && options.before) await pause();
        const query = target.query.bind(target) as unknown as (...values: unknown[]) => Promise<unknown>;
        const result = await query(...args);
        if (matched && !options.before) await pause();
        return result;
      };
    },
  }))));
  return gate;
}
const auditGate = (action: string, fail = false) => barrier((sql, params) => sql.includes('INSERT INTO audit_event') && params[2] === action, { fail });
const impactGate = () => barrier((sql) => sql.includes('WITH newly_uncovered AS'));

async function begin(): Promise<Held> {
  const client = await pool.connect(); await client.query('BEGIN'); await client.query("SET LOCAL lock_timeout = '4s'");
  const transaction = { client, pid: await backendPid(client), open: true }; held.push(transaction); return transaction;
}
async function finish(transaction: Held, command: 'COMMIT' | 'ROLLBACK') {
  if (!transaction.open) return; transaction.open = false;
  try { await transaction.client.query(command); } finally { transaction.client.release(); }
}
async function blocked(pid: number, count = 1) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const result = await pool.query(`WITH RECURSIVE waiters(pid) AS (
      SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))
      UNION SELECT a.pid FROM pg_stat_activity a JOIN waiters w ON w.pid = ANY(pg_blocking_pids(a.pid))
    ) SELECT w.pid FROM waiters w JOIN pg_stat_activity a ON a.pid = w.pid WHERE a.wait_event_type = 'Lock'`, [pid]);
    if (result.rows.length >= count) return;
  }
  throw new Error(`Expected ${count} actual PG lock waiter(s) on ${pid}`);
}
function send(method: 'post' | 'patch' | 'delete', path: string, body: object | undefined, index = 0, version?: number) {
  const session = admins[index];
  let pending = request(app.getHttpServer())[method](path).set('Origin', ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf);
  if (version !== undefined) pending = pending.set('Expected-Version', String(version));
  const promise = Promise.resolve(body === undefined ? pending : pending.send(body));
  flights.add(promise); void promise.finally(() => flights.delete(promise)).catch(() => {}); return promise;
}
const employeePath = () => `/api/v1/employees/${employee.employeeId}`;
const datePatch = (body: object = { employmentEnd: '2027-02-28' }, index = 1) => send('patch', employeePath(), body, index);
const deactivate = (index = 2) => send('post', `${employeePath()}/deactivate`, {}, index);
const create = () => send('post', ASSIGNMENTS, { employeeId: employee.employeeId, projectId: project.projectId, monthStart: '2027-03-01' });
const correct = (id: string, body: object) => send('patch', `${ASSIGNMENTS}/${id}`, body);
async function seed(month: string, person = employee) {
  return (await pool.query<{ id: string }>(`INSERT INTO project_assignments (company_id, employee_id, project_id, planning_month)
    VALUES ($1, $2, $3, $4::date) RETURNING id`, [tenant.companyId, person.employeeId, project.projectId, month])).rows[0].id;
}
async function version(id: string) {
  return Number((await pool.query(`SELECT (extract(epoch FROM updated_at) * 1000000)::bigint::text AS v FROM project_assignments WHERE id = $1`, [id])).rows[0].v);
}
const remove = async (id: string) => send('delete', `${ASSIGNMENTS}/${id}`, undefined, 0, await version(id));
async function audits(action: string) { return (await pool.query('SELECT old_values, new_values, resource_id FROM audit_event WHERE company_id = $1 AND action = $2 ORDER BY id', [tenant.companyId, action])).rows; }
async function bounds() { return (await pool.query('SELECT employment_start::text AS start, employment_end::text AS end, status FROM employees WHERE id = $1', [employee.employeeId])).rows[0]; }
function outcome(response: request.Response) { return `${response.status}${response.body.code ? ` ${response.body.code}` : ''}`; }

beforeAll(() => { pool = openLocalTestPool(16); previousOrigin = process.env.APP_ORIGIN; process.env.APP_ORIGIN = ORIGIN; });
beforeEach(async () => {
  instant = '2026-12-15T12:00:00.000Z'; clock.mockClear();
  tenant = await createSyntheticTenant(pool, 'C2 races'); companies.push(tenant.companyId);
  employee = await createSyntheticEmployee(pool, tenant.employee, 'C2-A', { start: '2026-01-01' });
  other = await createSyntheticEmployee(pool, await createSyntheticAccount(pool, tenant.companyId, 'EMPLOYEE'), 'C2-B', { start: '2026-01-01' });
  project = await createSyntheticProject(pool, tenant.companyId, 'C2 North'); south = await createSyntheticProject(pool, tenant.companyId, 'C2 South');
  admins = await Promise.all([0, 1, 2, 3].map(() => createSyntheticSession(realSessionService(pool), tenant.admin)));
  app = await bootEmployeesApp(new RecordingDelivery(), { clock });
});
afterEach(async () => {
  for (const gate of gates.splice(0)) gate.resume.resolve();
  for (const transaction of held.splice(0)) await finish(transaction, 'ROLLBACK');
  await Promise.allSettled(flights); vi.restoreAllMocks(); await app?.close(); await removeSyntheticTenants(pool, companies.splice(0));
});
afterAll(async () => { await pool?.end(); if (previousOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previousOrigin; });

describe('C01..05 / C15..16 assignment writes into the excluded period, both orders and rollback', () => {
  for (const operation of ['post', 'month', 'employee', 'historical-employee'] as const) {
    const prepareWriter = async () => {
      if (operation === 'post') return create;
      const id = await seed(operation === 'month' || operation === 'historical-employee' ? '2026-11-01' : '2027-03-01', operation === 'month' ? employee : other);
      return () => correct(id, operation === 'month' ? { monthStart: '2027-03-01' } : { employeeId: employee.employeeId,
        ...(operation === 'historical-employee' ? { monthStart: '2027-03-01' } : {}) });
    };
    it.each([false, true])(`${operation} first (rollback=%s), employee waits and uses committed assignment snapshot`, async (rollback) => {
      const writer = operation === 'post' ? create : await prepareWriter();
      if (typeof writer !== 'function') throw new Error('Expected prepared writer');
      const gate = auditGate(operation === 'post' ? 'PROJECT_ASSIGNMENT_CREATED' : 'PROJECT_ASSIGNMENT_CORRECTED', rollback);
      const written = writer(); await within(gate.ready.promise);
      const changed = datePatch(); await blocked(gate.pid); gate.resume.resolve();
      const [w, e] = await Promise.all([written, changed]);
      expect(w.status).toBe(rollback ? 500 : operation === 'post' ? 201 : 200);
      expect(outcome(e)).toBe(rollback ? '200' : `409 ${CODE}`);
      expect(await audits('EMPLOYEE_UPDATED')).toHaveLength(rollback ? 1 : 0);
      expect(await audits(operation === 'post' ? 'PROJECT_ASSIGNMENT_CREATED' : 'PROJECT_ASSIGNMENT_CORRECTED')).toHaveLength(rollback ? 0 : 1);
      expect((await bounds()).end).toBe(rollback ? '2027-02-28' : null);
    });
    it.each([false, true])(`employee first (rollback=%s), ${operation} waits and checks committed dates`, async (rollback) => {
      const writer = operation === 'post' ? create : await prepareWriter();
      if (typeof writer !== 'function') throw new Error('Expected prepared writer');
      const gate = auditGate('EMPLOYEE_UPDATED', rollback); const changed = datePatch(); await within(gate.ready.promise);
      const written = writer(); await blocked(gate.pid); gate.resume.resolve();
      const [e, w] = await Promise.all([changed, written]);
      expect(e.status).toBe(rollback ? 500 : 200);
      expect(outcome(w)).toBe(rollback ? operation === 'post' ? '201' : '200'
        : `409 ${operation === 'historical-employee' ? 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT' : 'EMPLOYEE_NOT_EMPLOYED_FOR_MONTH'}`);
      expect(await audits('EMPLOYEE_UPDATED')).toHaveLength(rollback ? 0 : 1);
    });
  }
});

describe('C05..10 correction/removal of existing conflicts', () => {
  it.each(['delete', 'other-employee', 'covered-month', 'historical-month'] as const)('writer %s first removes the LAST conflict; date change can commit', async (operation) => {
    const id = await seed('2027-03-01');
    const gate = auditGate(operation === 'delete' ? 'PROJECT_ASSIGNMENT_REMOVED' : 'PROJECT_ASSIGNMENT_CORRECTED');
    const written = operation === 'delete' ? remove(id) : correct(id,
      operation === 'other-employee' ? { employeeId: other.employeeId } : { monthStart: operation === 'covered-month' ? '2027-01-01' : '2026-11-01' });
    await within(gate.ready.promise); const changed = datePatch(); await blocked(gate.pid); gate.resume.resolve();
    const [w, e] = await Promise.all([written, changed]); expect(w.status).toBe(operation === 'delete' ? 204 : 200); expect(e.status).toBe(200);
    expect(await audits('EMPLOYEE_UPDATED')).toHaveLength(1);
  });
  it.each(['delete', 'other-employee', 'covered-month', 'historical-month', 'project-only'] as const)('dates first rejects while %s waits, then explicit writer proceeds', async (operation) => {
    const id = await seed('2027-03-01'); const gate = impactGate(); const changed = datePatch(); await within(gate.ready.promise);
    const written = operation === 'delete' ? remove(id) : correct(id,
      operation === 'other-employee' ? { employeeId: other.employeeId }
        : operation === 'project-only' ? { projectId: south.projectId }
          : { monthStart: operation === 'covered-month' ? '2027-01-01' : '2026-11-01' });
    await blocked(gate.pid); gate.resume.resolve(); const [e, w] = await Promise.all([changed, written]);
    expect(outcome(e)).toBe(`409 ${CODE}`); expect(w.status).toBe(operation === 'delete' ? 204 : 200); expect(await audits('EMPLOYEE_UPDATED')).toEqual([]);
  });
  it('C07 project-only correction first does not clear the blocker', async () => {
    const id = await seed('2027-03-01'); const gate = auditGate('PROJECT_ASSIGNMENT_CORRECTED'); const written = correct(id, { projectId: south.projectId });
    await within(gate.ready.promise); const changed = datePatch(); await blocked(gate.pid); gate.resume.resolve();
    expect((await written).status).toBe(200); expect(outcome(await changed)).toBe(`409 ${CODE}`);
  });
  it('C08 DELETE audit rollback leaves the blocker and original exact version', async () => {
    const id = await seed('2027-03-01'); const original = await version(id); const gate = auditGate('PROJECT_ASSIGNMENT_REMOVED', true);
    const removed = remove(id); await within(gate.ready.promise); const changed = datePatch(); await blocked(gate.pid); gate.resume.resolve();
    expect((await removed).status).toBe(500); expect(outcome(await changed)).toBe(`409 ${CODE}`); expect(await version(id)).toBe(original);
    expect(await audits('PROJECT_ASSIGNMENT_REMOVED')).toEqual([]); expect(await audits('EMPLOYEE_UPDATED')).toEqual([]);
  });
  it('C05 March remains covered, then correction to April rejects against shortened dates', async () => {
    const id = await seed('2027-03-01'); const gate = auditGate('EMPLOYEE_UPDATED'); const changed = datePatch({ employmentEnd: '2027-03-31' }); await within(gate.ready.promise);
    const written = correct(id, { monthStart: '2027-04-01' }); await blocked(gate.pid); gate.resume.resolve();
    expect((await changed).status).toBe(200); expect(outcome(await written)).toBe('409 EMPLOYEE_NOT_EMPLOYED_FOR_MONTH');
  });
  it('C05 April correction first causes shortened dates to reject', async () => {
    const id = await seed('2027-03-01'); const gate = auditGate('PROJECT_ASSIGNMENT_CORRECTED'); const written = correct(id, { monthStart: '2027-04-01' });
    await within(gate.ready.promise); const changed = datePatch({ employmentEnd: '2027-03-31' }); await blocked(gate.pid); gate.resume.resolve();
    expect((await written).status).toBe(200); expect(outcome(await changed)).toBe(`409 ${CODE}`);
  });
  it('C10 stale removal cannot unblock dates or produce a removal audit', async () => {
    const id = await seed('2027-03-01'); const stale = await version(id);
    await correct(id, { projectId: south.projectId });
    const responses = await Promise.all([send('delete', `${ASSIGNMENTS}/${id}`, undefined, 0, stale), datePatch()]);
    expect(responses.map(outcome)).toEqual(['409 PROJECT_ASSIGNMENT_CONFLICT', `409 ${CODE}`]); expect(await audits('PROJECT_ASSIGNMENT_REMOVED')).toEqual([]);
  });
});

describe('C11..14 deactivation and competing employee updates', () => {
  it.each([false, true])('deactivation first, compatible dates=%s: status is retained and rule still enforced', async (compatible) => {
    await seed('2027-03-01'); const gate = auditGate('EMPLOYEE_DEACTIVATED'); const deactivated = deactivate(); await within(gate.ready.promise);
    const changed = datePatch(compatible ? { employmentStart: '2025-01-01' } : undefined); await blocked(gate.pid); gate.resume.resolve();
    expect((await deactivated).status).toBe(200); expect(outcome(await changed)).toBe(compatible ? '200' : `409 ${CODE}`); expect((await bounds()).status).toBe('DEACTIVATED');
  });
  it.each([false, true])('dates first, compatible=%s: deactivation waits and retains separate semantics', async (compatible) => {
    await seed('2027-03-01'); const gate = compatible ? auditGate('EMPLOYEE_UPDATED') : impactGate();
    const changed = datePatch(compatible ? { employmentStart: '2025-01-01' } : undefined); await within(gate.ready.promise);
    const deactivated = deactivate(); await blocked(gate.pid); gate.resume.resolve();
    expect(outcome(await changed)).toBe(compatible ? '200' : `409 ${CODE}`); expect((await deactivated).status).toBe(200); expect((await bounds()).status).toBe('DEACTIVATED');
  });
  it.each([false, true])('C13 separate omitted fields are built from latest locked row, rollback=%s', async (rollback) => {
    const gate = auditGate('EMPLOYEE_UPDATED', rollback); const first = datePatch({ employmentStart: '2026-02-01' }, 0); await within(gate.ready.promise);
    const second = datePatch({ employmentEnd: '2027-02-28' }); await blocked(gate.pid); gate.resume.resolve();
    expect((await first).status).toBe(rollback ? 500 : 200); expect((await second).status).toBe(200);
    expect(await bounds()).toMatchObject({ start: rollback ? '2026-01-01' : '2026-02-01', end: '2027-02-28' });
    expect((await audits('EMPLOYEE_UPDATED')).find((event) => event.new_values.changedFields.includes('employmentEnd'))?.old_values.employmentStart).toBe(rollback ? '2026-01-01' : '2026-02-01');
  });
  it.each(['2027-02-28', '2027-01-31'])('C14 same-field writes/no-op use committed current values: second end=%s', async (end) => {
    const gate = auditGate('EMPLOYEE_UPDATED'); const first = datePatch(undefined, 0); await within(gate.ready.promise);
    const second = datePatch({ employmentEnd: end }); await blocked(gate.pid); gate.resume.resolve();
    expect((await first).status).toBe(200); expect((await second).status).toBe(200); expect((await bounds()).end).toBe(end);
    expect(await audits('EMPLOYEE_UPDATED')).toHaveLength(end === '2027-02-28' ? 1 : 2);
  });
});

describe('T06..08 / C18/23/24 evaluation snapshots', () => {
  it.each(['role', 'account', 'company'])('A08 acting %s changes after the entry guard: service recheck refuses without disclosure', async (field) => {
    const id = await seed('2027-03-01'); const oldVersion = await version(id); const holder = await begin();
    if (field === 'company') await holder.client.query("UPDATE companies SET status = 'SUSPENDED' WHERE id = $1", [tenant.companyId]);
    else await holder.client.query(field === 'role' ? "UPDATE accounts SET role = 'EMPLOYEE' WHERE id = $1" : "UPDATE accounts SET status = 'DEACTIVATED' WHERE id = $1", [tenant.admin.accountId]);
    const attempted = app.get(EmployeesService).update({ companyId: tenant.companyId, accountId: tenant.admin.accountId, role: 'COMPANY_ADMIN', sessionId: randomUUID() }, employee.employeeId, { employmentEnd: '2027-02-28' }, randomUUID()).catch((error: unknown) => error);
    await blocked(holder.pid); await finish(holder, 'COMMIT');
    expect(await attempted).toMatchObject({ status: field === 'role' ? 403 : 401, response: { code: field === 'role' ? 'ACTION_FORBIDDEN' : 'SESSION_REVOKED' } });
    expect((await bounds()).end).toBeNull(); expect(await audits('EMPLOYEE_UPDATED')).toEqual([]); expect(await version(id)).toBe(oldVersion); expect(clock).not.toHaveBeenCalled();
  });
  it('T06 captures clock AFTER employee lock wait across company month rollover', async () => {
    instant = '2026-12-31T22:59:59.999Z'; await seed('2027-01-01'); const gate = await begin();
    await gate.client.query('SELECT 1 FROM employees WHERE id = $1 FOR UPDATE', [employee.employeeId]);
    const changed = datePatch({ employmentStart: null }); await blocked(gate.pid); expect(clock).not.toHaveBeenCalled();
    instant = '2026-12-31T23:00:00.000Z'; await finish(gate, 'COMMIT');
    expect((await changed).status).toBe(200); expect((await audits('EMPLOYEE_UPDATED'))[0].new_values.employmentPeriodImpact).toMatchObject({ evaluatedAt: instant, companyCurrentMonth: '2027-01-01', newlyUncoveredHistoricalAssignmentCount: 1 });
  });
  it('T07/C24 one captured snapshot survives clock rollover and waiting historical correction', async () => {
    instant = '2026-12-31T22:59:59.999Z'; const id = await seed('2026-11-01'); const gate = impactGate();
    const changed = datePatch({ employmentStart: '2026-12-01' }); await within(gate.ready.promise);
    instant = '2026-12-31T23:00:00.000Z'; const written = correct(id, { monthStart: '2026-12-01' }); await blocked(gate.pid); gate.resume.resolve();
    expect((await changed).status).toBe(200); expect((await written).status).toBe(200); expect(clock.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect((await audits('EMPLOYEE_UPDATED'))[0].new_values.employmentPeriodImpact).toEqual({ evaluatedAt: '2026-12-31T22:59:59.999Z', companyCurrentMonth: '2026-12-01', companyTimeZone: 'Europe/Berlin', newlyUncoveredHistoricalAssignmentCount: 1 });
  });
  it.each(['zone', 'status'])('C18 company %s UPDATE waits on actor SHARE', async (field) => {
    const gate = auditGate('EMPLOYEE_UPDATED'); const changed = datePatch(); await within(gate.ready.promise);
    const company = await begin(); const written = company.client.query(field === 'zone' ? "UPDATE companies SET time_zone = 'America/New_York' WHERE id = $1" : "UPDATE companies SET status = 'SUSPENDED' WHERE id = $1", [tenant.companyId]);
    await blocked(gate.pid); gate.resume.resolve(); expect((await changed).status).toBe(200); await written; await finish(company, 'ROLLBACK');
    expect((await audits('EMPLOYEE_UPDATED'))[0].new_values.employmentPeriodImpact.companyTimeZone).toBe('Europe/Berlin');
  });
  it('T08 earlier committed company zone is used after actor lock wait', async () => {
    instant = '2026-12-31T23:30:00.000Z'; await seed('2027-01-01'); const company = await begin();
    await company.client.query("UPDATE companies SET time_zone = 'America/New_York' WHERE id = $1", [tenant.companyId]);
    const changed = datePatch({ employmentStart: null }); await blocked(company.pid); await finish(company, 'COMMIT'); expect(outcome(await changed)).toBe(`409 ${CODE}`);
  });
  it('C23 technical query failure after lock rolls back, releases locks and stays sanitized 500', async () => {
    const gate = barrier((sql) => sql.includes('WITH newly_uncovered AS'), { fail: true }); const changed = datePatch(); await within(gate.ready.promise);
    const written = create(); await blocked(gate.pid); gate.resume.resolve();
    expect(outcome(await changed)).toBe('500 INTERNAL_ERROR'); expect((await written).status).toBe(201); expect((await bounds()).end).toBeNull(); expect(await audits('EMPLOYEE_UPDATED')).toEqual([]);
  });
  it('C23 actual PostgreSQL lock timeout stays technical, releases the transaction and never retries', async () => {
    const holder = await begin(); await holder.client.query('SELECT 1 FROM employees WHERE id = $1 FOR UPDATE', [employee.employeeId]);
    const database = app.get(DatabaseService); const real = database.withTransaction.bind(database);
    const spy = vi.spyOn(database, 'withTransaction').mockImplementation((work) => real(async (client) => {
      await client.query("SET LOCAL lock_timeout = '200ms'"); return work(client);
    }));
    const attempted = datePatch(); await blocked(holder.pid);
    const response = await attempted; expect(outcome(response)).toBe('500 INTERNAL_ERROR');
    expect(JSON.stringify(response.body)).not.toContain('lock timeout');
    expect(await audits('EMPLOYEE_UPDATED')).toEqual([]); expect(clock).not.toHaveBeenCalled();
    await finish(holder, 'ROLLBACK'); spy.mockRestore();
    expect((await datePatch()).status).toBe(200);
  });
});

describe('C19..22 PostgreSQL row lock compatibility and raw-SQL protocol limits', () => {
  it.each([
    ['UPDATE', 'NO KEY UPDATE', true], ['UPDATE', 'UPDATE', true], ['UPDATE', 'KEY SHARE', true], ['NO KEY UPDATE', 'KEY SHARE', false],
  ] as const)('employee FOR %s versus FOR %s blocking=%s', async (holder, waiter, waits) => {
    const first = await begin(); const second = await begin();
    // Identifiers below come only from this fixed test table, never user input.
    await first.client.query(`SELECT 1 FROM employees WHERE id = $1 FOR ${holder}`, [employee.employeeId]);
    const pending = second.client.query(`SELECT 1 FROM employees WHERE id = $1 FOR ${waiter}`, [employee.employeeId]);
    if (waits) { await blocked(first.pid); await finish(first, 'ROLLBACK'); }
    await pending; await finish(second, 'ROLLBACK');
  });
  it.each(['COMMIT', 'ROLLBACK'] as const)('C20 raw INSERT first, %s: fresh statement observes the committed outcome', async (command) => {
    const writer = await begin(); await writer.client.query(`INSERT INTO project_assignments (company_id, employee_id, project_id, planning_month) VALUES ($1, $2, $3, '2027-03-01')`, [tenant.companyId, employee.employeeId, project.projectId]);
    const changed = datePatch(); await blocked(writer.pid); await finish(writer, command);
    expect(outcome(await changed)).toBe(command === 'COMMIT' ? `409 ${CODE}` : '200');
  });
  it('C21 raw INSERT waits on FK then can insert uncovered month: FK is existence protection only', async () => {
    const gate = auditGate('EMPLOYEE_UPDATED'); const changed = datePatch(); await within(gate.ready.promise);
    const writer = await begin(); const inserted = writer.client.query(`INSERT INTO project_assignments (company_id, employee_id, project_id, planning_month) VALUES ($1, $2, $3, '2027-03-01')`, [tenant.companyId, employee.employeeId, project.projectId]);
    await blocked(gate.pid); gate.resume.resolve(); expect((await changed).status).toBe(200); await inserted; await finish(writer, 'COMMIT');
    expect((await bounds()).end).toBe('2027-02-28'); expect((await pool.query('SELECT count(*)::int AS n FROM project_assignments WHERE employee_id = $1', [employee.employeeId])).rows[0].n).toBe(1);
  });
  it.each(['update', 'delete'])('C22 raw month-only %s bypasses parent lock; unsupported writer limitation', async (operation) => {
    const id = await seed('2027-01-01'); const holder = await begin(); await holder.client.query('SELECT 1 FROM employees WHERE id = $1 FOR UPDATE', [employee.employeeId]);
    const writer = await begin(); await writer.client.query(operation === 'update' ? "UPDATE project_assignments SET planning_month = '2027-03-01' WHERE id = $1" : 'DELETE FROM project_assignments WHERE id = $1', [id]);
    await finish(writer, 'ROLLBACK'); await finish(holder, 'ROLLBACK');
  });
});

describe('C17 ordered employee locks under opposing corrections, date PATCH and DELETE', () => {
  it('bounded concurrent stress: no deadlock/technical error, exact successful business audits', async () => {
    let acceptedDates = 0;
    for (let round = 0; round < 4; round += 1) {
      await pool.query('UPDATE employees SET employment_end = NULL WHERE id = $1', [employee.employeeId]);
      const one = await seed(`2027-${String(round + 3).padStart(2, '0')}-01`); const two = await seed(`2027-${String(round + 7).padStart(2, '0')}-01`, other);
      const oldVersion = await version(one);
      const responses = await Promise.all([
        correct(one, { employeeId: other.employeeId }),
        send('patch', `${ASSIGNMENTS}/${two}`, { employeeId: employee.employeeId }, 1),
        datePatch({ employmentEnd: '2027-02-28' }, 2), send('delete', `${ASSIGNMENTS}/${one}`, undefined, 3, oldVersion),
      ]);
      expect(responses.every((response) => [200, 204, 404, 409].includes(response.status))).toBe(true);
      if (responses[2].status === 200) acceptedDates += 1;
      expect(await audits('EMPLOYEE_UPDATED')).toHaveLength(acceptedDates);
      const successfulRemovals = responses[3].status === 204 ? 1 : 0;
      expect((await audits('PROJECT_ASSIGNMENT_REMOVED')).filter((event) => event.resource_id === one)).toHaveLength(successfulRemovals);
      expect((await audits('PROJECT_ASSIGNMENT_CORRECTED')).filter((event) => [one, two].includes(event.resource_id)))
        .toHaveLength(responses.slice(0, 2).filter((response) => response.status === 200).length);
      const invalid = await pool.query(`SELECT count(*)::int AS n FROM project_assignments pa
        JOIN employees e ON e.company_id = pa.company_id AND e.id = pa.employee_id
        WHERE pa.company_id = $1 AND pa.employee_id = $2 AND pa.planning_month > '2026-12-01'
          AND (e.employment_start IS NULL OR e.employment_start > (pa.planning_month + interval '1 month' - interval '1 day')::date
               OR e.employment_end < pa.planning_month)`, [tenant.companyId, employee.employeeId]);
      expect(invalid.rows[0].n).toBe(0);
    }
  });
});
