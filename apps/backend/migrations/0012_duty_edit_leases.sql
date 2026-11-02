-- SP-12 duty-only coordination leases (Phase 8.7; owner approval 2026-11-02).
-- The latest token hash survives expiry/release to authenticate idempotent
-- release. Rotation/takeover replaces it; arbitrary/older tokens never succeed.
-- Workflow-case leases remain deferred. No cancellation/replacement schema.
CREATE TABLE edit_leases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL,
    duty_id UUID NOT NULL,
    owner_account_id UUID NOT NULL,
    token_hash BYTEA NOT NULL,
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    renewed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    released_at TIMESTAMPTZ,
    CONSTRAINT uq_edit_leases__company_id_id UNIQUE (company_id, id),
    CONSTRAINT uq_edit_leases__duty UNIQUE (company_id, duty_id),
    CONSTRAINT fk_edit_leases__duty FOREIGN KEY (company_id, duty_id)
        REFERENCES duties (company_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_edit_leases__owner FOREIGN KEY (company_id, owner_account_id)
        REFERENCES accounts (company_id, id) ON DELETE RESTRICT,
    CONSTRAINT ck_edit_leases__hash CHECK (octet_length(token_hash) = 32),
    CONSTRAINT ck_edit_leases__times CHECK (
        isfinite(acquired_at) AND isfinite(expires_at) AND expires_at > acquired_at
        AND (renewed_at IS NULL OR (isfinite(renewed_at) AND renewed_at >= acquired_at AND renewed_at < expires_at))
        AND (released_at IS NULL OR (isfinite(released_at) AND released_at >= acquired_at)))
);
CREATE INDEX idx_edit_leases__expiry ON edit_leases (expires_at);
