import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import request from 'supertest';
import { bootEmployeesApp, ORIGIN, RecordingDelivery } from './helpers/employees-test-app.js';
import { dutyMutationFixture, dutyPath, MUTATION_NOW, type DutyMutationFixture } from './helpers/duty-mutation-fixtures.js';
import { backendPid, createSyntheticProject, createSyntheticSession, openLocalTestPool, realSessionService, removeSyntheticTenants, waitUntilBlockedBy, type SyntheticSession, type TestPool } from './helpers/synthetic-tenants.js';
import { insertDuty, insertMembership } from './helpers/planning-fixtures.js';
import { detailSql, queueSql } from '../src/modules/cancellation-replacement/admin-work-queue.query.js';

let pool: TestPool, app: INestApplication<App>, f: DutyMutationFixture,
  original: SyntheticSession, candidate: SyntheticSession, requestId: string, needId: string;
const companies: string[] = [];
let previousOrigin: string | undefined;
const queue = (query = '', cookie = f.admin.cookie) => request(app.getHttpServer()).get(`/api/v1/admin/work-queue${query}`).set('Cookie', cookie);
const offers = (query = '', cookie = f.admin.cookie, id = needId) => request(app.getHttpServer()).get(`/api/v1/replacement-needs/${id}/offers${query}`).set('Cookie', cookie);
async function createOffer() {
  return request(app.getHttpServer()).post(`/api/v1/replacement-needs/${needId}/offers`)
    .set('Origin', ORIGIN).set('Cookie', candidate.cookie).set('X-CSRF-Token', candidate.csrf)
    .set('Idempotency-Key', randomUUID());
}
beforeAll(async () => {
  previousOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
  pool = openLocalTestPool(12);
  app = await bootEmployeesApp(new RecordingDelivery(), { clock: () => new Date(MUTATION_NOW) });
  await app.listen(0, '127.0.0.1');
});
beforeEach(async () => {
  f = await dutyMutationFixture(pool, companies);
  await pool.query("UPDATE monthly_plans SET status='PUBLISHED',published_at=clock_timestamp(),published_by_account_id=$2 WHERE id=$1", [f.planId, f.tenant.admin.accountId]);
  original = await createSyntheticSession(realSessionService(pool), f.mira.account);
  candidate = await createSyntheticSession(realSessionService(pool), f.jonas.account);
  const response = await request(app.getHttpServer()).post('/api/v1/cancellation-requests')
    .set('Origin', ORIGIN).set('Cookie', original.cookie).set('X-CSRF-Token', original.csrf)
    .set('Expected-Version', '1').set('Idempotency-Key', randomUUID()).send({ assignmentId: f.membership });
  expect(response.status).toBe(201);
  requestId = response.body.id;
  needId = response.body.replacementNeed.id;
});
afterEach(async () => { await removeSyntheticTenants(pool, companies.splice(0)); }, 30000);
afterAll(async () => {
  await app?.close();
  await pool?.end();
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousOrigin;
}, 30000);

it('returns persisted normalized work, coherent details, and current submission indicators', async () => {
  const empty = await queue();
  expect(empty.status).toBe(200);
  expect(empty.body.pagination).toEqual({ page: 1, pageSize: 25, totalItems: 1, totalPages: 1 });
  expect(empty.body.items[0]).toMatchObject({ type: 'CANCELLATION_REQUEST', cancellationRequestId: requestId,
    replacementNeedId: needId, openOfferCount: 0, eligibleOpenOfferCount: 0, monthStart: '2027-01-01', timeZone: 'Europe/Berlin' });
  expect((await offers()).body.context.need.openOfferCount).toBe(0);
  expect((await createOffer()).status).toBe(201);
  const result = await offers();
  expect(result.status).toBe(200);
  expect(result.body.items[0]).toMatchObject({ needId, status: 'OPEN', reviewEligibility: 'ELIGIBLE', employee: { id: f.jonas.employeeId } });
  expect(result.body.context).toMatchObject({ cancellation: { id: requestId }, need: { id: needId, openOfferCount: 1 }, eligibleOpenOfferCount: 1 });
  expect(JSON.stringify(result.body)).not.toMatch(/SICK|LEAVE|password|email|conflict/i);
  expect((await queue()).body.items[0]).toMatchObject({ openOfferCount: 1, eligibleOpenOfferCount: 1 });
  const cancellation = await request(app.getHttpServer()).get(`/api/v1/cancellation-requests/${requestId}`).set('Cookie', f.admin.cookie);
  expect(cancellation.body).toEqual(result.body.context.cancellation);
  const need = await request(app.getHttpServer()).get(`/api/v1/replacement-needs/${needId}`).set('Cookie', f.admin.cookie);
  expect(need.body).toEqual(result.body.context.need);
});
it('keeps an open offer but changes only its generic current submission indicator', async () => {
  expect((await createOffer()).status).toBe(201);
  await pool.query("INSERT INTO employee_availability_days(company_id,employee_id,day,status) VALUES($1,$2,'2027-01-20','SICK')", [f.tenant.companyId, f.jonas.employeeId]);
  const result = await offers();
  expect(result.body.items[0]).toMatchObject({ status: 'OPEN', reviewEligibility: 'INELIGIBLE' });
  expect(result.body.context).toMatchObject({ eligibleOpenOfferCount: 0, need: { openOfferCount: 1 } });
  expect((await queue('?offerPresence=WITHOUT_ELIGIBLE')).body.pagination.totalItems).toBe(1);
  expect((await queue('?offerPresence=WITH_ELIGIBLE')).body.pagination.totalItems).toBe(0);
  await pool.query('DELETE FROM employee_availability_days WHERE company_id=$1 AND employee_id=$2', [f.tenant.companyId, f.jonas.employeeId]);
  expect((await offers()).body.items[0].reviewEligibility).toBe('ELIGIBLE');
});
it.each(['employee', 'account'] as const)('marks an offer ineligible after candidate %s deactivation', async (kind) => {
  expect((await createOffer()).status).toBe(201);
  if (kind === 'employee') await pool.query("UPDATE employees SET status='DEACTIVATED',deactivated_at=clock_timestamp() WHERE id=$1", [f.jonas.employeeId]);
  else await pool.query("UPDATE accounts SET status='DEACTIVATED' WHERE id=$1", [f.jonas.account.accountId]);
  const response = await offers();
  expect(response.status).toBe(200);
  expect(response.body.items[0]).toMatchObject({ status: 'OPEN', reviewEligibility: 'INELIGIBLE' });
  expect(response.body.context.eligibleOpenOfferCount).toBe(0);
  expect((await queue()).body.pagination.totalItems).toBe(1);
});
it('changes the new-offer indicator at duty start without hiding the case', async () => {
  expect((await createOffer()).status).toBe(201);
  await pool.query("UPDATE duties SET starts_at=clock_timestamp()-interval '1 hour',ends_at=clock_timestamp()+interval '1 hour' WHERE id=$1", [f.dutyId]);
  const response = await offers();
  expect(response.body.items[0]).toMatchObject({ status: 'OPEN', reviewEligibility: 'INELIGIBLE' });
  expect(response.body.context.eligibleOpenOfferCount).toBe(0);
  expect((await queue()).body.pagination.totalItems).toBe(1);
});
it('keeps approved unfilled work after removal and does not reinterpret retained offers', async () => {
  expect((await createOffer()).status).toBe(201);
  await pool.query("UPDATE plan_assignments SET state='REMOVED',removed_at=clock_timestamp() WHERE id=$1", [f.membership]);
  await pool.query("WITH t AS (SELECT clock_timestamp() AS now) UPDATE cancellation_requests SET status='APPROVED',decided_at=t.now,updated_at=t.now,decided_by_account_id=$2 FROM t WHERE id=$1", [requestId, f.tenant.admin.accountId]);
  await pool.query("UPDATE replacement_needs SET status='OPEN_UNFILLED' WHERE id=$1", [needId]);
  const result = await queue();
  expect(result.status).toBe(200);
  expect(result.body.items).toHaveLength(1);
  expect(result.body.items[0]).toMatchObject({ type: 'REPLACEMENT_NEED', openOfferCount: 1, eligibleOpenOfferCount: 0 });
  expect((await offers()).body.items[0]).toMatchObject({ status: 'OPEN', reviewEligibility: 'NOT_APPLICABLE' });
  expect((await queue('?type=CANCELLATION_REQUEST')).body.pagination.totalItems).toBe(0);
  expect((await queue('?type=REPLACEMENT_NEED')).body.pagination.totalItems).toBe(1);
});
it('preserves terminal history after actual withdrawal and removes it from the queue', async () => {
  expect((await createOffer()).status).toBe(201);
  const withdrawn = await request(app.getHttpServer()).post(`/api/v1/cancellation-requests/${requestId}/withdraw`)
    .set('Origin', ORIGIN).set('Cookie', original.cookie).set('X-CSRF-Token', original.csrf);
  expect(withdrawn.status).toBe(200);
  expect((await queue()).body.pagination.totalItems).toBe(0);
  const result = await offers();
  expect(result.body.context.cancellation.status).toBe('WITHDRAWN');
  expect(result.body.items[0]).toMatchObject({ status: 'INVALIDATED', reviewEligibility: 'NOT_APPLICABLE' });
});
it('shows all retained terminal offer states without implying a new-offer decision', async () => {
  expect((await createOffer()).status).toBe(201);
  await pool.query("UPDATE plan_assignments SET state='REMOVED',removed_at=clock_timestamp() WHERE id=$1", [f.membership]);
  await pool.query("WITH t AS (SELECT clock_timestamp() AS now) UPDATE cancellation_requests SET status='APPROVED',decided_at=t.now,updated_at=t.now,decided_by_account_id=$2 FROM t WHERE id=$1", [requestId, f.tenant.admin.accountId]);
  await pool.query("WITH t AS (SELECT clock_timestamp() AS now) UPDATE replacement_needs SET status='RESOLVED',resolved_at=t.now,updated_at=t.now FROM t WHERE id=$1", [needId]);
  await pool.query("WITH t AS (SELECT clock_timestamp() AS now) UPDATE replacement_offers SET status='SELECTED',decided_at=t.now,updated_at=t.now FROM t WHERE need_id=$1", [needId]);
  for (const status of ['NOT_SELECTED', 'INVALIDATED', 'WITHDRAWN']) {
    await pool.query(`WITH t AS (SELECT clock_timestamp() AS now) INSERT INTO replacement_offers(company_id,need_id,employee_id,status,created_at,updated_at,decided_at)
      SELECT $1,$2,$3,$4,t.now,t.now,t.now FROM t`, [f.tenant.companyId, needId, f.jonas.employeeId, status]);
  }
  expect((await queue()).body.pagination.totalItems).toBe(0);
  const response = await offers();
  expect(response.status).toBe(200);
  expect(response.body.items.map((offer: { status: string }) => offer.status).sort())
    .toEqual(['SELECTED', 'NOT_SELECTED', 'INVALIDATED', 'WITHDRAWN'].sort());
  expect(response.body.items.every((offer: { reviewEligibility: string }) => offer.reviewEligibility === 'NOT_APPLICABLE')).toBe(true);
  expect(response.body.context.need.status).toBe('RESOLVED');
});
it('conceals foreign resources and enforces the administrator role', async () => {
  expect((await queue('', candidate.cookie)).status).toBe(403);
  expect((await offers('', candidate.cookie)).status).toBe(403);
  expect((await offers('', f.foreignAdmin.cookie)).status).toBe(404);
  expect((await offers('', f.admin.cookie, randomUUID())).status).toBe(404);
  expect((await queue(`?projectId=${randomUUID()}`)).status).toBe(404);
  const foreignProject = await createSyntheticProject(pool, f.foreign.companyId);
  expect((await queue(`?projectId=${foreignProject.projectId}`)).status).toBe(404);
  const foreignQueue = await queue('', f.foreignAdmin.cookie);
  expect(foreignQueue.status).toBe(200);
  expect(foreignQueue.body.pagination.totalItems).toBe(0);
  expect((await request(app.getHttpServer()).get(`/api/v1/replacement-needs/${needId}`).set('Cookie', f.foreignAdmin.cookie)).status).toBe(404);
  expect((await request(app.getHttpServer()).get(`/api/v1/cancellation-requests/${requestId}`).set('Cookie', f.foreignAdmin.cookie)).status).toBe(404);
});
it.each(['?from=2027-01-01','?to=2027-01-31','?companyId=x','?page=0','?pageSize=101','?page=1&page=2','?type=bogus','?sortBy=id','?monthStart=2027-02-30'])('rejects unsupported or malformed query %s', async (query) => {
  const response = await queue(query);
  expect(response.status).toBe(400);
  expect(response.body.code).toBe('VALIDATION_FAILED');
});
it('reports safe fixed pointers for known invalid fields without echoing unknown input', async () => {
  const known = await queue('?pageSize=101');
  expect(known.body.errors).toEqual([{ pointer: '#/query/pageSize', code: 'OUT_OF_RANGE', detail: 'The value is out of the permitted range.' }]);
  const unknown = await queue('?private-secret-value=hidden');
  expect(unknown.status).toBe(400);
  expect(JSON.stringify(unknown.body)).not.toContain('private-secret-value');
  expect(JSON.stringify(unknown.body)).not.toContain('hidden');
});
it('keeps context and truthful totals for empty and out-of-range pages', async () => {
  expect((await createOffer()).status).toBe(201);
  const result = await offers('?page=2&pageSize=1');
  expect(result.body.items).toEqual([]);
  expect(result.body.pagination).toEqual({ page: 2, pageSize: 1, totalItems: 1, totalPages: 1 });
  expect(result.body.context.cancellation.id).toBe(requestId);
  const filtered = await offers('?status=INVALIDATED');
  expect(filtered.body.items).toEqual([]);
  expect(filtered.body.context.need.openOfferCount).toBe(1);
});
it('filters before paging and applies the requested deterministic database ordering', async () => {
  expect((await createOffer()).status).toBe(201);
  const secondDuty = await insertDuty(pool, { companyId: f.tenant.companyId, projectId: f.project.projectId,
    planId: f.planId, month: '2027-01-01', dutyDate: '2027-01-21', startsAt: '2027-01-21T05:00:00Z', endsAt: '2027-01-21T17:00:00Z' });
  const secondMembership = await insertMembership(pool, f.tenant.companyId, secondDuty, f.mira.employeeId);
  const second = await request(app.getHttpServer()).post('/api/v1/cancellation-requests').set('Origin', ORIGIN)
    .set('Cookie', original.cookie).set('X-CSRF-Token', original.csrf).set('Expected-Version', '1')
    .set('Idempotency-Key', randomUUID()).send({ assignmentId: secondMembership });
  expect(second.status).toBe(201);
  const sorted = await queue('?monthStart=2027-01-01&sortBy=dutyDate&sortOrder=desc&pageSize=1');
  expect(sorted.body.pagination).toMatchObject({ totalItems: 2, totalPages: 2 });
  expect(sorted.body.items[0].cancellationRequestId).toBe(second.body.id);
  const filtered = await queue('?offerPresence=WITHOUT_ELIGIBLE&pageSize=1');
  expect(filtered.body.pagination.totalItems).toBe(1);
  expect(filtered.body.items[0].cancellationRequestId).toBe(second.body.id);
  await pool.query("UPDATE cancellation_requests SET created_at='2026-01-01T00:00:00Z' WHERE id=ANY($1::uuid[])", [[requestId, second.body.id]]);
  const tie = await queue('?sortBy=createdAt&sortOrder=asc');
  expect(tie.body.items.map((item: { cancellationRequestId: string }) => item.cancellationRequestId)).toEqual([requestId, second.body.id].sort());
});
it('does not hide open work when its project is inactive or its duty has started', async () => {
  expect((await createOffer()).status).toBe(201);
  await pool.query("UPDATE projects SET status='INACTIVE' WHERE id=$1", [f.project.projectId]);
  await pool.query("UPDATE duties SET starts_at=clock_timestamp()-interval '1 hour',ends_at=clock_timestamp()+interval '1 hour' WHERE id=$1", [f.dutyId]);
  const list = await queue();
  expect(list.status).toBe(200);
  expect(list.body.pagination.totalItems).toBe(1);
  expect(list.body.items[0]).toMatchObject({ openOfferCount: 1, eligibleOpenOfferCount: 0 });
  expect((await offers()).body.items[0]).toMatchObject({ status: 'OPEN', reviewEligibility: 'INELIGIBLE' });
});
it('fails closed on an inconsistent cancellation and need pair', async () => {
  await pool.query("UPDATE replacement_needs SET status='CLOSED' WHERE id=$1", [needId]);
  expect((await queue()).status).toBe(500);
  expect((await offers()).status).toBe(500);
});
it('fails closed instead of repairing an open offer on a closed workflow', async () => {
  expect((await createOffer()).status).toBe(201);
  await pool.query("UPDATE cancellation_requests SET status='WITHDRAWN' WHERE id=$1", [requestId]);
  await pool.query("UPDATE replacement_needs SET status='CLOSED' WHERE id=$1", [needId]);
  expect((await queue()).status).toBe(500);
  expect((await offers()).status).toBe(500);
  expect((await pool.query('SELECT status FROM replacement_offers WHERE need_id=$1', [needId])).rows[0].status).toBe('OPEN');
});
it('sets private no-store headers on GET, HEAD, validation and authorization failures', async () => {
  for (const response of [await queue(), await queue('?from=2027-01-01'), await queue('', candidate.cookie),
    await request(app.getHttpServer()).head('/api/v1/admin/work-queue').set('Cookie', f.admin.cookie).set('If-None-Match', '*')]) {
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers.vary).toContain('Cookie');
    expect(response.headers.etag).toBeUndefined();
  }
});

async function observedWaiter(holder: number): Promise<number> {
  for (let i = 0; i < 2000; i++) {
    const result = await pool.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))', [holder]);
    if (result.rows[0]) {
      await waitUntilBlockedBy(pool, result.rows[0].pid, holder);
      return result.rows[0].pid;
    }
  }
  throw new Error('No observed PostgreSQL blocker');
}

it.each(['WITHDRAW', 'PATCH', 'DELETE'] as const)(
  'observes a coherent snapshot while the actual %s writer waits on workflow', async (mode) => {
    expect((await createOffer()).status).toBe(201);
    let token = '';
    if (mode !== 'WITHDRAW') {
      const lease = await request(app.getHttpServer()).post(`${dutyPath(f)}/edit-lease`)
        .set('Origin', ORIGIN).set('Cookie', f.admin.cookie).set('X-CSRF-Token', f.admin.csrf);
      expect(lease.status).toBe(200);
      token = lease.body.leaseToken;
    }
    const blocker = await pool.connect();
    let pending: Promise<request.Response> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM cancellation_requests WHERE id=$1 FOR UPDATE', [requestId]);
      const holder = await backendPid(blocker);
      const writer = mode === 'WITHDRAW'
        ? request(app.getHttpServer()).post(`/api/v1/cancellation-requests/${requestId}/withdraw`)
          .set('Origin', ORIGIN).set('Cookie', original.cookie).set('X-CSRF-Token', original.csrf)
        : mode === 'PATCH'
          ? request(app.getHttpServer()).patch(dutyPath(f)).set('Origin', ORIGIN).set('Cookie', f.admin.cookie)
            .set('X-CSRF-Token', f.admin.csrf).set('Expected-Version', '1').set('Edit-Lease-Token', token).send({ assignments: [] })
          : request(app.getHttpServer()).delete(dutyPath(f)).set('Origin', ORIGIN).set('Cookie', f.admin.cookie)
            .set('X-CSRF-Token', f.admin.csrf).set('Expected-Version', '1').set('Edit-Lease-Token', token);
      pending = writer.then((response) => response);
      await observedWaiter(holder);
      // A distinct administrator avoids contending with the writer's actor fence.
      const before = await offers('', f.admin2.cookie);
      expect(before.status).toBe(200);
      expect(before.body.context.cancellation.status).toBe('OPEN');
      expect(before.body.context.need.status).toBe('OPEN');
      expect(before.body.items[0].status).toBe('OPEN');
      await blocker.query('COMMIT');
      const completed = await pending;
      expect(completed.status).toBe(mode === 'DELETE' ? 204 : 200);
      const after = await offers();
      expect(after.status).toBe(200);
      expect(after.body.context.cancellation.status).toBe(mode === 'WITHDRAW' ? 'WITHDRAWN' : 'OBSOLETE');
      expect(after.body.context.need.status).toBe('CLOSED');
      expect(after.body.items[0].status).toBe('INVALIDATED');
      expect((await queue()).body.pagination.totalItems).toBe(0);
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
      await pending?.catch(() => {});
    }
  }, 20000,
);

it('returns consistent offer pages while a real submission waits on the need', async () => {
  const blocker = await pool.connect();
  let pending: Promise<request.Response> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM replacement_needs WHERE id=$1 FOR UPDATE', [needId]);
    const holder = await backendPid(blocker);
    pending = createOffer();
    await observedWaiter(holder);
    const before = await offers();
    expect(before.status).toBe(200);
    expect(before.body.items).toEqual([]);
    expect(before.body.pagination.totalItems).toBe(0);
    expect(before.body.context.need.openOfferCount).toBe(0);
    expect(before.body.context.eligibleOpenOfferCount).toBe(0);
    await blocker.query('COMMIT');
    expect((await pending).status).toBe(201);
    const after = await offers();
    expect(after.status).toBe(200);
    expect(after.body.items).toHaveLength(1);
    expect(after.body.pagination.totalItems).toBe(1);
    expect(after.body.context.need.openOfferCount).toBe(1);
    expect(after.body.context.eligibleOpenOfferCount).toBe(1);
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    blocker.release();
    await pending?.catch(() => {});
  }
}, 20000);

it('observes a coherent snapshot while the actual employee-month batch waits on workflow', async () => {
  expect((await createOffer()).status).toBe(201);
  const path = `/api/v1/monthly-plans/${f.planId}/employee-months/${f.mira.employeeId}`;
  const draft = await request(app.getHttpServer()).get(path).set('Cookie', f.admin.cookie);
  expect(draft.status).toBe(200);
  const body = {
    expectedPlan: { status: draft.body.plan.status, publishedAt: draft.body.plan.publishedAt },
    expectedCreationContext: draft.body.creationContextFingerprint,
    expectedCalendar: draft.body.operatingCalendar.effective === null ? null : {
      id: draft.body.operatingCalendar.effective.id, version: draft.body.operatingCalendar.effective.version,
    },
    days: draft.body.days.map((day: { date: string; day: { dutyId: string; version: number } | null; night: { dutyId: string; version: number } | null }) => ({
      date: day.date, expected: { day: day.day ? { id: day.day.dutyId, version: day.day.version } : null,
        night: day.night ? { id: day.night.dutyId, version: day.night.version } : null }, desired: { state: 'OFF' },
    })),
  };
  const blocker = await pool.connect();
  let pending: Promise<request.Response> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM cancellation_requests WHERE id=$1 FOR UPDATE', [requestId]);
    const holder = await backendPid(blocker);
    pending = request(app.getHttpServer()).post(`${path}/save`).set('Origin', ORIGIN).set('Cookie', f.admin.cookie)
      .set('X-CSRF-Token', f.admin.csrf).set('Idempotency-Key', randomUUID()).send(body).then((response) => response);
    await observedWaiter(holder);
    const before = await offers('', f.admin2.cookie);
    expect(before.status).toBe(200);
    expect(before.body.context.cancellation.status).toBe('OPEN');
    expect(before.body.items[0].status).toBe('OPEN');
    await blocker.query('COMMIT');
    expect((await pending).status).toBe(200);
    const after = await offers();
    expect(after.status).toBe(200);
    expect(after.body.context.cancellation.status).toBe('OBSOLETE');
    expect(after.body.context.need.status).toBe('CLOSED');
    expect(after.body.items[0].status).toBe('INVALIDATED');
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    blocker.release();
    await pending?.catch(() => {});
  }
}, 20000);

it('rejects a revoked session after an observed schema-lock wait', async () => {
  const blocker = await pool.connect();
  let pending: Promise<request.Response> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE public.replacement_offers IN ACCESS EXCLUSIVE MODE');
    const holder = await backendPid(blocker);
    pending = queue().then((response) => response);
    await observedWaiter(holder);
    await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [createHash('sha256').update(f.admin.rawToken).digest()]);
    await blocker.query('COMMIT');
    expect((await pending).status).toBe(401);
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    blocker.release();
    await pending?.catch(() => {});
  }
}, 20000);

it('rereads the exact planning signature after an observed DDL wait', async () => {
  const blocker = await pool.connect();
  let pending: Promise<request.Response> | undefined;
  let committed = false;
  try {
    await blocker.query('BEGIN');
    await blocker.query('ALTER TABLE public.replacement_offers ADD COLUMN sp19_test_drift integer');
    const holder = await backendPid(blocker);
    pending = queue().then((response) => response);
    await observedWaiter(holder);
    await blocker.query('COMMIT');
    committed = true;
    const result = await pending;
    expect(result.status).toBe(500);
    expect(result.body.code).toBe('INTERNAL_ERROR');
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    blocker.release();
    await pending?.catch(() => {});
    if (committed) await pool.query('ALTER TABLE public.replacement_offers DROP COLUMN sp19_test_drift');
  }
}, 20000);

it('does not write workflow, planning, audit or receipts during GET and HEAD', async () => {
  expect((await createOffer()).status).toBe(201);
  const state = async () => (await pool.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM cancellation_requests x WHERE company_id=$1) AS cancellations,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM replacement_needs x WHERE company_id=$1) AS needs,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM replacement_offers x WHERE company_id=$1) AS offers,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM plan_assignments x WHERE company_id=$1) AS assignments,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM duties x WHERE company_id=$1) AS duties,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM monthly_plans x WHERE company_id=$1) AS plans,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM employees x WHERE company_id=$1) AS employees,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM projects x WHERE company_id=$1) AS projects,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM audit_event x WHERE company_id=$1) AS audits,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM idempotency_records x WHERE company_id=$1) AS receipts`, [f.tenant.companyId])).rows[0];
  const before = await state();
  expect((await queue()).status).toBe(200);
  expect((await offers()).status).toBe(200);
  expect((await request(app.getHttpServer()).head('/api/v1/admin/work-queue').set('Cookie', f.admin.cookie)).status).toBe(200);
  expect(await state()).toEqual(before);
});

it.runIf(Boolean(process.env.SECUREPLAN_SP19_PLAN_OUTPUT))('records PostgreSQL plans for 0, 1, 100 and 1000 submitted offers', async () => {
  const plans: { offerCount: number; route: string; elapsedMs: number; plan: string[] }[] = [];
  const persistPlans = () => {
    if (process.env.SECUREPLAN_SP19_PLAN_OUTPUT) writeFileSync(process.env.SECUREPLAN_SP19_PLAN_OUTPUT, JSON.stringify(plans, null, 2));
  };
  const explain = async (offerCount: number) => {
    for (const statement of [
      { route: 'queue', sql: queueSql('createdAt', 'asc'), args: [f.tenant.companyId, null, null, null, null, null, null, 25, 0] },
      { route: 'offers', sql: detailSql, args: [f.tenant.companyId, null, needId, null, 25, 0] },
    ]) {
      const started = performance.now();
      const client = await pool.connect();
      try {
        await client.query("SET statement_timeout='15s'");
        const preview = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${statement.sql}`, statement.args);
        const entry = { offerCount, route: statement.route, elapsedMs: 0, plan: preview.rows.map((row) => row['QUERY PLAN']) };
        plans.push(entry);
        persistPlans();
        const result = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, BUFFERS) ${statement.sql}`, statement.args);
        entry.elapsedMs = performance.now() - started;
        entry.plan = result.rows.map((row) => row['QUERY PLAN']);
        persistPlans();
      } finally {
        await client.query('RESET statement_timeout').catch(() => {});
        client.release();
      }
    }
    const response = await queue();
    expect(response.status).toBe(200);
    expect(response.body.items[0].openOfferCount).toBe(offerCount);
    expect(response.body.items[0].eligibleOpenOfferCount).toBe(offerCount);
  };
  await explain(0);
  expect((await createOffer()).status).toBe(201);
  await explain(1);
  const add = (count: number) => pool.query(`WITH ids AS MATERIALIZED (SELECT gen_random_uuid() AS account_id,gen_random_uuid() AS employee_id FROM generate_series(1,$3::int)),
  accounts_added AS (INSERT INTO accounts(id,company_id,email,account_scope,role,status)
    SELECT account_id,$1,account_id::text || '@example.invalid','TENANT','EMPLOYEE','ACTIVE' FROM ids RETURNING id),
  employees_added AS (INSERT INTO employees(id,company_id,account_id,employee_number,first_name,last_name,shift_eligibility,employment_start)
    SELECT i.employee_id,$1,i.account_id,i.employee_id::text,'Synthetic','Candidate','BOTH','2020-01-01' FROM ids i JOIN accounts_added a ON a.id=i.account_id RETURNING id),
  assignments_added AS (INSERT INTO project_assignments(company_id,employee_id,project_id,planning_month)
    SELECT $1,id,$4,'2027-01-01' FROM employees_added RETURNING employee_id)
  INSERT INTO replacement_offers(company_id,need_id,employee_id) SELECT $1,$2,employee_id FROM assignments_added`, [f.tenant.companyId, needId, count, f.project.projectId]);
  await add(99);
  await explain(100);
  await add(900);
  await explain(1000);
  persistPlans();
}, 90000);

it('matches the independently documented OpenAPI schemas against actual HTTP responses', async () => {
  type Schema = { $ref?: string; type?: string; format?: string; nullable?: boolean; enum?: unknown[]; required?: string[];
    properties?: Record<string, Schema>; additionalProperties?: boolean; items?: Schema; minimum?: number; maximum?: number };
  type Api = { components: { schemas: Record<string, Schema> }; paths: Record<string, { get: { parameters: { name: string; in: string }[] } }> };
  const api = JSON.parse(readFileSync(new URL('../../../docs/api/admin-work-queue.openapi.json', import.meta.url), 'utf8')) as Api;
  function validate(value: unknown, schema: Schema): void {
    if (schema.$ref) return validate(value, api.components.schemas[schema.$ref.split('/').at(-1)!]);
    if (value === null && schema.nullable) return;
    if (schema.enum) expect(schema.enum).toContain(value);
    if (schema.type === 'object') {
      expect(value).not.toBeNull();
      expect(typeof value).toBe('object');
      expect(Array.isArray(value)).toBe(false);
      const actual = value as Record<string, unknown>;
      for (const key of schema.required ?? []) expect(Object.hasOwn(actual, key)).toBe(true);
      if (schema.additionalProperties === false) for (const key of Object.keys(actual)) expect(Object.hasOwn(schema.properties!, key)).toBe(true);
      for (const [key, property] of Object.entries(schema.properties!)) if (Object.hasOwn(actual, key)) validate(actual[key], property);
    } else if (schema.type === 'array') {
      expect(Array.isArray(value)).toBe(true);
      for (const item of value as unknown[]) validate(item, schema.items!);
    } else if (schema.type === 'integer') {
      expect(Number.isSafeInteger(value)).toBe(true);
      if (schema.minimum !== undefined) expect(value as number).toBeGreaterThanOrEqual(schema.minimum);
      if (schema.maximum !== undefined) expect(value as number).toBeLessThanOrEqual(schema.maximum);
    } else if (schema.type === 'string' || schema.type === 'boolean') {
      expect(typeof value).toBe(schema.type);
      if (schema.format === 'uuid') expect(value).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
      if (schema.format === 'date') expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (schema.format === 'date-time') expect(Number.isFinite(Date.parse(value as string))).toBe(true);
    }
  }
  expect(api.paths['/api/v1/admin/work-queue'].get.parameters.filter((p) => p.in === 'query').map((p) => p.name).sort())
    .toEqual(['projectId','monthStart','type','offerPresence','page','pageSize','sortBy','sortOrder'].sort());
  expect((await createOffer()).status).toBe(201);
  const list = await queue();
  const detail = await offers();
  const cancellation = await request(app.getHttpServer()).get(`/api/v1/cancellation-requests/${requestId}`).set('Cookie', f.admin.cookie);
  const need = await request(app.getHttpServer()).get(`/api/v1/replacement-needs/${needId}`).set('Cookie', f.admin.cookie);
  for (const response of [list, detail, cancellation, need]) expect(response.status).toBe(200);
  validate(list.body, api.components.schemas.QueueResponse);
  validate(detail.body, api.components.schemas.AdminOffersResponse);
  validate(cancellation.body, api.components.schemas.Cancellation);
  validate(need.body, api.components.schemas.ReplacementNeed);
  for (const error of [await queue('?from=2027-01-01'), await queue('?pageSize=101'), await queue('', candidate.cookie), await offers('', f.foreignAdmin.cookie)]) {
    expect(error.headers['content-type']).toContain('application/problem+json');
    validate(error.body, api.components.schemas.Problem);
  }
});
