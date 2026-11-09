/**
 * SP-20 atomic replacement selection — real NestJS HTTP, real PostgreSQL 17.
 * Race guarantees use real concurrent requests and real row locks (no mocked
 * database clients). Rollback and lost-acknowledgement cases inject faults at a
 * real database boundary. Synthetic data only.
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DatabaseService } from '../src/database/database.service.js';
import { bootEmployeesApp, RecordingDelivery, ORIGIN } from './helpers/employees-test-app.js';
import {
  createSyntheticAccount,
  createSyntheticProject,
  createSyntheticSession,
  createSyntheticTenant,
  openLocalTestPool,
  realSessionService,
  removeSyntheticTenants,
  type SyntheticSession,
  type TestPool,
} from './helpers/synthetic-tenants.js';
import {
  createStaff,
  insertDuty,
  insertMembership,
  insertPlan,
  insertProjectAssignment,
  insertShiftConfiguration,
  planningState,
  STANDARD_SHIFTS,
} from './helpers/planning-fixtures.js';

const MONTH = '2027-01-01';
const DAY = '2027-01-20';
const NOW = '2026-12-15T12:00:00Z';

/** Fault injection at a real database boundary, plus lost-acknowledgement after COMPLETED. */
class ObservedDatabase extends DatabaseService {
  failOnce?: string;
  lostAckOnce = false;
  override async withTransaction<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    let completed = false;
    const result = await super.withTransaction((c) =>
      work(
        new Proxy(c, {
          get: (target, key) => {
            if (key === 'query')
              return async (sql: string, values?: unknown[]) => {
                if (this.failOnce && sql.includes(this.failOnce)) {
                  this.failOnce = undefined;
                  throw new Error('synthetic failure injected after the mutation boundary');
                }
                if (sql.includes("SET state='COMPLETED'")) completed = true;
                return target.query(sql, values);
              };
            const v: unknown = Reflect.get(target, key);
            return typeof v === 'function' ? v.bind(target) : v;
          },
        }),
      ),
    );
    if (completed && this.lostAckOnce) {
      this.lostAckOnce = false;
      throw new Error('synthetic lost commit acknowledgement');
    }
    return result;
  }
}

let pool: TestPool;
let app: INestApplication<App>;
let db: ObservedDatabase;
const companies: string[] = [];

async function boot() {
  await app?.close();
  db = new ObservedDatabase();
  await db.isReady();
  app = await bootEmployeesApp(new RecordingDelivery(), {
    database: db,
    clock: () => new Date(NOW),
  });
  await app.listen(0, '127.0.0.1');
}

type Fixture = Awaited<ReturnType<typeof buildFixture>>;

/** Published plan, original Mira on the duty, two candidates who offer, real cancellation API. */
async function buildFixture() {
  // A failure armed by a previous test must not leak into this fixture.
  db.failOnce = undefined;
  db.lostAckOnce = false;
  const tenant = await createSyntheticTenant(pool, 'SP20 selection');
  companies.push(tenant.companyId);
  const foreign = await createSyntheticTenant(pool, 'SP20 foreign');
  companies.push(foreign.companyId);
  const sessions = realSessionService(pool);
  const admin = await createSyntheticSession(sessions, tenant.admin);
  const admin2 = await createSyntheticSession(
    sessions,
    await createSyntheticAccount(pool, tenant.companyId, 'COMPANY_ADMIN'),
  );
  const foreignAdmin = await createSyntheticSession(sessions, foreign.admin);
  const project = await createSyntheticProject(pool, tenant.companyId, 'SP20 project');
  await insertShiftConfiguration(pool, tenant.companyId, project.projectId, MONTH, STANDARD_SHIFTS);
  const mira = await createStaff(pool, tenant.companyId);
  const jonas = await createStaff(pool, tenant.companyId);
  const lena = await createStaff(pool, tenant.companyId);
  for (const s of [mira, jonas, lena])
    await insertProjectAssignment(pool, tenant.companyId, s.employeeId, project.projectId, MONTH);
  const planId = await insertPlan(pool, tenant.companyId, project.projectId, MONTH, {
    byAccountId: tenant.admin.accountId,
  });
  const dutyId = await insertDuty(pool, {
    companyId: tenant.companyId,
    projectId: project.projectId,
    planId,
    month: MONTH,
    dutyDate: DAY,
    startsAt: `${DAY}T05:00:00Z`,
    endsAt: `${DAY}T17:00:00Z`,
  });
  const membershipId = await insertMembership(pool, tenant.companyId, dutyId, mira.employeeId);
  const miraS = await createSyntheticSession(sessions, mira.account);
  const jonasS = await createSyntheticSession(sessions, jonas.account);
  const lenaS = await createSyntheticSession(sessions, lena.account);

  const cancel = await request(app.getHttpServer())
    .post('/api/v1/cancellation-requests')
    .set('Origin', ORIGIN)
    .set('Cookie', miraS.cookie)
    .set('X-CSRF-Token', miraS.csrf)
    .set('Expected-Version', '1')
    .set('Idempotency-Key', randomUUID())
    .send({ assignmentId: membershipId });
  if (cancel.status !== 201) throw new Error(`fixture cancellation failed: ${cancel.status}`);
  const caseId: string = cancel.body.id;
  const needId: string = cancel.body.replacementNeed.id;

  const offer = (s: SyntheticSession) =>
    request(app.getHttpServer())
      .post(`/api/v1/replacement-needs/${needId}/offers`)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookie)
      .set('X-CSRF-Token', s.csrf)
      .set('Idempotency-Key', randomUUID());
  const offerJonas = await offer(jonasS);
  const offerLena = await offer(lenaS);
  if (offerJonas.status !== 201 || offerLena.status !== 201)
    throw new Error(`fixture offers failed: ${offerJonas.status}/${offerLena.status}`);

  return {
    companyId: tenant.companyId,
    foreignCompanyId: foreign.companyId,
    admin,
    admin2,
    adminAccountId: tenant.admin.accountId,
    foreignAdmin,
    miraS,
    jonasS,
    lenaS,
    miraId: mira.employeeId,
    jonasId: jonas.employeeId,
    lenaId: lena.employeeId,
    projectId: project.projectId,
    planId,
    dutyId,
    membershipId,
    caseId,
    needId,
    offerJonasId: offerJonas.body.id as string,
    offerLenaId: offerLena.body.id as string,
  };
}

const select = (
  f: Fixture,
  s: SyntheticSession | null,
  body: unknown,
  options: { key?: string | null; version?: string | null; needId?: string } = {},
) => {
  const r = request(app.getHttpServer())
    .post(`/api/v1/replacement-needs/${options.needId ?? f.needId}/selection`)
    .set('Origin', ORIGIN);
  if (s) r.set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf);
  const key = options.key === undefined ? randomUUID() : options.key;
  if (key !== null) r.set('Idempotency-Key', key);
  const version = options.version === undefined ? '1' : options.version;
  if (version !== null) r.set('Expected-Version', version);
  return r.send(body as object);
};

/** Everything a selection could change for the tenant, plus the case rows. */
async function snapshot(f: Fixture) {
  const offers = (
    await pool.query(
      'SELECT id, need_id, employee_id, status, decided_at FROM replacement_offers WHERE company_id = $1 ORDER BY id',
      [f.companyId],
    )
  ).rows;
  const cancellation = (
    await pool.query('SELECT id, status, decided_at FROM cancellation_requests WHERE company_id = $1 ORDER BY id', [f.companyId])
  ).rows;
  const need = (
    await pool.query('SELECT id, status, resolved_at FROM replacement_needs WHERE company_id = $1 ORDER BY id', [f.companyId])
  ).rows;
  const audit = (await pool.query('SELECT action FROM audit_event WHERE company_id = $1 ORDER BY id', [f.companyId])).rows;
  const idempotency = (
    await pool.query(
      "SELECT key_hash, state, attempt_id FROM idempotency_records WHERE company_id = $1 AND operation = 'DECIDE_REPLACEMENT_SELECTION' ORDER BY id",
      [f.companyId],
    )
  ).rows;
  return {
    planning: await planningState(pool, f.companyId),
    offers,
    cancellation,
    need,
    audit,
    idempotency,
  };
}

/** A refused command leaves every business table unchanged; its durable idempotency record may only be FAILED. */
async function expectNoBusinessWrite(f: Fixture, before: Awaited<ReturnType<typeof snapshot>>) {
  const after = await snapshot(f);
  expect({ ...after, idempotency: undefined }).toEqual({ ...before, idempotency: undefined });
  expect(after.idempotency.every((row) => row.state !== 'COMPLETED')).toBe(true);
}

async function selectionRows(f: Fixture) {
  const replacement = (
    await pool.query(
      "SELECT id, employee_id, duty_function, state, replacement_offer_id FROM plan_assignments WHERE company_id = $1 AND source = 'REPLACEMENT' ORDER BY id",
      [f.companyId],
    )
  ).rows;
  return { replacement };
}

async function acquireLease(f: Fixture, s: SyntheticSession) {
  const r = await request(app.getHttpServer())
    .post(`/api/v1/monthly-plans/${f.planId}/entries/${f.dutyId}/edit-lease`)
    .set('Origin', ORIGIN)
    .set('Cookie', s.cookie)
    .set('X-CSRF-Token', s.csrf);
  if (r.status !== 200) throw new Error(`lease acquire failed: ${r.status}`);
  return r.body.leaseToken as string;
}

// assertTrustedOrigin fails closed with 503 SERVICE_UNAVAILABLE when APP_ORIGIN is not an https origin.
let previousAppOrigin: string | undefined;

beforeAll(async () => {
  previousAppOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
  pool = openLocalTestPool(6);
  await boot();
});

afterAll(async () => {
  await app?.close();
  await removeSyntheticTenants(pool, companies);
  await pool.end();
  if (previousAppOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousAppOrigin;
});

describe('SP-20 fixture (arrange) — must pass before any selection test is meaningful', () => {
  it('builds a published plan, one OPEN cancellation, one OPEN need and two OPEN offers through real APIs', async () => {
    const f = await buildFixture();
    const s = await snapshot(f);
    expect(s.cancellation).toEqual([expect.objectContaining({ id: f.caseId, status: 'OPEN' })]);
    expect(s.need).toEqual([expect.objectContaining({ id: f.needId, status: 'OPEN' })]);
    expect(s.offers.map((o) => o.status).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(['OPEN', 'OPEN']);
  });
});

describe('SP-20 happy path', () => {
  it('approves the cancellation, resolves the need, selects one offer, rejects the rest, and moves the membership', async () => {
    const f = await buildFixture();
    const before = await snapshot(f);
    const res = await select(f, f.admin, { offerId: f.offerJonasId });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        needId: f.needId,
        cancellationRequestId: f.caseId,
        status: { cancellation: 'APPROVED', need: 'RESOLVED' },
        needVersion: 2,
        selectedOffer: expect.objectContaining({ id: f.offerJonasId, status: 'SELECTED' }),
        otherOffers: [expect.objectContaining({ id: f.offerLenaId, status: 'NOT_SELECTED' })],
        originalAssignment: expect.objectContaining({ id: f.membershipId, state: 'REMOVED' }),
        duty: expect.objectContaining({ id: f.dutyId, concurrencyVersion: 2 }),
      }),
    );
    const after = await snapshot(f);
    expect(after.cancellation).toEqual([expect.objectContaining({ id: f.caseId, status: 'APPROVED' })]);
    expect(after.need).toEqual([expect.objectContaining({ id: f.needId, status: 'RESOLVED' })]);
    const version = (await pool.query('SELECT concurrency_version::int AS v FROM replacement_needs WHERE id = $1', [f.needId])).rows[0].v;
    expect(version).toBe(2);
    const rows = await selectionRows(f);
    expect(rows.replacement).toEqual([
      expect.objectContaining({ employee_id: f.jonasId, duty_function: 'MITARBEITER', state: 'ACTIVE', replacement_offer_id: f.offerJonasId }),
    ]);
    // Historical row preserved: the original membership still exists, closed, not deleted.
    const original = await pool.query('SELECT id, state, removed_at FROM plan_assignments WHERE id = $1', [f.membershipId]);
    expect(original.rows).toEqual([expect.objectContaining({ id: f.membershipId, state: 'REMOVED' })]);
    expect(original.rows[0].removed_at).not.toBeNull();
    expect(before.audit.length).toBeLessThan(after.audit.length);
  });
});

describe('SP-20 concurrency (real PostgreSQL row locks)', () => {
  it('two admins selecting different offers for one need: exactly one succeeds, the other gets a conflict', async () => {
    const f = await buildFixture();
    const [a, b] = await Promise.all([
      select(f, f.admin, { offerId: f.offerJonasId }),
      select(f, f.admin2, { offerId: f.offerLenaId }),
    ]);
    expect([a.status, b.status].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.code).toBe('CANCELLATION_ALREADY_RESOLVED');
    const selected = (await pool.query("SELECT id FROM replacement_offers WHERE company_id = $1 AND status = 'SELECTED'", [f.companyId])).rows;
    expect(selected).toHaveLength(1);
    expect((await selectionRows(f)).replacement).toHaveLength(1);
  });

  it('two admins selecting the same offer with different keys: exactly one succeeds', async () => {
    const f = await buildFixture();
    const [a, b] = await Promise.all([
      select(f, f.admin, { offerId: f.offerJonasId }),
      select(f, f.admin2, { offerId: f.offerJonasId }),
    ]);
    expect([a.status, b.status].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual([200, 409]);
    expect((await selectionRows(f)).replacement).toHaveLength(1);
  });

  it('cancellation withdrawn while selection is in progress: never APPROVED and WITHDRAWN together', async () => {
    const f = await buildFixture();
    const withdraw = request(app.getHttpServer())
      .post(`/api/v1/cancellation-requests/${f.caseId}/withdraw`)
      .set('Origin', ORIGIN)
      .set('Cookie', f.miraS.cookie)
      .set('X-CSRF-Token', f.miraS.csrf);
    const [w, s] = await Promise.all([withdraw, select(f, f.admin, { offerId: f.offerJonasId })]);
    const cancellation = (await pool.query('SELECT status FROM cancellation_requests WHERE id = $1', [f.caseId])).rows[0].status;
    const replacements = (await selectionRows(f)).replacement.length;
    if (cancellation === 'APPROVED') {
      expect(s.status).toBe(200);
      expect(w.status).toBe(409);
      expect(replacements).toBe(1);
    } else {
      expect(cancellation).toBe('WITHDRAWN');
      expect(s.status).toBe(409);
      expect(replacements).toBe(0);
    }
  });

  it('duty removed while selection is in progress: exactly one outcome is committed', async () => {
    const f = await buildFixture();
    const token = await acquireLease(f, f.admin);
    const removal = request(app.getHttpServer())
      .delete(`/api/v1/monthly-plans/${f.planId}/entries/${f.dutyId}`)
      .set('Origin', ORIGIN)
      .set('Cookie', f.admin.cookie)
      .set('X-CSRF-Token', f.admin.csrf)
      .set('Expected-Version', '1')
      .set('Edit-Lease-Token', token);
    const [r, s] = await Promise.all([removal, select(f, f.admin2, { offerId: f.offerJonasId })]);
    const duty = (await pool.query('SELECT removed_at FROM duties WHERE id = $1', [f.dutyId])).rows[0];
    if (duty.removed_at === null) {
      expect(s.status).toBe(200);
      expect(r.status).toBe(409); // D-8: a resolved duty cannot be removed
    } else {
      expect(r.status).toBe(204); // the existing duty-removal route answers 204 No Content
      expect(s.status).toBe(409);
      expect((await selectionRows(f)).replacement).toHaveLength(0);
    }
  });

  it('a live lease held by another actor refuses selection at once, without waiting for expiry', async () => {
    const f = await buildFixture();
    await acquireLease(f, f.admin2);
    const started = Date.now();
    const res = await select(f, f.admin, { offerId: f.offerJonasId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RESOURCE_EDIT_LOCKED');
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await selectionRows(f)).replacement).toHaveLength(0);
  });

  it('employee deactivation and offer creation serialize on the candidate employee row (G-1 regression)', async () => {
    const f = await buildFixture();
    const ole = await createStaff(pool, f.companyId);
    await insertProjectAssignment(pool, f.companyId, ole.employeeId, f.projectId, MONTH);
    const oleS = await createSyntheticSession(realSessionService(pool), ole.account);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Deactivation writer: row lock on the employee, held until commit.
      await client.query('SELECT id FROM employees WHERE company_id = $1 AND id = $2 FOR NO KEY UPDATE', [f.companyId, ole.employeeId]);
      const pending = request(app.getHttpServer())
        .post(`/api/v1/replacement-needs/${f.needId}/offers`)
        .set('Origin', ORIGIN)
        .set('Cookie', oleS.cookie)
        .set('X-CSRF-Token', oleS.csrf)
        .set('Idempotency-Key', randomUUID());
      const response = pending.then((r) => r);
      // Observe that the offer request is really blocked on a row lock (not merely slow).
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        const waiting = (await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()")).rows[0].n;
        blocked = waiting > 0;
        if (!blocked) await new Promise((r) => setTimeout(r, 50));
      }
      expect(blocked).toBe(true);
      await client.query(
        "UPDATE employees SET status = 'DEACTIVATED', deactivated_at = clock_timestamp() WHERE company_id = $1 AND id = $2",
        [f.companyId, ole.employeeId],
      );
      await client.query('COMMIT');
      const res = await response;
      // Serialized after deactivation: the candidate is no longer an active employee.
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ACTION_FORBIDDEN');
      const offers = (await pool.query('SELECT count(*)::int AS n FROM replacement_offers WHERE company_id = $1 AND employee_id = $2', [f.companyId, ole.employeeId])).rows[0].n;
      expect(offers).toBe(0);
    } finally {
      client.release();
    }
  });
});

describe('SP-20 idempotency', () => {
  it('a repeated request with the same Idempotency-Key returns the same result and makes no second decision', async () => {
    const f = await buildFixture();
    const key = randomUUID();
    const first = await select(f, f.admin, { offerId: f.offerJonasId }, { key });
    const beforeReplay = await snapshot(f);
    const second = await select(f, f.admin, { offerId: f.offerJonasId }, { key });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    const afterReplay = await snapshot(f);
    expect(afterReplay.planning).toEqual(beforeReplay.planning);
    expect(afterReplay.audit).toEqual(beforeReplay.audit);
    expect(afterReplay.offers).toEqual(beforeReplay.offers);
  });

  it('the same key with a different payload is refused and writes nothing', async () => {
    const f = await buildFixture();
    const key = randomUUID();
    expect((await select(f, f.admin, { offerId: f.offerJonasId }, { key })).status).toBe(200);
    const before = await snapshot(f);
    const res = await select(f, f.admin, { offerId: f.offerLenaId }, { key });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST');
    expect(await snapshot(f)).toEqual(before);
  });

  it('a response lost after the database commit is recovered by replaying the same key', async () => {
    const f = await buildFixture();
    const key = randomUUID();
    db.lostAckOnce = true;
    const lost = await select(f, f.admin, { offerId: f.offerJonasId }, { key });
    expect(lost.status).not.toBe(200);
    expect((await selectionRows(f)).replacement).toHaveLength(1);
    const retry = await select(f, f.admin, { offerId: f.offerJonasId }, { key });
    expect(retry.status).toBe(200);
    expect(retry.headers['idempotency-replayed']).toBe('true');
    expect((await selectionRows(f)).replacement).toHaveLength(1);
  });
});

describe('SP-20 eligibility and authorization', () => {
  it('a candidate who became unavailable before selection is refused without any write', async () => {
    const f = await buildFixture();
    // Overlapping duty in a second plan (live-slot uniqueness is per plan).
    const otherProject = await createSyntheticProject(pool, f.companyId, 'SP20 other project');
    const otherPlan = await insertPlan(pool, f.companyId, otherProject.projectId, MONTH);
    const other = await insertDuty(pool, {
      companyId: f.companyId,
      projectId: otherProject.projectId,
      planId: otherPlan,
      month: MONTH,
      dutyDate: DAY,
      startsAt: `${DAY}T05:00:00Z`,
      endsAt: `${DAY}T17:00:00Z`,
    });
    await insertMembership(pool, f.companyId, other, f.jonasId);
    const before = await snapshot(f);
    const res = await select(f, f.admin, { offerId: f.offerJonasId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REPLACEMENT_CANDIDATE_UNAVAILABLE');
    await expectNoBusinessWrite(f, before);
  });

  it('a SCHICHTLEITER original is refused fail-closed, because no qualification rule exists (A1)', async () => {
    const f = await buildFixture();
    await pool.query("UPDATE plan_assignments SET duty_function = 'SCHICHTLEITER' WHERE id = $1", [f.membershipId]);
    const before = await snapshot(f);
    const res = await select(f, f.admin, { offerId: f.offerJonasId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REPLACEMENT_CANDIDATE_INELIGIBLE');
    await expectNoBusinessWrite(f, before);
  });

  it('an employee cannot select; a missing session is unauthenticated; a missing Origin is refused', async () => {
    const f = await buildFixture();
    const before = await snapshot(f);
    expect((await select(f, f.jonasS, { offerId: f.offerJonasId })).status).toBe(403);
    expect((await select(f, null, { offerId: f.offerJonasId })).status).toBe(401);
    const noOrigin = await request(app.getHttpServer())
      .post(`/api/v1/replacement-needs/${f.needId}/selection`)
      .set('Cookie', f.admin.cookie)
      .set('X-CSRF-Token', f.admin.csrf)
      .set('Idempotency-Key', randomUUID())
      .set('Expected-Version', '1')
      .send({ offerId: f.offerJonasId });
    expect(noOrigin.status).toBe(403);
    expect(await snapshot(f)).toEqual(before);
  });

  it('another company cannot see or select this need or offer, even after the owner has resolved it', async () => {
    const f = await buildFixture();
    // Positive control: the owning admin's valid request succeeds, so the 404s below are real concealment.
    expect((await select(f, f.admin, { offerId: f.offerJonasId })).status).toBe(200);
    const before = await snapshot(f);
    const foreign = await select(f, f.foreignAdmin, { offerId: f.offerLenaId });
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe('RESOURCE_NOT_FOUND');
    expect(await snapshot(f)).toEqual(before);
  });

  it('an offer that does not belong to this need is concealed (404), not reported as a state conflict', async () => {
    const f = await buildFixture();
    // Positive control: the owning admin's valid request succeeds first.
    expect((await select(f, f.admin, { offerId: f.offerJonasId })).status).toBe(200);
    const before = await snapshot(f);
    const res = await select(f, f.admin, { offerId: randomUUID() });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
    expect(await snapshot(f)).toEqual(before);
  });
});

describe('SP-20 request validation and version precedence', () => {
  it('rejects a missing Idempotency-Key, a missing Expected-Version, a null offerId and an unknown field', async () => {
    const f = await buildFixture();
    expect((await select(f, f.admin, { offerId: f.offerJonasId }, { key: null })).status).toBe(400);
    const noVersion = await select(f, f.admin, { offerId: f.offerJonasId }, { version: null });
    expect(noVersion.body.code).toBe('EXPECTED_VERSION_REQUIRED');
    expect((await select(f, f.admin, { offerId: null })).status).toBe(400);
    expect((await select(f, f.admin, { offerId: f.offerJonasId, extra: true })).status).toBe(400);
  });

  it('a stale Expected-Version is refused with PLAN_CONCURRENT_MODIFICATION (D-7)', async () => {
    const f = await buildFixture();
    const res = await select(f, f.admin, { offerId: f.offerJonasId }, { version: '2' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PLAN_CONCURRENT_MODIFICATION');
  });

  it('an already resolved case reports the resolution before a version mismatch (V-10 precedence)', async () => {
    const f = await buildFixture();
    expect((await select(f, f.admin, { offerId: f.offerJonasId })).status).toBe(200);
    const res = await select(f, f.admin2, { offerId: f.offerLenaId }, { version: '1' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CANCELLATION_ALREADY_RESOLVED');
  });
});

describe('SP-20 failure injection and rollback (exact)', () => {
  const boundaries = [
    'UPDATE public.duties',
    'UPDATE public.plan_assignments',
    'INSERT INTO public.plan_assignments',
    'UPDATE public.replacement_offers',
    'UPDATE public.replacement_needs',
    'UPDATE public.cancellation_requests',
    'INSERT INTO audit_event',
    "SET state='COMPLETED'",
  ];
  it.each(boundaries)('a failure at %s leaves every table unchanged and a retry succeeds once', async (boundary) => {
    const f = await buildFixture();
    const before = await snapshot(f);
    const key = randomUUID();
    db.failOnce = boundary;
    const failed = await select(f, f.admin, { offerId: f.offerJonasId }, { key });
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(await snapshot(f)).toEqual({
      ...before,
      idempotency: expect.any(Array),
    });
    const retry = await select(f, f.admin, { offerId: f.offerJonasId }, { key: randomUUID() });
    expect(retry.status).toBe(200);
    expect((await selectionRows(f)).replacement).toHaveLength(1);
  });
});

describe('SP-20 historical preservation and lifetime uniqueness', () => {
  it('a second REPLACEMENT membership for the same offer is refused, even after the first was historically removed', async () => {
    const f = await buildFixture();
    expect((await select(f, f.admin, { offerId: f.offerJonasId })).status).toBe(200);
    const replacement = (await selectionRows(f)).replacement[0];
    await pool.query("UPDATE plan_assignments SET state = 'REMOVED', removed_at = clock_timestamp() WHERE id = $1", [replacement.id]);
    await expect(
      pool.query(
        `INSERT INTO plan_assignments (company_id, duty_id, employee_id, duty_function, source, state, replacement_offer_id)
         VALUES ($1, $2, $3, 'MITARBEITER', 'REPLACEMENT', 'ACTIVE', $4)`,
        [f.companyId, f.dutyId, f.jonasId, f.offerJonasId],
      ),
    ).rejects.toThrow();
    const remaining = await pool.query('SELECT count(*)::int AS n FROM plan_assignments WHERE replacement_offer_id = $1', [f.offerJonasId]);
    expect(remaining.rows[0].n).toBe(1);
  });
});

describe('SP-20 D-8 protection of a resolved duty', () => {
  it('a duty with a resolved replacement cannot be removed', async () => {
    const f = await buildFixture();
    expect((await select(f, f.admin, { offerId: f.offerJonasId })).status).toBe(200);
    const token = await acquireLease(f, f.admin);
    const res = await request(app.getHttpServer())
      .delete(`/api/v1/monthly-plans/${f.planId}/entries/${f.dutyId}`)
      .set('Origin', ORIGIN)
      .set('Cookie', f.admin.cookie)
      .set('X-CSRF-Token', f.admin.csrf)
      .set('Expected-Version', '2')
      .set('Edit-Lease-Token', token);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CANCELLATION_PLAN_CHANGED');
  });
});

describe('SP-20 administrative read contract', () => {
  it('the admin case read exposes the need version and selected-offer state', async () => {
    const f = await buildFixture();
    const before = await request(app.getHttpServer()).get(`/api/v1/replacement-needs/${f.needId}`).set('Cookie', f.admin.cookie);
    expect(before.status).toBe(200);
    expect(before.body).toEqual(expect.objectContaining({ concurrencyVersion: 1, selectedOfferId: null }));
    expect((await select(f, f.admin, { offerId: f.offerJonasId })).status).toBe(200);
    const after = await request(app.getHttpServer()).get(`/api/v1/replacement-needs/${f.needId}`).set('Cookie', f.admin.cookie);
    expect(after.body).toEqual(expect.objectContaining({ concurrencyVersion: 2, selectedOfferId: f.offerJonasId }));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// PR #116 review remediation: exact audit contract, employee-facing /me integration, deterministic lock barriers.
// ---------------------------------------------------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REMOVED_AT_SQL = `to_char(removed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** audit_event.id is a random UUID and occurred_at is the transaction start, so rows are identified by a baseline set. */
async function auditBaseline(companyId: string): Promise<string[]> {
  return (await pool.query<{ id: string }>('SELECT id FROM audit_event WHERE company_id = $1', [companyId])).rows.map((r) => r.id);
}

/** Rows written after the baseline, ordered by action (every action of one selection is distinct). */
async function auditSince(companyId: string, baseline: string[]) {
  const rows = (
    await pool.query<{
      action: string;
      resource_type: string;
      resource_id: string;
      actor_account_id: string;
      old_values: unknown;
      new_values: unknown;
      correlation_id: string;
    }>(
      'SELECT action, resource_type, resource_id, actor_account_id, old_values, new_values, correlation_id FROM audit_event WHERE company_id = $1 AND NOT (id = ANY($2::uuid[]))',
      [companyId, baseline],
    )
  ).rows;
  return rows.sort((a, b) => (a.action < b.action ? -1 : a.action > b.action ? 1 : 0));
}

async function replacementMembershipId(f: Fixture, offerId: string): Promise<string> {
  return (
    await pool.query<{ id: string }>(
      "SELECT id FROM plan_assignments WHERE company_id = $1 AND source = 'REPLACEMENT' AND replacement_offer_id = $2",
      [f.companyId, offerId],
    )
  ).rows[0].id;
}

async function removedAtOf(membershipId: string): Promise<string> {
  return (await pool.query<{ v: string }>(`SELECT ${REMOVED_AT_SQL} AS v FROM plan_assignments WHERE id = $1`, [membershipId])).rows[0].v;
}

/** Waits (polls pg_blocking_pids live) until some backend is blocked by the given blocker and returns that waiter. */
async function waitForLockWaiter(blockerPid: number, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const waiters = (
      await pool.query<{ pid: number; blockers: number[]; wait_event_type: string; wait_event: string; query: string }>(
        `SELECT pid, pg_blocking_pids(pid) AS blockers, wait_event_type, wait_event, left(query, 90) AS query
         FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      )
    ).rows;
    const hit = waiters.find((w) => w.blockers.includes(blockerPid));
    if (hit) return hit;
    if (Date.now() > deadline) {
      const observed = waiters.map((w) => `pid ${w.pid} waits(${w.wait_event}) on [${w.blockers.join(',')}]: ${w.query}`);
      throw new Error(`no lock waiter observed behind pid ${blockerPid}; lock waiters: ${JSON.stringify(observed)}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function backendPid(client: PoolClient): Promise<number> {
  return Number((await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid);
}

/**
 * The seven rows of one selection with one losing offer, in the action order that auditSince returns.
 * CANCELLATION_APPROVED, REPLACEMENT_NEED_RESOLVED, REPLACEMENT_OFFER_SELECTED and REPLACEMENT_OFFER_NOT_SELECTED are
 * PROPOSED under ADR-0004 supplement A8 and are PENDING PRODUCT OWNER APPROVAL. These assertions pin what the code
 * emits; they do not record an approval. The DUTY_* rows use the already approved SP-12 contract.
 */
const SELECTED_ACTIONS = [
  'CANCELLATION_APPROVED',
  'DUTY_MEMBERSHIP_ADDED',
  'DUTY_MEMBERSHIP_REMOVED',
  'DUTY_UPDATED',
  'REPLACEMENT_NEED_RESOLVED',
  'REPLACEMENT_OFFER_NOT_SELECTED',
  'REPLACEMENT_OFFER_SELECTED',
];

describe('SP-20 audit contract (exact, real PostgreSQL)', () => {
  it('a successful selection writes exactly the seven rows (A8 actions pending PO approval), with exact action, resource IDs, old and new values and one correlation ID', async () => {
    const f = await buildFixture();
    const mark = await auditBaseline(f.companyId);
    const res = await select(f, f.admin, { offerId: f.offerJonasId });
    expect(res.status).toBe(200);
    const replacementId = await replacementMembershipId(f, f.offerJonasId);
    const rows = await auditSince(f.companyId, mark);
    expect(rows.map((r) => r.action)).toEqual(SELECTED_ACTIONS);
    const correlation = rows[0].correlation_id;
    expect(rows).toHaveLength(7);
    expect(correlation).toMatch(UUID_RE);
    expect(new Set(rows.map((r) => r.correlation_id))).toEqual(new Set([correlation]));
    expect(new Set(rows.map((r) => r.actor_account_id))).toEqual(new Set([f.adminAccountId]));
    const dutyOld = { planId: f.planId, dutyDate: DAY, shiftKind: 'DAY', startsAt: `${DAY}T05:00:00Z`, endsAt: `${DAY}T17:00:00Z`, version: 1 };
    const removedAt = await removedAtOf(f.membershipId);
    expect(removedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    const actual = rows.map((r) => ({
      action: r.action,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      oldValues: r.old_values,
      newValues: r.new_values,
    }));
    // Exact per-row equality; the rows are unordered in the table (see auditSince), so match them by action.
    expect(actual).toEqual(expect.arrayContaining([
      { action: 'CANCELLATION_APPROVED', resourceType: 'CANCELLATION_REQUEST', resourceId: f.caseId, oldValues: { status: 'OPEN' }, newValues: { status: 'APPROVED' } },
      { action: 'REPLACEMENT_NEED_RESOLVED', resourceType: 'REPLACEMENT_NEED', resourceId: f.needId, oldValues: { status: 'OPEN' }, newValues: { status: 'RESOLVED', selectedOfferId: f.offerJonasId } },
      { action: 'REPLACEMENT_OFFER_SELECTED', resourceType: 'REPLACEMENT_OFFER', resourceId: f.offerJonasId, oldValues: { status: 'OPEN' }, newValues: { status: 'SELECTED' } },
      { action: 'REPLACEMENT_OFFER_NOT_SELECTED', resourceType: 'REPLACEMENT_OFFER', resourceId: f.offerLenaId, oldValues: { status: 'OPEN' }, newValues: { status: 'NOT_SELECTED' } },
      { action: 'DUTY_UPDATED', resourceType: 'DUTY', resourceId: f.dutyId, oldValues: dutyOld, newValues: { ...dutyOld, version: 2 } },
      {
        action: 'DUTY_MEMBERSHIP_REMOVED',
        resourceType: 'DUTY_ASSIGNMENT',
        resourceId: f.membershipId,
        oldValues: { dutyId: f.dutyId, employeeId: f.miraId, dutyRole: 'EMPLOYEE', source: 'NORMAL' },
        newValues: { dutyId: f.dutyId, state: 'REMOVED', removedAt },
      },
      {
        action: 'DUTY_MEMBERSHIP_ADDED',
        resourceType: 'DUTY_ASSIGNMENT',
        resourceId: replacementId,
        oldValues: null,
        newValues: { dutyId: f.dutyId, employeeId: f.jonasId, dutyRole: 'EMPLOYEE', source: 'REPLACEMENT' },
      },
    ]));
  });
});

describe('SP-20 employee-facing plan changes (committed /me integration)', () => {
  const planPath = `/api/v1/me/monthly-plans?monthStart=${MONTH}`;
  const dutiesOf = async (s: SyntheticSession) => {
    const res = await request(app.getHttpServer()).get(planPath).set('Cookie', s.cookie);
    expect(res.status).toBe(200);
    return res.body.items[0].duties as Array<Record<string, unknown>>;
  };

  it('the original employee loses the duty, the replacement gains it, the rejected candidate gains nothing, and the published plan stays consistent', async () => {
    const f = await buildFixture();
    expect(await dutiesOf(f.miraS)).toEqual([expect.objectContaining({ dutyId: f.dutyId, assignmentId: f.membershipId, version: 1 })]);
    expect(await dutiesOf(f.jonasS)).toEqual([]);
    expect(await dutiesOf(f.lenaS)).toEqual([]);

    expect((await select(f, f.admin, { offerId: f.offerJonasId })).status).toBe(200);
    const replacementId = await replacementMembershipId(f, f.offerJonasId);

    expect(await dutiesOf(f.miraS)).toEqual([]);
    expect(await dutiesOf(f.jonasS)).toEqual([
      expect.objectContaining({ dutyId: f.dutyId, assignmentId: replacementId, version: 2, dutyRole: 'EMPLOYEE', dutyDate: DAY, shiftKind: 'DAY' }),
    ]);
    expect(await dutiesOf(f.lenaS)).toEqual([]);

    const plan = await request(app.getHttpServer()).get(`/api/v1/monthly-plans/${f.planId}`).set('Cookie', f.admin.cookie);
    expect(plan.status).toBe(200);
    expect(plan.body).toEqual(expect.objectContaining({ id: f.planId, status: 'PUBLISHED' }));
    const members = (
      await pool.query<{ id: string; employee_id: string; state: string; source: string }>(
        'SELECT id, employee_id, state, source FROM plan_assignments WHERE company_id = $1 AND duty_id = $2 ORDER BY id',
        [f.companyId, f.dutyId],
      )
    ).rows;
    expect(members.filter((m) => m.state === 'ACTIVE')).toEqual([
      expect.objectContaining({ id: replacementId, employee_id: f.jonasId, source: 'REPLACEMENT' }),
    ]);
    expect(members.filter((m) => m.state === 'REMOVED')).toEqual([
      expect.objectContaining({ id: f.membershipId, employee_id: f.miraId, source: 'NORMAL' }),
    ]);
    expect((await pool.query('SELECT concurrency_version::int AS v FROM duties WHERE id = $1', [f.dutyId])).rows[0].v).toBe(2);
  });
});

describe('SP-20 deterministic lock barrier (real PostgreSQL, two administrators)', () => {
  /**
   * The test holds the duty row lock on its own connection, so the first selection is parked at a known lock.
   * The second selection then queues behind the first one (pg_blocking_pids), and the first is released.
   */
  async function parkFirstSelection(f: Fixture) {
    const holder = await pool.connect();
    let held = true;
    const release = async () => {
      if (held) {
        held = false;
        await holder.query('COMMIT');
      }
    };
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM public.duties WHERE company_id = $1 AND id = $2 FOR UPDATE', [f.companyId, f.dutyId]);
    const holderPid = await backendPid(holder);
    // supertest requests are lazy thenables; Promise.resolve starts each HTTP request now, not when it is awaited.
    const first = Promise.resolve(select(f, f.admin, { offerId: f.offerJonasId }));
    const firstWaiter = await waitForLockWaiter(holderPid);
    const second = Promise.resolve(select(f, f.admin2, { offerId: f.offerLenaId }));
    const secondWaiter = await waitForLockWaiter(firstWaiter.pid);
    return { holder, holderPid, release, first, second, firstWaiter, secondWaiter };
  }

  it('the second administrator waits on the first transaction, the first commits, and the second receives 409 with no further change', async () => {
    const f = await buildFixture();
    const mark = await auditBaseline(f.companyId);
    const parked = await parkFirstSelection(f);
    try {
      // Which transaction waits on which: the first selection is parked only behind the test's duty lock,
      // the second only behind the first selection's transaction.
      expect(parked.firstWaiter.wait_event_type).toBe('Lock');
      expect(parked.firstWaiter.blockers).toEqual([parked.holderPid]);
      expect(parked.secondWaiter.wait_event_type).toBe('Lock');
      expect(parked.secondWaiter.blockers).toEqual([parked.firstWaiter.pid]);
      expect(parked.secondWaiter.pid).not.toBe(parked.firstWaiter.pid);
      await parked.release();
    } finally {
      await parked.release().catch(() => undefined);
      parked.holder.release();
    }
    const [a, b] = await Promise.all([parked.first, parked.second]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(409);
    expect(b.body.code).toBe('CANCELLATION_ALREADY_RESOLVED');

    expect((await pool.query("SELECT id FROM replacement_offers WHERE company_id = $1 AND status = 'SELECTED'", [f.companyId])).rows).toEqual([
      { id: f.offerJonasId },
    ]);
    expect(await replacementMembershipId(f, f.offerJonasId)).toEqual(expect.any(String));
    expect((await selectionRows(f)).replacement).toHaveLength(1);
    expect((await pool.query('SELECT concurrency_version::int AS v FROM duties WHERE id = $1', [f.dutyId])).rows[0].v).toBe(2);
    expect((await auditSince(f.companyId, mark)).map((r) => r.action)).toEqual(SELECTED_ACTIONS);
    const keys = (
      await pool.query<{ state: string }>(
        "SELECT state FROM idempotency_records WHERE company_id = $1 AND operation = 'DECIDE_REPLACEMENT_SELECTION' ORDER BY state",
        [f.companyId],
      )
    ).rows.map((r) => r.state);
    expect(keys).toEqual(['COMPLETED', 'FAILED']);
  });

  it('the first writer fails at its first audit row after waiting, rolls back completely, and the second writer then commits exactly one selection', async () => {
    const f = await buildFixture();
    const mark = await auditBaseline(f.companyId);
    const parked = await parkFirstSelection(f);
    db.failOnce = 'INSERT INTO audit_event';
    try {
      await parked.release();
    } finally {
      await parked.release().catch(() => undefined);
      parked.holder.release();
    }
    const [a, b] = await Promise.all([parked.first, parked.second]);
    expect(a.status).toBeGreaterThanOrEqual(500);
    expect(b.status).toBe(200);
    expect(b.body.selectedOffer.id).toBe(f.offerLenaId);

    // Exact invariants: only the second writer's decision survives the rollback of the first.
    expect((await pool.query("SELECT id FROM replacement_offers WHERE company_id = $1 AND status = 'SELECTED'", [f.companyId])).rows).toEqual([
      { id: f.offerLenaId },
    ]);
    const offerStatuses = Object.fromEntries(
      (await pool.query<{ id: string; status: string }>('SELECT id, status FROM replacement_offers WHERE company_id = $1', [f.companyId])).rows
        .map((r) => [r.id, r.status]),
    );
    expect(offerStatuses).toEqual({ [f.offerJonasId]: 'NOT_SELECTED', [f.offerLenaId]: 'SELECTED' });
    const replacement = (await selectionRows(f)).replacement;
    expect(replacement).toEqual([expect.objectContaining({ employee_id: f.lenaId, state: 'ACTIVE', replacement_offer_id: f.offerLenaId })]);
    expect((await pool.query('SELECT concurrency_version::int AS v FROM duties WHERE id = $1', [f.dutyId])).rows[0].v).toBe(2);
    expect((await pool.query("SELECT status FROM cancellation_requests WHERE id = $1", [f.caseId])).rows[0].status).toBe('APPROVED');
    const rows = await auditSince(f.companyId, mark);
    expect(rows.map((r) => r.action)).toEqual(SELECTED_ACTIONS);
    expect(rows.find((r) => r.action === 'REPLACEMENT_OFFER_SELECTED')?.resource_id).toBe(f.offerLenaId);
    expect(rows.find((r) => r.action === 'DUTY_MEMBERSHIP_ADDED')?.new_values).toEqual(
      { dutyId: f.dutyId, employeeId: f.lenaId, dutyRole: 'EMPLOYEE', source: 'REPLACEMENT' },
    );
    const states = (
      await pool.query<{ state: string }>(
        "SELECT state FROM idempotency_records WHERE company_id = $1 AND operation = 'DECIDE_REPLACEMENT_SELECTION' ORDER BY state",
        [f.companyId],
      )
    ).rows.map((r) => r.state);
    expect(states).toEqual(['COMPLETED', 'FAILED']);
  });
});
