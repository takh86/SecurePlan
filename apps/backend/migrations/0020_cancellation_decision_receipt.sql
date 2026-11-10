-- SP-21 S1: idempotency operation DECIDE_CANCELLATION with a typed decision-time receipt.
-- Forward-only. No table, column, index or trigger is added. The five existing operation
-- contracts are restated unchanged; only the DECIDE_CANCELLATION arms are new.
-- The receipt is the decision-time response body (result_json, schema version 1):
--   {"cancellation": CancellationResponse, "selectedOffer": null, "updatedDuty": null | Duty+version}
-- Bound: at most 8192 bytes of PostgreSQL JSON text. Closed key sets at every level.
-- CHECKs enforce structure only, not temporal immutability (application fencing does that).

-- (0) Pre-check: no writer for this operation may have run before this migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.idempotency_records WHERE operation = 'DECIDE_CANCELLATION') THEN
    RAISE EXCEPTION 'migration 0020: DECIDE_CANCELLATION idempotency rows already exist';
  END IF;
END
$$;

ALTER TABLE public.idempotency_records
  DROP CONSTRAINT ck_idempotency_records__operation,
  DROP CONSTRAINT ck_idempotency_records__state,
  DROP CONSTRAINT ck_idempotency_records__employee_month;

ALTER TABLE public.idempotency_records
  ADD CONSTRAINT ck_idempotency_records__operation
    CHECK (operation IN ('INITIAL_PUBLISH','EMPLOYEE_MONTH_SAVE','CREATE_CANCELLATION',
      'CREATE_REPLACEMENT_OFFER','DECIDE_REPLACEMENT_SELECTION','DECIDE_CANCELLATION')),
  ADD CONSTRAINT ck_idempotency_records__state CHECK ((
    (state IN ('IN_PROGRESS','FAILED')
      AND result_plan_id IS NULL AND result_cancellation_request_id IS NULL
      AND result_replacement_offer_id IS NULL AND completed_at IS NULL)
    OR (state = 'COMPLETED' AND completed_at IS NOT NULL AND (
      (operation IN ('INITIAL_PUBLISH','EMPLOYEE_MONTH_SAVE')
        AND result_plan_id IS NOT NULL AND result_cancellation_request_id IS NULL
        AND result_replacement_offer_id IS NULL)
      OR (operation = 'CREATE_CANCELLATION'
        AND result_plan_id IS NULL AND result_cancellation_request_id IS NOT NULL
        AND result_replacement_offer_id IS NULL)
      OR (operation = 'CREATE_REPLACEMENT_OFFER'
        AND result_plan_id IS NULL AND result_cancellation_request_id IS NULL
        AND result_replacement_offer_id IS NOT NULL)
      OR (operation = 'DECIDE_REPLACEMENT_SELECTION'
        AND result_plan_id IS NULL AND result_cancellation_request_id IS NOT NULL
        AND result_replacement_offer_id IS NOT NULL)
      OR (operation = 'DECIDE_CANCELLATION'
        AND result_plan_id IS NULL AND result_cancellation_request_id IS NOT NULL
        AND result_replacement_offer_id IS NULL)))
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
    OR (operation IN ('CREATE_CANCELLATION','CREATE_REPLACEMENT_OFFER','DECIDE_REPLACEMENT_SELECTION')
      AND context_plan_id IS NULL AND context_employee_id IS NULL
      AND result_json IS NULL AND result_schema_version IS NULL)
    OR (operation = 'DECIDE_CANCELLATION'
      AND context_plan_id IS NULL AND context_employee_id IS NULL AND (
        (state IN ('IN_PROGRESS','FAILED') AND result_json IS NULL AND result_schema_version IS NULL)
        OR (state = 'COMPLETED' AND result_schema_version = 1 AND result_json IS NOT NULL
          AND jsonb_typeof(result_json) = 'object'
          AND octet_length(result_json::text) <= 8192
          AND result_json ?& ARRAY['cancellation','selectedOffer','updatedDuty']
          AND (result_json - ARRAY['cancellation','selectedOffer','updatedDuty']) = '{}'::jsonb
          AND result_json->'selectedOffer' = 'null'::jsonb
          AND CASE WHEN jsonb_typeof(result_json->'cancellation') = 'object' THEN (
            (result_json->'cancellation') ?& ARRAY['id','assignmentId','employee','duty','status','createdAt','decidedAt','replacementNeed']
            AND ((result_json->'cancellation') - ARRAY['id','assignmentId','employee','duty','status','createdAt','decidedAt','replacementNeed']) = '{}'::jsonb
            AND result_json->'cancellation'->>'id' = result_cancellation_request_id::text
            AND jsonb_typeof(result_json->'cancellation'->'assignmentId') = 'string'
            AND result_json->'cancellation'->>'assignmentId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            AND jsonb_typeof(result_json->'cancellation'->'createdAt') = 'string'
            AND result_json->'cancellation'->>'createdAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
            AND jsonb_typeof(result_json->'cancellation'->'decidedAt') = 'string'
            AND result_json->'cancellation'->>'decidedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
            AND result_json->'cancellation'->>'status' IN ('APPROVED','REJECTED')
            AND CASE WHEN jsonb_typeof(result_json->'cancellation'->'employee') = 'object' THEN (
              (result_json->'cancellation'->'employee') ?& ARRAY['id','employeeCode','firstName','lastName']
              AND ((result_json->'cancellation'->'employee') - ARRAY['id','employeeCode','firstName','lastName']) = '{}'::jsonb
              AND jsonb_typeof(result_json->'cancellation'->'employee'->'id') = 'string'
              AND result_json->'cancellation'->'employee'->>'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              AND jsonb_typeof(result_json->'cancellation'->'employee'->'employeeCode') = 'string'
              AND jsonb_typeof(result_json->'cancellation'->'employee'->'firstName') = 'string'
              AND jsonb_typeof(result_json->'cancellation'->'employee'->'lastName') = 'string'
            ) ELSE false END
            AND CASE WHEN jsonb_typeof(result_json->'cancellation'->'duty') = 'object' THEN (
              (result_json->'cancellation'->'duty') ?& ARRAY['id','dutyDate','shiftKind','startsAt','endsAt']
              AND ((result_json->'cancellation'->'duty') - ARRAY['id','dutyDate','shiftKind','startsAt','endsAt']) = '{}'::jsonb
              AND jsonb_typeof(result_json->'cancellation'->'duty'->'id') = 'string'
              AND result_json->'cancellation'->'duty'->>'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              AND jsonb_typeof(result_json->'cancellation'->'duty'->'dutyDate') = 'string'
              AND result_json->'cancellation'->'duty'->>'dutyDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
              AND result_json->'cancellation'->'duty'->>'shiftKind' IN ('DAY','NIGHT')
              AND jsonb_typeof(result_json->'cancellation'->'duty'->'startsAt') = 'string'
              AND result_json->'cancellation'->'duty'->>'startsAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
              AND jsonb_typeof(result_json->'cancellation'->'duty'->'endsAt') = 'string'
              AND result_json->'cancellation'->'duty'->>'endsAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
            ) ELSE false END
            AND CASE WHEN jsonb_typeof(result_json->'cancellation'->'replacementNeed') = 'object' THEN (
              (result_json->'cancellation'->'replacementNeed') ?& ARRAY['id','status','resolvedAt']
              AND ((result_json->'cancellation'->'replacementNeed') - ARRAY['id','status','resolvedAt']) = '{}'::jsonb
              AND jsonb_typeof(result_json->'cancellation'->'replacementNeed'->'id') = 'string'
              AND result_json->'cancellation'->'replacementNeed'->>'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              AND result_json->'cancellation'->'replacementNeed'->'resolvedAt' = 'null'::jsonb
            ) ELSE false END
          ) ELSE false END
          AND CASE
            WHEN result_json->'cancellation'->>'status' = 'APPROVED' THEN (
              result_json->'cancellation'->'replacementNeed'->>'status' = 'OPEN_UNFILLED'
              AND CASE WHEN jsonb_typeof(result_json->'updatedDuty') = 'object' THEN (
                (result_json->'updatedDuty') ?& ARRAY['id','dutyDate','shiftKind','startsAt','endsAt','concurrencyVersion']
                AND ((result_json->'updatedDuty') - ARRAY['id','dutyDate','shiftKind','startsAt','endsAt','concurrencyVersion']) = '{}'::jsonb
                AND ((result_json->'updatedDuty') - 'concurrencyVersion') = result_json->'cancellation'->'duty'
                AND CASE WHEN jsonb_typeof(result_json->'updatedDuty'->'concurrencyVersion') = 'number'
                  THEN (result_json->'updatedDuty'->>'concurrencyVersion')::numeric BETWEEN 2 AND 9007199254740991
                    AND scale((result_json->'updatedDuty'->>'concurrencyVersion')::numeric) = 0
                  ELSE false END
              ) ELSE false END
            )
            WHEN result_json->'cancellation'->>'status' = 'REJECTED' THEN (
              result_json->'cancellation'->'replacementNeed'->>'status' = 'CLOSED'
              AND result_json->'updatedDuty' = 'null'::jsonb
            )
            ELSE false
          END
        )))
  ) IS TRUE);
