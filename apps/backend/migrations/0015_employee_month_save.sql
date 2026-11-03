-- A2-GATE-1: additive operation-specific context and immutable bounded receipt.
-- INITIAL_PUBLISH rows retain their original hashes, fields and codec.
ALTER TABLE public.idempotency_records
  ADD COLUMN context_plan_id UUID,
  ADD COLUMN context_employee_id UUID,
  ADD COLUMN result_json JSONB,
  ADD COLUMN result_schema_version SMALLINT,
  ADD CONSTRAINT fk_idempotency_records__context_plan FOREIGN KEY (company_id, context_plan_id)
    REFERENCES public.monthly_plans (company_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_idempotency_records__context_employee FOREIGN KEY (company_id, context_employee_id)
    REFERENCES public.employees (company_id, id) ON DELETE RESTRICT;
ALTER TABLE public.idempotency_records DROP CONSTRAINT ck_idempotency_records__operation;
ALTER TABLE public.idempotency_records ADD CONSTRAINT ck_idempotency_records__operation
  CHECK (operation IN ('INITIAL_PUBLISH', 'EMPLOYEE_MONTH_SAVE'));
ALTER TABLE public.idempotency_records ADD CONSTRAINT ck_idempotency_records__employee_month CHECK ((
  (operation = 'INITIAL_PUBLISH' AND context_plan_id IS NULL AND context_employee_id IS NULL
    AND result_json IS NULL AND result_schema_version IS NULL)
  OR (operation = 'EMPLOYEE_MONTH_SAVE' AND context_plan_id IS NOT NULL AND context_employee_id IS NOT NULL AND (
    (state IN ('IN_PROGRESS', 'FAILED') AND result_json IS NULL AND result_schema_version IS NULL)
    OR (state = 'COMPLETED' AND result_plan_id = context_plan_id AND result_schema_version = 2
      AND result_json IS NOT NULL AND jsonb_typeof(result_json) = 'object'
      AND octet_length(result_json::text) <= 131072
      AND result_json ?& ARRAY['commandId','outcome','completedAt','plan','employeeId','counts','changes']
      AND jsonb_typeof(result_json->'changes') = 'array'
      AND CASE WHEN jsonb_typeof(result_json->'changes') = 'array' THEN jsonb_array_length(result_json->'changes') <= 62 ELSE false END
      AND result_json->>'employeeId' = context_employee_id::text
      AND result_json->'plan'->>'id' = context_plan_id::text
      AND result_json->>'outcome' IN ('APPLIED','NO_OP')
      AND jsonb_typeof(result_json->'counts') = 'object'
      AND jsonb_typeof(result_json->'commandId') = 'string'
      AND jsonb_typeof(result_json->'completedAt') = 'string')))
) IS TRUE);
