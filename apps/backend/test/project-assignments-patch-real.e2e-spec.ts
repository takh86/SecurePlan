/**
 * SP-09 — correction PATCH /project-assignments/{id} against REAL PostgreSQL.
 *
 * Owner decisions 26.10.2026: D1 (future vs. current/past months), D2
 * (historical corrections), D3 (company IANA time zone, boundary tests),
 * D4 (employee reassignment), D5 (audit PROJECT_ASSIGNMENT_CORRECTED).
 * The "current month" comes from an injected wall clock, so the month-boundary
 * cases are deterministic. Synthetic data only; migrated LOCAL PostgreSQL.
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { SessionService } from '../src/auth/session.service.js';
import {
  createSyntheticAccount,
  createSyntheticEmployee,
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
import { assertPlanningDependencyCheckImplemented, PLANNING_TABLES } from '../src/modules/workforce/project-assignments/planning-dependency-guard.js';
import { FailingAudit, ORIGIN, RecordingDelivery, bootEmployeesApp } from './helpers/employees-test-app.js';

const BASE = '/api/v1/project-assignments';
// Pinned instant: 15 Dec 2026 midday UTC -> current month December 2026 (Berlin and UTC alike).
const MID_DEC = () => new Date('2026-12-15T12:00:00Z');

let pool: TestPool | undefined;
let sessions: SessionService;
let app: INestApplication<App> | undefined;
let tenantA: SyntheticTenant;
let tenantB: SyntheticTenant;
let mira: SyntheticEmployee;
let jonas: SyntheticEmployee;
let employeeB: SyntheticEmployee;
let north: SyntheticProject;
let south: SyntheticProject;
let projectB: SyntheticProject;
let adminA: SyntheticSession;
let adminB: SyntheticSession;
const createdCompanies: string[] = [];
let previousOrigin: string | undefined;

function db(): TestPool {
  if (!pool) throw new Error('Test database is unavailable');
  return pool;
}

const http = () => request(app!.getHttpServer());
const read = (path: string, session: SyntheticSession) => http().get(path).set('Cookie', session.cookie);

function patch(id: string, body: object, session: SyntheticSession | null = adminA) {
  let pending = http().patch(`${BASE}/${id}`).set('Origin', ORIGIN);
  if (session) pending = pending.set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf);
  return pending.send(body);
}

/** Direct fixture insert (committed); returns the assignment id. */
async function seed(employee: SyntheticEmployee, project: SyntheticProject, month: string): Promise<string> {
  const id = randomUUID();
  await db().query(
    `INSERT INTO project_assignments (id, company_id, employee_id, project_id, planning_month)
     VALUES ($1, $2, $3, $4, $5::date)`,
    [id, employee.account.companyId, employee.employeeId, project.projectId, month],
  );
  return id;
}

async function row(id: string) {
  return (await db().query(
    `SELECT employee_id, project_id, planning_month::text AS month, updated_at FROM project_assignments WHERE id = $1`,
    [id],
  )).rows[0];
}

async function auditFor(correlationId: string) {
  return (await db().query(
    `SELECT action, resource_type, resource_id, actor_account_id, old_values, new_values
     FROM audit_event WHERE correlation_id = $1`,
    [correlationId],
  )).rows;
}

async function state(companyId: string) {
  const q = async (sql: string) => (await db().query(sql, [companyId])).rows;
  return {
    assignments: await q('SELECT id, employee_id, project_id, planning_month::text, updated_at FROM project_assignments WHERE company_id = $1 ORDER BY id'),
    audit: await q('SELECT id FROM audit_event WHERE company_id = $1 ORDER BY id'),
  };
}

async function bootApp(options: { clock?: () => Date; audit?: FailingAudit } = {}) {
  if (app) await app.close();
  app = await bootEmployeesApp(new RecordingDelivery(), { clock: MID_DEC, ...options });
}

async function setEmployment(employee: SyntheticEmployee, start: string | null, end: string | null) {
  await db().query('UPDATE employees SET employment_start = $2::date, employment_end = $3::date WHERE id = $1', [
    employee.employeeId, start, end,
  ]);
}

beforeAll(() => {
  pool = openLocalTestPool(10);
  sessions = realSessionService(db());
  previousOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
});

beforeEach(async () => {
  tenantA = await createSyntheticTenant(db(), 'SP09 PATCH A');
  createdCompanies.push(tenantA.companyId);
  tenantB = await createSyntheticTenant(db(), 'SP09 PATCH B');
  createdCompanies.push(tenantB.companyId);
  mira = await createSyntheticEmployee(db(), tenantA.employee, 'A-001');
  jonas = await createSyntheticEmployee(db(), await createSyntheticAccount(db(), tenantA.companyId, 'EMPLOYEE'), 'A-002');
  employeeB = await createSyntheticEmployee(db(), tenantB.employee, 'B-001');
  north = await createSyntheticProject(db(), tenantA.companyId, 'Objekt Nord');
  south = await createSyntheticProject(db(), tenantA.companyId, 'Objekt Süd');
  projectB = await createSyntheticProject(db(), tenantB.companyId, 'Objekt B');
  adminA = await createSyntheticSession(sessions, tenantA.admin);
  adminB = await createSyntheticSession(sessions, tenantB.admin);
  await bootApp();
});

afterEach(async () => {
  if (app) await app.close();
  app = undefined;
  const ids = createdCompanies.splice(0);
  try {
    await removeSyntheticTenants(db(), ids);
  } catch (error) {
    throw new Error(`SP-09 PATCH fixture cleanup FAILED for companies ${ids.join(', ')}`, { cause: error });
  }
});

afterAll(async () => {
  await pool?.end();
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousOrigin;
});

describe('SP-09 PATCH — access, validation, concealment', () => {
  it('401 without session, 403 for EMPLOYEE, 403 without Origin/CSRF; nothing changes', async () => {
    const id = await seed(mira, north, '2027-02-01');
    const before = await state(tenantA.companyId);
    expect((await patch(id, { projectId: south.projectId }, null).expect(401)).body.code).toBe('SESSION_REQUIRED');
    const employee = await createSyntheticSession(sessions, tenantA.employee);
    expect((await patch(id, { projectId: south.projectId }, employee).expect(403)).body.code).toBe('ACTION_FORBIDDEN');
    const noOrigin = await http().patch(`${BASE}/${id}`).set('Cookie', adminA.cookie)
      .set('X-CSRF-Token', adminA.csrf).send({ projectId: south.projectId }).expect(403);
    expect(noOrigin.body.code).toBe('CSRF_VALIDATION_FAILED');
    const wrongCsrf = await http().patch(`${BASE}/${id}`).set('Origin', ORIGIN).set('Cookie', adminA.cookie)
      .set('X-CSRF-Token', adminB.csrf).send({ projectId: south.projectId }).expect(403);
    expect(wrongCsrf.body.code).toBe('CSRF_VALIDATION_FAILED');
    expect(await state(tenantA.companyId)).toEqual(before);
  });

  it('a foreign or unknown assignment/employee/project is the same 404; the other tenant stays untouched', async () => {
    const own = await seed(mira, north, '2027-02-01');
    const foreign = await seed(employeeB, projectB, '2027-02-01');
    const beforeA = await state(tenantA.companyId);
    const beforeB = await state(tenantB.companyId);
    const shape = (body: Record<string, unknown>) => {
      const { correlationId, instance, ...rest } = body;
      expect([typeof correlationId, typeof instance]).toEqual(['string', 'string']);
      return rest;
    };
    const reference = await patch(randomUUID(), { projectId: south.projectId }).expect(404);
    // Thunks: supertest requests must be created only when they are sent.
    const attempts = [
      () => patch(foreign, { projectId: south.projectId }),
      () => patch(own, { employeeId: employeeB.employeeId }),
      () => patch(own, { projectId: projectB.projectId }),
      () => patch(own, { employeeId: randomUUID() }),
      () => patch('not-a-uuid', { projectId: south.projectId }),
    ];
    for (const attempt of attempts) {
      const response = await attempt().expect(404);
      expect(response.body.code).toBe('RESOURCE_NOT_FOUND');
      expect(shape(response.body)).toEqual(shape(reference.body));
    }
    expect(await state(tenantA.companyId)).toEqual(beforeA);
    expect(await state(tenantB.companyId)).toEqual(beforeB);
    // Admin B cannot touch tenant A's row either.
    expect((await patch(own, { projectId: projectB.projectId }, adminB).expect(404)).body.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('EMPTY_PATCH, malformed input, INVALID_MONTH_START and tenant/status fields are rejected before any write', async () => {
    const id = await seed(mira, north, '2027-02-01');
    const before = await state(tenantA.companyId);
    expect((await patch(id, {}).expect(400)).body.code).toBe('EMPTY_PATCH');
    expect((await patch(id, { monthStart: '2027-03-15' }).expect(400)).body.code).toBe('INVALID_MONTH_START');
    for (const [body, pointer, code] of [
      [{ employeeId: 'x' }, '#/employeeId', 'INVALID_UUID'],
      [{ projectId: 5 }, '#/projectId', 'INVALID_UUID'],
      [{ monthStart: '2027-02-30' }, '#/monthStart', 'INVALID_FORMAT'],
      [{ monthStart: null }, '#/monthStart', 'INVALID_TYPE'],
    ] as const) {
      const response = await patch(id, body).expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(response.body.errors).toContainEqual(expect.objectContaining({ pointer, code }));
    }
    for (const hint of [{ companyId: tenantB.companyId }, { id: randomUUID() }, { status: 'ACTIVE' }]) {
      expect((await patch(id, { projectId: south.projectId, ...hint }).expect(400)).body.code).toBe('UNKNOWN_FIELD');
    }
    expect(await state(tenantA.companyId)).toEqual(before);
  });
});

describe('SP-09 PATCH — future corrections (D1)', () => {
  it('changes project, month and employee; audits old/new values without personal data', async () => {
    const id = await seed(mira, north, '2027-02-01');
    const response = await patch(id, { projectId: south.projectId, monthStart: '2027-03-01', employeeId: jonas.employeeId.toUpperCase() }).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({ id, employeeId: jonas.employeeId, projectId: south.projectId, monthStart: '2027-03-01' });
    expect(await row(id)).toMatchObject({ employee_id: jonas.employeeId, project_id: south.projectId, month: '2027-03-01' });

    const audit = await auditFor(response.headers['x-correlation-id']);
    expect(audit).toEqual([{
      action: 'PROJECT_ASSIGNMENT_CORRECTED',
      resource_type: 'PROJECT_ASSIGNMENT',
      resource_id: id,
      actor_account_id: tenantA.admin.accountId,
      old_values: { employeeId: mira.employeeId, projectId: north.projectId, monthStart: '2027-02-01' },
      new_values: { scope: 'FUTURE', employeeId: jonas.employeeId, projectId: south.projectId, monthStart: '2027-03-01' },
    }]);
    // Only IDs and months: no names, e-mail addresses or codes.
    expect(JSON.stringify(audit)).not.toMatch(/Synthetic|@secureplan|A-00/);
    // Persisted: a fresh read shows it.
    expect((await read(`${BASE}?monthStart=2027-03-01`, adminA).expect(200)).body.items).toEqual([response.body]);
    expect((await read(`${BASE}?monthStart=2027-02-01`, adminA).expect(200)).body.items).toEqual([]);
  });

  it('a no-op correction answers 200 without a write or audit entry', async () => {
    const id = await seed(mira, north, '2027-02-01');
    const before = await state(tenantA.companyId);
    const response = await patch(id, { projectId: north.projectId, monthStart: '2027-02-01' }).expect(200);
    expect(response.body.projectId).toBe(north.projectId);
    expect(await state(tenantA.companyId)).toEqual(before);
  });

  it('target month taken: other project 409 CONFLICT, same project 409 ALREADY_EXISTS; the row is not changed', async () => {
    const id = await seed(mira, north, '2027-02-01');
    await seed(mira, south, '2027-03-01');
    await seed(jonas, south, '2027-02-01');
    const before = await state(tenantA.companyId);
    expect((await patch(id, { monthStart: '2027-03-01' }).expect(409)).body.code).toBe('PROJECT_ASSIGNMENT_CONFLICT');
    expect((await patch(id, { monthStart: '2027-03-01', projectId: south.projectId }).expect(409)).body.code)
      .toBe('PROJECT_ASSIGNMENT_ALREADY_EXISTS');
    // Reassigning to a person who already has a project that month.
    expect((await patch(id, { employeeId: jonas.employeeId }).expect(409)).body.code).toBe('PROJECT_ASSIGNMENT_CONFLICT');
    expect(await state(tenantA.companyId)).toEqual(before);
  });

  it('future corrections need an ACTIVE employee and project; an ARCHIVED target project is 404', async () => {
    const id = await seed(mira, north, '2027-02-01');
    const inactiveProject = await createSyntheticProject(db(), tenantA.companyId, 'Inaktiv', 'INACTIVE');
    const archived = await createSyntheticProject(db(), tenantA.companyId, 'Archiv', 'ARCHIVED');
    await db().query("UPDATE employees SET status = 'DEACTIVATED' WHERE id = $1", [jonas.employeeId]);
    const before = await state(tenantA.companyId);
    expect((await patch(id, { projectId: inactiveProject.projectId }).expect(409)).body.code).toBe('PROJECT_INACTIVE');
    expect((await patch(id, { employeeId: jonas.employeeId }).expect(409)).body.code).toBe('EMPLOYEE_INACTIVE');
    expect((await patch(id, { projectId: archived.projectId }).expect(404)).body.code).toBe('RESOURCE_NOT_FOUND');
    // Even an unchanged inactive reference blocks a FUTURE correction.
    await db().query("UPDATE projects SET status = 'INACTIVE' WHERE id = $1", [north.projectId]);
    expect((await patch(id, { monthStart: '2027-04-01' }).expect(409)).body.code).toBe('PROJECT_INACTIVE');
    expect((await state(tenantA.companyId)).assignments).toEqual(before.assignments);
  });
});

describe('SP-09 PATCH — historical corrections (D1/D2)', () => {
  it('the current and past months can be corrected; an already referenced inactive project may stay', async () => {
    const current = await seed(mira, north, '2026-12-01');
    const past = await seed(jonas, north, '2026-09-01');
    await db().query("UPDATE projects SET status = 'INACTIVE' WHERE id = $1", [north.projectId]);
    // Unchanged inactive project, only the month moves within history: allowed.
    const moved = await patch(past, { monthStart: '2026-08-01' }).expect(200);
    expect(moved.body.monthStart).toBe('2026-08-01');
    expect((await auditFor(moved.headers['x-correlation-id']))[0].new_values).toMatchObject({ scope: 'HISTORICAL' });
    // The current month is historical scope too: a project-only correction to an ACTIVE project works.
    const fixed = await patch(current, { projectId: south.projectId }).expect(200);
    expect(fixed.body.projectId).toBe(south.projectId);
    expect((await auditFor(fixed.headers['x-correlation-id']))[0].new_values).toMatchObject({ scope: 'HISTORICAL' });
  });

  it('a newly referenced inactive project or employee is refused in history', async () => {
    const id = await seed(mira, north, '2026-10-01');
    const inactiveProject = await createSyntheticProject(db(), tenantA.companyId, 'Inaktiv', 'INACTIVE');
    expect((await patch(id, { projectId: inactiveProject.projectId }).expect(409)).body.code).toBe('PROJECT_INACTIVE');
    await setEmployment(jonas, '2026-01-01', null);
    await db().query("UPDATE employees SET status = 'DEACTIVATED' WHERE id = $1", [jonas.employeeId]);
    expect((await patch(id, { employeeId: jonas.employeeId }).expect(409)).body.code).toBe('EMPLOYEE_INACTIVE');
    expect(await row(id)).toMatchObject({ employee_id: mira.employeeId, project_id: north.projectId });
  });

  it('historical employee reassignment needs documented employment covering the month; missing evidence is not valid', async () => {
    const id = await seed(mira, north, '2026-10-01');
    const before = await state(tenantA.companyId);
    // No employment start recorded: no evidence.
    expect((await patch(id, { employeeId: jonas.employeeId }).expect(409)).body.code)
      .toBe('PROJECT_ASSIGNMENT_CORRECTION_CONFLICT');
    // Hired after the month, or left before it: no evidence either.
    await setEmployment(jonas, '2026-11-01', null);
    expect((await patch(id, { employeeId: jonas.employeeId }).expect(409)).body.code)
      .toBe('PROJECT_ASSIGNMENT_CORRECTION_CONFLICT');
    await setEmployment(jonas, '2025-01-01', '2026-09-30');
    expect((await patch(id, { employeeId: jonas.employeeId }).expect(409)).body.code)
      .toBe('PROJECT_ASSIGNMENT_CORRECTION_CONFLICT');
    expect(await state(tenantA.companyId)).toEqual(before);
    // Employment covering October (boundaries inclusive): allowed.
    await setEmployment(jonas, '2026-10-31', '2026-10-31');
    const ok = await patch(id, { employeeId: jonas.employeeId }).expect(200);
    expect(ok.body.employeeId).toBe(jonas.employeeId);
    expect((await auditFor(ok.headers['x-correlation-id']))[0].new_values).toMatchObject({ scope: 'HISTORICAL' });
  });

  it('moving a past record into the future is a historical correction (old month counts)', async () => {
    const id = await seed(mira, north, '2026-10-01');
    const response = await patch(id, { monthStart: '2027-01-01' }).expect(200);
    expect(response.body.monthStart).toBe('2027-01-01');
    expect((await auditFor(response.headers['x-correlation-id']))[0].new_values).toMatchObject({ scope: 'HISTORICAL' });
  });
});

describe('SP-09 PATCH — company time zone and month boundaries (D3)', () => {
  const setZone = (zone: string) => db().query('UPDATE companies SET time_zone = $2 WHERE id = $1', [tenantA.companyId, zone]);

  it('Europe/Berlin: 23:30 UTC on 31 Oct is already November, so November is the current (historical) month', async () => {
    await bootApp({ clock: () => new Date('2026-10-31T23:30:00Z') });
    // Berlin is UTC+1 here (DST ended 25 Oct): local 01 Nov 00:30. Moving to November is HISTORICAL scope.
    const id = await seed(mira, north, '2026-12-01');
    const moved = await patch(id, { monthStart: '2026-11-01' }).expect(200);
    expect((await auditFor(moved.headers['x-correlation-id']))[0].new_values).toMatchObject({ scope: 'HISTORICAL' });
    // A newly referenced inactive project is refused for November (historical rules) ...
    const inactive = await createSyntheticProject(db(), tenantA.companyId, 'Inaktiv', 'INACTIVE');
    expect((await patch(id, { projectId: inactive.projectId }).expect(409)).body.code).toBe('PROJECT_INACTIVE');
  });

  it('the same instant is still October in America/New_York (UTC would say November)', async () => {
    await setZone('America/New_York');
    await bootApp({ clock: () => new Date('2026-11-01T03:30:00Z') }); // local 31 Oct 23:30
    await setEmployment(jonas, null, null);
    const id = await seed(mira, north, '2026-12-01');
    // November is a FUTURE month here: a future correction to an employee without employment evidence passes,
    // which a historical one would refuse. (Employment rules apply to history only.)
    const response = await patch(id, { monthStart: '2026-11-01', employeeId: jonas.employeeId }).expect(200);
    expect((await auditFor(response.headers['x-correlation-id']))[0].new_values).toMatchObject({ scope: 'FUTURE' });
  });

  it('year boundary: 31 Dec 23:30 UTC is already January 2027 in Berlin but still December in New York', async () => {
    const instant = () => new Date('2026-12-31T23:30:00Z');
    await bootApp({ clock: instant });
    const berlin = await seed(mira, north, '2027-02-01');
    // Berlin: January 2027 is current, so moving a Feb record to Jan is historical (jonas has no evidence -> refused).
    expect((await patch(berlin, { monthStart: '2027-01-01', employeeId: jonas.employeeId }).expect(409)).body.code)
      .toBe('PROJECT_ASSIGNMENT_CORRECTION_CONFLICT');
    await setZone('America/New_York');
    await bootApp({ clock: instant });
    // New York: December 2026 is current, January 2027 is future -> same request passes as FUTURE.
    const response = await patch(berlin, { monthStart: '2027-01-01', employeeId: jonas.employeeId }).expect(200);
    expect((await auditFor(response.headers['x-correlation-id']))[0].new_values).toMatchObject({ scope: 'FUTURE' });
  });
});

describe('SP-09 PATCH — rollback and planning protection', () => {
  it('an audit failure rolls the correction back completely', async () => {
    const id = await seed(mira, north, '2027-02-01');
    await bootApp({ audit: new FailingAudit('PROJECT_ASSIGNMENT_CORRECTED') });
    const before = await state(tenantA.companyId);
    expect((await patch(id, { projectId: south.projectId }).expect(500)).body.code).toBe('INTERNAL_ERROR');
    expect(await state(tenantA.companyId)).toEqual(before);
  });

  it('DB constraints still hold for corrections made directly in SQL (month start, tenant FKs, uniqueness)', async () => {
    const id = await seed(mira, north, '2027-02-01');
    await seed(jonas, north, '2027-02-01');
    await expect(db().query("UPDATE project_assignments SET planning_month = '2027-02-15' WHERE id = $1", [id]))
      .rejects.toMatchObject({ code: '23514', constraint: 'ck_project_assignments__month_start' });
    await expect(db().query('UPDATE project_assignments SET employee_id = $2 WHERE id = $1', [id, employeeB.employeeId]))
      .rejects.toMatchObject({ code: '23503', constraint: 'fk_project_assignments__employees' });
    await expect(db().query('UPDATE project_assignments SET employee_id = $2 WHERE id = $1', [id, jonas.employeeId]))
      .rejects.toMatchObject({ code: '23505', constraint: 'uq_project_assignments__employee_month' });
  });

  it('SP-11 tripwire: once ANY planning table exists, corrections fail closed until the real dependency check replaces the guard', async () => {
    // Today none of the planning tables exists; that is not treated as proof of safety by itself.
    const probe = await db().connect();
    try {
      await expect(assertPlanningDependencyCheckImplemented(probe)).resolves.toBeUndefined();
      for (const table of PLANNING_TABLES) {
        // DDL inside a transaction is invisible to every other connection and rolled back afterwards.
        await probe.query('BEGIN');
        try {
          await probe.query(`CREATE TABLE public.${table} (id uuid)`);
          await expect(assertPlanningDependencyCheckImplemented(probe)).rejects.toMatchObject({
            response: { code: 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT' },
          });
        } finally {
          await probe.query('ROLLBACK');
        }
      }
    } finally {
      probe.release();
    }
  });
});