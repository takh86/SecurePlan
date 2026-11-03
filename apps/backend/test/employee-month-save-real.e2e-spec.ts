/** Actual A2 routes, guards, SQL, leases, receipts and transaction fault injection. */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types.js';
import { DatabaseService } from '../src/database/database.service.js';
import { SessionService } from '../src/auth/session.service.js';
import { EmployeeMonthService } from '../src/modules/planning/employee-month.service.js';
import { EmployeeMonthIdempotencyService } from '../src/modules/planning/employee-month-idempotency.service.js';
import {
  BusinessAuditService,
  type BusinessAuditEntry,
} from '../src/modules/audit/business-audit.service.js';
import type { SaveEmployeeMonth } from '../src/modules/planning/employee-month.contract.js';
import {
  bootEmployeesApp,
  ORIGIN,
  RecordingDelivery,
} from './helpers/employees-test-app.js';
import {
  dutyMutationFixture,
  dutyPath,
  MUTATION_DAY,
  MUTATION_MONTH,
  MUTATION_NOW,
  type DutyMutationFixture,
} from './helpers/duty-mutation-fixtures.js';
import {
  insertDuty,
  insertMembership,
  insertPlan,
  insertProjectAssignment,
  planningState,
} from './helpers/planning-fixtures.js';
import {
  openLocalTestPool,
  removeSyntheticTenants,
  type TestPool,
  type SyntheticSession,
} from './helpers/synthetic-tenants.js';

let pool: TestPool,
  app: INestApplication<App> | undefined,
  f: DutyMutationFixture;
const companies: string[] = [];
const flights: Promise<unknown>[] = [];
const releaseAll: (() => void)[] = [];
let priorOrigin: string | undefined;
const path = (plan = f.planId, employee = f.mira.employeeId) =>
  `/api/v1/monthly-plans/${plan}/employee-months/${employee}`;
async function boot(options: Parameters<typeof bootEmployeesApp>[1] = {}) {
  await app?.close();
  app = await bootEmployeesApp(new RecordingDelivery(), {
    clock: () => new Date(MUTATION_NOW),
    ...options,
  });
}
const read = (
  session = f.admin,
  plan = f.planId,
  employee = f.mira.employeeId,
) =>
  request(app!.getHttpServer())
    .get(path(plan, employee))
    .set('Origin', ORIGIN)
    .set('Cookie', session.cookie);
async function draft(
  plan = f.planId,
  employee = f.mira.employeeId,
): Promise<SaveEmployeeMonth> {
  const r = await read(f.admin, plan, employee);
  expect(r.status).toBe(200);
  return {
    expectedPlan: {
      status: r.body.plan.status,
      publishedAt: r.body.plan.publishedAt,
    },
    expectedCreationContext: r.body.creationContextFingerprint,
    expectedCalendar:
      r.body.operatingCalendar.effective === null
        ? null
        : {
            id: r.body.operatingCalendar.effective.id,
            version: r.body.operatingCalendar.effective.version,
          },
    days: r.body.days.map(
      (d: {
        date: string;
        day: {
          dutyId: string;
          version: number;
          assignment: { dutyRole: 'EMPLOYEE' | 'SHIFT_LEAD' } | null;
        } | null;
        night: {
          dutyId: string;
          version: number;
          assignment: { dutyRole: 'EMPLOYEE' | 'SHIFT_LEAD' } | null;
        } | null;
      }) => ({
        date: d.date,
        expected: {
          day: d.day ? { id: d.day.dutyId, version: d.day.version } : null,
          night: d.night
            ? { id: d.night.dutyId, version: d.night.version }
            : null,
        },
        desired: d.day?.assignment
          ? { state: 'DAY', role: d.day.assignment.dutyRole }
          : d.night?.assignment
            ? { state: 'NIGHT', role: d.night.assignment.dutyRole }
            : { state: 'OFF' },
      }),
    ),
  };
}
function save(
  body: object,
  key = randomUUID(),
  session: SyntheticSession = f.admin,
  plan = f.planId,
  employee = f.mira.employeeId,
) {
  return request(app!.getHttpServer())
    .post(`${path(plan, employee)}/save`)
    .set('Origin', ORIGIN)
    .set('Cookie', session.cookie)
    .set('X-CSRF-Token', session.csrf)
    .set('Idempotency-Key', key)
    .send(body);
}
const lookup = (
  key: string,
  session = f.admin,
  plan = f.planId,
  employee = f.mira.employeeId,
) =>
  request(app!.getHttpServer())
    .get(`${path(plan, employee)}/save-result`)
    .set('Origin', ORIGIN)
    .set('Cookie', session.cookie)
    .set('Idempotency-Key', key);
const paint = (
  dto: SaveEmployeeMonth,
  day: string,
  state: 'DAY' | 'NIGHT' | 'OFF',
  role: 'EMPLOYEE' | 'SHIFT_LEAD' = 'EMPLOYEE',
) => {
  dto.days.find((d) => d.date === day)!.desired =
    state === 'OFF' ? { state } : { state, role };
};
beforeAll(() => {
  pool = openLocalTestPool(8);
  priorOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
});
beforeEach(async () => {
  f = await dutyMutationFixture(pool, companies);
  await boot();
});
afterEach(async () => {
  for (const r of releaseAll.splice(0)) r();
  await Promise.allSettled(flights.splice(0));
  await app?.close();
  app = undefined;
});
afterAll(async () => {
  try {
    await removeSyntheticTenants(pool, companies);
  } finally {
    await pool.end();
  }
  if (priorOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = priorOrigin;
});

it('applies a complete 31-day month, canonical duties, exact bounded receipt and transactional audits', async () => {
  const dto = await draft();
  for (const day of dto.days) day.desired = { state: 'DAY', role: 'EMPLOYEE' };
  const r = await save(dto);
  expect(r.status).toBe(200);
  expect(r.body.outcome).toBe('APPLIED');
  expect(r.body.counts).toEqual({
    createdDuties: 30,
    changedDuties: 0,
    addedMemberships: 30,
    removedMemberships: 0,
    updatedMemberships: 0,
  });
  expect(r.body.changes).toHaveLength(30);
  expect(r.headers['cache-control']).toBe('no-store');
  expect(
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM duties WHERE company_id=$1',
        [f.tenant.companyId],
      )
    ).rows[0].n,
  ).toBe(31);
  expect(
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM audit_event WHERE company_id=$1',
        [f.tenant.companyId],
      )
    ).rows[0].n,
  ).toBe(60);
  expect(
    (await read()).body.days.every(
      (d: { currentState: string }) => d.currentState === 'DAY',
    ),
  ).toBe(true);
});
it('no-op changes no business timestamps, versions or audits and still completes an immutable receipt', async () => {
  const dto = await draft(),
    before = await planningState(pool, f.tenant.companyId),
    key = randomUUID();
  const r = await save(dto, key);
  expect(r.status).toBe(200);
  expect(r.body.outcome).toBe('NO_OP');
  expect(r.body.changes).toEqual([]);
  expect(await planningState(pool, f.tenant.companyId)).toEqual(before);
  expect((await lookup(key)).body).toEqual({
    state: 'COMPLETED',
    result: r.body,
  });
});
it('invalid final day rolls back all earlier dates, tentative duties and audits', async () => {
  const dto = await draft();
  paint(dto, '2027-01-01', 'DAY');
  paint(dto, '2027-01-31', 'DAY');
  await pool.query(
    "INSERT INTO employee_availability_days(company_id,employee_id,day,status) VALUES($1,$2,'2027-01-31','SICK')",
    [f.tenant.companyId, f.mira.employeeId],
  );
  const before = await planningState(pool, f.tenant.companyId),
    key = randomUUID(),
    r = await save(dto, key);
  expect(r.status).toBe(409);
  expect(r.body).toMatchObject({
    code: 'EMPLOYEE_MONTH_SAVE_CONFLICT',
    atomic: true,
    stage: 'VALIDATION',
    conflicts: [
      { date: '2027-01-31', shiftKind: 'DAY', reason: 'EMPLOYEE_UNAVAILABLE' },
    ],
  });
  expect(JSON.stringify(r.body)).not.toMatch(/SICK|LEAVE|employeeId/);
  expect(await planningState(pool, f.tenant.companyId)).toEqual(before);
  expect((await lookup(key)).body).toEqual({ state: 'NOT_COMPLETED' });
});
it('DAY to NIGHT validates the final overlay and preserves the old empty canonical duty and removed history', async () => {
  const dto = await draft();
  paint(dto, MUTATION_DAY, 'NIGHT');
  const r = await save(dto);
  expect(r.status).toBe(200);
  expect(r.body.counts).toEqual({
    createdDuties: 1,
    changedDuties: 1,
    addedMemberships: 1,
    removedMemberships: 1,
    updatedMemberships: 0,
  });
  expect(
    (
      await pool.query(
        'SELECT state,removed_at FROM plan_assignments WHERE id=$1',
        [f.membership],
      )
    ).rows[0],
  ).toMatchObject({ state: 'REMOVED', removed_at: expect.any(Date) });
  expect(
    (
      await pool.query(
        'SELECT removed_at,concurrency_version FROM duties WHERE id=$1',
        [f.dutyId],
      )
    ).rows[0],
  ).toEqual({ removed_at: null, concurrency_version: '2' });
});
it('reuses a legacy empty destination and preserves shared colleague identity, role, source and timestamps', async () => {
  const other = await insertMembership(
    pool,
    f.tenant.companyId,
    f.dutyId,
    f.jonas.employeeId,
  );
  await pool.query(
    "UPDATE plan_assignments SET duty_function='SCHICHTLEITER',source='REPLACEMENT' WHERE id=$1",
    [other],
  );
  const before = (
    await pool.query('SELECT * FROM plan_assignments WHERE id=$1', [other])
  ).rows[0];
  const night = await insertDuty(pool, {
    companyId: f.tenant.companyId,
    projectId: f.project.projectId,
    planId: f.planId,
    month: MUTATION_MONTH,
    dutyDate: MUTATION_DAY,
    kind: 'NACHT',
    startsAt: `${MUTATION_DAY}T17:00:00Z`,
    endsAt: '2027-01-21T05:00:00Z',
  });
  const dto = await draft();
  paint(dto, MUTATION_DAY, 'NIGHT');
  const r = await save(dto);
  expect(r.status).toBe(200);
  expect(r.body.counts.createdDuties).toBe(0);
  expect(
    r.body.changes.find((x: { shiftKind: string }) => x.shiftKind === 'NIGHT')
      .dutyId,
  ).toBe(night);
  expect(
    (await pool.query('SELECT * FROM plan_assignments WHERE id=$1', [other]))
      .rows[0],
  ).toEqual(before);
  expect(JSON.stringify((await read()).body)).not.toContain(f.jonas.employeeId);
});
it('reads INVALID_DUAL and permits explicit correction, with new identity on later rejoin', async () => {
  const night = await insertDuty(pool, {
    companyId: f.tenant.companyId,
    projectId: f.project.projectId,
    planId: f.planId,
    month: MUTATION_MONTH,
    dutyDate: MUTATION_DAY,
    kind: 'NACHT',
    startsAt: `${MUTATION_DAY}T17:00:00Z`,
    endsAt: '2027-01-21T05:00:00Z',
  });
  const old = await insertMembership(
    pool,
    f.tenant.companyId,
    night,
    f.mira.employeeId,
  );
  expect((await read()).body.days[19].currentState).toBe('INVALID_DUAL');
  const dto = await draft();
  paint(dto, MUTATION_DAY, 'DAY');
  expect((await save(dto)).status).toBe(200);
  const again = await draft();
  paint(again, MUTATION_DAY, 'NIGHT');
  const r = await save(again);
  expect(r.status).toBe(200);
  expect(
    r.body.changes.find((x: { shiftKind: string }) => x.shiftKind === 'NIGHT')
      .assignment.id,
  ).not.toBe(old);
});
it('retains assignment identity/source for role changes and increments the duty once', async () => {
  await pool.query(
    "UPDATE plan_assignments SET source='REPLACEMENT' WHERE id=$1",
    [f.membership],
  );
  const dto = await draft();
  paint(dto, MUTATION_DAY, 'DAY', 'SHIFT_LEAD');
  const r = await save(dto);
  expect(r.status).toBe(200);
  expect(r.body.changes[0]).toMatchObject({
    dutyId: f.dutyId,
    version: 2,
    assignment: {
      id: f.membership,
      dutyRole: 'SHIFT_LEAD',
      source: 'REPLACEMENT',
    },
  });
});
it('active same-actor edit lease refuses the whole batch before stale preconditions', async () => {
  const dto = await draft();
  paint(dto, MUTATION_DAY, 'OFF');
  paint(dto, '2027-01-01', 'DAY');
  dto.days[19].expected.day!.version = 999;
  const lease = await request(app!.getHttpServer())
    .post(`${dutyPath(f)}/edit-lease`)
    .set('Origin', ORIGIN)
    .set('Cookie', f.admin.cookie)
    .set('X-CSRF-Token', f.admin.csrf);
  expect(lease.status).toBe(200);
  const before = await planningState(pool, f.tenant.companyId),
    r = await save(dto);
  expect(r.status).toBe(409);
  expect(r.body.stage).toBe('LEASE');
  expect(r.body.conflicts[0].reason).toBe('ACTIVE_DUTY_EDIT');
  expect(await planningState(pool, f.tenant.companyId)).toEqual(before);
});
it('unchanged leased duties do not block other dates and expired leases do not block an affected duty', async () => {
  await request(app!.getHttpServer())
    .post(`${dutyPath(f)}/edit-lease`)
    .set('Origin', ORIGIN)
    .set('Cookie', f.admin.cookie)
    .set('X-CSRF-Token', f.admin.csrf)
    .expect(200);
  const dto = await draft();
  paint(dto, '2027-01-01', 'DAY');
  expect((await save(dto)).status).toBe(200);
  await pool.query(
    "UPDATE edit_leases SET acquired_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE duty_id=$1",
    [f.dutyId],
  );
  const again = await draft();
  paint(again, MUTATION_DAY, 'OFF');
  expect((await save(again)).status).toBe(200);
});
it('lost response replay and lookup return the original receipt after subsequent roster changes', async () => {
  const dto = await draft();
  paint(dto, '2027-01-01', 'DAY');
  const key = randomUUID(),
    first = await save(dto, key);
  expect(first.status).toBe(200);
  const again = await draft();
  paint(again, '2027-01-01', 'OFF');
  expect((await save(again)).status).toBe(200);
  const before = await planningState(pool, f.tenant.companyId),
    retry = await save(
      dto,
      key,
      f.admin,
      f.planId.toUpperCase(),
      f.mira.employeeId.toUpperCase(),
    );
  expect(retry.status).toBe(200);
  expect(retry.body).toEqual(first.body);
  expect(retry.headers['idempotency-replayed']).toBe('true');
  expect((await lookup(key)).body).toEqual({
    state: 'COMPLETED',
    result: first.body,
  });
  expect(await planningState(pool, f.tenant.companyId)).toEqual(before);
  paint(dto, '2027-01-02', 'DAY');
  expect((await save(dto, key)).body.code).toBe(
    'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
  );
});
it('result lookup is read-only, actor-bound, route-bound and reports unknown and failed without claiming', async () => {
  const key = randomUUID();
  expect((await lookup(key)).body).toEqual({ state: 'UNKNOWN' });
  expect(
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM idempotency_records WHERE company_id=$1',
        [f.tenant.companyId],
      )
    ).rows[0].n,
  ).toBe(0);
  expect((await save(await draft(), key)).status).toBe(200);
  expect((await lookup(key, f.admin2)).body).toEqual({ state: 'UNKNOWN' });
  expect(
    (await lookup(key, f.admin, f.planId, f.jonas.employeeId)).status,
  ).toBe(404);
});
it.each(['missing', 'closed'] as const)(
  'calendar %s refuses new work but allows genuine no-op/corrective reduction',
  async (scenario) => {
    if (scenario === 'missing')
      await pool.query(
        'DELETE FROM project_operating_calendars WHERE project_id=$1',
        [f.project.projectId],
      );
    else
      await pool.query(
        'UPDATE project_operating_calendars SET weekday_mask=1 WHERE project_id=$1',
        [f.project.projectId],
      );
    const dto = await draft();
    expect((await save(dto)).status).toBe(200);
    paint(dto, '2027-01-01', 'DAY');
    const before = await planningState(pool, f.tenant.companyId),
      r = await save(dto);
    expect(r.status).toBe(409);
    expect(r.body.conflicts[0].reason).toBe(
      scenario === 'missing'
        ? 'PROJECT_CALENDAR_MISSING'
        : 'PROJECT_CLOSED_WEEKDAY',
    );
    expect(await planningState(pool, f.tenant.companyId)).toEqual(before);
    const reduction = await draft();
    paint(reduction, MUTATION_DAY, 'OFF');
    expect((await save(reduction)).status).toBe(200);
  },
);
it('calendar, lifecycle, creation-context and any unchanged shared-slot drift are conservative conflicts', async () => {
  for (const field of ['calendar', 'lifecycle', 'creation', 'slot']) {
    const dto = await draft();
    paint(dto, '2027-01-01', 'DAY');
    if (field === 'calendar') dto.expectedCalendar!.version++;
    if (field === 'lifecycle')
      dto.expectedPlan = {
        status: 'PUBLISHED',
        publishedAt: '2026-01-01T00:00:00Z',
      };
    if (field === 'creation') dto.expectedCreationContext = '0'.repeat(64);
    if (field === 'slot') dto.days[19].expected.day!.version++;
    const before = await planningState(pool, f.tenant.companyId),
      r = await save(dto);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({
      code: 'PLAN_CONCURRENT_MODIFICATION',
      atomic: true,
      stage: 'PRECONDITION',
    });
    expect(await planningState(pool, f.tenant.companyId)).toEqual(before);
  }
});
it('preserved colleague validation is neutral and rolls back target-only change', async () => {
  await insertMembership(
    pool,
    f.tenant.companyId,
    f.dutyId,
    f.jonas.employeeId,
  );
  await pool.query("UPDATE employees SET status='DEACTIVATED' WHERE id=$1", [
    f.jonas.employeeId,
  ]);
  const dto = await draft();
  paint(dto, MUTATION_DAY, 'OFF');
  const before = await planningState(pool, f.tenant.companyId),
    r = await save(dto);
  expect(r.status).toBe(409);
  expect(r.body.conflicts[0].reason).toBe('PRESERVED_ROSTER_CONFLICT');
  expect(JSON.stringify(r.body)).not.toContain(f.jonas.employeeId);
  expect(await planningState(pool, f.tenant.companyId)).toEqual(before);
});
it('CR-03 published changes apply immediately and preserve publication metadata', async () => {
  await request(app!.getHttpServer())
    .post(`/api/v1/monthly-plans/${f.planId}/publish`)
    .set('Origin', ORIGIN)
    .set('Cookie', f.admin.cookie)
    .set('X-CSRF-Token', f.admin.csrf)
    .set('Idempotency-Key', randomUUID())
    .expect(200);
  const before = (
    await pool.query(
      'SELECT status,published_at,published_by_account_id FROM monthly_plans WHERE id=$1',
      [f.planId],
    )
  ).rows[0];
  const dto = await draft();
  paint(dto, '2027-01-01', 'DAY');
  const r = await save(dto);
  expect(r.status).toBe(200);
  expect(r.body.plan.status).toBe('PUBLISHED');
  expect(
    (
      await pool.query(
        'SELECT status,published_at,published_by_account_id FROM monthly_plans WHERE id=$1',
        [f.planId],
      )
    ).rows[0],
  ).toEqual(before);
});
class NthAudit extends BusinessAuditService {
  n = 0;
  override async recordBusinessAction(c: PoolClient, e: BusinessAuditEntry) {
    if (++this.n === 4) throw new Error('synthetic fourth audit failure');
    await super.recordBusinessAction(c, e);
  }
}
class FaultDatabase extends DatabaseService {
  mode: 'receipt' | 'lost' = 'receipt';
  override async withTransaction<T>(
    work: (c: PoolClient) => Promise<T>,
  ): Promise<T> {
    let completed = false;
    const result = await super.withTransaction(async (c) => {
      const original = c.query.bind(c);
      c.query = ((...args: unknown[]) => {
        if (
          typeof args[0] === 'string' &&
          args[0].includes("SET state='COMPLETED'")
        ) {
          completed = true;
          if (this.mode === 'receipt')
            throw new Error('synthetic receipt failure');
        }
        return (original as (...a: unknown[]) => unknown)(...args);
      }) as typeof c.query;
      try {
        return await work(c);
      } finally {
        c.query = original;
      }
    });
    if (completed && this.mode === 'lost')
      throw new Error('synthetic lost COMMIT acknowledgement');
    return result;
  }
}
it.each(['audit', 'receipt'] as const)(
  '%s failure rolls back every duty/member/audit and receipt completion',
  async (mode) => {
    const database = mode === 'receipt' ? new FaultDatabase() : undefined;
    await boot(mode === 'audit' ? { audit: new NthAudit() } : { database });
    const dto = await draft();
    paint(dto, '2027-01-01', 'DAY');
    paint(dto, '2027-01-02', 'DAY');
    const before = await planningState(pool, f.tenant.companyId),
      key = randomUUID(),
      r = await save(dto, key);
    expect(r.status).toBe(500);
    expect(await planningState(pool, f.tenant.companyId)).toEqual(before);
    expect((await lookup(key)).body).toEqual({ state: 'NOT_COMPLETED' });
  },
);
it('ambiguous COMMIT marker cannot overwrite completed evidence and replay never reapplies', async () => {
  const db = new FaultDatabase();
  db.mode = 'lost';
  await boot({ database: db });
  const dto = await draft();
  paint(dto, '2027-01-01', 'DAY');
  const key = randomUUID(),
    r = await save(dto, key);
  expect(r.status).toBe(500);
  const result = await lookup(key);
  expect(result.body.state).toBe('COMPLETED');
  const before = await planningState(pool, f.tenant.companyId),
    retry = await save(dto, key);
  expect(retry.status).toBe(200);
  expect(retry.body).toEqual(result.body.result);
  expect(await planningState(pool, f.tenant.companyId)).toEqual(before);
});
it.each(['tenant', 'role', 'revoked', 'archived'] as const)(
  '%s cannot read, save or retrieve a retained receipt; all responses no-store',
  async (kind) => {
    const dto = await draft(),
      key = randomUUID();
    expect((await save(dto, key)).status).toBe(200);
    let session = f.admin;
    if (kind === 'tenant') session = f.foreignAdmin;
    if (kind === 'role') session = f.employeeSession;
    if (kind === 'revoked')
      await pool.query(
        'UPDATE sessions SET revoked_at=clock_timestamp() WHERE account_id=$1',
        [f.tenant.admin.accountId],
      );
    if (kind === 'archived')
      await pool.query("UPDATE projects SET status='ARCHIVED' WHERE id=$1", [
        f.project.projectId,
      ]);
    const status =
      kind === 'tenant' || kind === 'archived'
        ? 404
        : kind === 'role'
          ? 403
          : 401;
    for (const r of [
      await read(session),
      await save(dto, key, session),
      await lookup(key, session),
    ]) {
      expect(r.status).toBe(status);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.body.conflicts).toBeUndefined();
    }
  },
);
it.each([
  (d: SaveEmployeeMonth) => ({ ...d, companyId: randomUUID() }),
  (d: SaveEmployeeMonth) => ({ ...d, days: d.days.slice(1) }),
  (d: SaveEmployeeMonth) => ({ ...d, days: [...d.days.slice(1), d.days[1]] }),
  (d: SaveEmployeeMonth) => ({
    ...d,
    days: d.days.map((x, i) =>
      i === 0 ? { ...x, desired: { state: 'OFF', role: 'EMPLOYEE' } } : x,
    ),
  }),
  (d: SaveEmployeeMonth) => ({
    ...d,
    days: d.days.map((x, i) =>
      i === 0
        ? {
            ...x,
            expected: { day: { id: randomUUID(), version: '1' }, night: null },
          }
        : x,
    ),
  }),
])(
  'strict full-state syntax rejects malformed request %# without business changes',
  async (change) => {
    const dto = await draft(),
      before = await planningState(pool, f.tenant.companyId),
      r = await save(change(dto));
    expect(r.status).toBe(400);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(await planningState(pool, f.tenant.companyId)).toEqual(before);
  },
);

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
class ObservedDatabase extends DatabaseService {
  hook?: (
    c: PoolClient,
    sql: string,
    params: unknown[] | undefined,
  ) => Promise<void>;
  statements: string[] = [];
  override withTransaction<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    return super.withTransaction((c) =>
      work(
        new Proxy(c, {
          get: (target, key) => {
            if (key === 'query')
              return async (sql: string, params?: unknown[]) => {
                const r = await target.query(sql, params);
                this.statements.push(sql);
                await this.hook?.(target, sql, params);
                return r;
              };
            const value: unknown = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
      ),
    );
  }
}
class HeldAudit extends BusinessAuditService {
  hook?: (c: PoolClient, e: BusinessAuditEntry) => Promise<void>;
  override async recordBusinessAction(c: PoolClient, e: BusinessAuditEntry) {
    await super.recordBusinessAction(c, e);
    await this.hook?.(c, e);
  }
}
async function blocking(pid: number) {
  const until = Date.now() + 3500;
  while (Date.now() < until) {
    if (
      (
        await pool.query(
          'SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))',
          [pid],
        )
      ).rowCount
    )
      return;
  }
  throw new Error('Expected PostgreSQL blocking was not observed');
}
function start(p: PromiseLike<Response>): Promise<Response> {
  const f = Promise.resolve(p);
  flights.push(f);
  return f;
}
function send(
  method: 'post' | 'patch' | 'delete' | 'put',
  url: string,
  body?: object,
  headers: Record<string, string> = {},
) {
  const r = request(app!.getHttpServer())
    [method](url)
    .set('Origin', ORIGIN)
    .set('Cookie', f.admin2.cookie)
    .set('X-CSRF-Token', f.admin2.csrf)
    .set(headers);
  return body === undefined ? r : r.send(body);
}
const cases = [
  {
    name: 'another A2 save',
    action: 'DUTY_CREATED',
    expected: [409, 'PLAN_CONCURRENT_MODIFICATION'],
    other: async (dto: SaveEmployeeMonth) => () =>
      save(dto, randomUUID(), f.admin2),
    a2FirstStatus: 409,
  },
  {
    name: 'absent-duty creator',
    action: 'DUTY_CREATED',
    expected: [409, 'PLAN_CONCURRENT_MODIFICATION'],
    other: async () => () =>
      send('post', `/api/v1/monthly-plans/${f.planId}/entries`, {
        dutyDate: '2027-01-01',
        shiftKind: 'DAY',
        assignments: [{ employeeId: f.mira.employeeId, dutyRole: 'EMPLOYEE' }],
      }),
    a2FirstStatus: 409,
    otherStatus: 201,
  },
  {
    name: 'shared membership PATCH',
    action: 'DUTY_UPDATED',
    expected: [409, 'PLAN_CONCURRENT_MODIFICATION'],
    other: async () => {
      const lease = await send('post', `${dutyPath(f)}/edit-lease`);
      expect(lease.status).toBe(200);
      return () =>
        send(
          'patch',
          dutyPath(f),
          {
            assignments: [
              { employeeId: f.mira.employeeId, dutyRole: 'EMPLOYEE' },
              { employeeId: f.jonas.employeeId, dutyRole: 'SHIFT_LEAD' },
            ],
          },
          {
            'Expected-Version': '1',
            'Edit-Lease-Token': lease.body.leaseToken,
          },
        );
    },
    a2FirstStatus: 200,
  },
  {
    name: 'SP-12 DELETE',
    action: 'DUTY_REMOVED',
    expected: [409, 'PLAN_CONCURRENT_MODIFICATION'],
    other: async () => {
      const lease = await send('post', `${dutyPath(f)}/edit-lease`);
      expect(lease.status).toBe(200);
      return () =>
        send('delete', dutyPath(f), undefined, {
          'Expected-Version': '1',
          'Edit-Lease-Token': lease.body.leaseToken,
        });
    },
    a2FirstStatus: 204,
    otherStatus: 204,
  },
  {
    name: 'First Publish',
    action: 'MONTHLY_PLAN_PUBLISHED',
    expected: [409, 'PLAN_CONCURRENT_MODIFICATION'],
    other: async () => () =>
      send('post', `/api/v1/monthly-plans/${f.planId}/publish`, undefined, {
        'Idempotency-Key': randomUUID(),
      }),
    a2FirstStatus: 409,
  },
  {
    name: 'employee eligibility',
    action: 'EMPLOYEE_UPDATED',
    expected: [409, 'EMPLOYEE_MONTH_SAVE_CONFLICT'],
    other: async () => () =>
      send('patch', `/api/v1/employees/${f.mira.employeeId}`, {
        shiftEligibility: 'NIGHT',
      }),
    a2FirstStatus: 200,
  },
  {
    name: 'project status',
    action: 'PROJECT_UPDATED',
    expected: [409, 'EMPLOYEE_MONTH_SAVE_CONFLICT'],
    other: async () => () =>
      send('patch', `/api/v1/projects/${f.project.projectId}`, {
        status: 'INACTIVE',
      }),
    a2FirstStatus: 200,
    clock: '2030-01-01T00:00:00Z',
  },
  {
    name: 'employment bounds',
    action: 'EMPLOYEE_UPDATED',
    expected: [409, 'EMPLOYEE_MONTH_SAVE_CONFLICT'],
    other: async () => () =>
      send('patch', `/api/v1/employees/${f.mira.employeeId}`, {
        employmentEnd: '2026-12-31',
      }),
    a2FirstStatus: 200,
    clock: '2030-01-01T00:00:00Z',
  },
  {
    name: 'effective operating calendar',
    action: 'PROJECT_OPERATING_CALENDAR_UPDATED',
    expected: [409, 'PLAN_CONCURRENT_MODIFICATION'],
    other: async () => {
      const p = `/api/v1/projects/${f.project.projectId}/operating-calendar`;
      const r = await request(app!.getHttpServer())
        .get(`${p}?effectiveForMonth=${MUTATION_MONTH}`)
        .set('Cookie', f.admin2.cookie);
      expect(r.status).toBe(200);
      return () =>
        send('patch', p, {
          bootstrap: false,
          effectiveFromMonth: MUTATION_MONTH,
          operatingWeekdays: [1, 2, 3, 4, 5],
          expectedExactVersion: r.body.exactVersion,
          expectedEffective: r.body.effective
            ? { id: r.body.effective.id, version: r.body.effective.version }
            : null,
          expectedNextEffectiveFromMonth: r.body.nextEffectiveFromMonth,
        });
    },
    a2FirstStatus: 200,
  },
];
for (const scenario of cases)
  for (const a2First of [true, false])
    for (const rollback of [false, true]) {
      it(`${scenario.name}: ${a2First ? 'A2' : 'other'} first ${rollback ? 'ROLLBACK' : 'COMMIT'}, measured blocking`, async () => {
        const audit = new HeldAudit();
        await boot({
          audit,
          clock: () => new Date(scenario.clock ?? MUTATION_NOW),
        });
        const dto = await draft();
        paint(dto, '2027-01-01', 'DAY');
        const other = await scenario.other(dto);
        const reached = latch(),
          resume = latch();
        releaseAll.push(resume.release);
        let pid = 0;
        audit.hook = async (c, e) => {
          if (e.action !== (a2First ? 'DUTY_CREATED' : scenario.action)) return;
          audit.hook = undefined;
          pid = (
            await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          reached.release();
          await resume.promise;
          if (rollback) await c.query('SELECT 1/0');
        };
        const first = start(a2First ? save(dto) : other());
        await Promise.race([
          reached.promise,
          first.then((r) => {
            throw new Error(
              `First writer missed barrier: ${r.status}/${String(r.body.code)}`,
            );
          }),
        ]);
        const second = start(a2First ? other() : save(dto));
        await blocking(pid);
        resume.release();
        const [one, two] = await Promise.all([first, second]);
        expect([one.status, one.body.code ?? null]).toEqual(
          rollback
            ? [500, 'INTERNAL_ERROR']
            : [a2First ? 200 : (scenario.otherStatus ?? 200), null],
        );
        const expected = a2First
          ? [
              rollback ? (scenario.otherStatus ?? 200) : scenario.a2FirstStatus,
              null,
            ]
          : rollback
            ? [200, null]
            : scenario.expected;
        expect(two.status).toBe(expected[0]);
        if (!a2First) expect(two.body.code ?? null).toBe(expected[1]);
        if (a2First && !rollback && two.status === 409)
          expect(two.body.code).toBe(
            scenario.name === 'another A2 save' ||
              scenario.name === 'First Publish'
              ? 'PLAN_CONCURRENT_MODIFICATION'
              : 'DUTY_ALREADY_EXISTS',
          );
        if (rollback)
          expect(
            (
              await pool.query(
                'SELECT count(*)::int AS n FROM audit_event WHERE correlation_id=$1',
                [one.headers['x-correlation-id']],
              )
            ).rows[0].n,
          ).toBe(0);
      });
    }

it('multi-D/multi-A2/multi-Q command acquires all D before A2 before Q, with no late parent tier', async () => {
  const night = await insertDuty(pool, {
    companyId: f.tenant.companyId,
    projectId: f.project.projectId,
    planId: f.planId,
    month: MUTATION_MONTH,
    dutyDate: MUTATION_DAY,
    kind: 'NACHT',
    startsAt: `${MUTATION_DAY}T17:00:00Z`,
    endsAt: '2027-01-21T05:00:00Z',
  });
  await insertMembership(pool, f.tenant.companyId, night, f.jonas.employeeId);
  for (const id of [f.dutyId, night]) {
    await send('post', `${dutyPath(f, id)}/edit-lease`).expect(200);
    await pool.query(
      "UPDATE edit_leases SET acquired_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE duty_id=$1",
      [id],
    );
  }
  const database = new ObservedDatabase();
  await boot({ database });
  const dto = await draft();
  paint(dto, MUTATION_DAY, 'OFF');
  paint(dto, '2027-01-01', 'DAY');
  database.statements = [];
  const r = await save(dto);
  expect(r.status).toBe(200);
  const sql = database.statements,
    firstD = sql.findIndex(
      (s) => s.includes('FROM public.duties') && s.includes('FOR UPDATE'),
    );
  const a2 = sql.findIndex(
    (s) =>
      s.includes('FROM public.plan_assignments pa') && s.includes('FOR UPDATE'),
  );
  const q = sql.findIndex(
    (s) => s.includes('FROM public.edit_leases') && s.includes('FOR UPDATE'),
  );
  expect(firstD).toBeGreaterThan(-1);
  expect(a2).toBeGreaterThan(firstD);
  expect(q).toBeGreaterThan(a2);
  expect(
    sql
      .slice(a2)
      .filter(
        (s) => s.includes('FOR UPDATE') && s.includes('FROM public.duties'),
      ),
  ).toEqual([]);
  expect(
    sql
      .slice(q + 1)
      .filter((s) => /FOR (?:SHARE|NO KEY UPDATE|KEY SHARE|UPDATE)/.test(s)),
  ).toEqual([]);
});
it.each(['idle', 'absolute'] as const)(
  'fresh %s expiry after Q wait refuses even no-op and rolls back tentative D',
  async (kind) => {
    const database = new ObservedDatabase();
    await boot({ database });
    const dto = await draft();
    paint(dto, '2027-01-01', 'DAY');
    database.hook = async (c, sql) => {
      if (
        !sql.includes('FROM public.edit_leases') ||
        !sql.includes('FOR UPDATE')
      )
        return;
      database.hook = undefined;
      // Deterministic expiry inside the test transaction after admission waits, no sleep.
      await c.query(
        kind === 'idle'
          ? "UPDATE sessions SET created_at=clock_timestamp()-interval '2 hours',last_seen_at=clock_timestamp()-interval '31 minutes' WHERE account_id=$1"
          : "UPDATE sessions SET created_at=clock_timestamp()-interval '2 hours',absolute_expires_at=clock_timestamp()-interval '1 second' WHERE account_id=$1",
        [f.tenant.admin.accountId],
      );
    };
    const before = await planningState(pool, f.tenant.companyId),
      r = await save(dto);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('SESSION_EXPIRED');
    expect(await planningState(pool, f.tenant.companyId)).toEqual(before);
  },
);
it('stale age cannot steal a running claim; explicit lookup and same-key command use nonwaiting I', async () => {
  const audit = new HeldAudit(),
    database = new ObservedDatabase();
  await boot({ audit, database });
  const dto = await draft();
  paint(dto, '2027-01-01', 'DAY');
  const key = randomUUID();
  const trusted = await app!
    .get(SessionService)
    .validateAndTouch(f.admin.rawToken);
  database.hook = async (c, sql) => {
    if (!sql.includes('INSERT INTO public.idempotency_records')) return;
    database.hook = undefined;
    await c.query(
      "UPDATE idempotency_records SET claimed_at=clock_timestamp()-interval '301 seconds' WHERE company_id=$1",
      [f.tenant.companyId],
    );
  };
  const reached = latch(),
    resume = latch();
  releaseAll.push(resume.release);
  audit.hook = async (_c, e) => {
    if (e.action !== 'DUTY_CREATED') return;
    audit.hook = undefined;
    reached.release();
    await resume.promise;
  };
  const first = start(save(dto, key));
  await reached.promise;
  const service = app!.get(EmployeeMonthService);
  await expect(
    service.save(trusted, f.planId, f.mira.employeeId, key, dto, randomUUID()),
  ).rejects.toMatchObject({
    status: 409,
    response: { code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS' },
  });
  await expect(
    service.lookup(trusted, f.planId, f.mira.employeeId, key),
  ).rejects.toMatchObject({
    status: 409,
    response: { code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS' },
  });
  resume.release();
  expect((await first).status).toBe(200);
});

it.each([
  ['2027-02-01', 28],
  ['2028-02-01', 29],
  ['2027-04-01', 30],
  ['2027-03-01', 31],
] as const)(
  'consistent read and complete save for %s (%i days)',
  async (month, n) => {
    const plan = await insertPlan(
      pool,
      f.tenant.companyId,
      f.project.projectId,
      month,
    );
    await insertProjectAssignment(
      pool,
      f.tenant.companyId,
      f.mira.employeeId,
      f.project.projectId,
      month,
    );
    const dto = await draft(plan);
    expect(dto.days).toHaveLength(n);
    paint(dto, dto.days.at(-1)!.date, 'NIGHT');
    const r = await save(dto, randomUUID(), f.admin, plan);
    expect(r.status).toBe(200);
    expect(r.body.counts.createdDuties).toBe(1);
  },
);
it('saved UTC intervals use D6 across DST and a closed next-day does not forbid overnight NIGHT', async () => {
  const month = '2027-03-01',
    plan = await insertPlan(
      pool,
      f.tenant.companyId,
      f.project.projectId,
      month,
    );
  await insertProjectAssignment(
    pool,
    f.tenant.companyId,
    f.mira.employeeId,
    f.project.projectId,
    month,
  );
  const dto = await draft(plan);
  paint(dto, '2027-03-27', 'DAY');
  paint(dto, '2027-03-28', 'DAY');
  const r = await save(dto, randomUUID(), f.admin, plan);
  expect(r.status).toBe(200);
  expect(r.body.changes.map((d: { startsAt: string }) => d.startsAt)).toEqual([
    '2027-03-27T05:00:00Z',
    '2027-03-28T04:00:00Z',
  ]);
  await pool.query(
    'UPDATE project_operating_calendars SET weekday_mask=16 WHERE project_id=$1',
    [f.project.projectId],
  );
  const next = await draft();
  paint(next, '2027-01-01', 'NIGHT');
  const night = await save(next);
  expect(night.status).toBe(200);
  expect(night.body.changes[0].endsAt).toBe('2027-01-02T05:00:00Z');
});
it('range-boundary invalid overnight and adjacent-month UTC overlap roll back the entire command', async () => {
  const boundary = await insertPlan(
    pool,
    f.tenant.companyId,
    f.project.projectId,
    '9999-12-01',
  );
  await insertProjectAssignment(
    pool,
    f.tenant.companyId,
    f.mira.employeeId,
    f.project.projectId,
    '9999-12-01',
  );
  const dto = await draft(boundary);
  paint(dto, '9999-12-01', 'DAY');
  paint(dto, '9999-12-31', 'NIGHT');
  const before = await planningState(pool, f.tenant.companyId),
    r = await save(dto, randomUUID(), f.admin, boundary);
  expect(r.status).toBe(409);
  expect(r.body.conflicts[0].reason).toBe('DUTY_TIME_RANGE_INVALID');
  expect(await planningState(pool, f.tenant.companyId)).toEqual(before);
  const feb = await insertPlan(
    pool,
    f.tenant.companyId,
    f.project.projectId,
    '2027-02-01',
  );
  const id = await insertDuty(pool, {
    companyId: f.tenant.companyId,
    projectId: f.project.projectId,
    planId: feb,
    month: '2027-02-01',
    dutyDate: '2027-02-01',
    startsAt: '2027-02-01T04:00:00Z',
    endsAt: '2027-02-01T17:00:00Z',
  });
  await insertMembership(pool, f.tenant.companyId, id, f.mira.employeeId);
  const jan = await draft();
  paint(jan, '2027-01-01', 'DAY');
  paint(jan, '2027-01-31', 'NIGHT');
  const baseline = await planningState(pool, f.tenant.companyId),
    overlap = await save(jan);
  expect(overlap.status).toBe(409);
  expect(overlap.body.conflicts[0].reason).toBe('DUTY_ASSIGNMENT_CONFLICT');
  expect(await planningState(pool, f.tenant.companyId)).toEqual(baseline);
});
it('expired evidence is UNKNOWN; a repeated effective request is stale, while reviewed no-op can create a new command identity', async () => {
  const dto = await draft();
  paint(dto, '2027-01-01', 'DAY');
  const key = randomUUID(),
    first = await save(dto, key);
  expect(first.status).toBe(200);
  await pool.query(
    "UPDATE idempotency_records SET created_at=clock_timestamp()-interval '2 days',claimed_at=clock_timestamp()-interval '2 days',completed_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE company_id=$1",
    [f.tenant.companyId],
  );
  expect((await lookup(key)).body).toEqual({ state: 'UNKNOWN' });
  expect((await save(dto, key)).body.code).toBe('PLAN_CONCURRENT_MODIFICATION');
  const current = await draft(),
    newKey = randomUUID(),
    noop = await save(current, newKey);
  expect(noop.status).toBe(200);
  await pool.query(
    "UPDATE idempotency_records SET created_at=clock_timestamp()-interval '2 days',claimed_at=clock_timestamp()-interval '2 days',completed_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE company_id=$1 AND state='COMPLETED'",
    [f.tenant.companyId],
  );
  const again = await save(current, newKey);
  expect(again.status).toBe(200);
  expect(again.body.outcome).toBe('NO_OP');
  expect(again.body.commandId).not.toBe(noop.body.commandId);
});

for (const reverse of [false, true])
  for (const rollback of [false, true]) {
    it(`different employees and absent DAY/NIGHT: ${reverse ? 'NIGHT' : 'DAY'} first ${rollback ? 'ROLLBACK' : 'COMMIT'}`, async () => {
      const audit = new HeldAudit();
      await boot({ audit });
      const day = await draft(),
        night = await draft(f.planId, f.jonas.employeeId);
      paint(day, '2027-01-01', 'DAY');
      paint(night, '2027-01-01', 'NIGHT');
      const reached = latch(),
        resume = latch();
      releaseAll.push(resume.release);
      let pid = 0;
      audit.hook = async (c, e) => {
        if (e.action !== 'DUTY_CREATED') return;
        audit.hook = undefined;
        pid = (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0].pid;
        reached.release();
        await resume.promise;
        if (rollback) await c.query('SELECT 1/0');
      };
      const first = start(
        reverse
          ? save(night, randomUUID(), f.admin2, f.planId, f.jonas.employeeId)
          : save(day),
      );
      await reached.promise;
      const second = start(
        reverse
          ? save(day)
          : save(night, randomUUID(), f.admin2, f.planId, f.jonas.employeeId),
      );
      await blocking(pid);
      resume.release();
      const [a, b] = await Promise.all([first, second]);
      expect(a.status).toBe(rollback ? 500 : 200);
      expect(b.status).toBe(rollback ? 200 : 409);
      if (!rollback) expect(b.body.code).toBe('PLAN_CONCURRENT_MODIFICATION');
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM duties WHERE company_id=$1 AND duty_date='2027-01-01'",
            [f.tenant.companyId],
          )
        ).rows[0].n,
      ).toBe(1);
    });
  }
for (const leaseFirst of [false, true])
  for (const rollback of [false, true]) {
    it(`lease admission race: ${leaseFirst ? 'lease' : 'A2'} first ${rollback ? 'ROLLBACK' : 'COMMIT'}`, async () => {
      const audit = new HeldAudit(),
        database = new ObservedDatabase();
      await boot({ audit, database });
      const dto = await draft();
      paint(dto, MUTATION_DAY, 'DAY', 'SHIFT_LEAD');
      paint(dto, '2027-01-01', 'DAY');
      const reached = latch(),
        resume = latch();
      releaseAll.push(resume.release);
      let pid = 0;
      const hold = async (c: PoolClient) => {
        pid = (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0].pid;
        reached.release();
        await resume.promise;
        if (rollback) await c.query('SELECT 1/0');
      };
      if (leaseFirst)
        database.hook = async (c, sql) => {
          if (!sql.includes('INSERT INTO public.edit_leases')) return;
          database.hook = undefined;
          await hold(c);
        };
      else
        audit.hook = async (c, e) => {
          if (e.action !== 'DUTY_CREATED' && e.action !== 'DUTY_UPDATED')
            return;
          audit.hook = undefined;
          await hold(c);
        };
      const lease = () => send('post', `${dutyPath(f)}/edit-lease`);
      const one = start(leaseFirst ? lease() : save(dto));
      await reached.promise;
      const two = start(leaseFirst ? save(dto) : lease());
      await blocking(pid);
      resume.release();
      const [a, b] = await Promise.all([one, two]);
      expect(a.status).toBe(rollback ? 500 : 200);
      expect(b.status).toBe(leaseFirst && !rollback ? 409 : 200);
      if (leaseFirst && !rollback)
        expect(b.body).toMatchObject({
          stage: 'LEASE',
          conflicts: [
            {
              date: MUTATION_DAY,
              shiftKind: 'DAY',
              reason: 'ACTIVE_DUTY_EDIT',
            },
          ],
        });
    });
  }
for (const a2First of [false, true])
  for (const rollback of [false, true]) {
    it(`session revocation: ${a2First ? 'A2' : 'logout'} first ${rollback ? 'ROLLBACK' : 'COMMIT'} with guard-issued context`, async () => {
      const audit = new HeldAudit(),
        database = new ObservedDatabase();
      await boot({ audit, database });
      const dto = await draft();
      paint(dto, '2027-01-01', 'DAY');
      const sessions = app!.get(SessionService),
        months = app!.get(EmployeeMonthService),
        trusted = await sessions.validateAndTouch(f.admin.rawToken);
      const reached = latch(),
        resume = latch();
      releaseAll.push(resume.release);
      let pid = 0;
      const hold = async (c: PoolClient) => {
        pid = (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0].pid;
        reached.release();
        await resume.promise;
        if (rollback) await c.query('SELECT 1/0');
      };
      if (a2First)
        audit.hook = async (c, e) => {
          if (e.action !== 'DUTY_CREATED') return;
          audit.hook = undefined;
          await hold(c);
        };
      else
        database.hook = async (c, sql) => {
          if (
            !sql.includes('SELECT id FROM accounts') ||
            !sql.includes('FOR UPDATE')
          )
            return;
          database.hook = undefined;
          await hold(c);
        };
      const command = () =>
        months.save(
          trusted,
          f.planId,
          f.mira.employeeId,
          randomUUID(),
          dto,
          randomUUID(),
        );
      const revoke = () => sessions.revoke(f.admin.rawToken);
      const first = (a2First ? command() : revoke()).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      flights.push(first);
      await reached.promise;
      const second = (a2First ? revoke() : command()).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      flights.push(second);
      await blocking(pid);
      resume.release();
      const [one, two] = await Promise.all([first, second]);
      expect('error' in one).toBe(rollback);
      if (!a2First && !rollback)
        expect(two).toMatchObject({
          error: { status: 401, response: { code: 'SESSION_REVOKED' } },
        });
      else expect('value' in two).toBe(true);
    });
  }

it('abandoned durable claim takeover fences a paused old claimant before any business writes', async () => {
  const database = new ObservedDatabase();
  await boot({ database });
  const dto = await draft();
  paint(dto, '2027-01-01', 'DAY');
  const key = randomUUID();
  const trusted = await app!
      .get(SessionService)
      .validateAndTouch(f.admin.rawToken),
    reached = latch(),
    resume = latch();
  releaseAll.push(resume.release);
  let claimed = false;
  database.hook = async (_c, sql) => {
    if (sql.includes('INSERT INTO public.idempotency_records')) claimed = true;
    else if (claimed && sql.includes('SET LOCAL lock_timeout')) {
      database.hook = undefined;
      reached.release();
      await resume.promise;
    }
  };
  const first = start(save(dto, key));
  await reached.promise;
  const old = (
    await pool.query(
      'SELECT attempt_id FROM idempotency_records WHERE company_id=$1',
      [f.tenant.companyId],
    )
  ).rows[0].attempt_id;
  await pool.query(
    "UPDATE idempotency_records SET claimed_at=clock_timestamp()-interval '301 seconds' WHERE company_id=$1",
    [f.tenant.companyId],
  );
  const recovered = await app!
    .get(EmployeeMonthService)
    .save(trusted, f.planId, f.mira.employeeId, key, dto, randomUUID());
  expect(recovered.result.outcome).toBe('APPLIED');
  expect(
    (
      await pool.query(
        'SELECT attempt_id FROM idempotency_records WHERE company_id=$1',
        [f.tenant.companyId],
      )
    ).rows[0].attempt_id,
  ).not.toBe(old);
  const before = await planningState(pool, f.tenant.companyId);
  resume.release();
  expect((await first).body.code).toBe('IDEMPOTENCY_REQUEST_IN_PROGRESS');
  expect(await planningState(pool, f.tenant.companyId)).toEqual(before);
  expect((await lookup(key)).body.result).toEqual(recovered.result);
});
it('bounded explicit cleanup removes only this principal’s expired A2 evidence and never INITIAL_PUBLISH or retained receipts', async () => {
  const dto = await draft();
  for (let i = 0; i < 3; i++) expect((await save(dto)).status).toBe(200);
  expect((await save(dto, randomUUID(), f.admin2)).status).toBe(200);
  await pool.query(
    "UPDATE idempotency_records SET created_at=clock_timestamp()-interval '2 days',claimed_at=clock_timestamp()-interval '2 days',completed_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE company_id=$1 AND actor_account_id=$2",
    [f.tenant.companyId, f.tenant.admin.accountId],
  );
  const key = randomUUID();
  expect((await save(dto, key)).status).toBe(200);
  await send('post', `/api/v1/monthly-plans/${f.planId}/publish`, undefined, {
    'Idempotency-Key': randomUUID(),
  }).expect(200);
  const trusted = await app!
      .get(SessionService)
      .validateAndTouch(f.admin.rawToken),
    receipts = app!.get(EmployeeMonthIdempotencyService);
  const before = await planningState(pool, f.tenant.companyId);
  expect(await receipts.pruneExpired(trusted, 1)).toBe(1);
  expect(await receipts.pruneExpired(trusted)).toBe(2);
  expect(await receipts.pruneExpired(trusted)).toBe(0);
  expect((await lookup(key)).body.state).toBe('COMPLETED');
  expect(
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM idempotency_records WHERE company_id=$1',
        [f.tenant.companyId],
      )
    ).rows[0].n,
  ).toBe(3);
  expect(await planningState(pool, f.tenant.companyId)).toEqual(before);
  await expect(receipts.pruneExpired(trusted, 1001)).rejects.toMatchObject({
    status: 400,
  });
});
