-- SP-07 Workforce: employee master record, kept separate from the Identity account lifecycle.
-- Tenant-safe: the composite FK makes an employee/account pairing across companies impossible.
CREATE TABLE employees (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL,
    account_id UUID NOT NULL,
    employee_number TEXT NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    employment_start DATE,
    employment_end DATE,
    shift_eligibility TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    deactivated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_employees PRIMARY KEY (id),
    CONSTRAINT uq_employees__company_id_id UNIQUE (company_id, id),
    CONSTRAINT uq_employees__company_employee_number UNIQUE (company_id, employee_number),
    CONSTRAINT uq_employees__company_account UNIQUE (company_id, account_id),
    CONSTRAINT fk_employees__accounts
        FOREIGN KEY (company_id, account_id)
        REFERENCES accounts (company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT ck_employees__shift_eligibility
        CHECK (shift_eligibility IN ('TAG', 'NACHT', 'BOTH')),
    CONSTRAINT ck_employees__status
        CHECK (status IN ('ACTIVE', 'DEACTIVATED')),
    CONSTRAINT ck_employees__employment_dates
        CHECK (employment_end IS NULL OR employment_start IS NULL OR employment_end >= employment_start)
);

-- Admin list: tenant + status filter, ordered by name.
CREATE INDEX idx_employees__company_status_name
    ON employees (company_id, status, last_name, first_name);
