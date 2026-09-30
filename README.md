# SecurePlan

**Backend Engineering Case Study · THM Praxisphase · B2B-SaaS Workforce Planning**

![Status](https://img.shields.io/badge/Architecture-6.1--6.11%20Closed-success)
![Next](https://img.shields.io/badge/Next-Phase%208.2-blue)
![Implementation](https://img.shields.io/badge/Production%20Code-Not%20Started-lightgrey)

SecurePlan ist ein webbasiertes System zur strukturierten Personal- und Einsatzplanung für Sicherheitsunternehmen.  
Das Projekt entsteht im Rahmen meiner **Praxisphase im B.Sc. Informatik an der Technischen Hochschule Mittelhessen (THM)**.

> **Stand: 30.09.2026**\
> **Architektur:** Phase 6.1–6.11 FINAL / APPROVED / CLOSED gemäß Final-Gate 6.11.\
> **Datenbankdesign:** Phase 7.1–7.3 FINAL / APPROVED / COMPLETE gemäß Final-Gate 7.3.\
> **Aktuelle Arbeit:** Phase 8.1 Resource Analysis v0.1 – Working Draft.\
> **Nächster Schritt:** Baseline-Abgleich von 8.1 → Phase 8.2 REST Endpoint Design.\
> **Implementierung:** Noch kein nachgewiesener Produktions-Anwendungscode. Architektur-, UX- und Planungsartefakte sind nicht mit implementierter Produktfunktion gleichzusetzen.

---

## 30-Sekunden-Überblick

| Bereich | Aktueller Stand |
|---|---|
| **Problem** | Personal- und Einsatzplanung mit Rollen, Abwesenheiten, Ersatzprozessen und verbindlichen Business Rules |
| **Produkttyp** | B2B-SaaS |
| **Architekturstil** | Tenant-aware Modular Monolith |
| **Geplanter Backend-Stack** | TypeScript · NestJS · PostgreSQL · REST APIs |
| **Security** | Session Auth · RBAC · server-derived TenantContext · Tenant Isolation · CSRF |
| **Consistency** | Transactions · Optimistic Locking · Idempotency · Duplicate Protection |
| **API** | REST · `/api/v1` · DTO Contracts · Validation · stabile Domain/Error Codes |
| **Integration** | Outbox-orientierte Integration Events |
| **Architekturfortschritt** | Phase 6.1–6.11 abgeschlossen; Final-Gate dokumentiert |
| **Datenbankdesign** | Phase 7.1–7.3 abgeschlossen; öffentliche fachliche Übersicht |
| **API-Design** | Phase 8.1 Working Draft; Phase 8.2 noch geplant |

---

## Problem & Ziel

Sicherheitsunternehmen müssen Mitarbeiter, Projekte, Monatspläne, Abwesenheiten und Ersatzbesetzungen zuverlässig koordinieren.

Dabei entstehen Backend-Herausforderungen wie:

- rollen- und kontextabhängige Berechtigungen,
- Tenant-Isolation in einem B2B-SaaS-Modell,
- komplexe Planungs- und Ersatzregeln,
- parallele Änderungen an denselben Planungsdaten,
- Duplicate Protection und wiederholbare Commands,
- stabile API-, DTO- und Error-Contracts,
- nachvollziehbare Audit- und Statusänderungen.

SecurePlan modelliert diese Anforderungen bewusst als **Backend-Domäne mit expliziten Business Rules und Architekturentscheidungen** – nicht nur als UI-Workflow.

---

## Meine Rolle

Ich bearbeite SecurePlan end-to-end von der Problemdefinition bis zur geplanten technischen Umsetzung.

Bisherige Engineering-Arbeit:

- Requirements Engineering und Scope-Definition
- Product Research und Zielgruppenanalyse
- MVP-Definition und Change Governance
- System- und Domainanalyse
- Architektur eines tenant-aware Modular Monolith
- Definition von Modulgrenzen, Ownership und Public Contracts
- Transaction-, Concurrency- und Idempotency-Design
- Security Architecture, RBAC und Tenant Isolation
- REST API-, DTO-, Validation- und Error-Contract-Design
- Vorbereitung von Testing, OpenAPI, CI/CD und Deployment

**Statusdisziplin:** `DOCUMENTED` ≠ `PROTOTYPED` ≠ `IMPLEMENTED`.

---

## Architektur-Snapshot

```mermaid
flowchart LR
    UI[Responsive Web Client] --> API[REST API / api-v1]

    API --> SEC[Session Auth / RBAC]
    SEC --> TC[Server-derived TenantContext]

    API --> MOD[Domain Modules]

    MOD --> PT[Platform & Tenant]
    MOD --> IAM[Identity & Access]
    MOD --> WP[Workforce & Projects]
    MOD --> PLAN[Planning]
    MOD --> REP[Absage & Ersatz]
    MOD --> AUDIT[Audit]

    PT --> DB[(PostgreSQL)]
    IAM --> DB
    WP --> DB
    PLAN --> DB
    REP --> DB
    AUDIT --> DB

    REP --> OUTBOX[Outbox / Integration Events]
```

### Architekturprinzipien

**Tenant-aware Modular Monolith**  
SecurePlan startet bewusst als modularer Monolith. Fachliche Module besitzen klare Ownership und kommunizieren über explizite Public Application Contracts.

**Tenant Isolation by Design**  
Der TenantContext wird serverseitig aus der authentifizierten Identität abgeleitet. Client-seitig übergebene Company-IDs sind keine Trust Source. Cross-Company Reads/Writes sind verboten.

**Business Rules im Backend**  
Planungs-, Berechtigungs- und Statusregeln werden serverseitig durchgesetzt und nicht der UI überlassen.

**Consistency by Design**  
Kritische Workflows berücksichtigen Transaction Boundaries, Optimistic Locking, Idempotency und Duplicate Protection.

**Explicit API Contracts**  
REST-Endpunkte, Commands, DTOs, Validation sowie Domain- und Error-Codes werden als stabile Verträge behandelt.

---

## Phase 6 – Architekturfortschritt

| Phase | Inhalt | Status |
|---|---|---|
| **6.1** | Architecture Goals & Quality Attributes | ✅ FINAL / APPROVED |
| **6.2** | System Context & Container View | ✅ FINAL / APPROVED |
| **6.3** | Backend Building Blocks | ✅ FINAL / APPROVED |
| **6.4** | Module Dependencies & Public Contracts | ✅ FINAL / APPROVED |
| **6.5** | Transactions, Concurrency & Consistency | ✅ FINAL / APPROVED |
| **6.6** | Security Architecture & RBAC | ✅ FINAL / APPROVED |
| **6.7** | API & Integration Architecture | ✅ FINAL / APPROVED |
| **6.8** | Deployment & Runtime Architecture | ✅ FINAL / APPROVED |
| **6.9** | Observability & Operations | ✅ FINAL / APPROVED |
| **6.10** | Architecture Risks, Trade-offs & ADRs | ✅ FINAL / APPROVED |
| **6.11** | Architecture Review & Final Baseline | ✅ FINAL / APPROVED / CLOSED |

Die fachlichen Modulgrenzen und die öffentlich dokumentierten Baselines sind über den [Architekturüberblick](docs/architektur/ueberblick.md) erreichbar. Detaillierte Security-, Transaktions-, Integrations- und Betriebsdokumente gehören nicht zu diesem öffentlichen Upload.

## Phase 7 – Datenbankdesignstatus

Phase 7.1–7.3 ist gemäß den verfügbaren Designquellen abgeschlossen. Die öffentliche [Statusübersicht](docs/datenbank/README.md) dokumentiert den Handoff und einen allgemeinen fachlichen [Domain-Überblick](docs/datenbank/domain-overview.md).

Technische Schema-, ERD-, Security- und Operations-Dokumente bleiben außerhalb dieser öffentlichen Auswahl. Ausführbare Migrationen und getesteter Anwendungscode liegen noch nicht vor.

## Phase 8 – aktuelle API-Arbeit

[Phase 8.1 Resource Analysis](docs/api/phase-8-1-resource-analysis-draft.md) ist ein **Working Draft**. Vor der Ableitung konkreter REST-Endpunkte in 8.2 müssen seine älteren Baseline-Verweise mit Phase 4 FINAL v1.2, CR-02/03 und den Final-Gates 6.11/7.3 abgeglichen werden. URLs, DTOs und OpenAPI-Verträge sind noch nicht final definiert.

## Backend Building Blocks

1. **Platform & Tenant Management**
2. **Identity & Access**
3. **Workforce & Projects**
4. **Planning**
5. **Absage & Ersatz**
6. **Audit**

Read Capabilities:

- Employee Statistics
- Admin Work Queue

Cross-cutting:

- TenantContext
- Logging
- Configuration
- Persistence

### Modulregeln

- kein Cross-Module Repository Access
- keine direkten Cross-Module Table Mutations
- keine zyklischen Dependencies
- Cross-Module Collaboration ausschließlich über explizite Public Contracts

---

## Verbindlicher Praktikums-MVP

1. Foundation
2. Authentication, RBAC und TenantContext
3. Mitarbeiter und Projekte
4. Manueller Monatsplan, Publish und Mitarbeiteransicht
5. Absage- und Ersatzprozess
6. Planbasierte Statistik
7. Admin Work Queue
8. Validation, Error Handling, Audit-Minimum, Tests, OpenAPI und CI
9. Reproduzierbare Demo-/Staging-Auslieferung

**Stretch:** Excel-Import

**Nicht Teil des verbindlichen 3-Monats-MVP:** Tagesplan, Lohnabrechnung und vollständige Notifications.

→ [Öffentlicher MVP-Überblick](docs/requirements/public-mvp-baseline.md)

---

## SaaS- & Tenant-Modell

- **Company = Tenant**
- ein Tenant-Benutzerkonto gehört genau einer Company
- kein Company Switcher / keine Cross-Company-Membership
- Platform Admin ist separater Provider-Scope
- kein impliziter Zugriff des Platform Admin auf operative Tenant-Daten
- Shared Database + Shared Schema als bevorzugte Startstrategie
- Monate 1–3: eine operative Company, technisch bereits tenant-aware
- Monate 4–6: geplante Multi-Company/Productization
- Billing / Subscription Automation und vollständiges Self-Service-Onboarding bleiben außerhalb des aktuellen Scopes

---

## Engineering Evidence

| Artefakt | Nachweis |
|---|---|
| [Öffentlicher MVP-Überblick](docs/requirements/public-mvp-baseline.md) | Requirements, Scope und MVP-Governance |
| [Systemanalyse](docs/systemanalyse/phase-4-final-v1.2.md) | Domain- und Systemanalyse |
| [UX/UI Baseline](docs/ux-ui/phase-5-baseline.md) | Übergang von Anforderungen zu Interaction Design |
| [Architekturüberblick](docs/architektur/ueberblick.md) | Repo-lokaler Architekturindex |
| [Phase 6.3](docs/architektur/phase-6-3-backend-building-blocks.md) | Module, Ownership und Building Blocks |
| [Phase 6.4](docs/architektur/phase-6-4-module-dependencies-public-contracts.md) | Dependencies und Public Contracts |
| [Phase 6.11 Final Gate](docs/architektur/phase-6-11-final-baseline-gate.md) | Öffentlicher Phasenstatus und fachliche Baseline |
| [Phase 7 – Designstatus](docs/datenbank/README.md) | Gate-Status und fachliche Übersicht |
| [Phase 8.1 Draft](docs/api/phase-8-1-resource-analysis-draft.md) | API-Resource-Analyse und offene Baseline-Prüfung |
| [CR-03](docs/requirements/cr-03-direct-published-plan-updates.md) | Direkte Änderungen nach der ersten Veröffentlichung |
| [Technische Quellen](docs/sources/README.md) | Herunterladbare geprüfte Dokumente |
| [Projektstatus](docs/project-status.md) | Repo-lokaler Gate- und Phasenstatus |
| [Fortschrittsprotokoll](docs/planung/fortschrittsprotokoll.md) | Nachvollziehbarer Projektfortschritt |

> **Dokumentationsnachweis:** Die ausgewählten öffentlichen technischen Quelldokumente sind im [Quellenindex](docs/sources/README.md) verlinkt. Markdown-Fassungen ergänzen CR-03 und den API-Arbeitsstand; 6.11/7.3 veröffentlichen nur den Gate-Status. Detaillierte Architektur-, Security-, Datenbank- und ERD-Dokumente bleiben außerhalb des Uploads. Die Statusangaben belegen Design-Gates; sie sind keine nachgewiesenen Code-, Test- oder Deployment-Ergebnisse.

---

## Was SecurePlan aktuell demonstriert

Auch vor dem Implementierungsstart zeigt das Projekt bereits nachvollziehbare Engineering-Arbeit in:

- Requirements Engineering
- Product Scope & Change Management
- Domain Modeling
- B2B-SaaS Multi-Tenancy
- Modular-Monolith-Architektur
- Modulgrenzen und Ownership
- RBAC und Tenant Isolation
- Transaction Design
- Concurrency & Optimistic Locking
- Idempotency & Duplicate Protection
- REST API Design
- DTO-, Validation- und Error Contracts
- Audit- und Integration-Event-Design
- technische Dokumentation und Architecture Gates

Mit Beginn der Implementierungsphase wird diese Evidenz um **ausführbaren Backend-Code, Datenbankmigrationen, automatisierte Tests, OpenAPI, Docker, CI/CD und eine reproduzierbare Demo** erweitert.

---

## Nächste Schritte

1. Phase 8.1 gegen die wirksamen Baselines und das physische Datenmodell prüfen.
2. Phase 8.2: REST-Endpunkte, DTOs, Authorization, Validation, Concurrency und Error Contracts definieren.
3. API-Design vervollständigen und OpenAPI-Spezifikation erarbeiten.
4. Verbleibende Design-/Human-Gates abschließen, bevor die Implementierung beginnt.
5. Danach Foundation, Migrationen, Auth/RBAC, MVP-Module, Tests und Demo/Staging nachweisen.

## Engineering Principle

> **Dokumentiert ist nicht implementiert. Prototypisiert ist nicht produktionsreif.**

SecurePlan wird bewusst über nachvollziehbare Gates entwickelt:

```text
Requirements
    ↓
Scope & Product Validation
    ↓
System Analysis
    ↓
UX / UI
    ↓
Architecture
    ↓
Human Approval
    ↓
Implementation
    ↓
Testing & Delivery
```

Ziel ist eine nachvollziehbare, testbare und wartbare Backend-Lösung für reale Business-Prozesse – nicht möglichst früh möglichst viel Code.
