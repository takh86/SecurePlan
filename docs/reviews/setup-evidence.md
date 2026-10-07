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
| Migrations-/DB-positive Runtime | PASS in CI | PostgreSQL 17; first apply, second no-op, DB verification und HTTP 200 readiness |

Der Foundation-Setup-Pfad ist auf Linux/CI nachgewiesen. Ein Foundation-Probe-Table ersetzt kein reviewed Produktschema; G0 bleibt wegen Auth-Handoff/Delivery NEEDS WORK. Docker Compose und Windows wurden hier nicht lokal getestet.

CI-Nachweis: [Foundation CI Run #2](https://github.com/takh86/SecurePlan/actions/runs/37601987531), SUCCESS. Head `61eeb941bd219fb671a12ae413e46174b61d653e`; getesteter PR-Merge-Commit `012cf4bd78f5bf18b39a27d6bf9eea7978422dc6`. Die nachfolgende Dokumentationsevidenz ändert den Anwendungscode nicht.
