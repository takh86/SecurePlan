/** Additive A2 schema on a fresh isolated database on the verified disposable cluster. */
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { assertEmployeeMonthReceiptSchema } from '../src/modules/planning/employee-month-receipt-schema.js';
import { isolatedPlanningDatabase } from './helpers/isolated-planning-database.js';
import {
  createSyntheticProject,
  createSyntheticTenant,
  type SyntheticTenant,
} from './helpers/synthetic-tenants.js';
import { createStaff, insertPlan } from './helpers/planning-fixtures.js';

let db: Awaited<ReturnType<typeof isolatedPlanningDatabase>>,
  a: SyntheticTenant,
  b: SyntheticTenant;
let plan: string,
  foreignPlan: string,
  employee: string,
  foreignEmployee: string;
let oldRows: Record<string, unknown>[];
beforeAll(async () => {
  db = await isolatedPlanningDatabase(async (pool, file) => {
    if (file !== '0015_employee_month_save.sql') return;
    const t = await createSyntheticTenant(pool, 'Pre-A2 Publish');
    const p = await insertPlan(
      pool,
      t.companyId,
      (await createSyntheticProject(pool, t.companyId)).projectId,
      '2027-01-01',
    );
    await pool.query(
      `INSERT INTO idempotency_records(company_id,actor_account_id,operation,key_hash,request_hash,state,result_plan_id,completed_at,expires_at)
      VALUES($1,$2,'INITIAL_PUBLISH',$3,$4,'COMPLETED',$5,clock_timestamp(),clock_timestamp()+interval '24 hours'),
      ($1,$2,'INITIAL_PUBLISH',$6,$7,'IN_PROGRESS',NULL,NULL,clock_timestamp()+interval '24 hours')`,
      [
        t.companyId,
        t.admin.accountId,
        randomBytes(32),
        randomBytes(32),
        p,
        randomBytes(32),
        randomBytes(32),
      ],
    );
    oldRows = (
      await pool.query('SELECT * FROM idempotency_records ORDER BY id')
    ).rows;
  });
  a = await createSyntheticTenant(db.pool, 'A2 schema A');
  b = await createSyntheticTenant(db.pool, 'A2 schema B');
  plan = await insertPlan(
    db.pool,
    a.companyId,
    (await createSyntheticProject(db.pool, a.companyId)).projectId,
    '2027-01-01',
  );
  foreignPlan = await insertPlan(
    db.pool,
    b.companyId,
    (await createSyntheticProject(db.pool, b.companyId)).projectId,
    '2027-01-01',
  );
  employee = (await createStaff(db.pool, a.companyId)).employeeId;
  foreignEmployee = (await createStaff(db.pool, b.companyId)).employeeId;
});
afterAll(async () => {
  await db?.close();
});
async function probe(fn: (c: PoolClient, id: string) => Promise<void>) {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query<{ id: string }>(
      `INSERT INTO public.idempotency_records(company_id,actor_account_id,operation,key_hash,request_hash,context_plan_id,context_employee_id,expires_at)
      VALUES($1,$2,'EMPLOYEE_MONTH_SAVE',$3,$4,$5,$6,clock_timestamp()+interval '24 hours') RETURNING id`,
      [
        a.companyId,
        a.admin.accountId,
        randomBytes(32),
        randomBytes(32),
        plan,
        employee,
      ],
    );
    await fn(c, r.rows[0].id);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
it('receipt schema signature matches the actually migrated PostgreSQL 17 catalogue', async () => {
  await probe(async (c) => {
    await assertEmployeeMonthReceiptSchema(c);
  });
});
it('0015 preserves pre-existing completed and in-progress INITIAL_PUBLISH rows byte-for-byte in all old columns', async () => {
  const now = (
    await db.pool.query(
      "SELECT * FROM idempotency_records WHERE operation='INITIAL_PUBLISH' ORDER BY id",
    )
  ).rows;
  expect(now).toEqual(
    oldRows.map((row) => ({
      ...row,
      context_plan_id: null,
      context_employee_id: null,
      result_json: null,
      result_schema_version: null,
      result_cancellation_request_id: null,
    })),
  );
});
it.each(['plan', 'employee'] as const)(
  'tenant-safe context %s FK rejects cross-tenant identity',
  async (kind) => {
    await probe(async (c, id) => {
      await expect(
        c.query(
          `UPDATE idempotency_records SET ${kind === 'plan' ? 'context_plan_id' : 'context_employee_id'}=$2 WHERE id=$1`,
          [id, kind === 'plan' ? foreignPlan : foreignEmployee],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });
  },
);
it.each([
  'context_plan_id=NULL',
  'context_employee_id=NULL',
  "result_json='{}'::jsonb",
  'result_schema_version=2',
  "state='COMPLETED',result_plan_id=context_plan_id,completed_at=clock_timestamp()",
])('rejects malformed A2 claim/completion: %s', async (change) => {
  await probe(async (c, id) => {
    await expect(
      c.query(`UPDATE idempotency_records SET ${change} WHERE id=$1`, [id]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
it('rejects an oversized receipt using UTF-8 text byte length, not compressed storage size', async () => {
  await probe(async (c, id) => {
    const result = {
      commandId: plan,
      outcome: 'NO_OP',
      completedAt: '2027-01-01T00:00:00Z',
      plan: { id: plan },
      employeeId: employee,
      counts: {},
      changes: [],
      padding: 'ä'.repeat(70000),
    };
    await expect(
      c.query(
        `UPDATE idempotency_records SET state='COMPLETED',result_plan_id=context_plan_id,completed_at=clock_timestamp(),result_schema_version=2,result_json=$2::jsonb WHERE id=$1`,
        [id, JSON.stringify(result)],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
it('rejects 63 slot changes at the storage boundary', async () => {
  await probe(async (c, id) => {
    const result = {
      commandId: plan,
      outcome: 'APPLIED',
      completedAt: '2027-01-01T00:00:00Z',
      plan: { id: plan },
      employeeId: employee,
      counts: {},
      changes: Array(63).fill({}),
    };
    await expect(
      c.query(
        `UPDATE idempotency_records SET state='COMPLETED',result_plan_id=context_plan_id,completed_at=clock_timestamp(),result_schema_version=2,result_json=$2::jsonb WHERE id=$1`,
        [id, JSON.stringify(result)],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
it('legacy INITIAL_PUBLISH records retain original null context/receipt columns and completion', async () => {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query<{ id: string }>(
      `INSERT INTO idempotency_records(company_id,actor_account_id,operation,key_hash,request_hash,expires_at)
      VALUES($1,$2,'INITIAL_PUBLISH',$3,$4,clock_timestamp()+interval '24 hours') RETURNING id`,
      [a.companyId, a.admin.accountId, randomBytes(32), randomBytes(32)],
    );
    await c.query(
      "UPDATE idempotency_records SET state='COMPLETED',result_plan_id=$2,completed_at=clock_timestamp() WHERE id=$1",
      [r.rows[0].id, plan],
    );
    expect(
      (
        await c.query(
          'SELECT context_plan_id,context_employee_id,result_json,result_schema_version,result_cancellation_request_id FROM idempotency_records WHERE id=$1',
          [r.rows[0].id],
        )
      ).rows[0],
    ).toEqual({
      context_plan_id: null,
      context_employee_id: null,
      result_json: null,
      result_schema_version: null,
      result_cancellation_request_id: null,
    });
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
it('signature refuses missing constraints and changed receipt column type', async () => {
  for (const ddl of [
    'ALTER TABLE idempotency_records DROP CONSTRAINT ck_idempotency_records__employee_month',
    'ALTER TABLE idempotency_records ALTER COLUMN result_schema_version TYPE integer',
  ]) {
    await probe(async (c) => {
      await c.query(ddl);
      await expect(assertEmployeeMonthReceiptSchema(c)).rejects.toThrow(
        'Unusable employee-month receipt schema',
      );
    });
  }
});
it('PostgreSQL SHA-256 matches the UTF-8 array golden at safe-integer precision', async () => {
  const tuple = [
    'EMPLOYEE_MONTH_CREATION_V1',
    '10000000-0000-4000-8000-000000000001',
    '2028-02-01',
    'Europe/Berlin',
    [
      '2027-01-01',
      [
        ['30000000-0000-4000-8000-000000000001', 'DAY', '06:00', '18:00'],
        ['30000000-0000-4000-8000-000000000002', 'NIGHT', '18:00', '06:00'],
      ],
    ],
    [
      '40000000-0000-4000-8000-000000000001',
      9007199254740991,
      '0001-01-01',
      [1, 2, 3, 4, 5, 6, 7],
    ],
    'D6_V1',
  ];
  const r = await db.pool.query<{ digest: string }>(
    "SELECT encode(sha256(convert_to(replace(($1::jsonb)::text,', ',','),'UTF8')),'hex') AS digest",
    [JSON.stringify(tuple)],
  );
  expect(r.rows[0].digest).toBe(
    'a8bf618a8036cfb70a64a50cff578c753026906194c5904e60d52b6ff51067ec',
  );
});
