/** Real migration-0013 integrity. Each probe rolls back its own transaction. */
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { createSyntheticProject, createSyntheticTenant, openLocalTestPool, removeSyntheticTenants, type SyntheticTenant, type TestPool } from './helpers/synthetic-tenants.js';
import { insertPlan } from './helpers/planning-fixtures.js';

let pool: TestPool;
let a: SyntheticTenant;
let b: SyntheticTenant;
let planA: string;
let planB: string;
beforeAll(async () => {
  pool = openLocalTestPool(2); a = await createSyntheticTenant(pool, 'SP13 schema A'); b = await createSyntheticTenant(pool, 'SP13 schema B');
  const pa = await createSyntheticProject(pool, a.companyId); const pb = await createSyntheticProject(pool, b.companyId);
  planA = await insertPlan(pool, a.companyId, pa.projectId, '2027-01-01'); planB = await insertPlan(pool, b.companyId, pb.projectId, '2027-01-01');
});
afterAll(async () => { try { await removeSyntheticTenants(pool, [a.companyId, b.companyId]); } finally { await pool.end(); } });
async function probe(work: (client: PoolClient, id: string) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const saved = await client.query<{ id: string }>(`INSERT INTO idempotency_records(company_id,actor_account_id,operation,key_hash,request_hash,expires_at)
      VALUES($1,$2,'INITIAL_PUBLISH',$3,$4,clock_timestamp()+interval '24 hours') RETURNING id`, [a.companyId, a.admin.accountId, randomBytes(32), randomBytes(32)]);
    await work(client, saved.rows[0].id);
  } finally { await client.query('ROLLBACK'); client.release(); }
}

it('rejects another company actor reference', async () => {
  await probe(async (client, id) => {
    await expect(client.query('UPDATE idempotency_records SET actor_account_id=$2 WHERE id=$1', [id, b.admin.accountId])).rejects.toMatchObject({ code: '23503', constraint: 'fk_idempotency_records__actor' });
  });
});
it('rejects a completed result from another tenant', async () => {
  await probe(async (client, id) => {
    await expect(client.query("UPDATE idempotency_records SET state='COMPLETED', result_plan_id=$2, completed_at=clock_timestamp() WHERE id=$1", [id, planB])).rejects.toMatchObject({ code: '23503', constraint: 'fk_idempotency_records__result' });
  });
});
it('unique reservation scope includes actor and operation and contains only hashes', async () => {
  await probe(async (client, id) => {
    await expect(client.query(`INSERT INTO idempotency_records(company_id,actor_account_id,operation,key_hash,request_hash,expires_at)
      SELECT company_id,actor_account_id,operation,key_hash,request_hash,expires_at FROM idempotency_records WHERE id=$1`, [id])).rejects.toMatchObject({ code: '23505', constraint: 'uq_idempotency_records__scope' });
  });
});
it.each([
  ["key_hash=decode('ab','hex')", 'ck_idempotency_records__hashes'],
  ["request_hash=decode('ab','hex')", 'ck_idempotency_records__hashes'],
  // 0015 adds an operation/context CHECK; PostgreSQL evaluates its name first.
  // Unsupported operations still fail with 23514; valid INITIAL_PUBLISH is unchanged.
  ["operation='OTHER'", 'ck_idempotency_records__employee_month'],
  ["state='COMPLETED'", 'ck_idempotency_records__state'],
  ["state='UNKNOWN'", 'ck_idempotency_records__state'],
  ["expires_at=created_at", 'ck_idempotency_records__time'],
  ["claimed_at='infinity'", 'ck_idempotency_records__time'],
  ["completed_at=clock_timestamp()", 'ck_idempotency_records__state'],
])('rejects invalid reservation metadata %s', async (change, constraint) => {
  await probe(async (client, id) => {
    await expect(client.query(`UPDATE idempotency_records SET ${change} WHERE id=$1`, [id])).rejects.toMatchObject({ code: '23514', constraint });
  });
});
it('allows the same tenant result reference only with terminal completion metadata', async () => {
  await probe(async (client, id) => {
    await client.query("UPDATE idempotency_records SET state='COMPLETED',result_plan_id=$2,completed_at=clock_timestamp() WHERE id=$1", [id, planA]);
    expect((await client.query('SELECT state,result_plan_id FROM idempotency_records WHERE id=$1', [id])).rows[0]).toEqual({ state: 'COMPLETED', result_plan_id: planA });
  });
});
