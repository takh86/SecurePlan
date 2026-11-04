/** Real Nest HTTP, current Identity authority, disposable PostgreSQL 17 and deterministic barriers. */
import { createHash, randomUUID } from 'node:crypto';
import { CancellationRequestsService } from '../src/modules/cancellation-replacement/cancellation-requests.service.js';
import type { TenantContext } from '../src/auth/authorization/tenant-context.js';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DatabaseService } from '../src/database/database.service.js';
import { BusinessAuditService } from '../src/modules/audit/business-audit.service.js';
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
  realSessionService,
  backendPid,
  waitUntilBlockedBy,
  type TestPool,
  type SyntheticSession,
} from './helpers/synthetic-tenants.js';
import {
  insertDuty,
  insertMembership,
  createStaff,
} from './helpers/planning-fixtures.js';
const BASE = '/api/v1/cancellation-requests';
const hash = (s: string) => createHash('sha256').update(s).digest();
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
class ObservedDatabase extends DatabaseService {
  hook?: {
    match: string;
    phase: 'before' | 'after';
    work: (c: PoolClient) => Promise<void>;
  };
  fail?: 'cancellation' | 'need' | 'completion' | 'deferred' | 'lostAck';
  dutyPids: number[] = [];
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
                const runHook = async (phase: 'before' | 'after') => {
                  if (
                    this.hook?.phase === phase &&
                    sql.includes(this.hook.match)
                  ) {
                    const hook = this.hook;
                    this.hook = undefined;
                    await hook.work(target);
                  }
                };
                if (sql.includes('public.duties') && sql.includes('FOR UPDATE'))
                  this.dutyPids.push(await backendPid(target));
                await runHook('before');
                const result = await target.query(sql, values);
                const failure = this.fail;
                if (
                  (failure === 'cancellation' &&
                    sql.startsWith(
                      'INSERT INTO public.cancellation_requests',
                    )) ||
                  (failure === 'need' &&
                    sql.startsWith('INSERT INTO public.replacement_needs')) ||
                  (failure === 'completion' &&
                    sql.includes("SET state='COMPLETED'"))
                ) {
                  this.fail = undefined;
                  await target.query('SELECT 1/0');
                }
                if (
                  failure === 'deferred' &&
                  sql.includes('FROM public.cancellation_requests r LEFT JOIN')
                ) {
                  this.fail = undefined;
                  await target.query(
                    'DELETE FROM public.replacement_needs WHERE company_id=$1',
                    [values![0]],
                  );
                }
                if (sql.includes("SET state='COMPLETED'")) completed = true;
                await runHook('after');
                return result;
              };
            const value: unknown = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
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
  coworker: SyntheticSession,
  foreignEmployee: SyntheticSession;
const companies: string[] = [],
  releases: (() => void)[] = [],
  pending: Promise<unknown>[] = [],
  clients: PoolClient[] = [];
let previousOrigin: string | undefined;
async function boot(audit?: BusinessAuditService) {
  await app?.close();
  db = new ObservedDatabase();
  await db.isReady();
  app = await bootEmployeesApp(new RecordingDelivery(), {
    database: db,
    clock: () => new Date(MUTATION_NOW),
    ...(audit ? { audit } : {}),
  });
  await app.listen(0, '127.0.0.1');
}
const post = (
  key: string | string[] | null = randomUUID(),
  version: string | string[] | null = '1',
  session: SyntheticSession | null = employee,
  body: unknown = { assignmentId: f.membership },
) => {
  const op = request(app.getHttpServer()).post(BASE).set('Origin', ORIGIN);
  if (session)
    op.set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf);
  if (key !== null) op.set({ 'Idempotency-Key': key });
  if (version !== null) op.set({ 'Expected-Version': version });
  return op.send(body as object);
};
const get = (id: string, session: SyntheticSession | null = employee) => {
  const op = request(app.getHttpServer()).get(`${BASE}/${id}`);
  return session ? op.set('Cookie', session.cookie) : op;
};
async function rows() {
  const q = async (table: string) =>
    (
      await pool.query(
        `SELECT * FROM public.${table} WHERE company_id=$1 ORDER BY id`,
        [f.tenant.companyId],
      )
    ).rows;
  return {
    requests: await q('cancellation_requests'),
    needs: await q('replacement_needs'),
    ledger: await q('idempotency_records'),
    audits: (await q('audit_event')).filter(
      (r) => r.action === 'CANCELLATION_CREATED',
    ),
  };
}
async function code(
  op: ReturnType<typeof post>,
  status: number,
  expected: string,
) {
  const r = await op;
  expect([r.status, r.body.code]).toEqual([status, expected]);
  return r;
}
function pause(
  match: string,
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
      if (rollback) await c.query('SELECT 1/0');
    },
  };
  return { entered: entered.promise, release: go.release, pid: () => pid };
}
async function blockedSubmission(blocker: PoolClient) {
  const p = pause('SELECT id FROM public.duties', 'before');
  const response = post().then((r) => r);
  pending.push(response);
  await p.entered;
  const pid = p.pid();
  p.release();
  await waitUntilBlockedBy(pool, pid, await backendPid(blocker));
  return { response };
}
async function lease() {
  return (
    await request(app.getHttpServer())
      .post(`${dutyPath(f)}/edit-lease`)
      .set('Origin', ORIGIN)
      .set('Cookie', f.admin.cookie)
      .set('X-CSRF-Token', f.admin.csrf)
      .expect(200)
  ).body.leaseToken as string;
}
function mutation(kind: 'patch' | 'delete', token: string) {
  const op = request(app.getHttpServer())
    [kind](dutyPath(f))
    .set('Origin', ORIGIN)
    .set('Cookie', f.admin.cookie)
    .set('X-CSRF-Token', f.admin.csrf)
    .set('Expected-Version', '1')
    .set('Edit-Lease-Token', token);
  return kind === 'patch'
    ? op.send({
        assignments: [{ employeeId: f.jonas.employeeId, dutyRole: 'EMPLOYEE' }],
      })
    : op;
}

async function command(key = randomUUID()) {
  const session = (
    await pool.query<{ id: string }>(
      'SELECT id FROM sessions WHERE token_hash=$1',
      [hash(employee.rawToken)],
    )
  ).rows[0];
  const t: TenantContext = {
    companyId: f.tenant.companyId,
    accountId: f.mira.account.accountId,
    sessionId: session.id,
    role: 'EMPLOYEE',
  };
  return app
    .get(CancellationRequestsService)
    .create(t, f.membership, 1, key, randomUUID())
    .then(
      (r) => ({ status: 201, body: r.result as { code?: string; id: string } }),
      (error: unknown) => ({
        status:
          typeof error === 'object' && error !== null && 'getStatus' in error
            ? (error as { getStatus: () => number }).getStatus()
            : 500,
        body: (typeof error === 'object' &&
        error !== null &&
        'getResponse' in error
          ? (error as { getResponse: () => unknown }).getResponse()
          : {}) as { code?: string; id: string },
      }),
    );
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
  employee = await createSyntheticSession(
    realSessionService(pool),
    f.mira.account,
  );
  coworker = await createSyntheticSession(
    realSessionService(pool),
    f.jonas.account,
  );
  db.dutyPids = [];
  foreignEmployee = await createSyntheticSession(
    realSessionService(pool),
    (await createStaff(pool, f.foreign.companyId)).account,
  );
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const c of clients.splice(0)) {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
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
it('creates one exact OPEN pair/audit/typed receipt and leaves assignment, duty version and four-field statistics unchanged', async () => {
  const before = (
    await pool.query(
      'SELECT to_jsonb(d)::text AS bytes FROM duties d WHERE id=$1',
      [f.dutyId],
    )
  ).rows;
  const statPath = '/api/v1/me/planning-statistics?monthStart=2027-01-01';
  const stats = (
    await request(app.getHttpServer())
      .get(statPath)
      .set('Cookie', employee.cookie)
      .expect(200)
  ).body;
  const r = await post().expect(201);
  expect(r.body).toMatchObject({
    assignmentId: f.membership,
    status: 'OPEN',
    employee: { id: f.mira.employeeId },
    duty: { id: f.dutyId },
    replacementNeed: { status: 'OPEN', resolvedAt: null },
    decidedAt: null,
  });
  expect(Object.keys(r.body).sort()).toEqual(
    [
      'id',
      'assignmentId',
      'employee',
      'duty',
      'status',
      'createdAt',
      'decidedAt',
      'replacementNeed',
    ].sort(),
  );
  expect(Object.keys(r.body.employee).sort()).toEqual(
    ['id', 'employeeCode', 'firstName', 'lastName'].sort(),
  );
  expect(Object.keys(r.body.duty).sort()).toEqual(
    ['id', 'dutyDate', 'shiftKind', 'startsAt', 'endsAt'].sort(),
  );
  expect(r.headers.location).toBe(`${BASE}/${r.body.id}`);
  const saved = await rows();
  expect(saved.requests).toHaveLength(1);
  expect(saved.needs).toHaveLength(1);
  expect(saved.audits).toHaveLength(1);
  expect(saved.ledger[0]).toMatchObject({
    state: 'COMPLETED',
    operation: 'CREATE_CANCELLATION',
    result_cancellation_request_id: r.body.id,
    result_plan_id: null,
    result_json: null,
    result_schema_version: null,
    context_plan_id: null,
    context_employee_id: null,
  });
  expect(saved.audits[0].new_values).toEqual({
    assignmentId: f.membership,
    dutyId: f.dutyId,
    employeeId: f.mira.employeeId,
    submissionVersion: 1,
    status: 'OPEN',
    needId: r.body.replacementNeed.id,
  });
  expect(
    (
      await pool.query(
        'SELECT to_jsonb(d)::text AS bytes FROM duties d WHERE id=$1',
        [f.dutyId],
      )
    ).rows,
  ).toEqual(before);
  expect(
    (
      await pool.query('SELECT state FROM plan_assignments WHERE id=$1', [
        f.membership,
      ])
    ).rows[0].state,
  ).toBe('ACTIVE');
  expect(
    (
      await request(app.getHttpServer())
        .get(statPath)
        .set('Cookie', employee.cookie)
    ).body,
  ).toEqual(stats);
  expect(Object.keys(stats)).toHaveLength(4);
  const own = (
    await request(app.getHttpServer())
      .get('/api/v1/me/monthly-plans?monthStart=2027-01-01')
      .set('Cookie', employee.cookie)
      .expect(200)
  ).body.items[0].duties[0];
  expect(own).toMatchObject({ assignmentId: f.membership, version: 1 });
});
it('same-key replay precedes duty version and active-state conflicts, returning current reconciled state', async () => {
  const key = randomUUID(),
    r = await post(key).expect(201);
  const token = await lease();
  await mutation('delete', token).expect(204);
  const replay = await post(key).expect(201);
  expect(replay.headers['idempotency-replayed']).toBe('true');
  expect(replay.body).toMatchObject({
    id: r.body.id,
    status: 'OBSOLETE',
    replacementNeed: { id: r.body.replacementNeed.id, status: 'CLOSED' },
  });
  expect(replay.headers['x-correlation-id']).not.toBe(
    r.headers['x-correlation-id'],
  );
  expect((await rows()).audits).toHaveLength(1);
  await code(post(randomUUID()), 409, 'CANCELLATION_ASSIGNMENT_NOT_ACTIVE');
  expect((await get(r.body.id).expect(200)).body).toEqual(replay.body);
});
it('same-key exact replay and different-key duplicate create no second pair', async () => {
  const key = randomUUID(),
    a = await post(key).expect(201);
  expect((await post(key).expect(201)).body).toEqual(a.body);
  await code(post(), 409, 'CANCELLATION_ALREADY_EXISTS');
  expect((await rows()).requests).toHaveLength(1);
});
it('same-key changed expected version rejects fingerprint reuse before stale checks', async () => {
  const key = randomUUID();
  await post(key).expect(201);
  await code(
    post(key, '2'),
    409,
    'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
  );
});
it('same-key different own assignment rejects changed payload', async () => {
  const key = randomUUID();
  await post(key).expect(201);
  const otherDuty = await insertDuty(pool, {
    companyId: f.tenant.companyId,
    projectId: f.project.projectId,
    planId: f.planId,
    month: '2027-01-01',
    dutyDate: '2027-01-21',
    startsAt: '2027-01-21T05:00:00Z',
    endsAt: '2027-01-21T17:00:00Z',
  });
  const id = await insertMembership(
    pool,
    f.tenant.companyId,
    otherDuty,
    f.mira.employeeId,
  );
  await code(
    post(key, '1', employee, { assignmentId: id }),
    409,
    'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
  );
});
it.each(['coworker', 'foreign', 'unknown'] as const)(
  'conceals %s assignment',
  async (kind) => {
    await code(
      post(
        randomUUID(),
        '1',
        kind === 'coworker'
          ? coworker
          : kind === 'foreign'
            ? foreignEmployee
            : employee,
        { assignmentId: kind === 'unknown' ? randomUUID() : f.membership },
      ),
      404,
      'RESOURCE_NOT_FOUND',
    );
    expect((await rows()).requests).toEqual([]);
  },
);
it('GET permits current owner/admin and conceals coworker/tenant/unknown resources', async () => {
  const r = await post().expect(201);
  expect((await get(r.body.id, f.admin).expect(200)).body).toEqual(r.body);
  for (const s of [coworker, f.foreignAdmin])
    expect((await get(r.body.id, s).expect(404)).body.code).toBe(
      'RESOURCE_NOT_FOUND',
    );
  await get(randomUUID()).expect(404);
});
it.each(['admin', 'missingEmployee'] as const)(
  'forbids submit by %s',
  async (kind) => {
    await code(
      post(randomUUID(), '1', kind === 'admin' ? f.admin : f.employeeSession),
      403,
      'ACTION_FORBIDDEN',
    );
  },
);
it.each([
  'expired',
  'revoked',
  'inactiveAccount',
  'inactiveCompany',
  'inactiveEmployee',
  'roleChanged',
] as const)('rechecks %s before completed replay and GET', async (kind) => {
  const key = randomUUID(),
    r = await post(key).expect(201);
  if (kind === 'expired')
    await pool.query(
      "UPDATE sessions SET created_at=clock_timestamp()-interval '10 hours',last_seen_at=clock_timestamp()-interval '9 hours' WHERE account_id=$1",
      [f.mira.account.accountId],
    );
  if (kind === 'revoked')
    await pool.query(
      'UPDATE sessions SET revoked_at=clock_timestamp() WHERE account_id=$1',
      [f.mira.account.accountId],
    );
  if (kind === 'inactiveAccount')
    await pool.query("UPDATE accounts SET status='DEACTIVATED' WHERE id=$1", [
      f.mira.account.accountId,
    ]);
  if (kind === 'inactiveCompany')
    await pool.query("UPDATE companies SET status='DEACTIVATED' WHERE id=$1", [
      f.tenant.companyId,
    ]);
  if (kind === 'inactiveEmployee')
    await pool.query("UPDATE employees SET status='DEACTIVATED' WHERE id=$1", [
      f.mira.employeeId,
    ]);
  if (kind === 'roleChanged')
    await pool.query("UPDATE accounts SET role='COMPANY_ADMIN' WHERE id=$1", [
      f.mira.account.accountId,
    ]);
  const expected = ['inactiveEmployee', 'roleChanged'].includes(kind)
    ? 403
    : 401;
  expect((await post(key)).status).toBe(expected);
  expect((await get(r.body.id)).status).toBe(
    kind === 'roleChanged' ? 200 : expected,
  );
  expect((await rows()).requests).toHaveLength(1);
});
it.each([
  null,
  '0',
  '01',
  '-1',
  '1.5',
  '9007199254740992',
  ['1', '1'],
] as const)('strict version header %j', async (value) => {
  const r = await post(randomUUID(), value as string | string[] | null);
  expect([r.status, r.body.code]).toEqual([
    400,
    value === null ? 'EXPECTED_VERSION_REQUIRED' : 'INVALID_EXPECTED_VERSION',
  ]);
});
it.each([null, 'short', 'bad key', ['12345678', '12345678']] as const)(
  'strict idempotency header %j',
  async (value) => {
    const r = await post(value as string | string[] | null);
    expect([r.status, r.body.code]).toEqual([
      400,
      value === null ? 'IDEMPOTENCY_KEY_REQUIRED' : 'IDEMPOTENCY_KEY_INVALID',
    ]);
  },
);
it.each([
  {},
  { assignmentId: 'bad' },
  { assignmentId: null },
  { assignmentId: randomUUID(), companyId: randomUUID() },
])('strict command DTO %j', async (body) => {
  await post(randomUUID(), '1', employee, body).expect(400);
  expect((await rows()).ledger).toEqual([]);
});
it('protects Origin, CSRF, media, parser errors and all private POST/GET/HEAD responses', async () => {
  const ops = [
    post().unset('Origin'),
    post().set('Origin', 'https://foreign.invalid'),
    post().unset('X-CSRF-Token'),
    post().set('X-CSRF-Token', 'x'),
    post().type('text').send('plain'),
    post().type('json').send('{'),
    post().unset('Cookie'),
    get(randomUUID()),
    request(app.getHttpServer())
      .head(`${BASE}/${randomUUID()}`)
      .set('Cookie', employee.cookie),
    request(app.getHttpServer()).post(BASE).type('json').send('{'),
  ];
  for (const op of ops) {
    const r = await op;
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.headers['cache-control']).toBe('private, no-store');
    expect(r.headers.vary).toContain('Cookie');
    expect(r.headers.etag).toBeUndefined();
    expect(r.headers['last-modified']).toBeUndefined();
  }
  const r = await post().expect(201);
  for (const method of ['get', 'head'] as const) {
    const result = await request(app.getHttpServer())
      [method](`${BASE}/${r.body.id}`)
      .set('Cookie', employee.cookie)
      .set('If-None-Match', '*')
      .expect(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.headers.etag).toBeUndefined();
  }
});
it.each(['cancellation', 'need', 'completion', 'deferred'] as const)(
  'rolls back business state and typed completion after %s failure',
  async (failure) => {
    const key = randomUUID();
    db.fail = failure;
    await post(key).expect(500);
    const result = await rows();
    expect(result.requests).toEqual([]);
    expect(result.needs).toEqual([]);
    expect(result.audits).toEqual([]);
    expect(result.ledger[0]).toMatchObject({
      state: 'FAILED',
      result_cancellation_request_id: null,
    });
    await post(key).expect(201);
  },
);
it('mandatory audit failure rolls back pair and permits exact retry', async () => {
  await boot(new FailingAudit('CANCELLATION_CREATED'));
  const key = randomUUID();
  await post(key).expect(500);
  expect((await rows()).requests).toEqual([]);
  await boot();
  await post(key).expect(201);
});
it('lost commit acknowledgement cannot downgrade completion; exact retry recovers original pair', async () => {
  const key = randomUUID();
  db.fail = 'lostAck';
  await post(key).expect(500);
  const saved = await rows();
  expect(saved.ledger[0].state).toBe('COMPLETED');
  const r = await post(key).expect(201);
  expect(r.headers['idempotency-replayed']).toBe('true');
  expect(r.body.id).toBe(saved.requests[0].id);
  expect((await rows()).audits).toHaveLength(1);
});
it('same-key admission is nonwaiting for two currently authorized commands while D is held', async () => {
  const key = randomUUID(),
    p = pause('SELECT id FROM public.duties');
  const first = command(key);
  pending.push(first);
  await p.entered;
  expect(await command(key)).toMatchObject({
    status: 409,
    body: { code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS' },
  });
  p.release();
  expect((await first).status).toBe(201);
  await post(key).expect(201);
  expect((await rows()).requests).toHaveLength(1);
});
it.each(['commit', 'rollback'] as const)(
  'two different keys block at D; first %s determines duplicate or creation',
  async (outcome) => {
    const p = pause('SELECT id FROM public.duties');
    if (outcome === 'rollback') db.fail = 'need';
    const first = command();
    pending.push(first);
    await p.entered;
    const waiting = pause('SELECT id FROM public.duties', 'before');
    const second = command();
    pending.push(second);
    await waiting.entered;
    const waiter = waiting.pid();
    waiting.release();
    await waitUntilBlockedBy(pool, waiter, p.pid());
    p.release();
    expect((await first).status).toBe(outcome === 'commit' ? 201 : 500);
    const r = await second;
    expect([r.status, r.body.code ?? null]).toEqual(
      outcome === 'commit' ? [409, 'CANCELLATION_ALREADY_EXISTS'] : [201, null],
    );
    expect((await rows()).requests).toHaveLength(1);
    expect((await rows()).audits).toHaveLength(1);
  },
);
it('revalidates session expiry after deterministic D wait', async () => {
  const c = await pool.connect();
  clients.push(c);
  await c.query('BEGIN');
  await c.query('SELECT id FROM duties WHERE id=$1 FOR UPDATE', [f.dutyId]);
  const { response } = await blockedSubmission(c);
  await pool.query(
    "UPDATE sessions SET created_at=clock_timestamp()-interval '10 hours',last_seen_at=clock_timestamp()-interval '9 hours' WHERE account_id=$1",
    [f.mira.account.accountId],
  );
  await c.query('COMMIT');
  const r = await response;
  expect([r.status, r.body.code]).toEqual([401, 'SESSION_EXPIRED']);
  expect((await rows()).requests).toEqual([]);
});
it('revocation committed during A-prefix wait prevents creation', async () => {
  const c = await pool.connect();
  clients.push(c);
  await c.query('BEGIN');
  await c.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [
    f.mira.account.accountId,
  ]);
  const p = pause('SELECT a.role, a.email', 'before');
  const response = post().then((r) => r);
  pending.push(response);
  await p.entered;
  const pid = p.pid();
  p.release();
  await waitUntilBlockedBy(pool, pid, await backendPid(c));
  await c.query(
    'UPDATE sessions SET revoked_at=clock_timestamp() WHERE account_id=$1',
    [f.mira.account.accountId],
  );
  await c.query('COMMIT');
  expect((await response).status).toBe(401);
  expect((await rows()).requests).toEqual([]);
});
it.each(['patch', 'delete'] as const)(
  'cancellation wins D before CR-03 %s: atomic OBSOLETE/CLOSED',
  async (kind) => {
    const token = await lease();
    const p = pause('SELECT id FROM public.duties');
    const first = post().then((r) => r);
    pending.push(first);
    await p.entered;
    const edit = mutation(kind, token).then((r) => r);
    pending.push(edit);
    // Observe the actual second backend blocked by the cancellation transaction (not elapsed time).
    let blocked = false;
    for (let i = 0; i < 2000; i++) {
      const r = await pool.query(
        'SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))',
        [p.pid()],
      );
      if (r.rowCount) {
        blocked = true;
        break;
      }
    }
    expect(blocked).toBe(true);
    p.release();
    expect((await first).status).toBe(201);
    expect((await edit).status).toBe(kind === 'delete' ? 204 : 200);
    const saved = await rows();
    expect(saved.requests[0].status).toBe('OBSOLETE');
    expect(saved.needs[0].status).toBe('CLOSED');
  },
);
it.each(
  (['patch', 'delete'] as const).flatMap((kind) =>
    [false, true].map((rollback) => ({ kind, rollback })),
  ),
)(
  'CR-03 $kind wins before submission, rollback=$rollback',
  async ({ kind, rollback }) => {
    const token = await lease();
    const p = pause('UPDATE public.plan_assignments', 'after', rollback);
    const edit = mutation(kind, token).then((r) => r);
    pending.push(edit);
    await p.entered;
    const submitting = post().then((r) => r);
    pending.push(submitting);
    let blocked = false;
    for (let i = 0; i < 2000; i++) {
      const r = await pool.query(
        'SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))',
        [p.pid()],
      );
      if (r.rowCount) {
        blocked = true;
        break;
      }
    }
    expect(blocked).toBe(true);
    p.release();
    expect((await edit).status).toBe(
      rollback ? 500 : kind === 'delete' ? 204 : 200,
    );
    const r = await submitting;
    expect([r.status, r.body.code ?? null]).toEqual(
      rollback ? [201, null] : [409, 'CANCELLATION_ASSIGNMENT_NOT_ACTIVE'],
    );
    expect((await rows()).requests).toHaveLength(rollback ? 1 : 0);
  },
);
it('retained role edit invalidates fresh confirmation but preserves existing OPEN cancellation', async () => {
  const key = randomUUID();
  await post(key).expect(201);
  const token = await lease();
  await request(app.getHttpServer())
    .patch(dutyPath(f))
    .set('Origin', ORIGIN)
    .set('Cookie', f.admin.cookie)
    .set('X-CSRF-Token', f.admin.csrf)
    .set('Expected-Version', '1')
    .set('Edit-Lease-Token', token)
    .send({
      assignments: [{ employeeId: f.mira.employeeId, dutyRole: 'SHIFT_LEAD' }],
    })
    .expect(200);
  await code(post(), 409, 'PLAN_CONCURRENT_MODIFICATION');
  expect((await rows()).requests[0].status).toBe('OPEN');
  await post(key).expect(201);
});
it.each(['FAILED', 'STALE', 'EXPIRED'] as const)(
  'recovers %s reservation with a new fenced attempt',
  async (kind) => {
    const key = randomUUID();
    db.fail = 'need';
    await post(key).expect(500);
    const prior = (await rows()).ledger[0];
    if (kind === 'STALE')
      await pool.query(
        "UPDATE idempotency_records SET state='IN_PROGRESS',claimed_at=clock_timestamp()-interval '10 minutes' WHERE id=$1",
        [prior.id],
      );
    if (kind === 'EXPIRED')
      await pool.query(
        "UPDATE idempotency_records SET created_at=clock_timestamp()-interval '2 days',claimed_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",
        [prior.id],
      );
    await post(key).expect(201);
    const saved = await rows();
    expect(saved.ledger[0].attempt_id).not.toBe(prior.attempt_id);
    expect(saved.requests).toHaveLength(1);
  },
);
it('an old claimant fails its attempt fence before any business write', async () => {
  const key = randomUUID();
  db.fail = 'need';
  await post(key).expect(500);
  const prior = (await rows()).ledger[0];
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { lockAttempt } =
      await import('../src/common/transactions/idempotency-lock.js');
    await c.query(
      "UPDATE idempotency_records SET attempt_id=gen_random_uuid(),state='IN_PROGRESS' WHERE id=$1",
      [prior.id],
    );
    await expect(
      lockAttempt(
        c,
        f.tenant.companyId,
        f.mira.account.accountId,
        'CREATE_CANCELLATION',
        hash(key),
        prior.id,
        prior.attempt_id,
      ),
    ).rejects.toHaveProperty(
      'response.code',
      'IDEMPOTENCY_REQUEST_IN_PROGRESS',
    );
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
  expect((await rows()).requests).toEqual([]);
});

it('reports corrupt existing OPEN/closed pairing as a technical error on fresh create, replay and GET', async () => {
  const key = randomUUID(),
    r = await post(key).expect(201);
  await pool.query(
    "UPDATE replacement_needs SET status='CLOSED' WHERE cancellation_request_id=$1",
    [r.body.id],
  );
  await post().expect(500);
  await post(key).expect(500);
  await get(r.body.id).expect(500);
  expect((await rows()).requests).toHaveLength(1);
});
it('no-op PATCH preserves displayed version and permits cancellation', async () => {
  const token = await lease();
  await request(app.getHttpServer())
    .patch(dutyPath(f))
    .set('Origin', ORIGIN)
    .set('Cookie', f.admin.cookie)
    .set('X-CSRF-Token', f.admin.csrf)
    .set('Expected-Version', '1')
    .set('Edit-Lease-Token', token)
    .send({
      assignments: [{ employeeId: f.mira.employeeId, dutyRole: 'EMPLOYEE' }],
    })
    .expect(200);
  await post().expect(201);
  expect(
    (
      await pool.query('SELECT concurrency_version FROM duties WHERE id=$1', [
        f.dutyId,
      ])
    ).rows[0].concurrency_version,
  ).toBe('1');
});
it('own assignment establishes visibility without requiring an existing project-month link', async () => {
  await pool.query(
    'DELETE FROM project_assignments WHERE company_id=$1 AND employee_id=$2',
    [f.tenant.companyId, f.mira.employeeId],
  );
  await post().expect(201);
});
it('an expired completed technical key cannot bypass the OPEN business uniqueness', async () => {
  const key = randomUUID();
  await post(key).expect(201);
  await pool.query(
    "UPDATE idempotency_records SET created_at=clock_timestamp()-interval '3 days',claimed_at=clock_timestamp()-interval '3 days',completed_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE company_id=$1",
    [f.tenant.companyId],
  );
  await code(post(key), 409, 'CANCELLATION_ALREADY_EXISTS');
  expect((await rows()).requests).toHaveLength(1);
});
