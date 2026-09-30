# Phase 6.1 – Architecture Goals & Quality Attributes

> **Aktueller Baseline-Hinweis (30.09.2026):** [Final-Gate 6.11](phase-6-11-final-baseline-gate.md) und [CR-03](../requirements/cr-03-direct-published-plan-updates.md) haben bei älteren widersprechenden Formulierungen Vorrang. Nach Initial Publish kein paralleler Draft / Re-Publish. Vollständige technische Quelldokumente bleiben außerhalb dieser öffentlichen Auswahl.

**Version:** v1.2  
**Stand:** 22.09.2026  
**Status:** FINAL / RE-APPROVED  
**Repo-Hinweis:** Kurzfassung des freigegebenen Projektartefakts; ersetzt nicht das ausführliche Originalartefakt.

## P1 – nicht verhandelbar
- serverseitige Authorization
- Cross-Tenant Isolation
- Datenintegrität durch DB-Constraints + Domain Validation
- Published Plan als Source of Truth
- atomare Absage-/Ersatz-Planänderung
- Optimistic Concurrency Protection
- idempotente kritische Commands
- explizite Domain-State-Transitions
- automatisierte Authorization-/Business-Rule-/Cross-Tenant-Negativtests

## P2
- stabile API-/Domain-Error-Contracts
- Auditability
- klare Modulgrenzen
- reproduzierbare Migrationen/Builds/CI/Deployment

## P3
- Company/Tenant-Seam von Beginn an
- effiziente Read Paths für Employee Plan und Admin Work Queue
- Production-Performance-Ziele berücksichtigen, ohne vorzeitiges Scaling

## Constraints
Modular Monolith · PostgreSQL · REST · responsive Web UI · Docker lokal · Account genau eine Company · Platform Admin separater Provider-Scope · Shared DB + Shared Schema als Startstrategie · keine Microservices/Queues/Redis ohne konkreten Treiber · Billing/Subscription-Automation out.
