# Phase 6.3 – Backend Building Blocks

> **Aktueller Baseline-Hinweis (30.09.2026):** [Final-Gate 6.11](phase-6-11-final-baseline-gate.md) und [CR-03](../requirements/cr-03-direct-published-plan-updates.md) haben bei älteren widersprechenden Formulierungen Vorrang. Nach Initial Publish kein paralleler Draft / Re-Publish. Vollständige technische Quelldokumente bleiben außerhalb dieser öffentlichen Auswahl.

**Version:** v1.2.1  
**Stand:** 22.09.2026  
**Status:** FINAL / APPROVED – Review Patch  
**Repo-Hinweis:** Kurzfassung des freigegebenen Projektartefakts; ersetzt nicht das ausführliche Originalartefakt.

> **Review-Patch v1.2.1:** Präzisiert ausschließlich Ownership der Replacement Eligibility. Keine Modulgrenze und keine fachliche Architekturentscheidung wurde geändert. Human Approval wird mit dem Merge von PR #3 dokumentiert.

## Designprinzipien

- Business Capabilities statt Screens/Tabellen
- High Cohesion, Low Coupling
- keine direkten fremden Repositories/Entities
- Tenant Isolation als Querschnittsregel
- Control Plane und Tenant Application Plane logisch getrennt

## Finale Building Blocks

### 1. Platform & Tenant Management
Besitzt:
- Company/Tenant Lifecycle
- providerseitiges Onboarding
- Company/Tenant Status
- initiales Company-Admin-Provisioning als orchestrierter Flow

### 2. Identity & Access
Besitzt:
- Account
- Credentials
- Sessions
- Rollen / Security Identity

### 3. Workforce & Projects
Besitzt:
- Employee
- Project
- MonthlyProjectAssignment
- Project Shift Configuration
- eligibility-relevante Stammdaten: aktive Beschäftigung, Projektzuordnung, Schicht-Eignung und minimale KRANK/URLAUB-Verfügbarkeit

### 4. Planning
Besitzt:
- MonthlyPlan
- Plan Entries
- unveröffentlichter Plan bis Initial Publish
- danach direkte autorisierte Planänderung nach Revalidierung / Commit (CR-03)
- Plan Version / Optimistic Lock Boundary
- Planmutationen

### 5. Absage & Ersatz
Besitzt:
- CancellationRequest
- ReplacementNeed
- ReplacementOffer
- ReplacementDecision

**Verantwortung:** Absage & Ersatz bewertet die Replacement Eligibility serverseitig über öffentliche Contracts zu Workforce & Projects und Planning. Workforce besitzt die dafür benötigten Stammdaten, nicht die fachliche Ersatzentscheidung.

### 6. Audit
Besitzt:
- Audit Records
- keine Business Decisions

## Read Capabilities

Keine eigenen Domain-Module:
- Employee Statistics → aus Planning
- Admin Work Queue → aus Absage & Ersatz

## Cross-cutting

- TenantContext
- Logging
- Configuration
- Persistence

## Bewusst kein eigenes Modul

- vollständige Notifications
- Billing / Subscription
- Employee Statistics als Domain
- Admin Work Queue als Domain
- TenantContext als Domain
