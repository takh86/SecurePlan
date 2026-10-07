> **Aktualisierung 07.10.2026:** Die folgende Liste ist historisch vom 30.09. Aktueller APIstand: 8.11 FINAL; operative Tickets und CR-03-Korrekturen: [G0-Backlog](g0-backlog.md).

# Arbeitsvorrat

**Stand:** 30.09.2026\
**Aktueller Fokus:** Phase 8.1 Working Draft abgleichen; danach 8.2 REST Endpoint Design.

> Hinweis: Die dokumentierten Teilphasen 6.1–6.4 und die bestehenden Backlog-IDs SP-A06-* sind zwei Sichten auf denselben Architekturarbeitsraum und werden nicht 1:1 umnummeriert.

## Abgeschlossener Design-Arbeitsraum – Phase 6 / 7

### SP-A06-01 — Architekturziele und Qualitätsattribute
**Status:** FERTIG / APPROVED  
**Nachweis:** Phase 6.1 v1.2.

### SP-A06-02 — Systemkontext und Bausteine
**Status:** FERTIG / APPROVED  
**Nachweis:** Phase 6.2 v1.1.

### SP-A06-03 — Domain-/Modulgrenzen
**Status:** FERTIG / APPROVED  
**Nachweis:** Phase 6.3 v1.2.1 – Review Patch.

### SP-A06-03B — Module Dependencies & Public Contracts
**Status:** FERTIG / APPROVED  
**Nachweis:** Phase 6.4 v1.0.1 – Review Patch.

### SP-A06-04 — Datenmodell-Invarianten
**Status:** FERTIG / DOCUMENTED\
**Nachweis:** Phase 7.1–7.3 und ERD. Stabile Published-Plan-Ressource gemäß CR-03; kein Code-/Migrationsnachweis.

### SP-A06-05 — Security / RBAC / API Contracts
**Status:** FERTIG / DOCUMENTED (Architektur)\
**Nachweis:** Phase 6.6/6.7. Konkrete Endpoint-/DTO-Contracts folgen in Phase 8.

### SP-A06-06 — Transactions / Concurrency / Idempotency
**Status:** FERTIG / DOCUMENTED\
**Nachweis:** Phase 6.5 und Datenbankdesign 7.2/7.3. Tests noch nicht ausgeführt.

### SP-A06-07 — ADR Pack + Architecture Review
**Status:** FERTIG / DOCUMENTED\
**Nachweis:** Phase 6.10/6.11; Production-Gates bleiben offen.

## P0 – aktuelles API-Design

- 8.1 Resource-Katalog gegen aktuelle Baseline prüfen.
- 8.2 REST-Endpunkte und DTOs definieren.
- Authorization, Tenant-Isolation, Concurrency und Error Contracts konkretisieren.
- OpenAPI und Design-/Human-Gates vor Implementierung abschließen.

## P1 — Implementierung nach Design-/Human-Gates

1. Foundation
2. Auth/RBAC
3. Mitarbeiter & Projekte
4. manueller Monatsplan + Publish
5. Mitarbeiteransicht + Statistik
6. Absage/Ersatz
7. Admin Work Queue
8. Quality/Hardening
9. Demo Delivery

## P2 — SHOULD / Stretch

- Excel-Import
- Wunschfrei
- Schichttausch
- ausgewählte Notifications
- MFA falls Kern stabil
- erweiterte Filter/Suche

## P3 — Monate 4–6 / Product Expansion

- Multi-Company-Aktivierung
- minimaler Platform/Tenant Admin
- providerseitiges Company/Tenant-Onboarding
- weitere priorisierte Product Verticals nach stabilem Core

## Weitere Post-MVP-Bereiche

- Tagesplan / Arbeitspositionen
- Lohnabrechnungen
- vollständige Notification-Matrix
- Production Observability / Backup / RPO/RTO

## Verbindliche Regeln

- CR-01: kein 3er-Ersatzlimit
- CR-02: Company = Tenant; Account genau eine Company
- CR-03: direkte wirksame Änderungen nach Initial Publish, kein paralleler Draft / Re-Publish
- kein Feature wird aus UX-Screens in den Scope „hineindesignt“
- kein Implementierungsstatus ohne Code-/Testnachweis
- Security, Authorization, Tenant Isolation und Datenintegrität werden nicht als Zeitpuffer verwendet
