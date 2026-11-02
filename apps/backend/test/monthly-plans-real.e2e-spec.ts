/**
 * SP-11 PR-1 monthly plans and duties over HTTP against REAL PostgreSQL
 * (SP11A-R1 acceptance rows API-01..06, EL-01..06, SEC-01..05, AUD-01..03,
 * E04-01/02, DST-03 via HTTP). Real AppModule: global AccessControlGuard,
 * sessions, CSRF/Origin, SQL. Two synthetic tenants prove isolation.
 * Synthetic data only; migrated LOCAL PostgreSQL (0001-0011).
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { SessionService } from '../src/auth/session.service.js';
import {
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
  createStaff,
  insertDuty,
  insertMembership,
  insertPlan,
  insertProjectAssignment,
  insertShiftConfiguration,
  planningState,
} from './helpers/planning-fixtures.js';

const BASE = '/api/v1/monthly-plans';
const MONTH = '2027-03-01';
const PLAN_KEYS = ['id', 'monthStart', 'projectId', 'publishedAt', 'status'];
const ENTRY_KEYS = ['assignments', 'availabilityConflicts', 'dutyDate', 'endsAt', 'id', 'shiftKind', 'startsAt', 'version'];

let pool: TestPool | undefined;
let sessions: SessionService;
let app: INestApplication<App> | undefined;
let tenantA: SyntheticTenant;
let tenantB: SyntheticTenant;
let adminA: SyntheticSession;
let adminB: SyntheticSession;
let employeeSessionA: SyntheticSession;
let north: SyntheticProject;
let mira: SyntheticEmployee;
let jonas: SyntheticEmployee;
const createdCompanies: string[] = [];
let previousOrigin: string | undefined;

function db(): TestPool {
  if (!pool) throw new Error('Test database is unavailable');
  return pool;
}

const http = () => request(app!.getHttpServer());

function read(path: string, session?: SyntheticSession) {
  const pending = http().get(path);
  return session ? pending.set('Cookie', session.cookie) : pending;
}

function write(path: string, session: SyntheticSession | null, body: unknown = {}) {
  let pending = http().post(path).set('Origin', ORIGIN);
  if (session) pending = pending.set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf);
  return pending.send(body as object);
}

async function bootApp(audit?: FailingAudit) {
  if (app) await app.close();
  app = await bootEmployeesApp(new RecordingDelivery(), audit ? { audit } : {});
}

async function createPlan(projectId = north.projectId, monthStart = MONTH): Promise<string> {
  return (await write(BASE, adminA, { projectId, monthStart }).expect(201)).body.id;
}

async function auditRows(companyId: string, correlationId: string) {
  return (await db().query<{ action: string; resource_type: string; resource_id: string; actor_account_id: string; old_values: unknown; new_values: Record<string, unknown> }>(
    `SELECT action, resource_type, resource_id, actor_account_id, old_values, new_values
     FROM audit_event WHERE company_id = $1 AND correlation_id = $2 ORDER BY action, resource_id`,
    [companyId, correlationId],
  )).rows;
}

beforeAll(() => {
  pool = openLocalTestPool(10);
  sessions = realSessionService(db());
  previousOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
});

beforeEach(async () => {
  tenantA = await createSyntheticTenant(db(), 'SP11 Tenant A');
  createdCompanies.push(tenantA.companyId);
  tenantB = await createSyntheticTenant(db(), 'SP11 Tenant B');
  createdCompanies.push(tenantB.companyId);
  adminA = await createSyntheticSession(sessions, tenantA.admin);
  adminB = await createSyntheticSession(sessions, tenantB.admin);
  employeeSessionA = await createSyntheticSession(sessions, tenantA.employee);
  north = await createSyntheticProject(db(), tenantA.companyId, 'SP11 Nord');
  await insertShiftConfiguration(db(), tenantA.companyId, north.projectId, '2027-01-01', STANDARD_SHIFTS);
  mira = await createStaff(db(), tenantA.companyId);
  jonas = await createStaff(db(), tenantA.companyId);
  for (const staff of [mira, jonas]) await insertProjectAssignment(db(), tenantA.companyId, staff.employeeId, north.projectId, MONTH);
  await bootApp();
});

afterEach(async () => {
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

describe('SP-11 — access control on every new route (SEC-01, SEC-03)', () => {
  it('anonymous 401, EMPLOYEE 403, foreign admin 404; CSRF and Origin are enforced on the creates', async () => {
    const planId = await createPlan();
    const routes = [
      ['GET', BASE], ['GET', `${BASE}/${planId}`], ['GET', `${BASE}/${planId}/entries`],
      ['POST', BASE], ['POST', `${BASE}/${planId}/entries`],
    ] as const;
    for (const [method, path] of routes) {
      const anonymous = method === 'GET' ? read(path) : write(path, null, {});
      expect((await anonymous).status, `${method} ${path}`).toBe(401);
      const employee = method === 'GET' ? read(path, employeeSessionA) : write(path, employeeSessionA, {});
      const denied = await employee;
      expect(denied.status, `${method} ${path}`).toBe(403);
      expect(denied.body.code).toBe('ACTION_FORBIDDEN');
    }
    expect((await read(`${BASE}/${planId}`, adminB)).status).toBe(404);
    const body = { dutyDate: '2027-03-10', shiftKind: 'DAY' };
    const noCsrf = await http().post(`${BASE}/${planId}/entries`).set('Origin', ORIGIN).set('Cookie', adminA.cookie).send(body);
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.code).toBe('CSRF_VALIDATION_FAILED');
    const foreignOrigin = await http().post(BASE).set('Origin', 'https://evil.invalid')
      .set('Cookie', adminA.cookie).set('X-CSRF-Token', adminA.csrf).send({ projectId: north.projectId, monthStart: '2027-04-01' });
    expect(foreignOrigin.status).toBe(403);
    const oversized = await write(`${BASE}/${planId}/entries`, adminA, { ...body, padding: 'x'.repeat(110 * 1024) });
    expect(oversized.status).toBe(413);
    expect(oversized.body.code).toBe('REQUEST_BODY_TOO_LARGE');
    expect((await db().query('SELECT count(*)::int AS n FROM duties WHERE company_id = $1', [tenantA.companyId])).rows[0].n).toBe(0);
  });
});

describe('SP-11 — monthly plans (API-01, AUD-01)', () => {
  it('creates an UNPUBLISHED plan with Location and exactly one bounded audit event', async () => {
    const response = await write(BASE, adminA, { projectId: north.projectId.toUpperCase(), monthStart: MONTH }).expect(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.location).toBe(`${BASE}/${response.body.id}`);
    expect(Object.keys(response.body).sort()).toEqual(PLAN_KEYS);
    expect(response.body).toMatchObject({ projectId: north.projectId, monthStart: MONTH, status: 'UNPUBLISHED', publishedAt: null });
    const correlationId = response.headers['x-correlation-id'];
    expect(await auditRows(tenantA.companyId, correlationId)).toEqual([{
      action: 'MONTHLY_PLAN_CREATED', resource_type: 'MONTHLY_PLAN', resource_id: response.body.id,
      actor_account_id: tenantA.admin.accountId, old_values: null,
      new_values: { projectId: north.projectId, monthStart: MONTH, status: 'UNPUBLISHED' },
    }]);
    expect((await read(`${BASE}/${response.body.id}`, adminA).expect(200)).body).toEqual(response.body);
  });

  it('refuses duplicates, invalid months, inactive, foreign and archived projects without writing', async () => {
    await createPlan();
    const archived = await createSyntheticProject(db(), tenantA.companyId, 'SP11 Archiv', 'ARCHIVED');
    const inactive = await createSyntheticProject(db(), tenantA.companyId, 'SP11 Ruhend', 'INACTIVE');
    const foreign = await createSyntheticProject(db(), tenantB.companyId, 'SP11 Fremd');
    const before = await planningState(db(), tenantA.companyId);
    const cases = [
      [{ projectId: north.projectId, monthStart: MONTH }, 409, 'MONTHLY_PLAN_ALREADY_EXISTS'],
      [{ projectId: north.projectId, monthStart: '2027-03-02' }, 400, 'INVALID_MONTH_START'],
      // Year 0000 is already refused by the strict ISO-8601 DTO check (structural 400).
      [{ projectId: north.projectId, monthStart: '0000-01-01' }, 400, 'VALIDATION_FAILED'],
      [{ projectId: north.projectId, monthStart: '2027-02-30' }, 400, 'VALIDATION_FAILED'],
      [{ projectId: inactive.projectId, monthStart: MONTH }, 409, 'PROJECT_INACTIVE'],
      [{ projectId: archived.projectId, monthStart: MONTH }, 404, 'RESOURCE_NOT_FOUND'],
      [{ projectId: foreign.projectId, monthStart: MONTH }, 404, 'RESOURCE_NOT_FOUND'],
      [{ projectId: north.projectId, monthStart: MONTH, status: 'PUBLISHED' }, 400, 'UNKNOWN_FIELD'],
      [{ projectId: north.projectId, monthStart: MONTH, companyId: tenantB.companyId }, 400, 'UNKNOWN_FIELD'],
    ] as const;
    for (const [body, status, code] of cases) {
      const response = await write(BASE, adminA, body);
      expect([response.status, response.body.code], JSON.stringify(body)).toEqual([status, code]);
    }
    expect(await planningState(db(), tenantA.companyId)).toEqual(before);
  });

  it('lists with filters, deterministic order, pagination and no foreign or archived rows', async () => {
    const south = await createSyntheticProject(db(), tenantA.companyId, 'SP11 Sued');
    const archived = await createSyntheticProject(db(), tenantA.companyId, 'SP11 Alt');
    const ids = {
      northMarch: await createPlan(north.projectId, MONTH),
      northApril: await createPlan(north.projectId, '2027-04-01'),
      southMarch: await createPlan(south.projectId, MONTH),
    };
    await insertPlan(db(), tenantA.companyId, archived.projectId, '2027-05-01');
    await db().query("UPDATE projects SET status = 'ARCHIVED' WHERE id = $1", [archived.projectId]);
    const foreignProject = await createSyntheticProject(db(), tenantB.companyId, 'SP11 Fremd');
    await insertPlan(db(), tenantB.companyId, foreignProject.projectId, MONTH);

    const all = (await read(BASE, adminA).expect(200)).body;
    expect(all.pagination).toEqual({ page: 1, pageSize: 25, totalItems: 3, totalPages: 1 });
    const marchIds = [ids.northMarch, ids.southMarch].sort();
    expect(all.items.map((plan: { id: string }) => plan.id)).toEqual([ids.northApril, ...marchIds]);
    expect((await read(`${BASE}?projectId=${north.projectId}&monthStart=${MONTH}`, adminA).expect(200)).body.items
      .map((plan: { id: string }) => plan.id)).toEqual([ids.northMarch]);
    expect((await read(`${BASE}?status=PUBLISHED`, adminA).expect(200)).body)
      .toEqual({ items: [], pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 } });
    expect((await read(`${BASE}?page=2&pageSize=2`, adminA).expect(200)).body.items).toHaveLength(1);
    expect((await read(`${BASE}?projectId=${foreignProject.projectId}`, adminA).expect(200)).body.pagination.totalItems).toBe(0);
    for (const query of ['status=DRAFT', 'pageSize=101', 'page=0', 'monthStart=2027-03-05', 'unknown=1', 'projectId=x']) {
      expect((await read(`${BASE}?${query}`, adminA)).status, query).toBe(400);
    }
  });
});

describe('SP-11 — duty creation (API-02..06, AUD-01..03)', () => {
  it('creates an empty duty and a staffed duty atomically, with exact snapshots, DTO and audit events', async () => {
    const planId = await createPlan();
    const empty = await write(`${BASE}/${planId}/entries`, adminA, { dutyDate: '2027-03-10', shiftKind: 'DAY' }).expect(201);
    expect(empty.headers.location).toBe(`${BASE}/${planId}/entries/${empty.body.id}`);
    expect(Object.keys(empty.body).sort()).toEqual(ENTRY_KEYS);
    expect(empty.body).toMatchObject({
      dutyDate: '2027-03-10', shiftKind: 'DAY', startsAt: '2027-03-10T05:00:00Z', endsAt: '2027-03-10T17:00:00Z',
      version: 1, assignments: [], availabilityConflicts: [],
    });

    const staffed = await write(`${BASE}/${planId}/entries`, adminA, {
      dutyDate: '2027-03-27', shiftKind: 'NIGHT',
      assignments: [{ employeeId: jonas.employeeId, dutyRole: 'SHIFT_LEAD' }, { employeeId: mira.employeeId.toUpperCase(), dutyRole: 'EMPLOYEE' }],
    }).expect(201);
    // Berlin spring-forward night 27/28 March 2027 is 11 real hours.
    expect(staffed.body).toMatchObject({ startsAt: '2027-03-27T17:00:00Z', endsAt: '2027-03-28T04:00:00Z', version: 1 });
    const byEmployee = Object.fromEntries(staffed.body.assignments.map((a: { employeeId: string; dutyRole: string }) => [a.employeeId, a.dutyRole]));
    expect(byEmployee).toEqual({ [jonas.employeeId]: 'SHIFT_LEAD', [mira.employeeId]: 'EMPLOYEE' });
    expect(staffed.body.assignments.every((a: { source: string }) => a.source === 'NORMAL')).toBe(true);

    const stored = (await db().query(
      `SELECT project_id, planning_month::text, time_zone, config_effective_from_month::text, start_local::text, end_local::text, removed_at
       FROM duties WHERE id = $1`, [staffed.body.id])).rows[0];
    expect(stored).toEqual({
      project_id: north.projectId, planning_month: MONTH, time_zone: 'Europe/Berlin',
      config_effective_from_month: '2027-01-01', start_local: '18:00:00', end_local: '06:00:00', removed_at: null,
    });

    const audit = await auditRows(tenantA.companyId, staffed.headers['x-correlation-id']);
    expect(audit.map((row) => row.action)).toEqual(['DUTY_CREATED', 'DUTY_MEMBERSHIP_ADDED', 'DUTY_MEMBERSHIP_ADDED']);
    expect(audit[0]).toMatchObject({
      resource_type: 'DUTY', resource_id: staffed.body.id, actor_account_id: tenantA.admin.accountId, old_values: null,
      new_values: { planId, dutyDate: '2027-03-27', shiftKind: 'NIGHT', startsAt: '2027-03-27T17:00:00Z', endsAt: '2027-03-28T04:00:00Z', version: 1 },
    });
    for (const row of audit.slice(1)) {
      expect(row.resource_type).toBe('DUTY_ASSIGNMENT');
      expect(Object.keys(row.new_values).sort()).toEqual(['dutyId', 'dutyRole', 'employeeId', 'source']);
    }

    const listed = (await read(`${BASE}/${planId}/entries`, adminA).expect(200)).body;
    expect(listed.items.map((entry: { id: string }) => entry.id)).toEqual([empty.body.id, staffed.body.id]);
    expect(listed.items[1]).toEqual(staffed.body);
    expect((await read(`${BASE}/${planId}/entries?shiftKind=NIGHT`, adminA).expect(200)).body.items).toHaveLength(1);
  });

  it('refuses structurally invalid input with 400 and writes nothing (API-03)', async () => {
    const planId = await createPlan();
    const before = await planningState(db(), tenantA.companyId);
    const valid = { dutyDate: '2027-03-10', shiftKind: 'DAY' };
    const cases = [
      [{ ...valid, dutyDate: '2027-02-30' }, 'VALIDATION_FAILED'],
      [{ ...valid, dutyDate: '0000-03-10' }, 'VALIDATION_FAILED'],
      [{ ...valid, dutyDate: '2027-04-01' }, 'DUTY_DATE_OUTSIDE_PLAN_MONTH'],
      [{ ...valid, shiftKind: 'TAG' }, 'VALIDATION_FAILED'],
      [{ ...valid, assignments: null }, 'VALIDATION_FAILED'],
      [{ ...valid, assignments: [{ employeeId: 'not-a-uuid', dutyRole: 'EMPLOYEE' }] }, 'VALIDATION_FAILED'],
      [{ ...valid, assignments: [{ employeeId: mira.employeeId, dutyRole: 'ADMIN' }] }, 'VALIDATION_FAILED'],
      [{ ...valid, assignments: [{ employeeId: mira.employeeId, dutyRole: 'EMPLOYEE', source: 'REPLACEMENT' }] }, 'UNKNOWN_FIELD'],
      [{ ...valid, startsAt: '2027-03-10T00:00:00Z' }, 'UNKNOWN_FIELD'],
      [{ ...valid, assignments: [
        { employeeId: mira.employeeId, dutyRole: 'EMPLOYEE' }, { employeeId: mira.employeeId.toUpperCase(), dutyRole: 'SHIFT_LEAD' },
      ] }, 'VALIDATION_FAILED'],
    ] as const;
    for (const [body, code] of cases) {
      const response = await write(`${BASE}/${planId}/entries`, adminA, body);
      expect([response.status, response.body.code], JSON.stringify(body)).toEqual([400, code]);
    }
    const duplicate = await write(`${BASE}/${planId}/entries`, adminA, cases[9][0]);
    expect(duplicate.body.errors).toEqual([expect.objectContaining({ pointer: '#/assignments', code: 'DUPLICATE_ITEM' })]);
    expect(await planningState(db(), tenantA.companyId)).toEqual(before);
  });

  it('duplicate live slot is a deterministic 409 and a different roster is never merged; no staffing minimum (API-04)', async () => {
    const planId = await createPlan();
    await write(`${BASE}/${planId}/entries`, adminA, { dutyDate: '2027-03-10', shiftKind: 'DAY' }).expect(201);
    const before = await planningState(db(), tenantA.companyId);
    const second = await write(`${BASE}/${planId}/entries`, adminA, {
      dutyDate: '2027-03-10', shiftKind: 'DAY', assignments: [{ employeeId: mira.employeeId, dutyRole: 'EMPLOYEE' }],
    });
    expect([second.status, second.body.code]).toEqual([409, 'DUTY_ALREADY_EXISTS']);
    expect(await planningState(db(), tenantA.companyId)).toEqual(before);
    // The other kind on the same day is a different slot.
    await write(`${BASE}/${planId}/entries`, adminA, { dutyDate: '2027-03-10', shiftKind: 'NIGHT' }).expect(201);
  });

  it('a tombstoned duty frees its slot (K1 live uniqueness)', async () => {
    const planId = await createPlan();
    await insertDuty(db(), {
      companyId: tenantA.companyId, projectId: north.projectId, planId, month: MONTH, dutyDate: '2027-03-11',
      startsAt: '2027-03-11T05:00:00Z', endsAt: '2027-03-11T17:00:00Z', removedAt: '2027-02-01T00:00:00Z',
    });
    await write(`${BASE}/${planId}/entries`, adminA, { dutyDate: '2027-03-11', shiftKind: 'DAY' }).expect(201);
    expect((await read(`${BASE}/${planId}/entries`, adminA).expect(200)).body.items).toHaveLength(1);
  });

  it('SHIFT_CONFIGURATION_MISSING only for a missing effective kind; kinds are never inherited (API-05)', async () => {
    const planId = await createPlan();
    // A newer whole version from March without NIGHT: the January NIGHT is not inherited.
    await insertShiftConfiguration(db(), tenantA.companyId, north.projectId, MONTH, [{ kind: 'TAG', start: '07:00', end: '19:00' }]);
    const night = await write(`${BASE}/${planId}/entries`, adminA, { dutyDate: '2027-03-10', shiftKind: 'NIGHT' });
    expect([night.status, night.body.code]).toEqual([409, 'SHIFT_CONFIGURATION_MISSING']);
    const day = await write(`${BASE}/${planId}/entries`, adminA, { dutyDate: '2027-03-10', shiftKind: 'DAY' }).expect(201);
    expect(day.body).toMatchObject({ startsAt: '2027-03-10T06:00:00Z', endsAt: '2027-03-10T18:00:00Z' });
    const unconfigured = await createSyntheticProject(db(), tenantA.companyId, 'SP11 Leer');
    const emptyPlan = await createPlan(unconfigured.projectId);
    const missing = await write(`${BASE}/${emptyPlan}/entries`, adminA, { dutyDate: '2027-03-10', shiftKind: 'DAY' });
    expect([missing.status, missing.body.code]).toEqual([409, 'SHIFT_CONFIGURATION_MISSING']);
  });

  it('precedence: structural 400 before any 409; PROJECT_INACTIVE before slot; config before time range (API-06)', async () => {
    const planId = await createPlan();
    await write(`${BASE}/${planId}/entries`, adminA, { dutyDate: '2027-03-10', shiftKind: 'DAY' }).expect(201);
    await db().query("UPDATE projects SET status = 'INACTIVE' WHERE id = $1", [north.projectId]);
    const outside = await write(`${BASE}/${planId}/entries`, adminA, { dutyDate: '2027-04-10', shiftKind: 'DAY' });
    expect([outside.status, outside.body.code]).toEqual([400, 'DUTY_DATE_OUTSIDE_PLAN_MONTH']);
    const inactive = await write(`${BASE}/${planId}/entries`, adminA, { dutyDate: '2027-03-10', shiftKind: 'DAY' });
    expect([inactive.status, inactive.body.code]).toEqual([409, 'PROJECT_INACTIVE']);
    await db().query("UPDATE projects SET status = 'ACTIVE' WHERE id = $1", [north.projectId]);
    const foreignStaff = await createStaff(db(), tenantB.companyId);
    const foreign = await write(`${BASE}/${planId}/entries`, adminA, {
      dutyDate: '2027-03-12', shiftKind: 'DAY', assignments: [{ employeeId: foreignStaff.employeeId, dutyRole: 'EMPLOYEE' }],
    });
    expect([foreign.status, foreign.body.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
  });

  it('an audit failure on membership event N rolls back the duty, all members and earlier events (AUD-02)', async () => {
    const planId = await createPlan();
    await bootApp(new FailingAudit('DUTY_MEMBERSHIP_ADDED'));
    const before = await planningState(db(), tenantA.companyId);
    const response = await write(`${BASE}/${planId}/entries`, adminA, {
      dutyDate: '2027-03-10', shiftKind: 'DAY', assignments: [{ employeeId: mira.employeeId, dutyRole: 'EMPLOYEE' }],
    });
    expect([response.status, response.body.code]).toEqual([500, 'INTERNAL_ERROR']);
    expect(JSON.stringify(response.body)).not.toMatch(/synthetic audit failure|plan_assignments|SELECT|INSERT/);
    expect(await planningState(db(), tenantA.companyId)).toEqual(before);
  });

  it('an unrecognised company zone is a sanitized 500 with no write (DST-03, SEC-05)', async () => {
    const planId = await createPlan();
    await db().query("UPDATE companies SET time_zone = 'Invalid/Zone' WHERE id = $1", [tenantA.companyId]);
    const before = await planningState(db(), tenantA.companyId);
    const response = await write(`${BASE}/${planId}/entries`, adminA, { dutyDate: '2027-03-10', shiftKind: 'DAY' });
    expect([response.status, response.body.code]).toEqual([500, 'INTERNAL_ERROR']);
    expect(JSON.stringify(response.body)).not.toContain('Invalid/Zone');
    expect(await planningState(db(), tenantA.companyId)).toEqual(before);
  });
});

describe('SP-11 — D6 interval rejection over HTTP (DST-03, C1)', () => {
  it.each([
    ['Berlin 02:30-03:15 on 2026-03-29 (-15 min)', 'Europe/Berlin', '2026-03-01', '2026-03-29', '02:30', '03:15'],
    ['Berlin 02:30-03:30 on 2026-03-29 (0 min)', 'Europe/Berlin', '2026-03-01', '2026-03-29', '02:30', '03:30'],
    ['New York 02:30-03:15 on 2026-03-08', 'America/New_York', '2026-03-01', '2026-03-08', '02:30', '03:15'],
  ])('%s -> 409 DUTY_TIME_RANGE_INVALID, no row, no audit; the same configuration on another date -> 201', async (_name, zone, month, dutyDate, start, end) => {
    await db().query('UPDATE companies SET time_zone = $2 WHERE id = $1', [tenantA.companyId, zone]);
    const gapProject = await createSyntheticProject(db(), tenantA.companyId, `SP11 DST ${randomUUID().slice(0, 6)}`);
    await insertShiftConfiguration(db(), tenantA.companyId, gapProject.projectId, month, [{ kind: 'TAG', start, end }]);
    const planId = await createPlan(gapProject.projectId, month);
    const before = await planningState(db(), tenantA.companyId);
    const refused = await write(`${BASE}/${planId}/entries`, adminA, { dutyDate, shiftKind: 'DAY' });
    expect([refused.status, refused.body.code]).toEqual([409, 'DUTY_TIME_RANGE_INVALID']);
    expect(refused.body.detail).toBe('The configured shift times do not produce a valid duty interval for this date.');
    expect(await planningState(db(), tenantA.companyId)).toEqual(before);
    await write(`${BASE}/${planId}/entries`, adminA, { dutyDate: `${month.slice(0, 8)}20`, shiftKind: 'DAY' }).expect(201);
  });
});

describe('SP-11 — staffing eligibility (EL-01..EL-06)', () => {
  function staffOne(planId: string, employeeId: string, dutyDate = '2027-03-10', shiftKind = 'DAY') {
    return write(`${BASE}/${planId}/entries`, adminA, { dutyDate, shiftKind, assignments: [{ employeeId, dutyRole: 'EMPLOYEE' }] });
  }

  it('refuses inactive, unemployed, unassigned, ineligible and unavailable employees with the catalogued 409 (EL-01..04)', async () => {
    const planId = await createPlan();
    const south = await createSyntheticProject(db(), tenantA.companyId, 'SP11 Sued');
    const people = {
      inactive: await createStaff(db(), tenantA.companyId),
      noStart: await createStaff(db(), tenantA.companyId, { start: null }),
      lateStart: await createStaff(db(), tenantA.companyId, { start: '2027-03-11' }),
      ended: await createStaff(db(), tenantA.companyId, { end: '2027-03-09' }),
      unassigned: await createStaff(db(), tenantA.companyId),
      otherProject: await createStaff(db(), tenantA.companyId),
      dayOnly: await createStaff(db(), tenantA.companyId, { eligibility: 'TAG' }),
      sick: await createStaff(db(), tenantA.companyId),
      onLeave: await createStaff(db(), tenantA.companyId),
    };
    for (const [key, staff] of Object.entries(people)) {
      if (key === 'unassigned') continue;
      await insertProjectAssignment(db(), tenantA.companyId, staff.employeeId, key === 'otherProject' ? south.projectId : north.projectId, MONTH);
    }
    await db().query("UPDATE employees SET status = 'DEACTIVATED' WHERE id = $1", [people.inactive.employeeId]);
    await db().query(
      `INSERT INTO employee_availability_days (company_id, employee_id, day, status) VALUES ($1, $2, '2027-03-10', 'SICK'), ($1, $3, '2027-03-10', 'LEAVE')`,
      [tenantA.companyId, people.sick.employeeId, people.onLeave.employeeId],
    );
    const before = await planningState(db(), tenantA.companyId);
    const expectations = [
      [people.inactive, 'DAY', 'EMPLOYEE_INACTIVE'],
      [people.noStart, 'DAY', 'EMPLOYEE_NOT_EMPLOYED_FOR_DAY'],
      [people.lateStart, 'DAY', 'EMPLOYEE_NOT_EMPLOYED_FOR_DAY'],
      [people.ended, 'DAY', 'EMPLOYEE_NOT_EMPLOYED_FOR_DAY'],
      [people.unassigned, 'DAY', 'EMPLOYEE_NOT_ASSIGNED_TO_PROJECT_MONTH'],
      [people.otherProject, 'DAY', 'EMPLOYEE_NOT_ASSIGNED_TO_PROJECT_MONTH'],
      [people.dayOnly, 'NIGHT', 'EMPLOYEE_NOT_ELIGIBLE_FOR_SHIFT'],
      [people.sick, 'DAY', 'EMPLOYEE_UNAVAILABLE'],
      [people.onLeave, 'DAY', 'EMPLOYEE_UNAVAILABLE'],
    ] as const;
    for (const [staff, kind, code] of expectations) {
      const response = await staffOne(planId, staff.employeeId, '2027-03-10', kind);
      expect([response.status, response.body.code], code).toEqual([409, code]);
      // No absence reason or status is echoed.
      expect(JSON.stringify(response.body)).not.toMatch(/SICK|LEAVE/);
    }
    expect(await planningState(db(), tenantA.companyId)).toEqual(before);
    // A whole command with one violating member is rejected; the valid member is not staffed alone.
    const mixed = await write(`${BASE}/${planId}/entries`, adminA, {
      dutyDate: '2027-03-10', shiftKind: 'DAY',
      assignments: [{ employeeId: mira.employeeId, dutyRole: 'EMPLOYEE' }, { employeeId: people.sick.employeeId, dutyRole: 'EMPLOYEE' }],
    });
    expect([mixed.status, mixed.body.code]).toEqual([409, 'EMPLOYEE_UNAVAILABLE']);
    expect(await planningState(db(), tenantA.companyId)).toEqual(before);
  });

  it('employment bounds are inclusive and an open end is open; the duty date decides a NIGHT (EL-02)', async () => {
    const planId = await createPlan();
    const startsOn = await createStaff(db(), tenantA.companyId, { start: '2027-03-12' });
    const endsOn = await createStaff(db(), tenantA.companyId, { end: '2027-03-12' });
    for (const staff of [startsOn, endsOn]) await insertProjectAssignment(db(), tenantA.companyId, staff.employeeId, north.projectId, MONTH);
    await staffOne(planId, startsOn.employeeId, '2027-03-12', 'DAY').expect(201);
    // A NIGHT starting on the last employed day is covered (duty-start-date rule).
    await staffOne(planId, endsOn.employeeId, '2027-03-12', 'NIGHT').expect(201);
    // Absence on the morning after does not block the night that starts the day before.
    await db().query(`INSERT INTO employee_availability_days (company_id, employee_id, day, status) VALUES ($1, $2, '2027-03-14', 'SICK')`,
      [tenantA.companyId, mira.employeeId]);
    await staffOne(planId, mira.employeeId, '2027-03-13', 'NIGHT').expect(201);
  });

  it('half-open UTC overlap across duties, plans and months; adjacency allowed; removed history never conflicts (EL-05, EL-06)', async () => {
    const planId = await createPlan();
    await staffOne(planId, mira.employeeId, '2027-03-15', 'NIGHT').expect(201); // 15th 17:00Z -> 16th 05:00Z
    const overlapping = await staffOne(planId, mira.employeeId, '2027-03-16', 'DAY'); // 16th 05:00Z: adjacent, allowed
    expect(overlapping.status).toBe(201);
    // Another project's duty overlapping in time conflicts, whatever its plan.
    const south = await createSyntheticProject(db(), tenantA.companyId, 'SP11 Sued');
    const southPlan = await insertPlan(db(), tenantA.companyId, south.projectId, MONTH);
    const southDuty = await insertDuty(db(), {
      companyId: tenantA.companyId, projectId: south.projectId, planId: southPlan, month: MONTH, dutyDate: '2027-03-20',
      startsAt: '2027-03-20T08:00:00Z', endsAt: '2027-03-20T12:00:00Z',
    });
    await insertMembership(db(), tenantA.companyId, southDuty, jonas.employeeId);
    const clash = await staffOne(planId, jonas.employeeId, '2027-03-20', 'DAY');
    expect([clash.status, clash.body.code]).toEqual([409, 'DUTY_ASSIGNMENT_CONFLICT']);
    // The same person's REMOVED membership and a tombstoned duty are history, not conflicts.
    await db().query("UPDATE plan_assignments SET state = 'REMOVED', removed_at = clock_timestamp() WHERE duty_id = $1", [southDuty]);
    await staffOne(planId, jonas.employeeId, '2027-03-20', 'DAY').expect(201);
    const tombstoned = await insertDuty(db(), {
      companyId: tenantA.companyId, projectId: south.projectId, planId: southPlan, month: MONTH, dutyDate: '2027-03-21',
      startsAt: '2027-03-21T08:00:00Z', endsAt: '2027-03-21T12:00:00Z', removedAt: '2027-02-01T00:00:00Z',
    });
    await insertMembership(db(), tenantA.companyId, tombstoned, mira.employeeId);
    await staffOne(planId, mira.employeeId, '2027-03-21', 'DAY').expect(201);
  });
});

describe('SP-11 — E-04 factual absence over an assigned duty (E04-01, E04-02, SEC-06)', () => {
  it('a later absence leaves the duty unchanged; the admin read shows one neutral conflict that clears with the fact', async () => {
    const planId = await createPlan();
    const created = (await write(`${BASE}/${planId}/entries`, adminA, {
      dutyDate: '2027-03-10', shiftKind: 'DAY',
      assignments: [{ employeeId: mira.employeeId, dutyRole: 'EMPLOYEE' }, { employeeId: jonas.employeeId, dutyRole: 'EMPLOYEE' }],
    }).expect(201)).body;
    const dutyBefore = (await db().query('SELECT concurrency_version, updated_at FROM duties WHERE id = $1', [created.id])).rows[0];
    for (const status of ['SICK', 'LEAVE']) {
      await db().query(`INSERT INTO employee_availability_days (company_id, employee_id, day, status) VALUES ($1, $2, '2027-03-10', $3)`,
        [tenantA.companyId, mira.employeeId, status]);
      const entries = await read(`${BASE}/${planId}/entries`, adminA).expect(200);
      expect(entries.headers['cache-control']).toBe('no-store');
      const membership = created.assignments.find((a: { employeeId: string }) => a.employeeId === mira.employeeId);
      expect(entries.body.items[0].availabilityConflicts).toEqual([
        { code: 'EMPLOYEE_UNAVAILABLE', assignmentId: membership.id, employeeId: mira.employeeId },
      ]);
      // SICK and LEAVE are indistinguishable; no reason is exposed anywhere in the response.
      expect(JSON.stringify(entries.body)).not.toMatch(/SICK|LEAVE/);
      await db().query('DELETE FROM employee_availability_days WHERE employee_id = $1', [mira.employeeId]);
    }
    expect((await read(`${BASE}/${planId}/entries`, adminA).expect(200)).body.items[0].availabilityConflicts).toEqual([]);
    expect((await db().query('SELECT concurrency_version, updated_at FROM duties WHERE id = $1', [created.id])).rows[0]).toEqual(dutyBefore);
    expect((await read(`${BASE}/${planId}/entries`, employeeSessionA)).status).toBe(403);
    expect((await read(`${BASE}/${planId}/entries`, adminB)).status).toBe(404);
  });
});

describe('SP-11 — tenant isolation (SEC-02)', () => {
  it('foreign plans, entries and members are concealed and never influence results', async () => {
    const planId = await createPlan();
    await write(`${BASE}/${planId}/entries`, adminA, { dutyDate: '2027-03-10', shiftKind: 'DAY' }).expect(201);
    const before = await planningState(db(), tenantA.companyId);
    for (const response of [
      await read(`${BASE}/${planId}`, adminB),
      await read(`${BASE}/${planId}/entries`, adminB),
      await write(`${BASE}/${planId}/entries`, adminB, { dutyDate: '2027-03-11', shiftKind: 'DAY' }),
      await read(`${BASE}/${randomUUID()}`, adminA),
      await read(`${BASE}/not-a-uuid/entries`, adminA),
    ]) {
      expect([response.status, response.body.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    }
    expect((await read(BASE, adminB).expect(200)).body.pagination.totalItems).toBe(0);
    expect(await planningState(db(), tenantA.companyId)).toEqual(before);
  });
});
