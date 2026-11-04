-- Typed durable cancellation result; historical publish and version-2 receipts are retained.
ALTER TABLE public.idempotency_records
  ADD COLUMN result_cancellation_request_id uuid,
  ADD CONSTRAINT fk_idempotency_records__cancellation_result
    FOREIGN KEY (company_id, result_cancellation_request_id)
    REFERENCES public.cancellation_requests(company_id, id) ON DELETE RESTRICT;

ALTER TABLE public.idempotency_records
  DROP CONSTRAINT ck_idempotency_records__operation,
  DROP CONSTRAINT ck_idempotency_records__state,
  DROP CONSTRAINT ck_idempotency_records__employee_month;
ALTER TABLE public.idempotency_records
  ADD CONSTRAINT ck_idempotency_records__operation
    CHECK (operation IN ('INITIAL_PUBLISH','EMPLOYEE_MONTH_SAVE','CREATE_CANCELLATION')),
  ADD CONSTRAINT ck_idempotency_records__state CHECK ((
    (state IN ('IN_PROGRESS','FAILED')
      AND result_plan_id IS NULL AND result_cancellation_request_id IS NULL
      AND completed_at IS NULL)
    OR (state = 'COMPLETED' AND completed_at IS NOT NULL AND (
      (operation IN ('INITIAL_PUBLISH','EMPLOYEE_MONTH_SAVE')
        AND result_plan_id IS NOT NULL AND result_cancellation_request_id IS NULL)
      OR (operation = 'CREATE_CANCELLATION'
        AND result_plan_id IS NULL AND result_cancellation_request_id IS NOT NULL)))
  ) IS TRUE),
  ADD CONSTRAINT ck_idempotency_records__employee_month CHECK ((
    (operation = 'INITIAL_PUBLISH'
      AND context_plan_id IS NULL AND context_employee_id IS NULL
      AND result_json IS NULL AND result_schema_version IS NULL)
    OR (operation = 'EMPLOYEE_MONTH_SAVE'
      AND context_plan_id IS NOT NULL AND context_employee_id IS NOT NULL AND (
        (state IN ('IN_PROGRESS','FAILED')
          AND result_json IS NULL AND result_schema_version IS NULL)
        OR (state = 'COMPLETED' AND result_plan_id = context_plan_id
          AND result_schema_version = 2 AND result_json IS NOT NULL
          AND jsonb_typeof(result_json) = 'object'
          AND octet_length(result_json::text) <= 131072
          AND result_json ?& ARRAY[
            'commandId','outcome','completedAt','plan','employeeId','counts','changes']
          AND jsonb_typeof(result_json->'changes') = 'array'
          AND CASE WHEN jsonb_typeof(result_json->'changes') = 'array'
            THEN jsonb_array_length(result_json->'changes') <= 62 ELSE false END
          AND result_json->>'employeeId' = context_employee_id::text
          AND result_json->'plan'->>'id' = context_plan_id::text
          AND result_json->>'outcome' IN ('APPLIED','NO_OP')
          AND jsonb_typeof(result_json->'counts') = 'object'
          AND jsonb_typeof(result_json->'commandId') = 'string'
          AND jsonb_typeof(result_json->'completedAt') = 'string')))
    OR (operation = 'CREATE_CANCELLATION'
      AND context_plan_id IS NULL AND context_employee_id IS NULL
      AND result_json IS NULL AND result_schema_version IS NULL)
  ) IS TRUE);
