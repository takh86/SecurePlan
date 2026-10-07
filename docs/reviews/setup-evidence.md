# SP-01 – Setup-Evidenz

Reviewdatum: 07.10.2026. SP-01 wurde gegen die gemergte Foundation lokal unter Windows und zusätzlich in Linux/GitHub Actions verifiziert. Die Foundation-Prüfung belegt Reproduzierbarkeit und technische Betriebsfähigkeit, nicht fertige Businessfunktionen.

| Check | Ergebnis | Grenze |
| --- | --- | --- |
| Dependency install | PASS; lokal Node 24.21.0 / npm 11, CI frisches Checkout | Keine Produktfunktion |
| Backend-/Frontendbuild | PASS lokal und CI | Production-Build, kein Deployment |
| Workspace lint | PASS; 0 Fehler / 0 Warnungen | Oxlint |
| Backendunit | PASS, 1/1 | Bestehender Startertest |
| Backend-E2E | PASS, 4/4 | Root + Liveness/Readiness-Verhalten |
| PostgreSQL / Docker Compose lokal | PASS unter Windows, PostgreSQL 17 healthy und Port 5432 gebunden | Lokale synthetische DB |
| Migration first apply | PASS | Foundation-Probe, kein Produktschema |
| Migration repeat | PASS; bereits angewendete Migration wird nicht erneut ausgeführt | Prüft Idempotenz/Immutable-Ledger-Pfad |
| DB verification | PASS lokal und CI | Foundation-Probe vorhanden |
| Backend `/health/live` | PASS, HTTP 200 lokal | Prozess erreichbar |
| Backend `/health/ready` | PASS, HTTP 200 gegen reale lokale PostgreSQL-DB | Foundation-Migration vorhanden |
| Readiness ohne DB | PASS im E2E, HTTP 503 mit neutraler Meldung | Negativfall |
| Frontend dev runtime | PASS, HTTP 200 / Starter-HTML lokal | Noch kein UX-Abnahmetest |
| Git Working Tree | PASS, nach Verifikation sauber | Keine unbeabsichtigten Repo-Änderungen |
| Environment-Dateien | PASS; `.env` und `.env.backup` von Git ignoriert | Kein vollständiger Secret-Audit |

**Entscheidung:** SP-01 – Reproducible Local Foundation = **PASS / CLOSED**.

Die Foundation ist sowohl lokal unter Windows als auch in Linux-CI nachgewiesen. Der Migrationsrunner, DB-Pool und die technische Probe ersetzen kein reviewed Produktschema. G0 bleibt unabhängig davon für den ersten Identity-Slice **NEEDS WORK**, bis Identity-Persistenz/Delivery und die dazugehörigen Implementierungsentscheidungen abgeschlossen sind.

CI-Nachweise: Foundation CI der gemergten Foundation sowie der nachfolgenden Public-Documentation-Änderung sind erfolgreich. Die spätere Dokumentationsbereinigung ändert kein Application Behavior.
