CREATE TABLE audit_event (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id),
    actor_account_id UUID,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id UUID NOT NULL,
    old_values JSONB,
    new_values JSONB,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    correlation_id UUID NOT NULL,
    CONSTRAINT fk_audit_event_actor_company
        FOREIGN KEY (company_id, actor_account_id)
        REFERENCES accounts (company_id, id)
);

CREATE INDEX idx_audit_event_resource_history
    ON audit_event (
        company_id,
        resource_type,
        resource_id,
        occurred_at DESC
    );