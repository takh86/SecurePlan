/** Case 2: real HTTP/guards/SQL/audit. Run only on explicitly disposable synthetic PostgreSQL. */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { vi } from 'vitest';
import { DatabaseService } from '../src/database/database.service.js';
import { BusinessAuditService } from '../src/modules/audit/business-audit.service.js';
import { AccountLifecycleService } from '../src/modules/identity/account-lifecycle.service.js';
import {
  createSyntheticAccount, createSyntheticEmployee, createSyntheticProject, createSyntheticSession, createSyntheticTenant,
  openLocalTestPool, realSessionService, removeSyntheticTenants,
  type SyntheticEmployee, type SyntheticProject, type SyntheticSession, type SyntheticTenant, type TestPool,
} from './helpers/synthetic-tenants.js';
import { ORIGIN, RecordingDelivery, bootEmployeesApp } from './helpers/employees-test-app.js';

const CODE = 'EMPLOYMENT_PERIOD_EXCLUDES_FUTURE_PROJECT_ASSIGNMENTS';
let pool: TestPool;
let app: INestApplication<App>;
let tenant: SyntheticTenant;
let foreign: SyntheticTenant;
let employee: SyntheticEmployee;
let project: SyntheticProject;
let admin: SyntheticSession;
let instant: string;
let previousOrigin: string | undefined;
const companies: string[] = [];
const clock = vi.fn(() => new Date(instant));
const path = (id = employee.employeeId) => `/api/v1/employees/${id}`;
const patch = (body: object, id = employee.employeeId, session = admin) => request(app.getHttpServer()).patch(path(id))
  .set('Cookie', session.cookie).set('Origin', ORIGIN).set('X-CSRF-Token', session.csrf).send(body);

async function seed(month: string, person = employee, target = project) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO project_assignments (company_id, employee_id, project_id, planning_month)
     VALUES ($1, $2, $3, $4::date) RETURNING id`, [person.account.companyId, person.employeeId, target.projectId, month],
  )).rows[0].id;
}
async function setPeriod(start: string | null, end: string | null) {
  await pool.query('UPDATE employees SET employment_start = $2::date, employment_end = $3::date WHERE id = $1', [employee.employeeId, start, end]);
}
async function state() {
  const result: Record<string, unknown> = {};
  for (const table of ['employees', 'accounts', 'projects', 'project_assignments', 'audit_event']) {
    result[table] = (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} AS t WHERE company_id = ANY($1::uuid[]) ORDER BY id`, [companies])).rows;
  }
  return result;
}
async function events(correlationId: string) {
  return (await pool.query('SELECT company_id, actor_account_id, action, resource_type, resource_id, old_values, new_values, correlation_id FROM audit_event WHERE correlation_id = $1', [correlationId])).rows;
}
function assertConflict(response: request.Response, count: number) {
  expect(response.status).toBe(409); expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['content-type']).toContain('application/problem+json');
  expect(Object.keys(response.body).sort()).toEqual(['type', 'title', 'status', 'detail', 'instance', 'code', 'correlationId', 'conflictCount', 'conflictingAssignments'].sort());
  expect(response.body).toMatchObject({ type: '/problems/employment-period-excludes-future-project-assignments',
    title: 'Conflict', status: 409, code: CODE, conflictCount: count,
    detail: 'The changed employment period would no longer cover existing future monthly project assignments. Review and correct or remove the conflicting assignments first.',
    correlationId: response.headers['x-correlation-id'], instance: `/problems/occurrences/${response.headers['x-correlation-id']}` });
  expect(response.body.conflictingAssignments).toHaveLength(Math.min(count, 25));
}

beforeAll(() => { pool = openLocalTestPool(10); previousOrigin = process.env.APP_ORIGIN; process.env.APP_ORIGIN = ORIGIN; });
beforeEach(async () => {
  instant = '2026-12-15T12:00:00.000Z'; clock.mockClear();
  tenant = await createSyntheticTenant(pool, 'I64 C2 A'); foreign = await createSyntheticTenant(pool, 'I64 C2 B');
  companies.push(tenant.companyId, foreign.companyId);
  employee = await createSyntheticEmployee(pool, tenant.employee, 'C2-001', { start: '2026-01-01' });
  project = await createSyntheticProject(pool, tenant.companyId, 'C2 Synthetic');
  admin = await createSyntheticSession(realSessionService(pool), tenant.admin);
  app = await bootEmployeesApp(new RecordingDelivery(), { clock });
});
afterEach(async () => { vi.restoreAllMocks(); await app?.close(); await removeSyntheticTenants(pool, companies.splice(0)); });
afterAll(async () => { await pool?.end(); if (previousOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previousOrigin; });

type Case = { id: string; start?: string | null; end?: string | null; months?: string[]; body: Record<string, unknown>; count?: number; historical?: number; status?: number };
const cases: Case[] = [
  { id: 'B01 start forward', months: ['2027-03-01'], body: { employmentStart: '2027-04-01' }, count: 1 },
  { id: 'B02 inclusive last day', months: ['2027-03-01'], body: { employmentStart: '2027-03-31' } },
  { id: 'B03 end backward', months: ['2027-03-01'], body: { employmentEnd: '2027-02-28' }, count: 1 },
  { id: 'B04 inclusive first day', months: ['2027-03-01'], body: { employmentEnd: '2027-03-01' } },
  { id: 'B05 both bounds', months: ['2027-05-01', '2027-06-01', '2027-08-01', '2027-09-01'], body: { employmentStart: '2027-06-01', employmentEnd: '2027-08-31' }, count: 2 },
  { id: 'B06 no intermediate-state validation', end: '2027-01-31', months: ['2027-03-01'], body: { employmentStart: '2027-02-01', employmentEnd: '2027-06-30' } },
  { id: 'B07 order before conflicts', months: ['2027-03-01'], body: { employmentStart: '2027-04-01', employmentEnd: '2027-02-28' }, status: 400 },
  { id: 'B08 clear start evidence', months: ['2027-03-01'], body: { employmentStart: null }, count: 1 },
  { id: 'B09 clear end expands', end: '2027-01-31', months: ['2027-03-01'], body: { employmentEnd: null } },
  { id: 'B10 missing start remains invalid', start: null, months: ['2027-03-01'], body: { employmentEnd: '2027-02-28' } },
  { id: 'B11 legacy remains invalid', end: '2027-01-31', months: ['2027-03-01'], body: { employmentEnd: '2027-02-28' } },
  { id: 'B12 only newly invalid', end: '2027-03-31', months: ['2027-03-01', '2027-05-01'], body: { employmentEnd: '2027-02-28' }, count: 1 },
  { id: 'B13 fix evidence', start: null, months: ['2027-03-01'], body: { employmentStart: '2026-01-01' } },
  { id: 'B17 atomic mixed', months: ['2027-03-01'], body: { employeeCode: 'C2-NEW', firstName: 'Synthetic', shiftEligibility: 'NIGHT', employmentEnd: '2027-02-28' }, count: 1 },
  { id: 'B18 current and past historical', months: ['2026-11-01', '2026-12-01'], body: { employmentEnd: '2026-10-31' }, historical: 2 },
  { id: 'B19 legacy historical excluded', start: '2026-12-01', months: ['2026-11-01', '2026-12-01'], body: { employmentStart: '2027-01-01' }, historical: 1 },
  { id: 'B20 no assignments', body: { employmentEnd: '2027-01-31' } },
  { id: 'B21 keep covered futures', months: ['2027-03-01', '2027-04-01'], body: { employmentEnd: '2027-04-01' } },
  { id: 'B25 December January', months: ['2027-01-01'], body: { employmentEnd: '2026-12-31' }, count: 1 },
  { id: 'B26 leap last day', months: ['2028-02-01'], body: { employmentStart: '2028-02-29' } },
  { id: 'B26 leap following day', months: ['2028-02-01'], body: { employmentStart: '2028-03-01' }, count: 1 },
  { id: 'B26 leap first day', months: ['2028-02-01'], body: { employmentEnd: '2028-02-01' } },
  { id: 'B26 leap preceding day', months: ['2028-02-01'], body: { employmentEnd: '2028-01-31' }, count: 1 },
  ...[2027, 2100].flatMap((year) => [
    { id: `B27 non-leap ${year} covered`, months: [`${year}-02-01`], body: { employmentStart: `${year}-02-28` } },
    { id: `B27 non-leap ${year} excluded`, months: [`${year}-02-01`], body: { employmentStart: `${year}-03-01` }, count: 1 },
  ]),
  { id: 'B28 one-day interval', start: '2027-03-10', end: '2027-03-10', months: ['2027-03-01'], body: { employmentStart: '2027-04-01', employmentEnd: '2027-04-01' }, count: 1 },
  { id: 'B30 no horizon', months: ['2040-12-01'], body: { employmentEnd: '2040-11-30' }, count: 1 },
];

describe('Case 2 interval and audit matrix', () => {
  it.each(cases)('$id', async (entry) => {
    const start = entry.start === undefined ? '2026-01-01' : entry.start;
    const end = entry.end ?? null;
    await setPeriod(start, end);
    for (const month of entry.months ?? []) await seed(month);
    const before = await state();
    const response = await patch(entry.body);
    if (entry.count !== undefined || entry.status === 400) {
      if (entry.count !== undefined) assertConflict(response, entry.count);
      else { expect(response.status).toBe(400); expect(response.body.code).toBe('EMPLOYMENT_DATE_CONFLICT'); }
      expect(await state()).toEqual(before); return;
    }
    expect(response.status).toBe(200);
    const nextStart = Object.hasOwn(entry.body, 'employmentStart') ? entry.body.employmentStart : start;
    const nextEnd = Object.hasOwn(entry.body, 'employmentEnd') ? entry.body.employmentEnd : end;
    expect(response.body).toMatchObject({ employmentStart: nextStart, employmentEnd: nextEnd });
    const audit = await events(response.headers['x-correlation-id']);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toEqual({ company_id: tenant.companyId, actor_account_id: tenant.admin.accountId,
      resource_id: employee.employeeId, resource_type: 'EMPLOYEE', action: 'EMPLOYEE_UPDATED',
      correlation_id: response.headers['x-correlation-id'],
      old_values: { employmentStart: start, employmentEnd: end },
      new_values: { employmentStart: nextStart, employmentEnd: nextEnd,
        changedFields: ['employmentStart', 'employmentEnd'].filter((key) => key === 'employmentStart' ? nextStart !== start : nextEnd !== end),
        employmentPeriodImpact: { newlyUncoveredHistoricalAssignmentCount: entry.historical ?? 0,
          evaluatedAt: instant, companyCurrentMonth: '2026-12-01', companyTimeZone: 'Europe/Berlin' } },
    });
    expect((await state()).project_assignments).toEqual(before.project_assignments);
    expect(clock).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('B14/15/16/29/34 unchanged dates skip the guard, changed other field=%s', async (other) => {
    await setPeriod(null, null); await seed('2027-03-01');
    await pool.query("UPDATE companies SET time_zone = 'Invalid/Case2' WHERE id = $1", [tenant.companyId]);
    const before = await state();
    const response = await patch({ employmentStart: null, employmentEnd: null, ...(other ? { firstName: 'Changed' } : {}) }).expect(200);
    expect(clock).not.toHaveBeenCalled();
    if (!other) expect(await state()).toEqual(before);
    else expect((await events(response.headers['x-correlation-id']))[0]).toMatchObject({ old_values: {}, new_values: { changedFields: ['firstName'] } });
  });

  it.each([false, true])('B14/15 unchanged documented interval, changed other field=%s', async (other) => {
    await setPeriod('2026-01-01', '2027-02-28'); await seed('2027-03-01'); const before = await state();
    const response = await patch({ employmentStart: '2026-01-01', employmentEnd: '2027-02-28', ...(other ? { shiftEligibility: 'NIGHT' } : {}) }).expect(200);
    expect(clock).not.toHaveBeenCalled();
    if (!other) expect(await state()).toEqual(before);
    else expect((await events(response.headers['x-correlation-id']))[0].new_values).toEqual({ changedFields: ['shiftEligibility'], shiftEligibility: 'NIGHT' });
  });

  it('A03 counts newly excluded future rows independently of many already invalid future rows', async () => {
    await setPeriod('2028-01-01', null);
    await pool.query(`INSERT INTO project_assignments (company_id, employee_id, project_id, planning_month)
      SELECT $1, $2, $3, ('2027-01-01'::date + n * interval '1 month')::date FROM generate_series(0, 39) n`, [tenant.companyId, employee.employeeId, project.projectId]);
    const before = await state(); const response = await patch({ employmentEnd: '2028-02-29' }); assertConflict(response, 26);
    expect(response.body.conflictingAssignments[0].monthStart).toBe('2028-03-01'); expect(await state()).toEqual(before);
  });

  it('U08 accepted mixed names/date change keeps trusted attribution and omits name values', async () => {
    const response = await patch({ firstName: 'Private Synthetic', employmentEnd: '2027-02-28' }).set('X-Correlation-ID', 'untrusted').expect(200);
    const audit = (await events(response.headers['x-correlation-id']))[0];
    expect(audit.actor_account_id).toBe(tenant.admin.accountId); expect(audit.company_id).toBe(tenant.companyId);
    expect(audit.new_values.changedFields).toEqual(['firstName', 'employmentEnd']);
    expect(audit.old_values).toEqual({ employmentStart: '2026-01-01', employmentEnd: null });
    expect(JSON.stringify(audit)).not.toContain('Private Synthetic'); expect(audit.correlation_id).not.toBe('untrusted');
  });

  it.each(['INACTIVE', 'ARCHIVED', 'employee-inactive', 'inactive-expansion'])('B22/23/24 status does not exempt assignments: %s', async (status) => {
    await seed('2027-03-01');
    if (status.startsWith('INACTIVE') || status === 'ARCHIVED') await pool.query('UPDATE projects SET status = $2 WHERE id = $1', [project.projectId, status]);
    else await request(app.getHttpServer()).post(`${path()}/deactivate`).set('Cookie', admin.cookie).set('Origin', ORIGIN).set('X-CSRF-Token', admin.csrf).expect(200);
    if (status === 'inactive-expansion') { await patch({ employmentStart: '2025-01-01' }).expect(200); return; }
    const before = await state(); assertConflict(await patch({ employmentEnd: '2027-02-28' }), 1); expect(await state()).toEqual(before);
  });

  it.each([1, 2, 25, 26, 101])('A01..05 exact count/order/sample and tenant isolation for %s conflicts', async (count) => {
    const foreignPerson = await createSyntheticEmployee(pool, foreign.employee, 'FOREIGN', { start: '2026-01-01' });
    const foreignProject = await createSyntheticProject(pool, foreign.companyId, 'Foreign'); await seed('2027-01-01', foreignPerson, foreignProject);
    await pool.query(`INSERT INTO project_assignments (company_id, employee_id, project_id, planning_month)
      SELECT $1, $2, $3, ('2027-01-01'::date + n * interval '1 month')::date
      FROM generate_series(0, $4::int - 1) AS n ORDER BY n DESC`, [tenant.companyId, employee.employeeId, project.projectId, count]);
    await seed('2025-01-01'); // legacy invalid and historical, not counted
    const expected = (await pool.query(`SELECT id AS "assignmentId", planning_month::text AS "monthStart"
      FROM project_assignments WHERE company_id = $1 AND employee_id = $2 AND planning_month >= '2027-01-01'
      ORDER BY planning_month, id LIMIT 25`, [tenant.companyId, employee.employeeId])).rows;
    const before = await state();
    const one = await patch({ employmentEnd: '2026-12-31' }).set('X-Correlation-ID', 'client-claim');
    const two = await patch({ employmentEnd: '2026-12-31' });
    for (const response of [one, two]) { assertConflict(response, count); expect(response.body.conflictingAssignments).toEqual(expected); }
    expect(one.body.correlationId).not.toBe('client-claim'); expect(one.body.correlationId).not.toBe(two.body.correlationId);
    expect(await state()).toEqual(before);
  });

  it('U04 more than 100 historical impacts have count-only fixed-size audit', async () => {
    await setPeriod('2000-01-01', null);
    await pool.query(`INSERT INTO project_assignments (company_id, employee_id, project_id, planning_month)
      SELECT $1, $2, $3, m::date FROM generate_series('2000-01-01'::date, '2026-12-01'::date, interval '1 month') m`, [tenant.companyId, employee.employeeId, project.projectId]);
    const response = await patch({ employmentStart: null }).expect(200);
    const audit = (await events(response.headers['x-correlation-id']))[0];
    expect(audit.new_values.employmentPeriodImpact).toEqual({ newlyUncoveredHistoricalAssignmentCount: 324,
      companyCurrentMonth: '2026-12-01', companyTimeZone: 'Europe/Berlin', evaluatedAt: instant });
    expect(JSON.stringify(audit.new_values)).not.toContain('assignmentId');
  });

  it('U07 failure after the actual audit insert rolls employee, updated_at and audit back', async () => {
    const audit = app.get(BusinessAuditService); const real = audit.recordBusinessAction.bind(audit);
    vi.spyOn(audit, 'recordBusinessAction').mockImplementation(async (client, entry) => { await real(client, entry); throw new Error('synthetic post-insert failure'); });
    const before = await state(); await patch({ employmentEnd: '2027-01-31', firstName: 'Never persisted' }).expect(500); expect(await state()).toEqual(before);
  });

  it('A12 response mapping failure after update/audit rolls back the entire transaction', async () => {
    vi.spyOn(app.get(AccountLifecycleService), 'accountSummaries').mockRejectedValue(new Error('synthetic mapping failure'));
    const before = await state(); const response = await patch({ employmentEnd: '2027-02-28' }).expect(500);
    expect(response.body.code).toBe('INTERNAL_ERROR'); expect(await state()).toEqual(before);
  });

  it.each(['unsafe-count', 'invalid-reference'])('A11 inconsistent internal query summary %s fails closed before mutation', async (fault) => {
    await seed('2027-03-01'); const before = await state();
    const database = app.get(DatabaseService); const real = database.withTransaction.bind(database);
    vi.spyOn(database, 'withTransaction').mockImplementation((work) => real(async (client) => work(new Proxy(client, {
      get(target, key) {
        if (key !== 'query') return Reflect.get(target, key, target);
        return async (...args: unknown[]) => {
          const query = target.query.bind(target) as unknown as (...values: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
          const result = await query(...args);
          // Deliberate corruption at the trust boundary; concurrency tests never fabricate results.
          if (typeof args[0] === 'string' && args[0].includes('WITH newly_uncovered AS')) {
            if (fault === 'unsafe-count') result.rows[0].future_count = '9007199254740992';
            else result.rows[0].conflicts = [{ assignmentId: 'unsafe', monthStart: '2027-03-01' }];
          }
          return result;
        };
      },
    }))));
    const response = await patch({ employmentEnd: '2027-02-28' }).expect(500); expect(response.body.code).toBe('INTERNAL_ERROR'); expect(await state()).toEqual(before);
  });
});

describe('Case 2 calendar and named-zone classification', () => {
  it.each([
    ['Europe/Berlin', '2026-11-30T23:30:00.000Z', '2026-12-01', 200],
    ['America/New_York', '2026-11-30T23:30:00.000Z', '2026-12-01', 409],
    ['Europe/Berlin', '2026-12-31T22:59:59.999Z', '2027-01-01', 409],
    ['Europe/Berlin', '2026-12-31T23:00:00.000Z', '2027-01-01', 200],
    ['America/New_York', '2026-12-31T23:30:00.000Z', '2027-01-01', 409],
    ['America/New_York', '2027-01-01T04:59:59.999Z', '2027-01-01', 409],
    ['America/New_York', '2027-01-01T05:00:00.000Z', '2027-01-01', 200],
    ['Europe/Berlin', '2026-03-29T01:30:00.000Z', '2026-03-01', 200],
    ['Europe/Berlin', '2026-10-25T01:30:00.000Z', '2026-11-01', 409],
    ['America/New_York', '2026-03-08T07:30:00.000Z', '2026-03-01', 200],
    ['America/New_York', '2026-11-01T06:30:00.000Z', '2026-11-01', 200],
  ])('T01..04 %s at %s for %s -> %s', async (zone, now, month, status) => {
    instant = now; await pool.query('UPDATE companies SET time_zone = $2 WHERE id = $1', [tenant.companyId, zone]); await seed(month);
    const response = await patch({ employmentStart: null }); expect(response.status).toBe(status);
    if (status === 409) assertConflict(response, 1);
    else expect((await events(response.headers['x-correlation-id']))[0].new_values.employmentPeriodImpact).toMatchObject({ evaluatedAt: now, companyTimeZone: zone, companyCurrentMonth: month, newlyUncoveredHistoricalAssignmentCount: 1 });
  });

  it.each(['UTC', 'Europe/Berlin', 'America/New_York'])('T05 DB session zone %s cannot affect the company cutoff', async (zone) => {
    instant = '2026-12-31T23:30:00.000Z'; await seed('2027-01-01');
    const database = app.get(DatabaseService); const real = database.withTransaction.bind(database);
    vi.spyOn(database, 'withTransaction').mockImplementation((work) => real(async (client) => { await client.query("SELECT set_config('TimeZone', $1, true)", [zone]); return work(client); }));
    const response = await patch({ employmentStart: null }).expect(200);
    expect((await events(response.headers['x-correlation-id']))[0].new_values.employmentPeriodImpact.companyCurrentMonth).toBe('2027-01-01');
  });

  it.each(['Invalid/Case2', '+03:00'])('B33 invalid/non-named zone %s fails safely and atomically', async (zone) => {
    await pool.query('UPDATE companies SET time_zone = $2 WHERE id = $1', [tenant.companyId, zone]); const before = await state();
    const response = await patch({ employmentStart: null }).expect(500); expect(response.body.code).toBe('INTERNAL_ERROR'); expect(await state()).toEqual(before);
  });
});

describe('Case 2 precedence and concealment', () => {
  it('B31 duplicate employee code precheck precedes the new conflict', async () => {
    await createSyntheticEmployee(pool, await createSyntheticAccount(pool, tenant.companyId, 'EMPLOYEE'), 'TAKEN'); await seed('2027-03-01'); const before = await state();
    const response = await patch({ employeeCode: 'TAKEN', employmentEnd: '2027-02-28' }).expect(409);
    expect(response.body.code).toBe('EMPLOYEE_CODE_ALREADY_EXISTS'); expect(response.body).not.toHaveProperty('conflictCount'); expect(clock).not.toHaveBeenCalled(); expect(await state()).toEqual(before);
  });

  it('B32 foreign and missing employees are the same concealed 404', async () => {
    const person = await createSyntheticEmployee(pool, foreign.employee, 'F', { start: '2026-01-01' });
    const target = await createSyntheticProject(pool, foreign.companyId, 'Foreign'); await seed('2027-03-01', person, target);
    for (const id of [person.employeeId, randomUUID()]) { const response = await patch({ employmentEnd: '2027-02-28' }, id).expect(404); expect(response.body.code).toBe('RESOURCE_NOT_FOUND'); expect(response.body).not.toHaveProperty('conflictCount'); }
    expect(clock).not.toHaveBeenCalled();
  });

  it.each([
    [{}, 400, 'EMPTY_PATCH'], [{ employmentStart: '2027-02-29' }, 400, 'VALIDATION_FAILED'],
    [{ status: 'ACTIVE' }, 400, 'UNKNOWN_FIELD'], [{ companyId: 'claim', role: 'COMPANY_ADMIN' }, 400, 'UNKNOWN_FIELD'],
  ] as const)('A09 existing DTO precedence %#', async (body, status, code) => {
    await seed('2027-03-01'); const before = await state(); const response = await patch(body).expect(status);
    expect(response.body.code).toBe(code); expect(response.body).not.toHaveProperty('conflictCount'); expect(await state()).toEqual(before);
  });

  it('A09 parameter/DTO combinations retain existing concealed and validation errors', async () => {
    for (const [body, status, code] of [[{ employmentEnd: '2027-02-28' }, 404, 'RESOURCE_NOT_FOUND'], [{ role: 'claim' }, 404, 'RESOURCE_NOT_FOUND']] as const) {
      const response = await patch(body, 'not-a-uuid').expect(status); expect(response.body.code).toBe(code); expect(response.body).not.toHaveProperty('conflictCount');
    }
  });

  it.each(['employee', 'no-session', 'expired', 'revoked', 'origin', 'csrf'])('A06/07 guards prevent disclosure: %s', async (kind) => {
    await seed('2027-03-01'); const before = await state();
    const session = kind === 'employee' ? await createSyntheticSession(realSessionService(pool), tenant.employee) : admin;
    if (kind === 'expired') await pool.query("UPDATE sessions SET created_at = now() - interval '2 days', last_seen_at = now() - interval '2 days', absolute_expires_at = now() - interval '1 day' WHERE account_id = $1", [tenant.admin.accountId]);
    if (kind === 'revoked') await pool.query('UPDATE sessions SET revoked_at = now() WHERE account_id = $1', [tenant.admin.accountId]);
    const response = await request(app.getHttpServer()).patch(path()).set('Cookie', kind === 'no-session' ? '' : session.cookie)
      .set('Origin', kind === 'origin' ? 'https://untrusted.invalid' : ORIGIN).set('X-CSRF-Token', kind === 'csrf' ? 'invalid' : session.csrf)
      .send({ employmentStart: null });
    expect(response.status).toBe(['employee', 'origin', 'csrf'].includes(kind) ? 403 : 401); expect(response.body).not.toHaveProperty('conflictCount');
    expect(clock).not.toHaveBeenCalled(); expect(await state()).toEqual(before);
  });
});
