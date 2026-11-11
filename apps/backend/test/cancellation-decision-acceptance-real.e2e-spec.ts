/**
 * SP-21 S4 — acceptance gap tests for REJECT and APPROVE without replacement.
 *
 * Only behaviour that S2 (cancellation-decision-real, service level) and S3 (cancellation-decision-http-real) do not
 * already prove: see docs/reviews/sp21-s4-acceptance-matrix.md for the matrix and the reason for every test here.
 * Everything runs through the real Nest/Express HTTP stack on a receipt-verified disposable PostgreSQL 17.
 * Races use real row locks and pg_blocking_pids barriers (no timing sleeps). Synthetic data only.
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DatabaseService } from '../src/database/database.service.js';
import { bootEmployeesApp, ORIGIN, RecordingDelivery } from './helpers/employees-test-app.js';
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

const MONTH = '2027-01-01';
const DAY = '2027-01-20';
const NOW = '2026-12-15T12:00:00Z';

/** Fault injection at a real database boundary: fail the nth statement that contains `match`. */
class ObservedDatabase extends DatabaseService {
  failAt?: { match: string; nth: number };
  override async withTransaction<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    return super.withTransaction((c) =>
      work(
        new Proxy(c, {
          get: (target, key) => {
            if (key === 'query')
              return async (sql: string, values?: unknown[]) => {
                if (this.failAt && typeof sql === 'string' && sql.includes(this.failAt.match) && --this.failAt.nth === 0) {
                  this.failAt = undefined;
                  throw new Error('synthetic failure injected at a database boundary');
                }
                return target.query(sql, values);
              };
            const v: unknown = Reflect.get(target, key);
            return typeof v === 'function' ? v.bind(target) : v;
          },
        }),
      ),
    );
  }
}

let pool: TestPool;
let app: INestApplication<App>;
let db: ObservedDatabase;
const delivery = new RecordingDelivery();
const companies: string[] = [];
let previousAppOrigin: string | undefined;

type Fixture = Awaited<ReturnType<typeof buildFixture>>;

/** Published plan, original employee on one duty, `offers` candidates who offer; all via the real APIs. */
async function buildFixture(offers = 1) {
  db.failAt = undefined;
  const tenant = await createSyntheticTenant(pool, 'SP21 S4 acceptance');
  const foreign = await createSyntheticTenant(pool, 'SP21 S4 foreign');
  companies.push(tenant.companyId, foreign.companyId);
  const sessions = realSessionService(pool);
  const admin = await createSyntheticSession(sessions, tenant.admin);
  const admin2Account = await createSyntheticAccount(pool, tenant.companyId, 'COMPANY_ADMIN');
  const admin2 = await createSyntheticSession(sessions, admin2Account);
  const project = await createSyntheticProject(pool, tenant.companyId, 'SP21 S4 project');
  await insertShiftConfiguration(pool, tenant.companyId, project.projectId, MONTH, STANDARD_SHIFTS);
  const original = await createStaff(pool, tenant.companyId);
  const candidates = [];
  for (let i = 0; i < offers; i++) candidates.push(await createStaff(pool, tenant.companyId));
  for (const s of [original, ...candidates]) await insertProjectAssignment(pool, tenant.companyId, s.employeeId, project.projectId, MONTH);
  const planId = await insertPlan(pool, tenant.companyId, project.projectId, MONTH, { byAccountId: tenant.admin.accountId });
  const dutyId = await insertDuty(pool, {
    companyId: tenant.companyId, projectId: project.projectId, planId, month: MONTH,
    dutyDate: DAY, startsAt: `${DAY}T05:00:00Z`, endsAt: `${DAY}T17:00:00Z`,
  });
  const assignmentId = await insertMembership(pool, tenant.companyId, dutyId, original.employeeId);
  const employee = await createSyntheticSession(sessions, original.account);
  const created = await createCancellation({ employee, assignmentId });
  if (created.status !== 201) throw new Error(`fixture cancellation failed: ${created.status}`);
  const candidateSessions: SyntheticSession[] = [];
  const offerIds: string[] = [];
  for (const c of candidates) {
    const s = await createSyntheticSession(sessions, c.account);
    candidateSessions.push(s);
    const r = await request(app.getHttpServer())
      .post(`/api/v1/replacement-needs/${created.body.replacementNeed.id}/offers`)
      .set('Origin', ORIGIN).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).set('Idempotency-Key', randomUUID());
    if (r.status !== 201) throw new Error(`fixture offer failed: ${r.status}`);
    offerIds.push(r.body.id);
  }
  return {
    tenant, foreign, admin, admin2, employee, original, candidates, candidateSessions, planId, dutyId, assignmentId,
    requestId: created.body.id as string, needId: created.body.replacementNeed.id as string, offerIds,
  };
}

function createCancellation(f: { employee: SyntheticSession; assignmentId: string }, expectedVersion = '1', key = randomUUID()) {
  return request(app.getHttpServer())
    .post('/api/v1/cancellation-requests')
    .set('Origin', ORIGIN).set('Cookie', f.employee.cookie).set('X-CSRF-Token', f.employee.csrf)
    .set('Expected-Version', expectedVersion).set('Idempotency-Key', key)
    .send({ assignmentId: f.assignmentId });
}
function decideHttp(f: Fixture, decision: 'APPROVE' | 'REJECT', opts: { key?: string; session?: SyntheticSession; requestId?: string; needVersion?: number; dutyVersion?: number } = {}) {
  const r = request(app.getHttpServer())
    .post(`/api/v1/cancellation-requests/${opts.requestId ?? f.requestId}/decision`)
    .set('Origin', ORIGIN).set('Cookie', (opts.session ?? f.admin).cookie).set('X-CSRF-Token', (opts.session ?? f.admin).csrf)
    .set('Idempotency-Key', opts.key ?? randomUUID());
  if (decision === 'REJECT') return r.send({ decision });
  return r.set('Expected-Version', String(opts.needVersion ?? 1)).send({ decision, expectedDutyVersion: opts.dutyVersion ?? 1 });
}
const leaseHttp = (f: Fixture, s: SyntheticSession) =>
  request(app.getHttpServer())
    .post(`/api/v1/monthly-plans/${f.planId}/entries/${f.dutyId}/edit-lease`)
    .set('Origin', ORIGIN).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf);
const removeDutyHttp = (f: Fixture, s: SyntheticSession, token: string, version = '1') =>
  request(app.getHttpServer())
    .delete(`/api/v1/monthly-plans/${f.planId}/entries/${f.dutyId}`)
    .set('Origin', ORIGIN).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf)
    .set('Expected-Version', version).set('Edit-Lease-Token', token);
const selectHttp = (f: Fixture, s: SyntheticSession, offerId: string, version = '1') =>
  request(app.getHttpServer())
    .post(`/api/v1/replacement-needs/${f.needId}/selection`)
    .set('Origin', ORIGIN).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf)
    .set('Idempotency-Key', randomUUID()).set('Expected-Version', version)
    .send({ offerId });

/** Business, audit and planning state of the tenant (idempotency rows reported separately). */
async function snapshot(companyId: string) {
  const q = async (sql: string) => (await pool.query(sql, [companyId])).rows;
  return {
    planning: await planningState(pool, companyId),
    rows: await Promise.all(
      ['duties', 'plan_assignments', 'cancellation_requests', 'replacement_needs', 'replacement_offers'].map((t) =>
        q(`SELECT to_jsonb(t)::text AS bytes FROM public.${t} t WHERE company_id = $1 ORDER BY id`),
      ),
    ),
    audit: await q('SELECT id FROM audit_event WHERE company_id = $1 ORDER BY id'),
  };
}
const receiptStates = async (companyId: string) =>
  (await pool.query<{ state: string }>(
    "SELECT state FROM idempotency_records WHERE company_id = $1 AND operation = 'DECIDE_CANCELLATION' ORDER BY created_at, id",
    [companyId],
  )).rows.map((r) => r.state);
async function auditMark(companyId: string) {
  return (await pool.query<{ id: string }>('SELECT id FROM audit_event WHERE company_id = $1', [companyId])).rows.map((r) => r.id);
}
type AuditRow = { action: string; resource_type: string; resource_id: string; old_values: Record<string, unknown> | null; new_values: Record<string, unknown> | null; actor_account_id: string; correlation_id: string };
async function auditSince(companyId: string, mark: string[]) {
  return (
    await pool.query<AuditRow>(
      'SELECT action, resource_type, resource_id, old_values, new_values, actor_account_id, correlation_id FROM audit_event WHERE company_id = $1 AND NOT (id = ANY($2::uuid[])) ORDER BY action, resource_id',
      [companyId, mark],
    )
  ).rows;
}
/** Code-unit order, which matches PostgreSQL uuid ORDER BY for canonical lower-case UUID text. */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const value = async (sql: string, params: unknown[]) => Object.values((await pool.query(sql, params)).rows[0])[0];

async function waitForLockWaiter(blockerPid: number, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const waiters = (
      await pool.query<{ pid: number; blockers: number[] }>(
        "SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      )
    ).rows;
    const hit = waiters.find((w) => w.blockers.includes(blockerPid));
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`no lock waiter behind pid ${blockerPid}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
/** Opens a transaction on a dedicated connection, runs `sql` in it and keeps it open until finish(). */
async function holdInTransaction(sql: string, params: unknown[]) {
  const holder = await pool.connect();
  await holder.query('BEGIN');
  await holder.query(sql, params);
  const pid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  let open = true;
  const finish = async (how: 'COMMIT' | 'ROLLBACK' = 'COMMIT') => {
    if (!open) return;
    open = false;
    try {
      await holder.query(how);
    } finally {
      holder.release();
    }
  };
  return { pid, finish };
}
const holdDuty = (f: Fixture) => holdInTransaction('SELECT id FROM duties WHERE company_id = $1 AND id = $2 FOR UPDATE', [f.tenant.companyId, f.dutyId]);
/** Starts `first` parked behind a duty-row barrier, queues `second` behind `first`, then releases the barrier. */
async function ordered<A, B>(f: Fixture, first: () => PromiseLike<A>, second: () => PromiseLike<B>): Promise<[A, B]> {
  const held = await holdDuty(f);
  let a: Promise<A>, b: Promise<B>;
  try {
    a = Promise.resolve(first());
    const firstWaiter = await waitForLockWaiter(held.pid);
    b = Promise.resolve(second());
    await waitForLockWaiter(firstWaiter.pid);
  } finally {
    await held.finish();
  }
  return Promise.all([a!, b!]);
}
function problem(r: { status: number; body: Record<string, unknown>; headers: Record<string, unknown> }, status: number, code: string) {
  expect({ status: r.status, code: r.body.code }).toEqual({ status, code });
  expect(String(r.headers['content-type'])).toMatch(/^application\/problem\+json/);
  expect(r.body.correlationId).toBe(r.headers['x-correlation-id']);
}

beforeAll(async () => {
  previousAppOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
  pool = openLocalTestPool(10);
  db = new ObservedDatabase();
  await db.isReady();
  app = await bootEmployeesApp(delivery, { database: db, clock: () => new Date(NOW) });
  await app.listen(0, '127.0.0.1');
}, 120000);
afterAll(async () => {
  await app?.close();
  if (pool) {
    await removeSyntheticTenants(pool, companies);
    await pool.end();
  }
  if (previousAppOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousAppOrigin;
});

/** Exact bounded audit payload keys per action (PO-2); values carry ids, statuses and versions only. */
const AUDIT_KEYS: Record<string, { old: string[]; new: string[] }> = {
  CANCELLATION_REJECTED: { old: ['status'], new: ['status'] },
  CANCELLATION_APPROVED: { old: ['status'], new: ['status'] },
  REPLACEMENT_NEED_CLOSED: { old: ['status'], new: ['status'] },
  REPLACEMENT_NEED_OPEN_UNFILLED: { old: ['status'], new: ['status'] },
  REPLACEMENT_OFFER_NOT_SELECTED: { old: ['status'], new: ['status'] },
  DUTY_MEMBERSHIP_REMOVED: { old: ['dutyId', 'dutyRole', 'employeeId', 'source'], new: ['dutyId', 'removedAt', 'state'] },
  DUTY_UPDATED: { old: [], new: [] }, // checked via DUTY_UPDATED_KEYS (existing SP-12 dutyValues shape)
};

describe('A1 PO-1/PO-2: only OPEN offers are finalized; exact bounded audit (HTTP)', () => {
  it.each(['REJECT', 'APPROVE'] as const)(
    '%s with two OPEN offers and one pre-existing INVALIDATED offer: k = 2, the terminal offer is untouched, payloads bounded, no PII, tenant-scoped',
    async (decision) => {
      const f = await buildFixture(3);
      // A terminal (INVALIDATED) offer is a reachable pre-existing state (SP-19 invalidation); it must not count in k.
      await pool.query(
        "UPDATE replacement_offers SET status = 'INVALIDATED', decided_at = greatest(created_at, updated_at), updated_at = greatest(created_at, updated_at) WHERE id = $1",
        [f.offerIds[2]],
      );
      const invalidatedBefore = await value('SELECT to_jsonb(o)::text FROM replacement_offers o WHERE id = $1', [f.offerIds[2]]);
      const mark = await auditMark(f.tenant.companyId);
      const foreignAuditBefore = await auditMark(f.foreign.companyId);
      const sentBefore = delivery.sent.length;
      const r = await decideHttp(f, decision);
      expect(r.status).toBe(200);
      const open = [f.offerIds[0], f.offerIds[1]].sort(byCodeUnit);
      const statuses = (await pool.query('SELECT id, status FROM replacement_offers WHERE company_id = $1 ORDER BY id', [f.tenant.companyId])).rows;
      expect(statuses).toEqual(
        [...open.map((id) => ({ id, status: 'NOT_SELECTED' })), { id: f.offerIds[2], status: 'INVALIDATED' }].sort((a, b) => byCodeUnit(a.id, b.id)),
      );
      expect(await value('SELECT to_jsonb(o)::text FROM replacement_offers o WHERE id = $1', [f.offerIds[2]])).toBe(invalidatedBefore);

      const rows = await auditSince(f.tenant.companyId, mark);
      const k = 2;
      expect(rows).toHaveLength(decision === 'REJECT' ? 2 + k : 4 + k);
      const expectedOfferRows = open.map((id) => ['REPLACEMENT_OFFER_NOT_SELECTED', 'REPLACEMENT_OFFER', id]);
      expect(rows.map((x) => [x.action, x.resource_type, x.resource_id])).toEqual(
        decision === 'REJECT'
          ? [['CANCELLATION_REJECTED', 'CANCELLATION_REQUEST', f.requestId], ['REPLACEMENT_NEED_CLOSED', 'REPLACEMENT_NEED', f.needId], ...expectedOfferRows]
          : [
              ['CANCELLATION_APPROVED', 'CANCELLATION_REQUEST', f.requestId],
              ['DUTY_MEMBERSHIP_REMOVED', 'DUTY_ASSIGNMENT', f.assignmentId],
              ['DUTY_UPDATED', 'DUTY', f.dutyId],
              ['REPLACEMENT_NEED_OPEN_UNFILLED', 'REPLACEMENT_NEED', f.needId],
              ...expectedOfferRows,
            ],
      );
      // One actor, the server-issued correlation id of this response, and no invalidated-offer row.
      expect(new Set(rows.map((x) => `${x.actor_account_id}/${x.correlation_id}`))).toEqual(new Set([`${f.tenant.admin.accountId}/${r.headers['x-correlation-id']}`]));
      for (const x of rows) {
        const keys = AUDIT_KEYS[x.action];
        if (x.action === 'DUTY_UPDATED') {
          expect(Object.keys(x.old_values ?? {}).sort(byCodeUnit)).toEqual(DUTY_UPDATED_KEYS);
          expect(Object.keys(x.new_values ?? {}).sort(byCodeUnit)).toEqual(DUTY_UPDATED_KEYS);
          expect([x.old_values?.version, x.new_values?.version]).toEqual([1, 2]);
          continue;
        }
        expect([Object.keys(x.old_values ?? {}).sort(byCodeUnit), Object.keys(x.new_values ?? {}).sort(byCodeUnit)]).toEqual([keys.old, keys.new]);
      }
      // No names, e-mail addresses, tokens or free text of any synthetic person in the audit payloads.
      const people = (
        await pool.query<{ first_name: string; last_name: string; email: string }>(
          'SELECT e.first_name, e.last_name, a.email FROM employees e JOIN accounts a ON a.id = e.account_id WHERE e.company_id = $1',
          [f.tenant.companyId],
        )
      ).rows;
      const auditText = JSON.stringify(rows.map((x) => [x.old_values, x.new_values]));
      for (const p of people) for (const v of [p.first_name, p.last_name, p.email]) expect(auditText).not.toContain(v);
      expect(auditText).not.toMatch(/@|token|password|reason/i);
      // Tenant isolation of the audit trail, and PO-3: no notification/delivery side effect.
      expect(await auditMark(f.foreign.companyId)).toEqual(foreignAuditBefore);
      expect(delivery.sent.length).toBe(sentBefore);
    },
  );
});

/** The existing SP-12 DUTY_UPDATED shape (planning/duty-audit-values.ts dutyValues), for both old and new values. */
const DUTY_UPDATED_KEYS = ['dutyDate', 'endsAt', 'planId', 'shiftKind', 'startsAt', 'version'];

describe('A2 PO-6: OPEN_UNFILLED after a real APPROVE stays visible to the office and admits no late selection (HTTP)', () => {
  it('work queue, admin need context and case read show APPROVED/OPEN_UNFILLED; no offer, no SP-20 selection, no notification', async () => {
    const f = await buildFixture(1);
    const sentBefore = delivery.sent.length;
    expect((await decideHttp(f, 'APPROVE')).status).toBe(200);

    const queue = await request(app.getHttpServer()).get('/api/v1/admin/work-queue').set('Cookie', f.admin.cookie);
    expect(queue.status).toBe(200);
    expect(queue.body.items).toEqual([
      expect.objectContaining({ cancellationRequestId: f.requestId, replacementNeedId: f.needId, cancellationStatus: 'APPROVED', replacementNeedStatus: 'OPEN_UNFILLED', openOfferCount: 0 }),
    ]);
    const context = await request(app.getHttpServer()).get(`/api/v1/replacement-needs/${f.needId}/offers`).set('Cookie', f.admin.cookie);
    expect(context.status).toBe(200);
    expect(context.body.context).toMatchObject({
      need: { id: f.needId, status: 'OPEN_UNFILLED', resolvedAt: null, selectedOfferId: null, concurrencyVersion: 2, openOfferCount: 0 },
      dutyRemoved: false,
      originalAssignmentActive: false,
    });
    expect(context.body.items).toEqual([expect.objectContaining({ id: f.offerIds[0], status: 'NOT_SELECTED' })]);
    const read = await request(app.getHttpServer()).get(`/api/v1/cancellation-requests/${f.requestId}`).set('Cookie', f.admin.cookie);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ id: f.requestId, status: 'APPROVED', replacementNeed: { id: f.needId, status: 'OPEN_UNFILLED', resolvedAt: null } });
    // The duty stays published with no ACTIVE member left and no REPLACEMENT membership (PO-6 a–c).
    expect(await value("SELECT count(*)::int FROM plan_assignments WHERE company_id = $1 AND state = 'ACTIVE'", [f.tenant.companyId])).toBe(0);
    expect(await value("SELECT count(*)::int FROM plan_assignments WHERE company_id = $1 AND source = 'REPLACEMENT'", [f.tenant.companyId])).toBe(0);
    expect(await value('SELECT p.status FROM monthly_plans p WHERE p.id = $1', [f.planId])).toBe('PUBLISHED');

    // No late SP-20 selection (PO-6 d) even with the current need version; no new offer on an OPEN_UNFILLED need.
    const before = await snapshot(f.tenant.companyId);
    const late = await selectHttp(f, f.admin2, f.offerIds[0], '2');
    expect(late.status).toBe(409);
    const extra = await createStaff(pool, f.tenant.companyId);
    await insertProjectAssignment(pool, f.tenant.companyId, extra.employeeId, (await value('SELECT project_id FROM monthly_plans WHERE id = $1', [f.planId])) as string, MONTH);
    const extraS = await createSyntheticSession(realSessionService(pool), extra.account);
    const offer = await request(app.getHttpServer())
      .post(`/api/v1/replacement-needs/${f.needId}/offers`)
      .set('Origin', ORIGIN).set('Cookie', extraS.cookie).set('X-CSRF-Token', extraS.csrf).set('Idempotency-Key', randomUUID());
    const after = await snapshot(f.tenant.companyId);
    expect({ rows: after.rows, audit: after.audit }).toEqual({ rows: before.rows, audit: before.audit });
    expect(delivery.sent.length).toBe(sentBefore);
    expect({ late: late.body.code, offer: [offer.status, offer.body.code] }).toEqual({ late: 'CANCELLATION_ALREADY_RESOLVED', offer: [409, 'REPLACEMENT_NEED_NOT_OPEN'] });
  });

  it('REJECT closes the need: the case leaves the work queue, the original stays ACTIVE on the unchanged duty', async () => {
    const f = await buildFixture(1);
    expect((await decideHttp(f, 'REJECT')).status).toBe(200);
    const queue = await request(app.getHttpServer()).get('/api/v1/admin/work-queue').set('Cookie', f.admin.cookie);
    expect(queue.status).toBe(200);
    expect(queue.body.items).toEqual([]);
    expect(await value('SELECT state FROM plan_assignments WHERE id = $1', [f.assignmentId])).toBe('ACTIVE');
    expect(await value('SELECT concurrency_version::int FROM duties WHERE id = $1', [f.dutyId])).toBe(1);
  });
});

describe('A3 PO-4: resubmission only under independently valid current create rules (HTTP)', () => {
  it('after REJECTED a new case is created on the still-ACTIVE membership; a second OPEN case is refused; after its APPROVE the removed membership cannot be reused', async () => {
    const f = await buildFixture(0);
    expect((await decideHttp(f, 'REJECT')).status).toBe(200);
    const second = await createCancellation(f);
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(f.requestId);
    expect(second.body.replacementNeed.id).not.toBe(f.needId);
    expect(second.body).toMatchObject({ status: 'OPEN', replacementNeed: { status: 'OPEN' } });
    expect(await value('SELECT status FROM cancellation_requests WHERE id = $1', [f.requestId])).toBe('REJECTED');
    const duplicate = await createCancellation(f);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('CANCELLATION_ALREADY_EXISTS');
    // Deciding the new case uses the new need (version 1) and the unchanged duty (version 1).
    expect((await decideHttp(f, 'APPROVE', { requestId: second.body.id })).status).toBe(200);
    const before = await snapshot(f.tenant.companyId);
    const afterApprove = await createCancellation(f, '2');
    expect(afterApprove.status).toBe(409);
    expect((await snapshot(f.tenant.companyId)).rows).toEqual(before.rows);
    expect(afterApprove.body.code).toBe('CANCELLATION_ASSIGNMENT_NOT_ACTIVE');
  });

  it('after WITHDRAWN a new case is allowed; after OBSOLETE (duty removed) it is refused', async () => {
    const w = await buildFixture(0);
    const withdrawn = await request(app.getHttpServer())
      .post(`/api/v1/cancellation-requests/${w.requestId}/withdraw`)
      .set('Origin', ORIGIN).set('Cookie', w.employee.cookie).set('X-CSRF-Token', w.employee.csrf);
    expect(withdrawn.status).toBe(200);
    expect((await createCancellation(w)).status).toBe(201);

    const o = await buildFixture(0);
    const token = (await leaseHttp(o, o.admin2)).body.leaseToken as string;
    expect((await removeDutyHttp(o, o.admin2, token)).status).toBe(204);
    expect(await value('SELECT status FROM cancellation_requests WHERE id = $1', [o.requestId])).toBe('OBSOLETE');
    const before = await snapshot(o.tenant.companyId);
    const refused = await createCancellation(o, '2');
    expect((await snapshot(o.tenant.companyId)).rows).toEqual(before.rows);
    expect([refused.status, refused.body.code]).toEqual([409, 'CANCELLATION_ASSIGNMENT_NOT_ACTIVE']);
    // And no decision can be taken on the OBSOLETE case (covered for REJECT by S2; here APPROVE over HTTP).
    expect((await decideHttp(o, 'APPROVE', { dutyVersion: 2 })).status).toBe(409);
  });
});

describe('A4 live authority at the account lock (HTTP, deterministic barrier)', () => {
  it.each([
    ['role downgraded to EMPLOYEE', "UPDATE accounts SET role = 'EMPLOYEE' WHERE id = $1", 403, 'ACTION_FORBIDDEN'],
    ['account deactivated', "UPDATE accounts SET status = 'DEACTIVATED' WHERE id = $1", 401, 'SESSION_REVOKED'],
  ] as const)('%s while the decision waits for the actor row: committed change refuses it with no write', async (_n, sql, status, code) => {
    const f = await buildFixture(1);
    const before = await snapshot(f.tenant.companyId);
    const held = await holdInTransaction(sql, [f.tenant.admin.accountId]);
    let pending!: Promise<request.Response>;
    try {
      pending = Promise.resolve(decideHttp(f, 'APPROVE'));
      await waitForLockWaiter(held.pid);
    } finally {
      await held.finish('COMMIT');
    }
    const r = await pending;
    expect({ status: r.status, code: r.body.code }).toEqual({ status, code });
    const after = await snapshot(f.tenant.companyId); // accounts changed by the test itself: compare business rows and audit
    expect({ rows: after.rows, audit: after.audit }).toEqual({ rows: before.rows, audit: before.audit });
    expect((await receiptStates(f.tenant.companyId)).filter((s) => s === 'COMPLETED')).toEqual([]);
  });

  it('a role change that is rolled back while the decision waits lets the decision proceed exactly once', async () => {
    const f = await buildFixture(1);
    const held = await holdInTransaction("UPDATE accounts SET role = 'EMPLOYEE' WHERE id = $1", [f.tenant.admin.accountId]);
    let pending!: Promise<request.Response>;
    try {
      pending = Promise.resolve(decideHttp(f, 'REJECT'));
      await waitForLockWaiter(held.pid);
    } finally {
      await held.finish('ROLLBACK');
    }
    expect((await pending).status).toBe(200);
    expect(await receiptStates(f.tenant.companyId)).toEqual(['COMPLETED']);
  });

  it('a downgrade issued while the decision holds its locks serializes after it; the same key then cannot replay', async () => {
    const f = await buildFixture(1);
    const key = randomUUID();
    const duty = await holdDuty(f);
    let decision!: Promise<request.Response>;
    let downgrade!: Promise<unknown>;
    try {
      decision = Promise.resolve(decideHttp(f, 'APPROVE', { key }));
      const parked = await waitForLockWaiter(duty.pid); // the decision, parked at D while holding the actor FOR SHARE
      downgrade = pool.query("UPDATE accounts SET role = 'EMPLOYEE' WHERE id = $1", [f.tenant.admin.accountId]);
      await waitForLockWaiter(parked.pid); // the downgrade waits for the decision, not the other way round
    } finally {
      await duty.finish();
    }
    expect((await decision).status).toBe(200);
    await downgrade;
    const before = await snapshot(f.tenant.companyId);
    const replay = await decideHttp(f, 'APPROVE', { key });
    problem(replay, 403, 'ACTION_FORBIDDEN');
    expect(await snapshot(f.tenant.companyId)).toEqual(before);
  });
});

describe('A5 APPROVE versus planning duty removal, both orders (HTTP, deterministic barrier)', () => {
  it('removal first: the case becomes OBSOLETE, APPROVE gets 409, no OPEN_UNFILLED need and no audit of the decision', async () => {
    const f = await buildFixture(1);
    const token = (await leaseHttp(f, f.admin2)).body.leaseToken as string;
    const mark = await auditMark(f.tenant.companyId);
    const [removal, approve] = await ordered(f, () => removeDutyHttp(f, f.admin2, token), () => decideHttp(f, 'APPROVE'));
    expect(removal.status).toBe(204);
    expect(approve.status).toBe(409);
    expect(await value('SELECT status FROM cancellation_requests WHERE id = $1', [f.requestId])).toBe('OBSOLETE');
    expect(await value('SELECT status FROM replacement_needs WHERE id = $1', [f.needId])).toBe('CLOSED');
    const actions = (await auditSince(f.tenant.companyId, mark)).map((r) => r.action);
    expect(actions).not.toContain('CANCELLATION_APPROVED');
    expect(actions).not.toContain('REPLACEMENT_NEED_OPEN_UNFILLED');
    expect(approve.body.code).toBe('REPLACEMENT_NEED_NOT_OPEN');
  });

  it('APPROVE first: a removal prepared against the pre-decision duty version is refused as stale; the OPEN_UNFILLED need survives', async () => {
    const f = await buildFixture(1);
    const [approve, lease] = await ordered(f, () => decideHttp(f, 'APPROVE'), () => leaseHttp(f, f.admin2));
    expect(approve.status).toBe(200);
    expect(lease.status).toBe(200);
    const before = await snapshot(f.tenant.companyId);
    const stale = await removeDutyHttp(f, f.admin2, lease.body.leaseToken as string, '1');
    problem(stale, 409, 'PLAN_CONCURRENT_MODIFICATION');
    expect((await snapshot(f.tenant.companyId)).rows).toEqual(before.rows);
    expect(await value('SELECT status FROM replacement_needs WHERE id = $1', [f.needId])).toBe('OPEN_UNFILLED');
    // A removal at the current duty version is the #123 lifecycle (OPEN_UNFILLED reconciliation): deliberately not exercised.
  });
});

describe('A6 bounded lock wait: timeout classification (HTTP)', () => {
  it('a decision blocked beyond lock_timeout fails as a sanitized 500 with no business write; the same key then decides once', async () => {
    const f = await buildFixture(1);
    const key = randomUUID();
    const before = await snapshot(f.tenant.companyId);
    const held = await holdDuty(f);
    let r!: request.Response;
    try {
      r = await decideHttp(f, 'APPROVE', { key }); // waits on the duty row until the server-side 5 s lock_timeout
    } finally {
      await held.finish();
    }
    problem(r, 500, 'INTERNAL_ERROR');
    expect(JSON.stringify(r.body)).not.toMatch(/lock|timeout|55P03|duties|SELECT/i);
    expect(await snapshot(f.tenant.companyId)).toEqual(before);
    expect(await receiptStates(f.tenant.companyId)).toEqual(['FAILED']);
    const retry = await decideHttp(f, 'APPROVE', { key });
    expect(retry.status).toBe(200);
    expect(retry.headers['idempotency-replayed']).toBeUndefined();
    expect(await receiptStates(f.tenant.companyId)).toEqual(['COMPLETED']);
  }, 30000);
});

describe('A7 REJECT atomic rollback at every non-audit boundary (HTTP)', () => {
  it.each([
    ['offer finalization', "SET status='NOT_SELECTED'"],
    ['cancellation transition', 'UPDATE public.cancellation_requests'],
    ['need transition', 'UPDATE public.replacement_needs'],
    ['receipt completion', "SET state='COMPLETED'"],
  ])('failure at %s: sanitized 500, nothing committed, FAILED; the same key decides once (2+k) and then replays', async (_n, match) => {
    const f = await buildFixture(1);
    const key = randomUUID();
    const before = await snapshot(f.tenant.companyId);
    db.failAt = { match, nth: 1 };
    const failed = await decideHttp(f, 'REJECT', { key });
    expect(db.failAt).toBeUndefined(); // the boundary was actually reached
    problem(failed, 500, 'INTERNAL_ERROR');
    expect(JSON.stringify(failed.body)).not.toContain('synthetic failure');
    expect(await snapshot(f.tenant.companyId)).toEqual(before);
    expect(await receiptStates(f.tenant.companyId)).toEqual(['FAILED']);
    const mark = await auditMark(f.tenant.companyId);
    const ok = await decideHttp(f, 'REJECT', { key });
    expect(ok.status).toBe(200);
    expect(await auditSince(f.tenant.companyId, mark)).toHaveLength(2 + 1);
    const replay = await decideHttp(f, 'REJECT', { key });
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.text).toBe(ok.text);
    expect(await auditSince(f.tenant.companyId, mark)).toHaveLength(2 + 1);
  });
});
