/** P1 persistence/receipt contract on an independently migrated disposable PG17 database. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../src/database/database.service.js';
import type { TenantContext } from '../src/auth/authorization/tenant-context.js';
import { reserveCommand } from '../src/common/transactions/command-reservation.js';
import { BusinessAuditService } from '../src/modules/audit/business-audit.service.js';
import {
  CancellationRequestsService,
  cancellationFingerprint,
} from '../src/modules/cancellation-replacement/cancellation-requests.service.js';
import {
  assertPlanningSchemaComplete,
  readPlanningSchema,
} from '../src/modules/planning/planning-schema.js';
import { assertEmployeeMonthReceiptSchema } from '../src/modules/planning/employee-month-receipt-schema.js';
import { isolatedPlanningDatabase } from './helpers/isolated-planning-database.js';
import {
  dutyMutationFixture,
  type DutyMutationFixture,
} from './helpers/duty-mutation-fixtures.js';
import {
  createSyntheticSession,
  realSessionService,
} from './helpers/synthetic-tenants.js';

let db: Awaited<ReturnType<typeof isolatedPlanningDatabase>>,
  f: DutyMutationFixture;
let need: string,
  cancellation: string,
  foreignNeed: string,
  foreignEmployee: string;
let d17: unknown, tenant: TenantContext;
const key = randomUUID();
const hash = (value: string) => createHash('sha256').update(value).digest();
async function pair(
  c: Pick<PoolClient, 'query'>,
  fixture: DutyMutationFixture,
) {
  const cancellation = randomUUID(),
    need = randomUUID();
  await c.query(
    `INSERT INTO cancellation_requests(id,company_id,assignment_id,duty_id,employee_id,submission_version)
    VALUES($1,$2,$3,$4,$5,1)`,
    [
      cancellation,
      fixture.tenant.companyId,
      fixture.membership,
      fixture.dutyId,
      fixture.mira.employeeId,
    ],
  );
  await c.query(
    'INSERT INTO replacement_needs(id,company_id,cancellation_request_id,duty_id) VALUES($1,$2,$3,$4)',
    [need, fixture.tenant.companyId, cancellation, fixture.dutyId],
  );
  return { cancellation, need };
}
const ledger = async (c: Pick<PoolClient, 'query'>, migrated = false) =>
  (
    await c.query(
      `SELECT ${migrated ? "(to_jsonb(r)-'result_replacement_offer_id')" : 'to_jsonb(r)'}::text AS bytes FROM idempotency_records r ORDER BY id`,
    )
  ).rows;
beforeAll(async () => {
  db = await isolatedPlanningDatabase(async (pool, file) => {
    if (file !== '0018_replacement_offers.sql') return;
    f = await dutyMutationFixture(pool, []);
    const other = await dutyMutationFixture(pool, []);
    foreignEmployee = other.mira.employeeId;
    const session = await createSyntheticSession(
      realSessionService(pool),
      f.mira.account,
    );
    tenant = {
      companyId: f.tenant.companyId,
      accountId: f.mira.account.accountId,
      sessionId: (
        await pool.query('SELECT id FROM sessions WHERE token_hash=$1', [
          hash(session.rawToken),
        ])
      ).rows[0].id,
      role: 'EMPLOYEE',
    };
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      ({ need, cancellation } = await pair(c, f));
      foreignNeed = (await pair(c, other)).need;
      for (const state of ['IN_PROGRESS', 'FAILED', 'COMPLETED']) {
        await c.query(
          `INSERT INTO idempotency_records(company_id,actor_account_id,operation,key_hash,request_hash,state,
          result_cancellation_request_id,completed_at,expires_at)
          VALUES($1,$2,'CREATE_CANCELLATION',$3,$4,$5,$6,CASE WHEN $5='COMPLETED' THEN clock_timestamp() END,clock_timestamp()+interval '24 hours')`,
          [
            tenant.companyId,
            tenant.accountId,
            state === 'COMPLETED' ? hash(key) : randomBytes(32),
            cancellationFingerprint(f.membership, 1),
            state,
            state === 'COMPLETED' ? cancellation : null,
          ],
        );
      }
      d17 = await ledger(c);
      // The new binary must refuse the old seven-table/old-ledger pair.
      expect(await readPlanningSchema(c)).toMatchObject({ state: 'INVALID' });
      await expect(assertEmployeeMonthReceiptSchema(c)).rejects.toThrow(
        'Unusable employee-month receipt schema',
      );
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  });
}, 30000);
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
async function offer(
  c: PoolClient,
  status = 'OPEN',
  employee = f.jonas.employeeId,
  needId = need,
  company = f.tenant.companyId,
) {
  return (
    await c.query<{ id: string }>(
      `WITH moment AS (SELECT clock_timestamp() AS at)
    INSERT INTO replacement_offers(company_id,need_id,employee_id,status,created_at,updated_at,decided_at)
    SELECT $1,$2,$3,$4,at,at,CASE WHEN $4='OPEN' THEN NULL ELSE at END FROM moment RETURNING id`,
      [company, needId, employee, status],
    )
  ).rows[0].id;
}
it('populated D17 cancellation receipts retain every old byte and replay through the actual service after D18', async () => {
  expect(await ledger(db.pool, true)).toEqual(d17);
  const adapter = {
    withTransaction: async <T>(work: (c: PoolClient) => Promise<T>) => {
      const c = await db.pool.connect();
      try {
        await c.query('BEGIN');
        const result = await work(c);
        await c.query('COMMIT');
        return result;
      } catch (error) {
        await c.query('ROLLBACK');
        throw error;
      } finally {
        c.release();
      }
    },
  } as DatabaseService;
  const result = await new CancellationRequestsService(
    adapter,
    new BusinessAuditService(),
  ).create(tenant, f.membership, 1, key, randomUUID());
  expect(result).toMatchObject({
    replayed: true,
    result: { id: cancellation, status: 'OPEN', replacementNeed: { id: need } },
  });
  expect(await ledger(db.pool, true)).toEqual(d17);
  expect(
    (
      await db.pool.query('SELECT id FROM audit_event WHERE company_id=$1', [
        tenant.companyId,
      ])
    ).rows,
  ).toEqual([]);
});
it.each(['OPEN', 'SELECTED', 'NOT_SELECTED', 'INVALIDATED', 'WITHDRAWN'])(
  'accepts %s with exactly its finalization semantics',
  async (status) => {
    await probe(async (c) => {
      const id = await offer(c, status);
      expect(
        (
          await c.query(
            'SELECT status,decided_at IS NULL AS undecided FROM replacement_offers WHERE id=$1',
            [id],
          )
        ).rows[0],
      ).toEqual({ status, undecided: status === 'OPEN' });
      await assertPlanningSchemaComplete(c);
      await assertEmployeeMonthReceiptSchema(c);
    });
  },
);
it.each(['OPEN', 'SELECTED'])(
  'active %s forbids another OPEN application for the same employee and need',
  async (status) => {
    await probe(async (c) => {
      await offer(c, status);
      await expect(offer(c)).rejects.toMatchObject({
        code: '23505',
        constraint: 'uq_replacement_offers__active_employee_need',
      });
    });
  },
);
it('one selected candidate per need while other employees can still have OPEN offers', async () => {
  await probe(async (c) => {
    await offer(c, 'SELECTED');
    await c.query('SAVEPOINT second_selection');
    await expect(offer(c, 'SELECTED', f.mira.employeeId)).rejects.toMatchObject(
      { code: '23505', constraint: 'uq_replacement_offers__selected_need' },
    );
    await c.query('ROLLBACK TO second_selection');
    await offer(c, 'OPEN', f.mira.employeeId);
  });
});
it('retains repeated terminal history while allowing a new application', async () => {
  await probe(async (c) => {
    for (const status of ['NOT_SELECTED', 'INVALIDATED', 'WITHDRAWN']) {
      await offer(c, status);
      await offer(c, status);
    }
    await offer(c);
    expect(
      (
        await c.query(
          'SELECT count(*)::int AS n FROM replacement_offers WHERE need_id=$1',
          [need],
        )
      ).rows[0].n,
    ).toBe(7);
  });
});
it.each(['need', 'employee'] as const)(
  "composite FK rejects another tenant's %s",
  async (kind) => {
    await probe(async (c) => {
      await expect(
        offer(
          c,
          'OPEN',
          kind === 'employee' ? foreignEmployee : f.jonas.employeeId,
          kind === 'need' ? foreignNeed : need,
        ),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: `fk_replacement_offers__${kind}`,
      });
    });
  },
);
it.each([
  "status='UNKNOWN'",
  "status='SELECTED'",
  'decided_at=clock_timestamp()',
  "created_at='infinity'",
  "updated_at='infinity'",
  "updated_at=created_at-interval '1 second'",
  "status='WITHDRAWN',decided_at='infinity'",
  "status='INVALIDATED',decided_at=created_at-interval '1 second'",
  "status='NOT_SELECTED',decided_at=updated_at+interval '1 second'",
])('rejects malformed offer lifecycle: %s', async (change) => {
  await probe(async (c) => {
    const id = await offer(c);
    await expect(
      c.query(`UPDATE replacement_offers SET ${change} WHERE id=$1`, [id]),
    ).rejects.toHaveProperty('code', '23514');
  });
});
it.each(['employees', 'replacement_needs'] as const)(
  'history prevents deleting referenced %s',
  async (table) => {
    await probe(async (c) => {
      await offer(c, 'INVALIDATED');
      await expect(
        c.query(`DELETE FROM ${table} WHERE id=$1`, [
          table === 'employees' ? f.jonas.employeeId : need,
        ]),
      ).rejects.toHaveProperty('code', '23503');
    });
  },
);
async function receipt(c: PoolClient, offerId: string, state = 'COMPLETED') {
  return (
    await c.query<{ id: string }>(
      `INSERT INTO idempotency_records(company_id,actor_account_id,operation,key_hash,request_hash,state,
    result_replacement_offer_id,completed_at,expires_at) VALUES($1,$2,'CREATE_REPLACEMENT_OFFER',$3,$4,$5,$6,
    CASE WHEN $5='COMPLETED' THEN clock_timestamp() END,clock_timestamp()+interval '24 hours') RETURNING id`,
      [
        tenant.companyId,
        tenant.accountId,
        randomBytes(32),
        randomBytes(32),
        state,
        state === 'COMPLETED' ? offerId : null,
      ],
    )
  ).rows[0].id;
}
it.each(['IN_PROGRESS', 'FAILED', 'COMPLETED'])(
  'typed offer receipt accepts %s',
  async (state) => {
    await probe(async (c) => {
      const offerId = await offer(c);
      await receipt(c, offerId, state);
      await assertEmployeeMonthReceiptSchema(c);
    });
  },
);
it.each([
  'result_replacement_offer_id=NULL',
  'result_plan_id=$2',
  'result_cancellation_request_id=$2',
  'completed_at=NULL',
  "state='IN_PROGRESS'",
  "state='FAILED'",
  'context_plan_id=$2',
  "result_json='{}'::jsonb",
  'result_schema_version=2',
])('typed offer receipt rejects mixed/null state: %s', async (change) => {
  await probe(async (c) => {
    const id = await receipt(c, await offer(c));
    await expect(
      c.query(
        `UPDATE idempotency_records SET ${change} WHERE id=$1`,
        change.includes('result_cancellation_request_id')
          ? [id, cancellation]
          : change.includes('$2')
            ? [id, f.planId]
            : [id],
      ),
    ).rejects.toHaveProperty('code', '23514');
  });
});
it('offer receipt FK rejects another tenant and protects retained result history', async () => {
  await probe(async (c) => {
    const foreignId = await offer(
      c,
      'OPEN',
      foreignEmployee,
      foreignNeed,
      (
        await c.query('SELECT company_id FROM employees WHERE id=$1', [
          foreignEmployee,
        ])
      ).rows[0].company_id,
    );
    await c.query('SAVEPOINT foreign_result');
    await expect(receipt(c, foreignId)).rejects.toHaveProperty('code', '23503');
    await c.query('ROLLBACK TO foreign_result');
    const id = await offer(c);
    await receipt(c, id);
    await expect(
      c.query('DELETE FROM replacement_offers WHERE id=$1', [id]),
    ).rejects.toHaveProperty('code', '23503');
  });
});
it('shared reservation codec replays the typed offer then clears it on expired-key reclaim', async () => {
  await probe(async (c) => {
    const offerId = await offer(c),
      id = await receipt(c, offerId);
    const prior = (
      await c.query(
        'SELECT key_hash,request_hash,attempt_id FROM idempotency_records WHERE id=$1',
        [id],
      )
    ).rows[0];
    const input = {
      tenant,
      operation: 'CREATE_REPLACEMENT_OFFER',
      keyHash: prior.key_hash,
      requestHash: prior.request_hash,
      lockId: '181818',
      retention: 86400,
      stale: 300,
      replay: async (row: { result_replacement_offer_id?: string | null }) =>
        row.result_replacement_offer_id,
    };
    expect(await reserveCommand(c, input)).toEqual({
      result: offerId,
      replayed: true,
    });
    await c.query(
      `UPDATE idempotency_records SET created_at=clock_timestamp()-interval '3 days',claimed_at=clock_timestamp()-interval '3 days',
      completed_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE id=$1`,
      [id],
    );
    const reclaimed = await reserveCommand(c, input);
    expect(reclaimed).toHaveProperty('claim.id', id);
    expect(
      (
        await c.query(
          'SELECT state,result_replacement_offer_id,attempt_id FROM idempotency_records WHERE id=$1',
          [id],
        )
      ).rows[0],
    ).toMatchObject({
      state: 'IN_PROGRESS',
      result_replacement_offer_id: null,
      attempt_id: expect.not.stringMatching(prior.attempt_id),
    });
  });
});
it.each([
  'ALTER TABLE replacement_offers DROP COLUMN decided_at CASCADE',
  'ALTER TABLE replacement_offers DROP CONSTRAINT fk_replacement_offers__employee',
  'ALTER TABLE replacement_offers DROP CONSTRAINT ck_replacement_offers__finalization',
  'DROP INDEX uq_replacement_offers__selected_need',
  "DROP INDEX uq_replacement_offers__active_employee_need; CREATE UNIQUE INDEX uq_replacement_offers__active_employee_need ON replacement_offers(company_id,need_id,employee_id) WHERE status='OPEN'",
  'CREATE INDEX sp18_extra ON replacement_offers(need_id)',
  'ALTER TABLE replacement_offers ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE replacement_offers DISABLE TRIGGER ALL',
  'ALTER TABLE idempotency_records DROP CONSTRAINT fk_idempotency_records__offer_result; ALTER TABLE replacement_offers SET UNLOGGED',
  'CREATE TEMP TABLE replacement_offer(id uuid)',
])('exact planning guard rejects offer drift: %s', async (ddl) => {
  await probe(async (c) => {
    await c.query(ddl);
    await expect(assertPlanningSchemaComplete(c)).rejects.toThrow();
  });
});
it.each([
  'ALTER TABLE idempotency_records DROP COLUMN result_replacement_offer_id CASCADE',
  'ALTER TABLE idempotency_records DROP CONSTRAINT fk_idempotency_records__offer_result',
  'ALTER TABLE idempotency_records DROP CONSTRAINT ck_idempotency_records__state',
])('independent receipt guard rejects D18 drift: %s', async (ddl) => {
  await probe(async (c) => {
    await c.query(ddl);
    await expect(assertEmployeeMonthReceiptSchema(c)).rejects.toThrow(
      'Unusable employee-month receipt schema',
    );
  });
});
