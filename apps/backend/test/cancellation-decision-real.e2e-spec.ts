/**
 * SP-21 S2 — cancellation decision service (REJECT, APPROVE without replacement) on real PostgreSQL 17.
 *
 * The service is called directly: S3 (route, DTO, CSRF/Origin, OpenAPI) does not exist yet, so HTTP decision,
 * CSRF, Origin and browser behaviour are NOT_RUN here. Fixtures, SP-20 selection and duty removal use the
 * existing real HTTP routes. Races use real row locks and pg_blocking_pids barriers. Synthetic data only.
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { TenantContext } from '../src/auth/authorization/tenant-context.js';
import { reserveCommand } from '../src/common/transactions/command-reservation.js';
import { DatabaseService } from '../src/database/database.service.js';
import { BusinessAuditService } from '../src/modules/audit/business-audit.service.js';
import {
  decisionFingerprint,
  DECIDE_CANCELLATION,
} from '../src/modules/cancellation-replacement/cancellation-decision-receipt.js';
import {
  CancellationDecisionService,
  type CancellationDecisionCommand,
} from '../src/modules/cancellation-replacement/cancellation-decision.service.js';
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

const DEFAULT_MONTH = '2027-01-01';
const DEFAULT_DAY = '2027-01-20';
const NOW = '2026-12-15T12:00:00Z';

/** Fault injection at a real database boundary: fail the nth statement that contains `failAt`. */
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
let service: CancellationDecisionService;
const companies: string[] = [];
let previousAppOrigin: string | undefined;

type Fixture = Awaited<ReturnType<typeof buildFixture>>;

async function contextOf(accountId: string, role: 'COMPANY_ADMIN' | 'EMPLOYEE' = 'COMPANY_ADMIN'): Promise<TenantContext> {
  const row = (
    await pool.query<{ id: string; company_id: string }>(
      'SELECT id, company_id FROM sessions WHERE account_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',
      [accountId],
    )
  ).rows[0];
  return { sessionId: row.id, accountId, companyId: row.company_id, role };
}

/** Published plan, original Mira on the duty, `offers` candidates who offer, real cancellation API. */
async function buildFixture(options: { offers?: number; shiftLead?: boolean; month?: string; day?: string; viaSql?: boolean } = {}) {
  db.failAt = undefined;
  const offers = options.offers ?? 2;
  const MONTH = options.month ?? DEFAULT_MONTH;
  const DAY = options.day ?? DEFAULT_DAY;
  const tenant = await createSyntheticTenant(pool, 'SP21 decision');
  companies.push(tenant.companyId);
  const foreign = await createSyntheticTenant(pool, 'SP21 foreign');
  companies.push(foreign.companyId);
  const sessions = realSessionService(pool);
  const adminS = await createSyntheticSession(sessions, tenant.admin);
  const second = await createSyntheticAccount(pool, tenant.companyId, 'COMPANY_ADMIN');
  const admin2S = await createSyntheticSession(sessions, second);
  await createSyntheticSession(sessions, foreign.admin);
  const project = await createSyntheticProject(pool, tenant.companyId, 'SP21 project');
  await insertShiftConfiguration(pool, tenant.companyId, project.projectId, MONTH, STANDARD_SHIFTS);
  const mira = await createStaff(pool, tenant.companyId);
  const candidates = [await createStaff(pool, tenant.companyId), await createStaff(pool, tenant.companyId)];
  for (const s of [mira, ...candidates]) await insertProjectAssignment(pool, tenant.companyId, s.employeeId, project.projectId, MONTH);
  const planId = await insertPlan(pool, tenant.companyId, project.projectId, MONTH, { byAccountId: tenant.admin.accountId });
  const dutyId = await insertDuty(pool, {
    companyId: tenant.companyId, projectId: project.projectId, planId, month: MONTH,
    dutyDate: DAY, startsAt: `${DAY}T05:00:00Z`, endsAt: `${DAY}T17:00:00Z`,
  });
  const membershipId = await insertMembership(pool, tenant.companyId, dutyId, mira.employeeId);
  if (options.shiftLead) await pool.query("UPDATE plan_assignments SET duty_function = 'SCHICHTLEITER' WHERE id = $1", [membershipId]);
  const miraS = await createSyntheticSession(sessions, mira.account);
  if (options.viaSql) {
    const id = randomUUID();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        'INSERT INTO cancellation_requests(id,company_id,assignment_id,duty_id,employee_id,submission_version) VALUES($1,$2,$3,$4,$5,1)',
        [id, tenant.companyId, membershipId, dutyId, mira.employeeId],
      );
      const need = await c.query<{ id: string }>('INSERT INTO replacement_needs(company_id,cancellation_request_id,duty_id) VALUES($1,$2,$3) RETURNING id', [tenant.companyId, id, dutyId]);
      await c.query('COMMIT');
      return {
        companyId: tenant.companyId, admin: await contextOf(tenant.admin.accountId), admin2: await contextOf(second.accountId),
        foreignAdmin: await contextOf(foreign.admin.accountId), employee: await contextOf(mira.account.accountId, 'EMPLOYEE'),
        adminS, admin2S, miraId: mira.employeeId, candidateIds: candidates.map((x) => x.employeeId), planId, dutyId, membershipId,
        caseId: id, needId: need.rows[0].id, offerIds: [] as string[],
      };
    } finally {
      c.release();
    }
  }
  const cancel = await request(app.getHttpServer())
    .post('/api/v1/cancellation-requests')
    .set('Origin', ORIGIN).set('Cookie', miraS.cookie).set('X-CSRF-Token', miraS.csrf)
    .set('Expected-Version', '1').set('Idempotency-Key', randomUUID())
    .send({ assignmentId: membershipId });
  if (cancel.status !== 201) throw new Error(`fixture cancellation failed: ${cancel.status} ${JSON.stringify(cancel.body)}`);
  const offerIds: string[] = [];
  for (const candidate of candidates.slice(0, offers)) {
    const s = await createSyntheticSession(sessions, candidate.account);
    const r = await request(app.getHttpServer())
      .post(`/api/v1/replacement-needs/${cancel.body.replacementNeed.id}/offers`)
      .set('Origin', ORIGIN).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).set('Idempotency-Key', randomUUID());
    if (r.status !== 201) throw new Error(`fixture offer failed: ${r.status}`);
    offerIds.push(r.body.id);
  }
  return {
    companyId: tenant.companyId,
    admin: await contextOf(tenant.admin.accountId),
    admin2: await contextOf(second.accountId),
    foreignAdmin: await contextOf(foreign.admin.accountId),
    employee: await contextOf(mira.account.accountId, 'EMPLOYEE'),
    adminS,
    admin2S,
    miraId: mira.employeeId,
    candidateIds: candidates.map((c) => c.employeeId),
    planId,
    dutyId,
    membershipId,
    caseId: cancel.body.id as string,
    needId: cancel.body.replacementNeed.id as string,
    offerIds: offerIds.sort(),
  };
}

const approve = (f: Fixture, needVersion = 1, dutyVersion = 1): CancellationDecisionCommand => ({
  decision: 'APPROVE', requestId: f.caseId, expectedNeedVersion: needVersion, expectedDutyVersion: dutyVersion,
});
const reject = (f: Fixture): CancellationDecisionCommand => ({ decision: 'REJECT', requestId: f.caseId });
const decide = (t: TenantContext, command: CancellationDecisionCommand, key = randomUUID()) =>
  service.decide(t, command, key, randomUUID());
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'RESOLVED';
  } catch (error) {
    const response = (error as { getResponse?: () => unknown }).getResponse?.();
    if (response && typeof response === 'object' && 'code' in response) return String((response as { code: unknown }).code);
    return 'ERROR';
  }
}

/** Everything a decision could change for the tenant (idempotency reported separately). */
async function snapshot(f: Fixture) {
  const q = async (sql: string) => (await pool.query(sql, [f.companyId])).rows;
  return {
    planning: await planningState(pool, f.companyId),
    duties: await q('SELECT id, concurrency_version, updated_at, removed_at FROM duties WHERE company_id = $1 ORDER BY id'),
    memberships: await q('SELECT id, state, removed_at, source, duty_function FROM plan_assignments WHERE company_id = $1 ORDER BY id'),
    cancellations: await q('SELECT id, status, decided_at, decided_by_account_id FROM cancellation_requests WHERE company_id = $1 ORDER BY id'),
    needs: await q('SELECT id, status, resolved_at, selected_offer_id, concurrency_version FROM replacement_needs WHERE company_id = $1 ORDER BY id'),
    offers: await q('SELECT id, status, decided_at FROM replacement_offers WHERE company_id = $1 ORDER BY id'),
    audit: await q('SELECT id FROM audit_event WHERE company_id = $1 ORDER BY id'),
  };
}
const receipts = async (f: Fixture) =>
  (await pool.query<{ state: string; key_hash: Buffer; bytes: string }>(
    "SELECT state, key_hash, to_jsonb(r)::text AS bytes FROM idempotency_records r WHERE company_id = $1 AND operation = 'DECIDE_CANCELLATION' ORDER BY id",
    [f.companyId],
  )).rows;
async function auditBaseline(companyId: string): Promise<string[]> {
  return (await pool.query<{ id: string }>('SELECT id FROM audit_event WHERE company_id = $1', [companyId])).rows.map((r) => r.id);
}
/**
 * New rows as a deterministic MULTISET (sorted by action, resource): audit_event has no logical sequence column and
 * occurred_at is the transaction start, so no intra-transaction order is asserted (TL review PR #127).
 */
async function auditSince(companyId: string, mark: string[]) {
  return (
    await pool.query<{ action: string; resource_type: string; resource_id: string; old_values: unknown; new_values: unknown; actor_account_id: string; correlation_id: string }>(
      'SELECT action, resource_type, resource_id, old_values, new_values, actor_account_id, correlation_id FROM audit_event WHERE company_id = $1 AND NOT (id = ANY($2::uuid[])) ORDER BY action, resource_id',
      [companyId, mark],
    )
  ).rows;
}
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
/** Holds the duty row so the first command parks at D; returns the holder and a release function. */
async function holdDuty(f: Fixture) {
  const holder = await pool.connect();
  await holder.query('BEGIN');
  await holder.query('SELECT id FROM duties WHERE company_id = $1 AND id = $2 FOR UPDATE', [f.companyId, f.dutyId]);
  const pid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  let open = true;
  const release = async () => {
    if (open) {
      open = false;
      await holder.query('COMMIT');
      holder.release();
    }
  };
  return { pid, release };
}
const selectHttp = (f: Fixture, s: SyntheticSession, offerId: string) =>
  request(app.getHttpServer())
    .post(`/api/v1/replacement-needs/${f.needId}/selection`)
    .set('Origin', ORIGIN).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf)
    .set('Idempotency-Key', randomUUID()).set('Expected-Version', '1')
    .send({ offerId });
async function acquireLease(f: Fixture, s: SyntheticSession) {
  const r = await request(app.getHttpServer())
    .post(`/api/v1/monthly-plans/${f.planId}/entries/${f.dutyId}/edit-lease`)
    .set('Origin', ORIGIN).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf);
  if (r.status !== 200) throw new Error(`lease acquire failed: ${r.status}`);
  return r.body.leaseToken as string;
}

beforeAll(async () => {
  previousAppOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
  pool = openLocalTestPool(8);
  db = new ObservedDatabase();
  await db.isReady();
  app = await bootEmployeesApp(new RecordingDelivery(), { database: db, clock: () => new Date(NOW) });
  await app.listen(0, '127.0.0.1');
  service = new CancellationDecisionService(db, new BusinessAuditService());
}, 120000);
afterAll(async () => {
  await app?.close();
  await removeSyntheticTenants(pool, companies);
  await pool.end();
  if (previousAppOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousAppOrigin;
});

describe('S2 successful transitions (exact state, audit and snapshot)', () => {
  it.each([0, 2])('REJECT with %i OPEN offers: REJECTED/CLOSED, need v2, membership and duty unchanged, 2+k audits', async (k) => {
    const f = await buildFixture({ offers: k });
    const mark = await auditBaseline(f.companyId);
    const correlationId = randomUUID();
    const before = await snapshot(f);
    const out = await service.decide(f.admin, reject(f), randomUUID(), correlationId);
    expect(out.replayed).toBe(false);
    const after = await snapshot(f);
    expect(after.cancellations).toEqual([expect.objectContaining({ id: f.caseId, status: 'REJECTED', decided_by_account_id: f.admin.accountId })]);
    expect(after.needs).toEqual([expect.objectContaining({ id: f.needId, status: 'CLOSED', resolved_at: null, selected_offer_id: null, concurrency_version: '2' })]);
    expect(after.duties).toEqual(before.duties);
    expect(after.memberships).toEqual(before.memberships);
    expect(after.offers.map((o) => o.status)).toEqual(Array(k).fill('NOT_SELECTED'));
    const rows = await auditSince(f.companyId, mark);
    expect(rows.map((r) => [r.action, r.resource_type, r.resource_id, r.old_values, r.new_values])).toEqual([
      ['CANCELLATION_REJECTED', 'CANCELLATION_REQUEST', f.caseId, { status: 'OPEN' }, { status: 'REJECTED' }],
      ['REPLACEMENT_NEED_CLOSED', 'REPLACEMENT_NEED', f.needId, { status: 'OPEN' }, { status: 'CLOSED' }],
      ...f.offerIds.map((id) => ['REPLACEMENT_OFFER_NOT_SELECTED', 'REPLACEMENT_OFFER', id, { status: 'OPEN' }, { status: 'NOT_SELECTED' }]),
    ]);
    expect(rows).toHaveLength(2 + k);
    expect(new Set(rows.map((r) => `${r.actor_account_id}/${r.correlation_id}`))).toEqual(new Set([`${f.admin.accountId}/${correlationId}`]));
    expect(out.result).toMatchObject({
      cancellation: { id: f.caseId, status: 'REJECTED', replacementNeed: { id: f.needId, status: 'CLOSED', resolvedAt: null } },
      selectedOffer: null,
      updatedDuty: null,
    });
    const stored = (await pool.query("SELECT result_json FROM idempotency_records WHERE company_id = $1 AND operation = 'DECIDE_CANCELLATION' AND state = 'COMPLETED'", [f.companyId])).rows;
    expect(stored).toEqual([{ result_json: out.result }]);
  });

  it.each([0, 2])('APPROVE with %i OPEN offers: APPROVED/OPEN_UNFILLED, need v2, membership REMOVED, duty v2, no replacement, 4+k audits', async (k) => {
    const f = await buildFixture({ offers: k });
    const mark = await auditBaseline(f.companyId);
    const out = await decide(f.admin, approve(f));
    const after = await snapshot(f);
    expect(after.cancellations).toEqual([expect.objectContaining({ status: 'APPROVED', decided_by_account_id: f.admin.accountId })]);
    expect(after.needs).toEqual([expect.objectContaining({ status: 'OPEN_UNFILLED', resolved_at: null, selected_offer_id: null, concurrency_version: '2' })]);
    expect(after.duties).toEqual([expect.objectContaining({ id: f.dutyId, concurrency_version: '2', removed_at: null })]);
    expect(after.memberships).toEqual([expect.objectContaining({ id: f.membershipId, state: 'REMOVED', source: 'NORMAL' })]);
    expect(after.memberships[0].removed_at).not.toBeNull();
    expect(after.offers.map((o) => o.status)).toEqual(Array(k).fill('NOT_SELECTED'));
    const rows = await auditSince(f.companyId, mark);
    expect(rows.map((r) => [r.action, r.resource_type, r.resource_id, r.old_values, r.new_values])).toEqual([
      ['CANCELLATION_APPROVED', 'CANCELLATION_REQUEST', f.caseId, { status: 'OPEN' }, { status: 'APPROVED' }],
      ['DUTY_MEMBERSHIP_REMOVED', 'DUTY_ASSIGNMENT', f.membershipId, expect.anything(), expect.anything()],
      ['DUTY_UPDATED', 'DUTY', f.dutyId, expect.anything(), expect.anything()],
      ['REPLACEMENT_NEED_OPEN_UNFILLED', 'REPLACEMENT_NEED', f.needId, { status: 'OPEN' }, { status: 'OPEN_UNFILLED' }],
      ...f.offerIds.map((id) => ['REPLACEMENT_OFFER_NOT_SELECTED', 'REPLACEMENT_OFFER', id, { status: 'OPEN' }, { status: 'NOT_SELECTED' }]),
    ]);
    expect(new Set(rows.map((r) => r.actor_account_id))).toEqual(new Set([f.admin.accountId]));
    expect(new Set(rows.map((r) => r.correlation_id)).size).toBe(1);
    expect(rows).toHaveLength(4 + k);
    const dutyUpdated = rows.find((r) => r.action === 'DUTY_UPDATED')!;
    expect([(dutyUpdated.old_values as { version: number }).version, (dutyUpdated.new_values as { version: number }).version]).toEqual([1, 2]);
    expect(rows.find((r) => r.action === 'DUTY_MEMBERSHIP_REMOVED')).toMatchObject({
      resource_id: f.membershipId,
      old_values: { dutyId: f.dutyId, employeeId: f.miraId, dutyRole: 'EMPLOYEE', source: 'NORMAL' },
      new_values: { dutyId: f.dutyId, state: 'REMOVED', removedAt: expect.any(String) },
    });
    expect(out.result).toMatchObject({
      cancellation: { id: f.caseId, status: 'APPROVED', replacementNeed: { status: 'OPEN_UNFILLED', resolvedAt: null } },
      selectedOffer: null,
      updatedDuty: { id: f.dutyId, concurrencyVersion: 2 },
    });
    // No audit row carries names, e-mail addresses or free text.
    expect(JSON.stringify(rows)).not.toMatch(/firstName|lastName|email|@/);
  });

  it('APPROVE and REJECT work for a SCHICHTLEITER duty membership', async () => {
    const a = await buildFixture({ offers: 1, shiftLead: true });
    const mark = await auditBaseline(a.companyId);
    await decide(a.admin, approve(a));
    expect((await auditSince(a.companyId, mark)).find((r) => r.action === 'DUTY_MEMBERSHIP_REMOVED')?.old_values).toMatchObject({ dutyRole: 'SHIFT_LEAD' });
    const r = await buildFixture({ offers: 1, shiftLead: true });
    await decide(r.admin, reject(r));
    expect(await value('SELECT status FROM cancellation_requests WHERE id = $1', [r.caseId])).toBe('REJECTED');
  });

  it('PO-5 Option A: a decision after the duty has started (database clock) is not refused by any time cut-off', async () => {
    // A published duty that has already started AND ended by the database clock (October 2026). The OPEN case is
    // inserted directly, because the create route applies its own create-time rules (PO-4), not a decision rule.
    for (const decision of ['APPROVE', 'REJECT'] as const) {
      const f = await buildFixture({ offers: 0, month: '2026-10-01', day: '2026-10-20', viaSql: true });
      expect(await value('SELECT ends_at < clock_timestamp() AS s FROM duties WHERE id = $1', [f.dutyId])).toBe(true);
      const out = await decide(f.admin, decision === 'APPROVE' ? approve(f) : reject(f));
      expect(out.result.cancellation.status).toBe(decision === 'APPROVE' ? 'APPROVED' : 'REJECTED');
    }
  });
});

describe('S2 version, state and lease precedence (refusals write nothing)', () => {
  it.each([
    ['stale need version', (f: Fixture) => approve(f, 2, 1)],
    ['stale duty version', (f: Fixture) => approve(f, 1, 2)],
  ])('APPROVE with a %s is 409 PLAN_CONCURRENT_MODIFICATION and changes no business row', async (_n, cmd) => {
    const f = await buildFixture();
    const before = await snapshot(f);
    expect(await codeOf(decide(f.admin, cmd(f)))).toBe('PLAN_CONCURRENT_MODIFICATION');
    expect(await snapshot(f)).toEqual(before);
    expect((await receipts(f)).map((r) => r.state)).toEqual(['FAILED']);
  });

  it('REJECT carries no version, so stale versions are irrelevant to it', async () => {
    const f = await buildFixture();
    await pool.query('UPDATE duties SET concurrency_version = concurrency_version + 3 WHERE id = $1', [f.dutyId]);
    expect((await decide(f.admin, reject(f))).result.cancellation.status).toBe('REJECTED');
  });

  it('an already decided case reports its state before a version mismatch', async () => {
    const r = await buildFixture();
    await decide(r.admin, reject(r));
    expect(await codeOf(decide(r.admin2, approve(r, 9, 9)))).toBe('REPLACEMENT_NEED_NOT_OPEN');
    expect(await codeOf(decide(r.admin2, reject(r)))).toBe('REPLACEMENT_NEED_NOT_OPEN');
    const a = await buildFixture();
    await decide(a.admin, approve(a));
    const before = await snapshot(a);
    expect(await codeOf(decide(a.admin2, approve(a, 9, 9)))).toBe('CANCELLATION_ALREADY_RESOLVED');
    expect(await codeOf(decide(a.admin2, reject(a)))).toBe('CANCELLATION_ALREADY_RESOLVED');
    expect(await snapshot(a)).toEqual(before);
  });

  it('a live edit lease refuses APPROVE at once with RESOURCE_EDIT_LOCKED; REJECT is not affected', async () => {
    const f = await buildFixture();
    await acquireLease(f, f.admin2S);
    const before = await snapshot(f);
    const started = Date.now();
    expect(await codeOf(decide(f.admin, approve(f)))).toBe('RESOURCE_EDIT_LOCKED');
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await snapshot(f)).toEqual(before);
    expect((await decide(f.admin, reject(f))).result.cancellation.status).toBe('REJECTED');
  });

  it('a withdrawn case cannot be decided', async () => {
    const f = await buildFixture();
    const mira = await pool.query("SELECT a.id FROM accounts a JOIN employees e ON e.account_id = a.id WHERE e.id = $1", [f.miraId]);
    const miraS = await createSyntheticSession(realSessionService(pool), { companyId: f.companyId, accountId: mira.rows[0].id } as never);
    const w = await request(app.getHttpServer()).post(`/api/v1/cancellation-requests/${f.caseId}/withdraw`)
      .set('Origin', ORIGIN).set('Cookie', miraS.cookie).set('X-CSRF-Token', miraS.csrf);
    expect(w.status).toBe(200);
    expect(await codeOf(decide(f.admin, approve(f)))).toBe('REPLACEMENT_NEED_NOT_OPEN');
  });

  it.each([
    ['a SELECTED offer under an OPEN case', (f: Fixture) => pool.query("UPDATE replacement_offers SET status = 'SELECTED', decided_at = greatest(created_at, updated_at), updated_at = greatest(created_at, updated_at) WHERE id = $1", [f.offerIds[0]])],
    ['an OPEN case whose need is CLOSED', (f: Fixture) => pool.query("UPDATE replacement_needs SET status = 'CLOSED' WHERE id = $1", [f.needId])],
    ['an OPEN case whose membership is no longer ACTIVE', (f: Fixture) => pool.query("UPDATE plan_assignments SET state = 'REMOVED', removed_at = clock_timestamp() WHERE id = $1", [f.membershipId])],
  ])('contradictory state (%s) fails closed with no business write', async (_n, corrupt) => {
    const f = await buildFixture();
    await corrupt(f);
    const before = await snapshot(f);
    const code = await codeOf(decide(f.admin, approve(f)));
    expect(['ERROR', 'CANCELLATION_ASSIGNMENT_NOT_ACTIVE']).toContain(code);
    expect(await codeOf(decide(f.admin, reject(f)))).not.toBe('RESOLVED');
    expect(await snapshot(f)).toEqual(before);
  });
});

describe('S2 tenant, actor, role and session', () => {
  it('another tenant, an unknown id and a malformed id are concealed as 404 before any claim', async () => {
    const f = await buildFixture();
    const before = await snapshot(f);
    expect(await codeOf(decide(f.foreignAdmin, approve(f)))).toBe('RESOURCE_NOT_FOUND');
    expect(await codeOf(decide(f.foreignAdmin, reject(f)))).toBe('RESOURCE_NOT_FOUND');
    expect(await codeOf(decide(f.admin, { decision: 'REJECT', requestId: randomUUID() }))).toBe('RESOURCE_NOT_FOUND');
    expect(await codeOf(decide(f.admin, { decision: 'REJECT', requestId: 'not-a-uuid' }))).toBe('RESOURCE_NOT_FOUND');
    expect(await snapshot(f)).toEqual(before);
    expect(await receipts(f)).toEqual([]);
    expect(Number(await value("SELECT count(*) FROM idempotency_records WHERE operation = 'DECIDE_CANCELLATION' AND actor_account_id = $1", [f.foreignAdmin.accountId]))).toBe(0);
  });

  it('an EMPLOYEE context is refused with 403 ACTION_FORBIDDEN and writes nothing', async () => {
    const f = await buildFixture();
    const before = await snapshot(f);
    expect(await codeOf(decide(f.employee, reject(f)))).toBe('ACTION_FORBIDDEN');
    expect(await codeOf(decide({ ...f.employee, role: 'COMPANY_ADMIN' }, reject(f)))).toBe('ACTION_FORBIDDEN');
    expect(await snapshot(f)).toEqual(before);
  });

  it('a revoked session is refused before any claim', async () => {
    const f = await buildFixture();
    await pool.query('UPDATE sessions SET revoked_at = clock_timestamp() WHERE id = $1', [f.admin.sessionId]);
    expect(await codeOf(decide(f.admin, reject(f)))).toBe('SESSION_REVOKED');
    expect(await receipts(f)).toEqual([]);
  });

  it.each([
    ['revoked', 'UPDATE sessions SET revoked_at = clock_timestamp() WHERE id = $1', 'SESSION_REVOKED'],
    ['expired', "UPDATE sessions SET created_at = clock_timestamp() - interval '2 days', last_seen_at = clock_timestamp() - interval '2 days', absolute_expires_at = clock_timestamp() - interval '1 day' WHERE id = $1", 'SESSION_EXPIRED'],
  ])('a session %s while the decision waits on a business lock is refused after the wait, with no business write', async (_n, sql, code) => {
    const f = await buildFixture();
    const before = await snapshot(f);
    const held = await holdDuty(f);
    const pending = codeOf(decide(f.admin, approve(f)));
    try {
      await waitForLockWaiter(held.pid);
      await pool.query(sql, [f.admin.sessionId]);
    } finally {
      await held.release();
    }
    expect(await pending).toBe(code);
    expect(await snapshot(f)).toEqual(before);
    expect((await receipts(f)).every((r) => r.state !== 'COMPLETED')).toBe(true);
  });
});

describe('S2 idempotency (S1 receipt contract)', () => {
  it('same key and payload replays the decision-time snapshot after later duty modification, with no new write or audit', async () => {
    const f = await buildFixture();
    const key = randomUUID();
    const first = await decide(f.admin, approve(f), key);
    await pool.query("UPDATE duties SET concurrency_version = concurrency_version + 5, updated_at = clock_timestamp() WHERE id = $1", [f.dutyId]);
    await pool.query("UPDATE employees SET last_name = 'Renamed' WHERE id = $1", [f.miraId]);
    const before = await snapshot(f);
    const stored = await receipts(f);
    const replay = await decide(f.admin, approve(f), key);
    expect(replay).toEqual({ result: first.result, replayed: true });
    expect(replay.result.updatedDuty?.concurrencyVersion).toBe(2);
    expect(await snapshot(f)).toEqual(before);
    expect(await receipts(f)).toEqual(stored);
  });

  it('REJECT replays with the same key; the fingerprint carries no version', async () => {
    const f = await buildFixture();
    const key = randomUUID();
    const first = await decide(f.admin, reject(f), key);
    expect(await decide(f.admin, reject(f), key)).toEqual({ result: first.result, replayed: true });
  });

  it.each([
    ['REJECT after APPROVE', (f: Fixture) => reject(f)],
    ['APPROVE with another expectedDutyVersion', (f: Fixture) => approve(f, 1, 7)],
    ['APPROVE with another expectedNeedVersion', (f: Fixture) => approve(f, 7, 1)],
  ])('same key, different payload (%s) is 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST', async (_n, cmd) => {
    const f = await buildFixture();
    const key = randomUUID();
    await decide(f.admin, approve(f), key);
    const before = await snapshot(f);
    expect(await codeOf(decide(f.admin, cmd(f), key))).toBe('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST');
    expect(await snapshot(f)).toEqual(before);
  });

  it('a different key after a finished decision is a business conflict, not a replay', async () => {
    const f = await buildFixture();
    await decide(f.admin, approve(f));
    expect(await codeOf(decide(f.admin, approve(f)))).toBe('CANCELLATION_ALREADY_RESOLVED');
  });

  it.each([
    ['identical payload', (f: Fixture) => approve(f)],
    ['changed payload', (f: Fixture) => approve(f, 2, 2)],
  ])('an expired key with %s re-evaluates business state: 409, no old 200, no write', async (_n, cmd) => {
    const f = await buildFixture();
    const key = randomUUID();
    await decide(f.admin, approve(f), key);
    await pool.query(
      `UPDATE idempotency_records SET created_at = clock_timestamp() - interval '3 days', claimed_at = clock_timestamp() - interval '3 days',
         completed_at = clock_timestamp() - interval '3 days' + interval '1 second', expires_at = clock_timestamp() - interval '1 day'
       WHERE company_id = $1 AND operation = 'DECIDE_CANCELLATION'`,
      [f.companyId],
    );
    const before = await snapshot(f);
    expect(await codeOf(decide(f.admin, cmd(f), key))).toBe('CANCELLATION_ALREADY_RESOLVED');
    expect(await snapshot(f)).toEqual(before);
    expect((await receipts(f)).map((r) => r.state)).toEqual(['FAILED']);
  });

  it('an in-progress claim refuses the same key; once stale it is reclaimed and the decision commits once', async () => {
    const f = await buildFixture();
    const key = randomUUID();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await reserveCommand(c, {
        tenant: f.admin, operation: DECIDE_CANCELLATION, keyHash: (await import('node:crypto')).createHash('sha256').update(key).digest(),
        requestHash: decisionFingerprint({ decision: 'REJECT', requestId: f.caseId }), lockId: '42', retention: 86400, stale: 300,
        replay: () => Promise.reject(new Error('unexpected replay')),
      });
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    expect(await codeOf(decide(f.admin, reject(f), key))).toBe('IDEMPOTENCY_REQUEST_IN_PROGRESS');
    await pool.query(
      "UPDATE idempotency_records SET created_at = clock_timestamp() - interval '1 hour', claimed_at = clock_timestamp() - interval '1 hour' WHERE company_id = $1 AND operation = 'DECIDE_CANCELLATION'",
      [f.companyId],
    );
    expect((await decide(f.admin, reject(f), key)).replayed).toBe(false);
    expect((await receipts(f)).map((r) => r.state)).toEqual(['COMPLETED']);
  });
});

describe('S2 audit and boundary failure: total rollback', () => {
  const approveBoundaries: [string, string, number][] = [
    ['duty update', 'UPDATE public.duties', 1],
    ['membership removal', 'UPDATE public.plan_assignments', 1],
    ['offer finalization', "SET status='NOT_SELECTED'", 1],
    ['cancellation transition', 'UPDATE public.cancellation_requests', 1],
    ['need transition', 'UPDATE public.replacement_needs', 1],
    ...[1, 2, 3, 4, 5, 6].map((n): [string, string, number] => [`audit row ${n} of 6`, 'INSERT INTO audit_event', n]),
    ['receipt completion', "SET state='COMPLETED'", 1],
  ];
  it.each(approveBoundaries)('APPROVE failure at %s rolls back everything; FAILED; the same key retries once', async (_n, match, nth) => {
    const f = await buildFixture();
    const before = await snapshot(f);
    const key = randomUUID();
    db.failAt = { match, nth };
    expect(await codeOf(decide(f.admin, approve(f), key))).toBe('ERROR');
    expect(await snapshot(f)).toEqual(before);
    expect((await receipts(f)).map((r) => r.state)).toEqual(['FAILED']);
    const mark = await auditBaseline(f.companyId);
    expect((await decide(f.admin, approve(f), key)).replayed).toBe(false);
    expect(await auditSince(f.companyId, mark)).toHaveLength(6);
    expect((await receipts(f)).map((r) => r.state)).toEqual(['COMPLETED']);
  });
  it.each([1, 2, 3, 4])('REJECT failure at audit row %i of 4 rolls back everything', async (nth) => {
    const f = await buildFixture();
    const before = await snapshot(f);
    db.failAt = { match: 'INSERT INTO audit_event', nth };
    expect(await codeOf(decide(f.admin, reject(f)))).toBe('ERROR');
    expect(await snapshot(f)).toEqual(before);
  });
  it('a refused or replayed decision emits no success audit', async () => {
    const f = await buildFixture();
    const key = randomUUID();
    await decide(f.admin, reject(f), key);
    const mark = await auditBaseline(f.companyId);
    await decide(f.admin, reject(f), key);
    await codeOf(decide(f.admin2, reject(f)));
    await codeOf(decide(f.admin, approve(f), key));
    expect(await auditSince(f.companyId, mark)).toEqual([]);
  });
});

describe('S2 races with real row locks (barrier on the duty row)', () => {
  /** Parks `first` behind the test's duty lock, then queues `second` behind `first`, then releases. */
  async function ordered<A, B>(f: Fixture, first: () => Promise<A>, second: () => Promise<B>) {
    const held = await holdDuty(f);
    let a: Promise<A>, b: Promise<B>;
    try {
      a = first();
      const firstWaiter = await waitForLockWaiter(held.pid);
      b = second();
      await waitForLockWaiter(firstWaiter.pid);
    } finally {
      await held.release();
    }
    return Promise.all([a!, b!].map((p) => (p as Promise<unknown>).then((v) => v, (e) => e))) as Promise<[unknown, unknown]>;
  }
  const httpStatus = (r: unknown) => (r as { status: number }).status;
  const httpCode = (r: unknown) => (r as { body: { code?: string } }).body.code;
  const decisionCode = (r: unknown) => (r instanceof Error ? (((r as { getResponse?: () => { code?: string } }).getResponse?.()?.code) ?? 'ERROR') : 'OK');

  it.each(['APPROVE', 'REJECT'] as const)('SP-20 selection first, then SP-21 %s: selection wins, decision gets 409', async (decision) => {
    const f = await buildFixture();
    const [sel, dec] = await ordered(f, () => Promise.resolve(selectHttp(f, f.admin2S, f.offerIds[0])), () => decide(f.admin, decision === 'APPROVE' ? approve(f) : reject(f)));
    expect(httpStatus(sel)).toBe(200);
    expect(decisionCode(dec)).toBe('CANCELLATION_ALREADY_RESOLVED');
    expect(await value('SELECT status FROM replacement_needs WHERE id = $1', [f.needId])).toBe('RESOLVED');
    expect(await value('SELECT status FROM cancellation_requests WHERE id = $1', [f.caseId])).toBe('APPROVED');
  });

  it.each([
    ['APPROVE', 'CANCELLATION_ALREADY_RESOLVED', 'OPEN_UNFILLED'],
    ['REJECT', 'REPLACEMENT_NEED_NOT_OPEN', 'CLOSED'],
  ] as const)('SP-21 %s first, then SP-20 selection: decision wins, selection gets 409 %s', async (decision, selectionCode, needStatus) => {
    const f = await buildFixture();
    const [dec, sel] = await ordered(f, () => decide(f.admin, decision === 'APPROVE' ? approve(f) : reject(f)), () => Promise.resolve(selectHttp(f, f.admin2S, f.offerIds[0])));
    expect(decisionCode(dec)).toBe('OK');
    expect(httpStatus(sel)).toBe(409);
    expect(httpCode(sel)).toBe(selectionCode);
    expect(await value('SELECT status FROM replacement_needs WHERE id = $1', [f.needId])).toBe(needStatus);
    expect(Number(await value("SELECT count(*) FROM plan_assignments WHERE company_id = $1 AND source = 'REPLACEMENT'", [f.companyId]))).toBe(0);
  });

  it('two admins deciding APPROVE and REJECT with different keys: exactly one winner, loser 409', async () => {
    const f = await buildFixture();
    const [a, b] = await ordered(f, () => decide(f.admin, approve(f)), () => decide(f.admin2, reject(f)));
    expect(decisionCode(a)).toBe('OK');
    expect(decisionCode(b)).toBe('CANCELLATION_ALREADY_RESOLVED');
    expect(Number(await value("SELECT count(*) FROM idempotency_records WHERE company_id = $1 AND operation = 'DECIDE_CANCELLATION' AND state = 'COMPLETED'", [f.companyId]))).toBe(1);
  });

  async function removeDuty(f: Fixture, token: string) {
    return request(app.getHttpServer())
      .delete(`/api/v1/monthly-plans/${f.planId}/entries/${f.dutyId}`)
      .set('Origin', ORIGIN).set('Cookie', f.admin2S.cookie).set('X-CSRF-Token', f.admin2S.csrf)
      .set('Expected-Version', '1').set('Edit-Lease-Token', token);
  }
  it('planning duty removal (reconciler) first, then REJECT: case becomes OBSOLETE, REJECT gets 409', async () => {
    const f = await buildFixture();
    const token = await acquireLease(f, f.admin2S);
    const [rem, dec] = await ordered(f, () => Promise.resolve(removeDuty(f, token)), () => decide(f.admin, reject(f)));
    expect(httpStatus(rem)).toBe(204);
    expect(decisionCode(dec)).toBe('REPLACEMENT_NEED_NOT_OPEN');
    expect(await value('SELECT status FROM cancellation_requests WHERE id = $1', [f.caseId])).toBe('OBSOLETE');
  });
  it('REJECT first, then planning duty removal: case stays REJECTED, removal commits afterwards', async () => {
    const f = await buildFixture();
    const token = await acquireLease(f, f.admin2S);
    const [dec, rem] = await ordered(f, () => decide(f.admin, reject(f)), () => Promise.resolve(removeDuty(f, token)));
    expect(decisionCode(dec)).toBe('OK');
    expect(httpStatus(rem)).toBe(204);
    expect(await value('SELECT status FROM cancellation_requests WHERE id = $1', [f.caseId])).toBe('REJECTED');
    expect(await value('SELECT removed_at IS NOT NULL AS r FROM duties WHERE id = $1', [f.dutyId])).toBe(true);
  });
});

describe('S2 runtime command validation (TL review PR #127, fail closed)', () => {
  const invalid: [string, (f: Fixture) => unknown][] = [
    ['unsupported decision CANCEL', (f) => ({ decision: 'CANCEL', requestId: f.caseId })],
    ['missing decision', (f) => ({ requestId: f.caseId })],
    ['lower-case reject', (f) => ({ decision: 'reject', requestId: f.caseId })],
    ['null command', () => null],
    ['REJECT with a non-null replacementOfferId', (f) => ({ decision: 'REJECT', requestId: f.caseId, replacementOfferId: f.offerIds[0] })],
    ['APPROVE with a non-null replacementOfferId', (f) => ({ ...approve(f), replacementOfferId: f.offerIds[0] })],
    ['APPROVE without versions', (f) => ({ decision: 'APPROVE', requestId: f.caseId })],
    ['APPROVE with string versions', (f) => ({ decision: 'APPROVE', requestId: f.caseId, expectedNeedVersion: '1', expectedDutyVersion: '1' })],
    ['APPROVE with version 0', (f) => approve(f, 0, 1)],
    ['REJECT carrying expectedDutyVersion', (f) => ({ decision: 'REJECT', requestId: f.caseId, expectedDutyVersion: 1 })],
    ['unknown field', (f) => ({ decision: 'REJECT', requestId: f.caseId, companyId: f.companyId })],
  ];
  it.each(invalid)('%s: 400 VALIDATION_FAILED, no claim, no business write, no audit', async (_n, build) => {
    const f = await buildFixture();
    const before = await snapshot(f);
    const key = randomUUID();
    expect(await codeOf(service.decide(f.admin, build(f) as CancellationDecisionCommand, key, randomUUID()))).toBe('VALIDATION_FAILED');
    expect(await snapshot(f)).toEqual(before);
    expect(await receipts(f)).toEqual([]);
    // The same key is still unused: a valid command afterwards decides normally.
    expect((await decide(f.admin, reject(f), key)).result.cancellation.status).toBe('REJECTED');
  });
  it('valid APPROVE and REJECT with an explicit null replacementOfferId still decide', async () => {
    const a = await buildFixture();
    expect((await decide(a.admin, { ...approve(a), replacementOfferId: null })).result.cancellation.status).toBe('APPROVED');
    const r = await buildFixture();
    expect((await decide(r.admin, { ...reject(r), replacementOfferId: null })).result.cancellation.status).toBe('REJECTED');
  });
});
