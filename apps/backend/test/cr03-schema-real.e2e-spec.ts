/** Fresh/populated D15 -> D16, exact PG17 signatures and commit-time integrity. */
import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  assertPlanningSchemaComplete,
  readPlanningSchema,
  PLANNING_RELATIONS,
} from '../src/modules/planning/planning-schema.js';
import { assertEmployeeMonthReceiptSchema } from '../src/modules/planning/employee-month-receipt-schema.js';
import { isolatedPlanningDatabase } from './helpers/isolated-planning-database.js';
import {
  dutyMutationFixture,
  type DutyMutationFixture,
} from './helpers/duty-mutation-fixtures.js';
import { backendPid, waitUntilBlockedBy } from './helpers/synthetic-tenants.js';
import { createStaff } from './helpers/planning-fixtures.js';

let db: Awaited<ReturnType<typeof isolatedPlanningDatabase>>,
  f: DutyMutationFixture;
let snapshot: Record<string, unknown>, ledgerConstraints: unknown;
let d16Snapshot: Record<string, unknown>, d16LedgerConstraints: unknown;
const tables = [
  'companies',
  'accounts',
  'employees',
  'projects',
  'monthly_plans',
  'duties',
  'plan_assignments',
  'idempotency_records',
];
beforeAll(async () => {
  db = await isolatedPlanningDatabase(async (pool, file) => {
    if (file === '0017_cancellation_idempotency.sql') {
      d16Snapshot = {};
      for (const table of tables)
        d16Snapshot[table] = (
          await pool.query(
            `SELECT to_jsonb(t)::text AS bytes FROM public.${table} t ORDER BY to_jsonb(t)::text`,
          )
        ).rows;
      d16LedgerConstraints = (
        await pool.query(
          "SELECT conname,pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.idempotency_records'::regclass ORDER BY conname",
        )
      ).rows;
      return;
    }
    if (file !== '0016_cr03_reconciliation.sql') return;
    f = await dutyMutationFixture(pool, []);
    await pool.query(
      `INSERT INTO idempotency_records(company_id,actor_account_id,operation,key_hash,request_hash,state,result_plan_id,completed_at,expires_at)
      VALUES($1,$2,'INITIAL_PUBLISH',$3,$4,'COMPLETED',$5,clock_timestamp(),clock_timestamp()+interval '24 hours')`,
      [
        f.tenant.companyId,
        f.tenant.admin.accountId,
        randomBytes(32),
        randomBytes(32),
        f.planId,
      ],
    );
    snapshot = {};
    for (const table of tables)
      snapshot[table] = (
        await pool.query(
          `SELECT to_jsonb(t)::text AS bytes FROM public.${table} t ORDER BY to_jsonb(t)::text`,
        )
      ).rows;
    ledgerConstraints = (
      await pool.query(
        "SELECT conname,pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.idempotency_records'::regclass ORDER BY conname",
      )
    ).rows;
  });
});
afterAll(async () => {
  await db?.close();
});
async function probe(work: (c: PoolClient) => Promise<void>) {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    await work(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
const insert = (
  c: PoolClient,
  id: string,
  options: {
    company?: string;
    assignment?: string;
    duty?: string;
    employee?: string;
    version?: number | string;
    status?: string;
  } = {},
) =>
  c.query(
    `INSERT INTO cancellation_requests(id,company_id,assignment_id,duty_id,employee_id,submission_version,status) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      id,
      options.company ?? f.tenant.companyId,
      options.assignment ?? f.membership,
      options.duty ?? f.dutyId,
      options.employee ?? f.mira.employeeId,
      options.version ?? 1,
      options.status ?? 'OPEN',
    ],
  );
const need = (
  c: PoolClient,
  id: string,
  duty = f.dutyId,
  company = f.tenant.companyId,
) =>
  c.query(
    'INSERT INTO replacement_needs(company_id,cancellation_request_id,duty_id) VALUES($1,$2,$3)',
    [company, id, duty],
  );

it('populated D15 upgrade preserves existing rows and ledger signatures byte-for-byte', async () => {
  for (const table of tables)
    expect(d16Snapshot[table]).toEqual(snapshot[table]);
  expect(d16LedgerConstraints).toEqual(ledgerConstraints);
});
it('final D18 signs eight canonical tables and the extended receipt schema', async () => {
  expect(PLANNING_RELATIONS).toHaveLength(8);
  await probe(async (c) => {
    expect(await readPlanningSchema(c)).toMatchObject({ state: 'COMPLETE' });
    await assertPlanningSchemaComplete(c);
    await assertEmployeeMonthReceiptSchema(c);
  });
});
it('cancellation-first insertion commits only with exactly one need and a nondeferrable referenced UNIQUE', async () => {
  const c = await db.pool.connect(),
    id = randomUUID();
  try {
    await c.query('BEGIN');
    await insert(c, id);
    await need(c, id);
    await c.query('COMMIT');
    const row = (
      await c.query(`SELECT condeferrable,condeferred,convalidated,confdeltype,confupdtype
      FROM pg_constraint WHERE conname='fk_cancellation_requests__required_need' AND conrelid='cancellation_requests'::regclass`)
    ).rows[0];
    expect(row).toEqual({
      condeferrable: true,
      condeferred: true,
      convalidated: true,
      confdeltype: 'a',
      confupdtype: 'a',
    });
    expect(
      (
        await c.query(
          "SELECT condeferrable FROM pg_constraint WHERE conname='uq_replacement_needs__cancellation' AND conrelid='replacement_needs'::regclass",
        )
      ).rows[0].condeferrable,
    ).toBe(false);
  } finally {
    await c.query('BEGIN');
    await c.query(
      'DELETE FROM replacement_needs WHERE cancellation_request_id=$1',
      [id],
    );
    await c.query('DELETE FROM cancellation_requests WHERE id=$1', [id]);
    await c.query('COMMIT');
    c.release();
  }
});
it('missing need fails at COMMIT, leaving no cancellation or audit', async () => {
  const c = await db.pool.connect(),
    id = randomUUID();
  try {
    await c.query('BEGIN');
    await insert(c, id);
    await c.query(
      `INSERT INTO audit_event(company_id,actor_account_id,action,resource_type,resource_id,correlation_id)
      VALUES($1,$2,'CANCELLATION_OBSOLETED','CANCELLATION_REQUEST',$3,$4)`,
      [f.tenant.companyId, f.tenant.admin.accountId, id, randomUUID()],
    );
    await expect(c.query('COMMIT')).rejects.toMatchObject({
      code: '23503',
      constraint: 'fk_cancellation_requests__required_need',
    });
    expect(
      (await c.query('SELECT id FROM cancellation_requests WHERE id=$1', [id]))
        .rows,
    ).toEqual([]);
    expect(
      (await c.query('SELECT id FROM audit_event WHERE resource_id=$1', [id]))
        .rows,
    ).toEqual([]);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
it.each(['tenant', 'assignment', 'employee', 'duty'] as const)(
  'historical identity rejects mismatched %s reference',
  async (kind) => {
    await probe(async (c) => {
      const options =
        kind === 'tenant'
          ? { company: f.foreign.companyId }
          : kind === 'employee'
            ? { employee: f.jonas.employeeId }
            : kind === 'duty'
              ? { duty: randomUUID() }
              : { assignment: randomUUID() };
      await expect(insert(c, randomUUID(), options)).rejects.toMatchObject({
        code: '23503',
      });
    });
  },
);
it('need cannot reference another duty or tenant', async () => {
  for (const mode of ['duty', 'tenant'])
    await probe(async (c) => {
      const id = randomUUID();
      await insert(c, id);
      await expect(
        need(
          c,
          id,
          mode === 'duty' ? randomUUID() : f.dutyId,
          mode === 'tenant' ? f.foreign.companyId : f.tenant.companyId,
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });
});
it('duplicate OPEN case and duplicate need are rejected; terminal cases permit later OPEN history', async () => {
  await probe(async (c) => {
    const id = randomUUID();
    await insert(c, id);
    await need(c, id);
    await c.query('SAVEPOINT duplicate');
    await expect(insert(c, randomUUID())).rejects.toMatchObject({
      code: '23505',
      constraint: 'uq_cancellation_requests__open',
    });
    await c.query('ROLLBACK TO duplicate');
    await expect(need(c, id)).rejects.toMatchObject({
      code: '23505',
      constraint: 'uq_replacement_needs__cancellation',
    });
    await c.query('ROLLBACK TO duplicate');
    await c.query(
      "UPDATE cancellation_requests SET status='OBSOLETE' WHERE id=$1",
      [id],
    );
    await insert(c, randomUUID());
  });
});
it.each([0, 9007199254740992, 'IN_REVIEW'] as const)(
  'invalid version/status %s is rejected',
  async (value) => {
    await probe(async (c) => {
      await expect(
        insert(
          c,
          randomUUID(),
          typeof value === 'string' ? { status: value } : { version: value },
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  },
);
it.each([
  "UPDATE cancellation_requests SET created_at='infinity',updated_at='infinity' WHERE id=$1",
  "UPDATE cancellation_requests SET updated_at=created_at-interval '1 second' WHERE id=$1",
  "UPDATE cancellation_requests SET status='APPROVED' WHERE id=$1",
  "UPDATE replacement_needs SET status='RESOLVED' WHERE cancellation_request_id=$1",
  "UPDATE replacement_needs SET status='INVALID' WHERE cancellation_request_id=$1",
  "UPDATE replacement_needs SET resolved_at='infinity' WHERE cancellation_request_id=$1",
  "UPDATE replacement_needs SET updated_at=created_at-interval '1 second' WHERE cancellation_request_id=$1",
])('timestamp/decision/resolution checks reject %s', async (sql) => {
  await probe(async (c) => {
    const id = randomUUID();
    await insert(c, id);
    await need(c, id);
    await expect(c.query(sql, [id])).rejects.toMatchObject({ code: '23514' });
  });
});
it('referenced assignment can become REMOVED but cannot be deleted or have historical ownership rewritten', async () => {
  const other = await createStaff(db.pool, f.tenant.companyId);
  await probe(async (c) => {
    const id = randomUUID();
    await insert(c, id);
    await need(c, id);
    await c.query(
      "UPDATE plan_assignments SET state='REMOVED',removed_at=clock_timestamp() WHERE id=$1",
      [f.membership],
    );
    await c.query('SAVEPOINT history');
    await expect(
      c.query('UPDATE plan_assignments SET employee_id=$2 WHERE id=$1', [
        f.membership,
        other.employeeId,
      ]),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'fk_cancellation_requests__assignment',
    });
    await c.query('ROLLBACK TO history');
    await expect(
      c.query('DELETE FROM plan_assignments WHERE id=$1', [f.membership]),
    ).rejects.toMatchObject({ code: '23503' });
  });
});
it.each(PLANNING_RELATIONS)(
  '%s missing or altered fails closed',
  async (table) => {
    for (const ddl of [
      `ALTER TABLE public.${table} RENAME TO cr03_missing`,
      `ALTER TABLE public.${table} ADD COLUMN unexpected integer`,
    ]) {
      await probe(async (c) => {
        await c.query(ddl);
        expect(await readPlanningSchema(c)).toMatchObject({ state: 'INVALID' });
      });
    }
  },
);
it('unvalidated constraint and a foreign-schema FK hidden by search_path fail closed', async () => {
  await probe(async (c) => {
    await c.query(
      'ALTER TABLE cancellation_requests DROP CONSTRAINT ck_cancellation_requests__version; ALTER TABLE cancellation_requests ADD CONSTRAINT ck_cancellation_requests__version CHECK(submission_version BETWEEN 1 AND 9007199254740991) NOT VALID',
    );
    expect(await readPlanningSchema(c)).toMatchObject({ state: 'INVALID' });
  });
  await probe(async (c) => {
    await c.query(`CREATE SCHEMA cr03_other; CREATE TABLE cr03_other.employees (id uuid,company_id uuid,UNIQUE(company_id,id));
      ALTER TABLE cancellation_requests DROP CONSTRAINT fk_cancellation_requests__employee;
      ALTER TABLE cancellation_requests ADD CONSTRAINT fk_cancellation_requests__employee FOREIGN KEY(company_id,employee_id)
        REFERENCES cr03_other.employees(company_id,id) ON DELETE RESTRICT; SET LOCAL search_path=cr03_other,public`);
    expect(await readPlanningSchema(c)).toMatchObject({ state: 'INVALID' });
  });
});

it.each(['indisvalid', 'indisready', 'indislive'] as const)(
  'invalid workflow index flag %s fails closed',
  async (flag) => {
    await probe(async (c) => {
      await c.query(
        `UPDATE pg_catalog.pg_index SET ${flag}=false WHERE indexrelid='uq_cancellation_requests__open'::regclass`,
      );
      expect(await readPlanningSchema(c)).toMatchObject({ state: 'INVALID' });
    });
  },
);

it.each(['COMMIT', 'ROLLBACK'] as const)(
  'catalog read -> ACCESS SHARE wait -> fresh catalog reread after DDL %s',
  async (finish) => {
    const holder = await db.pool.connect(),
      reader = await db.pool.connect();
    let flight: Promise<unknown> | undefined;
    let releaseRead!: () => void, reachedRead!: () => void;
    const resume = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      reachedRead = resolve;
    });
    let first = true;
    const wrapped = {
      query: async (sql: string, values?: unknown[]) => {
        const result = await reader.query(sql, values);
        if (first && sql.includes('WITH planning AS')) {
          first = false;
          reachedRead();
          await resume;
        }
        return result;
      },
    } as Pick<PoolClient, 'query'>;
    try {
      await holder.query('BEGIN');
      await reader.query('BEGIN');
      const holderPid = await backendPid(holder),
        readerPid = await backendPid(reader);
      // Gate AFTER the first real catalog read: pg_get_indexdef itself may take relation locks.
      flight = assertPlanningSchemaComplete(wrapped).then(
        () => 'COMPLETE',
        () => 'INVALID',
      );
      await Promise.race([
        reached,
        flight.then(() => {
          throw new Error('Guard missed catalog barrier');
        }),
      ]);
      await holder.query(
        'LOCK TABLE public.replacement_needs IN ACCESS EXCLUSIVE MODE',
      );
      releaseRead();
      await waitUntilBlockedBy(db.pool, readerPid, holderPid);
      const waiting = (
        await db.pool.query('SELECT query FROM pg_stat_activity WHERE pid=$1', [
          readerPid,
        ])
      ).rows[0].query as string;
      expect(waiting).toContain('LOCK TABLE public.monthly_plans');
      expect(waiting).toContain('public.replacement_needs');
      await holder.query(
        'ALTER TABLE public.replacement_needs ADD COLUMN cr03_drift integer',
      );
      await holder.query(finish);
      expect(await flight).toBe(finish === 'COMMIT' ? 'INVALID' : 'COMPLETE');
    } finally {
      releaseRead();
      await holder.query('ROLLBACK');
      await flight;
      await reader.query('ROLLBACK');
      await holder.query(
        'ALTER TABLE public.replacement_needs DROP COLUMN IF EXISTS cr03_drift',
      );
      holder.release();
      reader.release();
    }
  },
);
