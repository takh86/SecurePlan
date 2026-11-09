/**
 * Approved SP-12 single-entry read over real HTTP, authorization and PostgreSQL.
 * Fixture-only mutations below exercise history and MVCC; they do not implement
 * or establish acceptance of the deferred edit/removal/lease endpoints.
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DatabaseService } from '../src/database/database.service.js';
import type { MonthlyPlanEntryResponse } from '../src/modules/planning/monthly-plan.types.js';
import {
  createSyntheticProject, createSyntheticSession, createSyntheticTenant,
  openLocalTestPool, realSessionService, removeSyntheticTenants,
  type SyntheticEmployee, type SyntheticProject, type SyntheticSession, type SyntheticTenant, type TestPool,
} from './helpers/synthetic-tenants.js';
import { ORIGIN, RecordingDelivery, bootEmployeesApp } from './helpers/employees-test-app.js';
import {
  STANDARD_SHIFTS,
  createStaff,
  insertDuty,
  insertMembership,
  insertPlan,
  insertProjectAssignment,
  insertShiftConfiguration,
  planningState,
  asReplacementMembership,
} from './helpers/planning-fixtures.js';

const BASE = '/api/v1/monthly-plans';
const MONTH = '2027-03-01';

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

/** Hooks only the real duty SELECT, retaining the real transaction and SQL. */
class ObservedReadDatabase extends DatabaseService {
  afterDutyRead?: () => Promise<void>;
  failDutyRead = false;

  override withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return super.withTransaction((client) => work(new Proxy(client, {
      get: (target, key) => {
        if (key === 'query') return async (sql: string, values?: unknown[]) => {
          const dutyRead = sql.includes('FROM public.duties AS d');
          if (dutyRead && this.failDutyRead) await target.query('SELECT 1 / 0');
          const result = await target.query(sql, values);
          if (dutyRead && this.afterDutyRead) {
            const hook = this.afterDutyRead;
            this.afterDutyRead = undefined;
            await hook();
          }
          return result;
        };
        const value: unknown = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    })));
  }
}

let pool: TestPool;
let app: INestApplication<App>;
let database: ObservedReadDatabase;
let tenantA: SyntheticTenant;
let tenantB: SyntheticTenant;
let adminA: SyntheticSession;
let adminB: SyntheticSession;
let employeeSession: SyntheticSession;
let project: SyntheticProject;
let mira: SyntheticEmployee;
let jonas: SyntheticEmployee;
let planId: string;
let entry: MonthlyPlanEntryResponse;
let previousOrigin: string | undefined;
const companies: string[] = [];
const releases: (() => void)[] = [];
const pending: Promise<unknown>[] = [];
const held: PoolClient[] = [];

const path = (plan = planId, duty = entry.id) => `${BASE}/${plan}/entries/${duty}`;
const read = (url = path(), session: SyntheticSession | null = adminA) => {
  const operation = request(app.getHttpServer()).get(url);
  return session ? operation.set('Cookie', session.cookie) : operation;
};

beforeAll(() => {
  pool = openLocalTestPool(8);
  previousOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
});

beforeEach(async () => {
  tenantA = await createSyntheticTenant(pool, 'SP12 read A');
  companies.push(tenantA.companyId);
  tenantB = await createSyntheticTenant(pool, 'SP12 read B');
  companies.push(tenantB.companyId);
  const sessions = realSessionService(pool);
  adminA = await createSyntheticSession(sessions, tenantA.admin);
  adminB = await createSyntheticSession(sessions, tenantB.admin);
  employeeSession = await createSyntheticSession(sessions, tenantA.employee);
  project = await createSyntheticProject(pool, tenantA.companyId, 'SP12 read project');
  await insertShiftConfiguration(pool, tenantA.companyId, project.projectId, MONTH, STANDARD_SHIFTS);
  mira = await createStaff(pool, tenantA.companyId);
  jonas = await createStaff(pool, tenantA.companyId);
  for (const staff of [mira, jonas]) {
    await insertProjectAssignment(pool, tenantA.companyId, staff.employeeId, project.projectId, MONTH);
  }
  planId = await insertPlan(pool, tenantA.companyId, project.projectId, MONTH);
  database = new ObservedReadDatabase();
  app = await bootEmployeesApp(new RecordingDelivery(), { database });
  entry = (await request(app.getHttpServer()).post(`${BASE}/${planId}/entries`)
    .set('Origin', ORIGIN).set('Cookie', adminA.cookie).set('X-CSRF-Token', adminA.csrf)
    .send({ dutyDate: '2027-03-10', shiftKind: 'DAY', assignments: [{ employeeId: mira.employeeId, dutyRole: 'SHIFT_LEAD' }] })
    .expect(201)).body;
});

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const client of held.splice(0)) {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
  await Promise.allSettled(pending.splice(0));
  await app?.close();
});

afterAll(async () => {
  try { await removeSyntheticTenants(pool, companies); } finally { await pool.end(); }
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousOrigin;
});

describe('SP-12 — single-entry HTTP contract and isolation', () => {
  it('returns the created aggregate, UTC snapshots and current version without mutation or audit', async () => {
    const before = await planningState(pool, tenantA.companyId);
    const result = await read().expect(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.headers['content-type']).toMatch(/^application\/json/);
    expect(result.body).toEqual(entry);
    expect(result.body).toMatchObject({ startsAt: '2027-03-10T05:00:00Z', endsAt: '2027-03-10T17:00:00Z', version: 1 });
    const collection = await read(`${BASE}/${planId}/entries`).expect(200);
    expect(collection.body.items).toEqual([result.body]);
    expect(await planningState(pool, tenantA.companyId)).toEqual(before);
  });

  it('accepts uppercase path UUIDs and needs neither a version nor a lease to read', async () => {
    expect((await read(path(planId.toUpperCase(), entry.id.toUpperCase())).expect(200)).body).toEqual(entry);
  });

  it.each([
    ['anonymous', 401, 'SESSION_REQUIRED'],
    ['employee', 403, 'ACTION_FORBIDDEN'],
    ['foreign admin', 404, 'RESOURCE_NOT_FOUND'],
  ] as const)('%s is refused before any planning data is returned', async (actor, status, code) => {
    const session = actor === 'anonymous' ? null : actor === 'employee' ? employeeSession : adminB;
    const before = await planningState(pool, tenantA.companyId);
    const result = await read(path(), session);
    expect([result.status, result.body.code]).toEqual([status, code]);
    expect(result.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(JSON.stringify(result.body)).not.toContain(mira.employeeId);
    expect(await planningState(pool, tenantA.companyId)).toEqual(before);
  });

  it('uses the current account role rather than the role at session creation', async () => {
    await pool.query("UPDATE accounts SET role = 'EMPLOYEE' WHERE company_id = $1 AND id = $2", [tenantA.companyId, tenantA.admin.accountId]);
    const result = await read();
    expect([result.status, result.body.code]).toEqual([403, 'ACTION_FORBIDDEN']);
  });

  it.each(['plan', 'entry'] as const)('conceals unknown and malformed %s identifiers with the same 404', async (part) => {
    for (const id of [randomUUID(), 'not-a-uuid']) {
      const result = await read(part === 'plan' ? path(id) : path(planId, id));
      expect([result.status, result.body.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect(result.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(result.body.correlationId).toBe(result.headers['x-correlation-id']);
      expect(JSON.stringify(result.body)).not.toContain(mira.employeeId);
    }
  });

  it('requires both the duty tenant and its exact owning plan, even for an existing same-tenant duty', async () => {
    const otherProject = await createSyntheticProject(pool, tenantA.companyId, 'SP12 other project');
    const otherPlan = await insertPlan(pool, tenantA.companyId, otherProject.projectId, MONTH);
    const foreignProject = await createSyntheticProject(pool, tenantB.companyId, 'SP12 foreign project');
    const foreignPlan = await insertPlan(pool, tenantB.companyId, foreignProject.projectId, MONTH);
    const foreignDuty = await insertDuty(pool, {
      companyId: tenantB.companyId, projectId: foreignProject.projectId, planId: foreignPlan, month: MONTH,
      dutyDate: entry.dutyDate, startsAt: entry.startsAt, endsAt: entry.endsAt,
    });
    for (const url of [path(otherPlan), path(foreignPlan), path(planId, foreignDuty), path(foreignPlan, foreignDuty)]) {
      const result = await read(url);
      expect([result.status, result.body.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    }
    expect((await read(path(foreignPlan, foreignDuty), adminB).expect(200)).body.id).toBe(foreignDuty);
  });

  it.each(['ACTIVE', 'INACTIVE', 'ARCHIVED'] as const)('applies the existing %s project visibility policy', async (status) => {
    await pool.query('UPDATE projects SET status = $2 WHERE id = $1', [project.projectId, status]);
    const result = await read();
    if (status === 'ARCHIVED') expect([result.status, result.body.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    else {
      expect(result.status).toBe(200);
      expect(result.body).toEqual(entry);
    }
  });

  it('conceals a tombstone while retaining the duty and membership history', async () => {
    await pool.query("UPDATE plan_assignments SET state = 'REMOVED', removed_at = clock_timestamp() WHERE duty_id = $1", [entry.id]);
    await pool.query('UPDATE duties SET removed_at = clock_timestamp() WHERE id = $1', [entry.id]);
    const before = await planningState(pool, tenantA.companyId);
    const result = await read();
    expect([result.status, result.body.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    expect(await planningState(pool, tenantA.companyId)).toEqual(before);
    expect(before.duties).toHaveLength(1);
    expect(before.members).toHaveLength(1);
  });

  it('lists only active memberships, preserving their IDs, roles and server-owned source', async () => {
    await insertMembership(pool, tenantA.companyId, entry.id, jonas.employeeId, 'REMOVED');
    await asReplacementMembership(pool, entry.assignments[0].id);
    const result = await read().expect(200);
    expect(result.body.assignments).toEqual([{ ...entry.assignments[0], source: 'REPLACEMENT' }]);
    await pool.query("UPDATE plan_assignments SET state = 'REMOVED', removed_at = clock_timestamp() WHERE id = $1", [entry.assignments[0].id]);
    expect((await read().expect(200)).body.assignments).toEqual([]);
  });

  it('renders the largest supported duty version exactly, without advancing it', async () => {
    await pool.query('UPDATE duties SET concurrency_version = 9007199254740991 WHERE id = $1', [entry.id]);
    expect((await read().expect(200)).body.version).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each(['UNPUBLISHED', 'PUBLISHED'] as const)('reads the current %s plan directly with no new draft or publish action', async (status) => {
    if (status === 'PUBLISHED') {
      await pool.query("UPDATE monthly_plans SET status = 'PUBLISHED', published_at = '2027-02-01T12:00:00Z', published_by_account_id = $2 WHERE id = $1",
        [planId, tenantA.admin.accountId]);
    }
    const before = await planningState(pool, tenantA.companyId);
    expect((await read().expect(200)).body).toEqual(entry);
    expect(await planningState(pool, tenantA.companyId)).toEqual(before);
    expect(before.plans).toHaveLength(1);
  });

  it.each(['SICK', 'LEAVE'] as const)('exposes a later %s fact only as a neutral administrative conflict', async (status) => {
    await pool.query('INSERT INTO employee_availability_days (company_id, employee_id, day, status) VALUES ($1, $2, $3::date, $4)',
      [tenantA.companyId, mira.employeeId, entry.dutyDate, status]);
    const before = await planningState(pool, tenantA.companyId);
    const result = await read().expect(200);
    expect(result.body).toEqual({ ...entry, availabilityConflicts: [{
      code: 'EMPLOYEE_UNAVAILABLE', assignmentId: entry.assignments[0].id, employeeId: mira.employeeId,
    }] });
    expect(JSON.stringify(result.body)).not.toMatch(/SICK|LEAVE|status|reason|companyId|accountId/);
    expect(await planningState(pool, tenantA.companyId)).toEqual(before);
  });

  it('sanitizes a real PostgreSQL failure and releases the failed transaction for a later read', async () => {
    const before = await planningState(pool, tenantA.companyId);
    database.failDutyRead = true;
    const result = await read();
    expect([result.status, result.body.code]).toEqual([500, 'INTERNAL_ERROR']);
    expect(result.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(result.body.correlationId).toBe(result.headers['x-correlation-id']);
    expect(JSON.stringify(result.body)).not.toMatch(/SELECT|division|22012|duties|stack|employeeId/);
    expect(await planningState(pool, tenantA.companyId)).toEqual(before);
    database.failDutyRead = false;
    expect((await read().expect(200)).body).toEqual(entry);
  });
});

describe('SP-12 — real PostgreSQL aggregate read consistency', () => {
  it.each(['COMMIT', 'ROLLBACK'] as const)('keeps one snapshot across a concurrent fixture writer ending in %s', async (outcome) => {
    const writer = await pool.connect();
    held.push(writer);
    await writer.query('BEGIN');
    // Deliberately uncommitted fixture state: a reader must neither block on
    // the writer nor mix its old Duty with new memberships/availability facts.
    await writer.query("UPDATE duties SET duty_date = '2027-03-11', starts_at = '2027-03-11T05:00:00Z', ends_at = '2027-03-11T17:00:00Z', concurrency_version = 2 WHERE id = $1", [entry.id]);
    await writer.query("UPDATE plan_assignments SET state = 'REMOVED', removed_at = clock_timestamp() WHERE duty_id = $1", [entry.id]);
    await writer.query("INSERT INTO plan_assignments (company_id, duty_id, employee_id, duty_function) VALUES ($1, $2, $3, 'MITARBEITER')",
      [tenantA.companyId, entry.id, jonas.employeeId]);
    await writer.query("INSERT INTO employee_availability_days (company_id, employee_id, day, status) VALUES ($1, $2, '2027-03-11', 'SICK')",
      [tenantA.companyId, jonas.employeeId]);

    const arrived = latch();
    const resume = latch();
    releases.push(resume.release);
    database.afterDutyRead = async () => { arrived.release(); await resume.promise; };
    const response = read().then((value) => value);
    pending.push(response);
    await Promise.race([arrived.promise, response.then(() => { throw new Error('Read finished before the snapshot barrier'); })]);
    await writer.query(outcome);
    held.splice(held.indexOf(writer), 1);
    writer.release();
    resume.release();

    const result = await response;
    expect(result.status).toBe(200);
    expect(result.body).toEqual(entry);
    const next = await read().expect(200);
    if (outcome === 'ROLLBACK') expect(next.body).toEqual(entry);
    else {
      expect(next.body).toMatchObject({ dutyDate: '2027-03-11', version: 2 });
      expect(next.body.assignments).toEqual([{ id: expect.any(String), employeeId: jonas.employeeId, dutyRole: 'EMPLOYEE', source: 'NORMAL' }]);
      expect(next.body.availabilityConflicts).toEqual([{
        code: 'EMPLOYEE_UNAVAILABLE', assignmentId: next.body.assignments[0].id, employeeId: jonas.employeeId,
      }]);
    }
  });
});
