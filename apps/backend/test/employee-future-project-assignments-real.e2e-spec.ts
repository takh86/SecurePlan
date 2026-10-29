/** S-9: real global guards, sessions, SQL/MVCC and #73 DELETE. Synthetic local DB only. */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { vi } from 'vitest';
import { DatabaseService } from '../src/database/database.service.js';
import { BusinessAuditService } from '../src/modules/audit/business-audit.service.js';
import { ProjectAssignmentsService } from '../src/modules/workforce/project-assignments/project-assignments.service.js';
import type { FutureProjectAssignmentResponse } from '../src/modules/workforce/project-assignments/project-assignment.types.js';
import {
  SYNTHETIC_PASSWORD_HASH, createSyntheticEmployee, createSyntheticProject,
  createSyntheticSession, createSyntheticTenant, openLocalTestPool, realSessionService, removeSyntheticTenants,
  type SyntheticEmployee, type SyntheticProject, type SyntheticSession, type SyntheticTenant, type TestPool,
} from './helpers/synthetic-tenants.js';
import { ORIGIN, RecordingDelivery, bootEmployeesApp } from './helpers/employees-test-app.js';

let pool: TestPool;
let app: INestApplication<App>;
let tenant: SyntheticTenant;
let foreign: SyntheticTenant;
let employee: SyntheticEmployee;
let foreignEmployee: SyntheticEmployee;
let north: SyntheticProject;
let south: SyntheticProject;
let admin: SyntheticSession;
let foreignAdmin: SyntheticSession;
let instant: string;
let previousOrigin: string | undefined;
const clock = vi.fn(() => new Date(instant));
const companies: string[] = [];
const path = (id = employee.employeeId) => `/api/v1/employees/${id}/future-project-assignments`;
const http = () => request(app.getHttpServer());
const list = (query = '', id = employee.employeeId, session = admin) => http().get(`${path(id)}${query}`).set('Cookie', session.cookie);
const write = (method: 'patch' | 'delete', id: string) => http()[method](`/api/v1/project-assignments/${id}`)
  .set('Origin', ORIGIN).set('Cookie', admin.cookie).set('X-CSRF-Token', admin.csrf);
const listed = async (): Promise<FutureProjectAssignmentResponse[]> => (await list().expect(200)).body.items;

async function seed(month: string, project = north, person = employee): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO project_assignments (company_id, employee_id, project_id, planning_month)
     VALUES ($1, $2, $3, $4::date) RETURNING id`,
    [person.account.companyId, person.employeeId, project.projectId, month],
  );
  return result.rows[0].id;
}

/** Session activity is intentionally excluded; all business data/audit are compared exactly. */
async function businessState() {
  const state: Record<string, unknown> = {};
  for (const table of ['employees', 'projects', 'project_assignments', 'audit_event', 'accounts']) {
    state[table] = (await pool.query(
      `SELECT to_jsonb(t) AS row FROM ${table} AS t WHERE company_id = ANY($1::uuid[]) ORDER BY id`,
      [companies],
    )).rows;
  }
  return state;
}

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function deadline(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Snapshot barrier was not reached')), 4000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

beforeAll(() => {
  pool = openLocalTestPool(10);
  previousOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
});

beforeEach(async () => {
  instant = '2026-10-29T12:00:00Z';
  clock.mockClear();
  tenant = await createSyntheticTenant(pool, 'S9 A'); companies.push(tenant.companyId);
  foreign = await createSyntheticTenant(pool, 'S9 B'); companies.push(foreign.companyId);
  employee = await createSyntheticEmployee(pool, tenant.employee, 'S9-001', { start: '2026-01-01' });
  foreignEmployee = await createSyntheticEmployee(pool, foreign.employee, 'S9-B01');
  north = await createSyntheticProject(pool, tenant.companyId, 'S9 Nord');
  south = await createSyntheticProject(pool, tenant.companyId, 'S9 Süd');
  const sessions = realSessionService(pool);
  admin = await createSyntheticSession(sessions, tenant.admin);
  foreignAdmin = await createSyntheticSession(sessions, foreign.admin);
  app = await bootEmployeesApp(new RecordingDelivery(), { clock });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
  await removeSyntheticTenants(pool, companies.splice(0));
});

afterAll(async () => {
  await pool?.end();
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousOrigin;
});

describe('S-9 — scoped future discovery', () => {
  it('lists all future months/projects, excludes current/past, preserves exact version and original monthly GET', async () => {
    await seed('2026-09-01'); await seed('2026-10-01');
    const december = await seed('2026-12-01', south);
    const november = await seed('2026-11-01');
    const january = await seed('2027-01-01');
    const far = await seed('2040-04-01');
    await pool.query("UPDATE project_assignments SET updated_at = '2026-10-29T12:00:00.123456Z' WHERE id = $1", [november]);
    clock.mockClear();
    const response = await list().expect(200);
    expect(clock).toHaveBeenCalledTimes(1);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.pagination).toEqual({ page: 1, pageSize: 25, totalItems: 4, totalPages: 1 });
    expect(response.body.items.map((row: FutureProjectAssignmentResponse) => row.id)).toEqual([november, december, january, far]);
    expect(response.body.items[0]).toEqual({
      id: november, employeeId: employee.employeeId, projectId: north.projectId, monthStart: '2026-11-01',
      version: 1793275200123456, projectName: north.name, projectStatus: 'ACTIVE',
    });
    const original = await http().get('/api/v1/project-assignments?monthStart=2026-11-01').set('Cookie', admin.cookie).expect(200);
    expect(Object.keys(original.body.items[0]).sort()).toEqual(['employeeId', 'id', 'monthStart', 'projectId', 'version']);
    expect(original.body.items[0].version).toBe(response.body.items[0].version);
    expect((await http().get('/api/v1/project-assignments').set('Cookie', admin.cookie).expect(400)).body.code).toBe('VALIDATION_FAILED');
  });

  it('distinguishes existing empty employee from unknown/foreign/malformed, without disclosure', async () => {
    expect((await list().expect(200)).body).toEqual({ items: [], pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 } });
    const foreignProject = await createSyntheticProject(pool, foreign.companyId, 'S9 Foreign hidden name');
    await seed('2027-01-01', foreignProject, foreignEmployee);
    const bodies = [];
    for (const id of [foreignEmployee.employeeId, randomUUID(), 'not-an-id']) {
      const response = await list('', id).expect(404);
      expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
      const { correlationId, instance, ...safe } = response.body;
      expect(correlationId).toBeTruthy(); expect(instance).toContain(correlationId);
      expect(JSON.stringify(response.body)).not.toContain(foreignProject.name);
      expect(JSON.stringify(response.body)).not.toContain(foreignEmployee.employeeId);
      bodies.push(safe);
    }
    expect(bodies[0]).toEqual(bodies[1]); expect(bodies[1]).toEqual(bodies[2]);
    expect((await list('', foreignEmployee.employeeId, foreignAdmin).expect(200)).body.pagination.totalItems).toBe(1);
    expect((await list().expect(200)).body.pagination.totalItems).toBe(0);
  });

  it('keeps deactivated employees, missing employment evidence, inactive projects and masked archived references discoverable', async () => {
    const inactive = await createSyntheticProject(pool, tenant.companyId, 'S9 Inaktiv', 'INACTIVE');
    const archived = await createSyntheticProject(pool, tenant.companyId, 'S9 Archived confidential label', 'ARCHIVED');
    await seed('2026-11-01', inactive); const archivedId = await seed('2026-12-01', archived);
    await pool.query("UPDATE employees SET status = 'DEACTIVATED', employment_start = NULL, employment_end = NULL, deactivated_at = now() WHERE id = $1", [employee.employeeId]);
    await pool.query("UPDATE accounts SET status = 'DEACTIVATED' WHERE id = $1", [tenant.employee.accountId]);
    const response = await list().expect(200);
    expect(response.body.items[0]).toMatchObject({ projectName: inactive.name, projectStatus: 'INACTIVE' });
    expect(response.body.items[1]).toMatchObject({ id: archivedId, projectId: archived.projectId, projectName: null, projectStatus: null });
    expect(JSON.stringify(response.body)).not.toContain(archived.name);
    expect(JSON.stringify(response.body)).not.toContain('ARCHIVED');
    expect(response.body.pagination.totalItems).toBe(2);
  });

  it('paginates over 100 months deterministically, accepts uppercase ID, and reports truthful beyond-last totals', async () => {
    await pool.query(
      `INSERT INTO project_assignments (company_id, employee_id, project_id, planning_month)
       SELECT $1, $2, $3, month::date FROM generate_series('2026-11-01'::date, '2035-03-01'::date, interval '1 month') AS month`,
      [tenant.companyId, employee.employeeId, north.projectId],
    );
    const first = await list('?pageSize=100', employee.employeeId.toUpperCase()).expect(200);
    const second = await list('?page=2&pageSize=100').expect(200);
    expect(first.body.items).toHaveLength(100); expect(second.body.items).toHaveLength(1);
    expect(first.body.pagination).toEqual({ page: 1, pageSize: 100, totalItems: 101, totalPages: 2 });
    expect(first.body.items[0].monthStart).toBe('2026-11-01');
    expect(second.body.items[0].monthStart).toBe('2035-03-01');
    expect((await list('?pageSize=100').expect(200)).body).toEqual(first.body);
    expect((await list('?page=1000000&pageSize=100').expect(200)).body).toEqual({ items: [], pagination: { page: 1000000, pageSize: 100, totalItems: 101, totalPages: 2 } });
  });

  it.each(['page=0', 'page=-1', 'page=1.5', 'page=1000001', 'page=x', 'page=', 'page=1&page=2',
    'pageSize=0', 'pageSize=101', 'pageSize=1.5', 'pageSize=25&pageSize=25'])('rejects invalid paging %s', async (query) => {
    expect((await list(`?${query}`).expect(400)).body.code).toBe('VALIDATION_FAILED');
  });

  it.each(['companyId', 'employeeId', 'scope', 'monthStart', 'sortBy', 'sortOrder', 'timeZone'])('rejects undeclared query %s', async (field) => {
    const response = await list(`?${field}=untrusted`).expect(400);
    expect(response.body.code).toBe('UNKNOWN_FIELD');
    expect(JSON.stringify(response.body)).not.toContain('untrusted');
  });

  it('pins actual mixed-invalid path/query pipe precedence, while the global guard always runs first', async () => {
    expect((await list('?pageSize=0', 'not-an-id').expect(404)).body.code).toBe('RESOURCE_NOT_FOUND');
    expect((await http().get(`${path('not-an-id')}?pageSize=0`).expect(401)).body.code).toBe('SESSION_REQUIRED');
  });

  it('rejects employee role and live role changes before resource/query validation', async () => {
    const member = await createSyntheticSession(realSessionService(pool), tenant.employee);
    expect((await list('?pageSize=0', 'bad', member).expect(403)).body.code).toBe('ACTION_FORBIDDEN');
    await pool.query("UPDATE accounts SET role = 'EMPLOYEE' WHERE id = $1", [tenant.admin.accountId]);
    expect((await list().expect(403)).body.code).toBe('ACTION_FORBIDDEN');
  });

  it.each(['revoked', 'expired', 'account', 'company'])('rejects a %s session/account/company', async (kind) => {
    if (kind === 'revoked') await pool.query('UPDATE sessions SET revoked_at = now() WHERE account_id = $1', [tenant.admin.accountId]);
    if (kind === 'expired') await pool.query("UPDATE sessions SET absolute_expires_at = created_at + interval '1 microsecond' WHERE account_id = $1", [tenant.admin.accountId]);
    if (kind === 'account') await pool.query("UPDATE accounts SET status = 'DEACTIVATED' WHERE id = $1", [tenant.admin.accountId]);
    if (kind === 'company') await pool.query("UPDATE companies SET status = 'SUSPENDED' WHERE id = $1", [tenant.companyId]);
    const response = await list().expect(401);
    expect(response.body.code).toBe(kind === 'expired' ? 'SESSION_EXPIRED' : 'SESSION_REVOKED');
  });

  it('does not admit platform accounts as tenant sessions', async () => {
    const id = randomUUID();
    try {
      await pool.query(`INSERT INTO accounts (id, company_id, email, account_scope, role, status, password_hash)
        VALUES ($1, NULL, $2, 'PLATFORM', 'PLATFORM_ADMIN', 'ACTIVE', $3)`, [id, `s9-platform-${id}@secureplan.invalid`, SYNTHETIC_PASSWORD_HASH]);
      await expect(realSessionService(pool).createForAccount({ accountId: id, companyId: tenant.companyId, verifiedPasswordHash: SYNTHETIC_PASSWORD_HASH }))
        .rejects.toMatchObject({ status: 401 });
      expect((await http().get(path()).expect(401)).body.code).toBe('SESSION_REQUIRED');
    } finally {
      await pool.query('DELETE FROM accounts WHERE id = $1', [id]);
    }
  });

  it('performs no business mutation/version touch/audit, and fails closed on invalid stored timezone or version', async () => {
    const id = await seed('2026-11-01');
    const audit = vi.spyOn(app.get(BusinessAuditService), 'recordBusinessAction');
    const before = await businessState();
    await list().expect(200); await list('?page=100').expect(200);
    expect(await businessState()).toEqual(before); expect(audit).not.toHaveBeenCalled();
    await pool.query("UPDATE companies SET time_zone = 'Invalid/S9' WHERE id = $1", [tenant.companyId]);
    expect((await list().expect(500)).body.code).toBe('INTERNAL_ERROR');
    await pool.query("UPDATE companies SET time_zone = 'Europe/Berlin' WHERE id = $1", [tenant.companyId]);
    await pool.query("UPDATE project_assignments SET updated_at = '2256-01-01T00:00:00Z' WHERE id = $1", [id]);
    const failed = await list().expect(500);
    expect(failed.body.code).toBe('INTERNAL_ERROR'); expect(failed.body.items).toBeUndefined();
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('S-9 — IANA month/year boundaries', () => {
  it.each([
    ['Europe/Berlin', '2026-10-31T22:59:59.999Z', '2026-11-01', true],
    ['Europe/Berlin', '2026-10-31T23:00:00.000Z', '2026-11-01', false],
    ['America/New_York', '2026-10-31T23:30:00.000Z', '2026-11-01', true],
    ['America/New_York', '2026-11-01T03:59:59.999Z', '2026-11-01', true],
    ['America/New_York', '2026-11-01T04:00:00.000Z', '2026-11-01', false],
    ['Europe/Berlin', '2026-12-31T22:59:59.999Z', '2027-01-01', true],
    ['Europe/Berlin', '2026-12-31T23:00:00.000Z', '2027-01-01', false],
    ['America/New_York', '2026-12-31T23:30:00.000Z', '2027-01-01', true],
    ['America/New_York', '2027-01-01T04:59:59.999Z', '2027-01-01', true],
    ['America/New_York', '2027-01-01T05:00:00.000Z', '2027-01-01', false],
  ])('%s at %s: %s future=%s', async (zone, now, month, visible) => {
    instant = now;
    await pool.query('UPDATE companies SET time_zone = $2 WHERE id = $1', [tenant.companyId, zone]);
    const id = await seed(month);
    expect((await listed()).map((item) => item.id)).toEqual(visible ? [id] : []);
  });
});

describe('S-9 — real PostgreSQL snapshots', () => {
  it.each(['patch', 'delete', 'rollback', 'labels-and-zone', 'clock-rollover'])('keeps one coherent count/page/label snapshot during concurrent %s', async (operation) => {
    if (operation === 'labels-and-zone') instant = '2026-10-31T23:30:00Z';
    if (operation === 'clock-rollover') instant = '2026-10-31T22:59:59.999Z';
    const id = await seed('2026-11-01'); await seed('2026-12-01', south);
    const before = await listed();
    const counted = latch(); const resume = latch();
    const database = app.get(DatabaseService);
    const original = database.withTransaction.bind(database);
    let paused = false;
    const settings: unknown[] = [];
    const spy = vi.spyOn(database, 'withTransaction').mockImplementation((work) => original(async (client) => {
      const wrapped = new Proxy(client, {
        get(target, key) {
          if (key !== 'query') return Reflect.get(target, key, target);
          return async (...args: unknown[]) => {
            // Pass-through instrumentation only: every statement and result remains real PG.
            const query = target.query.bind(target) as unknown as (...values: unknown[]) => Promise<unknown>;
            const result = await query(...args);
            if (!paused && typeof args[0] === 'string' && args[0].includes('SELECT count(*)::int AS total FROM project_assignments AS pa WHERE')) {
              paused = true;
              settings.push((await target.query('SHOW transaction_isolation')).rows[0]);
              settings.push((await target.query('SHOW transaction_read_only')).rows[0]);
              counted.resolve(); await resume.promise;
            }
            return result;
          };
        },
      });
      return work(wrapped);
    }));
    const pending = list().then((response) => response);
    try {
      await deadline(Promise.race([counted.promise, pending.then(() => { throw new Error('List completed without snapshot barrier'); })]));
      if (operation === 'patch') await write('patch', id).send({ monthStart: '2027-01-01' }).expect(200);
      if (operation === 'delete') await write('delete', id).set('Expected-Version', String(before[0].version)).expect(204);
      if (operation === 'rollback') {
        const writer = await pool.connect();
        try {
          await writer.query('BEGIN'); await writer.query('DELETE FROM project_assignments WHERE id = $1', [id]);
          await writer.query('ROLLBACK');
        } finally { writer.release(); }
      }
      if (operation === 'labels-and-zone') {
        await pool.query("UPDATE projects SET name = 'S9 Renamed', status = 'ARCHIVED' WHERE id = $1", [north.projectId]);
        await pool.query("UPDATE companies SET time_zone = 'America/New_York' WHERE id = $1", [tenant.companyId]);
      }
      if (operation === 'clock-rollover') instant = '2026-10-31T23:00:00Z';
    } finally {
      resume.resolve();
      await pending;
      spy.mockRestore();
    }
    const response = await pending;
    expect(response.status).toBe(200); expect(response.body.items).toEqual(before);
    expect(response.body.pagination.totalItems).toBe(before.length);
    expect(settings).toEqual([{ transaction_isolation: 'repeatable read' }, { transaction_read_only: 'on' }]);
    const fresh = await listed();
    if (operation === 'patch') { expect(fresh.map((row) => row.monthStart)).toEqual(['2026-12-01', '2027-01-01']); expect(fresh[1].version).toBeGreaterThan(before[0].version); }
    if (operation === 'delete') expect(fresh).toHaveLength(1);
    if (operation === 'rollback') expect(fresh).toEqual(before);
    if (operation === 'labels-and-zone') expect(fresh[0]).toMatchObject({ projectName: null, projectStatus: null });
    if (operation === 'clock-rollover') expect(fresh.map((row) => row.monthStart)).toEqual(['2026-12-01']);
  });
});

describe('S-9 — discovery to approved DELETE', () => {
  it('removes with the listed version; repeat is 404; exactly one removal audit', async () => {
    await seed('2026-11-01'); const [row] = await listed();
    await write('delete', row.id).set('Expected-Version', String(row.version)).expect(204);
    expect(await listed()).toEqual([]);
    expect((await write('delete', row.id).set('Expected-Version', String(row.version)).expect(404)).body.code).toBe('RESOURCE_NOT_FOUND');
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_event WHERE company_id = $1 AND action = 'PROJECT_ASSIGNMENT_REMOVED'", [tenant.companyId])).rows[0].n).toBe(1);
  });

  it.each([false, true])('refuses listed stale version after PATCH (ABA=%s), without removal/audit', async (aba) => {
    const id = await seed('2026-11-01'); const [row] = await listed();
    await write('patch', id).send({ projectId: south.projectId }).expect(200);
    if (aba) await write('patch', id).send({ projectId: north.projectId }).expect(200);
    const before = await businessState();
    expect((await write('delete', id).set('Expected-Version', String(row.version)).expect(409)).body.code).toBe('PROJECT_ASSIGNMENT_CONFLICT');
    expect(await businessState()).toEqual(before);
    expect((await listed())[0].version).toBeGreaterThan(row.version);
  });

  it('refuses removal after company-local month rollover even with the unchanged listed version', async () => {
    instant = '2026-10-31T22:59:59.999Z'; await seed('2026-11-01'); const [row] = await listed();
    instant = '2026-10-31T23:00:00.000Z'; const before = await businessState();
    expect((await write('delete', row.id).set('Expected-Version', String(row.version)).expect(409)).body.code).toBe('PROJECT_ASSIGNMENT_CORRECTION_CONFLICT');
    expect(await businessState()).toEqual(before); expect(await listed()).toEqual([]);
  });

  it('keeps E-10 fail closed for a discovered row; uncommitted planning DDL is rolled back', async () => {
    await seed('2026-11-01'); const [row] = await listed(); const before = await businessState();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const schema = `s9_guard_${randomUUID().replaceAll('-', '')}`;
      await client.query(`CREATE SCHEMA ${schema}`); await client.query(`CREATE TABLE ${schema}.duties (id uuid)`);
      const service = new ProjectAssignmentsService(
        { withTransaction: <T>(work: (value: PoolClient) => Promise<T>) => work(client) } as DatabaseService,
        new BusinessAuditService(), clock,
      );
      await expect(service.remove({ accountId: tenant.admin.accountId, companyId: tenant.companyId, sessionId: randomUUID(), role: 'COMPANY_ADMIN' }, row.id, row.version, randomUUID()))
        .rejects.toMatchObject({ status: 409, response: { code: 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT' } });
    } finally {
      await client.query('ROLLBACK'); client.release();
    }
    expect(await businessState()).toEqual(before);
  });
});
