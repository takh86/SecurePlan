-- SP-11 PR-1: planning foundation (monthly plans, duties, duty memberships).
-- Owner-ratified technical design SP11A-R1 Rev3.1 with corrections K1-K3.
-- CR-03: one stable plan per company/project/month, UNPUBLISHED until its first
-- publication and PUBLISHED afterwards; no plan revision, no second draft.
-- ADR-0003 O-10: a duty stores its shift kind and resolved UTC instants; there
-- is no FK to the mutable shift configuration. The local times, company zone
-- and effective configuration month are informational provenance (C5).
-- K1: a removed duty keeps its row (removed_at tombstone); a removed membership
-- keeps its row (state REMOVED). Live uniqueness uses partial unique indexes.
-- K3: PostgreSQL-generated UUIDs (repository style) intentionally replace the
-- application-generated UUIDv7 of the original physical design.
-- This migration must ship together with the real planning guards (D2/D3) and
-- the D4/D5/deactivation writer integration; never with the temporary guards.
-- Existing current-state data is empty: no backfill.
-- All cross-tenant references use explicit composite keys.

CREATE TABLE monthly_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL,
    project_id UUID NOT NULL,
    planning_month DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'UNPUBLISHED',
    published_at TIMESTAMPTZ(0),
    published_by_account_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_monthly_plans__company_id_id UNIQUE (company_id, id),
    CONSTRAINT uq_monthly_plans__owner_month_id
        UNIQUE (company_id, project_id, planning_month, id),
    CONSTRAINT uq_monthly_plans__project_month
        UNIQUE (company_id, project_id, planning_month),
    CONSTRAINT fk_monthly_plans__project
        FOREIGN KEY (company_id, project_id)
        REFERENCES projects (company_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_monthly_plans__publisher
        FOREIGN KEY (company_id, published_by_account_id)
        REFERENCES accounts (company_id, id) ON DELETE RESTRICT,
    CONSTRAINT ck_monthly_plans__month
        CHECK (planning_month BETWEEN DATE '0001-01-01' AND DATE '9999-12-01'
            AND extract(day FROM planning_month) = 1),
    CONSTRAINT ck_monthly_plans__lifecycle CHECK (
        (status = 'UNPUBLISHED' AND published_at IS NULL AND published_by_account_id IS NULL)
        OR (status = 'PUBLISHED' AND published_at IS NOT NULL
            AND isfinite(published_at) AND published_by_account_id IS NOT NULL))
);
CREATE INDEX idx_monthly_plans__company_month
    ON monthly_plans (company_id, planning_month DESC, id);

CREATE TABLE duties (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL,
    project_id UUID NOT NULL,
    monthly_plan_id UUID NOT NULL,
    planning_month DATE NOT NULL,
    duty_date DATE NOT NULL,
    shift_kind TEXT NOT NULL,
    concurrency_version BIGINT NOT NULL DEFAULT 1,
    starts_at TIMESTAMPTZ(0) NOT NULL,
    ends_at TIMESTAMPTZ(0) NOT NULL,
    time_zone TEXT NOT NULL,
    config_effective_from_month DATE NOT NULL,
    start_local TIME(0) WITHOUT TIME ZONE NOT NULL,
    end_local TIME(0) WITHOUT TIME ZONE NOT NULL,
    removed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_duties__company_id_id UNIQUE (company_id, id),
    -- Tenant, project and month ownership is structural: a duty can only point
    -- at a plan of the same company, project and month.
    CONSTRAINT fk_duties__plan
        FOREIGN KEY (company_id, project_id, planning_month, monthly_plan_id)
        REFERENCES monthly_plans (company_id, project_id, planning_month, id)
        ON DELETE RESTRICT,
    CONSTRAINT ck_duties__date_month CHECK (
        duty_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
        AND extract(day FROM planning_month) = 1
        AND extract(year FROM duty_date) = extract(year FROM planning_month)
        AND extract(month FROM duty_date) = extract(month FROM planning_month)),
    -- Database vocabulary TAG/NACHT as in shift_configurations; API DAY/NIGHT.
    CONSTRAINT ck_duties__kind CHECK (shift_kind IN ('TAG', 'NACHT')),
    -- Optimistic-concurrency token of the duty (Phase 8.7); safe-integer bound.
    CONSTRAINT ck_duties__version
        CHECK (concurrency_version BETWEEN 1 AND 9007199254740991),
    CONSTRAINT ck_duties__interval
        CHECK (isfinite(starts_at) AND isfinite(ends_at) AND ends_at > starts_at),
    CONSTRAINT ck_duties__removed CHECK (removed_at IS NULL OR isfinite(removed_at)),
    CONSTRAINT ck_duties__config_month CHECK (
        config_effective_from_month BETWEEN DATE '0001-01-01' AND DATE '9999-12-01'
        AND extract(day FROM config_effective_from_month) = 1
        AND config_effective_from_month <= planning_month),
    CONSTRAINT ck_duties__local_precision CHECK (
        extract(second FROM start_local) = 0 AND extract(second FROM end_local) = 0
        AND start_local < TIME '24:00:00' AND end_local < TIME '24:00:00'
        AND start_local <> end_local
        AND (shift_kind <> 'TAG' OR end_local > start_local)),
    CONSTRAINT ck_duties__zone_nonempty CHECK (length(time_zone) BETWEEN 1 AND 255)
);
CREATE UNIQUE INDEX uq_duties__live_slot
    ON duties (company_id, monthly_plan_id, duty_date, shift_kind)
    WHERE removed_at IS NULL;
CREATE INDEX idx_duties__project_date_live
    ON duties (company_id, project_id, duty_date)
    WHERE removed_at IS NULL;
CREATE INDEX idx_duties__project_end_live
    ON duties (company_id, project_id, ends_at)
    WHERE removed_at IS NULL;

CREATE TABLE plan_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL,
    duty_id UUID NOT NULL,
    employee_id UUID NOT NULL,
    duty_function TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'NORMAL',
    state TEXT NOT NULL DEFAULT 'ACTIVE',
    removed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_plan_assignments__company_id_id UNIQUE (company_id, id),
    CONSTRAINT fk_plan_assignments__duty
        FOREIGN KEY (company_id, duty_id)
        REFERENCES duties (company_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_plan_assignments__employee
        FOREIGN KEY (company_id, employee_id)
        REFERENCES employees (company_id, id) ON DELETE RESTRICT,
    -- Duty-scoped function (MITARBEITER/SCHICHTLEITER), never an account role.
    CONSTRAINT ck_plan_assignments__function
        CHECK (duty_function IN ('MITARBEITER', 'SCHICHTLEITER')),
    CONSTRAINT ck_plan_assignments__source CHECK (source IN ('NORMAL', 'REPLACEMENT')),
    CONSTRAINT ck_plan_assignments__state CHECK (
        (state = 'ACTIVE' AND removed_at IS NULL)
        OR (state = 'REMOVED' AND removed_at IS NOT NULL AND isfinite(removed_at)))
);
CREATE UNIQUE INDEX uq_plan_assignments__active_employee
    ON plan_assignments (company_id, duty_id, employee_id)
    WHERE state = 'ACTIVE';
CREATE INDEX idx_plan_assignments__employee_active
    ON plan_assignments (company_id, employee_id, duty_id)
    WHERE state = 'ACTIVE';

-- No FK to shift_configurations or to correctable project_assignments (D2 is a
-- tuple predicate). No global plan revision. No workflow, edit-lease or
-- idempotency tables in this slice. Removing duties/memberships is an explicit
-- business transaction, never CASCADE. Valid IANA zone, UTC/source equality,
-- staffing eligibility and lifecycle transitions are enforced by the
-- application under the LOCK-01-L1 protocol.
