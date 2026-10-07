# Phase 10 – kontrollierter G0-Abgleich

Stand: 07.10.2026. Ergänzung zur Restlaufzeitplanung v1.1, Original bleibt historisch. CR-03 und API 8.11 sind normativ. [G0-Tickets](../reviews/g0-handoff.md) enthalten weitere Dependencies.

| Story | Korrigierte Acceptance Criteria / Tasks |
| --- | --- |
| SP-11 | Plan vor Erstveröffentlichung UNPUBLISHED, für Employee nicht sichtbar |
| SP-12 | Berechtigte Änderung PUBLISHED nach erfolgreichem Commit sichtbar; Expected-Version + Lease; Fehler/stale version ohne Datenänderung |
| SP-13 | Nur initial publish; idempotenter Retry ohne erneute Seiteneffekte; kein Re-Publish/Draftreplacement |
| SP-20 | Ersatzentscheidung mutiert aktuelle Published-Assignments atomar, mit Revalidation/Audit/Outbox und idempotency completion |
| SP-22 | Reconciliation im selben Commit bei Published-Mutation; UNPUBLISHED-Änderung beendet keine Anfrage zu anderem Published-State |
| D05/D07 | Keine offene Entscheidung zu parallelem Draft; Umsetzung CR-03 und Duty-Concurrencyvertrag nachweisen |

Reihenfolge: SP-01 → SP-02 Validation/Errorfoundation → SP-03 CI → SP-04 Activation/Reset → SP-05 Login/Logout/Sessions → SP-06 Tenant/RBAC. CI-Scaffolding ist hinzugefügt; eine Story ist erst nach vollständigen eigenen ACs und belegten Checks DONE.

**DoR Auth:** reviewed schema, Delivery, TTL/Abusewerte, Screens, API/Errorcontract. **DoD:** Migration/API/UI + Negativ-/Concurrencytests + grünes CI + passendes OpenAPI + Evidence am Commit. Keine 47-Endpunkt-Fertigmeldung bei fehlenden Reset-Endpunkten.
