# 12-Wochen-Fahrplan – Implementation Baseline + aktueller Overlay

**Originalbasis:** Phase 3 Scope & MVP v1.1  
**Synchronisiert:** 30.09.2026\
**Overlay:** CR-01/02/03 + Phase 4 FINAL v1.2 + Final-Gates 6.11 / 7.3

## Wichtige Einordnung

Die ursprüngliche Repository-Fassung vom 05.09.2026 behandelte Woche 1 als aktuellen Projektstand. Das ist nicht mehr korrekt.

Der folgende 12-Wochen-Plan bleibt die **Implementierungsbaseline des Praktikums-MVP**. CR-02 erweitert diesen 3-Monats-Scope nicht; die technische Basis wird jedoch von Beginn an tenant-aware.

## Aktueller Overlay

**Jetzt:** Phase 8.1 API Resource Analysis als Working Draft; danach 8.2 REST Endpoint Design.\
**Abgeschlossen laut Designquellen:** Phase 6.1–6.11 und 7.1–7.3.\
**Danach:** vollständige API-Contracts / verbleibende Design- und Human-Gates; anschließend Implementierung entlang der Phase-3-Sequenz\
**Noch nicht erlaubt:** UX-/Architekturdokumentation als implementiertes Feature zählen

## Implementierungsbaseline

| Implementierungswoche | Fokus | Exit-Kriterium |
|---|---|---|
| 1 | Foundation: Repo-Struktur, DB, Migrationen, Docker lokal, CI-Basis; tenant-aware Grundstruktur | Clean Build + DB-Migration + Testpipeline |
| 2 | Auth/RBAC + User-Grundmodell + serverseitiger TenantContext | AuthN/AuthZ + Tenant-Isolation-Negativtests |
| 3 | Mitarbeiter, Projekte, monatsbezogene Zuordnung; Schichtkonfiguration; minimale KRANK/URLAUB-Verfügbarkeit | Stammdaten + zentrale Constraints |
| 4 | Monatsplan-Datenmodell + manuelle Erfassung/Pflege | Plan ohne Excel anlegbar/validierbar/bearbeitbar |
| 5 | Publish, Mitarbeiteransicht, Statistik, erste Staging-Iteration | Planning Flow End-to-End |
| 6 | Planänderungen/Revalidation; optional Excel-Import Stretch | Plan-Core stabil |
| 7 | Absage + automatischer Ersatzbedarf + Eligibility | Absage erzeugt gültigen Ersatzbedarf |
| 8 | Ersatzangebote + Büroentscheidung + atomare Übernahme | Hauptworkflow End-to-End |
| 9 | Edge Cases, Idempotenz, Admin Work Queue | Business Rules/Statusübergänge stabil |
| 10 | Regression, Security Review, Audit-Minimum, Error Handling, OpenAPI | Feature Freeze / Hardening |
| 11 | Release Candidate, Deployment-Härtung, README, Demo-Daten | reproduzierbarer Release Candidate |
| 12 | Bugfix, UX-Polish, Regression, Demo, Praktikumsdokumentation | MVP-Abnahme möglich |

## CR-01-Auswirkung

Die historische Week-9-/M5-Regel „3er-Limit“ ist entfernt. Sie darf weder implementiert noch getestet werden.

## CR-02-Auswirkung

- Der 3-Monats-MVP bleibt fachlich eingefroren.
- Foundation/Auth/Data Access werden tenant-aware gebaut.
- Multi-Company-Aktivierung und minimaler Platform/Tenant Admin folgen erst in Monate 4–6.
- Billing/Subscriptions und Full Self-Service-Onboarding bleiben WON'T NOW.

## Scope Guardrails

- MUST vor SHOULD
- Excel-Import darf den manuellen Monatsplan nicht blockieren
- Tagesplan und Lohnabrechnung bleiben außerhalb des 3-Monats-MVP
- neue Ideen standardmäßig ins Backlog
- Tests, Authorization, Tenant Isolation und Datenintegrität werden bei Zeitdruck nicht gestrichen
- ab Feature Freeze keine neue MUST-Funktionalität ohne Scope-Entscheidung

## Design-Gates vor der Implementierung

Vor Start der Implementierungswoche 1 müssen die Phase-6-Ergebnisse freigegeben sein:
- Module/Boundaries
- Auth-/Security-/Tenant-Isolation-Ansatz
- Daten-/Transaktionsstrategie
- Concurrency/Idempotenz
- API-/Error-Contracts
- ADR-Basis


Phase 6 und 7 sind dokumentiert abgeschlossen. Phase 8 konkretisiert jetzt die Endpunkte, DTOs und OpenAPI-Verträge. Dieser Fahrplan ist keine Behauptung bereits verstrichener Implementierungswochen und setzt keine neue Praktikumsfrist fest.
