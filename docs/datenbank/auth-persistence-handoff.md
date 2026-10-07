# Auth-Persistenz – G0-R02

Stand: 07.10.2026. **Implementierungshandoff / Reviewentwurf**, keine bereits ausgeführte Produktmigration. Basis: Phase 7.2 und Phase 9.2 v1.1. Die Tabellen unten werden erst mit reviewed `companies`/`accounts`-Migrationen umgesetzt; diese PR enthält nur die Foundation-Probe.

## Relationen und Constraints

`accounts` benötigt `UNIQUE(company_id, id)`. Tenantzugehörigkeit muss über Composite Foreign Keys abgesichert sein; einfache account_id-FKs reichen dafür nicht. Accountrolle und Company-/Accountstatus werden bei jedem Request erneut autorisiert.

| Tabelle | Felder und Constraints |
| --- | --- |
| sessions | id uuid PK; company_id/account_id NOT NULL; token_hash bytea UNIQUE NOT NULL, CHECK octet_length=32; csrf_secret bytea NOT NULL; created_at/last_seen_at/absolute_expires_at timestamptz NOT NULL; revoked_at nullable; Composite FK (company_id, account_id) → accounts; CHECK last_seen_at >= created_at und absolute_expires_at > created_at |
| account_tokens | id uuid PK; company_id/account_id NOT NULL; purpose CHECK ACTIVATION/RESET; token_hash bytea UNIQUE NOT NULL, CHECK octet_length=32; created_at/expires_at NOT NULL; used_at/revoked_at nullable; Composite FK zu accounts; CHECK expires_at > created_at |

Session-/Einmaltoken: mindestens 32 kryptographisch zufällige Bytes, ausschließlich SHA-256 in DB. CSRF-Secret ist ein separates zufälliges, sessiongebundenes Secret, kein Sessiontoken; über Login/GET /me in kontrollierter Response übertragen, nie loggen. Konstante Vergleichsfunktion im Application-Code verwenden. Cookie: Secure/HttpOnly/SameSite=Lax/Path=/, kein LocalStorage.

Indizes: `sessions(company_id, account_id) WHERE revoked_at IS NULL`; `sessions(absolute_expires_at)`; `account_tokens(expires_at)`; aktiver Token-Lookup über UNIQUE token_hash. Abgelaufene/widerrufene Tokens bleiben ungültig, auch bevor Cleanup läuft. Cleanup wird periodisch in begrenzten Batches ausgeführt; retention ist vor Betrieb zu konfigurieren.

## Atomare Abläufe

- Activation: Account zuerst sperren; Zweck/Tenant/Account/Expiry/used/revoked prüfen; Token row sperren; nur PENDING_ACTIVATION Account aktivieren und Hash setzen; Token used_at + Audit in derselben Transaktion. Ein zweiter gleichzeitiger Consumer kann nicht erfolgreich sein.
- Reset: Account zuerst sperren, dann Token revalidieren/consume; Passwordhash aktualisieren; alle Sessions widerrufen; weitere Reset-Tokens widerrufen; Audit atomar. Kein automatischer Login als unbeabsichtigter Seiteneffekt.
- Deactivation: Accountstatus + Sessions + offene relevante Tokens in derselben Transaktion widerrufen. Login und neue Sessioncreation verwenden dieselbe Account-Sperrreihenfolge.
- Logout: aktuelle Session widerrufen; Cookie löschen. Cookie-Replay bleibt ungültig.
- Authentifizierung: revoked/status/company prüfen; Admin idle 30 Minuten/absolute 12 Stunden, Employee idle 8 Stunden/absolute 7 Tage. `last_seen_at` darf absolute expiry nicht verlängern. Sessionrefresh darf eine widerrufene Session nicht wieder aktivieren.

Lock order überall: Account → Session/Token. Rowlocks, bedingte Updates und Rollbacktests sind erforderlich; eine Sequenz ohne Transaktion genügt nicht.

## Noch zu reviewen

Token-TTL, Delivery-Modus, Cleanup-Retention und Login-Abuse-Parameter: [Security-Handoff](../security/auth-handoff.md). ORM ist nicht festgelegt; `pg` fügt in dieser PR nur den verbindungsfähigen Foundation-Pfad hinzu.

Acceptance: Composite FK rejects cross-tenant relation; keine Raw Tokens; simultaneous consume genau ein Erfolg; Reset/Deactivate-Replay abgewiesen; idle/absolute timeout mit kontrollierter Clock; Migration fresh + repeat + rollback auf echter PostgreSQL-DB.
