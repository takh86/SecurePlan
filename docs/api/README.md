# API Design – öffentliche Übersicht

Stand: 29.10.2026, Implementierungsbaseline `7107781`. Die interne Designbaseline hat Phase 8.11 erreicht; spätere freigegebene Amendments werden kontrolliert nachgeführt. Produkt-API-Design und implementierte Endpunkte werden getrennt ausgewiesen.

Öffentliche Einstiegspunkte: [Resource-Analyse](phase-8-1-resource-analysis-draft.md) und [bereinigte Designzusammenfassung](phase-8-2-rest-endpoint-design.md). Historische Dokumente beschreiben ihren jeweiligen damaligen Stand.

Das Ziel sind nachvollziehbare REST-Ressourcen, explizite Validierung, konsistente Fehlerbehandlung und geeignete Parallelitätskontrollen. Vollständige interne DTO-/Endpoint-/Securityverträge sind nicht veröffentlicht. Auth-, Mitarbeiter-, Projekt- und Monatszuordnungsrouten sind implementiert; Planung und Ersatz folgen separat.

Aktuelle freigegebene SP-09-Verträge: [Korrektur und Zukunfts-DELETE mit Expected-Version](../datenbank/project-assignment-correction-handoff.md), [S-9 Mitarbeiter-Discovery](employee-future-project-assignments.md), [Beschäftigungszeitraum-Konflikt](employee-employment-period-consistency.md). [Abschlussmatrizen und CI](../reviews/sp09-closeout-64-73.md) sowie [SP-11 D1–D6/LOCK-01](../datenbank/sp11-integrity-handoff.md) unterscheiden umgesetzt, übertragen und noch freizugebende API-Details. Browserabnahme bleibt NOT_RUN.
