# Anforderungsindex – wirksamer Praktikums-MVP

**Stand:** 30.09.2026\
**Status:** für Architektur, Datenbank und API-Design konsolidiert; Code-/Testverweise entstehen mit der Implementierung.

Traceability-Ziel:

Anforderung / Scope → Architekturentscheidung → Vertical Slice → Code → Test → Nachweis

## MVP-Index

| Scope | Anforderungen / Regeln | Priorität | Aktueller Zustand |
|---|---|---|---|
| M1 Foundation | PostgreSQL, Migrationen, Docker lokal, strukturierte Basis, CI; tenant-aware Grundstruktur | MUST | Architektur in Phase 6 |
| M2 Auth/RBAC | BR-AUTH-01; SEC-AUTHZ-01/02; SEC-EMAIL-01; SEC-SESSION-01; FR-ACT-01; TenantContext serverseitig; Account genau eine Company | MUST | Architektur in Phase 6 |
| M3 Mitarbeiter | FR-EMP-01..03; BR-EMP-01..07; BR-AUD-EMP-01; CL-04-01 minimale KRANK/URLAUB-Verfügbarkeit für Eligibility | MUST | Architektur in Phase 6 |
| M3 Projekte | FR-PROJ-01; BR-PROJ-01..05; CL-04-02 projektbezogene Schichtkonfiguration | MUST | Architektur in Phase 6 |
| M4 Monatsplan | FR-MP-05..09; BR-MP-04..08; manuelle Erfassung als Core | MUST | Planning-Modul freigegeben |
| Excel-Import | FR-MP-01..04 | SHOULD / Stretch | ZURÜCKGESTELLT bis Core stabil |
| M5 Absage | FR-AB-01..03; BR-AB-01..05 | MUST | Modulgrenze freigegeben |
| M5 Ersatz | BR-ER-00..07; BR-ER-10..11; FR-ER-00..04; FR-NOT-06; BR-ER-03 = pro Mitarbeiter und Ersatzdienst nur ein aktives Ersatzangebot; serverseitige Eligibility via Planning/Workforce | MUST | Modulgrenze freigegeben |
| CR-01 | BR-ER-08 entfällt; quota-bezogener BR-ER-09 entfällt; AC-ER-04 entfällt | APPROVED CHANGE | FERTIG dokumentiert |
| CR-02 | Company = Tenant; Account genau eine Company; Monate 4–6 Multi-Company/Productization; Billing bleibt out | APPROVED CHANGE | FERTIG dokumentiert |
| CR-03 | BR-MP-04/06/07/08 und BR-NOT-04 gemäß Amendment; keine Re-Publish-Aktion nach Initial Publish | APPROVED CHANGE | FERTIG dokumentiert |
| M6 Statistik | planbasierte Arbeitstage + TAG/NACHT | MUST | Read Capability aus Planning |
| M7 Work Queue | offene Fälle + Deep Link / direkte Navigation | MUST | Read Capability aus Absage & Ersatz |
| M8 Quality | Validation, Error Contract, Audit-Minimum, Tests, OpenAPI, CI, Cross-Tenant-Negativtests | MUST | Architektur/Planung |
| M9 Delivery | Docker Build, Setup, Secrets, Demo/Staging, extern HTTPS | MUST | GEPLANT |

## Bewusste Scope Cuts und 6-Monats-Horizont

| Bereich | Status |
|---|---|
| Tagesplan / Schichtleiter-Tagesplanung | Post-Praktikum / späteres Vertical |
| Lohnabrechnungen | Post-Praktikum / späteres Vertical |
| vollständige Notifications | Post-Praktikum |
| digitaler Urlaubsantrag | Post-MVP / eigene Capability |
| Urlaubskonto / Resturlaub | Post-MVP / separate Requirements erforderlich |
| Wunschfrei | SHOULD / Stretch |
| Schichttausch | SHOULD / Stretch |
| Multi-Company-Aktivierung + minimaler Platform Admin | Monate 4–6 gemäß CR-02 |
| Billing / Subscriptions / Full Self-Service-Onboarding | WON'T NOW |
| Native Mobile App | WON'T NOW |

## Konflikte / Amendments

### CR-01 – Ersatzlimit

Die historische Phase-2/3-Regel „maximal drei Ersatzübernahmen pro Mitarbeiter/Monatsplan“ ist **nicht mehr wirksam**.

Wirksamer Stand:
- keine feste 3er-Obergrenze
- Eligibility bleibt bestehen
- genau ein Ersatz wird final ausgewählt
- atomare Planänderung bleibt Pflicht
- Idempotenz, Authorization, Audit-Minimum und Datenintegrität bleiben Pflicht

### CR-02 – B2B-SaaS-Tenant-Modell

Wirksamer Stand:
- Company = Tenant
- Tenant-Nutzerkonto gehört genau einer Company
- kein Company Switcher / keine Cross-Company-Membership
- 3-Monats-MVP bleibt operativ auf eine Company fokussiert, technisch tenant-aware
- Monate 4–6: Multi-Company-Aktivierung + minimaler providerseitiger Platform/Tenant Admin
- Billing/Subscription und vollständiges Self-Service-Onboarding bleiben WON'T NOW
- Cross-Company Reads/Writes sind verboten und werden negativ getestet

## CR-03 – wirksamer Monatsplan

Initial Publish stellt den Plan bereit. Danach wird dieselbe stabile Ressource nach serverseitiger Revalidierung direkt geändert; kein paralleler Draft / Re-Publish. [Normative Quelle](cr-03-direct-published-plan-updates.md).

## Research-/Systemanalyse-Traceability

- Phase 3.5 bestätigt digitalen Urlaubsantrag als Post-MVP-Kandidat und Urlaubskonto/Resturlaub als separate spätere Capability.
- Phase 4 UC-10 bestätigt: pro Mitarbeiter und Ersatzbedarf nur ein aktives Ersatzangebot; korrespondiert mit BR-ER-03 aus Phase 2.

## Implementierungsfortschreibung

Mit jedem späteren Vertical Slice werden Spalten für ADR, Slice, Codepfad, Test und Nachweis ergänzt. Bis dahin darf kein Eintrag allein wegen vorhandener UX- oder Architekturdokumentation als implementiert markiert werden.
