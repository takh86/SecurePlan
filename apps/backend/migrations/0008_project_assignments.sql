-- SP-09 Workforce & Projects: month-scoped employee -> project assignment.
-- Invariant (database-enforced): an employee has AT MOST ONE project per
-- calendar month. planning_month is always the first day of its month, so the
-- UNIQUE key cannot be bypassed with two different days of the same month.
-- Whether a PLANNED employee has an assignment is checked by planning (SP-10/11).
-- History: rows are never deleted by the application (no DELETE endpoint);
-- composite FKs with RESTRICT keep employees/projects of past months.
CREATE TABLE project_assignments (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL,
    employee_id UUID NOT NULL,
    project_id UUID NOT NULL,
    planning_month DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_project_assignments PRIMARY KEY (id),
    CONSTRAINT uq_project_assignments__company_id_id UNIQUE (company_id, id),
    CONSTRAINT uq_project_assignments__employee_month UNIQUE (company_id, employee_id, planning_month),
    -- Tenant-safe: employee and project must belong to the row's company.
    CONSTRAINT fk_project_assignments__employees
        FOREIGN KEY (company_id, employee_id)
        REFERENCES employees (company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_project_assignments__projects
        FOREIGN KEY (company_id, project_id)
        REFERENCES projects (company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT ck_project_assignments__month_start
        CHECK (planning_month = date_trunc('month', planning_month)::date)
);

-- Employee pool per project and month. The employee/month lookup is already
-- covered by uq_project_assignments__employee_month.
CREATE INDEX idx_project_assignments__project_month
    ON project_assignments (company_id, project_id, planning_month);
