-- SP-05 SEC-01. Shared login-abuse state. No raw email, address, or secret.
CREATE TABLE login_abuse_counters (
  scope TEXT NOT NULL CHECK (scope IN ('ACCOUNT', 'IP')),
  identifier_hash BYTEA NOT NULL CHECK (octet_length(identifier_hash) = 32),
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  pending INTEGER NOT NULL DEFAULT 0 CHECK (pending >= 0),
  next_allowed_at TIMESTAMPTZ,
  PRIMARY KEY (scope, identifier_hash)
);
-- Enables a future bounded retention/cleanup job; no automatic deletion here.
CREATE INDEX idx_login_abuse_counters_window
  ON login_abuse_counters (window_started_at);
