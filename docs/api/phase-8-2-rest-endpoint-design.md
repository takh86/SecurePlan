# Phase 8.2 – REST Endpoint Design

**Stand:** 30.09.2026\
**Status:** DOCUMENTED – öffentliche, bereinigte Zusammenfassung\
**API-Basis:** `/api/v1`\
**Nächster Schritt:** Phase 8.3 – Request/Response DTOs & Validation Contracts

Diese Fassung dokumentiert den öffentlichen Designstand von Phase 8.2. Sie wurde gegen die wirksamen Projektbaselines abgeglichen, insbesondere Phase 4 FINAL v1.2 sowie CR-01, CR-02 und CR-03.

Die vollständige interne Endpoint-, Security- und Transaction-Spezifikation wird nicht in das öffentliche Repository übernommen.

## Designprinzipien

- resource-orientierte REST API
- englische, plurale Resource-Namen
- Versionierung unter `/api/v1`
- serverseitige Authorization und Tenant-Isolation
- TenantContext wird aus der authentifizierten Identität abgeleitet; clientseitige Company-IDs sind keine Trust Source
- Self-Service-Reads werden über einen eigenen Benutzerkontext modelliert
- Domain Actions nur dort, wo ein fachlicher Statusübergang oder mehrere konsistente Seiteneffekte erforderlich sind
- Read Models wie Mitarbeiterstatistik und Admin Work Queue bleiben von persistierten Domain Resources getrennt
- CR-01 bleibt wirksam: kein festes Kontingent von drei Ersatzübernahmen

## Öffentliche Resource-Familien

| Bereich | Öffentliche API-Richtung |
|---|---|
| Workforce | `/employees` |
| Projects | `/projects` |
| Monatsbezogene Zuordnungen | `/project-assignments` |
| Planning | `/monthly-plans` |
| Absage | `/cancellation-requests` |
| Ersatz | `/replacement-needs` und zugehörige Angebote |
| Employee Self-Service | `/me/...` |
| Administrative Arbeitsübersicht | `/admin/work-queue` |

Die Tabelle dokumentiert Resource-Familien, nicht die vollständige interne Route-/Payload-Spezifikation.

## Monatsplan und CR-03

CR-03 ändert ältere Draft-/Re-Publish-Aussagen:

1. Ein Monatsplan wird zunächst erstellt und einmalig veröffentlicht.
2. Nach der Erstveröffentlichung gibt es keinen parallelen Draft und keinen Re-Publish-Workflow.
3. Autorisierte Änderungen an einem veröffentlichten Monatsplan werden serverseitig revalidiert.
4. Nach erfolgreichem Commit sind diese Änderungen unmittelbar im aktuellen veröffentlichten Plan wirksam.
5. Der veröffentlichte Monatsplan bleibt die fachliche Source of Truth.

Damit gilt eine explizite Publish-Aktion nur für die **erste Veröffentlichung**. Spätere operative Änderungen werden nicht durch einen zusätzlichen Publish-Schritt freigegeben.

## Absage- und Ersatzworkflow

Der API-Entwurf bildet den freigegebenen Kernprozess ab:

```text
eigener geplanter Dienst
    ↓
Absageantrag
    ↓
offener Ersatzbedarf
    ↓
gültige Ersatzangebote
    ↓
finale Büro/Admin-Entscheidung
    ↓
konsistente wirksame Planänderung
```

Dabei bleiben die fachlichen Regeln serverseitig:

- Absage ist zunächst ein Antrag und verändert den Plan nicht automatisch.
- Nur fachlich geeignete Mitarbeitende dürfen Ersatzangebote abgeben.
- Genau ein Ersatz kann final gewählt werden.
- Die wirksame Ersatzübernahme muss konsistent mit dem aktuellen Planstand erfolgen.
- CR-01 entfernt das frühere feste 3er-Ersatzlimit.

## Read Models

Folgende Sichten werden als abgeleitete Read Models behandelt und nicht als eigenständige persistierte Hauptressourcen:

- persönliche Monatsplanansicht
- eigene Antrags-/Angebotsübersicht
- planbasierte Mitarbeiterstatistik
- Admin Work Queue

Die Statistik bleibt planbasiert und ist keine Arbeitszeiterfassung.

## Scope-Grenzen

Nicht Teil der verbindlichen Phase-8.2-MUST-API des 3-Monats-Praktikums:

- Tagesplan / Arbeitspositionen
- Lohnabrechnungs-Vertical
- vollständige Notification-Matrix
- GPS / WKS / Zeiterfassung
- KI-Planung
- Billing / Subscription Automation

Der Excel-Import bleibt Stretch und darf den manuellen Monatsplan-Core nicht blockieren.

## Statusdisziplin

Dieses Dokument belegt **API-Design**, nicht Implementierung.

- keine Produktionsendpoints nachgewiesen
- keine ausführbaren Controller/Services nachgewiesen
- keine OpenAPI-Implementierung nachgewiesen
- keine automatisierten Contract-/Integrationstests nachgewiesen

Der nächste Schritt ist Phase 8.3 mit DTOs, Feldtypen, Enums, Validation Contracts und Error Model.