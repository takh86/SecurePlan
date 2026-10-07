# SP-01 – Setup-Evidenz

Reviewdatum: 07.10.2026. Ausgangscommit main: `1fb8983f4579a45618e738d8a95a060662124a1d`. Die folgenden Ergebnisse gelten für die Änderungen dieser PR; der CI-Run ergänzt den konkreten Remote-Commit.

| Check | Ergebnis | Grenze |
| --- | --- | --- |
| Clean clone + npm ci | PASS, Node 24.19.0 / npm 11.9.0 | Frisches Checkout in Reviewumgebung |
| Backend-/Frontendbuild | PASS | Keine Business-Feature-Evidenz |
| Workspace lint | PASS | Oxlint |
| Backendunit | PASS, 1 Test | Bestehender Startertest |
| Backend-E2E | PASS, 4 Tests | Root + Health; DB-Provider ersetzt |
| Backendprozess + /health/live | PASS, HTTP 200 | Echter gestarteter Build |
| Frontend dev start | PASS, HTTP 200 | Starter-HTML; kein UX-Abnahmetest |
| /health/ready ohne DB | PASS, HTTP 503, neutrale Meldung | Echter negativer Runtimefall |
| Lokales PostgreSQL / Compose | NOT_RUN | Docker und PostgreSQL hier nicht installiert |
| Migrations-/DB-positive Runtime | CI PENDING | Workflow nutzt PostgreSQL 17; twice migrate + verify + readiness |

Ein Foundation-Probe-Table ersetzt kein reviewed Produktschema. SP-01/G0 nicht als vollständig DONE markieren, solange die positiven PostgreSQL-Checks nicht nachgewiesen sind. Nach CI-Auswertung ist deren URL/Status zu ergänzen; bis dahin kein grünes CI behaupten.
