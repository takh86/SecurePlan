/** Real HTTP, AppModule, guards, SQL and transactional audit; synthetic tenants only. */
import { createHash, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types.js';
import { DatabaseService } from '../src/database/database.service.js';
import { BusinessAuditService, type BusinessAuditEntry } from '../src/modules/audit/business-audit.service.js';
import { MonthlyPlansService } from '../src/modules/planning/monthly-plans.service.js';
import { ORIGIN, RecordingDelivery, bootEmployeesApp } from './helpers/employees-test-app.js';
import { createSyntheticProject, openLocalTestPool, removeSyntheticTenants, type SyntheticSession, type TestPool } from './helpers/synthetic-tenants.js';
import { adminContext, insertDuty, insertMembership, insertPlan, planningState } from './helpers/planning-fixtures.js';
import { dutyMutationFixture, dutyPath, MUTATION_DAY, MUTATION_MONTH, MUTATION_NOW, type DutyMutationFixture } from './helpers/duty-mutation-fixtures.js';

let pool: TestPool;
let app: INestApplication<App> | undefined;
let f: DutyMutationFixture;
let previousOrigin: string | undefined;
const companies: string[] = [];
const hash = (key: string) => createHash('sha256').update(key).digest();
const path = (id = f.planId) => `/api/v1/monthly-plans/${id}/publish`;
const result = (r: Response) => [r.status, r.body.code ?? null];

async function boot(options: Parameters<typeof bootEmployeesApp>[1] = {}) {
  await app?.close();
  app = await bootEmployeesApp(new RecordingDelivery(), { clock: () => new Date(MUTATION_NOW), ...options });
}
function publish(key: string | string[] | undefined = randomUUID(), session: SyntheticSession = f.admin, planId = f.planId, body?: object) {
  const op = request(app!.getHttpServer()).post(path(planId)).set('Origin', ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf);
  if (key !== undefined) op.set({ 'Idempotency-Key': key });
  if (body !== undefined) op.send(body);
  return op;
}
async function records() {
  return (await pool.query('SELECT action, resource_type, resource_id, actor_account_id, company_id, old_values, new_values, correlation_id FROM audit_event WHERE company_id = $1 ORDER BY occurred_at, id', [f.tenant.companyId])).rows;
}
async function publishedRow() {
  return (await pool.query('SELECT status, published_at, published_by_account_id FROM monthly_plans WHERE id = $1', [f.planId])).rows[0];
}
beforeAll(() => { pool = openLocalTestPool(6); previousOrigin = process.env.APP_ORIGIN; process.env.APP_ORIGIN = ORIGIN; });
beforeEach(async () => { f = await dutyMutationFixture(pool, companies); await boot(); });
afterEach(async () => { await app?.close(); app = undefined; });
afterAll(async () => {
  try { await removeSyntheticTenants(pool, companies); } finally { await pool.end(); }
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previousOrigin;
});

it('publishes once with persisted time/actor and one bounded atomic audit; no duty/version/snapshot mutation', async () => {
  const before = await planningState(pool, f.tenant.companyId);
  const response = await publish();
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ id: f.planId, projectId: f.project.projectId, monthStart: MUTATION_MONTH, status: 'PUBLISHED', publishedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/) });
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['idempotency-replayed']).toBe('false');
  expect(await publishedRow()).toEqual({ status: 'PUBLISHED', published_at: new Date(response.body.publishedAt), published_by_account_id: f.tenant.admin.accountId });
  expect(await records()).toEqual([{
    action: 'MONTHLY_PLAN_PUBLISHED', resource_type: 'MONTHLY_PLAN', resource_id: f.planId,
    actor_account_id: f.tenant.admin.accountId, company_id: f.tenant.companyId,
    old_values: { status: 'UNPUBLISHED', publishedAt: null }, new_values: { status: 'PUBLISHED', publishedAt: response.body.publishedAt },
    correlation_id: response.headers['x-correlation-id'],
  }]);
  const after = await planningState(pool, f.tenant.companyId);
  expect(after.duties).toEqual(before.duties); expect(after.members).toEqual(before.members);
  expect(after.leases).toEqual(before.leases);
  expect(result(await publish())).toEqual([409, 'MONTHLY_PLAN_ALREADY_PUBLISHED']);
  expect(await records()).toHaveLength(1);
});

it('lost-response same-key retry and canonical UUID replay preserve result and fresh correlation ID', async () => {
  const key = randomUUID(); const first = await publish(key);
  const retry = await publish(key, f.admin, f.planId.toUpperCase());
  expect(first.status).toBe(200); expect(retry.status).toBe(200); expect(retry.body).toEqual(first.body);
  expect(retry.headers['idempotency-replayed']).toBe('true');
  expect(retry.headers['x-correlation-id']).not.toBe(first.headers['x-correlation-id']);
  expect(await records()).toHaveLength(1);
  const saved = (await pool.query('SELECT key_hash, request_hash, state, result_plan_id FROM idempotency_records WHERE company_id = $1', [f.tenant.companyId])).rows;
  expect(saved).toEqual([{ key_hash: hash(key), request_hash: expect.any(Buffer), state: 'COMPLETED', result_plan_id: f.planId }]);
  expect(saved[0].request_hash.length).toBe(32); expect(JSON.stringify(saved)).not.toContain(key);
});

it('completed retry bypasses current eligibility/ACTIVE checks but retains authentication and concealment', async () => {
  const key = randomUUID(); const first = await publish(key); expect(first.status).toBe(200);
  await pool.query("UPDATE projects SET status = 'INACTIVE' WHERE id = $1", [f.project.projectId]);
  await pool.query("UPDATE employees SET shift_eligibility = 'NACHT' WHERE id = $1", [f.mira.employeeId]);
  const retry = await publish(key); expect(retry.status).toBe(200); expect(retry.body).toEqual(first.body);
  await pool.query("UPDATE projects SET status = 'ARCHIVED' WHERE id = $1", [f.project.projectId]);
  expect(result(await publish(key))).toEqual([404, 'RESOURCE_NOT_FOUND']);
  expect(await records()).toHaveLength(1);
});

it('same actor/operation/key with a different plan conflicts, with no cross-plan mutation', async () => {
  const key = randomUUID(); expect((await publish(key)).status).toBe(200);
  const other = await insertPlan(pool, f.tenant.companyId, f.project.projectId, '2027-02-01');
  expect(result(await publish(key, f.admin, other))).toEqual([409, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST']);
  expect((await pool.query('SELECT status FROM monthly_plans WHERE id = $1', [other])).rows[0].status).toBe('UNPUBLISHED');
});

it('same raw key is independent for another actor and another tenant', async () => {
  const key = randomUUID(); expect((await publish(key)).status).toBe(200);
  const other = await insertPlan(pool, f.tenant.companyId, f.project.projectId, '2027-02-01');
  expect((await publish(key, f.admin2, other)).status).toBe(200);
  const foreignProject = await createSyntheticProject(pool, f.foreign.companyId);
  const foreignPlan = await insertPlan(pool, f.foreign.companyId, foreignProject.projectId, MUTATION_MONTH);
  await pool.query(`INSERT INTO project_operating_calendars (company_id, project_id, effective_from_month, weekday_mask)
    VALUES ($1, $2, $3, 127)`, [f.foreign.companyId, foreignProject.projectId, MUTATION_MONTH]);
  expect((await publish(key, f.foreignAdmin, foreignPlan)).status).toBe(200);
});

it.each(['empty plan', 'unstaffed duty', 'removed history', 'past plan'])('allows %s without invented staffing/calendar rules', async (scenario) => {
  if (scenario !== 'past plan') await pool.query("UPDATE plan_assignments SET state = 'REMOVED', removed_at = clock_timestamp() WHERE duty_id = $1", [f.dutyId]);
  if (scenario === 'empty plan' || scenario === 'removed history') await pool.query('UPDATE duties SET removed_at = clock_timestamp() WHERE id = $1', [f.dutyId]);
  if (scenario === 'removed history') await pool.query("UPDATE employees SET status = 'DEACTIVATED' WHERE id = $1", [f.mira.employeeId]);
  if (scenario === 'past plan') await boot({ clock: () => new Date('2030-01-01T00:00:00Z') });
  expect((await publish()).status).toBe(200);
});

it('adjacent UTC duties on the same local project date reject dual DAY/NIGHT under P1', async () => {
  const night = await insertDuty(pool, { companyId: f.tenant.companyId, projectId: f.project.projectId, planId: f.planId,
    month: MUTATION_MONTH, dutyDate: MUTATION_DAY, kind: 'NACHT', startsAt: `${MUTATION_DAY}T17:00:00Z`, endsAt: '2027-01-21T05:00:00Z' });
  await insertMembership(pool, f.tenant.companyId, night, f.mira.employeeId);
  expect(result(await publish())).toEqual([409, 'EMPLOYEE_DAILY_SHIFT_CONFLICT']);
});

const invalid: [string, (fixture: DutyMutationFixture) => Promise<unknown>][] = [
  ['PROJECT_INACTIVE', (x) => pool.query("UPDATE projects SET status = 'INACTIVE' WHERE id = $1", [x.project.projectId])],
  ['SHIFT_CONFIGURATION_MISSING', (x) => pool.query('DELETE FROM shift_configurations WHERE project_id = $1', [x.project.projectId])],
  ['EMPLOYEE_INACTIVE', (x) => pool.query("UPDATE employees SET status = 'DEACTIVATED' WHERE id = $1", [x.mira.employeeId])],
  ['EMPLOYEE_NOT_EMPLOYED_FOR_DAY', (x) => pool.query('UPDATE employees SET employment_start = NULL WHERE id = $1', [x.mira.employeeId])],
  ['EMPLOYEE_NOT_EMPLOYED_FOR_DAY', (x) => pool.query("UPDATE employees SET employment_end = '2027-01-19' WHERE id = $1", [x.mira.employeeId])],
  ['EMPLOYEE_NOT_ASSIGNED_TO_PROJECT_MONTH', (x) => pool.query('DELETE FROM project_assignments WHERE id = $1', [x.assignment])],
  ['EMPLOYEE_NOT_ELIGIBLE_FOR_SHIFT', (x) => pool.query("UPDATE employees SET shift_eligibility = 'NACHT' WHERE id = $1", [x.mira.employeeId])],
  ...(['SICK', 'LEAVE'] as const).map((status): [string, (x: DutyMutationFixture) => Promise<unknown>] => ['EMPLOYEE_UNAVAILABLE',
    (x) => pool.query('INSERT INTO employee_availability_days (company_id, employee_id, day, status) VALUES ($1, $2, $3, $4)', [x.tenant.companyId, x.mira.employeeId, MUTATION_DAY, status])]),
  ['DUTY_ASSIGNMENT_CONFLICT', async (x) => {
    const id = await insertDuty(pool, { companyId: x.tenant.companyId, projectId: x.project.projectId, planId: x.planId,
      // A different local date isolates UTC overlap from same-date exclusivity.
      month: MUTATION_MONTH, dutyDate: '2027-01-19', kind: 'NACHT', startsAt: '2027-01-19T17:00:00Z', endsAt: '2027-01-20T06:00:00Z' });
    await insertMembership(pool, x.tenant.companyId, id, x.mira.employeeId);
  }],
];
it.each(invalid)('full revalidation rejects %s and preserves business/audit state', async (code, change) => {
  await change(f); const before = await planningState(pool, f.tenant.companyId);
  expect(result(await publish())).toEqual([409, code]);
  expect(await planningState(pool, f.tenant.companyId)).toEqual(before);
  expect(await publishedRow()).toEqual({ status: 'UNPUBLISHED', published_at: null, published_by_account_id: null });
});

it('structural errors and lifecycle conflicts have stable precedence', async () => {
  expect(result(await publish('short'))).toEqual([400, 'IDEMPOTENCY_KEY_INVALID']);
  expect(result(await publish(['valid-key-1', 'valid-key-2']))).toEqual([400, 'IDEMPOTENCY_KEY_INVALID']);
  expect(result(await publish(randomUUID(), f.admin, f.planId, { companyId: f.foreign.companyId }))).toEqual([400, 'INVALID_REQUEST_BODY']);
  expect((await publish()).status).toBe(200);
  await pool.query("UPDATE projects SET status = 'INACTIVE' WHERE id = $1", [f.project.projectId]);
  expect(result(await publish())).toEqual([409, 'MONTHLY_PLAN_ALREADY_PUBLISHED']);
});

it('missing key, malformed plan UUID and nonempty body fail before a business write', async () => {
  const noKey = await request(app!.getHttpServer()).post(path()).set('Origin', ORIGIN).set('Cookie', f.admin.cookie).set('X-CSRF-Token', f.admin.csrf);
  expect(result(noKey)).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
  expect(result(await publish(randomUUID(), f.admin, 'invalid-id'))).toEqual([404, 'RESOURCE_NOT_FOUND']);
  expect(result(await publish(randomUUID(), f.admin, f.planId, {}))).toEqual([400, 'INVALID_REQUEST_BODY']);
  expect(await records()).toHaveLength(0);
});

it('tenant concealment returns the same neutral 404 for foreign and absent IDs', async () => {
  const foreign = await publish(randomUUID(), f.foreignAdmin);
  const absent = await publish(randomUUID(), f.foreignAdmin, randomUUID());
  expect(result(foreign)).toEqual([404, 'RESOURCE_NOT_FOUND']); expect(result(absent)).toEqual(result(foreign));
  expect(foreign.body.detail).toBe(absent.body.detail);
  expect((await pool.query('SELECT 1 FROM idempotency_records WHERE company_id = ANY($1::uuid[])', [[f.tenant.companyId, f.foreign.companyId]])).rowCount).toBe(0);
  expect(await records()).toHaveLength(0);
});

it('permission/session/CSRF/Origin controls reject before reservation or plan disclosure', async () => {
  expect(result(await publish(randomUUID(), f.employeeSession))).toEqual([403, 'ACTION_FORBIDDEN']);
  const anonymous = await request(app!.getHttpServer()).post(path()).set('Origin', ORIGIN);
  expect(anonymous.status).toBe(401);
  const csrf = await request(app!.getHttpServer()).post(path()).set('Origin', ORIGIN).set('Cookie', f.admin.cookie).set('Idempotency-Key', randomUUID());
  expect(result(csrf)).toEqual([403, 'CSRF_VALIDATION_FAILED']);
  const origin = await request(app!.getHttpServer()).post(path()).set('Origin', 'https://foreign.invalid').set('Cookie', f.admin.cookie).set('X-CSRF-Token', f.admin.csrf);
  expect(origin.status).toBe(403);
  await pool.query("UPDATE accounts SET role = 'EMPLOYEE' WHERE id = $1", [f.tenant.admin.accountId]);
  expect(result(await publish())).toEqual([403, 'ACTION_FORBIDDEN']);
  expect((await pool.query('SELECT 1 FROM idempotency_records WHERE company_id = $1', [f.tenant.companyId])).rowCount).toBe(0);
  expect(await records()).toHaveLength(0);
});

it('a revoked session cannot replay a previously completed key', async () => {
  const key = randomUUID(); expect((await publish(key)).status).toBe(200);
  await pool.query('UPDATE sessions SET revoked_at = clock_timestamp() WHERE account_id = $1', [f.tenant.admin.accountId]);
  expect((await publish(key)).status).toBe(401); expect(await records()).toHaveLength(1);
});

it('transactional actor recheck rejects a stale trusted context before any claim', async () => {
  await pool.query("UPDATE accounts SET role = 'EMPLOYEE' WHERE id = $1", [f.tenant.admin.accountId]);
  await expect(app!.get(MonthlyPlansService).publish(adminContext(f.tenant.admin), f.planId, randomUUID(), randomUUID())).rejects.toMatchObject({ status: 403 });
  expect((await pool.query('SELECT 1 FROM idempotency_records WHERE company_id = $1', [f.tenant.companyId])).rowCount).toBe(0);
});

class AuditFailure extends BusinessAuditService {
  override async recordBusinessAction(client: PoolClient, entry: BusinessAuditEntry) {
    await super.recordBusinessAction(client, entry);
    if (entry.action === 'MONTHLY_PLAN_PUBLISHED') await client.query('SELECT 1/0');
  }
}
it('failure after the mandatory audit INSERT rolls back metadata and audit; the same key can safely recover', async () => {
  await boot({ audit: new AuditFailure() }); const before = await planningState(pool, f.tenant.companyId); const key = randomUUID();
  expect(result(await publish(key))).toEqual([500, 'INTERNAL_ERROR']);
  expect(await planningState(pool, f.tenant.companyId)).toEqual(before);
  expect((await pool.query('SELECT state FROM idempotency_records WHERE company_id = $1', [f.tenant.companyId])).rows[0].state).toBe('FAILED');
  await boot(); expect((await publish(key)).status).toBe(200); expect(await records()).toHaveLength(1);
});

class CompletionFailure extends DatabaseService {
  loseAcknowledgement = false;
  override async withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    let completed = false;
    const value = await super.withTransaction((client) => work(new Proxy(client, {
      get: (target, property) => {
        if (property === 'query') return async (sql: string, params?: unknown[]) => {
          if (sql.includes("SET state = 'COMPLETED', result_plan_id")) {
            completed = true;
            if (!this.loseAcknowledgement) await target.query('SELECT 1/0');
          }
          return target.query(sql, params);
        };
        const member: unknown = Reflect.get(target, property); return typeof member === 'function' ? member.bind(target) : member;
      },
    })));
    if (completed && this.loseAcknowledgement) { this.loseAcknowledgement = false; throw new Error('Synthetic lost COMMIT acknowledgement'); }
    return value;
  }
}
it('idempotency completion SQL failure rolls back the already inserted publication audit and metadata', async () => {
  await boot({ database: new CompletionFailure() }); const before = await planningState(pool, f.tenant.companyId);
  expect(result(await publish())).toEqual([500, 'INTERNAL_ERROR']);
  expect(await planningState(pool, f.tenant.companyId)).toEqual(before);
});
it('lost COMMIT acknowledgement never overwrites COMPLETED; same-key HTTP retry replays exactly one publication', async () => {
  const database = new CompletionFailure(); database.loseAcknowledgement = true; await boot({ database });
  const key = randomUUID(); expect(result(await publish(key))).toEqual([500, 'INTERNAL_ERROR']);
  const retry = await publish(key); expect(retry.status).toBe(200); expect(retry.headers['idempotency-replayed']).toBe('true');
  expect(await records()).toHaveLength(1);
});

it.each([false, true])('recent/stale abandoned IN_PROGRESS claim (stale=%s) is refused/recovered safely', async (stale) => {
  const key = randomUUID();
  await pool.query(`INSERT INTO idempotency_records (company_id, actor_account_id, operation, key_hash, request_hash, claimed_at, expires_at)
    VALUES ($1, $2, 'INITIAL_PUBLISH', $3, $4, clock_timestamp() - $5::int * INTERVAL '1 second', clock_timestamp() + INTERVAL '24 hours')`,
  [f.tenant.companyId, f.tenant.admin.accountId, hash(key), hash(JSON.stringify(['initial-publish-v1', f.planId])), stale ? 301 : 0]);
  const response = await publish(key);
  expect(result(response)).toEqual(stale ? [200, null] : [409, 'IDEMPOTENCY_REQUEST_IN_PROGRESS']);
  if (!stale) expect(response.headers['retry-after']).toBe('1');
  expect(await records()).toHaveLength(stale ? 1 : 0);
});

it('expired terminal replay retention cannot allow a second publication', async () => {
  const key = randomUUID(); expect((await publish(key)).status).toBe(200);
  await pool.query(`UPDATE idempotency_records SET created_at = clock_timestamp() - INTERVAL '2 days', claimed_at = clock_timestamp() - INTERVAL '2 days',
    completed_at = clock_timestamp() - INTERVAL '2 days', expires_at = clock_timestamp() - INTERVAL '1 day' WHERE company_id = $1`, [f.tenant.companyId]);
  expect(result(await publish(key))).toEqual([409, 'MONTHLY_PLAN_ALREADY_PUBLISHED']); expect(await records()).toHaveLength(1);
});

it('CR-03 permits a leased, versioned direct duty mutation after real first publication', async () => {
  expect((await publish()).status).toBe(200);
  const lease = await request(app!.getHttpServer()).post(`${dutyPath(f)}/edit-lease`).set('Origin', ORIGIN).set('Cookie', f.admin.cookie).set('X-CSRF-Token', f.admin.csrf);
  expect(lease.status).toBe(200);
  const edit = await request(app!.getHttpServer()).patch(dutyPath(f)).set('Origin', ORIGIN).set('Cookie', f.admin.cookie).set('X-CSRF-Token', f.admin.csrf)
    .set('Expected-Version', '1').set('Edit-Lease-Token', lease.body.leaseToken).send({ assignments: [{ employeeId: f.mira.employeeId, dutyRole: 'SHIFT_LEAD' }] });
  expect(edit.status).toBe(200); expect(edit.body.version).toBe(2); expect(edit.body.assignments[0].dutyRole).toBe('SHIFT_LEAD');
  expect((await publishedRow()).status).toBe('PUBLISHED');
  const actions = (await records()).map((row) => row.action);
  expect(actions).toHaveLength(3);
  expect(actions).toEqual(expect.arrayContaining(['MONTHLY_PLAN_PUBLISHED', 'DUTY_UPDATED', 'DUTY_MEMBERSHIP_UPDATED']));
});
