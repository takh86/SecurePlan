# API Design – öffentliche Übersicht

SP19-P1 [administrative read API](admin-work-queue.openapi.json) is implemented
in the merged backend PR #112 (tenant-scoped work queue, cancellation/need
context and offers). SP19-P2 React read-only integration is in [PR #113](https://github.com/takh86/SecurePlan/pull/113)
with [backend-backed acceptance evidence](../reviews/sp19-backend-acceptance-report.md).
Eligibility indicators describe current eligibility for submitting an offer;
they do not authorize selection or reassignment. Administrative decision
commands and deployment remain outside SP19-P1/P2.

Implementation and acceptance evidence do not, by themselves, record formal
Product Owner approval of this API contract. That approval remains to be
confirmed before SP-19 closeout.

A1 implementation amendment (2026-11-03): [project operating calendar](project-operating-calendar.md).
A2 adopted backend contract (2026-11-03): [employee-month Save](employee-month-save.md),
[OpenAPI](employee-month-save.openapi.json). Owner approval and implementation evidence are separate.
Product approval, implemented backend behavior and independent acceptance remain distinct.

Stand: 29.10.2026, Implementierungsbaseline `7107781`. Die interne Designbaseline hat Phase 8.11 erreicht; spätere freigegebene Amendments werden kontrolliert nachgeführt. Produkt-API-Design und implementierte Endpunkte werden getrennt ausgewiesen.

Öffentliche Einstiegspunkte: [Resource-Analyse](phase-8-1-resource-analysis-draft.md) und [bereinigte Designzusammenfassung](phase-8-2-rest-endpoint-design.md). Historische Dokumente beschreiben ihren jeweiligen damaligen Stand.

Das Ziel sind nachvollziehbare REST-Ressourcen, explizite Validierung, konsistente Fehlerbehandlung und geeignete Parallelitätskontrollen. Vollständige interne DTO-/Endpoint-/Securityverträge sind nicht veröffentlicht. Auth-, Mitarbeiter-, Projekt- und Monatszuordnungsrouten sind implementiert; Planung und Ersatz folgen separat.

SP-11 PR-1 (Draft, 02.11.2026): Monatspläne und Dienste anlegen/lesen (`/api/v1/monthly-plans`, nur COMPANY_ADMIN, ohne Veröffentlichung/Bearbeitung) sowie drei neue 409-Codes für Planungsabhängigkeiten; [Zusammenfassung und Evidenz](../reviews/sp11-pr1-planning-foundation.md).

Aktuelle freigegebene SP-09-Verträge: [Korrektur und Zukunfts-DELETE mit Expected-Version](../datenbank/project-assignment-correction-handoff.md), [S-9 Mitarbeiter-Discovery](employee-future-project-assignments.md), [Beschäftigungszeitraum-Konflikt](employee-employment-period-consistency.md). [Abschlussmatrizen und CI](../reviews/sp09-closeout-64-73.md) sowie [SP-11 D1–D6/LOCK-01](../datenbank/sp11-integrity-handoff.md) unterscheiden umgesetzt, übertragen und noch freizugebende API-Details. Browserabnahme bleibt NOT_RUN.
