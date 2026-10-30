/** Real PostgreSQL locks, both acquisition orders, rollback and lost-response safety. */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { App } from 'supertest/types.js';
import request from 'supertest';
import { vi } from 'vitest';
import { DatabaseService } from '../src/database/database.service.js';
import { createSyntheticAccount, createSyntheticEmployee, createSyntheticProject, createSyntheticSession,
  createSyntheticTenant, openLocalTestPool, realSessionService, removeSyntheticTenants, backendPid,
  type SyntheticTenant, type SyntheticEmployee, type SyntheticSession, type TestPool } from './helpers/synthetic-tenants.js';
import { bootEmployeesApp, RecordingDelivery, ORIGIN } from './helpers/employees-test-app.js';

let pool: TestPool; let app: INestApplication<App>; let tenant: SyntheticTenant;
let employee: SyntheticEmployee; let admins: SyntheticSession[]; let projectId: string;
let previousOrigin: string | undefined;
const companies: string[] = []; const flights = new Set<Promise<request.Response>>();
const input = { operation: 'SET', fromDate: '2026-10-28', toDate: '2026-10-29', status: 'SICK' };
const path = () => `/api/v1/employees/${employee.employeeId}`;
function latch() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
const gates: { resume: ReturnType<typeof latch> }[] = [];
const held: PoolClient[] = [];
function send(method: 'post' | 'patch' | 'delete', url: string, body: object, admin = 0, key?: string, version?: string) {
  const session = admins[admin];
  let call = request(app.getHttpServer())[method](url).set('Origin', ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf);
  if (key) call = call.set('Idempotency-Key', key);
  if (version) call = call.set('Expected-Version', version);
  const pending = Promise.resolve(call.send(body)); flights.add(pending);
  void pending.finally(() => flights.delete(pending)).catch(() => {}); return pending;
}
async function body(admin = 0) {
  const shown = await send('post', `${path()}/availability/preview`, input, admin);
  expect(shown.status).toBe(200); return { ...input, previewToken: shown.body.previewToken };
}
const commit = (payload: object, admin = 0, key = randomUUID()) => send('post', `${path()}/availability/batch`, payload, admin, key);

/** Pause AFTER actual SQL. A synthetic failure tests rollback, never fabricates results. */
function barrier(match: (sql: string, params: unknown[]) => boolean, fail = false, authenticatedPair = false) {
  const ready = latch(); const resume = latch(); const gate = { ready, resume, pid: 0, paused: false }; gates.push(gate);
  const actors = Array.from({ length: 2 }, () => ({ ready: latch(), resume: latch() }));
  if (authenticatedPair) gates.push(...actors);
  let actorIndex = 0;
  const database = app.get(DatabaseService); const real = database.withTransaction.bind(database);
  vi.spyOn(database, 'withTransaction').mockImplementation((work) => real(async (client) => work(new Proxy(client, {
    get(target, key) {
      if (key !== 'query') return Reflect.get(target, key, target);
      return async (...args: unknown[]) => {
        if (authenticatedPair && typeof args[0] === 'string' && args[0].includes('FOR SHARE OF a, c') && actorIndex < 2) {
          // Both real HTTP guards must finish before either business actor lock.
          // Otherwise the inherited SessionService account UPDATE lock serializes
          // the second request before it can reach the idempotency reservation.
          const actor = actors[actorIndex++]; actor.ready.resolve(); await actor.resume.promise;
        }
        const hit = !gate.paused && typeof args[0] === 'string' && match(args[0], Array.isArray(args[1]) ? args[1] : []);
        if (hit) gate.paused = true;
        const query = target.query.bind(target) as unknown as (...args: unknown[]) => Promise<unknown>;
        const result = await query(...args);
        if (hit) { gate.pid = await backendPid(target); ready.resolve(); await resume.promise; if (fail) throw new Error('synthetic transaction rollback'); }
        return result;
      };
    },
  }))));
  return { ...gate, get pid() { return gate.pid; }, actors };
}
const auditGate = (action: string, fail = false) => barrier((sql, params) => sql.includes('INSERT INTO audit_event') && params[2] === action, fail);
async function reached(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise<never>((_done, reject) => { timer = setTimeout(() => reject(new Error('SQL barrier not reached')), 4000); })]); }
  finally { clearTimeout(timer); }
}
async function blocked(holder: number) {
  const until = Date.now() + 4000;
  while (Date.now() < until) {
    const result = await pool.query('SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid)) AND wait_event_type = $2', [holder, 'Lock']);
    if (result.rowCount) return;
  }
  throw new Error('Expected real PostgreSQL lock waiter');
}
async function state() {
  const rows = (await pool.query('SELECT to_char(day,$2) AS day,status FROM employee_availability_days WHERE employee_id=$1 ORDER BY day', [employee.employeeId, 'YYYY-MM-DD'])).rows;
  const revision = (await pool.query('SELECT availability_revision::text AS revision FROM employees WHERE id=$1', [employee.employeeId])).rows[0].revision;
  const audits = (await pool.query('SELECT action FROM audit_event WHERE company_id=$1 ORDER BY action', [tenant.companyId])).rows;
  return { rows, revision, audits };
}
beforeAll(() => { pool = openLocalTestPool(12); previousOrigin = process.env.APP_ORIGIN; process.env.APP_ORIGIN = ORIGIN; });
beforeEach(async () => {
  tenant = await createSyntheticTenant(pool, 'SP10 locks'); companies.push(tenant.companyId);
  employee = await createSyntheticEmployee(pool, tenant.employee, 'SP10-L', { start: '2020-01-01' });
  const secondAdmin = await createSyntheticAccount(pool, tenant.companyId, 'COMPANY_ADMIN');
  admins = await Promise.all([tenant.admin, secondAdmin].map((account) => createSyntheticSession(realSessionService(pool), account)));
  projectId = (await createSyntheticProject(pool, tenant.companyId, 'SP10 project')).projectId;
  app = await bootEmployeesApp(new RecordingDelivery(), { clock: () => new Date('2026-10-30T12:00:00Z') });
});
afterEach(async () => {
  for (const gate of gates.splice(0)) gate.resume.resolve();
  for (const client of held.splice(0)) { await client.query('ROLLBACK'); client.release(); }
  await Promise.allSettled(flights); vi.restoreAllMocks(); await app?.close(); await removeSyntheticTenants(pool, companies.splice(0));
});
afterAll(async () => { await pool?.end(); if (previousOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previousOrigin; });

for (const rollback of [false, true]) {
  it(`serializes competing administrators, first ${rollback ? 'ROLLBACK' : 'COMMIT'}, fresh post-lock state`, async () => {
    const one = await body(0); const two = await body(1);
    const gate = auditGate('EMPLOYEE_AVAILABILITY_SET', rollback);
    const first = commit(one); await reached(gate.ready.promise);
    const second = commit(two, 1); await blocked(gate.pid); gate.resume.resolve();
    expect((await first).status).toBe(rollback ? 500 : 200);
    const result = await second; expect(result.status).toBe(rollback ? 200 : 409);
    if (!rollback) expect(result.body.code).toBe('AVAILABILITY_PREVIEW_STALE');
    expect(await state()).toMatchObject({ revision: '1', rows: [{ status: 'SICK' }, { status: 'SICK' }],
      audits: [{ action: 'EMPLOYEE_AVAILABILITY_SET' }, { action: 'EMPLOYEE_AVAILABILITY_SET' }] });
  });
}
it('same-key concurrent request returns IN_PROGRESS, then replays exactly one result', async () => {
  const payload = await body(); const key = randomUUID();
  const gate = barrier((sql, params) => sql.includes('INSERT INTO audit_event') && params[2] === 'EMPLOYEE_AVAILABILITY_SET', false, true);
  const first = commit(payload, 0, key); await reached(gate.actors[0].ready.promise);
  const second = commit(payload, 0, key); await reached(gate.actors[1].ready.promise);
  gate.actors[0].resume.resolve(); await reached(gate.ready.promise); gate.actors[1].resume.resolve();
  const duplicate = await second;
  expect(duplicate.status).toBe(409); expect(duplicate.body.code).toBe('IDEMPOTENCY_REQUEST_IN_PROGRESS');
  expect(duplicate.headers['retry-after']).toBe('1'); gate.resume.resolve();
  const saved = await first; const replay = await commit(payload, 0, key);
  expect(replay.body).toEqual(saved.body); expect(replay.headers['idempotency-replayed']).toBe('true');
  expect((await state()).audits).toHaveLength(2);
});
it('a duplicate waiting in the inherited authentication account lock subsequently replays success', async () => {
  const payload = await body(); const key = randomUUID(); const gate = auditGate('EMPLOYEE_AVAILABILITY_SET');
  const first = commit(payload, 0, key); await reached(gate.ready.promise);
  const second = commit(payload, 0, key); await blocked(gate.pid); gate.resume.resolve();
  expect((await first).status).toBe(200); const duplicate = await second;
  expect(duplicate.status).toBe(200); expect(duplicate.headers['idempotency-replayed']).toBe('true');
  expect((await state()).audits).toHaveLength(2);
});
it('same preview and different key waits and refuses a consumed human decision', async () => {
  const payload = await body(); const gate = auditGate('EMPLOYEE_AVAILABILITY_SET');
  const first = commit(payload); await reached(gate.ready.promise);
  const second = commit(payload); await blocked(gate.pid); gate.resume.resolve();
  expect((await first).status).toBe(200); expect((await second).body.code).toBe('AVAILABILITY_PREVIEW_STALE');
});
it('transactional actor recheck refuses a downgrade committed after real HTTP authorization', async () => {
  const payload = await body(); const gate = barrier(() => false, false, true);
  const pending = commit(payload); await reached(gate.actors[0].ready.promise);
  await pool.query("UPDATE accounts SET role='EMPLOYEE' WHERE id=$1", [tenant.admin.accountId]);
  gate.actors[0].resume.resolve(); const result = await pending;
  expect(result.status).toBe(403); expect(result.body.code).toBe('ACTION_FORBIDDEN');
  expect(await state()).toEqual({ rows: [], revision: '0', audits: [] });
});

for (const operation of ['employment', 'deactivation', 'assignment', 'assignment-patch', 'assignment-delete'] as const) {
  for (const markerFirst of [false, true]) for (const rollback of [false, true]) {
    it(`${operation} vs marker, ${markerFirst ? 'marker' : operation} first ${rollback ? 'ROLLBACK' : 'COMMIT'}`, async () => {
      const payload = await body();
      let assignment: { id: string; version: string } | undefined;
      if (operation === 'assignment-patch' || operation === 'assignment-delete') {
        const created = await send('post', '/api/v1/project-assignments', { employeeId: employee.employeeId, projectId, monthStart: '2027-01-01' }, 1);
        expect(created.status).toBe(201); assignment = created.body;
      }
      const other = () => operation === 'employment' ? send('patch', path(), { employmentEnd: '2026-10-27' }, 1) :
        operation === 'deactivation' ? send('post', `${path()}/deactivate`, {}, 1) :
          operation === 'assignment-patch' ? send('patch', `/api/v1/project-assignments/${assignment!.id}`, { monthStart: '2027-02-01' }, 1) :
          operation === 'assignment-delete' ? send('delete', `/api/v1/project-assignments/${assignment!.id}`, {}, 1, undefined, assignment!.version) :
          send('post', '/api/v1/project-assignments', { employeeId: employee.employeeId, projectId, monthStart: '2027-01-01' }, 1);
      const action = markerFirst ? 'EMPLOYEE_AVAILABILITY_SET' : operation === 'employment' ? 'EMPLOYEE_UPDATED' :
        operation === 'deactivation' ? 'EMPLOYEE_DEACTIVATED' : operation === 'assignment-patch' ? 'PROJECT_ASSIGNMENT_CORRECTED' :
          operation === 'assignment-delete' ? 'PROJECT_ASSIGNMENT_REMOVED' : 'PROJECT_ASSIGNMENT_CREATED';
      const gate = auditGate(action, rollback);
      const first = markerFirst ? commit(payload) : other(); await reached(gate.ready.promise);
      const second = markerFirst ? other() : commit(payload); await blocked(gate.pid); gate.resume.resolve();
      const otherStatus = operation === 'assignment' ? 201 : operation === 'assignment-delete' ? 204 : 200;
      expect((await first).status).toBe(rollback ? 500 : markerFirst ? 200 : otherStatus);
      const result = await second;
      if (!markerFirst && !rollback && (operation === 'employment' || operation === 'deactivation')) {
        expect(result.status).toBe(409); expect(result.body.code).toBe('AVAILABILITY_PREVIEW_STALE');
        expect((await state()).rows).toHaveLength(0);
      } else {
        expect(result.status).toBe(markerFirst ? otherStatus : 200);
        expect((await state()).rows).toHaveLength(markerFirst && rollback ? 0 : 2);
      }
    });
  }
}
it('expires a preview during a parent wait and rejects after obtaining the lock', async () => {
  const payload = await body(); const holder = await pool.connect(); held.push(holder);
  await holder.query('BEGIN'); const pid = await backendPid(holder);
  await holder.query('SELECT id FROM employees WHERE id=$1 FOR NO KEY UPDATE', [employee.employeeId]);
  const pending = commit(payload); await blocked(pid);
  await pool.query(`UPDATE availability_batch_commands SET created_at=clock_timestamp()-INTERVAL '20 minutes',
    preview_expires_at=clock_timestamp()-INTERVAL '10 minutes', expires_at=clock_timestamp()-INTERVAL '10 minutes' WHERE employee_id=$1`, [employee.employeeId]);
  await holder.query('COMMIT'); holder.release(); held.splice(held.indexOf(holder), 1);
  expect((await pending).body.code).toBe('AVAILABILITY_PREVIEW_STALE'); expect((await state()).rows).toHaveLength(0);
});
it('failure after command completion rolls back markers, audits, revision and completion; same-key retry succeeds', async () => {
  const payload = await body(); const key = randomUUID();
  const gate = barrier((sql) => sql.includes("SET state = 'COMPLETED'"), true);
  const pending = commit(payload, 0, key); await reached(gate.ready.promise); gate.resume.resolve();
  expect((await pending).status).toBe(500);
  expect(await state()).toEqual({ rows: [], revision: '0', audits: [] });
  expect((await commit(payload, 0, key)).status).toBe(200);
});
it('technical lock timeout is sanitized INTERNAL_ERROR, not a stale confirmation', async () => {
  const payload = await body(); const holder = await pool.connect(); held.push(holder);
  await holder.query('BEGIN'); await holder.query('SELECT id FROM employees WHERE id=$1 FOR NO KEY UPDATE', [employee.employeeId]);
  const database = app.get(DatabaseService); const real = database.withTransaction.bind(database);
  vi.spyOn(database, 'withTransaction').mockImplementation((work) => real(async (client) => {
    await client.query("SET LOCAL lock_timeout='100ms'"); return work(client);
  }));
  const response = await commit(payload); expect(response.status).toBe(500); expect(response.body.code).toBe('INTERNAL_ERROR');
  expect(JSON.stringify(response.body)).not.toContain('timeout'); expect((await state()).rows).toHaveLength(0);
});
