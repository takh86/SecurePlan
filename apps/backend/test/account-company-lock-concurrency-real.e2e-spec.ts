/**
 * LOCK-01 regression on PostgreSQL 17. The company-exclusive writer exists
 * ONLY in this test: production companies remain a SHARE-only leaf.
 * Gates + pg_blocking_pids prove waits. NOWAIT probes expose the forbidden
 * company -> account inversion without requiring a scheduled deadlock.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { assertActorInTransaction } from '../src/auth/authorization/actor-in-transaction.js';
import { BusinessAuditService } from '../src/modules/audit/business-audit.service.js';
import { lockAccountsPrefix } from '../src/modules/identity/account-prefix-lock.js';
import { adminContext } from './helpers/planning-fixtures.js';
import {
  backendPid, createSyntheticProject, createSyntheticTenant, openLocalTestPool,
  removeSyntheticTenants, type SyntheticProject, type SyntheticTenant, type TestPool,
} from './helpers/synthetic-tenants.js';

type Transaction = { client: PoolClient; pid: number; open: boolean };
let pool: TestPool;
let tenant: SyntheticTenant;
let project: SyntheticProject;
const companies: string[] = [];
const held: Transaction[] = [];
const pending: Promise<unknown>[] = [];
const helpers = [
  ['legacy joined', assertActorInTransaction],
  ['sequential', lockAccountsPrefix],
] as const;

async function begin(): Promise<Transaction> {
  const client = await pool.connect();
  const tx = { client, pid: 0, open: true };
  held.push(tx);
  await client.query("BEGIN; SET LOCAL lock_timeout = '4s'; SET LOCAL statement_timeout = '8s'");
  tx.pid = await backendPid(client);
  return tx;
}

async function finish(tx: Transaction, outcome: 'COMMIT' | 'ROLLBACK'): Promise<void> {
  if (!tx.open) return;
  tx.open = false;
  try { await tx.client.query(outcome); } finally { tx.client.release(); }
}

function start<T>(work: Promise<T>) {
  // Attach rejection handlers immediately, even while the test observes a wait.
  const result = work.then((value) => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
  pending.push(result);
  return result;
}

async function blocked(waiter: Transaction, holder: Transaction): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ blocked: boolean }>('SELECT $1::int = ANY(pg_blocking_pids($2)) AS blocked', [holder.pid, waiter.pid]);
    if (result.rows[0].blocked) return;
  }
  throw new Error('Expected lock wait was not observed');
}

async function createPlan(tx: Transaction, helper: (typeof helpers)[number][1]): Promise<void> {
  await helper(tx.client, adminContext(tenant.admin), ['COMPANY_ADMIN']);
  const id = randomUUID();
  await tx.client.query(`INSERT INTO public.monthly_plans (id, company_id, project_id, planning_month)
    VALUES ($1, $2, $3, '2027-01-01')`, [id, tenant.companyId, project.projectId]);
  await new BusinessAuditService().recordBusinessAction(tx.client, {
    companyId: tenant.companyId, actorAccountId: tenant.admin.accountId,
    action: 'MONTHLY_PLAN_CREATED', resourceType: 'MONTHLY_PLAN', resourceId: id,
    newValues: { projectId: project.projectId, monthStart: '2027-01-01', status: 'UNPUBLISHED' }, correlationId: randomUUID(),
  });
}

/** Hypothetical company writer following the account -> company ordering. */
async function suspendCompany(tx: Transaction): Promise<void> {
  await tx.client.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [tenant.admin.accountId]);
  await tx.client.query("UPDATE companies SET status = 'SUSPENDED' WHERE id = $1", [tenant.companyId]);
}

async function assertRows(count: number): Promise<void> {
  expect((await pool.query('SELECT count(*)::int AS n FROM public.monthly_plans WHERE company_id = $1', [tenant.companyId])).rows[0].n).toBe(count);
  expect((await pool.query('SELECT count(*)::int AS n FROM audit_event WHERE company_id = $1', [tenant.companyId])).rows[0].n).toBe(count);
}

beforeAll(() => { pool = openLocalTestPool(8); });
beforeEach(async () => {
  tenant = await createSyntheticTenant(pool, 'SP79 LOCK-01');
  companies.push(tenant.companyId);
  project = await createSyntheticProject(pool, tenant.companyId, 'SP79 LOCK-01');
});
afterEach(async () => {
  // Release blockers before draining requests, including after a failed assertion.
  for (const tx of held.splice(0).reverse()) await finish(tx, 'ROLLBACK');
  await Promise.allSettled(pending.splice(0));
});
afterAll(async () => { await removeSyntheticTenants(pool, companies); await pool.end(); });

describe.each(helpers)('LOCK-01: %s helper vs test-only company writer', (_name, helper) => {
  it.each(['COMMIT', 'ROLLBACK'] as const)('company writer first, %s: helper waits and rechecks company; plan/audit are atomic', async (outcome) => {
    const writer = await begin();
    await suspendCompany(writer);
    const worker = await begin();
    const command = start(createPlan(worker, helper));
    await blocked(worker, writer);
    await finish(writer, outcome);
    const result = await command;
    if (outcome === 'COMMIT') {
      expect(result.error).toMatchObject({ response: { code: 'SESSION_REVOKED' } });
      await finish(worker, 'ROLLBACK');
      await assertRows(0);
    } else {
      expect(result.error).toBeUndefined();
      await finish(worker, 'COMMIT');
      await assertRows(1);
    }
    expect((await pool.query('SELECT status FROM companies WHERE id = $1', [tenant.companyId])).rows[0].status)
      .toBe(outcome === 'COMMIT' ? 'SUSPENDED' : 'ACTIVE');
  });

  it.each(['COMMIT', 'ROLLBACK'] as const)('helper first, %s: writer waits for account protection; both final outcomes persist correctly', async (outcome) => {
    const worker = await begin();
    await createPlan(worker, helper);
    const writer = await begin();
    const change = start(suspendCompany(writer));
    await blocked(writer, worker);
    await finish(worker, outcome);
    expect((await change).error).toBeUndefined();
    await finish(writer, 'COMMIT');
    await assertRows(outcome === 'COMMIT' ? 1 : 0);
    expect((await pool.query('SELECT status FROM companies WHERE id = $1', [tenant.companyId])).rows[0].status).toBe('SUSPENDED');
  });

  it.each(['COMMIT', 'ROLLBACK'] as const)('company-only exclusive gate, %s: account lock is already held; inverted writer fails NOWAIT without a deadlock assertion', async (outcome) => {
    const writer = await begin();
    await writer.client.query("UPDATE companies SET status = 'SUSPENDED' WHERE id = $1", [tenant.companyId]);
    const worker = await begin();
    const command = start(createPlan(worker, helper));
    await blocked(worker, writer);
    // This proves the account is held while the helper waits for the company
    // on this PG17 execution. The joined helper is still not an ordering API.
    await writer.client.query('SAVEPOINT inversion_probe');
    await expect(writer.client.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE NOWAIT', [tenant.admin.accountId]))
      .rejects.toMatchObject({ code: '55P03' });
    await writer.client.query('ROLLBACK TO SAVEPOINT inversion_probe');
    await finish(writer, outcome);
    const result = await command;
    expect(result.error).toEqual(outcome === 'COMMIT' ? expect.objectContaining({ response: { code: 'SESSION_REVOKED' } }) : undefined);
    await finish(worker, outcome === 'COMMIT' ? 'ROLLBACK' : 'COMMIT');
    await assertRows(outcome === 'COMMIT' ? 0 : 1);
  });
});

it.each(['COMMIT', 'ROLLBACK'] as const)('legacy and sequential helpers coexist under a company SHARE leaf; first helper %s', async (outcome) => {
  const legacy = await begin();
  await assertActorInTransaction(legacy.client, adminContext(tenant.admin), ['COMPANY_ADMIN']);
  const sequential = await begin();
  await lockAccountsPrefix(sequential.client, adminContext(tenant.admin), ['COMPANY_ADMIN']);
  const exclusive = await begin();
  const change = start(exclusive.client.query('SELECT 1 FROM companies WHERE id = $1 FOR UPDATE', [tenant.companyId]));
  await blocked(exclusive, legacy);
  // pg_blocking_pids may expose only the currently waited-on member of a
  // multixact. Observe the remaining holder after the first one releases.
  await finish(legacy, outcome);
  await blocked(exclusive, sequential);
  await finish(sequential, 'COMMIT');
  expect((await change).error).toBeUndefined();
  await finish(exclusive, 'ROLLBACK');
  await assertRows(0);
});
