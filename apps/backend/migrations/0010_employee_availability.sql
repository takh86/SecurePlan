-- SP-10: approved daily facts, preview binding and atomic retry completion.
-- Employment/time-dependent rules use the existing employee parent-lock protocol.
ALTER TABLE employees ADD COLUMN availability_revision BIGINT NOT NULL DEFAULT 0
    CONSTRAINT ck_employees__availability_revision CHECK (availability_revision >= 0);

CREATE TABLE employee_availability_days (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL,
    employee_id UUID NOT NULL,
    day DATE NOT NULL,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_employee_availability_days__company_id_id UNIQUE (company_id, id),
    CONSTRAINT uq_employee_availability_days__employee_day UNIQUE (company_id, employee_id, day),
    CONSTRAINT fk_employee_availability_days__employee FOREIGN KEY (company_id, employee_id)
        REFERENCES employees (company_id, id) ON DELETE RESTRICT,
    CONSTRAINT ck_employee_availability_days__status CHECK (status IN ('SICK', 'LEAVE')),
    CONSTRAINT ck_employee_availability_days__day CHECK (day BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
);

CREATE TABLE availability_batch_commands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL,
    actor_account_id UUID NOT NULL,
    employee_id UUID NOT NULL,
    token_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    selection_hash BYTEA NOT NULL CHECK (octet_length(selection_hash) = 32),
    context_hash BYTEA NOT NULL CHECK (octet_length(context_hash) = 32),
    expected_revision BIGINT NOT NULL CHECK (expected_revision >= 0),
    state TEXT NOT NULL DEFAULT 'PREVIEWED' CHECK (state IN ('PREVIEWED', 'COMPLETED')),
    key_hash BYTEA CHECK (octet_length(key_hash) = 32),
    commit_hash BYTEA CHECK (octet_length(commit_hash) = 32),
    changed_day_count SMALLINT,
    unchanged_day_count SMALLINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    preview_expires_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    CONSTRAINT fk_availability_batch_commands__actor FOREIGN KEY (company_id, actor_account_id)
        REFERENCES accounts (company_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_availability_batch_commands__employee FOREIGN KEY (company_id, employee_id)
        REFERENCES employees (company_id, id) ON DELETE RESTRICT,
    CONSTRAINT ck_availability_batch_commands__expiry CHECK (
        isfinite(created_at) AND isfinite(preview_expires_at) AND isfinite(expires_at)
        AND preview_expires_at > created_at AND expires_at > created_at),
    CONSTRAINT ck_availability_batch_commands__state CHECK (
        (state = 'PREVIEWED' AND key_hash IS NULL AND commit_hash IS NULL AND completed_at IS NULL
            AND changed_day_count IS NULL AND unchanged_day_count IS NULL)
        OR (state = 'COMPLETED' AND key_hash IS NOT NULL AND commit_hash IS NOT NULL
            AND completed_at IS NOT NULL AND isfinite(completed_at) AND expires_at > completed_at
            AND changed_day_count IS NOT NULL AND unchanged_day_count IS NOT NULL
            AND changed_day_count >= 0 AND unchanged_day_count >= 0
            AND changed_day_count + unchanged_day_count BETWEEN 1 AND 93))
);
CREATE UNIQUE INDEX uq_availability_batch_commands__actor_key
    ON availability_batch_commands (company_id, actor_account_id, key_hash) WHERE key_hash IS NOT NULL;
CREATE INDEX idx_availability_batch_commands__expiry ON availability_batch_commands (company_id, expires_at);
