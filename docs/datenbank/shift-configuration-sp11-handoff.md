# Schichtkonfiguration: Übergabe an SP-11

Stand: 29.10.2026. Betrifft `GET`/`PATCH /api/v1/projects/{projectId}/shift-configuration` (SP-08b, Backend und React-Oberfläche mit #62 implementiert) und die noch offene Monatsplanung SP-11. Entscheidungsgrundlage: [ADR-0003](../architektur/adr/0003-schichtkonfiguration-monatsversioniert.md) mit datiertem Nachtrag, [PO-D1–D6](https://github.com/takh86/SecurePlan/issues/64#issuecomment-6502123168) und der [verbindliche SP-11-Handoff in #25](sp11-integrity-handoff.md). Business-Regeln sind freigegeben; detaillierte Implementierungsverträge und unabhängige Abnahme bleiben offen. Browsernachweis bleibt NOT_RUN.

## Was SP-08b liefert

- **Tabelle `shift_configurations`** (Migration `0009`): Versionen je Projekt und Wirkmonat; eine Version ist die vollständige Menge von 1–2 Schichtarten (`TAG`/`NACHT`) mit lokalen Uhrzeiten (`time(0)`, minutengenau).
- **Wirksame Konfiguration für Monat X:** alle Zeilen des jüngsten `effective_from_month ≤ X`. Fehlende Arten werden nicht aus älteren Versionen übernommen. Die Leseabfrage steht in `ShiftConfigurationsService.getEffective` (wählt erst den Monat, dann alle Zeilen genau dieses Monats).
- **Keine Defaults:** Ein Projekt ohne Version hat keine Schichtkonfiguration.
- **Temporärer Planungsschutz:** `shift-configuration-planning-guard.ts` sperrt jede tatsächliche Konfigurationsänderung (`409 SHIFT_CONFIGURATION_CONFLICT`), sobald eine Tabelle mit einem bekannten Planungsnamen existiert. `GET` und echte No-op-`PATCH`es bleiben erlaubt.
- **React-Oberfläche:** `ShiftConfigurationSection` ist im Projekt-Detail eingebunden. `ShiftConfigurationSection.test.tsx` prüft Vererbung/Full Replacement, Fehler mit erhaltenen Eingaben, INACTIVE/read-only, Fokus und Navigation. Das sind jsdom-Regressionsnachweise, kein Browser-E2E.

## Pflichten von SP-11

### 1. Wirksame Konfiguration verwenden

- Beim Anlegen oder Ändern eines Dienstes wird die wirksame Version für den Monat des `duty_date` in **derselben Transaktion** gelesen, nachdem das Projekt mit `FOR SHARE` gesperrt wurde (siehe Sperrreihenfolge). So kann kein gleichzeitiger Schicht-`PATCH` (`FOR NO KEY UPDATE`) die Grundlage während der Prüfung ändern.
- Fehlt die Schichtart des Dienstes in dieser Version oder gibt es gar keine Version: `409 SHIFT_CONFIGURATION_MISSING`. Das ist die einzige Verwendung dieses Codes; `GET` der Konfiguration liefert ohne Version `200` mit `effectiveFromMonth: null` (A-SP08b-01).

### 2. Dienst-Snapshot (O-10)

- Dienste speichern Schichtart und die aufgelösten Zeitpunkte `starts_at`/`ends_at` (`timestamptz`, UTC). **Kein** Fremdschlüssel auf `shift_configurations`: Deren Zeilen werden durch Full Replacement gelöscht oder neu angelegt, und spätere Konfigurationsänderungen dürfen bestehende Dienstzeiten nie still verändern.
- `duty_date` ist der Kalendertag, an dem die Schicht beginnt. Ende am Folgetag genau dann, wenn `end_local < start_local` (nur NACHT).
- Auflösung ausschließlich mit `companies.time_zone`; es gibt keine Projekt-Zeitzone. `ends_at > starts_at` wird an den realen Zeitpunkten geprüft.

### 3. DST-Regel N-1 durch PO-D6 entschieden, Umsetzung offen

Am 29.10.2026 hat der PO die frühere Option (a) freigegeben: nicht existierende lokale Uhrzeit um die genaue Offset-Lücke vorwärts verschieben; doppelte Uhrzeit auf das erste Vorkommen in Echtzeit, also den früheren UTC-Zeitpunkt, auflösen. Start/Ende auf ihren richtigen Kalendertagen auflösen und exakte UTC-Snapshots speichern. Keine implizite PostgreSQL-/JS-Standardeinstellung darf die Entscheidung ersetzen. Resolver, Zeitzonendaten-/Präzisions- und Fehlervertrag sind vor SP-11 noch technisch freizugeben; vollständige Abnahmefälle stehen im D6-Handoff.

Die früher betrachteten Alternativen (b), betroffene Dienste generell abzulehnen, und (c), solche Konfigurationszeiten generell zu verbieten, wurden mit der Auswahl von (a) nicht übernommen. Das ist keine neue Einschränkung des Schichtkonfigurations-PATCH.

Pflicht-Testfälle (synthetisch, Real-PostgreSQL):

| Zone | Umstellung | Fall | Erwartung |
|---|---|---|---|
| Europe/Berlin | 29.03.2026, 02:00 → 03:00 | NACHT 18:00–06:00 mit `duty_date` 28.03. | 17:00Z → 04:00Z, real 11 h |
| Europe/Berlin | 25.10.2026, 03:00 → 02:00 | NACHT 18:00–06:00 mit `duty_date` 24.10. | 16:00Z → 05:00Z, real 13 h |
| Europe/Berlin | 29.03.2026 | TAG 06:00–18:00 | 04:00Z → 16:00Z, 12 h |
| Europe/Berlin | beide Tage | 02:30 als Start oder Ende | Frühjahr 03:30 → 01:30Z; Herbst erstes 02:30 → 00:30Z |
| America/New_York | 08.03.2026 | nicht existentes 02:30 | 03:30 → 07:30Z |
| America/New_York | 01.11.2026 | doppeltes 01:30 | erstes Vorkommen → 05:30Z; 02:30 ist hier eindeutig |

Keine Logik darf annehmen, dass eine Nachtschicht 12 reale Stunden dauert. Stunden werden, falls je benötigt, nur als `ends_at − starts_at` berechnet. Die MVP-Statistik zählt Schichten und Tage, keine Stunden.

### 4. Echte Abhängigkeitsprüfung statt Tripwire (Gate vor Auslieferung von SP-11)

**Ziel:** `assertShiftConfigurationPlanningCheckImplemented` durch die echte projekt- und monatsbezogene Prüfung ersetzen. Der Guard darf nicht umgangen, auskommentiert oder durch „Tabelle existiert, also egal“ ersetzt werden. Legt SP-11 die Planungstabellen an, ohne den Guard zu ersetzen, sind Schichtänderungen absichtlich gesperrt. Der SP-09-Guard (`planning-dependency-guard.ts`) ist eine eigene, gleichartige Aufgabe ([Übergabe Zuordnungen](project-assignment-correction-handoff.md)).

**Freigegebene Business-Regel PO-D3:** Ein `PATCH` mit tatsächlicher Änderung für Projekt P und Wirkmonat M wird mit `409 SHIFT_CONFIGURATION_CONFLICT` abgelehnt, wenn gespeicherte Dienste von P von der geänderten Konfiguration im Bereich `[M, nächster späterer Wirkmonat von P)` abhängen; ohne spätere Version offen nach oben. DRAFT und PUBLISHED sind gleich geschützt. Lifecycle, exakte relationale Prädikate und Sperrprotokoll sind noch als Implementierungsvertrag freizugeben, einschließlich einer neu zwischen vorhandenen Versionen eingefügten Version.

**Acceptance Criteria**

1. Ändern der Zeiten einer Art, Weglassen einer Art oder Anlegen einer neuen Version für M wird abgelehnt, wenn im betroffenen Bereich Dienste von P existieren.
2. Dienste vor M oder ab dem nächsten späteren Wirkmonat blockieren nicht.
3. Ohne abhängige Dienste funktioniert der `PATCH` wie bisher (`200`); ein echter No-op bleibt immer `200` ohne Audit.
4. Bestehende Dienstzeiten werden nie verändert; die Konfigurationsänderung löst keine Kaskade aus.
5. Die Prüfung läuft in derselben Transaktion unter der Projektsperre (`FOR NO KEY UPDATE`). Alle Dienst-Schreiber nehmen vorher das Projekt mit `FOR SHARE`, sodass während der Prüfung kein neuer Dienst entsteht.
6. Code und Text bleiben katalogkonform (keine neuen Codes) und geben keine Plandetails preis.
7. Der Tripwire-Test wird durch fachliche Integrationstests ersetzt, nicht gelöscht.
8. Beide temporären Guards nutzen die zentrale Klassifikation `planning-guard/planning-table-classification.ts` (`PLANNING_GUARD_TABLES`, jedes Schema außer den reservierten Systemschemas `pg_*`, also auch `information_schema`). Jede neue Tabelle einer Migration muss dort als Planungs- oder Nicht-Planungstabelle eingetragen werden. Sonst schlägt der statische CI-Test `planning-table-classification.spec.ts` fehl, spätestens aber die Post-Migration-Prüfung `planning-classification-catalog-real.e2e-spec.ts`; sie gleicht `pg_catalog` ab und erfasst auch dynamisch erzeugte DDL. Fremde Schemas sind für Migrationen gesperrt.

**Integrationstests (Real-PostgreSQL, synthetische Daten)**

- Veröffentlichter Plan mit Diensten im Bereich: Zeitänderung, Weglassen einer Art und neue Version ergeben je `409`, Zustand unverändert, kein Audit.
- DRAFT/unveröffentlichter Plan: dieselben ablehnenden Fälle wie PUBLISHED nach PO-D3.
- Dienste nur vor M oder nur ab dem nächsten späteren Wirkmonat: `200`.
- No-op mit vorhandenen Diensten: `200`, kein Audit.
- Nebenläufigkeit: Schicht-`PATCH` gegen gleichzeitige Dienstanlage für dasselbe Projekt, in beiden Sperrreihenfolgen, ohne Deadlock; danach passt jeder Dienst zur zum Anlagezeitpunkt wirksamen Version.
- Cross-Tenant: Dienste eines anderen Unternehmens beeinflussen die Entscheidung nie.
- Rollback: Ein Audit-Fehler nach bestandener Prüfung lässt alles unverändert.

### 5. Sperrreihenfolge

Heute: Actor (`accounts`, `companies` `FOR SHARE`) → Mitarbeiter (`FOR NO KEY UPDATE`, aufsteigende ID) → Projekt (Zuordnungen `FOR SHARE`, Schicht-`PATCH` und Projekt-`PATCH` `FOR NO KEY UPDATE`) → Monatszuordnungszeile. Der Schicht-PATCH benötigt selbst keine Mitarbeiter-/Zuordnungssperre. Die frühere pauschale Erweiterung um Planungssperren ist **kein freigegebener globaler Vertrag**: ihre Position relativ zur Monatszuordnung und die Duty-first-Workflow-Regel müssen zusammen mit Publish-/Mitgliedschaftsschreibern aufgelöst werden. Siehe LOCK-01 im SP-11-Handoff. Vor Implementierung einheitlichen Sperrgraph freigeben und konkurrierende Inserts, beide Reihenfolgen, COMMIT/ROLLBACK sowie Auditfehler mit Real-PG nachweisen.

### 6. Revalidierung beim Veröffentlichen

Die Revalidierung der Schichtkonfiguration beim Veröffentlichen ist bei Snapshot-Diensten zu definieren. Vorschlag: Die Schichtart jedes Dienstes existiert in der wirksamen Version seines Monats. Weil die echte Abhängigkeitsprüfung Änderungen mit betroffenen Diensten verhindert, können Dienstzeiten und Konfiguration danach nicht auseinanderlaufen.

## Nicht enthalten

Implementierte DST-Auflösung/Dienste und BR-SHIFT-03 (Ruhezeit, Production-Follow-up). Die frühere Aussage, die React-Oberfläche fehle, ist durch #62 überholt. PO-D1 ratifiziert den bestehenden Namen `SHIFT_CONFIGURATION_UPDATED`; [ADR-0004](../architektur/adr/0004-related-business-audit-catalogue.md) beschreibt die begrenzte Semantik. Unabhängige kontrollierte Dokumentabnahme und Audit-Betriebskontrollen bleiben offen.
