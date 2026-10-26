-- SP-08 Workforce & Projects: project master record (tenant-scoped).
-- Controlled baseline change (owner decision 26.10.2026): the public API v1
-- contract (name + status, name unique per company) is authoritative. The
-- physical-design columns address, internal_code and note are deliberately not
-- created yet; they can be added later by an additive migration.
-- ARCHIVED stays an allowed stored value (physical design), but API v1 exposes
-- and writes only ACTIVE/INACTIVE.
CREATE TABLE projects (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_projects PRIMARY KEY (id),
    -- Target of tenant-safe composite FKs (company_id, project_id).
    CONSTRAINT uq_projects__company_id_id UNIQUE (company_id, id),
    CONSTRAINT uq_projects__company_name UNIQUE (company_id, name),
    CONSTRAINT fk_projects__companies
        FOREIGN KEY (company_id)
        REFERENCES companies (id)
        ON DELETE RESTRICT,
    CONSTRAINT ck_projects__status
        CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED'))
);

-- Admin list: tenant + status filter.
CREATE INDEX idx_projects__company_status
    ON projects (company_id, status);
