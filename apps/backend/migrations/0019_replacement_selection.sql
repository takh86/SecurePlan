-- SP-20 atomic replacement selection (design: SP20 R2a + amendments R3).
-- Forward-only. Pre-checks fail loudly before any constraint is added; no row is rewritten
-- except the documented offer.duty_id backfill, which is derived from its need.

-- (0) Pre-checks: refuse to run if existing rows already violate a new invariant.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.replacement_needs WHERE status = 'RESOLVED') THEN
    RAISE EXCEPTION 'migration 0019: RESOLVED replacement needs exist; no selection writer may have run';
  END IF;
  IF EXISTS (SELECT 1 FROM public.plan_assignments WHERE source = 'REPLACEMENT') THEN
    RAISE EXCEPTION 'migration 0019: REPLACEMENT plan assignments exist without a selected offer';
  END IF;
END
$$;

-- (1) Need: duty-scoped key, monotonic version, selected offer.
ALTER TABLE public.replacement_needs
  ADD CONSTRAINT uq_replacement_needs__duty UNIQUE (company_id, id, duty_id),
  ADD COLUMN selected_offer_id uuid,
  ADD COLUMN concurrency_version bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT ck_replacement_needs__version
    CHECK (concurrency_version BETWEEN 1 AND 9007199254740991),
  ADD CONSTRAINT ck_replacement_needs__selection
    CHECK ((status = 'RESOLVED') = (selected_offer_id IS NOT NULL));

-- (2) Offer: duty is part of its identity (denormalised from the need, enforced by a composite key).
ALTER TABLE public.replacement_offers
  ADD COLUMN duty_id uuid;
UPDATE public.replacement_offers o
  SET duty_id = n.duty_id
  FROM public.replacement_needs n
  WHERE n.company_id = o.company_id AND n.id = o.need_id;
ALTER TABLE public.replacement_offers
  ALTER COLUMN duty_id SET NOT NULL,
  ADD CONSTRAINT uq_replacement_offers__need UNIQUE (company_id, id, need_id),
  ADD CONSTRAINT uq_replacement_offers__membership UNIQUE (company_id, id, duty_id, employee_id),
  ADD CONSTRAINT fk_replacement_offers__need_duty
    FOREIGN KEY (company_id, need_id, duty_id)
    REFERENCES public.replacement_needs (company_id, id, duty_id) ON DELETE RESTRICT;

-- (3) Need -> selected offer. Column order maps need_id, so the offer must belong to the same need.
ALTER TABLE public.replacement_needs
  ADD CONSTRAINT fk_replacement_needs__selected_offer
    FOREIGN KEY (company_id, selected_offer_id, id)
    REFERENCES public.replacement_offers (company_id, id, need_id) ON DELETE RESTRICT;

-- (4) Membership -> offer. The composite key fixes tenant, offer, duty and employee together.
ALTER TABLE public.plan_assignments
  ADD COLUMN replacement_offer_id uuid,
  ADD CONSTRAINT fk_plan_assignments__replacement_offer
    FOREIGN KEY (company_id, replacement_offer_id, duty_id, employee_id)
    REFERENCES public.replacement_offers (company_id, id, duty_id, employee_id) ON DELETE RESTRICT,
  ADD CONSTRAINT ck_plan_assignments__replacement_origin CHECK (
    (source = 'NORMAL' AND replacement_offer_id IS NULL)
    OR (source = 'REPLACEMENT' AND replacement_offer_id IS NOT NULL));

-- Lifetime uniqueness (amendment A3): an offer yields at most one REPLACEMENT membership, ever.
-- No state predicate, so a historically removed replacement still occupies its offer.
CREATE UNIQUE INDEX uq_plan_assignments__replacement_offer_lifetime
  ON public.plan_assignments (company_id, replacement_offer_id)
  WHERE source = 'REPLACEMENT';

-- (5) Idempotency: new operation with a typed result (selected offer id + cancellation id).
ALTER TABLE public.idempotency_records
  DROP CONSTRAINT ck_idempotency_records__operation,
  DROP CONSTRAINT ck_idempotency_records__state,
  DROP CONSTRAINT ck_idempotency_records__employee_month;
ALTER TABLE public.idempotency_records
  ADD CONSTRAINT ck_idempotency_records__operation
    CHECK (operation IN ('INITIAL_PUBLISH','EMPLOYEE_MONTH_SAVE','CREATE_CANCELLATION','CREATE_REPLACEMENT_OFFER','DECIDE_REPLACEMENT_SELECTION')),
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
    OR (operation IN ('CREATE_CANCELLATION','CREATE_REPLACEMENT_OFFER','DECIDE_REPLACEMENT_SELECTION')
      AND context_plan_id IS NULL AND context_employee_id IS NULL
      AND result_json IS NULL AND result_schema_version IS NULL)
  ) IS TRUE);
