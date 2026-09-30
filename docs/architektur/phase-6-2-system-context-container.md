# Phase 6.2 – System Context & Container View

> **Aktueller Baseline-Hinweis (30.09.2026):** [Final-Gate 6.11](phase-6-11-final-baseline-gate.md) und [CR-03](../requirements/cr-03-direct-published-plan-updates.md) haben bei älteren widersprechenden Formulierungen Vorrang. Nach Initial Publish kein paralleler Draft / Re-Publish. Vollständige technische Quelldokumente bleiben außerhalb dieser öffentlichen Auswahl.

**Version:** v1.1  
**Stand:** 22.09.2026  
**Status:** FINAL / RE-APPROVED  
**Repo-Hinweis:** Kurzfassung des freigegebenen Projektartefakts; ersetzt nicht das ausführliche Originalartefakt.

## System Context

SecurePlan ist B2B-SaaS. Akteure:
- Platform Admin / SecurePlan Betreiber
- Company Admin / Büro
- Mitarbeiter

## Control Plane vs. Application Plane

**Control Plane:** Company/Tenant anlegen, Status verwalten, initialen Company Admin provisionieren.

**Application Plane:** Mitarbeiter, Projekte, Monatsplan, Absage/Ersatz, Admin Work Queue, Employee Statistics.

Die Trennung ist logisch/modular; kein separates Microservice-Deployment im 6-Monats-Projekt.

## Container View

Responsive Web Client → REST/HTTPS → Backend API (tenant-aware Modular Monolith) → PostgreSQL.

## Tenant Rules

- Company = Tenant
- Account gehört genau einer Company
- kein Company Switcher
- TenantContext serverseitig aus Auth Identity
- Company Admin sieht nur eigene Company
- Platform Admin besitzt kein implizites Recht auf operative Tenant-Daten

## Datenisolation

Startstrategie: Shared Database + Shared Schema + explizite Company Ownership.

Database-per-Tenant bleibt spätere Option bei realen Compliance-/Enterprise-Treibern.
