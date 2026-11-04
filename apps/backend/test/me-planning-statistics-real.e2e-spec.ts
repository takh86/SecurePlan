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

const BASE = '/api/v1/me/planning-statistics',
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
  timeoutRead = false;
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
                if (sql === MY_MONTHLY_PLANS_QUERY && this.timeoutRead) {
                  await target.query("SET LOCAL statement_timeout = '1ms'");
                  await target.query('SELECT pg_sleep(0.02)');
                }
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
  a = await createSyntheticTenant(pool, 'SP15 A');
  b = await createSyntheticTenant(pool, 'SP15 B');
  own = await createSyntheticEmployee(pool, a.employee);
  coworker = await createStaff(pool, a.companyId);
  const sessions = realSessionService(pool);
  employee = await createSyntheticSession(sessions, a.employee);
  admin = await createSyntheticSession(sessions, a.admin);
  foreign = await createSyntheticSession(sessions, b.employee);
  project = await createSyntheticProject(
    pool,
    a.companyId,
    'Synthetic SP15 own',
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

const counts = (
  plannedWorkdays: number,
  dayShiftCount: number,
  nightShiftCount: number,
  monthStart = MONTH,
) => ({ monthStart, plannedWorkdays, dayShiftCount, nightShiftCount });
async function addDay() {
  const id = await insertDuty(pool, {
    companyId: a.companyId,
    projectId: project.projectId,
    planId: plan,
    month: MONTH,
    dutyDate: '2026-12-04',
    startsAt: '2026-12-04T05:00:00Z',
    endsAt: '2026-12-04T17:00:00Z',
  });
  await insertMembership(pool, a.companyId, id, own.employeeId);
  return id;
}
describe('SP15 real Nest HTTP/PostgreSQL contract H01-H08 K01-K02', () => {
  it('H01/H08 exact counts from one owner statement, one read transaction and unchanged session protocol', async () => {
    await addDay();
    db.statements = [];
    const result = await read().expect(200);
    expect(result.body).toEqual(counts(2, 1, 1));
    expect(
      db.statements.filter((sql) => sql === MY_MONTHLY_PLANS_QUERY),
    ).toHaveLength(1);
    expect(
      db.statements.filter(
        (sql) => sql === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
      ),
    ).toHaveLength(1);
    expect(
      db.statements.filter((sql) =>
        /UPDATE sessions\s+SET last_seen_at/.test(sql),
      ),
    ).toHaveLength(1);
    const statements = db.statements.slice();
    // The entire DB statement trace equals the established owner read under stable data.
    const personal = await request(app.getHttpServer())
      .get(`/api/v1/me/monthly-plans?monthStart=${MONTH}`)
      .set('Cookie', employee.cookie)
      .expect(200);
    expect(db.statements.slice(statements.length)).toEqual(statements);
    const duties = (
      personal.body as {
        items: { duties: { dutyDate: string; shiftKind: string }[] }[];
      }
    ).items.flatMap((p) => p.duties);
    expect(result.body).toEqual(
      counts(
        new Set(duties.map((d) => d.dutyDate)).size,
        duties.filter((d) => d.shiftKind === 'DAY').length,
        duties.filter((d) => d.shiftKind === 'NIGHT').length,
      ),
    );
    expect(result.headers['cache-control']).toBe('private, no-store');
  });
  it('H02 legacy SQL P1 saved own membership with no current link and one new linked empty plan', async () => {
    await pool.query('DELETE FROM project_assignments WHERE employee_id=$1', [
      own.employeeId,
    ]);
    await pool.query(
      "UPDATE plan_assignments SET source='REPLACEMENT',duty_function='SCHICHTLEITER' WHERE employee_id=$1",
      [own.employeeId],
    );
    await pool.query(
      "UPDATE employees SET shift_eligibility='TAG',employment_end='2026-01-01' WHERE id=$1",
      [own.employeeId],
    );
    expect((await read().expect(200)).body).toEqual(counts(1, 0, 1));
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
    expect((await read().expect(200)).body).toEqual(counts(1, 0, 1));
    await pool.query(
      "UPDATE plan_assignments SET state='REMOVED',removed_at=clock_timestamp() WHERE employee_id=$1",
      [own.employeeId],
    );
    expect((await read().expect(200)).body).toEqual(counts(0, 0, 0));
  });
  it('H03 same zero response for missing, unpublished, own-empty and removed duties', async () => {
    expect((await read('monthStart=2027-01-01').expect(200)).body).toEqual(
      counts(0, 0, 0, '2027-01-01'),
    );
    await pool.query(
      "UPDATE monthly_plans SET status='UNPUBLISHED',published_at=NULL,published_by_account_id=NULL WHERE id=$1",
      [plan],
    );
    expect((await read().expect(200)).body).toEqual(counts(0, 0, 0));
    await pool.query(
      "UPDATE monthly_plans SET status='PUBLISHED',published_at=clock_timestamp(),published_by_account_id=$2 WHERE id=$1",
      [plan, a.admin.accountId],
    );
    await pool.query(
      "UPDATE plan_assignments SET state='REMOVED',removed_at=clock_timestamp() WHERE employee_id=$1",
      [own.employeeId],
    );
    expect((await read().expect(200)).body).toEqual(counts(0, 0, 0));
    await pool.query(
      'UPDATE duties SET removed_at=clock_timestamp() WHERE id=$1',
      [duty],
    );
    expect((await read().expect(200)).body).toEqual(counts(0, 0, 0));
  });
  it('H04 isolated coworker, unrelated project and tenant cannot alter counts', async () => {
    const before = (await read().expect(200)).body;
    const alienEmployee = await createSyntheticEmployee(pool, b.employee);
    for (const [tenant, staff] of [
      [a, coworker],
      [b, alienEmployee],
    ] as const) {
      const p = await createSyntheticProject(pool, tenant.companyId);
      const mp = await insertPlan(pool, tenant.companyId, p.projectId, MONTH, {
        byAccountId: tenant.admin.accountId,
      });
      const d = await insertDuty(pool, {
        companyId: tenant.companyId,
        projectId: p.projectId,
        planId: mp,
        month: MONTH,
        dutyDate: '2026-12-06',
        startsAt: '2026-12-06T05:00:00Z',
        endsAt: '2026-12-06T17:00:00Z',
      });
      await insertMembership(pool, tenant.companyId, d, staff.employeeId);
    }
    expect((await read().expect(200)).body).toEqual(before);
    expect((await read(undefined, foreign).expect(200)).body).toEqual(
      counts(1, 1, 0),
    );
    await pool.query("UPDATE projects SET status='INACTIVE' WHERE id=$1", [
      project.projectId,
    ]);
    expect((await read().expect(200)).body).toEqual(before);
    await pool.query("UPDATE projects SET status='ARCHIVED' WHERE id=$1", [
      project.projectId,
    ]);
    expect((await read().expect(200)).body).toEqual(counts(0, 0, 0));
  });
  it.each(['schema', 'SQL', 'integrity', 'timeout'])(
    'H07 sanitizes %s failures with correlation and no zero fallback',
    async (kind) => {
      if (kind === 'schema') db.shadow = true;
      else if (kind === 'SQL') db.failRead = true;
      else if (kind === 'timeout') db.timeoutRead = true;
      else
        await pool.query("UPDATE duties SET time_zone='+01:00' WHERE id=$1", [
          duty,
        ]);
      const r = await read().expect(500);
      expect(r.body).toMatchObject({
        status: 500,
        code: 'INTERNAL_ERROR',
        correlationId: expect.any(String),
      });
      expect(r.headers['content-type']).toContain('application/problem+json');
      expect(r.headers['x-correlation-id']).toBe(r.body.correlationId);
      expect(r.body.plannedWorkdays).toBeUndefined();
      expect(r.text).not.toContain(duty);
    },
  );
  it('D01 rejects second monthly link, duplicate live slot, active membership and foreign FK', async () => {
    const other = await createSyntheticProject(pool, a.companyId),
      alien = await createSyntheticEmployee(pool, b.employee);
    await expect(
      insertProjectAssignment(
        pool,
        a.companyId,
        own.employeeId,
        other.projectId,
        MONTH,
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      insertMembership(pool, a.companyId, duty, own.employeeId),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      insertDuty(pool, {
        companyId: a.companyId,
        projectId: project.projectId,
        planId: plan,
        month: MONTH,
        dutyDate: '2026-12-31',
        kind: 'NACHT',
        startsAt: '2026-12-31T17:00:00Z',
        endsAt: '2027-01-01T05:00:00Z',
      }),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      insertMembership(pool, a.companyId, duty, alien.employeeId),
    ).rejects.toMatchObject({ code: '23503' });
    expect((await read().expect(200)).body).toEqual(counts(1, 0, 1));
  });
  it.each(['get', 'head'] as const)(
    'K01/K02 %s success/error/aliases/conditional never cache or 304',
    async (method) => {
      for (const path of [
        BASE,
        BASE + '/',
        BASE.toUpperCase(),
        BASE.toUpperCase() + '/',
      ]) {
        for (const [query, session, status] of [
          [`monthStart=${MONTH}`, employee, 200],
          ['monthStart=bad', employee, 400],
          [`monthStart=${MONTH}`, null, 401],
          [`monthStart=${MONTH}`, admin, 403],
        ] as const) {
          const op = request(app.getHttpServer())
            [method](`${path}?${query}`)
            .set('If-None-Match', '*')
            .set('If-Modified-Since', 'Wed, 04 Nov 2099 00:00:00 GMT');
          if (session) op.set('Cookie', session.cookie);
          const r = await op.expect(status);
          expect(r.headers['cache-control']).toBe('private, no-store');
          expect(r.headers.pragma).toBe('no-cache');
          expect(r.headers.vary).toContain('Cookie');
          expect(r.headers.etag).toBeUndefined();
          expect(r.headers['last-modified']).toBeUndefined();
          if (method === 'head') expect(r.text).toBeUndefined();
        }
      }
      db.failRead = true;
      const r = await request(app.getHttpServer())
        [method](`${BASE}?monthStart=${MONTH}`)
        .set('Cookie', employee.cookie)
        .set('If-None-Match', '*')
        .expect(500);
      expect(r.headers['cache-control']).toBe('private, no-store');
      expect(r.headers.etag).toBeUndefined();
    },
  );
  it.each(['COMMIT', 'ROLLBACK'])(
    'C02 single old/new count snapshot around %s',
    async (finish) => {
      await addDay();
      const gate = pause('afterRead'),
        op = read().then((r) => r);
      pending.push(op);
      await gate.entered;
      const writer = await pool.connect();
      clients.push(writer);
      await writer.query('BEGIN');
      await writer.query(
        "UPDATE plan_assignments SET state='REMOVED',removed_at=clock_timestamp() WHERE duty_id=$1 AND employee_id=$2",
        [duty, own.employeeId],
      );
      await writer.query(finish);
      gate.release();
      expect((await op).body).toEqual(counts(2, 1, 1));
      expect((await read().expect(200)).body).toEqual(
        finish === 'COMMIT' ? counts(1, 1, 0) : counts(2, 1, 1),
      );
    },
  );
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
    {
      cookie: '__Host-secureplan_session=' + 'A'.repeat(43),
      csrf: '',
      rawToken: '',
    },
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
    ['month=2026-12', 'VALIDATION_FAILED'],
    ['monthStart=2026-12-01&month=2026-12', 'UNKNOWN_FIELD'],
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
      expect((await read(`monthStart=${month}`).expect(200)).body).toEqual(
        counts(0, 0, 0, month),
      );
    },
  );
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
    expect((await read().expect(200)).body).toEqual(counts(1, 1, 0));
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
      expect((await read().expect(200)).body).toEqual(
        includeOwner ? counts(1, 1, 0) : counts(0, 0, 0),
      );
    }
    expect(
      (
        await pool.query('SELECT published_at FROM monthly_plans WHERE id=$1', [
          plan,
        ])
      ).rows,
    ).toEqual(before);
    await request(app.getHttpServer())
      .delete(path)
      .set('Cookie', admin.cookie)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', admin.csrf)
      .set('Expected-Version', '4')
      .set('Edit-Lease-Token', lease.body.leaseToken)
      .expect(204);
    expect((await read().expect(200)).body).toEqual(counts(0, 0, 0));
  });
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
