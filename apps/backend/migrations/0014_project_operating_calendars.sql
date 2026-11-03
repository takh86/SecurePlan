-- P4/P5: no inferred configuration and no historical data rewrite.
CREATE TABLE project_operating_calendars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  project_id uuid NOT NULL,
  effective_from_month date NOT NULL,
  weekday_mask smallint NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, project_id, effective_from_month),
  FOREIGN KEY (company_id, project_id) REFERENCES projects (company_id, id) ON DELETE RESTRICT,
  CHECK (effective_from_month BETWEEN DATE '0001-01-01' AND DATE '9999-12-01'
    AND EXTRACT(day FROM effective_from_month) = 1),
  CHECK (weekday_mask BETWEEN 1 AND 127),
  CHECK (version BETWEEN 1 AND 9007199254740991),
  CHECK (isfinite(created_at) AND isfinite(updated_at))
);
-- The project/month UNIQUE index supports both predecessor and successor reads.
-- Existing duties(company_id, project_id, duty_date) serves dependency checks.
