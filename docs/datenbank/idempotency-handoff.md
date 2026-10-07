# Idempotency – G0-R04

Stand: 07.10.2026. Vertragsabgleich 7.2 → 8.7; **Schemaentwurf**, noch keine Businessmigration.

`idempotency_records`: id uuid PK; company_id/actor_account_id NOT NULL mit Composite FK zu accounts(company_id,id); operation text NOT NULL; key_hash bytea NOT NULL (SHA-256, 32 bytes); request_fingerprint bytea NOT NULL; state IN_PROGRESS/COMPLETED/FAILED; created_at/updated_at/expires_at timestamptz; result_status und minimales result_metadata jsonb nullable; claim_generation integer als Recovery-Fencing-Zähler. `UNIQUE(company_id, actor_account_id, operation, key_hash)`; Index (state, updated_at), Index expires_at. Raw Keys nicht speichern.

Claim in kurzer Transaktion. Businesstransaktion sperrt claim + relevante Domainrows, revalidiert Zustand/Fingerprint/Claimgeneration und commitet Mutation + Audit + benötigte Outbox + COMPLETED/result atomar. Neue HTTP-Versuche erhalten neue Correlation IDs; transportabhängige Header nicht unverändert replayen. COMPLETED replayt nur nach erneuter AuthZ; andere Fingerprints ergeben 409, IN_PROGRESS ergibt 409. FAILED ist kein Erfolg und wird nicht blind replayt.

Stale recovery darf einen noch laufenden Owner nicht überholen: claim row lock + generation revalidieren, nicht nur anhand verstrichener Zeit zurücksetzen. Recoverypolicy und Retention vor erstem kritischen POST konfigurieren. Cleanup eines gültigen Keys darf keinen zweiten Business-Effekt erlauben; Domain-Invarianten bleiben erforderlich.

Acceptance: gleicher Actor/Key liefert einmaligen Effekt; anderer Actor isoliert; andere Payload 409; paralleler Claim genau ein Owner; Crash vor Commit rollback, nach Commit replay; veralteter Recovery-Owner kann nicht committen; gespeichertes Result enthält keine Secrets.
