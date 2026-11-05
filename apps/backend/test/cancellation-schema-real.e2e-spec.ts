/** Populated D15 -> D16 -> D17, exact independent ledger guard and historical receipt replay. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../src/database/database.service.js';
import { assertEmployeeMonthReceiptSchema } from '../src/modules/planning/employee-month-receipt-schema.js';
import { assertPlanningSchemaComplete } from '../src/modules/planning/planning-schema.js';
import { EmployeeMonthIdempotencyService } from '../src/modules/planning/employee-month-idempotency.service.js';
import { PublishIdempotencyService } from '../src/modules/planning/publish-idempotency.service.js';
import {
  decodeSaveResult,
  type SaveResult,
} from '../src/modules/planning/employee-month.contract.js';
import { isolatedPlanningDatabase } from './helpers/isolated-planning-database.js';
import {
  dutyMutationFixture,
  type DutyMutationFixture,
} from './helpers/duty-mutation-fixtures.js';
import type { TenantContext } from '../src/auth/authorization/tenant-context.js';
let db: Awaited<ReturnType<typeof isolatedPlanningDatabase>>,
  f: DutyMutationFixture,
  old: unknown,
  d16: unknown;
let receipt: SaveResult, cancellation: string, foreignCancellation: string;
const publishKey = randomUUID(),
  monthKey = randomUUID(),
  digest = (s: string) => createHash('sha256').update(s).digest();
const ledger = async (pool: typeof db.pool, extended = false) =>
  (
    await pool.query(
      `SELECT ${extended ? "to_jsonb(r)-'result_cancellation_request_id'-'result_replacement_offer_id'" : 'to_jsonb(r)'} AS row FROM idempotency_records r ORDER BY id`,
    )
  ).rows;
beforeAll(async () => {
  db = await isolatedPlanningDatabase(async (pool, file) => {
    if (file === '0016_cr03_reconciliation.sql') {
      f = await dutyMutationFixture(pool, []);
      await pool.query(
        "UPDATE monthly_plans SET status='PUBLISHED',published_at='2026-10-31T12:00:00Z',published_by_account_id=$2 WHERE id=$1",
        [f.planId, f.tenant.admin.accountId],
      );
      receipt = {
        commandId: randomUUID(),
        outcome: 'NO_OP',
        completedAt: '2026-11-04T12:00:00.123456Z',
        plan: {
          id: f.planId,
          projectId: f.project.projectId,
          monthStart: '2027-01-01',
          status: 'PUBLISHED',
          publishedAt: '2026-10-31T12:00:00Z',
        },
        employeeId: f.mira.employeeId,
        counts: {
          createdDuties: 0,
          changedDuties: 0,
          addedMemberships: 0,
          removedMemberships: 0,
          updatedMemberships: 0,
        },
        changes: [],
      };
      decodeSaveResult(receipt, f.planId, f.mira.employeeId);
      await pool.query(
        `INSERT INTO idempotency_records(company_id,actor_account_id,operation,key_hash,request_hash,state,result_plan_id,completed_at,expires_at)
     VALUES($1,$2,'INITIAL_PUBLISH',$3,$4,'COMPLETED',$5,clock_timestamp(),clock_timestamp()+interval '24 hours'),
     ($1,$2,'INITIAL_PUBLISH',$6,$7,'IN_PROGRESS',NULL,NULL,clock_timestamp()+interval '24 hours')`,
        [
          f.tenant.companyId,
          f.tenant.admin.accountId,
          digest(publishKey),
          digest(
            JSON.stringify(['initial-publish-v1', f.planId.toLowerCase()]),
          ),
          f.planId,
          randomBytes(32),
          randomBytes(32),
        ],
      );
      await pool.query(
        `INSERT INTO idempotency_records(company_id,actor_account_id,operation,key_hash,request_hash,state,result_plan_id,completed_at,expires_at,context_plan_id,context_employee_id,result_json,result_schema_version)
     VALUES($1,$2,'EMPLOYEE_MONTH_SAVE',$3,$4,'COMPLETED',$5,clock_timestamp(),clock_timestamp()+interval '24 hours',$5,$6,$7::jsonb,2)`,
        [
          f.tenant.companyId,
          f.tenant.admin.accountId,
          digest(monthKey),
          randomBytes(32),
          f.planId,
          f.mira.employeeId,
          JSON.stringify(receipt),
        ],
      );
      old = await ledger(pool);
    }
    if (file === '0017_cancellation_idempotency.sql') {
      d16 = await ledger(pool);
      expect(d16).toEqual(old);
    }
  });
  const pair = async (
    company: string,
    assignment: string,
    duty: string,
    employee: string,
  ) => {
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      const id = randomUUID();
      await c.query(
        'INSERT INTO cancellation_requests(id,company_id,assignment_id,duty_id,employee_id,submission_version) VALUES($1,$2,$3,$4,$5,1)',
        [id, company, assignment, duty, employee],
      );
      await c.query(
        'INSERT INTO replacement_needs(company_id,cancellation_request_id,duty_id) VALUES($1,$2,$3)',
        [company, id, duty],
      );
      await c.query('COMMIT');
      return id;
    } finally {
      c.release();
    }
  };
  cancellation = await pair(
    f.tenant.companyId,
    f.membership,
    f.dutyId,
    f.mira.employeeId,
  );
  const other = await dutyMutationFixture(db.pool, []);
  foreignCancellation = await pair(
    other.tenant.companyId,
    other.membership,
    other.dutyId,
    other.mira.employeeId,
  );
});
afterAll(async () => {
  await db?.close();
});
async function probe(work: (c: PoolClient, id: string) => Promise<void>) {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query<{ id: string }>(
      `INSERT INTO idempotency_records(company_id,actor_account_id,operation,key_hash,request_hash,expires_at)
 VALUES($1,$2,'CREATE_CANCELLATION',$3,$4,clock_timestamp()+interval '24 hours') RETURNING id`,
      [
        f.tenant.companyId,
        f.mira.account.accountId,
        randomBytes(32),
        randomBytes(32),
      ],
    );
    await work(c, r.rows[0].id);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
it('D16 and D17 preserve all historical receipt bytes, hashes, attempts and old ledger columns', async () => {
  expect(d16).toEqual(old);
  expect(await ledger(db.pool, true)).toEqual(old);
});
it('exact eight-table guard and independent D18 receipt signature both pass real PG17', async () => {
  await probe(async (c) => {
    await assertPlanningSchemaComplete(c);
    await assertEmployeeMonthReceiptSchema(c);
  });
});
it('historical INITIAL_PUBLISH and stored v2 employee-month results still replay without mutation', async () => {
  const session = (
    await db.pool.query<{ id: string }>(
      'SELECT id FROM sessions WHERE token_hash=$1',
      [digest(f.admin.rawToken)],
    )
  ).rows[0];
  const t: TenantContext = {
    companyId: f.tenant.companyId,
    accountId: f.tenant.admin.accountId,
    sessionId: session.id,
    role: 'COMPANY_ADMIN',
  };
  // Use the isolated database explicitly; never its environment connection for fixture work.
  const adapter = {
    withTransaction: async <T>(work: (c: PoolClient) => Promise<T>) => {
      const c = await db.pool.connect();
      try {
        await c.query('BEGIN');
        const r = await work(c);
        await c.query('COMMIT');
        return r;
      } catch (error) {
        await c.query('ROLLBACK');
        throw error;
      } finally {
        c.release();
      }
    },
  } as DatabaseService;
  const months = new EmployeeMonthIdempotencyService(adapter);
  expect(await months.lookup(t, f.planId, f.mira.employeeId, monthKey)).toEqual(
    { state: 'COMPLETED', result: receipt },
  );
  const publish = new PublishIdempotencyService(adapter);
  const r = await publish.execute(
    t,
    f.planId,
    publishKey,
    async (c) => {
      await assertPlanningSchemaComplete(c);
      return (
        await c.query(
          `SELECT id,project_id,planning_month::text AS month_start,status,to_char(published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS published_at FROM monthly_plans WHERE company_id=$1 AND id=$2`,
          [t.companyId, f.planId],
        )
      ).rows[0];
    },
    async () => {
      throw new Error('Historical replay must never publish again');
    },
  );
  expect(r.replayed).toBe(true);
  expect(r.result).toEqual(receipt.plan);
  expect(await ledger(db.pool, true)).toEqual(old);
});
it.each([
  "state='COMPLETED',completed_at=clock_timestamp()",
  'result_cancellation_request_id=gen_random_uuid()',
  "state='FAILED',result_cancellation_request_id=gen_random_uuid()",
  "state='COMPLETED',result_plan_id=$2,completed_at=clock_timestamp()",
  'context_plan_id=$2',
  "result_json='{}'::jsonb",
  'result_schema_version=2',
  "state='UNKNOWN'",
  "operation='OTHER'",
])(
  'rejects mixed or incomplete cancellation ledger state: %s',
  async (change) => {
    await probe(async (c, id) => {
      await expect(
        c.query(
          `UPDATE idempotency_records SET ${change} WHERE id=$1`,
          change.includes('$2') ? [id, f.planId] : [id],
        ),
      ).rejects.toHaveProperty('code', '23514');
    });
  },
);
it('typed result is tenant scoped and never a plan ID', async () => {
  await probe(async (c, id) => {
    await expect(
      c.query(
        "UPDATE idempotency_records SET state='COMPLETED',completed_at=clock_timestamp(),result_cancellation_request_id=$2 WHERE id=$1",
        [id, foreignCancellation],
      ),
    ).rejects.toHaveProperty('code', '23503');
  });
});
it('completed cancellation uses only the typed reference and FK prevents deleting its history', async () => {
  await probe(async (c, id) => {
    await c.query(
      "UPDATE idempotency_records SET state='COMPLETED',completed_at=clock_timestamp(),result_cancellation_request_id=$2 WHERE id=$1",
      [id, cancellation],
    );
    expect(
      (
        await c.query(
          'SELECT result_plan_id,result_cancellation_request_id,result_json FROM idempotency_records WHERE id=$1',
          [id],
        )
      ).rows[0],
    ).toEqual({
      result_plan_id: null,
      result_cancellation_request_id: cancellation,
      result_json: null,
    });
    await expect(
      c.query('DELETE FROM cancellation_requests WHERE id=$1', [cancellation]),
    ).rejects.toHaveProperty('code', '23503');
  });
});
it.each([
  'ALTER TABLE idempotency_records DROP CONSTRAINT fk_idempotency_records__cancellation_result',
  'ALTER TABLE idempotency_records DROP CONSTRAINT ck_idempotency_records__state',
  'ALTER TABLE idempotency_records DROP COLUMN result_cancellation_request_id CASCADE',
  'DROP INDEX idx_idempotency_records__expiry',
  'ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE idempotency_records DISABLE TRIGGER ALL',
  'ALTER TABLE idempotency_records SET UNLOGGED',
])('receipt guard fails closed on D17 drift: %s', async (ddl) => {
  await probe(async (c) => {
    await c.query(ddl);
    await expect(assertEmployeeMonthReceiptSchema(c)).rejects.toThrow(
      'Unusable employee-month receipt schema',
    );
  });
});
