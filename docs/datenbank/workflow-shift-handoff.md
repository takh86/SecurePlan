# Workflow/Shift-Handoff – G0-R05

Stand: 07.10.2026. Mapping und zeitliches Persistenzmodell sind **Reviewvorschläge**; vor SP-08 bzw. SP-16 abschließen. Final API 8.11/8.3 und CR-03 haben Vorrang vor älterem DB-Wording.

## Explizites Mapping

| API | DB 7.2 | Semantik |
| --- | --- | --- |
| DAY / NIGHT | TAG / NACHT | Serializer/Mapper, keine direkten Enumcasts |
| SICK / LEAVE | KRANK / URLAUB | Gleichwertige fachliche Zustände |
| Cancellation OBSOLETE | VOID | Durch aktuelle Planung gegenstandslos, Need CLOSED |
| Cancellation OPEN | OPEN / UNDER_REVIEW | API zeigt OPEN; interner Prüfzustand bleibt offen, keine neue öffentliche Entscheidung |
| Need OPEN_UNFILLED | OPEN + Cancellation APPROVED | Abgeleitete Projektion; ohne Ersatzentscheidung bleibt API OPEN |
| Need RESOLVED / CLOSED | RESOLVED / CLOSED | Direktes Mapping |
| Offer WITHDRAWN | Kein Zustand in 7.2 | CHECK-Erweiterung nur falls finaler Workflow es tatsächlich erzeugt; kein zusätzlicher Endpoint allein wegen DTO-Enum |

UNDER_REVIEW→OPEN und WITHDRAWN müssen mit konkreten Transitiontests reviewed werden. Kein stilles Auffüllen unbekannter Zustände mit OPEN; unbekannte Werte sind interne Konsistenzfehler.

## Zeitliche Schichtkonfiguration

7.2 UNIQUE(company,project,shift_code) speichert keine Historie; API erwartet effectiveFromMonth/effectiveForMonth. Vorschlag: Shiftconfiguration-Revisions je (company, project, effective_from_month), dazu genau eine DAY/NIGHT-Definition je Revision. UNIQUE(company,project,effective_from_month); FK auf Projekt im selben Tenant; Datum am Monatsersten. Read wählt letzte Revision <= angefragter Monat. Gleichzeitige Revisionen über Unique Constraint absichern.

Alternative: immutable Konfigurationssnapshot je MonthlyPlan. Einfachere stabile Planhistorie, aber zusätzlicher Kopier-/Konfliktvertrag für API effectiveForMonth. Auswahl vor SP-08 festhalten; diese PR migriert keine Variante ungefragt.

Duties speichern starts_at/ends_at timestamptz und verwendete Revision/Snapshotreferenz. Bestehende Duties werden nicht durch Konfigurationsänderung still neu berechnet. Fachliche spätere Änderungen laufen über validierte Planungstransaktion mit Duty.version und erforderlichem Lease.

Timezonequelle: pro Projekt konfigurierte IANA-Zone, für deutsche Demo Europe/Berlin; keine Server-Systemzone als Geschäftsregel. NIGHT kann am nächsten Kalendertag enden. Nicht existierende/mehrdeutige lokale Zeiten bei DST benötigen ausdrückliche Regel; vor Umsetzung keine automatische Bibliothekskorrektur voraussetzen. Tests: Monats-/Jahresgrenze, Nacht über Mitternacht, DST gap/fold, historische Planstabilität, Overlap und stale-write rollback.

CR-03: UNPUBLISHED nur vor erstem Publish. Spätere validierte Änderungen wirken nach Commit direkt; Cancellation reconciliation, Audit und notwendige Outbox in derselben Transaktion. Lease koordiniert, Expected-Version verhindert verlorene Updates.
