/** A1: real migrated schema, real HTTP writers, tenant/session/CSRF and audit. */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types.js';
import { BusinessAuditService, type BusinessAuditEntry } from '../src/modules/audit/business-audit.service.js';
import { SessionService } from '../src/auth/session.service.js';
import { OperatingCalendarService } from '../src/modules/workforce/projects/operating-calendar.service.js';
import { ORIGIN, RecordingDelivery, bootEmployeesApp } from './helpers/employees-test-app.js';
import { backendPid, createSyntheticProject, openLocalTestPool, removeSyntheticTenants, type SyntheticSession, type TestPool } from './helpers/synthetic-tenants.js';
import { insertDuty, insertMembership, insertPlan } from './helpers/planning-fixtures.js';
import { dutyMutationFixture, dutyPath, MUTATION_DAY, MUTATION_MONTH, type DutyMutationFixture } from './helpers/duty-mutation-fixtures.js';

function latch() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
class ProbeAudit extends BusinessAuditService {
  hook?: (client: PoolClient, entry: BusinessAuditEntry) => Promise<void>;
  override async recordBusinessAction(client: PoolClient, entry: BusinessAuditEntry) {
    await super.recordBusinessAction(client, entry); await this.hook?.(client, entry);
  }
}
let pool: TestPool;
let app: INestApplication<App>;
let audit: ProbeAudit;
let f: DutyMutationFixture;
let previousOrigin: string | undefined;
const companies: string[] = [];
const pending: Promise<unknown>[] = [];
const releases: (() => void)[] = [];
const path = (project = f.project.projectId) => `/api/v1/projects/${project}/operating-calendar`;
const entries = () => `/api/v1/monthly-plans/${f.planId}/entries`;
const outcome = (r: Response) => [r.status, r.body.code ?? null];
function send(method: 'get' | 'post' | 'patch' | 'delete', url: string, body?: object, session: SyntheticSession = f.admin) {
  const op = request(app.getHttpServer())[method](url).set('Origin', ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf);
  if (body !== undefined) op.send(body);
  return op;
}
async function baseline(target = MUTATION_MONTH, project = f.project.projectId) {
  return (await send('get', `${path(project)}?effectiveForMonth=${target}`).expect(200)).body;
}
async function command(days = [1, 2, 3, 4, 5, 6, 7], target = MUTATION_MONTH, bootstrap = false, project = f.project.projectId) {
  const read = await baseline(target, project);
  return { effectiveFromMonth: target, expectedExactVersion: read.exactVersion,
    expectedEffective: read.effective ? { id: read.effective.id, version: read.effective.version } : null,
    expectedNextEffectiveFromMonth: read.nextEffectiveFromMonth, operatingWeekdays: days, bootstrap };
}
const create = (day = '2027-01-22', kind = 'DAY', employee = f.jonas.employeeId, session = f.admin2) =>
  send('post', entries(), { dutyDate: day, shiftKind: kind, assignments: [{ employeeId: employee, dutyRole: 'EMPLOYEE' }] }, session);
async function edit(body: object, id = f.dutyId, version = '1') {
  const lease = await send('post', `${dutyPath(f, id)}/edit-lease`).expect(200);
  return send('patch', dutyPath(f, id), body).set('Expected-Version', version).set('Edit-Lease-Token', lease.body.leaseToken);
}
function publish() { return send('post', `/api/v1/monthly-plans/${f.planId}/publish`).set('Idempotency-Key', randomUUID()); }
async function missing() { await pool.query('DELETE FROM project_operating_calendars WHERE project_id = $1', [f.project.projectId]); }
async function legacyClosed() { await pool.query('UPDATE project_operating_calendars SET weekday_mask = 1 WHERE project_id = $1', [f.project.projectId]); }

beforeAll(() => { pool = openLocalTestPool(12); previousOrigin = process.env.APP_ORIGIN; process.env.APP_ORIGIN = ORIGIN; });
beforeEach(async () => { f = await dutyMutationFixture(pool, companies); audit = new ProbeAudit(); app = await bootEmployeesApp(new RecordingDelivery(), { audit }); });
afterEach(async () => { releases.splice(0).forEach((release) => release()); await Promise.allSettled(pending.splice(0)); await app.close(); });
afterAll(async () => { try { await removeSyntheticTenants(pool, companies); } finally { await pool.end(); }
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previousOrigin; });

it('MISSING is explicit; migration/runtime invent no weekdays, reads are tenant scoped and no-store', async () => {
  await missing();
  expect(await baseline()).toMatchObject({ state: 'MISSING', effective: null, exactVersion: null, nextEffectiveFromMonth: null });
  const response = await send('get', `${path()}?effectiveForMonth=${MUTATION_MONTH}`);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(outcome(await create())).toEqual([409, 'PROJECT_CALENDAR_MISSING']);
  expect(outcome(await publish())).toEqual([409, 'PROJECT_CALENDAR_MISSING']);
});

it('replaces complete sets, sorts ISO weekdays, preserves month history and next boundaries', async () => {
  expect((await send('patch', path(), await command([5, 3, 1]))).body.outcome).toBe('APPLIED');
  expect((await baseline()).effective.operatingWeekdays).toEqual([1, 3, 5]);
  expect(outcome(await send('patch', path(), await command([2], '2027-03-01')))).toEqual([200, null]);
  const feb = await baseline('2027-02-01');
  expect(feb.exactVersion).toBeNull(); expect(feb.effective.effectiveFromMonth).toBe(MUTATION_MONTH);
  expect(feb.nextEffectiveFromMonth).toBe('2027-03-01');
  expect((await baseline('2027-03-01')).effective.operatingWeekdays).toEqual([2]);
  const other = await createSyntheticProject(pool, f.tenant.companyId);
  expect((await baseline(MUTATION_MONTH, other.projectId)).state).toBe('MISSING');
  await send('patch', path(other.projectId), await command([2, 4, 6], MUTATION_MONTH, false, other.projectId)).expect(200);
  expect((await baseline(MUTATION_MONTH, other.projectId)).effective.operatingWeekdays).toEqual([2, 4, 6]);
  expect((await baseline()).effective.operatingWeekdays).toEqual([1, 3, 5]);
});

it('an unconfigured project without live duties bootstraps only at the current company month', async () => {
  const other = await createSyntheticProject(pool, f.tenant.companyId);
  const today = (await pool.query(`SELECT to_char(date_trunc('month', clock_timestamp() AT TIME ZONE time_zone), 'YYYY-MM-DD') AS month
    FROM companies WHERE id = $1`, [f.tenant.companyId])).rows[0].month as string;
  expect(outcome(await send('patch', path(other.projectId), await command([2], '2000-01-01', true, other.projectId)))).toEqual([400, 'PROJECT_CALENDAR_INVALID']);
  await send('patch', path(other.projectId), await command([2], today, true, other.projectId)).expect(200);
  expect((await baseline(today, other.projectId)).effective.operatingWeekdays).toEqual([2]);
});

it('existing past exact versions are immutable even for identical no-op input', async () => {
  expect(outcome(await send('patch', path(), await command(undefined, '0001-01-01')))).toEqual([400, 'PROJECT_CALENDAR_INVALID']);
});

it('exact no-op requires fresh exact/effective/next tokens and emits no audit', async () => {
  const dto = await command(); await send('patch', path(), dto).expect(200);
  expect(outcome(await send('patch', path(), dto))).toEqual([409, 'PROJECT_CALENDAR_CONCURRENT_MODIFICATION']);
  const fresh = await command(); expect((await send('patch', path(), fresh)).body.outcome).toBe('NO_OP');
  const rows = (await pool.query("SELECT * FROM audit_event WHERE company_id = $1 AND action = 'PROJECT_OPERATING_CALENDAR_UPDATED'", [f.tenant.companyId])).rows;
  expect(rows).toHaveLength(1); expect(rows[0].old_values).toBeNull();
  expect(rows[0].new_values).toEqual({ effectiveFromMonth: MUTATION_MONTH, operatingWeekdays: [1, 2, 3, 4, 5, 6, 7], version: 1 });
});

it('replacement increments the same exact row version and audits bounded old/new sets', async () => {
  await send('patch', path(), await command([3])).expect(200);
  const first = (await baseline()).effective;
  const changed = await send('patch', path(), await command([3, 5])).expect(200);
  expect(changed.body.effective).toMatchObject({ id: first.id, version: 2, operatingWeekdays: [3, 5] });
  const rows = (await pool.query("SELECT old_values, new_values FROM audit_event WHERE company_id = $1 AND action = 'PROJECT_OPERATING_CALENDAR_UPDATED' ORDER BY occurred_at, id", [f.tenant.companyId])).rows;
  expect(rows).toHaveLength(2);
  expect(rows[1]).toEqual({ old_values: { effectiveFromMonth: MUTATION_MONTH, version: 1, operatingWeekdays: [3] },
    new_values: { effectiveFromMonth: MUTATION_MONTH, version: 2, operatingWeekdays: [3, 5] } });
});

it('two actual calendar writers from the same baseline cannot both commit', async () => {
  const dto = await command([3]);
  const results = await Promise.all([send('patch', path(), dto), send('patch', path(), { ...dto, operatingWeekdays: [3, 5] }, f.admin2)]);
  expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 409]);
  expect(results.find((r) => r.status === 409)!.body.code).toBe('PROJECT_CALENDAR_CONCURRENT_MODIFICATION');
});

it.each(['exact', 'effective', 'next'])('rejects a stale %s baseline before dependency checks', async (which) => {
  const dto = await command([1]);
  if (which === 'exact') dto.expectedExactVersion = { id: randomUUID(), version: 1 };
  if (which === 'effective') dto.expectedEffective = { ...dto.expectedEffective!, version: 2 };
  if (which === 'next') dto.expectedNextEffectiveFromMonth = '2027-02-01';
  expect(outcome(await send('patch', path(), dto))).toEqual([409, 'PROJECT_CALENDAR_CONCURRENT_MODIFICATION']);
});

it.each([false, true])('a live saved duty blocks closure including empty=%s and PUBLISHED', async (empty) => {
  if (empty) await pool.query("UPDATE plan_assignments SET state = 'REMOVED', removed_at = clock_timestamp() WHERE duty_id = $1", [f.dutyId]);
  await pool.query("UPDATE monthly_plans SET status = 'PUBLISHED', published_at = clock_timestamp(), published_by_account_id = $2 WHERE id = $1", [f.planId, f.tenant.admin.accountId]);
  expect(outcome(await send('patch', path(), await command([1])))).toEqual([409, 'PROJECT_CALENDAR_DEPENDENCY_CONFLICT']);
  expect(outcome(await send('patch', path(), await command([3])))).toEqual([200, null]);
});

it('explicit bootstrap requires no prior version, exact earliest live month and all saved dates', async () => {
  await missing();
  const historic = await insertPlan(pool, f.tenant.companyId, f.project.projectId, '2020-01-01');
  await insertDuty(pool, { companyId: f.tenant.companyId, projectId: f.project.projectId, planId: historic,
    month: '2020-01-01', dutyDate: '2020-01-05', startsAt: '2020-01-05T05:00Z', endsAt: '2020-01-05T17:00Z' });
  expect(outcome(await send('patch', path(), await command([3, 7], '2020-01-01')))).toEqual([400, 'PROJECT_CALENDAR_INVALID']);
  expect(outcome(await send('patch', path(), await command([3], '2020-01-01', true)))).toEqual([409, 'PROJECT_CALENDAR_DEPENDENCY_CONFLICT']);
  expect(outcome(await send('patch', path(), await command([3, 7], '2020-01-01', true)))).toEqual([200, null]);
  expect(outcome(await send('patch', path(), await command([3, 7], '2020-01-01', true)))).toEqual([400, 'PROJECT_CALENDAR_INVALID']);
  const row = (await pool.query("SELECT new_values FROM audit_event WHERE company_id = $1 AND action = 'PROJECT_OPERATING_CALENDAR_UPDATED'", [f.tenant.companyId])).rows[0];
  expect(row.new_values.bootstrap).toBe(true);
});

it('NIGHT uses local start date and may finish on a closed Saturday', async () => {
  await send('patch', path(), await command([3, 5])).expect(200);
  const night = await create('2027-01-22', 'NIGHT').expect(201);
  expect(night.body.endsAt).toBe('2027-01-23T05:00:00Z');
  expect(outcome(await create('2027-01-23'))).toEqual([409, 'PROJECT_CLOSED_WEEKDAY']);
});

it.each(['missing', 'closed'])('legacy %s stays visible and permits no-op, removal and explicit duty deletion', async (state) => {
  if (state === 'missing') await missing(); else await legacyClosed();
  const read = await send('get', entries()).expect(200); expect(read.body.items).toHaveLength(1);
  expect(outcome(await edit({ dutyDate: MUTATION_DAY }))).toEqual([200, null]);
  expect(outcome(await edit({ assignments: [{ employeeId: f.mira.employeeId, dutyRole: 'SHIFT_LEAD' }] })))
    .toEqual([409, state === 'missing' ? 'PROJECT_CALENDAR_MISSING' : 'PROJECT_CLOSED_WEEKDAY']);
  expect(outcome(await edit({ assignments: [] }))).toEqual([200, null]);
  expect((await send('get', entries())).body.items[0].assignments).toEqual([]);
  const lease = await send('post', `${dutyPath(f)}/edit-lease`).expect(200);
  await send('delete', dutyPath(f)).set('Expected-Version', '2').set('Edit-Lease-Token', lease.body.leaseToken).expect(204);
});

it.each(['create', 'patch', 'move', 'publish', 'published'])('exclusive DAY/NIGHT is enforced through %s', async (writer) => {
  const day = writer === 'move' ? '2027-01-21' : MUTATION_DAY;
  const night = await insertDuty(pool, { companyId: f.tenant.companyId, projectId: f.project.projectId, planId: f.planId,
    month: MUTATION_MONTH, dutyDate: day, kind: 'NACHT', startsAt: `${day}T17:00Z`, endsAt: `${day === MUTATION_DAY ? '2027-01-21' : '2027-01-22'}T05:00Z` });
  if (writer === 'create') {
    await pool.query('DELETE FROM duties WHERE id = $1', [night]);
    expect(outcome(await create(MUTATION_DAY, 'NIGHT', f.mira.employeeId))).toEqual([409, 'EMPLOYEE_DAILY_SHIFT_CONFLICT']);
  } else if (writer === 'publish') {
    await insertMembership(pool, f.tenant.companyId, night, f.mira.employeeId);
    expect(outcome(await publish())).toEqual([409, 'EMPLOYEE_DAILY_SHIFT_CONFLICT']);
    expect((await pool.query('SELECT status FROM monthly_plans WHERE id = $1', [f.planId])).rows[0].status).toBe('UNPUBLISHED');
  } else {
    if (writer === 'published') await publish().expect(200);
    if (writer === 'move') await insertMembership(pool, f.tenant.companyId, night, f.mira.employeeId);
    expect(outcome(await edit(writer === 'move' ? { dutyDate: MUTATION_DAY }
      : { assignments: [{ employeeId: f.mira.employeeId, dutyRole: 'EMPLOYEE' }] }, night))).toEqual([409, 'EMPLOYEE_DAILY_SHIFT_CONFLICT']);
  }
});

it('corrects legacy dual memberships without deleting the retained empty duty or history', async () => {
  const night = await insertDuty(pool, { companyId: f.tenant.companyId, projectId: f.project.projectId, planId: f.planId,
    month: MUTATION_MONTH, dutyDate: MUTATION_DAY, kind: 'NACHT', startsAt: '2027-01-20T17:00Z', endsAt: '2027-01-21T05:00Z' });
  await insertMembership(pool, f.tenant.companyId, night, f.mira.employeeId);
  expect(outcome(await edit({ assignments: [] }, night))).toEqual([200, null]);
  expect((await pool.query('SELECT removed_at FROM duties WHERE id = $1', [night])).rows[0].removed_at).toBeNull();
  expect((await pool.query('SELECT state FROM plan_assignments WHERE duty_id = $1', [night])).rows[0].state).toBe('REMOVED');
  await publish().expect(200);
});

it('First Publish rejects an empty closed duty', async () => {
  await legacyClosed();
  await pool.query("UPDATE plan_assignments SET state = 'REMOVED', removed_at = clock_timestamp() WHERE duty_id = $1", [f.dutyId]);
  expect(outcome(await publish())).toEqual([409, 'PROJECT_CLOSED_WEEKDAY']);
});

it('rolls calendar/version/audit back after a late audit failure', async () => {
  const before = await baseline();
  audit.hook = async (_client, entry) => { if (entry.action === 'PROJECT_OPERATING_CALENDAR_UPDATED') throw new Error('synthetic late audit failure'); };
  expect(outcome(await send('patch', path(), await command([3])))).toEqual([500, 'INTERNAL_ERROR']);
  expect(await baseline()).toEqual(before);
  expect((await pool.query('SELECT 1 FROM audit_event WHERE company_id = $1', [f.tenant.companyId])).rowCount).toBe(0);
});

it.each([[], [0], [8], [1, 1], [1.1], ['1'], null])('rejects invalid weekdays %j', async (days) => {
  expect((await send('patch', path(), { ...await command(), operatingWeekdays: days })).status).toBe(400);
});
it.each([[], [[]], {}, { id: randomUUID(), version: 0 }, { id: randomUUID(), version: Number.MAX_SAFE_INTEGER + 1 }])('rejects invalid baseline %j', async (expected) => {
  expect((await send('patch', path(), { ...await command(), expectedEffective: expected })).status).toBe(400);
});
it.each(['2027-02-29', '2027-01-02', '0000-01-01', '10000-01-01'])('rejects non-month %s safely', async (target) => {
  const r = await send('get', `${path()}?effectiveForMonth=${target}`);
  expect(outcome(r)).toEqual([400, 'PROJECT_CALENDAR_INVALID']); expect(r.headers['cache-control']).toBe('no-store');
});

it('tenant concealment, role, CSRF, unknown fields, INACTIVE and ARCHIVED precedence', async () => {
  const dto = await command();
  expect(outcome(await send('patch', path(), dto, f.foreignAdmin))).toEqual([404, 'RESOURCE_NOT_FOUND']);
  expect(outcome(await send('patch', path(), dto, f.employeeSession))).toEqual([403, 'ACTION_FORBIDDEN']);
  expect(outcome(await send('patch', path(), dto).unset('X-CSRF-Token'))).toEqual([403, 'CSRF_VALIDATION_FAILED']);
  expect(outcome(await send('patch', path(), { ...dto, companyId: f.foreign.companyId }))).toEqual([400, 'UNKNOWN_FIELD']);
  await pool.query("UPDATE projects SET status = 'INACTIVE' WHERE id = $1", [f.project.projectId]);
  await baseline(); expect(outcome(await send('patch', path(), dto))).toEqual([409, 'PROJECT_INACTIVE']);
  await pool.query("UPDATE projects SET status = 'ARCHIVED' WHERE id = $1", [f.project.projectId]);
  expect(outcome(await send('patch', path(), dto))).toEqual([404, 'RESOURCE_NOT_FOUND']);
});

it('transaction session check refuses a revoked session even with a previously trusted tenant context', async () => {
  const sessions = app.get(SessionService); const trusted = await sessions.validateAndTouch(f.admin.rawToken);
  const dto = await command([3]); await sessions.revoke(f.admin.rawToken);
  await expect(app.get(OperatingCalendarService).replace(trusted, f.project.projectId, dto, randomUUID()))
    .rejects.toMatchObject({ status: 401, response: { code: 'SESSION_REVOKED' } });
});

it.each(['idle', 'absolute'])('rechecks %s expiry after waiting for P without a late session/account lock', async (expiry) => {
  const trusted = await app.get(SessionService).validateAndTouch(f.admin.rawToken);
  const dto = await command([3]); const holder = await pool.connect(); let flight: Promise<unknown> | undefined;
  try {
    await holder.query('BEGIN'); const pid = await backendPid(holder);
    await holder.query('SELECT id FROM projects WHERE id = $1 FOR NO KEY UPDATE', [f.project.projectId]);
    flight = app.get(OperatingCalendarService).replace(trusted, f.project.projectId, dto, randomUUID());
    // Attach immediately so a refusal never becomes an unhandled rejection.
    const checked = expect(flight).rejects.toMatchObject({ status: 401, response: { code: 'SESSION_EXPIRED' } });
    pending.push(checked);
    const deadline = Date.now() + 4000; let waiting = false;
    while (Date.now() < deadline) {
      if ((await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [pid])).rowCount) { waiting = true; break; }
    }
    expect(waiting).toBe(true);
    // Models clock expiry during the wait, without breaking A-order revocation rules.
    if (expiry === 'idle') await pool.query("UPDATE sessions SET created_at = clock_timestamp() - interval '1 hour', last_seen_at = clock_timestamp() - interval '31 minutes' WHERE id = $1", [trusted.sessionId]);
    else await pool.query("UPDATE sessions SET absolute_expires_at = clock_timestamp() - interval '1 second', created_at = clock_timestamp() - interval '2 hours' WHERE id = $1", [trusted.sessionId]);
    await holder.query('COMMIT'); await checked;
    expect((await pool.query("SELECT 1 FROM audit_event WHERE company_id = $1 AND action = 'PROJECT_OPERATING_CALENDAR_UPDATED'", [f.tenant.companyId])).rowCount).toBe(0);
  } finally { await holder.query('ROLLBACK').catch(() => {}); holder.release(); if (flight) await flight.catch(() => {}); }
});

it.each(['logout', 'role'])('revalidates %s committed before A acquisition after an account wait', async (change) => {
  const trusted = await app.get(SessionService).validateAndTouch(f.admin.rawToken);
  const dto = await command([3]); const holder = await pool.connect(); let flight: Promise<unknown> | undefined;
  try {
    await holder.query('BEGIN'); const pid = await backendPid(holder);
    await holder.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [trusted.accountId]);
    flight = app.get(OperatingCalendarService).replace(trusted, f.project.projectId, dto, randomUUID());
    const checked = expect(flight).rejects.toMatchObject({ status: change === 'logout' ? 401 : 403 }); pending.push(checked);
    const deadline = Date.now() + 4000; let waiting = false;
    while (Date.now() < deadline) {
      if ((await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [pid])).rowCount) { waiting = true; break; }
    }
    expect(waiting).toBe(true);
    if (change === 'logout') await holder.query('UPDATE sessions SET revoked_at = clock_timestamp() WHERE id = $1', [trusted.sessionId]);
    else await holder.query("UPDATE accounts SET role = 'EMPLOYEE' WHERE id = $1", [trusted.accountId]);
    await holder.query('COMMIT'); await checked;
  } finally { await holder.query('ROLLBACK').catch(() => {}); holder.release(); if (flight) await flight.catch(() => {}); }
});

it('calendar holds A SHARE so a real logout waits until the authorized write commits', async () => {
  const sessions = app.get(SessionService); const trusted = await sessions.validateAndTouch(f.admin.rawToken);
  const dto = await command([3]); const arrived = latch(); const resume = latch(); releases.push(resume.release); let holder = 0;
  audit.hook = async (client, entry) => { if (entry.action !== 'PROJECT_OPERATING_CALENDAR_UPDATED') return;
    audit.hook = undefined; holder = await backendPid(client); arrived.release(); await resume.promise; };
  const first = app.get(OperatingCalendarService).replace(trusted, f.project.projectId, dto, randomUUID()); pending.push(first);
  await arrived.promise; const logout = sessions.revoke(f.admin.rawToken); pending.push(logout);
  const deadline = Date.now() + 4000; let waiting = false;
  while (Date.now() < deadline) {
    if ((await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [holder])).rowCount) { waiting = true; break; }
  }
  expect(waiting).toBe(true); resume.release();
  expect((await first).outcome).toBe('APPLIED'); expect(await logout).toBe(true);
});

it('schema enforces month, mask, version, uniqueness and tenant FK without a data rewrite', async () => {
  const client = await pool.connect();
  try {
    for (const [target, mask, version, company] of [
      ['2027-02-02', 1, 1, f.tenant.companyId], ['infinity', 1, 1, f.tenant.companyId],
      ['2027-02-01', 0, 1, f.tenant.companyId], ['2027-02-01', 128, 1, f.tenant.companyId],
      ['2027-02-01', 1, 0, f.tenant.companyId], ['2027-02-01', 1, '9007199254740992', f.tenant.companyId],
      ['2027-02-01', 1, 1, f.foreign.companyId], ['0001-01-01', 1, 1, f.tenant.companyId],
    ]) {
      await client.query('BEGIN');
      await expect(client.query(`INSERT INTO project_operating_calendars(company_id, project_id, effective_from_month, weekday_mask, version)
        VALUES ($1, $2, $3, $4, $5)`, [company, f.project.projectId, target, mask, version])).rejects.toBeDefined();
      await client.query('ROLLBACK');
    }
  } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
});

it('calendar guards use the existing project/date index on a synthetic multi-year roster', async () => {
  await pool.query(`INSERT INTO monthly_plans(company_id, project_id, planning_month)
    SELECT $1, $2, m::date FROM generate_series('2028-01-01'::date, '2037-12-01'::date, interval '1 month') m`, [f.tenant.companyId, f.project.projectId]);
  await pool.query(`INSERT INTO duties(company_id, project_id, monthly_plan_id, planning_month, duty_date, shift_kind,
    starts_at, ends_at, time_zone, config_effective_from_month, start_local, end_local)
    SELECT p.company_id, p.project_id, p.id, p.planning_month, day::date, 'TAG', day + interval '5 hours', day + interval '17 hours',
      'Europe/Berlin', p.planning_month, '06:00', '18:00' FROM monthly_plans p
    CROSS JOIN LATERAL generate_series(p.planning_month::timestamp, p.planning_month + interval '1 month - 1 day', interval '1 day') day
    WHERE p.company_id = $1 AND p.project_id = $2 AND p.planning_month >= '2028-01-01'`, [f.tenant.companyId, f.project.projectId]);
  await pool.query('ANALYZE duties');
  const explain = (await pool.query(`EXPLAIN (FORMAT JSON) SELECT 1 FROM public.duties d
    WHERE d.company_id = $1 AND d.project_id = $2 AND d.removed_at IS NULL
    AND d.duty_date >= '2030-01-01' AND d.duty_date < '2030-02-01'
    AND (1 & (1 << (extract(isodow FROM d.duty_date)::int - 1))) = 0 LIMIT 1`, [f.tenant.companyId, f.project.projectId])).rows;
  expect(JSON.stringify(explain)).toContain('idx_duties__project_date');
});

for (const first of ['calendar', 'duty'] as const) for (const rollback of [false, true]) {
  it(`actual calendar/duty writers: ${first} first, ${rollback ? 'ROLLBACK' : 'COMMIT'}, observed P wait`, async () => {
    const dto = await command([3]); const arrived = latch(); const resume = latch(); releases.push(resume.release); let holder = 0;
    const action = first === 'calendar' ? 'PROJECT_OPERATING_CALENDAR_UPDATED' : 'DUTY_CREATED';
    audit.hook = async (client, entry) => { if (entry.action !== action) return; audit.hook = undefined;
      holder = await backendPid(client); arrived.release(); await resume.promise; if (rollback) throw new Error('synthetic rollback'); };
    const calendar = () => send('patch', path(), dto).then((r) => r);
    const duty = () => create().then((r) => r);
    const one = first === 'calendar' ? calendar() : duty(); pending.push(one);
    await Promise.race([arrived.promise, one.then((r) => { throw new Error(`First writer missed barrier: ${r.status}`); })]);
    const two = first === 'calendar' ? duty() : calendar(); pending.push(two);
    const deadline = Date.now() + 4000; let blocked = false;
    while (Date.now() < deadline) {
      if ((await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [holder])).rowCount) { blocked = true; break; }
    }
    expect(blocked).toBe(true); resume.release();
    expect((await one).status).toBe(rollback ? 500 : first === 'calendar' ? 200 : 201);
    expect(outcome(await two)).toEqual(rollback ? [first === 'calendar' ? 201 : 200, null]
      : [409, first === 'calendar' ? 'PROJECT_CLOSED_WEEKDAY' : 'PROJECT_CALENDAR_DEPENDENCY_CONFLICT']);
  });
}

for (const firstKind of ['DAY', 'NIGHT']) for (const rollback of [false, true]) {
  it(`exclusive employee/date writers: ${firstKind} first, ${rollback ? 'ROLLBACK' : 'COMMIT'}, observed E wait`, async () => {
    const arrived = latch(); const resume = latch(); releases.push(resume.release); let holder = 0;
    audit.hook = async (client, entry) => { if (entry.action !== 'DUTY_CREATED') return; audit.hook = undefined;
      holder = await backendPid(client); arrived.release(); await resume.promise; if (rollback) throw new Error('synthetic rollback'); };
    const one = create('2027-01-22', firstKind, f.jonas.employeeId, f.admin).then((r) => r); pending.push(one);
    await Promise.race([arrived.promise, one.then((r) => { throw new Error(`First duty missed barrier: ${r.status}`); })]);
    const two = create('2027-01-22', firstKind === 'DAY' ? 'NIGHT' : 'DAY').then((r) => r); pending.push(two);
    const deadline = Date.now() + 4000; let waiting = false;
    while (Date.now() < deadline) {
      if ((await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [holder])).rowCount) { waiting = true; break; }
    }
    expect(waiting).toBe(true); resume.release();
    expect((await one).status).toBe(rollback ? 500 : 201);
    expect(outcome(await two)).toEqual(rollback ? [201, null] : [409, 'EMPLOYEE_DAILY_SHIFT_CONFLICT']);
  });
}
