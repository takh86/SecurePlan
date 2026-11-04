/** Real Nest/guard/Identity/SQL/PostgreSQL coverage. No security or query results mocked. */
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DatabaseService } from '../src/database/database.service.js';
import { MY_MONTHLY_PLANS_QUERY } from '../src/modules/planning/me-monthly-plans.query.js';
import {
  ORIGIN,
  RecordingDelivery,
  bootEmployeesApp,
} from './helpers/employees-test-app.js';
import {
  createSyntheticEmployee,
  createSyntheticProject,
  createSyntheticSession,
  createSyntheticTenant,
  openLocalTestPool,
  realSessionService,
  removeSyntheticTenants,
  type TestPool,
  type SyntheticTenant,
  type SyntheticSession,
  type SyntheticEmployee,
  type SyntheticProject,
} from './helpers/synthetic-tenants.js';
import {
  createStaff,
  insertDuty,
  insertMembership,
  insertPlan,
  insertProjectAssignment,
  insertShiftConfiguration,
  STANDARD_SHIFTS,
} from './helpers/planning-fixtures.js';

const BASE = '/api/v1/me/monthly-plans',
  MONTH = '2026-12-01';
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}
class ObservedDatabase extends DatabaseService {
  pause?: {
    stage: 'prefix' | 'beforeRead' | 'afterRead';
    work: () => Promise<void>;
  };
  shadow = false;
  failRead = false;
  statements: string[] = [];
  override withTransaction<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return super.withTransaction((client) =>
      work(
        new Proxy(client, {
          get: (target, key) => {
            if (key === 'query')
              return async (sql: string, values?: unknown[]) => {
                this.statements.push(sql);
                const stage =
                  sql === MY_MONTHLY_PLANS_QUERY
                    ? 'beforeRead'
                    : sql === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED'
                      ? 'prefix'
                      : null;
                if (this.pause?.stage === stage) {
                  const hook = this.pause;
                  this.pause = undefined;
                  await hook.work();
                }
                if (sql === MY_MONTHLY_PLANS_QUERY && this.failRead)
                  await target.query('SELECT 1/0');
                const result = await target.query(sql, values);
                if (
                  sql === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED' &&
                  this.shadow
                ) {
                  this.shadow = false;
                  await target.query(
                    'CREATE TEMP TABLE duties (id uuid) ON COMMIT DROP',
                  );
                }
                if (
                  sql === MY_MONTHLY_PLANS_QUERY &&
                  this.pause?.stage === 'afterRead'
                ) {
                  const hook = this.pause;
                  this.pause = undefined;
                  await hook.work();
                }
                return result;
              };
            const value: unknown = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
      ),
    );
  }
}
let pool: TestPool, app: INestApplication<App>, db: ObservedDatabase;
let a: SyntheticTenant,
  b: SyntheticTenant,
  own: SyntheticEmployee,
  coworker: SyntheticEmployee,
  project: SyntheticProject;
let employee: SyntheticSession,
  admin: SyntheticSession,
  foreign: SyntheticSession,
  plan: string,
  duty: string;
const releaseAll: (() => void)[] = [],
  pending: Promise<unknown>[] = [],
  clients: PoolClient[] = [];
const read = (
  query = `monthStart=${MONTH}`,
  session: SyntheticSession | null = employee,
) => {
  const operation = request(app.getHttpServer()).get(
    `${BASE}${query ? `?${query}` : ''}`,
  );
  return session ? operation.set('Cookie', session.cookie) : operation;
};
const pause = (stage: 'prefix' | 'beforeRead' | 'afterRead') => {
  const entered = latch(),
    proceed = latch();
  releaseAll.push(proceed.release);
  db.pause = {
    stage,
    work: async () => {
      entered.release();
      await proceed.promise;
    },
  };
  return { entered: entered.promise, release: proceed.release };
};
async function waitForBlocked(pid: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (
      (
        await pool.query<{ blocked: boolean }>(
          'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
          [pid],
        )
      ).rows[0].blocked
    )
      return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('Expected deterministic PostgreSQL lock wait');
}
beforeAll(() => {
  pool = openLocalTestPool(12);
  process.env.APP_ORIGIN = ORIGIN;
});
beforeEach(async () => {
  a = await createSyntheticTenant(pool, 'SP14 A');
  b = await createSyntheticTenant(pool, 'SP14 B');
  own = await createSyntheticEmployee(pool, a.employee);
  coworker = await createStaff(pool, a.companyId);
  const sessions = realSessionService(pool);
  employee = await createSyntheticSession(sessions, a.employee);
  admin = await createSyntheticSession(sessions, a.admin);
  foreign = await createSyntheticSession(sessions, b.employee);
  project = await createSyntheticProject(
    pool,
    a.companyId,
    'Synthetic SP14 own',
  );
  await insertShiftConfiguration(
    pool,
    a.companyId,
    project.projectId,
    MONTH,
    STANDARD_SHIFTS,
  );
  await insertProjectAssignment(
    pool,
    a.companyId,
    own.employeeId,
    project.projectId,
    MONTH,
  );
  await insertProjectAssignment(
    pool,
    a.companyId,
    coworker.employeeId,
    project.projectId,
    MONTH,
  );
  plan = await insertPlan(pool, a.companyId, project.projectId, MONTH, {
    byAccountId: a.admin.accountId,
  });
  duty = await insertDuty(pool, {
    companyId: a.companyId,
    projectId: project.projectId,
    planId: plan,
    month: MONTH,
    dutyDate: '2026-12-31',
    kind: 'NACHT',
    startsAt: '2026-12-31T17:00:00Z',
    endsAt: '2027-01-01T05:00:00Z',
  });
  await insertMembership(pool, a.companyId, duty, own.employeeId);
  await insertMembership(pool, a.companyId, duty, coworker.employeeId);
  db = new ObservedDatabase();
  app = await bootEmployeesApp(new RecordingDelivery(), {
    database: db,
    clock: () => new Date('2026-11-30T23:30:00Z'),
  });
});
afterEach(async () => {
  releaseAll.splice(0).forEach((release) => release());
  for (const client of clients.splice(0)) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
  await Promise.allSettled(pending.splice(0));
  await app?.close();
  if (a && b) await removeSyntheticTenants(pool, [a.companyId, b.companyId]);
});
afterAll(async () => {
  await pool.end();
});

describe('SP14 real HTTP + PG ownership H1-H26/C1-C4', () => {
  it('H1/H6/H24 returns only own DTO, snapshots, no mutations/roster or private caching', async () => {
    const before = (
      await pool.query(
        'SELECT count(*)::int AS n FROM audit_event WHERE company_id=$1',
        [a.companyId],
      )
    ).rows[0];
    db.statements = [];
    const result = await read().expect(200);
    expect(result.body).toEqual({
      items: [
        {
          planId: plan,
          project: { id: project.projectId, name: project.name },
          monthStart: MONTH,
          duties: [
            {
              dutyId: duty,
              assignmentId: (
                await pool.query(
                  'SELECT id FROM plan_assignments WHERE company_id=$1 AND duty_id=$2 AND employee_id=$3',
                  [a.companyId, duty, own.employeeId],
                )
              ).rows[0].id,
              version: 1,
              dutyDate: '2026-12-31',
              shiftKind: 'NIGHT',
              startsAt: '2026-12-31T17:00:00Z',
              endsAt: '2027-01-01T05:00:00Z',
              dutyRole: 'EMPLOYEE',
              timeZone: 'Europe/Berlin',
            },
          ],
        },
      ],
    });
    for (const secret of [
      own.employeeId,
      coworker.employeeId,
      a.companyId,
      a.employee.accountId,
    ])
      expect(result.text).not.toContain(secret);
    expect(
      db.statements.filter((sql) => sql === MY_MONTHLY_PLANS_QUERY),
    ).toHaveLength(1);
    expect(
      db.statements.filter((sql) =>
        /UPDATE sessions\s+SET last_seen_at/.test(sql),
      ),
    ).toHaveLength(1);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM audit_event WHERE company_id=$1',
          [a.companyId],
        )
      ).rows[0],
    ).toEqual(before);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.headers.vary).toContain('Cookie');
    expect(result.headers.etag).toBeUndefined();
    expect((await read('monthStart=2027-01-01').expect(200)).body).toEqual({
      items: [],
    });
  });
  it('H2/H3 no plan and unpublished plan are indistinguishable', async () => {
    expect((await read('monthStart=2027-02-01').expect(200)).body).toEqual({
      items: [],
    });
    await pool.query(
      "UPDATE monthly_plans SET status='UNPUBLISHED',published_at=NULL,published_by_account_id=NULL WHERE id=$1",
      [plan],
    );
    expect((await read().expect(200)).body).toEqual({ items: [] });
  });
  it('H4/H5/H16 published linked empty plan hides coworker/placeholder/removed memberships', async () => {
    await pool.query(
      "UPDATE plan_assignments SET state='REMOVED',removed_at=clock_timestamp() WHERE employee_id=$1",
      [own.employeeId],
    );
    const result = await read().expect(200);
    expect(result.body.items).toHaveLength(1);
    expect(result.body.items[0].duties).toEqual([]);
    await pool.query(
      'UPDATE duties SET removed_at=clock_timestamp() WHERE id=$1',
      [duty],
    );
    expect((await read().expect(200)).body).toEqual(result.body);
  });
  it('H16 active membership on a removed duty is hidden', async () => {
    await pool.query(
      'UPDATE duties SET removed_at=clock_timestamp() WHERE id=$1',
      [duty],
    );
    expect((await read().expect(200)).body.items[0].duties).toEqual([]);
  });
  it('H7/H8/H22 unrelated projects/tenants cannot change the authorized payload or counts', async () => {
    const before = (await read().expect(200)).body;
    const other = await createSyntheticProject(pool, a.companyId);
    const alien = await createSyntheticProject(pool, b.companyId);
    await insertPlan(pool, a.companyId, other.projectId, MONTH, {
      byAccountId: a.admin.accountId,
    });
    const alienEmployee = await createSyntheticEmployee(pool, b.employee);
    const alienPlan = await insertPlan(
      pool,
      b.companyId,
      alien.projectId,
      MONTH,
      { byAccountId: b.admin.accountId },
    );
    const alienDuty = await insertDuty(pool, {
      companyId: b.companyId,
      projectId: alien.projectId,
      planId: alienPlan,
      month: MONTH,
      dutyDate: '2026-12-02',
      startsAt: '2026-12-02T05:00:00Z',
      endsAt: '2026-12-02T17:00:00Z',
    });
    await insertMembership(
      pool,
      b.companyId,
      alienDuty,
      alienEmployee.employeeId,
    );
    await insertProjectAssignment(
      pool,
      b.companyId,
      alienEmployee.employeeId,
      alien.projectId,
      MONTH,
    );
    expect((await read().expect(200)).body).toEqual(before);
    const foreignRead = await read(undefined, foreign).expect(200);
    expect(foreignRead.body.items[0].planId).toBe(alienPlan);
    expect(
      foreignRead.body.items[0].duties.map((d: { dutyId: string }) => d.dutyId),
    ).toEqual([alienDuty]);
    expect(foreignRead.text).not.toContain(duty);
    expect((await read().expect(200)).text).not.toContain(alienDuty);
    await pool.query(
      "UPDATE plan_assignments SET state='REMOVED',removed_at=clock_timestamp() WHERE employee_id=$1",
      [own.employeeId],
    );
    await pool.query('DELETE FROM project_assignments WHERE employee_id=$1', [
      own.employeeId,
    ]);
    expect((await read().expect(200)).body).toEqual({ items: [] });
  });
  it.each([
    'employeeId',
    'companyId',
    'role',
    'projectId',
    'planId',
    'status',
    'page',
    'sort',
  ])('H9/C4 refuses unknown %s without echo', async (field) => {
    const result = await read(
      `monthStart=${MONTH}&${field}=private-sentinel`,
    ).expect(400);
    expect(result.body.code).toBe('UNKNOWN_FIELD');
    expect(result.text).not.toContain('private-sentinel');
    if (field !== 'status') expect(result.text).not.toContain(field);
  });
  it('H10/H11 admin endpoint inaccessible to employee and personal endpoint inaccessible to admin', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/monthly-plans/${plan}`)
      .set('Cookie', employee.cookie)
      .expect(403);
    expect((await read(undefined, admin).expect(403)).body.code).toBe(
      'ACTION_FORBIDDEN',
    );
  });
  it.each([
    null,
    { cookie: '__Host-secureplan_session=invalid', csrf: '', rawToken: '' },
  ])('H12 guard401 wins over invalid query', async (session) => {
    const result = await read('bad=x', session).expect(401);
    expect(result.body.code).toBe('SESSION_REQUIRED');
    expect(result.headers['cache-control']).toBe('private, no-store');
  });
  it.each(['revoked', 'idle', 'absolute'])(
    'H13 rejects %s session',
    async (kind) => {
      await pool.query(
        kind === 'revoked'
          ? 'UPDATE sessions SET revoked_at=clock_timestamp() WHERE account_id=$1'
          : kind === 'idle'
            ? "UPDATE sessions SET created_at=clock_timestamp()-interval '10 hours',last_seen_at=clock_timestamp()-interval '9 hours' WHERE account_id=$1"
            : "UPDATE sessions SET created_at=clock_timestamp()-interval '1 hour',absolute_expires_at=clock_timestamp()-interval '1 second' WHERE account_id=$1",
        [a.employee.accountId],
      );
      const result = await read().expect(401);
      expect(result.body.code).toBe(
        kind === 'revoked' ? 'SESSION_REVOKED' : 'SESSION_EXPIRED',
      );
    },
  );
  it.each(['account', 'SUSPENDED', 'DEACTIVATED'])(
    'H14 refuses inactive authority %s',
    async (kind) => {
      await pool.query(
        kind === 'account'
          ? "UPDATE accounts SET status='DEACTIVATED' WHERE id=$1"
          : 'UPDATE companies SET status=$2 WHERE id=$1',
        kind === 'account' ? [a.employee.accountId] : [a.companyId, kind],
      );
      expect((await read().expect(401)).body.code).toBe('SESSION_REVOKED');
    },
  );
  it.each(['missing', 'inactive'])(
    'H15 generic403 for %s employee with still-active account',
    async (state) => {
      if (state === 'inactive')
        await pool.query(
          "UPDATE employees SET status='DEACTIVATED' WHERE id=$1",
          [own.employeeId],
        );
      else {
        await pool.query('DELETE FROM plan_assignments WHERE employee_id=$1', [
          own.employeeId,
        ]);
        await pool.query(
          'DELETE FROM project_assignments WHERE employee_id=$1',
          [own.employeeId],
        );
        await pool.query('DELETE FROM employees WHERE id=$1', [own.employeeId]);
      }
      expect((await read().expect(403)).body.code).toBe('ACTION_FORBIDDEN');
    },
  );
  it.each([
    ['', 'VALIDATION_FAILED'],
    ['employeeId=x', 'VALIDATION_FAILED'],
    ['monthStart=garbage', 'VALIDATION_FAILED'],
    ['monthStart=garbage&employeeId=x', 'VALIDATION_FAILED'],
    ['monthStart=', 'VALIDATION_FAILED'],
    ['monthStart=2026-12-01&monthStart=2026-12-01', 'VALIDATION_FAILED'],
    [
      'monthStart=2026-12-01&monthStart=2027-01-01&employeeId=x',
      'VALIDATION_FAILED',
    ],
    ['monthStart[]=2026-12-01', 'VALIDATION_FAILED'],
    ['monthStart[x]=2026-12-01', 'VALIDATION_FAILED'],
    ['monthStart=2026-12-01&monthStart[]=x', 'UNKNOWN_FIELD'],
    ['monthStart=2026-13-01', 'INVALID_DATE'],
    ['monthStart=2026-02-30', 'INVALID_DATE'],
    ['monthStart=0000-01-01', 'INVALID_DATE'],
    ['monthStart=2026-12-02', 'INVALID_MONTH_START'],
    ['monthStart=2026-13-01&employeeId=x', 'UNKNOWN_FIELD'],
    ['monthStart=10000-01-01', 'VALIDATION_FAILED'],
  ])('H17/C4 exact error for %s', async (query, code) => {
    const result = await read(query).expect(400);
    expect(result.body.code).toBe(code);
    expect(result.headers['cache-control']).toBe('private, no-store');
    if (query === 'monthStart=2026-13-01&employeeId=x') {
      expect(
        (await read('monthStart=2026-12-02&employeeId=x').expect(400)).body
          .code,
      ).toBe('UNKNOWN_FIELD');
    }
    if (query === 'monthStart[]=2026-12-01') {
      expect(
        (await read('monthStart%5B%5D=2026-12-01').expect(400)).body.code,
      ).toBe('VALIDATION_FAILED');
    }
  });
  it.each(['0001-01-01', '0099-01-01', '9999-12-01'])(
    'H17 accepts full-range %s',
    async (month) => {
      expect((await read(`monthStart=${month}`).expect(200)).body).toEqual({
        items: [],
      });
    },
  );
  it('H20 inactive readable but archived concealed in both union branches', async () => {
    await pool.query("UPDATE projects SET status='INACTIVE' WHERE id=$1", [
      project.projectId,
    ]);
    expect((await read().expect(200)).body.items).toHaveLength(1);
    await pool.query("UPDATE projects SET status='ARCHIVED' WHERE id=$1", [
      project.projectId,
    ]);
    expect((await read().expect(200)).body).toEqual({ items: [] });
  });
  it('H21/C1 own membership independently grants visibility, including replacement and current ineligibility', async () => {
    await pool.query('DELETE FROM project_assignments WHERE employee_id=$1', [
      own.employeeId,
    ]);
    await pool.query(
      "UPDATE employees SET shift_eligibility='TAG',employment_end='2026-01-01' WHERE id=$1",
      [own.employeeId],
    );
    await pool.query(
      "UPDATE plan_assignments SET source='REPLACEMENT' WHERE employee_id=$1",
      [own.employeeId],
    );
    expect((await read().expect(200)).body.items[0].duties[0].dutyId).toBe(
      duty,
    );
    const second = await createSyntheticProject(pool, a.companyId);
    await insertProjectAssignment(
      pool,
      a.companyId,
      own.employeeId,
      second.projectId,
      MONTH,
    );
    await insertPlan(pool, a.companyId, second.projectId, MONTH, {
      byAccountId: a.admin.accountId,
    });
    expect((await read().expect(200)).body.items).toHaveLength(2);
  });
  it('H23 real supported employee deactivation invalidates sessions', async () => {
    await pool.query(
      "UPDATE plan_assignments SET state='REMOVED',removed_at=clock_timestamp() WHERE employee_id=$1",
      [own.employeeId],
    );
    await request(app.getHttpServer())
      .post(`/api/v1/employees/${own.employeeId}/deactivate`)
      .set('Cookie', admin.cookie)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', admin.csrf)
      .send({})
      .expect(200);
    expect((await read().expect(401)).body.code).toBe('SESSION_REVOKED');
  });
  it('H25 success/errors/HEAD do not expose validators or private304', async () => {
    const result = await request(app.getHttpServer())
      .head(`${BASE}?monthStart=${MONTH}`)
      .set('Cookie', employee.cookie)
      .set('If-None-Match', '*')
      .expect(200);
    expect(result.text).toBeUndefined();
    expect(result.headers.etag).toBeUndefined();
    expect(result.headers['last-modified']).toBeUndefined();
    expect(result.headers['cache-control']).toBe('private, no-store');
    await read().set('If-None-Match', '*').expect(200);
  });
  it('H26 actual unusable schema and SQL failure are sanitized500, never empty fallback', async () => {
    db.shadow = true;
    let result = await read().expect(500);
    expect(result.body.code).toBe('INTERNAL_ERROR');
    expect(result.text).not.toContain('duties');
    db.failRead = true;
    result = await read().expect(500);
    expect(result.body.code).toBe('INTERNAL_ERROR');
    expect(result.headers['cache-control']).toBe('private, no-store');
  });
  it.each(['EMPLOYEE', 'COMPANY_ADMIN'] as const)(
    'R3 enriched/me for %s has authoritative zone/month and no cookie secrets',
    async (role) => {
      const result = await request(app.getHttpServer())
        .get('/api/v1/me')
        .set('Cookie', role === 'EMPLOYEE' ? employee.cookie : admin.cookie)
        .expect(200);
      expect(result.body).toMatchObject({
        role,
        companyTimeZone: 'Europe/Berlin',
        currentCompanyMonth: '2026-12-01',
      });
      expect(Object.keys(result.body).sort()).toEqual([
        'accountId',
        'companyId',
        'companyTimeZone',
        'currentCompanyMonth',
        'email',
        'role',
      ]);
      expect(result.headers['x-csrf-token']).toBe(
        role === 'EMPLOYEE' ? employee.csrf : admin.csrf,
      );
      expect(result.headers['cache-control']).toBe('private, no-store');
    },
  );
  it('R3 invalid stored company zone fails/me closed', async () => {
    await pool.query("UPDATE companies SET time_zone='+01:00' WHERE id=$1", [
      a.companyId,
    ]);
    const result = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Cookie', employee.cookie)
      .expect(500);
    expect(result.body.code).toBe('INTERNAL_ERROR');
    expect(result.headers['cache-control']).toBe('private, no-store');
  });
});

describe('SP14 deterministic real PG concurrency D2/D3/R6', () => {
  it.each(['COMMIT', 'ROLLBACK'])(
    'H18/H19 one-statement snapshot across concurrent CR03 %s',
    async (finish) => {
      const gate = pause('afterRead');
      const operation = read().then((result) => result);
      pending.push(operation);
      await gate.entered;
      const writer = await pool.connect();
      clients.push(writer);
      await writer.query('BEGIN');
      await writer.query(
        "UPDATE duties SET ends_at='2027-01-01T06:00:00Z' WHERE id=$1",
        [duty],
      );
      await writer.query(
        "UPDATE plan_assignments SET duty_function='SCHICHTLEITER' WHERE employee_id=$1",
        [own.employeeId],
      );
      await writer.query(finish);
      gate.release();
      const before = await operation;
      expect(before.status).toBe(200);
      expect(before.body.items[0].duties[0]).toMatchObject({
        endsAt: '2027-01-01T05:00:00Z',
        dutyRole: 'EMPLOYEE',
      });
      const after = await read().expect(200);
      expect(after.body.items[0].duties[0]).toMatchObject(
        finish === 'COMMIT'
          ? { endsAt: '2027-01-01T06:00:00Z', dutyRole: 'SHIFT_LEAD' }
          : { endsAt: '2027-01-01T05:00:00Z', dutyRole: 'EMPLOYEE' },
      );
    },
  );
  it('revoke committed after guard but before prefix is rejected', async () => {
    const gate = pause('prefix');
    const operation = read().then((result) => result);
    pending.push(operation);
    await gate.entered;
    await realSessionService(pool).revoke(employee.rawToken);
    gate.release();
    const result = await operation;
    expect(result.status).toBe(401);
    expect(result.body.code).toBe('SESSION_REVOKED');
  });
  it.each(['COMMIT', 'ROLLBACK'])(
    'read-first holds A while revoke writer waits, %s disposition',
    async (finish) => {
      const gate = pause('beforeRead');
      const operation = read().then((result) => result);
      pending.push(operation);
      await gate.entered;
      const writer = await pool.connect();
      clients.push(writer);
      await writer.query('BEGIN');
      const pid = (
        await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0].pid;
      const update = writer.query(
        'SELECT id FROM accounts WHERE id=$1 FOR UPDATE',
        [a.employee.accountId],
      );
      pending.push(update);
      await waitForBlocked(pid);
      gate.release();
      expect((await operation).status).toBe(200);
      await update;
      await writer.query(
        'UPDATE sessions SET revoked_at=clock_timestamp() WHERE account_id=$1',
        [a.employee.accountId],
      );
      await writer.query(finish);
      await read().expect(finish === 'COMMIT' ? 401 : 200);
    },
  );
  it.each(['prefix', 'afterRead'] as const)(
    'expiry at %s check fails closed',
    async (stage) => {
      const gate = pause(stage);
      const operation = read().then((result) => result);
      pending.push(operation);
      await gate.entered;
      // Synthetic clock-aging fixture only; does not claim a supported session writer.
      await pool.query(
        "UPDATE sessions SET created_at=clock_timestamp()-interval '1 hour',absolute_expires_at=clock_timestamp()-interval '1 second' WHERE account_id=$1",
        [a.employee.accountId],
      );
      gate.release();
      const result = await operation;
      expect(result.status).toBe(401);
      expect(result.body.code).toBe('SESSION_EXPIRED');
    },
  );
  it('role change after guard before prefix returns403 and no schedule', async () => {
    const gate = pause('prefix');
    const operation = read().then((result) => result);
    pending.push(operation);
    await gate.entered;
    await pool.query("UPDATE accounts SET role='COMPANY_ADMIN' WHERE id=$1", [
      a.employee.accountId,
    ]);
    gate.release();
    const result = await operation;
    expect(result.status).toBe(403);
    expect(result.body.code).toBe('ACTION_FORBIDDEN');
  });
});

describe('SP14 additional real writer, integrity and snapshot regressions', () => {
  it('H18 real CR03 leased PATCH is visible without republishing', async () => {
    await pool.query(
      "UPDATE employees SET employment_start='2020-01-01' WHERE id=$1",
      [own.employeeId],
    );
    const path = `/api/v1/monthly-plans/${plan}/entries/${duty}`;
    const lease = await request(app.getHttpServer())
      .post(`${path}/edit-lease`)
      .set('Cookie', admin.cookie)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', admin.csrf)
      .expect(200);
    const before = (
      await pool.query('SELECT published_at FROM monthly_plans WHERE id=$1', [
        plan,
      ])
    ).rows;
    const changed = await request(app.getHttpServer())
      .patch(path)
      .set('Cookie', admin.cookie)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', admin.csrf)
      .set('Expected-Version', '1')
      .set('Edit-Lease-Token', lease.body.leaseToken)
      .send({
        dutyDate: '2026-12-30',
        shiftKind: 'DAY',
        assignments: [
          { employeeId: own.employeeId, dutyRole: 'SHIFT_LEAD' },
          { employeeId: coworker.employeeId, dutyRole: 'EMPLOYEE' },
        ],
      });
    expect([changed.status, changed.body.code]).toEqual([200, undefined]);
    expect((await read().expect(200)).body.items[0].duties[0]).toMatchObject({
      dutyRole: 'SHIFT_LEAD',
      dutyDate: '2026-12-30',
      shiftKind: 'DAY',
      startsAt: '2026-12-30T05:00:00Z',
      endsAt: '2026-12-30T17:00:00Z',
    });
    for (const includeOwner of [false, true]) {
      await request(app.getHttpServer())
        .patch(path)
        .set('Cookie', admin.cookie)
        .set('Origin', ORIGIN)
        .set('X-CSRF-Token', admin.csrf)
        .set('Expected-Version', includeOwner ? '3' : '2')
        .set('Edit-Lease-Token', lease.body.leaseToken)
        .send({
          assignments: [
            ...(includeOwner
              ? [{ employeeId: own.employeeId, dutyRole: 'EMPLOYEE' }]
              : []),
            { employeeId: coworker.employeeId, dutyRole: 'EMPLOYEE' },
          ],
        })
        .expect(200);
      expect((await read().expect(200)).body.items[0].duties).toHaveLength(
        includeOwner ? 1 : 0,
      );
    }
    expect(
      (
        await pool.query('SELECT published_at FROM monthly_plans WHERE id=$1', [
          plan,
        ])
      ).rows,
    ).toEqual(before);
  });
  it('D1 composite tenant FKs reject foreign memberships and employee-account pairs', async () => {
    const alien = await createSyntheticEmployee(pool, b.employee);
    await expect(
      insertMembership(pool, a.companyId, duty, alien.employeeId),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      pool.query('UPDATE employees SET account_id=$2 WHERE id=$1', [
        own.employeeId,
        b.employee.accountId,
      ]),
    ).rejects.toMatchObject({ code: '23503' });
    expect((await read().expect(200)).body.items[0].duties).toHaveLength(1);
  });
  it.each([
    ['2026-03-29', '2026-03-29T01:30:00Z', 'Europe/Berlin'],
    ['2026-10-25', '2026-10-25T00:30:00Z', 'Europe/Berlin'],
    ['2026-03-08', '2026-03-08T07:30:00Z', 'America/New_York'],
    ['2026-11-01', '2026-11-01T05:30:00Z', 'America/New_York'],
  ])('D4 immutable saved DST golden %s %s %s', async (date, start, zone) => {
    const month = `${date.slice(0, 7)}-01`;
    const p = await insertPlan(pool, a.companyId, project.projectId, month, {
      byAccountId: a.admin.accountId,
    });
    const end = new Date(Date.parse(start) + 3600000)
      .toISOString()
      .replace('.000Z', 'Z');
    const id = await insertDuty(pool, {
      companyId: a.companyId,
      projectId: project.projectId,
      planId: p,
      month,
      dutyDate: date,
      startsAt: start,
      endsAt: end,
    });
    await pool.query('UPDATE duties SET time_zone=$2 WHERE id=$1', [id, zone]);
    await insertMembership(pool, a.companyId, id, own.employeeId);
    const saved = async () =>
      (
        await pool.query(
          'SELECT starts_at::text,ends_at::text,time_zone FROM duties WHERE id=$1',
          [id],
        )
      ).rows;
    const before = await saved();
    await pool.query(
      "UPDATE companies SET time_zone='Pacific/Auckland' WHERE id=$1",
      [a.companyId],
    );
    expect(
      (await read(`monthStart=${month}`).expect(200)).body.items[0].duties[0],
    ).toMatchObject({
      startsAt: start,
      endsAt: end,
      timeZone: zone,
      dutyDate: date,
    });
    expect(await saved()).toEqual(before);
    if (zone === 'Europe/Berlin') {
      const spring = date === '2026-03-29';
      const previous = spring ? '2026-03-28' : '2026-10-24';
      const starts = `${previous}T${spring ? '17' : '16'}:00:00Z`;
      const ends = `${date}T${spring ? '04' : '05'}:00:00Z`;
      const night = await insertDuty(pool, {
        companyId: a.companyId,
        projectId: project.projectId,
        planId: p,
        month,
        dutyDate: previous,
        kind: 'NACHT',
        startsAt: starts,
        endsAt: ends,
      });
      await insertMembership(pool, a.companyId, night, own.employeeId);
      const response = await read(`monthStart=${month}`).expect(200);
      const snapshot = response.body.items[0].duties.find(
        (value: { dutyId: string }) => value.dutyId === night,
      );
      expect(snapshot).toMatchObject({
        startsAt: starts,
        endsAt: ends,
        dutyDate: previous,
        timeZone: 'Europe/Berlin',
      });
      expect(
        (Date.parse(snapshot.endsAt) - Date.parse(snapshot.startsAt)) / 3600000,
      ).toBe(spring ? 11 : 13);
    }
  });
  it.each(['COMMIT', 'ROLLBACK'])(
    'D2 First Publish %s has no half-published read',
    async (finish) => {
      await pool.query(
        "UPDATE monthly_plans SET status='UNPUBLISHED',published_at=NULL,published_by_account_id=NULL WHERE id=$1",
        [plan],
      );
      const writer = await pool.connect();
      clients.push(writer);
      await writer.query('BEGIN');
      await writer.query(
        "UPDATE monthly_plans SET status='PUBLISHED',published_at=clock_timestamp(),published_by_account_id=$2 WHERE id=$1",
        [plan, a.admin.accountId],
      );
      expect((await read().expect(200)).body).toEqual({ items: [] });
      await writer.query(finish);
      expect((await read().expect(200)).body.items).toHaveLength(
        finish === 'COMMIT' ? 1 : 0,
      );
    },
  );
  it('D3 actual A-lock wait expires before data is read', async () => {
    const gate = pause('prefix');
    const operation = read().then((result) => result);
    pending.push(operation);
    await gate.entered;
    const writer = await pool.connect();
    clients.push(writer);
    await writer.query('BEGIN');
    await writer.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [
      a.employee.accountId,
    ]);
    gate.release();
    let waiting = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const { rows } = await pool.query<{ blocked: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR SHARE%') AS blocked",
      );
      if (rows[0].blocked) {
        waiting = true;
        break;
      }
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(waiting).toBe(true);
    await writer.query(
      "UPDATE sessions SET created_at=clock_timestamp()-interval '1 hour',absolute_expires_at=clock_timestamp()-interval '1 second' WHERE account_id=$1",
      [a.employee.accountId],
    );
    await writer.query('COMMIT');
    const result = await operation;
    expect(result.status).toBe(401);
    expect(result.body.code).toBe('SESSION_EXPIRED');
  });
  it.each(['COMMIT', 'ROLLBACK'])(
    'D3 deactivation writer-first %s fails closed or preserves authority',
    async (finish) => {
      const gate = pause('prefix');
      const operation = read().then((result) => result);
      pending.push(operation);
      await gate.entered;
      const writer = await pool.connect();
      clients.push(writer);
      await writer.query('BEGIN');
      await writer.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [
        a.employee.accountId,
      ]);
      await writer.query(
        "UPDATE accounts SET status='DEACTIVATED' WHERE id=$1",
        [a.employee.accountId],
      );
      await writer.query(
        "UPDATE employees SET status='DEACTIVATED' WHERE id=$1",
        [own.employeeId],
      );
      await writer.query(
        'UPDATE sessions SET revoked_at=clock_timestamp() WHERE account_id=$1',
        [a.employee.accountId],
      );
      await writer.query(finish);
      gate.release();
      expect((await operation).status).toBe(finish === 'COMMIT' ? 401 : 200);
    },
  );
});

describe('SP14 complete visibility and authority race regressions', () => {
  it('H1/H5 same-day DAY precedes NIGHT; unassigned live placeholder has no employee duty', async () => {
    const day = await insertDuty(pool, {
      companyId: a.companyId,
      projectId: project.projectId,
      planId: plan,
      month: MONTH,
      dutyDate: '2026-12-31',
      startsAt: '2026-12-31T05:00:00Z',
      endsAt: '2026-12-31T17:00:00Z',
    });
    await insertMembership(pool, a.companyId, day, own.employeeId);
    expect(
      (await read().expect(200)).body.items[0].duties.map(
        (d: { shiftKind: string }) => d.shiftKind,
      ),
    ).toEqual(['DAY', 'NIGHT']);
    await pool.query('DELETE FROM plan_assignments WHERE company_id=$1', [
      a.companyId,
    ]);
    expect((await read().expect(200)).body.items[0].duties).toEqual([]);
  });
  it.each(['deactivate', 'role'])(
    'D3 %s rollback before read retains original authority',
    async (kind) => {
      const gate = pause('prefix');
      const operation = read().then((result) => result);
      pending.push(operation);
      await gate.entered;
      const writer = await pool.connect();
      clients.push(writer);
      await writer.query('BEGIN');
      await writer.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [
        a.employee.accountId,
      ]);
      await writer.query(
        kind === 'role'
          ? "UPDATE accounts SET role='COMPANY_ADMIN' WHERE id=$1"
          : "UPDATE accounts SET status='DEACTIVATED' WHERE id=$1",
        [a.employee.accountId],
      );
      await writer.query('ROLLBACK');
      gate.release();
      expect((await operation).status).toBe(200);
    },
  );
  it.each([
    ['deactivate', 'COMMIT'],
    ['deactivate', 'ROLLBACK'],
    ['role', 'COMMIT'],
    ['role', 'ROLLBACK'],
  ])(
    'D3 read-first blocks %s %s and follows next-read outcome',
    async (kind, finish) => {
      const gate = pause('beforeRead');
      const operation = read().then((result) => result);
      pending.push(operation);
      await gate.entered;
      const writer = await pool.connect();
      clients.push(writer);
      await writer.query('BEGIN');
      const pid = (
        await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0].pid;
      const lock = writer.query(
        'SELECT id FROM accounts WHERE id=$1 FOR UPDATE',
        [a.employee.accountId],
      );
      pending.push(lock);
      await waitForBlocked(pid);
      gate.release();
      expect((await operation).status).toBe(200);
      await lock;
      await writer.query(
        kind === 'role'
          ? "UPDATE accounts SET role='COMPANY_ADMIN' WHERE id=$1"
          : "UPDATE accounts SET status='DEACTIVATED' WHERE id=$1",
        [a.employee.accountId],
      );
      await writer.query(finish);
      await read().expect(
        finish === 'ROLLBACK' ? 200 : kind === 'role' ? 403 : 401,
      );
    },
  );
});

it('R7 case-insensitive Express route aliases keep the private cache boundary on successes and errors', async () => {
  for (const [suffix, session, status] of [
    [`?monthStart=${MONTH}`, employee, 200],
    ['?monthStart=bad', employee, 400],
    [`?monthStart=${MONTH}`, null, 401],
  ] as const) {
    const operation = request(app.getHttpServer())
      .get('/API/V1/ME/MONTHLY-PLANS' + suffix)
      .set('If-None-Match', '*');
    if (session) operation.set('Cookie', session.cookie);
    const response = await operation.expect(status);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers.etag).toBeUndefined();
  }
});
