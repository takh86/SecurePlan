-- SP18-P1: retained offer history; D06 lifecycle finalization, not human approval.
CREATE TABLE public.replacement_offers (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  need_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  CONSTRAINT pk_replacement_offers PRIMARY KEY (id),
  CONSTRAINT uq_replacement_offers__company_id UNIQUE (company_id, id),
  CONSTRAINT fk_replacement_offers__need
    FOREIGN KEY (company_id, need_id)
    REFERENCES public.replacement_needs(company_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_replacement_offers__employee
    FOREIGN KEY (company_id, employee_id)
    REFERENCES public.employees(company_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_replacement_offers__status
    CHECK (status IN ('OPEN','SELECTED','NOT_SELECTED','INVALIDATED','WITHDRAWN')),
  CONSTRAINT ck_replacement_offers__time
    CHECK (isfinite(created_at) AND isfinite(updated_at)
      AND updated_at >= created_at
      AND (decided_at IS NULL OR (isfinite(decided_at)
        AND decided_at >= created_at AND decided_at <= updated_at))),
  CONSTRAINT ck_replacement_offers__finalization
    CHECK ((status = 'OPEN' AND decided_at IS NULL)
      OR (status IN ('SELECTED','NOT_SELECTED','INVALIDATED','WITHDRAWN')
        AND decided_at IS NOT NULL))
);
CREATE UNIQUE INDEX uq_replacement_offers__active_employee_need
  ON public.replacement_offers (company_id, need_id, employee_id)
  WHERE status IN ('OPEN','SELECTED');
CREATE UNIQUE INDEX uq_replacement_offers__selected_need
  ON public.replacement_offers (company_id, need_id)
  WHERE status = 'SELECTED';
CREATE INDEX idx_replacement_offers__employee_history
  ON public.replacement_offers (company_id, employee_id, created_at, id);
CREATE INDEX idx_replacement_offers__need_history
  ON public.replacement_offers (company_id, need_id, created_at, id);

-- Typed result contract only. The offer command is a separately reviewed slice.
ALTER TABLE public.idempotency_records
  ADD COLUMN result_replacement_offer_id uuid,
  ADD CONSTRAINT fk_idempotency_records__offer_result
    FOREIGN KEY (company_id, result_replacement_offer_id)
    REFERENCES public.replacement_offers(company_id, id) ON DELETE RESTRICT;
ALTER TABLE public.idempotency_records
  DROP CONSTRAINT ck_idempotency_records__operation,
  DROP CONSTRAINT ck_idempotency_records__state,
  DROP CONSTRAINT ck_idempotency_records__employee_month;
ALTER TABLE public.idempotency_records
  ADD CONSTRAINT ck_idempotency_records__operation
    CHECK (operation IN ('INITIAL_PUBLISH','EMPLOYEE_MONTH_SAVE','CREATE_CANCELLATION','CREATE_REPLACEMENT_OFFER')),
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
        AND result_replacement_offer_id IS NOT NULL)))
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
    OR (operation IN ('CREATE_CANCELLATION','CREATE_REPLACEMENT_OFFER')
      AND context_plan_id IS NULL AND context_employee_id IS NULL
      AND result_json IS NULL AND result_schema_version IS NULL)
  ) IS TRUE);
