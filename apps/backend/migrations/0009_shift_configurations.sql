-- SP-08b Workforce & Projects: month-versioned shift configuration per project.
-- Owner decisions O-1..O-10 (27.10.2026, ADR-0003): a VERSION is the complete
-- set of rows with the same (company_id, project_id, effective_from_month); it
-- holds one or two shift kinds. The effective configuration for month X is the
-- whole set of the latest effective_from_month <= X; missing kinds are never
-- inherited from older versions. Times are local wall-clock times of the
-- company's IANA time zone; concrete duty instants are resolved later (SP-11).
-- Enforced by the application service only (not expressible as row CHECKs):
-- 1..2 rows per version, writes only for the current or a future month, and
-- whole-set replacement under the project row lock.
-- No seed data and no server defaults: a project without a version has no
-- shift configuration.
CREATE TABLE shift_configurations (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL,
    project_id UUID NOT NULL,
    effective_from_month DATE NOT NULL,
    shift_kind TEXT NOT NULL,
    start_local TIME(0) WITHOUT TIME ZONE NOT NULL,
    end_local TIME(0) WITHOUT TIME ZONE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_shift_configurations PRIMARY KEY (id),
    CONSTRAINT uq_shift_configurations__company_id_id UNIQUE (company_id, id),
    -- One row per shift kind and version. Also serves the "latest month <= X"
    -- lookup, so no additional index is needed.
    CONSTRAINT uq_shift_configurations__project_month_kind
        UNIQUE (company_id, project_id, effective_from_month, shift_kind),
    -- Tenant-safe: the project must belong to the row's company.
    CONSTRAINT fk_shift_configurations__projects
        FOREIGN KEY (company_id, project_id)
        REFERENCES projects (company_id, id)
        ON DELETE RESTRICT,
    -- Database vocabulary TAG/NACHT (as employees.shift_eligibility); the API
    -- uses DAY/NIGHT through an explicit mapper.
    CONSTRAINT ck_shift_configurations__shift_kind
        CHECK (shift_kind IN ('TAG', 'NACHT')),
    CONSTRAINT ck_shift_configurations__month_start
        CHECK (effective_from_month = date_trunc('month', effective_from_month)::date),
    -- The API contract is HH:mm; seconds never occur.
    CONSTRAINT ck_shift_configurations__minute_precision
        CHECK (extract(second FROM start_local) = 0 AND extract(second FROM end_local) = 0),
    CONSTRAINT ck_shift_configurations__distinct_times
        CHECK (start_local <> end_local),
    -- A day shift ends on the same calendar day; only a night shift may wrap.
    CONSTRAINT ck_shift_configurations__day_same_day
        CHECK (shift_kind <> 'TAG' OR end_local > start_local)
);
