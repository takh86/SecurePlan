import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import request from 'supertest';
import { bootEmployeesApp, ORIGIN, RecordingDelivery } from './helpers/employees-test-app.js';
import { dutyMutationFixture, MUTATION_MONTH, MUTATION_NOW, type DutyMutationFixture } from './helpers/duty-mutation-fixtures.js';
import { createStaff, insertDuty, insertMembership, insertProjectAssignment } from './helpers/planning-fixtures.js';
import {
  createSyntheticSession,
  openLocalTestPool,
  realSessionService,
  removeSyntheticTenants,
  type SyntheticAccount,
  type SyntheticSession,
  type TestPool,
} from './helpers/synthetic-tenants.js';

/**
 * P0 regression (GitHub issue #119). A legitimate chained replacement must not make the admin
 * work queue fail for the whole tenant, while genuinely inconsistent history must still fail closed.
 * Synthetic data only. Every scenario is created through the public API; the committed state is
 * asserted before the read model is checked, so a failure points at the read model and not at setup.
 */

let pool: TestPool;
let app: INestApplication<App>;
let previousOrigin: string | undefined;
const companies: string[] = [];

const api = () => request(app.getHttpServer());
const session = (account: SyntheticAccount) => createSyntheticSession(realSessionService(pool), account);

async function publish(f: DutyMutationFixture) {
  await pool.query(
    "UPDATE monthly_plans SET status='PUBLISHED', published_at=clock_timestamp(), published_by_account_id=$2 WHERE id=$1",
    [f.planId, f.tenant.admin.accountId],
  );
}

async function fixture() {
  const f = await dutyMutationFixture(pool, companies);
  await publish(f);
  return f;
}

async function staffMember(f: DutyMutationFixture) {
  const staff = await createStaff(pool, f.tenant.companyId);
  await insertProjectAssignment(pool, f.tenant.companyId, staff.employeeId, f.project.projectId, MUTATION_MONTH);
  return { employeeId: staff.employeeId, session: await session(staff.account) };
}

const cancel = (s: SyntheticSession, assignmentId: string, dutyVersion: number) =>
  api().post('/api/v1/cancellation-requests')
    .set('Origin', ORIGIN).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf)
    .set('Expected-Version', String(dutyVersion)).set('Idempotency-Key', randomUUID())
    .send({ assignmentId });

const offer = (s: SyntheticSession, needId: string) =>
  api().post(`/api/v1/replacement-needs/${needId}/offers`)
    .set('Origin', ORIGIN).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf)
    .set('Idempotency-Key', randomUUID());

const select = (admin: SyntheticSession, needId: string, offerId: string, needVersion: number) =>
  api().post(`/api/v1/replacement-needs/${needId}/selection`)
    .set('Origin', ORIGIN).set('Cookie', admin.cookie).set('X-CSRF-Token', admin.csrf)
    .set('Expected-Version', String(needVersion)).set('Idempotency-Key', randomUUID())
    .send({ offerId });

const queue = (s: SyntheticSession) => api().get('/api/v1/admin/work-queue').set('Cookie', s.cookie);
const caseContext = (s: SyntheticSession, needId: string) =>
  api().get(`/api/v1/replacement-needs/${needId}/offers`).set('Cookie', s.cookie);

type Replacement = { caseId: string; needId: string; replacementId: string; dutyVersion: number };

/** One link: the given member cancels; the candidate is offered and then selected by the administrator. */
async function replaceMember(
  f: DutyMutationFixture,
  canceller: SyntheticSession,
  membershipId: string,
  dutyVersion: number,
  candidate: SyntheticSession,
): Promise<Replacement> {
  const created = await cancel(canceller, membershipId, dutyVersion);
  expect(created.status).toBe(201);
  const needId = created.body.replacementNeed.id as string;
  const offered = await offer(candidate, needId);
  expect(offered.status).toBe(201);
  const selected = await select(f.admin, needId, offered.body.id as string, 1);
  expect(selected.status).toBe(200);
  return {
    caseId: created.body.id as string,
    needId,
    replacementId: selected.body.replacementAssignment.id as string,
    dutyVersion: selected.body.duty.concurrencyVersion as number,
  };
}

/** An unrelated OPEN case on a second duty of the same plan, filed by a different employee. */
async function unrelatedOpenCase(f: DutyMutationFixture) {
  const staff = await staffMember(f);
  const dutyId = await insertDuty(pool, {
    companyId: f.tenant.companyId, projectId: f.project.projectId, planId: f.planId, month: MUTATION_MONTH,
    dutyDate: '2027-01-21', startsAt: '2027-01-21T05:00:00Z', endsAt: '2027-01-21T17:00:00Z',
  });
  const membershipId = await insertMembership(pool, f.tenant.companyId, dutyId, staff.employeeId);
  const created = await cancel(staff.session, membershipId, 1);
  expect(created.status).toBe(201);
  return { caseId: created.body.id as string, needId: created.body.replacementNeed.id as string, membershipId, dutyId, staff };
}

/** Two replacements in a row: original member -> first candidate -> cancels -> second candidate. */
async function chainedTenant() {
  const f = await fixture();
  const jonas = await session(f.jonas.account);
  const first = await replaceMember(f, await session(f.mira.account), f.membership, 1, jonas);
  const kira = await staffMember(f);
  const second = await replaceMember(f, jonas, first.replacementId, first.dutyVersion, kira.session);
  const states = await caseStates(f.tenant.companyId);
  expect(states.map((row) => [row.cancellation, row.need, row.selected])).toEqual([
    ['APPROVED', 'RESOLVED', true],
    ['APPROVED', 'RESOLVED', true],
  ]);
  return { f, first, second, kira, jonas };
}

async function caseStates(companyId: string) {
  return (await pool.query<{ cancellation: string; need: string; selected: boolean }>(
    `SELECT r.status AS cancellation, n.status AS need, n.selected_offer_id IS NOT NULL AS selected
       FROM public.cancellation_requests r
       JOIN public.replacement_needs n ON n.company_id = r.company_id AND n.cancellation_request_id = r.id
      WHERE r.company_id = $1 ORDER BY r.created_at, r.id`,
    [companyId],
  )).rows;
}

async function errorCode(run: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await run();
    return { message: 'no error was raised' };
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    return { code: failure.code, message: failure.message ?? '' };
  }
}

beforeAll(async () => {
  previousOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
  pool = openLocalTestPool(12);
  app = await bootEmployeesApp(new RecordingDelivery(), { clock: () => new Date(MUTATION_NOW) });
  await app.listen(0, '127.0.0.1');
});

afterEach(async () => {
  await removeSyntheticTenants(pool, companies.splice(0));
}, 30000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousOrigin;
}, 30000);

describe('admin work queue after a chained replacement (RED for issue #119)', () => {
  it('keeps the admin queue available and lists the unrelated open case', async () => {
    const { f } = await chainedTenant();
    const unrelated = await unrelatedOpenCase(f);
    const response = await queue(f.admin);
    expect(response.status).toBe(200);
    expect(response.body.items.map((item: { cancellationRequestId: string }) => item.cancellationRequestId)).toEqual([unrelated.caseId]);
  });

  it('keeps the historical replaced case readable and CONSISTENT', async () => {
    const { f, first, second } = await chainedTenant();
    const historical = await caseContext(f.admin, first.needId);
    expect(historical.status).toBe(200);
    expect(historical.body.context).toMatchObject({
      consistency: 'CONSISTENT',
      cancellation: { id: first.caseId, status: 'APPROVED' },
      need: { id: first.needId, status: 'RESOLVED' },
    });
    const newest = await caseContext(f.admin, second.needId);
    expect(newest.status).toBe(200);
    expect(newest.body.context).toMatchObject({ consistency: 'CONSISTENT', need: { id: second.needId, status: 'RESOLVED' } });
  });

  it('keeps the unrelated open case readable on its own', async () => {
    const { f } = await chainedTenant();
    const unrelated = await unrelatedOpenCase(f);
    const detail = await caseContext(f.admin, unrelated.needId);
    expect(detail.status).toBe(200);
    expect(detail.body.context).toMatchObject({ consistency: 'CONSISTENT', cancellation: { id: unrelated.caseId, status: 'OPEN' } });
  });

  it('does not let the chained tenant affect a valid case in another tenant', async () => {
    await chainedTenant();
    const other = await fixture();
    const otherCase = await cancel(await session(other.mira.account), other.membership, 1);
    expect(otherCase.status).toBe(201);
    const response = await queue(other.admin);
    expect(response.status).toBe(200);
    expect(response.body.pagination.totalItems).toBe(1);
  });

  it('keeps the chained case concealed from another tenant administrator', async () => {
    const { first } = await chainedTenant();
    const other = await fixture();
    const response = await caseContext(other.admin, first.needId);
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('still fails closed when a replaced membership was removed without an approved decision on it', async () => {
    const f = await fixture();
    const first = await replaceMember(f, await session(f.mira.account), f.membership, 1, await session(f.jonas.account));
    await pool.query("WITH moment AS (SELECT clock_timestamp() AS at) UPDATE plan_assignments SET state='REMOVED', removed_at=moment.at, updated_at=moment.at FROM moment WHERE id=$1", [first.replacementId]);
    const response = await queue(f.admin);
    expect(response.status).toBe(500);
    expect(response.body.code).toBe('INTERNAL_ERROR');
    expect((await caseContext(f.admin, first.needId)).status).toBe(500);
    const other = await fixture();
    await cancel(await session(other.mira.account), other.membership, 1);
    expect((await queue(other.admin)).status).toBe(200);
  });

  it('does not accept a rejected decision on the replacement as the explanation of its removal', async () => {
    const f = await fixture();
    const jonas = await session(f.jonas.account);
    const first = await replaceMember(f, await session(f.mira.account), f.membership, 1, jonas);
    const pending = await cancel(jonas, first.replacementId, first.dutyVersion);
    expect(pending.status).toBe(201);
    const secondNeed = pending.body.replacementNeed.id as string;
    await pool.query("WITH moment AS (SELECT clock_timestamp() AS at) UPDATE cancellation_requests SET status='REJECTED', decided_at=moment.at, decided_by_account_id=$2, updated_at=moment.at FROM moment WHERE id=$1", [pending.body.id, f.tenant.admin.accountId]);
    await pool.query("UPDATE replacement_needs SET status='CLOSED', updated_at=clock_timestamp() WHERE id=$1", [secondNeed]);
    await pool.query("WITH moment AS (SELECT clock_timestamp() AS at) UPDATE plan_assignments SET state='REMOVED', removed_at=moment.at, updated_at=moment.at FROM moment WHERE id=$1", [first.replacementId]);
    expect((await queue(f.admin)).status).toBe(500);
    expect((await caseContext(f.admin, first.needId)).status).toBe(500);
  });

  it('does not accept an approved decision on a different membership as the explanation', async () => {
    const f = await fixture();
    const first = await replaceMember(f, await session(f.mira.account), f.membership, 1, await session(f.jonas.account));
    const unrelated = await unrelatedOpenCase(f);
    await pool.query("WITH moment AS (SELECT clock_timestamp() AS at) UPDATE plan_assignments SET state='REMOVED', removed_at=moment.at, updated_at=moment.at FROM moment WHERE id=$1", [unrelated.membershipId]);
    await pool.query("WITH moment AS (SELECT clock_timestamp() AS at) UPDATE cancellation_requests SET status='APPROVED', decided_at=moment.at, decided_by_account_id=$2, updated_at=moment.at FROM moment WHERE id=$1", [unrelated.caseId, f.tenant.admin.accountId]);
    await pool.query("UPDATE replacement_needs SET status='OPEN_UNFILLED', updated_at=clock_timestamp() WHERE id=$1", [unrelated.needId]);
    await pool.query("WITH moment AS (SELECT clock_timestamp() AS at) UPDATE plan_assignments SET state='REMOVED', removed_at=moment.at, updated_at=moment.at FROM moment WHERE id=$1", [first.replacementId]);
    expect((await queue(f.admin)).status).toBe(500);
    expect((await caseContext(f.admin, first.needId)).status).toBe(500);
  });

  it('fails closed when the selected offer has no replacement membership', async () => {
    const f = await fixture();
    const first = await replaceMember(f, await session(f.mira.account), f.membership, 1, await session(f.jonas.account));
    await pool.query('DELETE FROM plan_assignments WHERE id=$1', [first.replacementId]);
    expect((await queue(f.admin)).status).toBe(500);
    expect((await caseContext(f.admin, first.needId)).status).toBe(500);
  });

  it('rejects offer, membership and need relationships that cross a need, a duty or an employee', async () => {
    const { f, first, second, kira } = await chainedTenant();
    // Lifetime uniqueness: the first offer already produced its only replacement membership.
    const duplicate = await errorCode(() => pool.query(
      `WITH moment AS (SELECT clock_timestamp() AS at)
       INSERT INTO plan_assignments (id, company_id, duty_id, employee_id, duty_function, source, state, replacement_offer_id, created_at, updated_at)
       SELECT gen_random_uuid(), o.company_id, o.duty_id, o.employee_id, 'MITARBEITER', 'REPLACEMENT', 'ACTIVE', o.id, moment.at, moment.at
         FROM replacement_offers o CROSS JOIN moment WHERE o.company_id = $1 AND o.id = (SELECT selected_offer_id FROM replacement_needs WHERE id = $2)`,
      [f.tenant.companyId, first.needId],
    ));
    expect(duplicate.code, duplicate.message).toBe('23505');
    // A pending offer on the unrelated case, then a membership that crosses duty and employee.
    const unrelated = await unrelatedOpenCase(f);
    const pendingOffer = await offer(kira.session, unrelated.needId);
    expect(pendingOffer.status).toBe(201);
    const crossing = await errorCode(() => pool.query(
      `WITH moment AS (SELECT clock_timestamp() AS at)
       INSERT INTO plan_assignments (id, company_id, duty_id, employee_id, duty_function, source, state, replacement_offer_id, created_at, updated_at)
       SELECT gen_random_uuid(), $1, $2, $3, 'MITARBEITER', 'REPLACEMENT', 'ACTIVE', $4, moment.at, moment.at FROM moment`,
      [f.tenant.companyId, f.dutyId, f.jonas.employeeId, pendingOffer.body.id],
    ));
    expect(crossing.code, crossing.message).toBe('23503');
    // A need may select only an offer that belongs to that same need.
    const foreignSelection = await errorCode(() => pool.query(
      `WITH moment AS (SELECT clock_timestamp() AS at)
       UPDATE replacement_needs SET status='RESOLVED', resolved_at=moment.at, updated_at=moment.at,
         selected_offer_id=(SELECT selected_offer_id FROM replacement_needs WHERE id=$1) FROM moment WHERE id=$2`,
      [second.needId, unrelated.needId],
    ));
    expect(foreignSelection.code, foreignSelection.message).toBe('23503');
  });
});
