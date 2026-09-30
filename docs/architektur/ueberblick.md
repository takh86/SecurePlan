# Architekturüberblick – Phase 6

**Stand:** 30.09.2026\
**Status:** Phase 6.1–6.11 FINAL / APPROVED / CLOSED gemäß [Final-Gate 6.11](phase-6-11-final-baseline-gate.md).

## Freigegebene Dokumente

- [Phase 6.1 – Architecture Goals](phase-6-1-architecture-goals.md)
- [Phase 6.2 – System Context & Container View](phase-6-2-system-context-container.md)
- [Phase 6.3 – Backend Building Blocks](phase-6-3-backend-building-blocks.md)
- [Phase 6.4 – Module Dependencies & Public Contracts](phase-6-4-module-dependencies-public-contracts.md)
- [Backward Consistency Gate](backward-consistency-gate-2026-09-22.md)
- [ADR-Vorlage](adr/0000-vorlage.md)

- [Phase 6.5 – Transactions, Consistency & Concurrency](ueberblick.md)
- [Phase 6.6 – Security Architecture & RBAC](ueberblick.md)
- [Phase 6.7 – API & Integration Architecture](ueberblick.md)
- [Phase 6.8 – Deployment & Runtime Architecture](ueberblick.md)
- [Phase 6.9 – Observability & Operations Architecture](ueberblick.md)
- [Phase 6.10 – Risks, Trade-offs & ADRs](ueberblick.md)
- [Phase 6.11 – Architecture Review & Final Baseline](phase-6-11-final-baseline-gate.md)

## 1. Systemkontext

SecurePlan ist B2B-SaaS. Company = Tenant. Tenant-Benutzerkonto gehört genau einer Company. Platform Admin ist separater Provider-Scope.

## 2. 6-Monats-Horizont

- Monate 1–3: fokussierter Praktikums-MVP mit operativ einer Company
- Monate 4–6: Multi-Company-Aktivierung mit minimalem providerseitigem Tenant Management
- Billing/Subscriptions und vollständiges Self-Service-Onboarding bleiben WON'T NOW

## 3. Container View

Responsive Web Client → REST Backend (tenant-aware Modular Monolith) → PostgreSQL.

Shared Database + Shared Schema ist die bevorzugte Startstrategie. Database-per-Tenant bleibt spätere Option bei konkreten Compliance-/Enterprise-Treibern.

## 4. Backend Building Blocks

1. Platform & Tenant Management
2. Identity & Access
3. Workforce & Projects
4. Planning
5. Absage & Ersatz
6. Audit

Read Capabilities:
- Employee Statistics
- Admin Work Queue

Cross-cutting:
- TenantContext
- Logging
- Configuration
- Persistence

## 5. Verbindliche Ownership

- Platform & Tenant Management besitzt Company/Tenant-Lifecycle.
- Identity & Access besitzt Accounts, Credentials, Sessions und Rollen.
- Workforce & Projects besitzt Employee, Project, MonthlyProjectAssignment, Shift Config und eligibility-relevante Stammdaten inkl. minimaler KRANK/URLAUB-Verfügbarkeit.
- Planning besitzt MonthlyPlan, Erstveröffentlichung und direkte wirksame Planmutationen. CR-03: danach kein paralleler Draft und kein Re-Publish.
- Absage & Ersatz besitzt CancellationRequest, ReplacementNeed, ReplacementOffer und ReplacementDecision und bewertet Replacement Eligibility über Public Contracts.
- Audit besitzt Audit Records, nicht Business Decisions.

## 6. Modulregeln

1. No cross-module repository access.
2. No cross-module table mutation.
3. Dependencies are unidirectional where possible; circular dependencies are prohibited.
4. Cross-module collaboration happens through explicit public application contracts.

## 7. Wichtige Abhängigkeiten

- Platform & Tenant Management → Identity & Access
- Workforce & Projects → Identity & Access
- Planning → Workforce & Projects
- Absage & Ersatz → Planning
- Absage & Ersatz → Workforce & Projects
- alle auditpflichtigen Module inkl. Platform & Tenant Management → Audit
- Employee Statistics → Planning (read only)
- Admin Work Queue → Absage & Ersatz (read only)

## 8. Handoff nach Architekturabschluss

Phase 7 hat das Datenbankdesign konkretisiert und ist gemäß [Final-Gate 7.3](../datenbank/phase-7-3-operations-final-gate.md) abgeschlossen. Aktuelle Arbeit ist [API Resource Analysis 8.1](../api/phase-8-1-resource-analysis-draft.md) als Draft; danach folgt REST Endpoint Design 8.2.

## 9. Production-Gates und Implementierungsnachweis

Production-Gates aus 6.11 bleiben offen. Architektur- und Datenbankdesign dokumentieren kein bereits laufendes Backend, keine ausführbaren Migrationen und keine erfolgreichen Feature-Tests. Implementierung folgt erst nach den verbleibenden Design-/Human-Gates.
