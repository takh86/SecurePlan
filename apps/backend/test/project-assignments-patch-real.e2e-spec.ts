/**
 * SP-09 — correction PATCH /project-assignments/{id} against REAL PostgreSQL.
 *
 * Owner decisions 26.10.2026: D1 (future vs. current/past months), D2
 * (historical corrections), D3 (company IANA time zone, boundary tests),
 * D4 (employee reassignment), D5 (audit PROJECT_ASSIGNMENT_CORRECTED).
 * #64 case 1 (owner decision 1a, 28.10.2026): FUTURE corrections need the same
 * employment evidence for the resulting employee and month as POST.
 * #64 owner decision B (28.10.2026): so does a HISTORICAL correction into a
 * future target month, also for an unchanged employee.
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
import { assertPlanningDependencyCheckImplemented } from '../src/modules/workforce/project-assignments/planning-dependency-guard.js';
import { PLANNING_GUARD_TABLES } from '../src/modules/workforce/planning-guard/planning-table-classification.js';
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
  // Documented employment by default (#64 case 1); tests that need missing evidence set it explicitly.
  mira = await createSyntheticEmployee(db(), tenantA.employee, 'A-001', { start: '2020-01-01' });
  jonas = await createSyntheticEmployee(
    db(), await createSyntheticAccount(db(), tenantA.companyId, 'EMPLOYEE'), 'A-002', { start: '2020-01-01' },
  );
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

describe('#64 case 1 — FUTURE corrections need employment evidence for the resulting employee and month (1a)', () => {
  it('project only: the unchanged employee must still be employed in the unchanged month; a refusal leaves no trace', async () => {
    const id = await seed(mira, north, '2027-02-01');
    // A later master-data change left the stored row without evidence (case 2 does not block that yet).
    await setEmployment(mira, '2020-01-01', '2027-01-31');
    const before = await state(tenantA.companyId);
    const refused = await patch(id, { projectId: south.projectId }).expect(409);
    expect(refused.body.code).toBe('EMPLOYEE_NOT_EMPLOYED_FOR_MONTH');
    expect(await auditFor(refused.headers['x-correlation-id'])).toEqual([]);
    // A missing employment start is no evidence, whatever the end says.
    await setEmployment(mira, null, '2030-12-31');
    expect((await patch(id, { projectId: south.projectId }).expect(409)).body.code).toBe('EMPLOYEE_NOT_EMPLOYED_FOR_MONTH');
    expect(await state(tenantA.companyId)).toEqual(before);

    // An employment end on the 1st of the month counts (inclusive).
    await setEmployment(mira, '2020-01-01', '2027-02-01');
    const ok = await patch(id, { projectId: south.projectId }).expect(200);
    expect(ok.body).toEqual({ id, employeeId: mira.employeeId, projectId: south.projectId, monthStart: '2027-02-01' });
    expect(await auditFor(ok.headers['x-correlation-id'])).toEqual([expect.objectContaining({
      old_values: { projectId: north.projectId },
      new_values: { scope: 'FUTURE', projectId: south.projectId },
    })]);
  });

  it('month only: the evidence is checked for the TARGET month, not for the stored one', async () => {
    const id = await seed(mira, north, '2027-02-01');
    await setEmployment(mira, '2020-01-01', '2027-02-28');
    expect((await patch(id, { monthStart: '2027-03-01' }).expect(409)).body.code).toBe('EMPLOYEE_NOT_EMPLOYED_FOR_MONTH');
    expect(await row(id)).toMatchObject({ month: '2027-02-01' });
    // Hired on 29 Feb 2028: February 2027 (stored) has no evidence, February 2028 (target) has.
    await setEmployment(mira, '2028-02-29', null);
    expect((await patch(id, { monthStart: '2028-01-01' }).expect(409)).body.code).toBe('EMPLOYEE_NOT_EMPLOYED_FOR_MONTH');
    expect((await patch(id, { monthStart: '2028-02-01' }).expect(200)).body.monthStart).toBe('2028-02-01');
  });

  it('employee only: the newly referenced employee needs evidence; the previous one no longer matters', async () => {
    const id = await seed(mira, north, '2027-02-01');
    const before = await state(tenantA.companyId);
    for (const [start, end] of [
      [null, null], // nothing documented
      [null, '2030-12-31'], // end without start
      ['2027-03-01', null], // hired the day after the month
      ['2020-01-01', '2027-01-31'], // left the day before the month
    ] as const) {
      await setEmployment(jonas, start, end);
      expect((await patch(id, { employeeId: jonas.employeeId }).expect(409)).body.code).toBe('EMPLOYEE_NOT_EMPLOYED_FOR_MONTH');
    }
    expect(await state(tenantA.companyId)).toEqual(before);

    await setEmployment(mira, null, null);
    await setEmployment(jonas, '2027-02-28', null); // hired on the last day of the month
    const ok = await patch(id, { employeeId: jonas.employeeId }).expect(200);
    expect(ok.body.employeeId).toBe(jonas.employeeId);
  });

  it('combined: employee, project and month change together; only the resulting employee and month count', async () => {
    const id = await seed(mira, north, '2027-02-01');
    await setEmployment(jonas, '2027-04-01', null);
    const before = await state(tenantA.companyId);
    const all = (monthStart: string) => ({ employeeId: jonas.employeeId, projectId: south.projectId, monthStart });
    expect((await patch(id, all('2027-03-01')).expect(409)).body.code).toBe('EMPLOYEE_NOT_EMPLOYED_FOR_MONTH');
    expect(await state(tenantA.companyId)).toEqual(before);
    const ok = await patch(id, all('2027-04-01')).expect(200);
    expect(ok.body).toEqual({ id, ...all('2027-04-01') });
  });

  it('precedence as for POST: 404, then EMPLOYEE_INACTIVE/PROJECT_INACTIVE, then employment, then the taken month', async () => {
    const id = await seed(mira, north, '2027-02-01');
    await seed(jonas, south, '2027-02-01'); // jonas already has a project in February
    await setEmployment(jonas, null, null);
    const inactive = await createSyntheticProject(db(), tenantA.companyId, 'Inaktiv', 'INACTIVE');
    const before = await state(tenantA.companyId);
    // Missing evidence wins over the taken target month ...
    expect((await patch(id, { employeeId: jonas.employeeId }).expect(409)).body.code).toBe('EMPLOYEE_NOT_EMPLOYED_FOR_MONTH');
    // ... an inactive project or employee wins over missing evidence ...
    await setEmployment(mira, null, null);
    expect((await patch(id, { projectId: inactive.projectId }).expect(409)).body.code).toBe('PROJECT_INACTIVE');
    await db().query("UPDATE employees SET status = 'DEACTIVATED' WHERE id = $1", [jonas.employeeId]);
    expect((await patch(id, { employeeId: jonas.employeeId }).expect(409)).body.code).toBe('EMPLOYEE_INACTIVE');
    // ... and an unknown employee is a 404 before any of them.
    expect((await patch(id, { employeeId: randomUUID() }).expect(404)).body.code).toBe('RESOURCE_NOT_FOUND');
    expect(await state(tenantA.companyId)).toEqual(before);
  });

  it('a no-op stays a no-op even if the stored row lacks evidence: 200, no write, no audit', async () => {
    const id = await seed(mira, north, '2027-02-01');
    await setEmployment(mira, null, null);
    const before = await state(tenantA.companyId);
    // Nothing is corrected, so there is no new state to validate (existing no-op contract, like the status rules).
    const response = await patch(id, { employeeId: mira.employeeId, projectId: north.projectId, monthStart: '2027-02-01' })
      .expect(200);
    expect(response.body).toEqual({ id, employeeId: mira.employeeId, projectId: north.projectId, monthStart: '2027-02-01' });
    expect(await state(tenantA.companyId)).toEqual(before);
  });

  it('tenant isolation: a foreign employee never counts and a foreign admin cannot probe employment', async () => {
    const id = await seed(mira, north, '2027-02-01');
    await setEmployment(mira, null, null);
    await setEmployment(employeeB, '2020-01-01', null);
    const beforeA = await state(tenantA.companyId);
    const beforeB = await state(tenantB.companyId);
    const shape = (body: Record<string, unknown>) => {
      const { correlationId, instance, ...rest } = body;
      expect([typeof correlationId, typeof instance]).toEqual(['string', 'string']);
      return rest;
    };
    const reference = await patch(randomUUID(), { projectId: south.projectId }, adminB).expect(404);
    // Tenant B's employee has evidence, but is invisible to tenant A: 404, not 200.
    const foreignEmployee = await patch(id, { employeeId: employeeB.employeeId }).expect(404);
    expect(shape(foreignEmployee.body)).toEqual(shape(reference.body));
    // Tenant A's admin gets the 409; admin B gets the same 404 as for an unknown id.
    expect((await patch(id, { projectId: south.projectId }).expect(409)).body.code).toBe('EMPLOYEE_NOT_EMPLOYED_FOR_MONTH');
    const foreignAdmin = await patch(id, { projectId: south.projectId }, adminB).expect(404);
    expect(shape(foreignAdmin.body)).toEqual(shape(reference.body));
    expect(await state(tenantA.companyId)).toEqual(beforeA);
    expect(await state(tenantB.companyId)).toEqual(beforeB);
  });

  it('HISTORICAL corrections keep their contract: no evidence check without an employee change, D2 code otherwise', async () => {
    const current = await seed(mira, north, '2026-12-01');
    const past = await seed(mira, south, '2026-09-01');
    await setEmployment(mira, null, null);
    await setEmployment(jonas, null, null);
    // Project only in the current month, month only within history: allowed without evidence, as before.
    expect((await patch(current, { projectId: south.projectId }).expect(200)).body.projectId).toBe(south.projectId);
    expect((await patch(past, { monthStart: '2026-08-01' }).expect(200)).body.monthStart).toBe('2026-08-01');
    // A newly referenced employee keeps the historical code, not POST's.
    expect((await patch(past, { employeeId: jonas.employeeId }).expect(409)).body.code)
      .toBe('PROJECT_ASSIGNMENT_CORRECTION_CONFLICT');
  });
});

describe('#64 decision B — HISTORICAL→FUTURE corrections need employment evidence for the target month', () => {
  it('unchanged employee without evidence for the future target month: 409 EMPLOYEE_NOT_EMPLOYED_FOR_MONTH, nothing written', async () => {
    const past = await seed(mira, north, '2026-10-01');
    const current = await seed(mira, south, '2026-12-01'); // the current month counts as historical (D1)
    const before = await state(tenantA.companyId);
    for (const [start, end] of [
      [null, null], // nothing documented
      [null, '2030-12-31'], // end without start
      ['2020-01-01', '2026-12-31'], // left at the end of the current month
      ['2027-03-01', null], // hired after the target month
    ] as const) {
      await setEmployment(mira, start, end);
      for (const [id, body] of [
        [past, { monthStart: '2027-02-01' }],
        [current, { monthStart: '2027-02-01', projectId: north.projectId }],
      ] as const) {
        const refused = await patch(id, body).expect(409);
        expect(refused.body.code).toBe('EMPLOYEE_NOT_EMPLOYED_FOR_MONTH');
        expect(await auditFor(refused.headers['x-correlation-id'])).toEqual([]);
      }
    }
    expect(await state(tenantA.companyId)).toEqual(before);
  });

  it('unchanged employee with evidence for the target month: 200, audited as HISTORICAL scope and persisted', async () => {
    const past = await seed(mira, north, '2026-10-01');
    await setEmployment(mira, '2020-01-01', '2027-02-01'); // ends on the 1st of the target month
    const response = await patch(past, { monthStart: '2027-02-01', projectId: south.projectId }).expect(200);
    expect(response.body).toEqual({ id: past, employeeId: mira.employeeId, projectId: south.projectId, monthStart: '2027-02-01' });
    expect(await auditFor(response.headers['x-correlation-id'])).toEqual([{
      action: 'PROJECT_ASSIGNMENT_CORRECTED',
      resource_type: 'PROJECT_ASSIGNMENT',
      resource_id: past,
      actor_account_id: tenantA.admin.accountId,
      old_values: { projectId: north.projectId, monthStart: '2026-10-01' },
      // Classification unchanged (D1): the old month counts, so the scope stays HISTORICAL.
      new_values: { scope: 'HISTORICAL', projectId: south.projectId, monthStart: '2027-02-01' },
    }]);
    expect((await read(`${BASE}?monthStart=2027-02-01`, adminA).expect(200)).body.items).toEqual([response.body]);

    // From the current month: one month too far is refused, the covered month is accepted.
    const current = await seed(mira, north, '2026-12-01');
    expect((await patch(current, { monthStart: '2027-03-01' }).expect(409)).body.code).toBe('EMPLOYEE_NOT_EMPLOYED_FOR_MONTH');
    expect((await patch(current, { monthStart: '2027-01-01' }).expect(200)).body.monthStart).toBe('2027-01-01');
  });

  it('target-month boundaries are inclusive and leap February counts', async () => {
    const id = await seed(mira, north, '2026-11-01');
    const before = await state(tenantA.companyId);
    // Left the day before the target month, or hired the day after it: no overlap.
    await setEmployment(mira, '2020-01-01', '2027-02-28');
    expect((await patch(id, { monthStart: '2027-03-01' }).expect(409)).body.code).toBe('EMPLOYEE_NOT_EMPLOYED_FOR_MONTH');
    await setEmployment(mira, '2027-04-01', null);
    expect((await patch(id, { monthStart: '2027-03-01' }).expect(409)).body.code).toBe('EMPLOYEE_NOT_EMPLOYED_FOR_MONTH');
    expect(await state(tenantA.companyId)).toEqual(before);
    // Hired on the last day of the target month: overlaps.
    await setEmployment(mira, '2027-03-31', null);
    expect((await patch(id, { monthStart: '2027-03-01' }).expect(200)).body.monthStart).toBe('2027-03-01');

    // Hired on 29 Feb 2028: January 2028 has no evidence, February 2028 has.
    const leap = await seed(mira, south, '2026-10-01');
    await setEmployment(mira, '2028-02-29', null);
    expect((await patch(leap, { monthStart: '2028-01-01' }).expect(409)).body.code).toBe('EMPLOYEE_NOT_EMPLOYED_FOR_MONTH');
    const ok = await patch(leap, { monthStart: '2028-02-01' }).expect(200);
    expect((await auditFor(ok.headers['x-correlation-id']))[0].new_values).toEqual({ scope: 'HISTORICAL', monthStart: '2028-02-01' });
  });

  it('an employee change keeps the historical employee-change contract, checked for the target month', async () => {
    const id = await seed(mira, north, '2026-10-01');
    await setEmployment(mira, null, null); // the previous employee no longer matters
    const before = await state(tenantA.companyId);
    for (const [start, end] of [
      [null, null],
      ['2020-01-01', '2027-01-31'], // left before the target month
      ['2027-03-01', null], // hired after it
    ] as const) {
      await setEmployment(jonas, start, end);
      expect((await patch(id, { employeeId: jonas.employeeId, monthStart: '2027-02-01' }).expect(409)).body.code)
        .toBe('PROJECT_ASSIGNMENT_CORRECTION_CONFLICT');
    }
    expect(await state(tenantA.companyId)).toEqual(before);

    await setEmployment(jonas, '2027-02-28', null);
    const ok = await patch(id, { employeeId: jonas.employeeId, monthStart: '2027-02-01' }).expect(200);
    expect(await auditFor(ok.headers['x-correlation-id'])).toEqual([expect.objectContaining({
      old_values: { employeeId: mira.employeeId, monthStart: '2026-10-01' },
      new_values: { scope: 'HISTORICAL', employeeId: jonas.employeeId, monthStart: '2027-02-01' },
    })]);

    // A newly referenced inactive employee is refused before the evidence, as in every historical correction.
    const other = await seed(mira, south, '2026-11-01');
    await db().query("UPDATE employees SET status = 'DEACTIVATED' WHERE id = $1", [jonas.employeeId]);
    expect((await patch(other, { employeeId: jonas.employeeId, monthStart: '2027-03-01' }).expect(409)).body.code)
      .toBe('EMPLOYEE_INACTIVE');
  });

  it('within history nothing new is checked: past→past, past→current, future→past and project only', async () => {
    const past = await seed(mira, north, '2026-09-01');
    const future = await seed(mira, south, '2027-03-01');
    await setEmployment(mira, null, null);
    expect((await patch(past, { monthStart: '2026-10-01' }).expect(200)).body.monthStart).toBe('2026-10-01');
    expect((await patch(past, { monthStart: '2026-12-01' }).expect(200)).body.monthStart).toBe('2026-12-01');
    expect((await patch(past, { projectId: south.projectId }).expect(200)).body.projectId).toBe(south.projectId);
    const back = await patch(future, { monthStart: '2026-11-01' }).expect(200);
    expect((await auditFor(back.headers['x-correlation-id']))[0].new_values).toEqual({ scope: 'HISTORICAL', monthStart: '2026-11-01' });
  });

  it('precedence: 404, then a newly referenced inactive project, then employment, then the taken target month', async () => {
    const id = await seed(mira, north, '2026-10-01');
    await seed(mira, south, '2027-02-01'); // mira's target month is taken
    const inactive = await createSyntheticProject(db(), tenantA.companyId, 'Inaktiv', 'INACTIVE');
    await setEmployment(mira, '2020-01-01', '2026-12-31');
    const before = await state(tenantA.companyId);
    // Missing evidence wins over the taken target month ...
    expect((await patch(id, { monthStart: '2027-02-01' }).expect(409)).body.code).toBe('EMPLOYEE_NOT_EMPLOYED_FOR_MONTH');
    // ... a newly referenced inactive project wins over missing evidence ...
    expect((await patch(id, { monthStart: '2027-02-01', projectId: inactive.projectId }).expect(409)).body.code)
      .toBe('PROJECT_INACTIVE');
    // ... and an unknown project is a 404 before any of them.
    expect((await patch(id, { monthStart: '2027-02-01', projectId: randomUUID() }).expect(404)).body.code)
      .toBe('RESOURCE_NOT_FOUND');
    // With evidence, the taken month decides as before.
    await setEmployment(mira, '2020-01-01', null);
    expect((await patch(id, { monthStart: '2027-02-01' }).expect(409)).body.code).toBe('PROJECT_ASSIGNMENT_CONFLICT');
    expect((await patch(id, { monthStart: '2027-02-01', projectId: south.projectId }).expect(409)).body.code)
      .toBe('PROJECT_ASSIGNMENT_ALREADY_EXISTS');
    expect(await state(tenantA.companyId)).toEqual(before);
  });

  it('a genuine no-op on a historical row stays 200 without write or audit, even without evidence', async () => {
    const id = await seed(mira, north, '2026-10-01');
    await setEmployment(mira, null, null);
    const before = await state(tenantA.companyId);
    const response = await patch(id, { employeeId: mira.employeeId.toUpperCase(), projectId: north.projectId, monthStart: '2026-10-01' })
      .expect(200);
    expect(response.body).toEqual({ id, employeeId: mira.employeeId, projectId: north.projectId, monthStart: '2026-10-01' });
    expect(await state(tenantA.companyId)).toEqual(before);
  });

  it('actor authorization and tenant isolation come before the employment check', async () => {
    const id = await seed(mira, north, '2026-10-01');
    await setEmployment(mira, null, null);
    await setEmployment(employeeB, '2020-01-01', null);
    const beforeA = await state(tenantA.companyId);
    const beforeB = await state(tenantB.companyId);
    const move = { monthStart: '2027-02-01' };
    const shape = (body: Record<string, unknown>) => {
      const { correlationId, instance, ...rest } = body;
      expect([typeof correlationId, typeof instance]).toEqual(['string', 'string']);
      return rest;
    };
    // No session, an EMPLOYEE session, a foreign CSRF token: refused without revealing the employment state.
    expect((await patch(id, move, null).expect(401)).body.code).toBe('SESSION_REQUIRED');
    const employee = await createSyntheticSession(sessions, tenantA.employee);
    expect((await patch(id, move, employee).expect(403)).body.code).toBe('ACTION_FORBIDDEN');
    const wrongCsrf = await http().patch(`${BASE}/${id}`).set('Origin', ORIGIN).set('Cookie', adminA.cookie)
      .set('X-CSRF-Token', adminB.csrf).send(move).expect(403);
    expect(wrongCsrf.body.code).toBe('CSRF_VALIDATION_FAILED');
    // Tenant B's admin gets the same 404 as for an unknown id; tenant A's admin gets the 409.
    const reference = await patch(randomUUID(), move, adminB).expect(404);
    expect(shape((await patch(id, move, adminB).expect(404)).body)).toEqual(shape(reference.body));
    expect((await patch(id, move).expect(409)).body.code).toBe('EMPLOYEE_NOT_EMPLOYED_FOR_MONTH');
    // Tenant B's employee has evidence but is invisible to tenant A.
    const foreignEmployee = await patch(id, { ...move, employeeId: employeeB.employeeId }).expect(404);
    expect(shape(foreignEmployee.body)).toEqual(shape(reference.body));
    expect(await state(tenantA.companyId)).toEqual(beforeA);
    expect(await state(tenantB.companyId)).toEqual(beforeB);
  });

  it('OPEN (not decided): status rules stay historical, so an already referenced inactive employee or inactive/archived project may move into a future month', async () => {
    // Pins the unchanged contract rather than endorsing it: decision B adds only the employment check.
    // POST and FUTURE corrections would refuse these rows (EMPLOYEE_INACTIVE / PROJECT_INACTIVE).
    const id = await seed(mira, north, '2026-10-01');
    const archived = await seed(jonas, south, '2026-10-01');
    await db().query("UPDATE projects SET status = 'INACTIVE' WHERE id = $1", [north.projectId]);
    await db().query("UPDATE projects SET status = 'ARCHIVED' WHERE id = $1", [south.projectId]);
    await db().query("UPDATE employees SET status = 'DEACTIVATED' WHERE id = $1", [mira.employeeId]);
    const response = await patch(id, { monthStart: '2027-02-01' }).expect(200);
    expect((await auditFor(response.headers['x-correlation-id']))[0].new_values).toEqual({ scope: 'HISTORICAL', monthStart: '2027-02-01' });
    expect((await patch(archived, { monthStart: '2027-02-01' }).expect(200)).body.monthStart).toBe('2027-02-01');
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
    await setEmployment(jonas, null, null);
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

  it('employment boundaries (inclusive) across month changes: end on the 1st counts, end the day before does not', async () => {
    const id = await seed(mira, north, '2026-10-01');
    // Employed until exactly 1 Nov: overlaps November, so October -> November with jonas works.
    await setEmployment(jonas, '2020-01-01', '2026-11-01');
    const ok = await patch(id, { employeeId: jonas.employeeId, monthStart: '2026-11-01' }).expect(200);
    expect(ok.body).toMatchObject({ employeeId: jonas.employeeId, monthStart: '2026-11-01' });
    // The evidence is checked for the TARGET month: ended 31 Oct -> November has no evidence.
    const other = await seed(mira, south, '2026-09-01');
    await setEmployment(jonas, '2020-01-01', '2026-10-31');
    expect((await patch(other, { employeeId: jonas.employeeId, monthStart: '2026-11-01' }).expect(409)).body.code)
      .toBe('PROJECT_ASSIGNMENT_CORRECTION_CONFLICT');
    // The refused correction changed nothing.
    expect(await row(other)).toMatchObject({ employee_id: mira.employeeId, month: '2026-09-01' });
  });

  it('an ARCHIVED project already referenced stays correctable in history; a future correction is refused', async () => {
    const past = await seed(mira, north, '2026-10-01');
    const future = await seed(jonas, north, '2027-02-01');
    await db().query("UPDATE projects SET status = 'ARCHIVED' WHERE id = $1", [north.projectId]);
    expect((await patch(past, { monthStart: '2026-09-01' }).expect(200)).body.monthStart).toBe('2026-09-01');
    expect((await patch(future, { monthStart: '2027-03-01' }).expect(409)).body.code).toBe('PROJECT_INACTIVE');
    // Moving an assignment ONTO the archived project is invisible: 404, not 409.
    const elsewhere = await seed(mira, south, '2027-05-01');
    expect((await patch(elsewhere, { projectId: north.projectId }).expect(404)).body.code).toBe('RESOURCE_NOT_FOUND');
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
    // November is a FUTURE month here: missing evidence gets POST's code (#64 case 1),
    // not the historical PROJECT_ASSIGNMENT_CORRECTION_CONFLICT.
    expect((await patch(id, { monthStart: '2026-11-01', employeeId: jonas.employeeId }).expect(409)).body.code)
      .toBe('EMPLOYEE_NOT_EMPLOYED_FOR_MONTH');
    await setEmployment(jonas, '2026-11-30', null);
    const response = await patch(id, { monthStart: '2026-11-01', employeeId: jonas.employeeId }).expect(200);
    expect((await auditFor(response.headers['x-correlation-id']))[0].new_values).toMatchObject({ scope: 'FUTURE' });
  });

  it('year boundary: 31 Dec 23:30 UTC is already January 2027 in Berlin but still December in New York', async () => {
    const instant = () => new Date('2026-12-31T23:30:00Z');
    await bootApp({ clock: instant });
    const berlin = await seed(mira, north, '2027-02-01');
    await setEmployment(jonas, null, null);
    // Berlin: January 2027 is current, so moving a Feb record to Jan is historical (jonas has no evidence -> refused).
    expect((await patch(berlin, { monthStart: '2027-01-01', employeeId: jonas.employeeId }).expect(409)).body.code)
      .toBe('PROJECT_ASSIGNMENT_CORRECTION_CONFLICT');
    await setZone('America/New_York');
    await bootApp({ clock: instant });
    // New York: December 2026 is current, January 2027 is future -> the same request is FUTURE: POST's code.
    expect((await patch(berlin, { monthStart: '2027-01-01', employeeId: jonas.employeeId }).expect(409)).body.code)
      .toBe('EMPLOYEE_NOT_EMPLOYED_FOR_MONTH');
    await setEmployment(jonas, '2027-01-01', null);
    const response = await patch(berlin, { monthStart: '2027-01-01', employeeId: jonas.employeeId }).expect(200);
    expect((await auditFor(response.headers['x-correlation-id']))[0].new_values).toMatchObject({ scope: 'FUTURE' });
  });

  it('decision B: at 03:30 UTC on 1 Nov, October→November is HISTORICAL→FUTURE in New York but stays within history in Berlin', async () => {
    await bootApp({ clock: () => new Date('2026-11-01T03:30:00Z') }); // New York 31 Oct 23:30, Berlin 1 Nov 04:30
    const id = await seed(mira, north, '2026-10-01');
    await setEmployment(mira, '2020-01-01', '2026-10-31');
    await setZone('America/New_York');
    // October is current, November future: mira left on 31 Oct, so the move is refused.
    expect((await patch(id, { monthStart: '2026-11-01' }).expect(409)).body.code).toBe('EMPLOYEE_NOT_EMPLOYED_FOR_MONTH');
    expect(await row(id)).toMatchObject({ month: '2026-10-01' });
    await setZone('Europe/Berlin');
    // November is already the current month: a correction within history, no evidence check (D2).
    const moved = await patch(id, { monthStart: '2026-11-01' }).expect(200);
    expect((await auditFor(moved.headers['x-correlation-id']))[0].new_values).toEqual({ scope: 'HISTORICAL', monthStart: '2026-11-01' });
  });

  it('decision B at the year boundary: at 23:30 UTC on 31 Dec, December→January 2027 is checked in New York, not in Berlin', async () => {
    await bootApp({ clock: () => new Date('2026-12-31T23:30:00Z') }); // New York 31 Dec 18:30, Berlin 1 Jan 00:30
    const miraDecember = await seed(mira, north, '2026-12-01');
    const jonasDecember = await seed(jonas, south, '2026-12-01');
    await setEmployment(mira, '2020-01-01', '2026-12-31');
    await setEmployment(jonas, '2020-01-01', '2027-01-01'); // ends on the 1st of January
    await setZone('America/New_York');
    expect((await patch(miraDecember, { monthStart: '2027-01-01' }).expect(409)).body.code).toBe('EMPLOYEE_NOT_EMPLOYED_FOR_MONTH');
    const covered = await patch(jonasDecember, { monthStart: '2027-01-01' }).expect(200);
    expect((await auditFor(covered.headers['x-correlation-id']))[0].new_values).toEqual({ scope: 'HISTORICAL', monthStart: '2027-01-01' });
    await setZone('Europe/Berlin');
    // January 2027 is already current in Berlin: no evidence check without an employee change.
    expect((await patch(miraDecember, { monthStart: '2027-01-01' }).expect(200)).body.monthStart).toBe('2027-01-01');
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
      for (const table of PLANNING_GUARD_TABLES) {
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