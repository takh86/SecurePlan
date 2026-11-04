-- CR-03 prerequisite: preserve historical identity and require one need per case at commit.
ALTER TABLE public.plan_assignments
  ADD CONSTRAINT uq_plan_assignments__historical_identity
  UNIQUE (company_id, id, duty_id, employee_id);

CREATE TABLE public.cancellation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  duty_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  submission_version bigint NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  decided_by_account_id uuid,
  CONSTRAINT uq_cancellation_requests__tenant_id UNIQUE (company_id, id),
  CONSTRAINT uq_cancellation_requests__duty UNIQUE (company_id, id, duty_id),
  CONSTRAINT fk_cancellation_requests__assignment
    FOREIGN KEY (company_id, assignment_id, duty_id, employee_id)
    REFERENCES public.plan_assignments(company_id, id, duty_id, employee_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_cancellation_requests__duty
    FOREIGN KEY (company_id, duty_id)
    REFERENCES public.duties(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_cancellation_requests__employee
    FOREIGN KEY (company_id, employee_id)
    REFERENCES public.employees(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_cancellation_requests__decider
    FOREIGN KEY (company_id, decided_by_account_id)
    REFERENCES public.accounts(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT ck_cancellation_requests__version
    CHECK (submission_version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT ck_cancellation_requests__status
    CHECK (status IN ('OPEN','WITHDRAWN','REJECTED','APPROVED','OBSOLETE')),
  CONSTRAINT ck_cancellation_requests__time CHECK (
    isfinite(created_at) AND isfinite(updated_at) AND updated_at >= created_at
    AND (decided_at IS NULL OR
      (isfinite(decided_at) AND decided_at >= created_at AND decided_at <= updated_at))),
  CONSTRAINT ck_cancellation_requests__decision CHECK (
    (status IN ('APPROVED','REJECTED')
      AND decided_at IS NOT NULL AND decided_by_account_id IS NOT NULL)
    OR (status IN ('OPEN','WITHDRAWN','OBSOLETE')
      AND decided_at IS NULL AND decided_by_account_id IS NULL))
);
CREATE UNIQUE INDEX uq_cancellation_requests__open
  ON public.cancellation_requests (company_id, duty_id, employee_id)
  WHERE status = 'OPEN';

CREATE TABLE public.replacement_needs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  cancellation_request_id uuid NOT NULL,
  duty_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  CONSTRAINT uq_replacement_needs__tenant_id UNIQUE (company_id, id),
  CONSTRAINT uq_replacement_needs__cancellation
    UNIQUE (company_id, cancellation_request_id),
  CONSTRAINT fk_replacement_needs__cancellation_duty
    FOREIGN KEY (company_id, cancellation_request_id, duty_id)
    REFERENCES public.cancellation_requests(company_id, id, duty_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_replacement_needs__duty
    FOREIGN KEY (company_id, duty_id)
    REFERENCES public.duties(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT ck_replacement_needs__status
    CHECK (status IN ('OPEN','OPEN_UNFILLED','RESOLVED','CLOSED')),
  CONSTRAINT ck_replacement_needs__time CHECK (
    isfinite(created_at) AND isfinite(updated_at) AND updated_at >= created_at
    AND (resolved_at IS NULL OR
      (isfinite(resolved_at) AND resolved_at >= created_at AND resolved_at <= updated_at))),
  CONSTRAINT ck_replacement_needs__resolution CHECK (
    (status = 'RESOLVED' AND resolved_at IS NOT NULL)
    OR (status IN ('OPEN','OPEN_UNFILLED','CLOSED') AND resolved_at IS NULL))
);
ALTER TABLE public.cancellation_requests
  ADD CONSTRAINT fk_cancellation_requests__required_need
  FOREIGN KEY (company_id, id)
  REFERENCES public.replacement_needs(company_id, cancellation_request_id)
  ON UPDATE NO ACTION ON DELETE NO ACTION
  DEFERRABLE INITIALLY DEFERRED;
