/**
 * SP-21 S1 — DECIDE_CANCELLATION idempotency receipt on real PostgreSQL (isolated database).
 *
 * Scope: migration 0020 constraints, the exact receipt-schema guard, the shared reservation codec
 * and the receipt codec (fenced completion, replay, reclaim). There is NO decision service, route
 * or business transition yet (S2/S3): these tests drive the codec directly. They are not HTTP or
 * end-to-end decision evidence.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../src/auth/authorization/tenant-context.js';
import { reserveCommand, type CommandClaim } from '../src/common/transactions/command-reservation.js';
import { BusinessAuditService } from '../src/modules/audit/business-audit.service.js';
import {
  completeDecisionReceipt,
  decisionFingerprint,
  DECIDE_CANCELLATION,
  DECISION_RETENTION_SECONDS,
  DECISION_STALE_SECONDS,
  pgJsonTextBytes,
  replayDecisionReceipt,
  type DecisionReceiptV1,
} from '../src/modules/cancellation-replacement/cancellation-decision-receipt.js';
import { cancellationContext } from '../src/modules/planning/cancellation-context.js';
import { assertEmployeeMonthReceiptSchema } from '../src/modules/planning/employee-month-receipt-schema.js';
import { employeeSummary } from '../src/modules/workforce/employees/employee-context.js';
import { dutyMutationFixture, type DutyMutationFixture } from './helpers/duty-mutation-fixtures.js';
import { isolatedPlanningDatabase } from './helpers/isolated-planning-database.js';
import { adminContext, insertMembership } from './helpers/planning-fixtures.js';

let db: Awaited<ReturnType<typeof isolatedPlanningDatabase>>;
let f: DutyMutationFixture, other: DutyMutationFixture;
let cancellation: string, need: string, foreignCancellation: string, sameTenantB: string;
let admin: TenantContext, admin2: TenantContext, foreignAdmin: TenantContext;
const digest = (s: string) => createHash('sha256').update(s).digest();

async function tx<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
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
}
/** Rolled-back probe; each statement runs under its own savepoint. */
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
async function attempt(c: PoolClient, sql: string, params: unknown[]): Promise<string> {
  await c.query('SAVEPOINT s');
  try {
    await c.query(sql, params);
    await c.query('RELEASE SAVEPOINT s');
    return 'ok';
  } catch (error) {
    await c.query('ROLLBACK TO SAVEPOINT s');
    return (error as { code?: string }).code ?? 'error';
  }
}

const lockId = (t: TenantContext, key: Buffer) =>
  digest(JSON.stringify(['decide-cancellation-v1', t.companyId, t.accountId, DECIDE_CANCELLATION, key.toString('hex')]))
    .readBigInt64BE()
    .toString();
const reserveIn = (c: PoolClient, t: TenantContext, key: string, requestHash: Buffer, requestId = cancellation) =>
  reserveCommand(c, {
    tenant: t,
    operation: DECIDE_CANCELLATION,
    keyHash: digest(key),
    requestHash,
    lockId: lockId(t, digest(key)),
    retention: DECISION_RETENTION_SECONDS,
    stale: DECISION_STALE_SECONDS,
    replay: (prior) => Promise.resolve(replayDecisionReceipt(prior, requestId)),
  });
const reserve = (t: TenantContext, key: string, requestHash: Buffer, requestId = cancellation) =>
  tx((c) => reserveIn(c, t, key, requestHash, requestId));
const claimOf = (r: Awaited<ReturnType<typeof reserve>>): CommandClaim => {
  if (!('claim' in r)) throw new Error('expected a new claim');
  return r.claim;
};
const approveHash = (dutyVersion = 1, needVersion = 1) =>
  decisionFingerprint({ decision: 'APPROVE', requestId: cancellation, needVersion, dutyVersion });
const rejectHash = () => decisionFingerprint({ decision: 'REJECT', requestId: cancellation });

/** Decision-time snapshot built from the real historical readers (as S2 will do under locks). */
async function receipt(decision: 'APPROVE' | 'REJECT', companyId = f.tenant.companyId, id = cancellation): Promise<DecisionReceiptV1> {
  return tx(async (c) => {
    const row = (
      await c.query<{ assignment_id: string; employee_id: string; created_at: Date; need_id: string; version: string; at: Date }>(
        `SELECT r.assignment_id,r.employee_id,r.created_at,n.id AS need_id,d.concurrency_version::text AS version,clock_timestamp() AS at
         FROM cancellation_requests r JOIN replacement_needs n ON n.company_id=r.company_id AND n.cancellation_request_id=r.id
         JOIN duties d ON d.company_id=r.company_id AND d.id=r.duty_id WHERE r.company_id=$1 AND r.id=$2`,
        [companyId, id],
      )
    ).rows[0];
    const ctx = await cancellationContext(c, companyId, row.assignment_id);
    const duty = { id: ctx.duty_id, dutyDate: ctx.dutyDate, shiftKind: ctx.shiftKind, startsAt: ctx.startsAt, endsAt: ctx.endsAt };
    const approve = decision === 'APPROVE';
    return {
      cancellation: {
        id,
        assignmentId: row.assignment_id,
        employee: await employeeSummary(c, companyId, row.employee_id),
        duty,
        status: approve ? 'APPROVED' : 'REJECTED',
        createdAt: row.created_at.toISOString(),
        decidedAt: row.at.toISOString(),
        replacementNeed: { id: row.need_id, status: approve ? 'OPEN_UNFILLED' : 'CLOSED', resolvedAt: null },
      },
      selectedOffer: null,
      updatedDuty: approve ? { ...duty, concurrencyVersion: Number(row.version) + 1 } : null,
    };
  });
}
const complete = (t: TenantContext, claim: CommandClaim, r: DecisionReceiptV1, expected: string = cancellation) =>
  tx((c) => completeDecisionReceipt(c, t, claim, expected, r));
const rowBytes = async (key: string, t = admin) =>
  (
    await db.pool.query<{ bytes: string }>(
      'SELECT to_jsonb(r)::text AS bytes FROM idempotency_records r WHERE company_id=$1 AND actor_account_id=$2 AND operation=$3 AND key_hash=$4',
      [t.companyId, t.accountId, DECIDE_CANCELLATION, digest(key)],
    )
  ).rows[0]?.bytes;
const row = async (key: string, t = admin) =>
  (
    await db.pool.query<{ state: string; result_json: unknown; result_schema_version: number | null; result_cancellation_request_id: string | null; attempt_id: string }>(
      'SELECT state,result_json,result_schema_version,result_cancellation_request_id,attempt_id FROM idempotency_records WHERE company_id=$1 AND actor_account_id=$2 AND operation=$3 AND key_hash=$4',
      [t.companyId, t.accountId, DECIDE_CANCELLATION, digest(key)],
    )
  ).rows[0];
const audits = async () => Number((await db.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM audit_event')).rows[0].n);
/** Business tables the decision command will touch in S2; replay and refusal must leave them unchanged. */
const business = async () =>
  (
    await db.pool.query<{ h: string }>(`SELECT md5(concat_ws('|',
      (SELECT string_agg(to_jsonb(x)::text, ',' ORDER BY id) FROM duties x),
      (SELECT string_agg(to_jsonb(x)::text, ',' ORDER BY id) FROM plan_assignments x),
      (SELECT string_agg(to_jsonb(x)::text, ',' ORDER BY id) FROM cancellation_requests x),
      (SELECT string_agg(to_jsonb(x)::text, ',' ORDER BY id) FROM replacement_needs x),
      (SELECT string_agg(to_jsonb(x)::text, ',' ORDER BY id) FROM replacement_offers x))) AS h`)
  ).rows[0].h;
/** Makes the row look as if it had been claimed/completed long ago (keeps ck_idempotency_records__time valid). */
async function age(key: string, expired: boolean, t = admin) {
  await db.pool.query(
    `UPDATE idempotency_records SET created_at=clock_timestamp()-interval '3 days',claimed_at=clock_timestamp()-interval '3 days',
       completed_at=CASE WHEN state='COMPLETED' THEN clock_timestamp()-interval '3 days'+interval '1 second' END,
       expires_at=CASE WHEN $5 THEN clock_timestamp()-interval '1 day' ELSE expires_at END
     WHERE company_id=$1 AND actor_account_id=$2 AND operation=$3 AND key_hash=$4`,
    [t.companyId, t.accountId, DECIDE_CANCELLATION, digest(key), expired],
  );
}

beforeAll(async () => {
  db = await isolatedPlanningDatabase();
  f = await dutyMutationFixture(db.pool, []);
  other = await dutyMutationFixture(db.pool, []);
  const pair = (fx: DutyMutationFixture) =>
    tx(async (c) => {
      const id = randomUUID();
      await c.query(
        'INSERT INTO cancellation_requests(id,company_id,assignment_id,duty_id,employee_id,submission_version) VALUES($1,$2,$3,$4,$5,1)',
        [id, fx.tenant.companyId, fx.membership, fx.dutyId, fx.mira.employeeId],
      );
      const n = await c.query<{ id: string }>(
        'INSERT INTO replacement_needs(company_id,cancellation_request_id,duty_id) VALUES($1,$2,$3) RETURNING id',
        [fx.tenant.companyId, id, fx.dutyId],
      );
      return { id, need: n.rows[0].id };
    });
  ({ id: cancellation, need } = await pair(f));
  ({ id: foreignCancellation } = await pair(other));
  // Cancellation B: a second real OPEN case in the SAME tenant (other employee on the same duty).
  const jonasMembership = await insertMembership(db.pool, f.tenant.companyId, f.dutyId, f.jonas.employeeId);
  ({ id: sameTenantB } = await pair({ ...f, membership: jonasMembership, mira: f.jonas }));
  admin = adminContext(f.tenant.admin);
  admin2 = adminContext(f.second);
  foreignAdmin = adminContext(other.tenant.admin);
}, 120000);
afterAll(async () => {
  await db?.close();
});

describe('migration 0020 schema', () => {
  it('passes the exact fail-closed receipt-schema guard and adds no trigger', async () => {
    await probe(async (c) => {
      await expect(assertEmployeeMonthReceiptSchema(c)).resolves.toBeUndefined();
      expect((await c.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid='public.idempotency_records'::regclass AND NOT tgisinternal")).rows[0].n).toBe(0);
    });
  });

  it.each([
    'ALTER TABLE idempotency_records DROP CONSTRAINT ck_idempotency_records__employee_month',
    "ALTER TABLE idempotency_records DROP CONSTRAINT ck_idempotency_records__operation, ADD CONSTRAINT ck_idempotency_records__operation CHECK (operation IN ('INITIAL_PUBLISH','EMPLOYEE_MONTH_SAVE','CREATE_CANCELLATION','CREATE_REPLACEMENT_OFFER','DECIDE_REPLACEMENT_SELECTION'))",
    'CREATE FUNCTION pg_temp.noop() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$; CREATE TRIGGER t BEFORE UPDATE ON idempotency_records FOR EACH ROW EXECUTE FUNCTION pg_temp.noop()',
  ])('guard fails closed on drift: %s', async (ddl) => {
    await probe(async (c) => {
      await c.query(ddl);
      await expect(assertEmployeeMonthReceiptSchema(c)).rejects.toThrow('Unusable employee-month receipt schema');
    });
  });

  const insert = `INSERT INTO idempotency_records(company_id,actor_account_id,operation,key_hash,request_hash,state,completed_at,expires_at,
      result_cancellation_request_id,result_json,result_schema_version,result_plan_id,context_plan_id,context_employee_id)
    VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $6='COMPLETED' THEN clock_timestamp() END,clock_timestamp()+interval '1 day',$7,$8::jsonb,$9,$10,$11,$12)`;
  type Row = { op?: string; state?: string; id?: string | null; json?: unknown; version?: number | null; plan?: string | null; ctxPlan?: string | null; ctxEmployee?: string | null; company?: string };
  const put = (c: PoolClient, r: Row) =>
    attempt(c, insert, [
      r.company ?? f.tenant.companyId, f.tenant.admin.accountId, r.op ?? DECIDE_CANCELLATION, digest(randomUUID()), digest('h'),
      r.state ?? 'COMPLETED', r.id === undefined ? cancellation : r.id, r.json === undefined ? null : JSON.stringify(r.json),
      r.version === undefined ? 1 : r.version, r.plan ?? null, r.ctxPlan ?? null, r.ctxEmployee ?? null,
    ]);

  it('accepts typed schema-1 APPROVE and REJECT receipts', async () => {
    const approve = await receipt('APPROVE'), reject = await receipt('REJECT');
    await probe(async (c) => {
      expect(await put(c, { json: approve })).toBe('ok');
      expect(await put(c, { json: reject })).toBe('ok');
      expect(await put(c, { state: 'IN_PROGRESS', id: null, version: null })).toBe('ok');
      expect(await put(c, { state: 'FAILED', id: null, version: null })).toBe('ok');
    });
  });

  type Mut = (r: any) => void;
  const invalid: [string, Mut][] = [
    ['extra top-level key', (r) => (r.extra = true)],
    ['missing updatedDuty', (r) => delete r.updatedDuty],
    ['selectedOffer object', (r) => (r.selectedOffer = {})],
    ['email in employee', (r) => (r.cancellation.employee.email = 'x@example.invalid')],
    ['absence reason', (r) => (r.cancellation.reason = 'x')],
    ['null employee', (r) => (r.cancellation.employee = null)],
    ['numeric firstName', (r) => (r.cancellation.employee.firstName = 1)],
    ['non-UUID assignment', (r) => (r.cancellation.assignmentId = 'x')],
    ['upper-case need id', (r) => (r.cancellation.replacementNeed.id = 'ABCDEF00-0000-4000-8000-000000000000')],
    ['timestamp without millis', (r) => (r.cancellation.decidedAt = '2026-12-15T13:00:00Z')],
    ['null decidedAt', (r) => (r.cancellation.decidedAt = null)],
    ['resolvedAt set', (r) => (r.cancellation.replacementNeed.resolvedAt = '2026-12-15T13:00:00.000Z')],
    ['missing resolvedAt', (r) => delete r.cancellation.replacementNeed.resolvedAt],
    ['APPROVED with CLOSED need', (r) => (r.cancellation.replacementNeed.status = 'CLOSED')],
    ['APPROVED with RESOLVED need', (r) => (r.cancellation.replacementNeed.status = 'RESOLVED')],
    ['APPROVED with null updatedDuty', (r) => (r.updatedDuty = null)],
    ['updatedDuty of another duty', (r) => (r.updatedDuty.id = randomUUID())],
    ['updatedDuty with other times', (r) => (r.updatedDuty.endsAt = '2027-01-20T18:00:00Z')],
    ['updatedDuty missing version', (r) => delete r.updatedDuty.concurrencyVersion],
    ['duty version 1', (r) => (r.updatedDuty.concurrencyVersion = 1)],
    ['fractional duty version', (r) => (r.updatedDuty.concurrencyVersion = 2.5)],
    ['string duty version', (r) => (r.updatedDuty.concurrencyVersion = '2')],
    ['unsafe duty version', (r) => (r.updatedDuty.concurrencyVersion = 9007199254740992)],
    ['WITHDRAWN status', (r) => (r.cancellation.status = 'WITHDRAWN')],
    ['TAG shift kind', (r) => (r.cancellation.duty.shiftKind = 'TAG')],
    ['bad duty date', (r) => (r.cancellation.duty.dutyDate = '20.01.2027')],
  ];
  it.each(invalid)('rejects invalid nested receipt: %s', async (_name, mutate) => {
    const r = await receipt('APPROVE');
    mutate(r);
    await probe(async (c) => expect(await put(c, { json: r })).toBe('23514'));
  });

  it('rejects REJECTED paired with an updatedDuty or an OPEN_UNFILLED need', async () => {
    const a = (await receipt('REJECT')) as any, b = (await receipt('REJECT')) as any;
    a.updatedDuty = (await receipt('APPROVE')).updatedDuty;
    b.cancellation.replacementNeed.status = 'OPEN_UNFILLED';
    await probe(async (c) => {
      expect(await put(c, { json: a })).toBe('23514');
      expect(await put(c, { json: b })).toBe('23514');
    });
  });

  it('enforces typed result columns, resource identity and tenant scope', async () => {
    const r = await receipt('APPROVE');
    await probe(async (c) => {
      expect(await put(c, { json: r, id: foreignCancellation })).toBe('23514'); // receipt id must equal the typed result
      expect(await put(c, { json: r, id: null })).toBe('23514');
      expect(await put(c, { json: null })).toBe('23514');
      expect(await put(c, { json: r, version: 2 })).toBe('23514');
      expect(await put(c, { json: r, version: null })).toBe('23514');
      expect(await put(c, { json: r, plan: f.planId })).toBe('23514');
      expect(await put(c, { json: r, ctxPlan: f.planId, ctxEmployee: f.mira.employeeId })).toBe('23514');
      expect(await put(c, { state: 'IN_PROGRESS', id: null, json: r })).toBe('23514');
      expect(await put(c, { state: 'FAILED', id: cancellation, version: null })).toBe('23514');
      expect(await put(c, { op: 'DECIDE_CANCELLATION_V2', state: 'IN_PROGRESS', id: null, version: null })).toBe('23514');
    });
    const foreign = await receipt('APPROVE', other.tenant.companyId, foreignCancellation);
    await probe(async (c) => expect(await put(c, { json: foreign, id: foreignCancellation })).toBe('23503')); // composite FK: no cross-tenant result
  });

  it('bounds PostgreSQL JSON text at exactly 8192 bytes with multi-byte UTF-8', async () => {
    const sized = async (n: number) => {
      const r = await receipt('APPROVE');
      r.cancellation.employee.lastName = '';
      const pad = n - pgJsonTextBytes(r);
      r.cancellation.employee.lastName = '€ü'.repeat(Math.floor(pad / 5)) + 'a'.repeat(pad % 5);
      return r;
    };
    await probe(async (c) => {
      for (const [n, expected] of [[8192, 'ok'], [8193, '23514']] as const) {
        const r = await sized(n);
        const pgBytes = (await c.query<{ n: number }>('SELECT octet_length($1::jsonb::text) AS n', [JSON.stringify(r)])).rows[0].n;
        expect([pgJsonTextBytes(r), pgBytes]).toEqual([n, n]);
        expect(await put(c, { json: r })).toBe(expected);
      }
    });
  });

  it('keeps the existing operation contracts', async () => {
    const r = await receipt('APPROVE');
    await probe(async (c) => {
      expect(await put(c, { op: 'INITIAL_PUBLISH', id: null, version: null, plan: f.planId })).toBe('ok');
      expect(await put(c, { op: 'CREATE_CANCELLATION', version: null })).toBe('ok');
      expect(await put(c, { op: 'CREATE_CANCELLATION', json: r })).toBe('23514');
      expect(await put(c, { op: 'DECIDE_REPLACEMENT_SELECTION', version: null })).toBe('23514'); // still needs both typed results
      expect(await put(c, { op: 'EMPLOYEE_MONTH_SAVE', id: null, json: r, plan: f.planId, ctxPlan: f.planId, ctxEmployee: f.mira.employeeId })).toBe('23514');
      expect(await put(c, { op: 'INITIAL_PUBLISH', state: 'IN_PROGRESS', id: null, version: null })).toBe('ok');
    });
  });
});

describe('receipt codec lifecycle (codec level, no decision service)', () => {
  it('first response is the stored snapshot; same-key replay returns it unchanged after later duty and employee edits', async () => {
    const key = randomUUID();
    const claim = claimOf(await reserve(admin, key, approveHash()));
    const snapshot = await receipt('APPROVE');
    const first = await complete(admin, claim, snapshot);
    const stored = await row(key);
    expect(first).toEqual(stored.result_json);
    expect(stored).toMatchObject({ state: 'COMPLETED', result_schema_version: 1, result_cancellation_request_id: cancellation });
    const bytes = await rowBytes(key);
    // Later business edits outside this command.
    await db.pool.query('UPDATE duties SET concurrency_version=concurrency_version+2 WHERE id=$1', [f.dutyId]);
    await db.pool.query("UPDATE employees SET last_name='Renamed' WHERE id=$1", [f.mira.employeeId]);
    const [auditBefore, businessBefore] = [await audits(), await business()];
    const replay = await reserve(admin, key, approveHash());
    expect(replay).toEqual({ result: first, replayed: true });
    const again = await reserve(admin, key, approveHash());
    expect(again).toEqual(replay);
    expect(await rowBytes(key)).toBe(bytes);
    expect([await audits(), await business()]).toEqual([auditBefore, businessBefore]);
    expect(first.updatedDuty?.concurrencyVersion).not.toBe(Number((await db.pool.query('SELECT concurrency_version FROM duties WHERE id=$1', [f.dutyId])).rows[0].concurrency_version));
  });

  it('same key with a different expectedDutyVersion, need version or decision is a 409 conflict and writes nothing', async () => {
    const key = randomUUID();
    await complete(admin, claimOf(await reserve(admin, key, approveHash(5, 2))), await receipt('APPROVE'));
    const bytes = await rowBytes(key);
    for (const hash of [approveHash(6, 2), approveHash(5, 3), rejectHash(), decisionFingerprint({ decision: 'REJECT', requestId: foreignCancellation })])
      await expect(reserve(admin, key, hash)).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST' } });
    expect(await rowBytes(key)).toBe(bytes);
  });

  it('REJECT fingerprint ignores the optional Expected-Version header, so a retry with the header replays', async () => {
    const key = randomUUID();
    const withoutHeader = decisionFingerprint({ decision: 'REJECT', requestId: cancellation });
    const withHeader = decisionFingerprint({ decision: 'REJECT', requestId: cancellation, needVersion: 7 } as never);
    const first = await complete(admin, claimOf(await reserve(admin, key, withoutHeader)), await receipt('REJECT'));
    expect(await reserve(admin, key, withHeader)).toEqual({ result: first, replayed: true });
  });

  it('a FAILED attempt is reclaimed with a new attempt and no stale snapshot; a changed payload on it is a conflict', async () => {
    const key = randomUUID();
    const first = claimOf(await reserve(admin, key, approveHash()));
    await db.pool.query("UPDATE idempotency_records SET state='FAILED' WHERE id=$1 AND attempt_id=$2 AND state='IN_PROGRESS'", [first.id, first.attempt_id]);
    await expect(reserve(admin, key, approveHash(9))).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST' } });
    const second = claimOf(await reserve(admin, key, approveHash()));
    expect(second.id).toBe(first.id);
    expect(second.attempt_id).not.toBe(first.attempt_id);
    expect(await row(key)).toMatchObject({ state: 'IN_PROGRESS', result_json: null, result_schema_version: null, result_cancellation_request_id: null });
    await expect(complete(admin, first, await receipt('APPROVE'))).rejects.toThrow('lost its attempt fence');
    await complete(admin, second, await receipt('APPROVE'));
    expect((await row(key)).state).toBe('COMPLETED');
  });

  it.each([
    ['identical payload', () => approveHash()],
    ['changed payload', () => approveHash(42)],
  ])('an expired COMPLETED key is not replayed (%s): it is reclaimed and its old snapshot cleared', async (_n, hash) => {
    const key = randomUUID();
    await complete(admin, claimOf(await reserve(admin, key, approveHash())), await receipt('APPROVE'));
    await age(key, true);
    const businessBefore = await business();
    const result = await reserve(admin, key, hash());
    expect('claim' in result).toBe(true); // no old 200; S2 re-evaluates business state (409 for a finished decision)
    expect(await row(key)).toMatchObject({ state: 'IN_PROGRESS', result_json: null, result_schema_version: null, result_cancellation_request_id: null });
    expect(await business()).toBe(businessBefore);
  });

  it('a stale IN_PROGRESS attempt is fenced out after reclaim and cannot overwrite the completed receipt', async () => {
    const key = randomUUID();
    const a = claimOf(await reserve(admin, key, approveHash()));
    await expect(reserve(admin, key, approveHash())).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS' } });
    await age(key, false);
    const b = claimOf(await reserve(admin, key, approveHash()));
    expect(b.attempt_id).not.toBe(a.attempt_id);
    const rejectSnapshot = await receipt('REJECT');
    await expect(complete(admin, a, rejectSnapshot)).rejects.toThrow('lost its attempt fence');
    const winner = await complete(admin, b, await receipt('APPROVE'));
    const bytes = await rowBytes(key);
    // Every later write path against the unexpired COMPLETED row is refused or replays.
    await expect(complete(admin, b, rejectSnapshot)).rejects.toThrow('lost its attempt fence');
    await expect(complete(admin, a, rejectSnapshot)).rejects.toThrow('lost its attempt fence');
    await expect(complete(admin2, b, rejectSnapshot)).rejects.toThrow('lost its attempt fence');
    await expect(reserve(admin, key, rejectHash())).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST' } });
    expect(await reserve(admin, key, approveHash())).toEqual({ result: winner, replayed: true });
    expect(await rowBytes(key)).toBe(bytes);
  });

  it('concurrent same-key reservations: the second is refused while the first holds the admission lock', async () => {
    const key = randomUUID();
    const c1 = await db.pool.connect();
    try {
      await c1.query('BEGIN');
      const held = await reserveIn(c1, admin, key, approveHash());
      expect('claim' in held).toBe(true);
      await expect(reserve(admin, key, approveHash())).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS' } });
      await c1.query('COMMIT');
    } finally {
      c1.release();
    }
    await expect(reserve(admin, key, approveHash())).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS' } });
    expect((await db.pool.query('SELECT count(*)::int AS n FROM idempotency_records WHERE key_hash=$1', [digest(key)])).rows[0].n).toBe(1);
  });

  it('completion and a success audit roll back together; the attempt stays IN_PROGRESS without a snapshot', async () => {
    const key = randomUUID();
    const claim = claimOf(await reserve(admin, key, approveHash()));
    const snapshot = await receipt('APPROVE');
    const before = await audits();
    const auditService = new BusinessAuditService();
    await expect(
      tx(async (c) => {
        await completeDecisionReceipt(c, admin, claim, cancellation, snapshot);
        await auditService.recordBusinessAction(c, {
          companyId: admin.companyId, actorAccountId: admin.accountId, action: 'CANCELLATION_APPROVED',
          resourceType: 'CANCELLATION_REQUEST', resourceId: cancellation,
          oldValues: { status: 'OPEN' }, newValues: { status: 'APPROVED' }, correlationId: randomUUID(),
        });
        throw new Error('injected failure after audit');
      }),
    ).rejects.toThrow('injected failure after audit');
    expect(await audits()).toBe(before);
    expect(await row(key)).toMatchObject({ state: 'IN_PROGRESS', result_json: null, result_cancellation_request_id: null });
    // A failing audit insert inside the completion transaction also rolls the snapshot back.
    await expect(
      tx(async (c) => {
        await completeDecisionReceipt(c, admin, claim, cancellation, snapshot);
        await c.query("INSERT INTO audit_event(company_id) VALUES('not-a-uuid')");
      }),
    ).rejects.toBeTruthy();
    expect(await row(key)).toMatchObject({ state: 'IN_PROGRESS', result_json: null });
    expect(await audits()).toBe(before);
  });

  it('isolates scope by tenant and actor, and binds replay to the requested resource', async () => {
    const key = randomUUID();
    const done = await complete(admin, claimOf(await reserve(admin, key, approveHash())), await receipt('APPROVE'));
    // Same key, other admin of the same company: independent scope, never the first admin's receipt.
    expect('claim' in (await reserve(admin2, key, approveHash()))).toBe(true);
    // Same key in another tenant: independent scope.
    const foreignHash = decisionFingerprint({ decision: 'APPROVE', requestId: foreignCancellation, needVersion: 1, dutyVersion: 1 });
    expect('claim' in (await reserve(foreignAdmin, key, foreignHash, foreignCancellation))).toBe(true);
    // Another tenant cannot complete this tenant's attempt.
    const claim = claimOf(await reserve(admin, randomUUID(), approveHash()));
    await expect(complete(foreignAdmin, claim, await receipt('APPROVE'))).rejects.toThrow('lost its attempt fence');
    // A stored receipt is never served for another request id (fails closed).
    await expect(reserve(admin, key, approveHash(), foreignCancellation)).rejects.toThrow('Invalid cancellation decision receipt');
    expect(await reserve(admin, key, approveHash())).toEqual({ result: done, replayed: true });
  });

  it('refuses an invalid snapshot before writing', async () => {
    const key = randomUUID();
    const claim = claimOf(await reserve(admin, key, approveHash()));
    const bad = (await receipt('APPROVE')) as any;
    bad.cancellation.employee.email = 'x@example.invalid';
    await expect(complete(admin, claim, bad)).rejects.toThrow('Invalid cancellation decision receipt');
    expect(await row(key)).toMatchObject({ state: 'IN_PROGRESS', result_json: null });
    expect(need).toBeTruthy();
  });
});

describe('resource binding of completion (TL review PR #126)', () => {
  it.each(['APPROVE', 'REJECT'] as const)(
    '%s: a claim for cancellation A refuses a valid same-tenant receipt for cancellation B, then completes for A',
    async (decision) => {
      const key = randomUUID();
      const hashA = decision === 'APPROVE' ? approveHash() : rejectHash();
      const claim = claimOf(await reserve(admin, key, hashA));
      const receiptB = await receipt(decision, f.tenant.companyId, sameTenantB);
      expect(receiptB.cancellation.id).toBe(sameTenantB);
      const before = await rowBytes(key);
      await expect(complete(admin, claim, receiptB, cancellation)).rejects.toThrow('Invalid cancellation decision receipt: cancellation.id');
      expect(await rowBytes(key)).toBe(before);
      expect(await row(key)).toMatchObject({ state: 'IN_PROGRESS', result_json: null, result_cancellation_request_id: null, attempt_id: claim.attempt_id });
      const receiptA = await receipt(decision);
      const first = await complete(admin, claim, receiptA, cancellation);
      expect(first.cancellation.id).toBe(cancellation);
      expect(await row(key)).toMatchObject({ state: 'COMPLETED', result_cancellation_request_id: cancellation });
      expect(await reserve(admin, key, hashA)).toEqual({ result: first, replayed: true });
    },
  );
  it.each(['APPROVE', 'REJECT'] as const)('%s: completion for B succeeds only when B is the expected command resource', async (decision) => {
    const key = randomUUID();
    const hashB = decision === 'APPROVE'
      ? decisionFingerprint({ decision: 'APPROVE', requestId: sameTenantB, needVersion: 1, dutyVersion: 1 })
      : decisionFingerprint({ decision: 'REJECT', requestId: sameTenantB });
    const claim = claimOf(await reserve(admin, key, hashB, sameTenantB));
    await expect(complete(admin, claim, await receipt(decision), sameTenantB)).rejects.toThrow('cancellation.id');
    const done = await complete(admin, claim, await receipt(decision, f.tenant.companyId, sameTenantB), sameTenantB);
    expect(await reserve(admin, key, hashB, sameTenantB)).toEqual({ result: done, replayed: true });
  });
});
