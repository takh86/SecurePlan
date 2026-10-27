# Schichtkonfiguration: Übergabe an SP-11

Stand: 27.10.2026. Betrifft `GET`/`PATCH /api/v1/projects/{projectId}/shift-configuration` (SP-08b, Backend-Slice, Stand PARTIAL) und die Monatsplanung SP-11. Entscheidungsgrundlage: [ADR-0003](../architektur/adr/0003-schichtkonfiguration-monatsversioniert.md).

## Was SP-08b liefert

- **Tabelle `shift_configurations`** (Migration `0009`): Versionen je Projekt und Wirkmonat; eine Version ist die vollständige Menge von 1–2 Schichtarten (`TAG`/`NACHT`) mit lokalen Uhrzeiten (`time(0)`, minutengenau).
- **Wirksame Konfiguration für Monat X:** alle Zeilen des jüngsten `effective_from_month ≤ X`. Fehlende Arten werden nicht aus älteren Versionen übernommen. Die Leseabfrage steht in `ShiftConfigurationsService.getEffective` (wählt erst den Monat, dann alle Zeilen genau dieses Monats).
- **Keine Defaults:** Ein Projekt ohne Version hat keine Schichtkonfiguration.
- **Temporärer Planungsschutz:** `shift-configuration-planning-guard.ts` sperrt jede tatsächliche Konfigurationsänderung (`409 SHIFT_CONFIGURATION_CONFLICT`), sobald eine Tabelle mit einem bekannten Planungsnamen existiert. `GET` und echte No-op-`PATCH`es bleiben erlaubt.

## Pflichten von SP-11

### 1. Wirksame Konfiguration verwenden

- Beim Anlegen oder Ändern eines Dienstes wird die wirksame Version für den Monat des `duty_date` in **derselben Transaktion** gelesen, nachdem das Projekt mit `FOR SHARE` gesperrt wurde (siehe Sperrreihenfolge). So kann kein gleichzeitiger Schicht-`PATCH` (`FOR NO KEY UPDATE`) die Grundlage während der Prüfung ändern.
- Fehlt die Schichtart des Dienstes in dieser Version oder gibt es gar keine Version: `409 SHIFT_CONFIGURATION_MISSING`. Das ist die einzige Verwendung dieses Codes; `GET` der Konfiguration liefert ohne Version `200` mit `effectiveFromMonth: null` (A-SP08b-01).

### 2. Dienst-Snapshot (O-10)

- Dienste speichern Schichtart und die aufgelösten Zeitpunkte `starts_at`/`ends_at` (`timestamptz`, UTC). **Kein** Fremdschlüssel auf `shift_configurations`: Deren Zeilen werden durch Full Replacement gelöscht oder neu angelegt, und spätere Konfigurationsänderungen dürfen bestehende Dienstzeiten nie still verändern.
- `duty_date` ist der Kalendertag, an dem die Schicht beginnt. Ende am Folgetag genau dann, wenn `end_local < start_local` (nur NACHT).
- Auflösung ausschließlich mit `companies.time_zone`; es gibt keine Projekt-Zeitzone. `ends_at > starts_at` wird an den realen Zeitpunkten geprüft.

### 3. DST-Regel N-1 vorher entscheiden

Vor der Implementierung legt der Owner fest, wie lokale Uhrzeiten aufgelöst werden, die an Umstellungstagen nicht existieren oder doppelt vorkommen. Das implizite Verhalten von PostgreSQL oder JS-Bibliotheken darf nicht stillschweigend die Regel sein. Optionen:

- **(a)** Deterministische Auflösung (nicht existierend → vorwärts um die Lücke; doppelt → erste Ausprägung).
- **(b)** Dienst an diesen Tagen ablehnen; dafür gibt es heute keinen passenden Code.
- **(c)** Solche Uhrzeiten schon beim Konfigurieren ablehnen; das wäre eine neue, zeitzonenabhängige Regel in SP-08b.

Pflicht-Testfälle (synthetisch, Real-PostgreSQL):

| Zone | Umstellung | Fall | Erwartung |
|---|---|---|---|
| Europe/Berlin | 29.03.2026, 02:00 → 03:00 | NACHT 18:00–06:00 mit `duty_date` 28.03. | 17:00Z → 04:00Z, real 11 h |
| Europe/Berlin | 25.10.2026, 03:00 → 02:00 | NACHT 18:00–06:00 mit `duty_date` 24.10. | 16:00Z → 05:00Z, real 13 h |
| Europe/Berlin | 29.03.2026 | TAG 06:00–18:00 | 04:00Z → 16:00Z, 12 h |
| Europe/Berlin | beide Tage | Start oder Ende zwischen 02:00 und 02:59 | gemäß N-1 |
| America/New_York | 08.03.2026 und 01.11.2026, je 02:00 | NACHT über die Umstellung | gemäß N-1 |

Keine Logik darf annehmen, dass eine Nachtschicht 12 reale Stunden dauert. Stunden werden, falls je benötigt, nur als `ends_at − starts_at` berechnet. Die MVP-Statistik zählt Schichten und Tage, keine Stunden.

### 4. Echte Abhängigkeitsprüfung statt Tripwire (Gate vor Auslieferung von SP-11)

**Ziel:** `assertShiftConfigurationPlanningCheckImplemented` durch die echte projekt- und monatsbezogene Prüfung ersetzen. Der Guard darf nicht umgangen, auskommentiert oder durch „Tabelle existiert, also egal“ ersetzt werden. Legt SP-11 die Planungstabellen an, ohne den Guard zu ersetzen, sind Schichtänderungen absichtlich gesperrt. Der SP-09-Guard (`planning-dependency-guard.ts`) ist eine eigene, gleichartige Aufgabe ([Übergabe Zuordnungen](project-assignment-correction-handoff.md)).

**Regelvorschlag (Owner-Entscheidung bei SP-11):** Ein `PATCH` mit tatsächlicher Änderung für Projekt P und Wirkmonat M wird mit `409 SHIFT_CONFIGURATION_CONFLICT` abgelehnt, wenn Dienste von P mit `duty_date` im betroffenen Bereich existieren. Der Bereich reicht von M bis vor den nächsten späteren Wirkmonat von P, ohne spätere Version offen nach oben. Das gilt unabhängig davon, ob der Plan veröffentlicht ist, solange der Owner für unveröffentlichte Pläne nichts anderes festlegt.

**Acceptance Criteria**

1. Ändern der Zeiten einer Art, Weglassen einer Art oder Anlegen einer neuen Version für M wird abgelehnt, wenn im betroffenen Bereich Dienste von P existieren.
2. Dienste vor M oder ab dem nächsten späteren Wirkmonat blockieren nicht.
3. Ohne abhängige Dienste funktioniert der `PATCH` wie bisher (`200`); ein echter No-op bleibt immer `200` ohne Audit.
4. Bestehende Dienstzeiten werden nie verändert; die Konfigurationsänderung löst keine Kaskade aus.
5. Die Prüfung läuft in derselben Transaktion unter der Projektsperre (`FOR NO KEY UPDATE`). Alle Dienst-Schreiber nehmen vorher das Projekt mit `FOR SHARE`, sodass während der Prüfung kein neuer Dienst entsteht.
6. Code und Text bleiben katalogkonform (keine neuen Codes) und geben keine Plandetails preis.
7. Der Tripwire-Test wird durch fachliche Integrationstests ersetzt, nicht gelöscht.
8. Verwendet SP-11 andere Tabellennamen als die Guard-Liste, wird die Liste bis zur Ablösung im selben PR angepasst.

**Integrationstests (Real-PostgreSQL, synthetische Daten)**

- Veröffentlichter Plan mit Diensten im Bereich: Zeitänderung, Weglassen einer Art und neue Version ergeben je `409`, Zustand unverändert, kein Audit.
- Unveröffentlichter Plan: gleiche Fälle nach der dann gültigen Owner-Regel.
- Dienste nur vor M oder nur ab dem nächsten späteren Wirkmonat: `200`.
- No-op mit vorhandenen Diensten: `200`, kein Audit.
- Nebenläufigkeit: Schicht-`PATCH` gegen gleichzeitige Dienstanlage für dasselbe Projekt, in beiden Sperrreihenfolgen, ohne Deadlock; danach passt jeder Dienst zur zum Anlagezeitpunkt wirksamen Version.
- Cross-Tenant: Dienste eines anderen Unternehmens beeinflussen die Entscheidung nie.
- Rollback: Ein Audit-Fehler nach bestandener Prüfung lässt alles unverändert.

### 5. Sperrreihenfolge

Heute: Actor (`accounts`, `companies` `FOR SHARE`) → Mitarbeiter (`FOR NO KEY UPDATE`, aufsteigende ID) → Projekt (Zuordnungen `FOR SHARE`, Schicht-`PATCH` und Projekt-`PATCH` `FOR NO KEY UPDATE`) → Zuordnungszeile. SP-11 ordnet Planungssperren danach ein: Actor → Mitarbeiter → Projekt → Monatsplan → Dienste → Plan-Zuordnungen. Die Reihenfolge wird mit dem Planungs-Concurrency-Konzept abgeglichen, dokumentiert und per Nebenläufigkeitstest belegt; kein neuer Deadlock-Pfad.

### 6. Revalidierung beim Veröffentlichen

Die Revalidierung der Schichtkonfiguration beim Veröffentlichen ist bei Snapshot-Diensten zu definieren. Vorschlag: Die Schichtart jedes Dienstes existiert in der wirksamen Version seines Monats. Weil die echte Abhängigkeitsprüfung Änderungen mit betroffenen Diensten verhindert, können Dienstzeiten und Konfiguration danach nicht auseinanderlaufen.

## Nicht enthalten

React-Oberfläche für Schichtzeiten, DST-Auflösung, Dienste, BR-SHIFT-03 (Ruhezeit, Production-Follow-up) und ein freigegebener Audit-Aktionskatalog.
