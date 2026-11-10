/**
 * SP-21 S1: the shared reservation codec. The inline snapshot of the five pre-existing operations
 * (whitespace-normalized) was captured from the unmodified origin/main codec (3dbeaef) before DECIDE_CANCELLATION was
 * added, so any change to their SQL fails here.
 */
import type { PoolClient } from 'pg';
import type { TenantContext } from '../../auth/authorization/tenant-context.js';
import { reserveCommand, type CommandReservation } from './command-reservation.js';

const tenant: TenantContext = {
  sessionId: '00000000-0000-4000-8000-000000000001',
  accountId: '00000000-0000-4000-8000-000000000002',
  companyId: '00000000-0000-4000-8000-000000000003',
  role: 'COMPANY_ADMIN',
};
const hash = Buffer.alloc(32, 1);
type Scenario = 'insert' | 'reclaim' | 'replay';

async function run(operation: string, scenario: Scenario, context?: { planId: string; employeeId: string }) {
  const calls: { sql: string; params: number }[] = [];
  const prior: Partial<CommandReservation> | undefined =
    scenario === 'insert'
      ? undefined
      : { id: 'row', attempt_id: 'old', state: 'COMPLETED', request_hash: hash, result_plan_id: null, unexpired: scenario === 'replay', stale: false };
  const client = {
    query: (sql: string, params: unknown[] = []) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params.length });
      if (sql.includes('pg_try_advisory_xact_lock')) return Promise.resolve({ rows: [{ held: true }] });
      if (sql.includes('FOR UPDATE')) return Promise.resolve({ rows: prior ? [prior] : [] });
      return Promise.resolve({ rows: [{ id: 'row', attempt_id: 'new' }] });
    },
  } as unknown as PoolClient;
  const replayed: unknown[] = [];
  const result = await reserveCommand(client, {
    tenant,
    operation,
    keyHash: hash,
    requestHash: hash,
    lockId: '1',
    retention: 86400,
    stale: 300,
    context,
    replay: (p) => {
      replayed.push(p);
      return Promise.resolve('REPLAYED');
    },
  });
  return { calls, result, replayed };
}

const context = { planId: 'plan', employeeId: 'employee' };
const existing: [string, { planId: string; employeeId: string } | undefined][] = [
  ['INITIAL_PUBLISH', undefined],
  ['EMPLOYEE_MONTH_SAVE', context],
  ['CREATE_CANCELLATION', undefined],
  ['CREATE_REPLACEMENT_OFFER', undefined],
  ['DECIDE_REPLACEMENT_SELECTION', undefined],
];

describe('reserveCommand codec', () => {
  it('keeps the whitespace-normalized SQL of the five pre-existing operations unchanged', async () => {
    const out: Record<string, unknown> = {};
    for (const [operation, ctx] of existing)
      for (const scenario of ['insert', 'reclaim'] as const) out[`${operation} ${scenario}`] = (await run(operation, scenario, ctx)).calls;
    expect(out).toMatchInlineSnapshot(`
      {
        "CREATE_CANCELLATION insert": [
          {
            "params": 1,
            "sql": "SELECT pg_try_advisory_xact_lock($1::bigint) AS held",
          },
          {
            "params": 5,
            "sql": "SELECT id,attempt_id,state,request_hash,result_plan_id,result_cancellation_request_id, expires_at>clock_timestamp() AS unexpired,claimed_at<=clock_timestamp()-$5::int*interval '1 second' AS stale FROM public.idempotency_records WHERE company_id=$1 AND actor_account_id=$2 AND operation=$3 AND key_hash=$4 FOR UPDATE",
          },
          {
            "params": 6,
            "sql": "WITH moment AS (SELECT clock_timestamp() AS at) INSERT INTO public.idempotency_records(company_id,actor_account_id,operation,key_hash,request_hash,created_at,claimed_at,expires_at) SELECT $1,$2,$3,$4,$5,at,at,at+$6::int*interval '1 second' FROM moment RETURNING id,attempt_id",
          },
        ],
        "CREATE_CANCELLATION reclaim": [
          {
            "params": 1,
            "sql": "SELECT pg_try_advisory_xact_lock($1::bigint) AS held",
          },
          {
            "params": 5,
            "sql": "SELECT id,attempt_id,state,request_hash,result_plan_id,result_cancellation_request_id, expires_at>clock_timestamp() AS unexpired,claimed_at<=clock_timestamp()-$5::int*interval '1 second' AS stale FROM public.idempotency_records WHERE company_id=$1 AND actor_account_id=$2 AND operation=$3 AND key_hash=$4 FOR UPDATE",
          },
          {
            "params": 4,
            "sql": "WITH moment AS (SELECT clock_timestamp() AS at) UPDATE public.idempotency_records SET attempt_id=gen_random_uuid(),state='IN_PROGRESS',request_hash=$3, result_plan_id=NULL,completed_at=NULL,claimed_at=at,expires_at=at+$4::int*interval '1 second',result_cancellation_request_id=NULL FROM moment WHERE company_id=$1 AND id=$2 RETURNING id,attempt_id",
          },
        ],
        "CREATE_REPLACEMENT_OFFER insert": [
          {
            "params": 1,
            "sql": "SELECT pg_try_advisory_xact_lock($1::bigint) AS held",
          },
          {
            "params": 5,
            "sql": "SELECT id,attempt_id,state,request_hash,result_plan_id,result_replacement_offer_id, expires_at>clock_timestamp() AS unexpired,claimed_at<=clock_timestamp()-$5::int*interval '1 second' AS stale FROM public.idempotency_records WHERE company_id=$1 AND actor_account_id=$2 AND operation=$3 AND key_hash=$4 FOR UPDATE",
          },
          {
            "params": 6,
            "sql": "WITH moment AS (SELECT clock_timestamp() AS at) INSERT INTO public.idempotency_records(company_id,actor_account_id,operation,key_hash,request_hash,created_at,claimed_at,expires_at) SELECT $1,$2,$3,$4,$5,at,at,at+$6::int*interval '1 second' FROM moment RETURNING id,attempt_id",
          },
        ],
        "CREATE_REPLACEMENT_OFFER reclaim": [
          {
            "params": 1,
            "sql": "SELECT pg_try_advisory_xact_lock($1::bigint) AS held",
          },
          {
            "params": 5,
            "sql": "SELECT id,attempt_id,state,request_hash,result_plan_id,result_replacement_offer_id, expires_at>clock_timestamp() AS unexpired,claimed_at<=clock_timestamp()-$5::int*interval '1 second' AS stale FROM public.idempotency_records WHERE company_id=$1 AND actor_account_id=$2 AND operation=$3 AND key_hash=$4 FOR UPDATE",
          },
          {
            "params": 4,
            "sql": "WITH moment AS (SELECT clock_timestamp() AS at) UPDATE public.idempotency_records SET attempt_id=gen_random_uuid(),state='IN_PROGRESS',request_hash=$3, result_plan_id=NULL,completed_at=NULL,claimed_at=at,expires_at=at+$4::int*interval '1 second',result_replacement_offer_id=NULL FROM moment WHERE company_id=$1 AND id=$2 RETURNING id,attempt_id",
          },
        ],
        "DECIDE_REPLACEMENT_SELECTION insert": [
          {
            "params": 1,
            "sql": "SELECT pg_try_advisory_xact_lock($1::bigint) AS held",
          },
          {
            "params": 5,
            "sql": "SELECT id,attempt_id,state,request_hash,result_plan_id,result_cancellation_request_id,result_replacement_offer_id, expires_at>clock_timestamp() AS unexpired,claimed_at<=clock_timestamp()-$5::int*interval '1 second' AS stale FROM public.idempotency_records WHERE company_id=$1 AND actor_account_id=$2 AND operation=$3 AND key_hash=$4 FOR UPDATE",
          },
          {
            "params": 6,
            "sql": "WITH moment AS (SELECT clock_timestamp() AS at) INSERT INTO public.idempotency_records(company_id,actor_account_id,operation,key_hash,request_hash,created_at,claimed_at,expires_at) SELECT $1,$2,$3,$4,$5,at,at,at+$6::int*interval '1 second' FROM moment RETURNING id,attempt_id",
          },
        ],
        "DECIDE_REPLACEMENT_SELECTION reclaim": [
          {
            "params": 1,
            "sql": "SELECT pg_try_advisory_xact_lock($1::bigint) AS held",
          },
          {
            "params": 5,
            "sql": "SELECT id,attempt_id,state,request_hash,result_plan_id,result_cancellation_request_id,result_replacement_offer_id, expires_at>clock_timestamp() AS unexpired,claimed_at<=clock_timestamp()-$5::int*interval '1 second' AS stale FROM public.idempotency_records WHERE company_id=$1 AND actor_account_id=$2 AND operation=$3 AND key_hash=$4 FOR UPDATE",
          },
          {
            "params": 4,
            "sql": "WITH moment AS (SELECT clock_timestamp() AS at) UPDATE public.idempotency_records SET attempt_id=gen_random_uuid(),state='IN_PROGRESS',request_hash=$3, result_plan_id=NULL,completed_at=NULL,claimed_at=at,expires_at=at+$4::int*interval '1 second',result_cancellation_request_id=NULL,result_replacement_offer_id=NULL FROM moment WHERE company_id=$1 AND id=$2 RETURNING id,attempt_id",
          },
        ],
        "EMPLOYEE_MONTH_SAVE insert": [
          {
            "params": 1,
            "sql": "SELECT pg_try_advisory_xact_lock($1::bigint) AS held",
          },
          {
            "params": 5,
            "sql": "SELECT id,attempt_id,state,request_hash,result_plan_id,context_plan_id,context_employee_id,result_json,result_schema_version, expires_at>clock_timestamp() AS unexpired,claimed_at<=clock_timestamp()-$5::int*interval '1 second' AS stale FROM public.idempotency_records WHERE company_id=$1 AND actor_account_id=$2 AND operation=$3 AND key_hash=$4 FOR UPDATE",
          },
          {
            "params": 8,
            "sql": "WITH moment AS (SELECT clock_timestamp() AS at) INSERT INTO public.idempotency_records(company_id,actor_account_id,operation,key_hash,request_hash,created_at,claimed_at,expires_at,context_plan_id,context_employee_id) SELECT $1,$2,$3,$4,$5,at,at,at+$6::int*interval '1 second',$7,$8 FROM moment RETURNING id,attempt_id",
          },
        ],
        "EMPLOYEE_MONTH_SAVE reclaim": [
          {
            "params": 1,
            "sql": "SELECT pg_try_advisory_xact_lock($1::bigint) AS held",
          },
          {
            "params": 5,
            "sql": "SELECT id,attempt_id,state,request_hash,result_plan_id,context_plan_id,context_employee_id,result_json,result_schema_version, expires_at>clock_timestamp() AS unexpired,claimed_at<=clock_timestamp()-$5::int*interval '1 second' AS stale FROM public.idempotency_records WHERE company_id=$1 AND actor_account_id=$2 AND operation=$3 AND key_hash=$4 FOR UPDATE",
          },
          {
            "params": 6,
            "sql": "WITH moment AS (SELECT clock_timestamp() AS at) UPDATE public.idempotency_records SET attempt_id=gen_random_uuid(),state='IN_PROGRESS',request_hash=$3, result_plan_id=NULL,completed_at=NULL,claimed_at=at,expires_at=at+$4::int*interval '1 second',context_plan_id=$5,context_employee_id=$6,result_json=NULL,result_schema_version=NULL FROM moment WHERE company_id=$1 AND id=$2 RETURNING id,attempt_id",
          },
        ],
        "INITIAL_PUBLISH insert": [
          {
            "params": 1,
            "sql": "SELECT pg_try_advisory_xact_lock($1::bigint) AS held",
          },
          {
            "params": 5,
            "sql": "SELECT id,attempt_id,state,request_hash,result_plan_id, expires_at>clock_timestamp() AS unexpired,claimed_at<=clock_timestamp()-$5::int*interval '1 second' AS stale FROM public.idempotency_records WHERE company_id=$1 AND actor_account_id=$2 AND operation=$3 AND key_hash=$4 FOR UPDATE",
          },
          {
            "params": 6,
            "sql": "WITH moment AS (SELECT clock_timestamp() AS at) INSERT INTO public.idempotency_records(company_id,actor_account_id,operation,key_hash,request_hash,created_at,claimed_at,expires_at) SELECT $1,$2,$3,$4,$5,at,at,at+$6::int*interval '1 second' FROM moment RETURNING id,attempt_id",
          },
        ],
        "INITIAL_PUBLISH reclaim": [
          {
            "params": 1,
            "sql": "SELECT pg_try_advisory_xact_lock($1::bigint) AS held",
          },
          {
            "params": 5,
            "sql": "SELECT id,attempt_id,state,request_hash,result_plan_id, expires_at>clock_timestamp() AS unexpired,claimed_at<=clock_timestamp()-$5::int*interval '1 second' AS stale FROM public.idempotency_records WHERE company_id=$1 AND actor_account_id=$2 AND operation=$3 AND key_hash=$4 FOR UPDATE",
          },
          {
            "params": 4,
            "sql": "WITH moment AS (SELECT clock_timestamp() AS at) UPDATE public.idempotency_records SET attempt_id=gen_random_uuid(),state='IN_PROGRESS',request_hash=$3, result_plan_id=NULL,completed_at=NULL,claimed_at=at,expires_at=at+$4::int*interval '1 second' FROM moment WHERE company_id=$1 AND id=$2 RETURNING id,attempt_id",
          },
        ],
      }
    `);
  });

  it('DECIDE_CANCELLATION selects the typed result and its receipt columns, never the employee-month context', async () => {
    const { calls } = await run('DECIDE_CANCELLATION', 'replay');
    expect(calls[1].sql).toContain('SELECT id,attempt_id,state,request_hash,result_plan_id,result_cancellation_request_id,result_json,result_schema_version,');
    expect(calls[1].sql).not.toContain('context_plan_id');
    expect(calls).toHaveLength(2);
  });

  it('DECIDE_CANCELLATION replays an unexpired COMPLETED row without writing', async () => {
    const { calls, result, replayed } = await run('DECIDE_CANCELLATION', 'replay');
    expect(result).toEqual({ result: 'REPLAYED', replayed: true });
    expect(replayed).toHaveLength(1);
    expect(calls.some((c) => /^(WITH moment AS \(SELECT clock_timestamp\(\) AS at\) )?(UPDATE|INSERT)/.test(c.sql))).toBe(false);
  });

  it('DECIDE_CANCELLATION reclaim clears the stale typed result and the stale snapshot', async () => {
    const { calls } = await run('DECIDE_CANCELLATION', 'reclaim');
    const update = calls.find((c) => c.sql.includes('UPDATE public.idempotency_records'));
    expect(update?.sql).toContain(',result_cancellation_request_id=NULL,result_json=NULL,result_schema_version=NULL');
    expect(update?.sql).not.toContain('context_plan_id');
    expect(update?.params).toBe(4);
  });

  it('DECIDE_CANCELLATION insert carries no context columns', async () => {
    const { calls } = await run('DECIDE_CANCELLATION', 'insert');
    const insert = calls.find((c) => c.sql.includes('INSERT INTO public.idempotency_records'));
    expect(insert?.sql).toContain('(company_id,actor_account_id,operation,key_hash,request_hash,created_at,claimed_at,expires_at)');
    expect(insert?.params).toBe(6);
  });

  it('DECIDE_CANCELLATION refuses an employee-month context', async () => {
    await expect(run('DECIDE_CANCELLATION', 'insert', context)).rejects.toThrow('DECIDE_CANCELLATION takes no context');
  });
});
