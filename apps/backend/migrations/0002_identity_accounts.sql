CREATE TABLE companies(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    time_zone TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_companies_status 
        CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DEACTIVATED'))
);
CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES companies(id),
    email TEXT NOT NULL,
    account_scope TEXT NOT NULL,
    role TEXT NOT NULL,
    password_hash TEXT,
    email_verified_at TIMESTAMPTZ,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_accounts_company_id_id UNIQUE (company_id, id),
    CONSTRAINT chk_accounts_scope CHECK (account_scope IN ('TENANT','PLATFORM')),
    CONSTRAINT chk_accounts_role CHECK (role IN ('EMPLOYEE','COMPANY_ADMIN','PLATFORM_ADMIN')),
    CONSTRAINT chk_accounts_status CHECK (status IN ('PENDING_ACTIVATION','ACTIVE','DEACTIVATED')),
    CONSTRAINT chk_accounts_scope_role_company
        CHECK ((account_scope = 'TENANT' AND company_id IS NOT NULL AND role IN ('EMPLOYEE', 'COMPANY_ADMIN'))
            OR(account_scope = 'PLATFORM' AND company_id IS NULL AND role = 'PLATFORM_ADMIN'))
);

CREATE UNIQUE INDEX uq_accounts_email_lower
    ON accounts (LOWER(email));

CREATE TABLE account_tokens(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL,
    account_id UUID NOT NULL,
    purpose TEXT NOT NULL,
    token_hash BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    CONSTRAINT fk_account_tokens_account FOREIGN KEY (company_id, account_id) REFERENCES accounts (company_id, id),
    CONSTRAINT chk_token_hash_length CHECK(octet_length(token_hash) = 32 ),
    CONSTRAINT uq_account_tokens_token_hash UNIQUE (token_hash),
    CONSTRAINT chk_account_tokens_purpose CHECK (purpose IN ('EMAIL_VERIFICATION','PASSWORD_RESET')),
    CONSTRAINT chk_account_tokens_expiry CHECK (expires_at > created_at)
);
-- Index for retrieving tokens by company, account and purpose
CREATE INDEX idx_account_tokens_account_purpose
    ON account_tokens (company_id, account_id, purpose);

-- Index for finding expired tokens
CREATE INDEX idx_account_tokens_expires_at
    ON account_tokens (expires_at);