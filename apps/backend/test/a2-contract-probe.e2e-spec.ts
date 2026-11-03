/** Engineering probe only: proposed A2 prefix, no A2 endpoint or Save implementation. */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { App } from 'supertest/types.js';
import type { TenantContext } from '../src/auth/authorization/tenant-context.js';
import { SessionService, assertSessionInTransaction } from '../src/auth/session.service.js';
import { lockAccountsPrefix } from '../src/modules/identity/account-prefix-lock.js';
import { BusinessAuditService, type BusinessAuditEntry } from '../src/modules/audit/business-audit.service.js';
import { MonthlyPlansService } from '../src/modules/planning/monthly-plans.service.js';
import { acquireDutyLease } from '../src/modules/planning/duty-edit-leases.js';
import { PLANNING_WRITER_TIMEOUTS } from '../src/modules/planning/planning-locks.js';
import { OperatingCalendarService } from '../src/modules/workforce/projects/operating-calendar.service.js';
import { bootEmployeesApp, RecordingDelivery } from './helpers/employees-test-app.js';
import { backendPid, openLocalTestPool, removeSyntheticTenants, type TestPool } from './helpers/synthetic-tenants.js';
import { dutyMutationFixture, MUTATION_MONTH, type DutyMutationFixture } from './helpers/duty-mutation-fixtures.js';
import { insertDuty, insertMembership } from './helpers/planning-fixtures.js';

function latch() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
class ProbeAudit extends BusinessAuditService {
  hook?: (client: PoolClient, entry: BusinessAuditEntry) => Promise<void>;
  override async recordBusinessAction(client: PoolClient, entry: BusinessAuditEntry) {
    await super.recordBusinessAction(client, entry);
    await this.hook?.(client, entry);
  }
}
let pool: TestPool;
let app: INestApplication<App>;
let f: DutyMutationFixture;
let tenant: TenantContext;
let audit: ProbeAudit;
const companies: string[] = [];
const pending: Promise<unknown>[] = [];
const releaseBarriers: (() => void)[] = [];

beforeAll(() => { pool = openLocalTestPool(12); });
beforeEach(async () => {
  f = await dutyMutationFixture(pool, companies);
  audit = new ProbeAudit(); app = await bootEmployeesApp(new RecordingDelivery(), { audit });
  tenant = await app.get(SessionService).validateAndTouch(f.admin.rawToken);
  const secondDuty = await insertDuty(pool, { companyId: tenant.companyId, projectId: f.project.projectId, planId: f.planId,
    month: MUTATION_MONTH, dutyDate: '2027-01-21', startsAt: '2027-01-21T05:00Z', endsAt: '2027-01-21T17:00Z' });
  await insertMembership(pool, tenant.companyId, secondDuty, f.jonas.employeeId);
  // Retained released Q row: each schedule exercises multiple D/A2 plus Q.
  const plans = app.get(MonthlyPlansService);
  const lease = await plans.acquireLease(tenant, f.planId, secondDuty);
  await plans.releaseLease(tenant, f.planId, secondDuty, lease.leaseToken);
});
afterEach(async () => {
  releaseBarriers.splice(0).forEach((release) => release());
  await Promise.allSettled(pending.splice(0)); await app.close();
});
afterAll(async () => { try { await removeSyntheticTenants(pool, companies); } finally { await pool.end(); } });

async function blockedBy(holder: number) {
  const deadline = Date.now() + 3500;
  while (Date.now() < deadline) {
    if ((await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [holder])).rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected PostgreSQL blocking edge was not observed');
}

/** Mirrors the proposed tiers on actual migrated relations. No reservation row
 * exists for A2 yet. I here is an isolated nonwaiting advisory probe scope. */
async function prefix(client: PoolClient) {
  await client.query(PLANNING_WRITER_TIMEOUTS);
  await lockAccountsPrefix(client, tenant, ['COMPANY_ADMIN']);
  await assertSessionInTransaction(client, tenant);
  expect((await client.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS held', ['880020261103'])).rows[0].held).toBe(true);
  const employees = [f.mira.employeeId, f.jonas.employeeId].sort();
  await client.query('SELECT id FROM employees WHERE company_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR NO KEY UPDATE', [tenant.companyId, employees]);
  await client.query('SELECT id FROM projects WHERE company_id = $1 AND id = $2 FOR SHARE', [tenant.companyId, f.project.projectId]);
  await client.query('SELECT id FROM project_assignments WHERE company_id = $1 AND employee_id = ANY($2::uuid[]) AND planning_month = $3::date ORDER BY id FOR SHARE', [tenant.companyId, employees, MUTATION_MONTH]);
  await client.query('SELECT id FROM monthly_plans WHERE company_id = $1 AND id = $2 FOR UPDATE', [tenant.companyId, f.planId]);
  const duties = (await client.query<{ id: string }>('SELECT id FROM duties WHERE company_id = $1 AND monthly_plan_id = $2 AND removed_at IS NULL ORDER BY id FOR UPDATE', [tenant.companyId, f.planId])).rows.map((row) => row.id);
  await client.query("SELECT id FROM plan_assignments WHERE company_id = $1 AND duty_id = ANY($2::uuid[]) AND state = 'ACTIVE' ORDER BY id FOR UPDATE", [tenant.companyId, duties]);
  await client.query('SELECT id FROM edit_leases WHERE company_id = $1 AND duty_id = ANY($2::uuid[]) ORDER BY id FOR UPDATE', [tenant.companyId, duties]);
  await assertSessionInTransaction(client, tenant);
  const liveLease = (await client.query('SELECT id FROM edit_leases WHERE company_id = $1 AND duty_id = ANY($2::uuid[]) AND released_at IS NULL AND expires_at > clock_timestamp()', [tenant.companyId, duties])).rowCount! > 0;
  const state = (await client.query(`SELECT status,
    (SELECT count(*)::int FROM duties WHERE monthly_plan_id = $2 AND removed_at IS NULL) AS duties,
    (SELECT concurrency_version::int FROM duties WHERE id = $3) AS version,
    (SELECT count(*)::int FROM project_operating_calendars WHERE project_id = $4) AS calendars
    FROM monthly_plans WHERE company_id = $1 AND id = $2`, [tenant.companyId, f.planId, f.dutyId, f.project.projectId])).rows[0];
  return { liveLease, ...state };
}

for (const writer of ['create', 'patch', 'publish', 'calendar'] as const) {
  for (const first of ['proposal', 'writer'] as const) for (const rollback of [false, true]) {
    it(`${writer}: ${first} first / ${rollback ? 'ROLLBACK' : 'COMMIT'} / observed blocking and fresh state`, async () => {
      const plans = app.get(MonthlyPlansService);
      const calendar = app.get(OperatingCalendarService);
      const baseline = await calendar.get(tenant, f.project.projectId, MUTATION_MONTH);
      const lease = writer === 'patch' ? await plans.acquireLease(tenant, f.planId, f.dutyId) : undefined;
      const command = () => writer === 'create'
        ? plans.createEntry(tenant, f.planId, { dutyDate: '2027-01-22', shiftKind: 'DAY', assignments: [{ employeeId: f.jonas.employeeId, dutyRole: 'EMPLOYEE' }] }, randomUUID())
        : writer === 'patch'
          ? plans.updateEntry(tenant, f.planId, f.dutyId, { assignments: [{ employeeId: f.mira.employeeId, dutyRole: 'SHIFT_LEAD' }] }, 1, lease!.leaseToken, randomUUID())
          : writer === 'publish'
            ? plans.publish(tenant, f.planId, randomUUID(), randomUUID())
            : calendar.replace(tenant, f.project.projectId, { effectiveFromMonth: MUTATION_MONTH, expectedExactVersion: null,
              expectedEffective: baseline.effective ? { id: baseline.effective.id, version: baseline.effective.version } : null,
              expectedNextEffectiveFromMonth: null, operatingWeekdays: [3, 4, 5], bootstrap: false }, randomUUID());
      const client = await pool.connect();
      let flight: Promise<unknown> | undefined;
      const arrived = latch(); const resume = latch(); releaseBarriers.push(resume.release);
      try {
        await client.query('BEGIN');
        if (first === 'proposal') {
          const state = await prefix(client);
          expect(state.duties).toBe(2);
          // A harmless version mutation demonstrates visibility/rollback under
          // the candidate locks. This is deliberately not a Save command.
          await client.query('UPDATE duties SET concurrency_version = concurrency_version + 1 WHERE id = $1', [f.dutyId]);
          flight = command(); const settled = flight.then((value) => ({ value }), (error: unknown) => ({ error })); pending.push(settled);
          await blockedBy(await backendPid(client));
          await client.query(rollback ? 'ROLLBACK' : 'COMMIT');
          const result = await settled;
          // Publish also discovers before its E wait and refuses changed duty
          // signatures rather than silently publishing a different snapshot.
          if ((writer === 'patch' || writer === 'publish') && !rollback) expect(result).toMatchObject({ error: { response: { code: 'PLAN_CONCURRENT_MODIFICATION' } } });
          else expect(result).toHaveProperty('value');
        } else {
          let holder = 0;
          audit.hook = async (connection) => { audit.hook = undefined; holder = await backendPid(connection); arrived.release(); await resume.promise; if (rollback) throw new Error('synthetic writer rollback'); };
          flight = command(); const settled = flight.then((value) => ({ value }), (error: unknown) => ({ error })); pending.push(settled);
          await Promise.race([arrived.promise, settled.then(() => { throw new Error('Writer did not reach audit barrier'); })]);
          const probe = prefix(client); const checked = probe.then((value) => ({ value }), (error: unknown) => ({ error })); pending.push(checked);
          await blockedBy(holder); resume.release();
          const actual = await settled;
          expect(actual).toHaveProperty(rollback ? 'error' : 'value');
          const observed = await probe;
          expect(observed.duties).toBe(writer === 'create' && !rollback ? 3 : 2);
          expect(observed.version).toBe(writer === 'patch' && !rollback ? 2 : 1);
          expect(observed.status).toBe(writer === 'publish' && !rollback ? 'PUBLISHED' : 'UNPUBLISHED');
          expect(observed.calendars).toBe(writer === 'calendar' && !rollback ? 2 : 1);
          await client.query('ROLLBACK');
        }
      } finally {
        resume.release(); await client.query('ROLLBACK').catch(() => {}); client.release();
        await flight?.catch(() => {});
      }
    });
  }
}

for (const change of ['logout', 'reset-revoke', 'role'] as const) {
  for (const first of ['proposal', 'identity'] as const) for (const rollback of [false, true]) {
    it(`session ${change}: ${first} first / ${rollback ? 'ROLLBACK' : 'COMMIT'}`, async () => {
      const holder = await pool.connect(); const follower = await pool.connect();
      let flight: Promise<unknown> | undefined;
      const identity = async (client: PoolClient) => {
        await client.query(PLANNING_WRITER_TIMEOUTS);
        await client.query('SELECT id FROM accounts WHERE company_id = $1 AND id = $2 FOR UPDATE', [tenant.companyId, tenant.accountId]);
        if (change === 'role') await client.query("UPDATE accounts SET role = 'EMPLOYEE' WHERE company_id = $1 AND id = $2", [tenant.companyId, tenant.accountId]);
        else if (change === 'reset-revoke') await app.get(SessionService).revokeAllForAccountInTransaction(client, tenant.companyId, tenant.accountId);
        else await client.query('UPDATE sessions SET revoked_at = clock_timestamp() WHERE company_id = $1 AND account_id = $2 AND id = $3', [tenant.companyId, tenant.accountId, tenant.sessionId]);
      };
      try {
        await holder.query('BEGIN'); await follower.query('BEGIN');
        if (first === 'identity') {
          await identity(holder);
          const probe = prefix(follower); flight = probe;
          const result = probe.then((value) => ({ value }), (error: unknown) => ({ error })); pending.push(result);
          await blockedBy(await backendPid(holder));
          await holder.query(rollback ? 'ROLLBACK' : 'COMMIT');
          if (rollback) expect(await result).toHaveProperty('value');
          else expect(await result).toMatchObject({ error: { status: change === 'role' ? 403 : 401,
            response: { code: change === 'role' ? 'ACTION_FORBIDDEN' : 'SESSION_REVOKED' } } });
        } else {
          await prefix(holder);
          flight = identity(follower); pending.push(flight.catch(() => {}));
          await blockedBy(await backendPid(holder));
          // A SHARE admits this transaction before revocation, including its
          // post-wait specific-session check. Identity must wait at A.
          await assertSessionInTransaction(holder, tenant);
          await holder.query(rollback ? 'ROLLBACK' : 'COMMIT'); await flight;
          await follower.query(rollback ? 'ROLLBACK' : 'COMMIT');
        }
      } finally {
        await holder.query('ROLLBACK').catch(() => {}); holder.release();
        await flight?.catch(() => {}); await follower.query('ROLLBACK').catch(() => {}); follower.release();
      }
    });
  }
}

for (const first of ['proposal', 'lease'] as const) for (const rollback of [false, true]) {
  it(`lease admission: ${first} first / ${rollback ? 'ROLLBACK' : 'COMMIT'}`, async () => {
    const holder = await pool.connect(); const follower = await pool.connect();
    let flight: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN'); await follower.query('BEGIN');
      if (first === 'proposal') {
        expect((await prefix(holder)).liveLease).toBe(false);
        flight = app.get(MonthlyPlansService).acquireLease(tenant, f.planId, f.dutyId);
        pending.push(flight.catch(() => {}));
        await blockedBy(await backendPid(holder));
        await holder.query(rollback ? 'ROLLBACK' : 'COMMIT'); await flight;
      } else {
        // Real lease helper, caller-owned transaction to permit ROLLBACK.
        await holder.query(PLANNING_WRITER_TIMEOUTS);
        await lockAccountsPrefix(holder, tenant, ['COMPANY_ADMIN']);
        await holder.query('SELECT id FROM projects WHERE id = $1 FOR SHARE', [f.project.projectId]);
        await holder.query('SELECT id FROM monthly_plans WHERE id = $1 FOR SHARE', [f.planId]);
        await holder.query('SELECT id FROM duties WHERE id = $1 FOR UPDATE', [f.dutyId]);
        await acquireDutyLease(holder, tenant, f.dutyId);
        const probe = prefix(follower); flight = probe; pending.push(probe.catch(() => {}));
        await blockedBy(await backendPid(holder));
        await holder.query(rollback ? 'ROLLBACK' : 'COMMIT');
        expect((await probe).liveLease).toBe(!rollback);
      }
    } finally {
      await holder.query('ROLLBACK').catch(() => {}); holder.release();
      await flight?.catch(() => {}); await follower.query('ROLLBACK').catch(() => {}); follower.release();
    }
  });
}
