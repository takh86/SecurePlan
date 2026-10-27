/**
 * SP-09 — month-scoped project assignments against REAL PostgreSQL.
 *
 * Drives the real AppModule over HTTP (real global AccessControlGuard, real
 * sessions, real SQL) and additionally proves the database constraints with
 * raw SQL that bypasses the application (Phase 7.2 integrity matrix DB-03,
 * DB-04, DB-12, DB-14). Two synthetic tenants (A, B) prove tenant isolation.
 *
 * Requires a migrated LOCAL PostgreSQL (0001–0008); synthetic fixtures only.
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
import { FailingAudit, ORIGIN, RecordingDelivery, bootEmployeesApp } from './helpers/employees-test-app.js';

const BASE = '/api/v1/project-assignments';
const RESPONSE_KEYS = ['employeeId', 'id', 'monthStart', 'projectId'];
// Deterministic synthetic months, including a year boundary.
const NOV = '2026-11-01';
const DEC = '2026-12-01';
const JAN = '2027-01-01';
// Explicit documented employment (F-1): covers all months used by the fixtures.
const EMPLOYED = { start: '2026-01-01' };

let pool: TestPool | undefined;
let sessions: SessionService;
let app: INestApplication<App> | undefined;
let tenantA: SyntheticTenant;
let tenantB: SyntheticTenant;
let employeeA: SyntheticEmployee;
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

function read(path: string, session?: SyntheticSession) {
  const pending = http().get(path);
  return session ? pending.set('Cookie', session.cookie) : pending;
}

function post(session: SyntheticSession | null, body: object) {
  let pending = http().post(BASE).set('Origin', ORIGIN);
  if (session) pending = pending.set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf);
  return pending.send(body);
}

function assign(employee: SyntheticEmployee, project: SyntheticProject, monthStart: string, session = adminA) {
  return post(session, { employeeId: employee.employeeId, projectId: project.projectId, monthStart });
}

/** Everything an assignment write could have changed in one tenant. */
async function tenantState(companyId: string) {
  const query = async (sql: string) => (await db().query(sql, [companyId])).rows;
  return {
    assignments: await query(
      `SELECT id, employee_id, project_id, planning_month::text, updated_at
       FROM project_assignments WHERE company_id = $1 ORDER BY id`,
    ),
    audit: await query('SELECT id FROM audit_event WHERE company_id = $1 ORDER BY id'),
  };
}

async function assignmentCount(companyId: string): Promise<number> {
  return (await db().query('SELECT count(*)::int AS n FROM project_assignments WHERE company_id = $1', [companyId]))
    .rows[0].n;
}

async function bootApp(audit?: FailingAudit) {
  if (app) await app.close();
  app = await bootEmployeesApp(new RecordingDelivery(), audit ? { audit } : {});
}

beforeAll(() => {
  pool = openLocalTestPool(10);
  sessions = realSessionService(db());
  previousOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
});

beforeEach(async () => {
  tenantA = await createSyntheticTenant(db(), 'SP09 Tenant A');
  createdCompanies.push(tenantA.companyId);
  tenantB = await createSyntheticTenant(db(), 'SP09 Tenant B');
  createdCompanies.push(tenantB.companyId);
  employeeA = await createSyntheticEmployee(db(), tenantA.employee, 'A-001', EMPLOYED);
  employeeB = await createSyntheticEmployee(db(), tenantB.employee, 'B-001', EMPLOYED);
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
    throw new Error(`SP-09 fixture cleanup FAILED for companies ${ids.join(', ')}`, { cause: error });
  }
});

afterAll(async () => {
  await pool?.end();
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousOrigin;
});

describe('SP-09 — access control', () => {
  it('unauthenticated: 401 SESSION_REQUIRED on read and create, nothing written', async () => {
    const before = await tenantState(tenantA.companyId);
    expect((await read(`${BASE}?monthStart=${NOV}`).expect(401)).body.code).toBe('SESSION_REQUIRED');
    expect((await post(null, { employeeId: employeeA.employeeId, projectId: north.projectId, monthStart: NOV })
      .expect(401)).body.code).toBe('SESSION_REQUIRED');
    expect(await tenantState(tenantA.companyId)).toEqual(before);
  });

  it('EMPLOYEE role: 403 ACTION_FORBIDDEN on read and create, also for the own record', async () => {
    const employee = await createSyntheticSession(sessions, tenantA.employee);
    const before = await tenantState(tenantA.companyId);
    expect((await read(`${BASE}?monthStart=${NOV}`, employee).expect(403)).body.code).toBe('ACTION_FORBIDDEN');
    expect((await assign(employeeA, north, NOV, employee).expect(403)).body.code).toBe('ACTION_FORBIDDEN');
    expect(await tenantState(tenantA.companyId)).toEqual(before);
  });

  it('creates without a valid Origin or CSRF token are rejected before any change', async () => {
    const otherAdminA = await createSyntheticSession(sessions, tenantA.admin);
    const body = { employeeId: employeeA.employeeId, projectId: north.projectId, monthStart: NOV };
    const before = await tenantState(tenantA.companyId);
    const attempts = [
      () => http().post(BASE).set('Origin', ORIGIN).set('Cookie', adminA.cookie).send(body),
      () => http().post(BASE).set('Origin', ORIGIN).set('Cookie', adminA.cookie).set('X-CSRF-Token', otherAdminA.csrf).send(body),
      () => http().post(BASE).set('Origin', 'https://attacker.example').set('Cookie', adminA.cookie)
        .set('X-CSRF-Token', adminA.csrf).send(body),
      () => http().post(BASE).set('Cookie', adminA.cookie).set('X-CSRF-Token', adminA.csrf).send(body),
    ];
    for (const attempt of attempts) {
      const response = await attempt();
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('CSRF_VALIDATION_FAILED');
    }
    expect(await tenantState(tenantA.companyId)).toEqual(before);
  });
});

describe('SP-09 — create and read', () => {
  it('creates an assignment, audits it and returns it again on a fresh read (reload)', async () => {
    const response = await assign(employeeA, north, NOV).expect(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(Object.keys(response.body).sort()).toEqual(RESPONSE_KEYS);
    expect(response.body).toMatchObject({ employeeId: employeeA.employeeId, projectId: north.projectId, monthStart: NOV });

    const stored = await db().query(
      'SELECT company_id, employee_id, project_id, planning_month::text AS month FROM project_assignments WHERE id = $1',
      [response.body.id],
    );
    expect(stored.rows[0]).toEqual({
      company_id: tenantA.companyId, employee_id: employeeA.employeeId, project_id: north.projectId, month: NOV,
    });

    const audit = await db().query(
      `SELECT action, resource_type, resource_id, actor_account_id, old_values, new_values
       FROM audit_event WHERE company_id = $1 AND correlation_id = $2`,
      [tenantA.companyId, response.headers['x-correlation-id']],
    );
    expect(audit.rows).toEqual([{
      action: 'PROJECT_ASSIGNMENT_CREATED',
      resource_type: 'PROJECT_ASSIGNMENT',
      resource_id: response.body.id,
      actor_account_id: tenantA.admin.accountId,
      old_values: null,
      new_values: { employeeId: employeeA.employeeId, projectId: north.projectId, monthStart: NOV },
    }]);

    // Reload: a new request (new transaction) sees the persisted assignment.
    const list = await read(`${BASE}?monthStart=${NOV}`, adminA).expect(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body).toEqual({
      items: [response.body],
      pagination: { page: 1, pageSize: 25, totalItems: 1, totalPages: 1 },
    });
    expect((await read(`${BASE}?monthStart=${DEC}`, adminA).expect(200)).body.items).toEqual([]);
  });

  it('at most one project per employee and month: same project 409 ALREADY_EXISTS, other project 409 CONFLICT', async () => {
    const first = await assign(employeeA, north, NOV).expect(201);
    const before = await tenantState(tenantA.companyId);

    const same = await assign(employeeA, north, NOV).expect(409);
    expect(same.body.code).toBe('PROJECT_ASSIGNMENT_ALREADY_EXISTS');
    const other = await assign(employeeA, south, NOV).expect(409);
    expect(other.body.code).toBe('PROJECT_ASSIGNMENT_CONFLICT');
    // Ids are uuids, not strings: letter case must not change the outcome.
    const upper = await post(adminA, {
      employeeId: employeeA.employeeId.toUpperCase(), projectId: north.projectId.toUpperCase(), monthStart: NOV,
    }).expect(409);
    expect(upper.body.code).toBe('PROJECT_ASSIGNMENT_ALREADY_EXISTS');

    expect(await tenantState(tenantA.companyId)).toEqual(before);
    expect((await read(`${BASE}?monthStart=${NOV}`, adminA).expect(200)).body.items).toEqual([first.body]);
  });

  it('months are independent; a project change applies from the next month and history stays (incl. year boundary)', async () => {
    const nov = await assign(employeeA, north, NOV).expect(201);
    const dec = await assign(employeeA, south, DEC).expect(201);
    const jan = await assign(employeeA, north, JAN).expect(201);

    for (const [month, expected] of [[NOV, nov.body], [DEC, dec.body], [JAN, jan.body]] as const) {
      const response = await read(`${BASE}?monthStart=${month}&employeeId=${employeeA.employeeId}`, adminA).expect(200);
      expect(response.body.items).toEqual([expected]);
    }
    expect(await assignmentCount(tenantA.companyId)).toBe(3);
  });

  it('deactivating the employee keeps past assignments readable and blocks new ones', async () => {
    const nov = await assign(employeeA, north, NOV).expect(201);
    await http().post(`/api/v1/employees/${employeeA.employeeId}/deactivate`)
      .set('Origin', ORIGIN).set('Cookie', adminA.cookie).set('X-CSRF-Token', adminA.csrf).send({}).expect(200);

    expect((await read(`${BASE}?monthStart=${NOV}`, adminA).expect(200)).body.items).toEqual([nov.body]);
    const blocked = await assign(employeeA, north, DEC).expect(409);
    expect(blocked.body.code).toBe('EMPLOYEE_INACTIVE');
    expect(await assignmentCount(tenantA.companyId)).toBe(1);
  });

  it('an INACTIVE project blocks new assignments; existing ones stay; reactivation allows them again', async () => {
    const nov = await assign(employeeA, north, NOV).expect(201);
    const patch = (status: string) => http().patch(`/api/v1/projects/${north.projectId}`)
      .set('Origin', ORIGIN).set('Cookie', adminA.cookie).set('X-CSRF-Token', adminA.csrf).send({ status });
    await patch('INACTIVE').expect(200);

    const blocked = await assign(employeeA, north, DEC).expect(409);
    expect(blocked.body.code).toBe('PROJECT_INACTIVE');
    expect((await read(`${BASE}?monthStart=${NOV}&projectId=${north.projectId}`, adminA).expect(200)).body.items)
      .toEqual([nov.body]);

    await patch('ACTIVE').expect(200);
    await assign(employeeA, north, DEC).expect(201);
  });

  it('an ARCHIVED project is invisible: assigning to it is 404 like an unknown project; its history stays readable', async () => {
    const old = await assign(employeeA, north, NOV).expect(201);
    await db().query("UPDATE projects SET status = 'ARCHIVED' WHERE id = $1", [north.projectId]);
    const before = await tenantState(tenantA.companyId);
    const blocked = await assign(employeeA, north, DEC).expect(404);
    expect(blocked.body.code).toBe('RESOURCE_NOT_FOUND');
    expect(await tenantState(tenantA.companyId)).toEqual(before);
    expect((await read(`${BASE}?monthStart=${NOV}`, adminA).expect(200)).body.items).toEqual([old.body]);
  });

  it('an audit failure rolls the create back completely', async () => {
    await bootApp(new FailingAudit('PROJECT_ASSIGNMENT_CREATED'));
    const before = await tenantState(tenantA.companyId);
    const response = await assign(employeeA, north, NOV).expect(500);
    expect(response.body.code).toBe('INTERNAL_ERROR');
    expect(await tenantState(tenantA.companyId)).toEqual(before);
  });
});

describe('SP-09 — F-1 employment must overlap the target month (owner decision)', () => {
  async function employed(code: string, start: string | null, end: string | null = null) {
    return createSyntheticEmployee(
      db(), await createSyntheticAccount(db(), tenantA.companyId, 'EMPLOYEE'), code, { start, end },
    );
  }

  it.each([
    ['start after the target month', '2026-12-01', null, NOV, 409],
    ['start on the last day of the month', '2026-11-30', null, NOV, 201],
    ['end on the first day of the month', '2026-01-01', '2026-11-01', NOV, 201],
    ['end before the target month', '2026-01-01', '2026-10-31', NOV, 409],
    ['no employment start (no evidence)', null, null, NOV, 409],
    ['no employment start, with an end date', null, '2027-12-31', NOV, 409],
    ['valid far-future month (no artificial limit)', '2026-01-01', null, '2031-05-01', 201],
    ['historical month before employment', '2026-06-01', null, '2025-01-01', 409],
  ] as const)('%s -> %i', async (_label, start, end, month, status) => {
    const person = await employed(`F1-${randomUUID().slice(0, 6)}`, start, end);
    const before = await tenantState(tenantA.companyId);
    const response = await assign(person, north, month).expect(status);
    if (status === 409) {
      expect(response.body.code).toBe('EMPLOYEE_NOT_EMPLOYED_FOR_MONTH');
      expect(await tenantState(tenantA.companyId)).toEqual(before); // no row, no audit
    } else {
      expect(await assignmentCount(tenantA.companyId)).toBe(1);
    }
  });

  it('precedence: inactive employee/project and 404 win over the employment check; the employment check wins over existing assignments', async () => {
    const unemployed = await employed('F1-NOEMP', null);
    const unemployedInactive = await employed('F1-INACT', null);
    await db().query("UPDATE employees SET status = 'DEACTIVATED', deactivated_at = now() WHERE id = $1", [unemployedInactive.employeeId]);
    const inactiveProject = await createSyntheticProject(db(), tenantA.companyId, 'Objekt Inaktiv', 'INACTIVE');
    const archived = await createSyntheticProject(db(), tenantA.companyId, 'Objekt Archiv', 'ARCHIVED');

    expect((await assign(unemployedInactive, north, NOV).expect(409)).body.code).toBe('EMPLOYEE_INACTIVE');
    expect((await assign(unemployed, inactiveProject, NOV).expect(409)).body.code).toBe('PROJECT_INACTIVE');
    expect((await assign(unemployed, archived, NOV).expect(404)).body.code).toBe('RESOURCE_NOT_FOUND');
    expect((await assign(employeeB, north, NOV).expect(404)).body.code).toBe('RESOURCE_NOT_FOUND'); // foreign employee
    expect((await assign(unemployed, projectB, NOV).expect(404)).body.code).toBe('RESOURCE_NOT_FOUND'); // foreign project

    // Existing assignment (inserted bypassing the app) + employment gap: employment check comes first.
    await db().query(
      'INSERT INTO project_assignments (company_id, employee_id, project_id, planning_month) VALUES ($1, $2, $3, $4::date)',
      [tenantA.companyId, unemployed.employeeId, north.projectId, NOV],
    );
    expect((await assign(unemployed, north, NOV).expect(409)).body.code).toBe('EMPLOYEE_NOT_EMPLOYED_FOR_MONTH');
    expect((await assign(unemployed, south, NOV).expect(409)).body.code).toBe('EMPLOYEE_NOT_EMPLOYED_FOR_MONTH');
    // Employed person: existing 409 codes unchanged.
    await assign(employeeA, north, NOV).expect(201);
    expect((await assign(employeeA, north, NOV).expect(409)).body.code).toBe('PROJECT_ASSIGNMENT_ALREADY_EXISTS');
    expect((await assign(employeeA, south, NOV).expect(409)).body.code).toBe('PROJECT_ASSIGNMENT_CONFLICT');
  });
});

describe('SP-09 — tenant isolation', () => {
  it('a foreign employee or project answers exactly like an unknown id (404); nothing is written anywhere', async () => {
    const beforeA = await tenantState(tenantA.companyId);
    const beforeB = await tenantState(tenantB.companyId);
    const shape = (body: Record<string, unknown>) => {
      const { correlationId, instance, ...rest } = body;
      expect(typeof correlationId).toBe('string');
      expect(typeof instance).toBe('string');
      return rest;
    };
    const unknownEmployee = { employeeId: randomUUID(), projectId: north.projectId, monthStart: NOV };
    const reference = await post(adminA, unknownEmployee).expect(404);

    for (const body of [
      { employeeId: employeeB.employeeId, projectId: north.projectId, monthStart: NOV }, // employee of B
      { employeeId: employeeA.employeeId, projectId: projectB.projectId, monthStart: NOV }, // project of B
      { employeeId: employeeB.employeeId, projectId: projectB.projectId, monthStart: NOV }, // both of B
      { employeeId: employeeA.employeeId, projectId: randomUUID(), monthStart: NOV },
    ]) {
      const response = await post(adminA, body).expect(404);
      expect(response.body.code).toBe('RESOURCE_NOT_FOUND');
      expect(shape(response.body)).toEqual(shape(reference.body));
    }
    expect(await tenantState(tenantA.companyId)).toEqual(beforeA);
    expect(await tenantState(tenantB.companyId)).toEqual(beforeB);
  });

  it('reads are tenant-scoped; foreign filters return nothing; tenant hints are rejected', async () => {
    await assign(employeeA, north, NOV).expect(201);
    await assign(employeeB, projectB, NOV, adminB).expect(201);

    const listA = await read(`${BASE}?monthStart=${NOV}`, adminA).expect(200);
    expect(listA.body.items.map((item: { employeeId: string }) => item.employeeId)).toEqual([employeeA.employeeId]);
    const listB = await read(`${BASE}?monthStart=${NOV}`, adminB).expect(200);
    expect(listB.body.items.map((item: { employeeId: string }) => item.employeeId)).toEqual([employeeB.employeeId]);

    expect((await read(`${BASE}?monthStart=${NOV}&projectId=${north.projectId}`, adminB).expect(200)).body)
      .toEqual({ items: [], pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 } });
    expect((await read(`${BASE}?monthStart=${NOV}&employeeId=${employeeA.employeeId}`, adminB).expect(200)).body.items)
      .toEqual([]);

    expect((await read(`${BASE}?monthStart=${NOV}&companyId=${tenantA.companyId}`, adminB).expect(400)).body.code)
      .toBe('UNKNOWN_FIELD');
    for (const hint of [{ companyId: tenantB.companyId }, { id: randomUUID() }, { status: 'ACTIVE' }]) {
      const response = await post(adminA, {
        employeeId: employeeA.employeeId, projectId: north.projectId, monthStart: DEC, ...hint,
      }).expect(400);
      expect(response.body.code).toBe('UNKNOWN_FIELD');
    }
    expect(await assignmentCount(tenantA.companyId)).toBe(1);
  });
});

describe('SP-09 — validation', () => {
  it('a valid date that is not the first of a month is 400 INVALID_MONTH_START (create and read)', async () => {
    const response = await assign(employeeA, north, '2026-11-15').expect(400);
    expect(response.body.code).toBe('INVALID_MONTH_START');
    expect((await read(`${BASE}?monthStart=2026-11-15`, adminA).expect(400)).body.code).toBe('INVALID_MONTH_START');
    expect(await assignmentCount(tenantA.companyId)).toBe(0);
  });

  it('malformed input is 400 VALIDATION_FAILED with safe pointers and nothing persisted', async () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [{ monthStart: '2026-02-30' }, '#/monthStart', 'INVALID_FORMAT'],
      [{ monthStart: '2026-13-01' }, '#/monthStart', 'INVALID_FORMAT'],
      [{ monthStart: 'abc' }, '#/monthStart', 'INVALID_FORMAT'],
      [{ monthStart: undefined }, '#/monthStart', 'REQUIRED'],
      [{ employeeId: 'not-a-uuid' }, '#/employeeId', 'INVALID_UUID'],
      [{ projectId: undefined }, '#/projectId', 'REQUIRED'],
    ];
    for (const [override, pointer, code] of cases) {
      const response = await post(adminA, {
        employeeId: employeeA.employeeId, projectId: north.projectId, monthStart: NOV, ...override,
      }).expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(response.body.errors).toContainEqual(expect.objectContaining({ pointer, code }));
      expect(JSON.stringify(response.body)).not.toContain('not-a-uuid');
    }
    expect(await assignmentCount(tenantA.companyId)).toBe(0);
  });

  it('read requires monthStart and validates filters and paging', async () => {
    for (const query of ['', 'monthStart=', 'monthStart=2026-11', `monthStart=${NOV}&projectId=x`, `monthStart=${NOV}&pageSize=101`,
      `monthStart=${NOV}&page=0`, `monthStart=${NOV}&monthStart=${DEC}`]) {
      const response = await read(`${BASE}?${query}`, adminA);
      expect({ query, status: response.status, code: response.body.code })
        .toEqual({ query, status: 400, code: 'VALIDATION_FAILED' });
    }
    expect((await read(`${BASE}?monthStart=${NOV}&sortBy=name`, adminA).expect(400)).body.code).toBe('UNKNOWN_FIELD');
  });
});

describe('SP-09 — list order and paging', () => {
  it('orders by employee code, narrows by project/employee and pages with consistent totals', async () => {
    const extra = async (code: string) =>
      createSyntheticEmployee(db(), await createSyntheticAccount(db(), tenantA.companyId, 'EMPLOYEE'), code, EMPLOYED);
    const c3 = await extra('C-003');
    const b2 = await extra('B-002');
    await assign(c3, south, NOV).expect(201);
    await assign(employeeA, north, NOV).expect(201);
    await assign(b2, north, NOV).expect(201);

    const ids = (body: { items: { employeeId: string }[] }) => body.items.map((item) => item.employeeId);
    expect(ids((await read(`${BASE}?monthStart=${NOV}`, adminA).expect(200)).body))
      .toEqual([employeeA.employeeId, b2.employeeId, c3.employeeId]);
    expect(ids((await read(`${BASE}?monthStart=${NOV}&projectId=${north.projectId}`, adminA).expect(200)).body))
      .toEqual([employeeA.employeeId, b2.employeeId]);
    const paged = await read(`${BASE}?monthStart=${NOV}&pageSize=2&page=2`, adminA).expect(200);
    expect(ids(paged.body)).toEqual([c3.employeeId]);
    expect(paged.body.pagination).toEqual({ page: 2, pageSize: 2, totalItems: 3, totalPages: 2 });
  });
});

describe('SP-09 — database integrity without the application (raw SQL)', () => {
  async function rawInsert(companyId: string, employeeId: string, projectId: string, month: string) {
    return db().query(
      'INSERT INTO project_assignments (company_id, employee_id, project_id, planning_month) VALUES ($1, $2, $3, $4::date)',
      [companyId, employeeId, projectId, month],
    );
  }

  it('DB-03: a second project for the same employee and month violates the UNIQUE constraint', async () => {
    await rawInsert(tenantA.companyId, employeeA.employeeId, north.projectId, NOV);
    await expect(rawInsert(tenantA.companyId, employeeA.employeeId, south.projectId, NOV))
      .rejects.toMatchObject({ code: '23505', constraint: 'uq_project_assignments__employee_month' });
    // Different month: allowed.
    await rawInsert(tenantA.companyId, employeeA.employeeId, south.projectId, DEC);
  });

  it('DB-12: planning_month must be the first day of a month (CHECK), so the UNIQUE key cannot be bypassed', async () => {
    await rawInsert(tenantA.companyId, employeeA.employeeId, north.projectId, NOV);
    await expect(rawInsert(tenantA.companyId, employeeA.employeeId, south.projectId, '2026-11-15'))
      .rejects.toMatchObject({ code: '23514', constraint: 'ck_project_assignments__month_start' });
    await expect(rawInsert(tenantA.companyId, employeeB.employeeId, projectB.projectId, '2026-12-31'))
      .rejects.toMatchObject({ code: '23514', constraint: 'ck_project_assignments__month_start' });
  });

  it('DB-04: a row of company A cannot reference an employee or project of company B (composite FKs)', async () => {
    await expect(rawInsert(tenantA.companyId, employeeB.employeeId, north.projectId, NOV))
      .rejects.toMatchObject({ code: '23503', constraint: 'fk_project_assignments__employees' });
    await expect(rawInsert(tenantA.companyId, employeeA.employeeId, projectB.projectId, NOV))
      .rejects.toMatchObject({ code: '23503', constraint: 'fk_project_assignments__projects' });
    expect(await assignmentCount(tenantA.companyId)).toBe(0);
  });

  it('DB-14: a referenced employee or project cannot be hard-deleted (RESTRICT keeps history)', async () => {
    await rawInsert(tenantA.companyId, employeeA.employeeId, north.projectId, NOV);
    await expect(db().query('DELETE FROM employees WHERE id = $1', [employeeA.employeeId]))
      .rejects.toMatchObject({ code: '23503', constraint: 'fk_project_assignments__employees' });
    await expect(db().query('DELETE FROM projects WHERE id = $1', [north.projectId]))
      .rejects.toMatchObject({ code: '23503', constraint: 'fk_project_assignments__projects' });
  });
});
