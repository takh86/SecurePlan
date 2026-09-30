# Öffentlicher Überblick zum Praktikums-MVP

**Stand:** 30.09.2026

SecurePlan plant einen fokussierten Praktikums-MVP für Personal- und Einsatzplanung. Der dokumentierte Designstand ist keine bereits implementierte Produktfunktion. Details der Security- und Betriebsarchitektur gehören nicht zu dieser öffentlichen Zusammenfassung.

## Kernumfang

- Persönliche Konten mit Mitarbeiter- und Büro/Admin-Funktionen.
- Mitarbeiter, Projekte und monatsbezogene Projektzuordnung.
- Manuelle Monatsplanung, Erstveröffentlichung und persönliche Mitarbeiteransicht.
- Absageanträge, Ersatzangebote und finale Büroentscheidung.
- Planbasierte Statistik und Übersicht offener Vorgänge.
- Spätere nachgewiesene technische Umsetzung, Verifikation und reproduzierbare Demo.

## Wirksame Change Requests

- CR-01: kein festes monatliches Kontingent von drei Ersatzübernahmen.
- CR-02: B2B-SaaS; ein persönliches Tenant-Konto gehört genau einer Company. Multi-Company-Produktisierung ist ein späterer Horizont.
- [CR-03](cr-03-direct-published-plan-updates.md): nach Initial Publish kein paralleler Draft und kein Re-Publish. Autorisierte Änderungen werden nach Revalidierung und erfolgreichem Commit direkt wirksam.

## Scope

Excel-Import bleibt Stretch. Tagesplan, Lohnabrechnungen und vollständige Notifications gehören nicht zum verbindlichen 3-Monats-MVP. Zusätzliche Produktfunktionen werden nicht still aus Entwürfen in den Scope übernommen.

## Quellen und aktueller Status

[Ausgewählte öffentliche Quellen](../sources/README.md) und [Projektstatus](../project-status.md). Frühere Baseline-Dokumente können durch die genehmigten CRs überholte Aussagen enthalten; die Change Requests haben Vorrang. Aktuelle API-Arbeit ist Phase 8.1 als Working Draft, danach folgt 8.2 REST Endpoint Design.
