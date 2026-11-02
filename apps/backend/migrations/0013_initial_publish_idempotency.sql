-- SP-13: Phase 8.7 selective command reservations. Later API rules supersede
-- the older physical design's raw key and company-only scope. Only hashes are
-- retained; tenant + actor + operation scope spans all plan IDs. PostgreSQL UUIDs
-- follow the ratified repository strategy. This is technical command state,
-- never a second plan, roster copy, notification or business plan revision.
CREATE TABLE idempotency_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL,
    actor_account_id UUID NOT NULL,
    operation TEXT NOT NULL,
    key_hash BYTEA NOT NULL,
    request_hash BYTEA NOT NULL,
    attempt_id UUID NOT NULL DEFAULT gen_random_uuid(),
    state TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    result_plan_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    completed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT fk_idempotency_records__actor FOREIGN KEY (company_id, actor_account_id)
        REFERENCES accounts (company_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_idempotency_records__result FOREIGN KEY (company_id, result_plan_id)
        REFERENCES monthly_plans (company_id, id) ON DELETE RESTRICT,
    CONSTRAINT uq_idempotency_records__scope UNIQUE (company_id, actor_account_id, operation, key_hash),
    CONSTRAINT ck_idempotency_records__operation CHECK (operation = 'INITIAL_PUBLISH'),
    CONSTRAINT ck_idempotency_records__hashes CHECK (octet_length(key_hash) = 32 AND octet_length(request_hash) = 32),
    CONSTRAINT ck_idempotency_records__state CHECK (
        (state IN ('IN_PROGRESS', 'FAILED') AND result_plan_id IS NULL AND completed_at IS NULL)
        OR (state = 'COMPLETED' AND result_plan_id IS NOT NULL AND completed_at IS NOT NULL)),
    CONSTRAINT ck_idempotency_records__time CHECK (
        isfinite(created_at) AND isfinite(claimed_at) AND isfinite(expires_at)
        AND expires_at > created_at AND expires_at > claimed_at
        AND (completed_at IS NULL OR (isfinite(completed_at) AND expires_at > completed_at)))
);
CREATE INDEX idx_idempotency_records__expiry ON idempotency_records (expires_at, id);
