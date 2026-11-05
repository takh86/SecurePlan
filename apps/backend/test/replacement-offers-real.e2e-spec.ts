/** Real HTTP/PG17, trusted principal facts and deterministic two-client lock schedules. */
import { createHash, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DatabaseService } from '../src/database/database.service.js';
import { ReplacementOffersService } from '../src/modules/cancellation-replacement/replacement-offers.service.js';
import type { TenantContext } from '../src/auth/authorization/tenant-context.js';
import {
  bootEmployeesApp,
  RecordingDelivery,
  FailingAudit,
  ORIGIN,
} from './helpers/employees-test-app.js';
import {
  dutyMutationFixture,
  dutyPath,
  MUTATION_NOW,
  type DutyMutationFixture,
} from './helpers/duty-mutation-fixtures.js';
import {
  openLocalTestPool,
  removeSyntheticTenants,
  createSyntheticSession,
  createSyntheticProject,
  realSessionService,
  backendPid,
  waitUntilBlockedBy,
  type TestPool,
  type SyntheticSession,
} from './helpers/synthetic-tenants.js';
import {
  createStaff,
  insertPlan,
  insertDuty,
  insertMembership,
  insertProjectAssignment,
  planningState,
} from './helpers/planning-fixtures.js';
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}
class ObservedDatabase extends DatabaseService {
  hook?: {
    match: string;
    phase: 'before' | 'after';
    work: (c: PoolClient) => Promise<void>;
  };
  fail?: 'insert' | 'completion' | 'lostAck';
  pids: number[] = [];
  override async withTransaction<T>(
    work: (c: PoolClient) => Promise<T>,
  ): Promise<T> {
    let completed = false;
    const result = await super.withTransaction((c) =>
      work(
        new Proxy(c, {
          get: (target, key) => {
            if (key === 'query')
              return async (sql: string, values?: unknown[]) => {
                const hook = async (phase: 'before' | 'after') => {
                  if (
                    this.hook?.phase === phase &&
                    sql.includes(this.hook.match)
                  ) {
                    const h = this.hook;
                    this.hook = undefined;
                    await h.work(target);
                  }
                };
                if (sql.includes('FOR '))
                  this.pids.push(await backendPid(target));
                await hook('before');
                const r = await target.query(sql, values);
                if (
                  (this.fail === 'insert' &&
                    sql.includes('INSERT INTO public.replacement_offers')) ||
                  (this.fail === 'completion' &&
                    sql.includes("SET state='COMPLETED'"))
                ) {
                  this.fail = undefined;
                  throw new Error('synthetic rollback');
                }
                if (sql.includes("SET state='COMPLETED'")) completed = true;
                await hook('after');
                return r;
              };
            const v: unknown = Reflect.get(target, key);
            return typeof v === 'function' ? v.bind(target) : v;
          },
        }),
      ),
    );
    if (completed && this.fail === 'lostAck') {
      this.fail = undefined;
      throw new Error('synthetic lost commit acknowledgement');
    }
    return result;
  }
}
let pool: TestPool,
  app: INestApplication<App>,
  db: ObservedDatabase,
  f: DutyMutationFixture,
  employee: SyntheticSession,
  original: SyntheticSession,
  foreign: SyntheticSession,
  need: string,
  caseId: string;
const companies: string[] = [],
  releases: (() => void)[] = [],
  pending: Promise<unknown>[] = [];
let previousOrigin: string | undefined;
async function boot(failAudit = false) {
  await app?.close();
  db = new ObservedDatabase();
  await db.isReady();
  app = await bootEmployeesApp(new RecordingDelivery(), {
    database: db,
    clock: () => new Date(MUTATION_NOW),
    ...(failAudit
      ? { audit: new FailingAudit('REPLACEMENT_OFFER_CREATED') }
      : {}),
  });
  await app.listen(0, '127.0.0.1');
}
const list = (
  query = 'monthStart=2027-01-01',
  s: SyntheticSession | null = employee,
) => {
  const r = request(app.getHttpServer()).get(
    `/api/v1/me/replacement-needs?${query}`,
  );
  return s ? r.set('Cookie', s.cookie) : r;
};
const detail = (id = need, s: SyntheticSession | null = employee) => {
  const r = request(app.getHttpServer()).get(`/api/v1/replacement-needs/${id}`);
  return s ? r.set('Cookie', s.cookie) : r;
};
const post = (
  key: string | null = randomUUID(),
  s: SyntheticSession | null = employee,
  id = need,
) => {
  const r = request(app.getHttpServer())
    .post(`/api/v1/replacement-needs/${id}/offers`)
    .set('Origin', ORIGIN);
  if (s) r.set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf);
  if (key !== null) r.set('Idempotency-Key', key);
  return r;
};
const history = () =>
  request(app.getHttpServer())
    .get('/api/v1/me/work-items?monthStart=2027-01-01')
    .set('Cookie', employee.cookie);
const withdraw = () =>
  request(app.getHttpServer())
    .post(`/api/v1/cancellation-requests/${caseId}/withdraw`)
    .set('Origin', ORIGIN)
    .set('Cookie', original.cookie)
    .set('X-CSRF-Token', original.csrf);
async function context(): Promise<TenantContext> {
  const row = (
    await pool.query<{ id: string }>(
      'SELECT id FROM sessions WHERE token_hash=$1',
      [createHash('sha256').update(employee.rawToken).digest()],
    )
  ).rows[0];
  return {
    companyId: f.tenant.companyId,
    accountId: f.jonas.account.accountId,
    sessionId: row.id,
    role: 'EMPLOYEE',
  };
}
async function command(key = randomUUID()) {
  const t = await context();
  return app
    .get(ReplacementOffersService)
    .create(t, need, key, randomUUID())
    .then(
      (r) => ({
        status: 201,
        body: r.result as { id?: string; code?: string },
      }),
      (e: unknown) => ({
        status:
          typeof e === 'object' && e !== null && 'getStatus' in e
            ? (e as { getStatus: () => number }).getStatus()
            : 500,
        body:
          typeof e === 'object' && e !== null && 'getResponse' in e
            ? (
                e as { getResponse: () => { id?: string; code?: string } }
              ).getResponse()
            : {},
      }),
    );
}
async function counts() {
  const q = async (table: string, extra = '') =>
    Number(
      (
        await pool.query(
          `SELECT count(*) AS n FROM public.${table} WHERE company_id=$1 ${extra}`,
          [f.tenant.companyId],
        )
      ).rows[0].n,
    );
  return {
    offers: await q('replacement_offers'),
    audits: await q('audit_event', "AND action='REPLACEMENT_OFFER_CREATED'"),
    completed: await q(
      'idempotency_records',
      "AND operation='CREATE_REPLACEMENT_OFFER' AND state='COMPLETED'",
    ),
  };
}
function pause(
  match = 'SELECT id,need_id,status',
  phase: 'before' | 'after' = 'after',
  rollback = false,
) {
  const entered = latch(),
    go = latch();
  releases.push(go.release);
  let pid = 0;
  db.hook = {
    match,
    phase,
    work: async (c) => {
      pid = await backendPid(c);
      entered.release();
      await go.promise;
      if (rollback) throw new Error('synthetic barrier rollback');
    },
  };
  return { entered: entered.promise, release: go.release, pid: () => pid };
}
async function blocked(holder: number) {
  for (let n = 0; n < 2500; n++) {
    const rows = (
      await pool.query<{ pid: number }>(
        'SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))',
        [holder],
      )
    ).rows;
    const waiter = rows.find((row) => db.pids.includes(row.pid));
    if (waiter) {
      await waitUntilBlockedBy(pool, waiter.pid, holder);
      return;
    }
  }
  throw new Error('Actual command never blocked on held business fence');
}
beforeAll(async () => {
  previousOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
  pool = openLocalTestPool(12);
  await boot();
});
beforeEach(async () => {
  f = await dutyMutationFixture(pool, companies);
  await pool.query(
    "UPDATE monthly_plans SET status='PUBLISHED',published_at=clock_timestamp(),published_by_account_id=$2 WHERE id=$1",
    [f.planId, f.tenant.admin.accountId],
  );
  original = await createSyntheticSession(
    realSessionService(pool),
    f.mira.account,
  );
  employee = await createSyntheticSession(
    realSessionService(pool),
    f.jonas.account,
  );
  foreign = await createSyntheticSession(
    realSessionService(pool),
    (await createStaff(pool, f.foreign.companyId)).account,
  );
  const r = await request(app.getHttpServer())
    .post('/api/v1/cancellation-requests')
    .set('Origin', ORIGIN)
    .set('Cookie', original.cookie)
    .set('X-CSRF-Token', original.csrf)
    .set('Expected-Version', '1')
    .set('Idempotency-Key', randomUUID())
    .send({ assignmentId: f.membership });
  expect(r.status).toBe(201);
  need = r.body.replacementNeed.id;
  caseId = r.body.id;
  db.pids = [];
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(pending.splice(0));
  db.hook = undefined;
  db.fail = undefined;
  await removeSyntheticTenants(pool, companies.splice(0));
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousOrigin;
});
it('returns exact contextual DTOs, pagination, own history and one atomic create without assignment mutation', async () => {
  const before = await planningState(pool, f.tenant.companyId),
    r = await list();
  expect(r.status).toBe(200);
  expect(r.body.pagination).toEqual({
    page: 1,
    pageSize: 25,
    totalItems: 1,
    totalPages: 1,
  });
  expect(Object.keys(r.body.items[0]).sort()).toEqual(['myOffer', 'need']);
  expect(r.body.items[0].need).toEqual((await detail()).body);
  expect(r.body.items[0].need.project.id).toBe(f.project.projectId);
  expect(r.body.items[0].need.timeZone).toBe('Europe/Berlin');
  expect(JSON.stringify(r.body)).not.toContain(f.mira.employeeId);
  const created = await post();
  expect(created.status).toBe(201);
  expect(created.body.status).toBe('OPEN');
  expect(created.body.decidedAt).toBeNull();
  expect(created.body.employee.id).toBe(f.jonas.employeeId);
  expect(await counts()).toEqual({ offers: 1, audits: 1, completed: 1 });
  const after = await planningState(pool, f.tenant.companyId);
  expect(after.duties).toEqual(before.duties);
  expect(after.members).toEqual(before.members);
  expect((await history()).body.replacementOffers).toEqual([created.body]);
  expect((await list()).body.items[0].myOffer).toEqual(created.body);
});
it('allows two candidates, has no monthly offer quota and filters before pagination', async () => {
  const second = await createStaff(pool, f.tenant.companyId);
  await insertProjectAssignment(
    pool,
    f.tenant.companyId,
    second.employeeId,
    f.project.projectId,
    '2027-01-01',
  );
  const session = await createSyntheticSession(
    realSessionService(pool),
    second.account,
  );
  expect((await post()).status).toBe(201);
  expect((await post(randomUUID(), session)).status).toBe(201);
  expect((await detail()).body.openOfferCount).toBe(2);
  expect((await list('monthStart=2027-01-01&page=2&pageSize=1')).body).toEqual({
    items: [],
    pagination: { page: 2, pageSize: 1, totalItems: 1, totalPages: 1 },
  });
});
it.each([
  'employment_start=NULL',
  "employment_start='2027-01-21'",
  "employment_end='2027-01-19'",
  "shift_eligibility='NACHT'",
])('fresh eligibility rejects employee %s', async (change) => {
  await pool.query(`UPDATE employees SET ${change} WHERE id=$1`, [
    f.jonas.employeeId,
  ]);
  expect((await list()).body.pagination.totalItems).toBe(0);
  expect((await detail()).status).toBe(404);
  expect((await post()).body.code).toBe('REPLACEMENT_CANDIDATE_INELIGIBLE');
  expect(await counts()).toEqual({ offers: 0, audits: 0, completed: 0 });
});
it.each(['SICK', 'LEAVE'])(
  'duty-local %s prevents discovery and submission',
  async (status) => {
    await pool.query(
      'INSERT INTO employee_availability_days(company_id,employee_id,day,status) VALUES($1,$2,$3,$4)',
      [f.tenant.companyId, f.jonas.employeeId, '2027-01-20', status],
    );
    expect((await list()).body.items).toEqual([]);
    expect((await post()).body.code).toBe('REPLACEMENT_CANDIDATE_UNAVAILABLE');
  },
);
it('uses inclusive duty-date employment and next-day-only absence for overnight', async () => {
  await pool.query(
    "UPDATE duties SET shift_kind='NACHT',starts_at='2027-01-20T17:00:00Z',ends_at='2027-01-21T05:00:00Z',start_local='18:00',end_local='06:00' WHERE id=$1",
    [f.dutyId],
  );
  await pool.query(
    "UPDATE employees SET employment_start='2027-01-20',employment_end='2027-01-20',shift_eligibility='NACHT' WHERE id=$1",
    [f.jonas.employeeId],
  );
  await pool.query(
    "INSERT INTO employee_availability_days(company_id,employee_id,day,status) VALUES($1,$2,'2027-01-21','SICK')",
    [f.tenant.companyId, f.jonas.employeeId],
  );
  expect((await list()).body.pagination.totalItems).toBe(1);
  expect((await post()).status).toBe(201);
});
it.each(['INACTIVE', 'ARCHIVED'])(
  'excludes %s project for new offers but retains history and replay',
  async (status) => {
    const key = randomUUID(),
      created = await post(key);
    expect(created.status).toBe(201);
    await pool.query('UPDATE projects SET status=$2 WHERE id=$1', [
      f.project.projectId,
      status,
    ]);
    expect((await list()).body.items).toEqual([]);
    expect((await detail()).status).toBe(404);
    expect((await post()).body.code).toBe('REPLACEMENT_CANDIDATE_INELIGIBLE');
    expect((await post(key)).body.id).toBe(created.body.id);
    expect((await history()).body.replacementOffers).toHaveLength(1);
  },
);
it('requires exact project/month link and preserves existing history after link loss', async () => {
  expect((await post()).status).toBe(201);
  await pool.query('DELETE FROM project_assignments WHERE employee_id=$1', [
    f.jonas.employeeId,
  ]);
  expect((await list()).body.items).toEqual([]);
  expect((await post()).body.code).toBe('REPLACEMENT_CANDIDATE_INELIGIBLE');
  expect((await history()).body.replacementOffers).toHaveLength(1);
});
it.each(['assigned', 'overlap', 'adjacent-other-shift', 'removed'])(
  'checks actual Planning conflicts %s across unpublished membership',
  async (kind) => {
    let duty = f.dutyId;
    if (kind !== 'assigned')
      duty = await insertDuty(pool, {
        companyId: f.tenant.companyId,
        projectId: f.project.projectId,
        planId: f.planId,
        month: '2027-01-01',
        dutyDate: kind === 'adjacent-other-shift' ? '2027-01-20' : '2027-01-19',
        kind: kind === 'adjacent-other-shift' ? 'NACHT' : 'TAG',
        startsAt:
          kind === 'adjacent-other-shift'
            ? '2027-01-20T17:00:00Z'
            : '2027-01-20T04:00:00Z',
        endsAt:
          kind === 'adjacent-other-shift'
            ? '2027-01-21T05:00:00Z'
            : '2027-01-20T06:00:00Z',
      });
    await insertMembership(
      pool,
      f.tenant.companyId,
      duty,
      f.jonas.employeeId,
      kind === 'removed' ? 'REMOVED' : 'ACTIVE',
    );
    expect((await post()).status).toBe(kind === 'removed' ? 201 : 409);
  },
);
it('conceals foreign and irrelevant local resources, but gives contextual self-offer conflict', async () => {
  expect((await detail(need, foreign)).status).toBe(404);
  expect((await post(randomUUID(), foreign)).status).toBe(404);
  expect((await detail(need, original)).status).toBe(404);
  expect((await post(randomUUID(), original)).body.code).toBe(
    'REPLACEMENT_SELF_OFFER_NOT_ALLOWED',
  );
  const stranger = await createStaff(pool, f.tenant.companyId),
    s = await createSyntheticSession(
      realSessionService(pool),
      stranger.account,
    );
  expect((await detail(need, s)).status).toBe(404);
  expect((await post(randomUUID(), s)).status).toBe(404);
});
it.each(['list', 'detail', 'post'])(
  'enforces authenticated employee role on %s',
  async (kind) => {
    const op = (s: SyntheticSession | null) =>
      kind === 'list'
        ? list('monthStart=2027-01-01', s)
        : kind === 'detail'
          ? detail(need, s)
          : post(randomUUID(), s);
    expect((await op(null)).status).toBe(401);
    expect((await op(f.admin)).status).toBe(403);
  },
);
it.each([
  'monthStart=2027-01-02',
  'monthStart=2027-02-30',
  'monthStart=0000-01-01',
  'monthStart=2027-01-01&monthStart=2027-01-01',
  'monthStart=2027-01-01&page=0',
  'monthStart=2027-01-01&page=1.1',
  'monthStart=2027-01-01&page=9007199254740992',
  'monthStart=2027-01-01&pageSize=101',
  'monthStart=2027-01-01&employeeId=x',
])('rejects strict query %s', async (q) => {
  expect((await list(q)).status).toBe(400);
});
it('rejects body/key/query overrides, requires CSRF/Origin, and prevents caching including HEAD/errors', async () => {
  expect((await post(null)).body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  expect((await post('short')).body.code).toBe('IDEMPOTENCY_KEY_INVALID');
  expect((await post().send({ employeeId: f.mira.employeeId })).status).toBe(
    400,
  );
  expect((await post().query({ companyId: f.tenant.companyId })).status).toBe(
    400,
  );
  expect((await post().set('X-CSRF-Token', 'invalid')).status).toBe(403);
  expect((await post().unset('Origin')).status).toBe(403);
  for (const r of [
    await list(),
    await detail(),
    await detail(randomUUID()),
    await request(app.getHttpServer())
      .head(`/api/v1/replacement-needs/${need}`)
      .set('Cookie', employee.cookie),
  ]) {
    expect(r.headers['cache-control']).toBe('private, no-store');
    expect(r.headers.vary).toContain('Cookie');
    expect(r.headers.etag).toBeUndefined();
  }
});
it('completed same-key replay precedes duplicate/closure checks and returns current INVALIDATED state', async () => {
  const key = randomUUID(),
    r = await post(key);
  expect(r.status).toBe(201);
  const again = await post(key.toUpperCase() === key ? key : key);
  expect(again.status).toBe(201);
  expect(again.headers['idempotency-replayed']).toBe('true');
  expect((await post()).body.code).toBe('REPLACEMENT_OFFER_ALREADY_EXISTS');
  expect((await withdraw()).status).toBe(200);
  const closed = await post(key);
  expect(closed.status).toBe(201);
  expect(closed.body.id).toBe(r.body.id);
  expect(closed.body.status).toBe('INVALIDATED');
  expect(closed.body.decidedAt).not.toBeNull();
  expect((await detail()).status).toBe(404);
  expect(await counts()).toEqual({ offers: 1, audits: 1, completed: 1 });
});
it('cutoff uses current database clock, while authorized replay survives start', async () => {
  const key = randomUUID();
  expect((await post(key)).status).toBe(201);
  await pool.query(
    "UPDATE duties SET starts_at=clock_timestamp()-interval '1 hour',ends_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
    [f.dutyId],
  );
  expect((await post()).body.code).toBe('REPLACEMENT_CANDIDATE_INELIGIBLE');
  expect((await post(key)).status).toBe(201);
  expect((await list()).body.items).toEqual([]);
});
it.each(['insert', 'completion', 'lostAck'] as const)(
  'fences %s failure and permits safe same-key recovery',
  async (fail) => {
    const key = randomUUID();
    db.fail = fail;
    expect((await post(key)).status).toBe(500);
    expect(await counts()).toEqual(
      fail === 'lostAck'
        ? { offers: 1, audits: 1, completed: 1 }
        : { offers: 0, audits: 0, completed: 0 },
    );
    expect((await post(key)).status).toBe(201);
    expect(await counts()).toEqual({ offers: 1, audits: 1, completed: 1 });
  },
);
it('rolls back a mandatory audit failure', async () => {
  await boot(true);
  expect((await post()).status).toBe(500);
  expect(await counts()).toEqual({ offers: 0, audits: 0, completed: 0 });
  await boot();
});
it.each([false, true])(
  'different keys serialize at actual D/W3 fence (first rollback=%s)',
  async (rollback) => {
    const gate = pause(undefined, undefined, rollback);
    const first = command();
    pending.push(first);
    await gate.entered;
    const second = command();
    pending.push(second);
    await blocked(gate.pid());
    gate.release();
    expect((await first).status).toBe(rollback ? 500 : 201);
    expect((await second).status).toBe(rollback ? 201 : 409);
    expect(await counts()).toEqual({ offers: 1, audits: 1, completed: 1 });
  },
);
it.each([false, true])(
  'withdrawal first at real D/W3 fence (rollback=%s)',
  async (rollback) => {
    const gate = pause(undefined, undefined, rollback),
      first = withdraw().then((r) => r);
    pending.push(first);
    await gate.entered;
    const second = command();
    pending.push(second);
    await blocked(gate.pid());
    gate.release();
    expect((await first).status).toBe(rollback ? 500 : 200);
    expect((await second).status).toBe(rollback ? 201 : 409);
  },
);
it.each([false, true])(
  'offer first is atomically invalidated by real withdrawal (rollback=%s)',
  async (rollback) => {
    const gate = pause(undefined, undefined, rollback),
      first = command();
    pending.push(first);
    await gate.entered;
    const second = withdraw().then((r) => r);
    pending.push(second);
    await blocked(gate.pid());
    gate.release();
    expect((await first).status).toBe(rollback ? 500 : 201);
    expect((await second).status).toBe(200);
    const h = await history();
    expect(
      h.body.replacementOffers.map((o: { status: string }) => o.status),
    ).toEqual(rollback ? [] : ['INVALIDATED']);
  },
);
it('rechecks revoked session after actual D wait', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT id FROM duties WHERE id=$1 FOR UPDATE', [f.dutyId]);
    const holder = await backendPid(c),
      result = command();
    pending.push(result);
    await blocked(holder);
    const t = await context();
    await pool.query(
      'UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1',
      [t.sessionId],
    );
    await c.query('COMMIT');
    expect((await result).status).toBe(401);
    expect((await counts()).offers).toBe(0);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});

async function removal(kind: 'patch' | 'delete' | 'batch') {
  if (kind === 'batch') {
    const path = `/api/v1/monthly-plans/${f.planId}/employee-months/${f.mira.employeeId}`;
    const r = await request(app.getHttpServer())
      .get(path)
      .set('Cookie', f.admin.cookie);
    expect(r.status).toBe(200);
    const v = r.body,
      body = {
        expectedPlan: {
          status: v.plan.status,
          publishedAt: v.plan.publishedAt,
        },
        expectedCreationContext: v.creationContextFingerprint,
        expectedCalendar: v.operatingCalendar.effective
          ? {
              id: v.operatingCalendar.effective.id,
              version: v.operatingCalendar.effective.version,
            }
          : null,
        days: v.days.map(
          (d: {
            date: string;
            day: { dutyId: string; version: number } | null;
            night: { dutyId: string; version: number } | null;
          }) => ({
            date: d.date,
            expected: {
              day: d.day ? { id: d.day.dutyId, version: d.day.version } : null,
              night: d.night
                ? { id: d.night.dutyId, version: d.night.version }
                : null,
            },
            desired: { state: 'OFF' },
          }),
        ),
      };
    return () =>
      request(app.getHttpServer())
        .post(`${path}/save`)
        .set('Origin', ORIGIN)
        .set('Cookie', f.admin.cookie)
        .set('X-CSRF-Token', f.admin.csrf)
        .set('Idempotency-Key', randomUUID())
        .send(body)
        .then((r) => r);
  }
  const r = await request(app.getHttpServer())
    .post(`${dutyPath(f)}/edit-lease`)
    .set('Origin', ORIGIN)
    .set('Cookie', f.admin.cookie)
    .set('X-CSRF-Token', f.admin.csrf);
  expect(r.status).toBe(200);
  return () => {
    const op = request(app.getHttpServer())
      [kind](dutyPath(f))
      .set('Origin', ORIGIN)
      .set('Cookie', f.admin.cookie)
      .set('X-CSRF-Token', f.admin.csrf)
      .set('Expected-Version', '1')
      .set('Edit-Lease-Token', r.body.leaseToken as string);
    return (kind === 'patch' ? op.send({ assignments: [] }) : op).then(
      (r) => r,
    );
  };
}
it.each(['patch', 'delete', 'batch'] as const)(
  'real CR03 %s wins before offer; committed closure rejects, rollback admits',
  async (kind) => {
    for (const rollback of [true, false]) {
      const mutate = await removal(kind),
        gate = pause(undefined, undefined, rollback),
        first = mutate();
      pending.push(first);
      await gate.entered;
      const second = command();
      pending.push(second);
      await blocked(gate.pid());
      gate.release();
      expect((await first).status).toBe(
        rollback ? 500 : kind === 'delete' ? 204 : 200,
      );
      expect((await second).status).toBe(rollback ? 201 : 409);
      if (rollback) {
        await pool.query(
          "WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at) UPDATE replacement_offers SET status='WITHDRAWN',decided_at=at,updated_at=at FROM moment WHERE company_id=$1",
          [f.tenant.companyId],
        );
      }
    }
  },
);
it.each(['patch', 'delete', 'batch'] as const)(
  'offer wins before real CR03 %s, then closure invalidates atomically',
  async (kind) => {
    const mutate = await removal(kind),
      gate = pause(),
      first = command();
    pending.push(first);
    await gate.entered;
    const second = mutate();
    pending.push(second);
    await blocked(gate.pid());
    gate.release();
    expect((await first).status).toBe(201);
    expect((await second).status).toBe(kind === 'delete' ? 204 : 200);
    expect((await history()).body.replacementOffers[0].status).toBe(
      'INVALIDATED',
    );
    expect((await counts()).audits).toBe(1);
  },
);
it('same key concurrent attempt sees in-progress then replays one result', async () => {
  const key = randomUUID(),
    gate = pause(),
    first = command(key);
  pending.push(first);
  await gate.entered;
  const second = await command(key);
  expect(second.status).toBe(409);
  expect(second.body.code).toBe('IDEMPOTENCY_REQUEST_IN_PROGRESS');
  gate.release();
  const result = await first;
  expect((await post(key)).body.id).toBe(result.body.id);
  expect(await counts()).toEqual({ offers: 1, audits: 1, completed: 1 });
});
it('fingerprint binds the need and canonical UUID path, not correlation/key spelling', async () => {
  const key = randomUUID(),
    first = await post(key);
  expect(first.status).toBe(201);
  expect((await post(key, employee, need.toUpperCase())).body.id).toBe(
    first.body.id,
  );
  const id = await insertDuty(pool, {
      companyId: f.tenant.companyId,
      projectId: f.project.projectId,
      planId: f.planId,
      month: '2027-01-01',
      dutyDate: '2027-01-22',
      startsAt: '2027-01-22T05:00:00Z',
      endsAt: '2027-01-22T17:00:00Z',
    }),
    membership = await insertMembership(
      pool,
      f.tenant.companyId,
      id,
      f.mira.employeeId,
    );
  const r = await request(app.getHttpServer())
    .post('/api/v1/cancellation-requests')
    .set('Origin', ORIGIN)
    .set('Cookie', original.cookie)
    .set('X-CSRF-Token', original.csrf)
    .set('Expected-Version', '1')
    .set('Idempotency-Key', randomUUID())
    .send({ assignmentId: membership });
  expect(r.status).toBe(201);
  expect((await post(key, employee, r.body.replacementNeed.id)).body.code).toBe(
    'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
  );
});
it('stale attempt is reclaimed with a new fence, old executor cannot complete', async () => {
  const key = randomUUID(),
    gate = pause('SELECT id FROM public.duties', 'before'),
    first = command(key);
  pending.push(first);
  await gate.entered;
  // The old executor already holds I here, so a competing attempt cannot reset its row.
  const second = await command(key);
  expect(second.status).toBe(409);
  gate.release();
  expect((await first).status).toBe(201);
  await pool.query(
    "UPDATE idempotency_records SET created_at=created_at-interval '2 days',claimed_at=claimed_at-interval '2 days',completed_at=completed_at-interval '2 days',expires_at=expires_at-interval '2 days' WHERE company_id=$1 AND operation='CREATE_REPLACEMENT_OFFER'",
    [f.tenant.companyId],
  );
  expect((await post(key)).body.code).toBe('REPLACEMENT_OFFER_ALREADY_EXISTS');
  expect((await counts()).offers).toBe(1);
});
it.each(['employment', 'availability', 'month', 'shift', 'inactive'] as const)(
  'eligibility edit %s first fences new offer at E and rechecks after commit',
  async (kind) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT id FROM employees WHERE id=$1 FOR NO KEY UPDATE', [
        f.jonas.employeeId,
      ]);
      const first = command();
      pending.push(first);
      await blocked(await backendPid(c));
      if (kind === 'employment')
        await c.query(
          "UPDATE employees SET employment_start='2027-01-21' WHERE id=$1",
          [f.jonas.employeeId],
        );
      if (kind === 'availability')
        await c.query(
          "INSERT INTO employee_availability_days(company_id,employee_id,day,status) VALUES($1,$2,'2027-01-20','LEAVE')",
          [f.tenant.companyId, f.jonas.employeeId],
        );
      if (kind === 'month')
        await c.query('DELETE FROM project_assignments WHERE employee_id=$1', [
          f.jonas.employeeId,
        ]);
      if (kind === 'shift')
        await c.query(
          "UPDATE employees SET shift_eligibility='NACHT' WHERE id=$1",
          [f.jonas.employeeId],
        );
      if (kind === 'inactive')
        await c.query("UPDATE employees SET status='DEACTIVATED' WHERE id=$1", [
          f.jonas.employeeId,
        ]);
      await c.query('COMMIT');
      expect((await first).status).toBe(
        kind === 'inactive' ? 403 : kind === 'month' ? 404 : 409,
      );
      expect((await counts()).offers).toBe(0);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  },
);

it('reclaims a genuinely stale pending receipt with a fresh attempt, and cannot complete the old fence', async () => {
  const key = randomUUID();
  db.fail = 'insert';
  expect((await post(key)).status).toBe(500);
  const old = (
    await pool.query<{ id: string; attempt_id: string }>(
      "UPDATE idempotency_records SET state='IN_PROGRESS',created_at=clock_timestamp()-interval '6 minutes',claimed_at=clock_timestamp()-interval '6 minutes' WHERE company_id=$1 AND operation='CREATE_REPLACEMENT_OFFER' RETURNING id,attempt_id",
      [f.tenant.companyId],
    )
  ).rows[0];
  expect((await post(key)).status).toBe(201);
  const receipt = (
    await pool.query(
      'SELECT attempt_id,state,extract(epoch FROM expires_at-completed_at)::int AS retention FROM idempotency_records WHERE id=$1',
      [old.id],
    )
  ).rows[0];
  expect(receipt.attempt_id).not.toBe(old.attempt_id);
  expect(receipt.state).toBe('COMPLETED');
  expect(receipt.retention).toBe(86400);
  expect(
    (
      await pool.query(
        "UPDATE idempotency_records SET state='FAILED' WHERE id=$1 AND attempt_id=$2 AND state='IN_PROGRESS'",
        [old.id, old.attempt_id],
      )
    ).rowCount,
  ).toBe(0);
});
it('honors a fresh pending claim without allocating another receipt', async () => {
  const key = randomUUID();
  db.fail = 'insert';
  expect((await post(key)).status).toBe(500);
  await pool.query(
    "UPDATE idempotency_records SET state='IN_PROGRESS' WHERE company_id=$1 AND operation='CREATE_REPLACEMENT_OFFER'",
    [f.tenant.companyId],
  );
  expect((await post(key)).body.code).toBe('IDEMPOTENCY_REQUEST_IN_PROGRESS');
  expect((await counts()).offers).toBe(0);
});
it('retries a FAILED receipt without allocating duplicate business rows', async () => {
  const key = randomUUID();
  db.fail = 'insert';
  expect((await post(key)).status).toBe(500);
  expect((await post(key)).status).toBe(201);
  expect(await counts()).toEqual({ offers: 1, audits: 1, completed: 1 });
});
it('never admits OPEN_UNFILLED and retains terminal statuses in own history', async () => {
  expect((await post()).status).toBe(201);
  await pool.query(
    "WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at) UPDATE replacement_offers SET status='NOT_SELECTED',decided_at=at,updated_at=at FROM moment WHERE company_id=$1",
    [f.tenant.companyId],
  );
  await pool.query(
    "WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at) UPDATE cancellation_requests SET status='APPROVED',decided_at=at,updated_at=at,decided_by_account_id=$2 FROM moment WHERE id=$1",
    [caseId, f.tenant.admin.accountId],
  );
  await pool.query(
    "UPDATE replacement_needs SET status='OPEN_UNFILLED' WHERE id=$1",
    [need],
  );
  expect((await list()).body.items).toEqual([]);
  expect((await detail()).status).toBe(404);
  expect((await post()).body.code).toBe('REPLACEMENT_NEED_NOT_OPEN');
  expect((await history()).body.replacementOffers[0].status).toBe(
    'NOT_SELECTED',
  );
});
it.each([false, true])(
  'cross-project prior NIGHT conflict in UNPUBLISHED planning (adjacent=%s)',
  async (adjacent) => {
    const project = await createSyntheticProject(pool, f.tenant.companyId),
      plan = await insertPlan(
        pool,
        f.tenant.companyId,
        project.projectId,
        '2027-01-01',
      );
    const duty = await insertDuty(pool, {
      companyId: f.tenant.companyId,
      projectId: project.projectId,
      planId: plan,
      month: '2027-01-01',
      dutyDate: '2027-01-19',
      kind: 'NACHT',
      startsAt: '2027-01-19T17:00:00Z',
      endsAt: adjacent ? '2027-01-20T05:00:00Z' : '2027-01-20T06:00:00Z',
    });
    await insertMembership(pool, f.tenant.companyId, duty, f.jonas.employeeId);
    expect((await post()).status).toBe(adjacent ? 201 : 409);
  },
);
it('accepts fourth and fifth voluntary offers without reserving candidate time', async () => {
  expect((await post()).status).toBe(201);
  for (const day of ['21', '22', '23', '24']) {
    const duty = await insertDuty(pool, {
        companyId: f.tenant.companyId,
        projectId: f.project.projectId,
        planId: f.planId,
        month: '2027-01-01',
        dutyDate: `2027-01-${day}`,
        startsAt: `2027-01-${day}T05:00:00Z`,
        endsAt: `2027-01-${day}T17:00:00Z`,
      }),
      membership = await insertMembership(
        pool,
        f.tenant.companyId,
        duty,
        f.mira.employeeId,
      );
    const r = await request(app.getHttpServer())
      .post('/api/v1/cancellation-requests')
      .set('Origin', ORIGIN)
      .set('Cookie', original.cookie)
      .set('X-CSRF-Token', original.csrf)
      .set('Expected-Version', '1')
      .set('Idempotency-Key', randomUUID())
      .send({ assignmentId: membership });
    expect(r.status).toBe(201);
    expect(
      (await post(randomUUID(), employee, r.body.replacementNeed.id)).status,
    ).toBe(201);
  }
  expect(await counts()).toEqual({ offers: 5, audits: 5, completed: 5 });
});
it.each(['employment', 'shift', 'month', 'availability'] as const)(
  'offer first then fenced %s change retains own OPEN history but removes current eligibility',
  async (kind) => {
    const gate = pause(),
      first = command();
    pending.push(first);
    await gate.entered;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const pid = await backendPid(c),
        edit = c.query(
          'SELECT id FROM employees WHERE id=$1 FOR NO KEY UPDATE',
          [f.jonas.employeeId],
        );
      pending.push(edit);
      await waitUntilBlockedBy(pool, pid, gate.pid());
      gate.release();
      expect((await first).status).toBe(201);
      await edit;
      if (kind === 'employment')
        await c.query(
          "UPDATE employees SET employment_end='2027-01-19' WHERE id=$1",
          [f.jonas.employeeId],
        );
      if (kind === 'shift')
        await c.query(
          "UPDATE employees SET shift_eligibility='NACHT' WHERE id=$1",
          [f.jonas.employeeId],
        );
      if (kind === 'month')
        await c.query('DELETE FROM project_assignments WHERE employee_id=$1', [
          f.jonas.employeeId,
        ]);
      if (kind === 'availability')
        await c.query(
          "INSERT INTO employee_availability_days(company_id,employee_id,day,status) VALUES($1,$2,'2027-01-20','SICK')",
          [f.tenant.companyId, f.jonas.employeeId],
        );
      await c.query('COMMIT');
      expect((await list()).body.items).toEqual([]);
      expect((await history()).body.replacementOffers[0].status).toBe('OPEN');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  },
);

it('checks current authority for completed replay after employee mapping loss', async () => {
  const key = randomUUID();
  expect((await post(key)).status).toBe(201);
  const other = await createStaff(pool, f.tenant.companyId);
  // Move the employee to another already active employee account through a synthetic spare account.
  // Unique mapping is enforced; remove the current mapping through a spare account without touching history ownership.
  await pool.query('UPDATE employees SET account_id=$2 WHERE id=$1', [
    other.employeeId,
    f.tenant.employee.accountId,
  ]);
  await pool.query('UPDATE employees SET account_id=$2 WHERE id=$1', [
    f.jonas.employeeId,
    other.account.accountId,
  ]);
  expect((await post(key)).status).toBe(403);
  expect((await history()).status).toBe(403);
  expect((await counts()).offers).toBe(1);
});
it('enforces exact query/body/header contracts before reservations', async () => {
  expect(
    (await detail().query({ employeeId: f.jonas.employeeId })).status,
  ).toBe(400);
  expect((await post().set('Transfer-Encoding', 'chunked')).status).toBe(400);
  expect(
    (await post().set({ 'Idempotency-Key': [randomUUID(), randomUUID()] }))
      .status,
  ).toBe(400);
  expect((await counts()).completed).toBe(0);
});

it('session revocation after completion work still rolls back before COMMIT', async () => {
  const gate = pause("SET state='COMPLETED'"),
    result = command();
  pending.push(result);
  await gate.entered;
  const t = await context();
  await pool.query(
    'UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1',
    [t.sessionId],
  );
  gate.release();
  expect((await result).status).toBe(401);
  expect(await counts()).toEqual({ offers: 0, audits: 0, completed: 0 });
});
