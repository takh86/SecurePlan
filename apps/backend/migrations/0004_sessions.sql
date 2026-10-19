
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id UUID NOT NULL,
    account_id UUID NOT NULL,

    token_hash BYTEA NOT NULL,
    csrf_secret BYTEA NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    absolute_expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,

    CONSTRAINT fk_sessions_account
        FOREIGN KEY (company_id, account_id)
        REFERENCES accounts (company_id, id),

    CONSTRAINT uq_sessions_token_hash
        UNIQUE (token_hash),

    CONSTRAINT chk_sessions_token_hash_length
        CHECK (octet_length(token_hash) = 32),

    CONSTRAINT chk_sessions_last_seen
        CHECK (last_seen_at >= created_at),

    CONSTRAINT chk_sessions_absolute_expiry
        CHECK (absolute_expires_at > created_at)
);

-- Find sessions belonging to a specific tenant/account
CREATE INDEX idx_sessions_account
    ON sessions (company_id, account_id);

-- Support cleanup of expired sessions
CREATE INDEX idx_sessions_absolute_expires
    ON sessions (absolute_expires_at);
