/** PostgreSQL 17 signature through 0017. New A2 paths fail closed on drift. */
import type { PoolClient } from 'pg';

const expected = {
  columns: [
    'id uuid NOT NULL DEFAULT gen_random_uuid()',
    'company_id uuid NOT NULL',
    'actor_account_id uuid NOT NULL',
    'operation text NOT NULL',
    'key_hash bytea NOT NULL',
    'request_hash bytea NOT NULL',
    'attempt_id uuid NOT NULL DEFAULT gen_random_uuid()',
    "state text NOT NULL DEFAULT 'IN_PROGRESS'::text",
    'result_plan_id uuid',
    'created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()',
    'claimed_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()',
    'completed_at timestamp with time zone',
    'expires_at timestamp with time zone NOT NULL',
    'context_plan_id uuid',
    'context_employee_id uuid',
    'result_json jsonb',
    'result_schema_version smallint',
    'result_cancellation_request_id uuid',
  ],
  constraints: [
    "ck_idempotency_records__employee_month CHECK (((((operation = 'INITIAL_PUBLISH'::text) AND (context_plan_id IS NULL) AND (context_employee_id IS NULL) AND (result_json IS NULL) AND (result_schema_version IS NULL)) OR ((operation = 'EMPLOYEE_MONTH_SAVE'::text) AND (context_plan_id IS NOT NULL) AND (context_employee_id IS NOT NULL) AND (((state = ANY (ARRAY['IN_PROGRESS'::text, 'FAILED'::text])) AND (result_json IS NULL) AND (result_schema_version IS NULL)) OR ((state = 'COMPLETED'::text) AND (result_plan_id = context_plan_id) AND (result_schema_version = 2) AND (result_json IS NOT NULL) AND (jsonb_typeof(result_json) = 'object'::text) AND (octet_length((result_json)::text) <= 131072) AND (result_json ?& ARRAY['commandId'::text, 'outcome'::text, 'completedAt'::text, 'plan'::text, 'employeeId'::text, 'counts'::text, 'changes'::text]) AND (jsonb_typeof((result_json -> 'changes'::text)) = 'array'::text) AND\nCASE\n    WHEN (jsonb_typeof((result_json -> 'changes'::text)) = 'array'::text) THEN (jsonb_array_length((result_json -> 'changes'::text)) <= 62)\n    ELSE false\nEND AND ((result_json ->> 'employeeId'::text) = (context_employee_id)::text) AND (((result_json -> 'plan'::text) ->> 'id'::text) = (context_plan_id)::text) AND ((result_json ->> 'outcome'::text) = ANY (ARRAY['APPLIED'::text, 'NO_OP'::text])) AND (jsonb_typeof((result_json -> 'counts'::text)) = 'object'::text) AND (jsonb_typeof((result_json -> 'commandId'::text)) = 'string'::text) AND (jsonb_typeof((result_json -> 'completedAt'::text)) = 'string'::text)))) OR ((operation = 'CREATE_CANCELLATION'::text) AND (context_plan_id IS NULL) AND (context_employee_id IS NULL) AND (result_json IS NULL) AND (result_schema_version IS NULL))) IS TRUE))",
    'ck_idempotency_records__hashes CHECK (((octet_length(key_hash) = 32) AND (octet_length(request_hash) = 32)))',
    "ck_idempotency_records__operation CHECK ((operation = ANY (ARRAY['INITIAL_PUBLISH'::text, 'EMPLOYEE_MONTH_SAVE'::text, 'CREATE_CANCELLATION'::text])))",
    "ck_idempotency_records__state CHECK (((((state = ANY (ARRAY['IN_PROGRESS'::text, 'FAILED'::text])) AND (result_plan_id IS NULL) AND (result_cancellation_request_id IS NULL) AND (completed_at IS NULL)) OR ((state = 'COMPLETED'::text) AND (completed_at IS NOT NULL) AND (((operation = ANY (ARRAY['INITIAL_PUBLISH'::text, 'EMPLOYEE_MONTH_SAVE'::text])) AND (result_plan_id IS NOT NULL) AND (result_cancellation_request_id IS NULL)) OR ((operation = 'CREATE_CANCELLATION'::text) AND (result_plan_id IS NULL) AND (result_cancellation_request_id IS NOT NULL))))) IS TRUE))",
    'ck_idempotency_records__time CHECK ((isfinite(created_at) AND isfinite(claimed_at) AND isfinite(expires_at) AND (expires_at > created_at) AND (expires_at > claimed_at) AND ((completed_at IS NULL) OR (isfinite(completed_at) AND (expires_at > completed_at)))))',
    'fk_idempotency_records__actor FOREIGN KEY (company_id, actor_account_id) REFERENCES accounts(company_id, id) ON DELETE RESTRICT',
    'fk_idempotency_records__cancellation_result FOREIGN KEY (company_id, result_cancellation_request_id) REFERENCES cancellation_requests(company_id, id) ON DELETE RESTRICT',
    'fk_idempotency_records__context_employee FOREIGN KEY (company_id, context_employee_id) REFERENCES employees(company_id, id) ON DELETE RESTRICT',
    'fk_idempotency_records__context_plan FOREIGN KEY (company_id, context_plan_id) REFERENCES monthly_plans(company_id, id) ON DELETE RESTRICT',
    'fk_idempotency_records__result FOREIGN KEY (company_id, result_plan_id) REFERENCES monthly_plans(company_id, id) ON DELETE RESTRICT',
    'idempotency_records_pkey PRIMARY KEY (id)',
    'uq_idempotency_records__scope UNIQUE (company_id, actor_account_id, operation, key_hash)',
  ],
} as const;

export async function assertEmployeeMonthReceiptSchema(
  c: PoolClient,
): Promise<void> {
  await c.query('LOCK TABLE public.idempotency_records IN ACCESS SHARE MODE');
  const row = (
    await c.query<{ safe: boolean; columns: string[]; constraints: string[] }>(`
    SELECT t.relkind='r' AND t.relpersistence='p' AND NOT t.relrowsecurity AND NOT t.relforcerowsecurity AND NOT t.relispartition
      AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=t.oid AND NOT convalidated)
      AND NOT EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=t.oid OR inhparent=t.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=t.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_constraint f JOIN pg_class r ON r.oid=f.confrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE f.conrelid=t.oid AND f.contype='f' AND n.nspname<>'public')
      AND EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=t.oid AND pg_get_indexdef(i.indexrelid)='CREATE INDEX idx_idempotency_records__expiry ON public.idempotency_records USING btree (expires_at, id)')
      AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=t.oid AND (NOT tgisinternal OR tgenabled<>'O'))
      AND NOT EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=t.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid=t.oid AND (NOT indisvalid OR NOT indisready OR NOT indislive)) AS safe,
      ARRAY(SELECT a.attname || ' ' || format_type(a.atttypid,a.atttypmod)
        || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
        || coalesce(' DEFAULT ' || pg_get_expr(d.adbin,d.adrelid),'')
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum) AS columns,
      ARRAY(SELECT conname || ' ' || pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid=t.oid ORDER BY conname) AS constraints
    FROM pg_class t WHERE t.oid='public.idempotency_records'::regclass`)
  ).rows[0];
  if (
    !row?.safe ||
    JSON.stringify(row.columns) !== JSON.stringify(expected.columns) ||
    JSON.stringify(row.constraints) !== JSON.stringify(expected.constraints)
  )
    throw new Error('Unusable employee-month receipt schema');
}
