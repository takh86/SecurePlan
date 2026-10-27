# ADR-0003 — Projektbezogene Schichtkonfiguration: monatsversioniert, vollständige Menge je Wirkmonat

- **Status:** Angenommen
- **Datum:** 27.10.2026
- **Entscheidung durch:** Product Owner / Projektverantwortlicher (Owner-Ratifizierung der Entscheidungen O-1 bis O-10 vom 27.10.2026)
- **Geltungsbereich:** `GET`/`PATCH /api/v1/projects/{projectId}/shift-configuration` und Tabelle `shift_configurations` (Migration `0009_shift_configurations.sql`)
- **Betroffene Anforderungen:** FR-SHIFT-01, FR-SHIFT-02, BR-SHIFT-01, BR-SHIFT-02 (BR-SHIFT-03 ausdrücklich nicht)
- **Referenzen:** Interne Baselines Phase 2 (Anforderungen), Phase 7 / 7.2 / 7.3 (DB-Design), Phase 8.3/8.4/8.5/8.8/8.9/8.10/8.11 (API-Vertrag); SP-08b, Issue #22; ADR-0002.

## Kontext

SP-08 ist PARTIAL: Projekte haben bisher nur Name und Status. Für die Monatsplanung (SP-11) braucht jedes Projekt konfigurierbare Schichten TAG und NACHT mit Start- und Endzeit; eine Nachtschicht darf über Mitternacht gehen. Die Zeiten des aktuellen Kundenprojekts (TAG 06:00–18:00, NACHT 18:00–06:00) gelten nur für dieses Projekt und sind keine Systemregel.

Der API-Vertrag liest die Konfiguration ausdrücklich **für einen Monat** (Pflicht-Parameter `effectiveForMonth`) und schreibt sie **ab einem Wirkmonat** (`effectiveFromMonth`). Die freigegebenen internen Baselines widersprechen sich dabei in mehreren Punkten:

1. **Datenmodell:** Das logische DB-Design sieht eine nach Wirkmonat versionierte Konfiguration vor. Das physische DB-Design und das Operations-Gate beschreiben dagegen eine Definition je Projekt und Schichtart ohne Wirkmonat, die in-place geändert und per Aktiv-Flag abgeschaltet wird.
2. **DB-Vokabular:** Das logische Design nennt für die Schichtart die Werte DAY/NIGHT, das physische Design und der bestehende Code (`employees.shift_eligibility`) verwenden TAG/NACHT.
3. **Zeitformat:** Ein Beispiel im DTO-Design zeigt lokale Zeiten mit Sekunden, der Validierungsvertrag legt kanonisch `HH:mm` fest.
4. **Kein Zustand „nicht konfiguriert“:** Das Antwortschema kennt keinen Fall, in dem für den angefragten Monat noch keine Version existiert; der Wirkmonat ist dort nicht nullable.
5. **Zeitzone:** An einer Stelle ist von „Projekt-Zeitzone“ die Rede, das Modell kennt aber nur die Unternehmens-Zeitzone (`companies.time_zone`).
6. **Dienste:** Das physische Design verknüpft Dienste per Fremdschlüssel mit der Schichtdefinition, das logische Design speichert aufgelöste Start-/Endzeitpunkte am Dienst.

Ohne Entscheidung ist SP-08b nicht vertragskonform umsetzbar, und SP-11 hätte keine verlässliche Quelle für Schichtzeiten.

## Betrachtete Optionen

### Option A — Definition je Projekt und Schichtart, in-place geändert (verworfen)
- **Vorteile:** Eine Zeile je Schichtart, einfachste Abfrage.
- **Nachteile:** Erfüllt den monatsbezogenen Lese- und Schreibvertrag nicht (`effectiveForMonth`/`effectiveFromMonth` wären bedeutungslos). Eine Änderung überschreibt die Historie; welche Zeiten in einem früheren Monat galten, ist danach nicht mehr ablesbar.
- **Risiken:** Bestehende oder künftige Pläne könnten still andere Zeiten „erben“.

### Option B — Versionierte vollständige Menge je Projekt und Wirkmonat (gewählt)
- **Vorteile:** Eine Tabelle; erfüllt den freigegebenen API-Vertrag; frühere Monate bleiben unverändert nachvollziehbar.
- **Nachteile:** Lesen braucht „jüngster Wirkmonat ≤ X“; einige Invarianten (1–2 Zeilen je Version, Ersetzen der ganzen Menge) sind nur im Service durchsetzbar.

### Option C — Kopf-Tabelle je Version plus Regel-Tabelle (verworfen)
- **Vorteile:** Die Version ist eine eigene Entität; eine explizit leere Version wäre darstellbar.
- **Nachteile:** Zweite Tabelle, zweiter FK-Pfad und mehr Sperr- und Testaufwand ohne Nutzen im MVP.

### Teilentscheidung: Antwort ohne wirksame Version
- **A1 — `200` mit `effectiveFromMonth: null` und `shifts: []` (gewählt, Amendment A-SP08b-01).** Ein neues Projekt ohne Konfiguration ist ein erwarteter Datenzustand, kein Fehler. Die Invariante „`null` genau dann, wenn `shifts` leer ist“ ist einfach prüfbar.
- **A2 — `409 SHIFT_CONFIGURATION_MISSING` (verworfen).** Der Code ist für das Anlegen eines Dienstes ohne passende Konfiguration bestimmt (SP-11); ihn für einen lesenden Zugriff zu verwenden, hätte seine feste Bedeutung erweitert. Jedes neue Projekt hätte beim ersten Aufruf einen Konfliktfehler erzeugt.
- **A3 — `404` (verworfen).** Nicht unterscheidbar vom verschleierten fremden oder unbekannten Projekt.
- **A4 — Server-Defaults 06–18/18–06 (verworfen).** Würde erfundene Daten liefern.

## Entscheidung

**Option B mit A1 ist angenommen.** Die ratifizierten Owner-Entscheidungen:

| # | Regel |
|---|---|
| O-1 | **Monatsversioniert.** Eine Version ist die vollständige Menge der Zeilen mit gleichem (Unternehmen, Projekt, Wirkmonat). Je Version gibt es höchstens eine Zeile pro Schichtart. |
| O-2 | **Zeitrelation.** Start ≠ Ende. TAG endet später am selben Kalendertag (Ende > Start; ein Ende um 00:00 ist kein TAG). NACHT darf über Mitternacht gehen, muss aber nicht (z. B. 00:00–06:00). |
| O-3 | **Keine rückwirkende Änderung.** Geschrieben werden darf nur der aktuelle oder ein zukünftiger Wirkmonat, bestimmt in der Unternehmens-Zeitzone. Vergangene Wirkmonate sind unveränderliche Historie (`400 SHIFT_CONFIGURATION_INVALID`). Eine Obergrenze gibt es nicht. |
| O-4 | **Überlappung** von TAG und NACHT wird nicht erzwungen; Doppelbelegungen von Personen prüft die Planung (SP-11). |
| O-5 | **Full Replacement.** `PATCH` ersetzt die gesamte Menge (1–2 Schichtarten) des angegebenen Wirkmonats. Eine weggelassene Art gilt ab diesem Monat als nicht konfiguriert. Eine Konfiguration lässt sich nicht vollständig entfernen. |
| O-6 | **A-SP08b-01:** `GET` ohne Version bis zum angefragten Monat liefert `200` mit `effectiveFromMonth: null` und `shifts: []`. Nach einem erfolgreichen `PATCH` ist `effectiveFromMonth` nie `null`. |
| O-7 | **Keine stillen Server-Defaults.** 06:00–18:00 und 18:00–06:00 sind nur als gekennzeichnete UI-Vorschläge zulässig; gespeichert wird erst, wenn der Admin speichert. Kein Seed per Migration. |
| O-8 | **Temporärer Planungsschutz.** Eine Neufassung desselben Monats ist erlaubt, solange keine Planungsdaten betroffen sein können. Bis SP-11 gilt ein Fail-closed-Guard (siehe unten). |
| O-9 | **Audit** `SHIFT_CONFIGURATION_UPDATED` (vorläufiger Name, kein freigegebener Aktionskatalog), Ressource `PROJECT_SHIFT_CONFIGURATION` mit der Projekt-ID. Alte und neue Menge des Wirkmonats, ohne Zeilen-IDs und ohne personenbezogene Daten. Ein No-op wird nicht auditiert. |
| O-10 | **Dienst-Snapshot erst in SP-11.** Dienste speichern Schichtart und aufgelöste UTC-Zeitpunkte, ohne Fremdschlüssel auf die Konfiguration. Spätere Konfigurationsänderungen verändern so keine bestehenden Dienstzeiten. |

Weitere ratifizierte Festlegungen:

- **Zeitformat:** Request und Response verwenden kanonisch `HH:mm` (24-Stunden, keine Sekunden, kein `24:00`).
- **Mapping:** API `DAY`/`NIGHT` ↔ DB `TAG`/`NACHT` über einen expliziten Mapper; ein unbekannter gespeicherter Wert schlägt geschlossen fehl (500 ohne Details). Die API nimmt `TAG`/`NACHT` nicht an.
- **Zeitzone:** Die Unternehmens-Zeitzone ist die einzige Quelle. Es gibt keine Projekt-Zeitzone; „Projekt-Zeitzone“ in den Baselines meint die Unternehmens-Zeitzone.
- **Lesesemantik:** Wirksam für Monat X ist die ganze Menge des jüngsten Wirkmonats ≤ X. Fehlende Schichtarten werden **nicht** aus älteren Versionen übernommen.

**Ausschlaggebender Grund:** Nur die Monatsversion erfüllt den freigegebenen monatsbezogenen Vertrag und erlaubt Änderungen, ohne die Bedeutung bereits vergangener Monate zu verändern.

## Umsetzung (SP-08b Backend)

**Prüfreihenfolge `PATCH`** (nach globalem Guard und DTO-Validierung): `INVALID_MONTH_START` → `SHIFT_CONFIGURATION_INVALID` (Zeitrelation) → in der Transaktion: Actor-Recheck → `404` Projekt (unbekannt, fremd, ARCHIVED) → `PROJECT_INACTIVE` (auch bei unverändertem Payload) → `SHIFT_CONFIGURATION_INVALID` (vergangener Monat) → No-op `200` → `SHIFT_CONFIGURATION_CONFLICT` (Planungsschutz) → Schreiben und Audit. Doppelte Schichtarten im Request sind ein Validierungsfehler (`DUPLICATE_ITEM`), keine stille Deduplizierung. Es gibt keine neuen Fehlercodes.

**Diff-Apply mit stabilen IDs:** Unter der Projektsperre werden fehlende Arten des Monats gelöscht, neue eingefügt und geänderte Zeiten in-place aktualisiert. Eine ID identifiziert (Projekt, Wirkmonat, Schichtart): Sie bleibt bei einer Zeitänderung derselben Art im selben Monat erhalten; ein neuer Wirkmonat oder eine wieder hinzugefügte Art bekommt eine neue ID. Clients dürfen IDs nicht über Versionen hinweg gleichsetzen.

**No-op:** Verglichen wird mit der Menge **genau dieses** Wirkmonats. Ist sie identisch, antwortet `PATCH` mit `200` ohne Schreibzugriff und ohne Audit. Existiert für den Monat noch keine Version, ist das Anlegen auch dann eine Änderung, wenn die Zeiten der vorherigen Version gleichen.

### Wer erzwingt welche Invariante

| Invariante | PostgreSQL | Application Service |
|---|---|---|
| Projekt gehört zum Unternehmen der Zeile | Composite-FK `(company_id, project_id)`, `ON DELETE RESTRICT` | Alle Abfragen zusätzlich per `company_id` aus der Session |
| Höchstens eine Zeile je Projekt, Monat und Art | `UNIQUE (company_id, project_id, effective_from_month, shift_kind)` | Diff-Apply per `ON CONFLICT` |
| Wirkmonat ist ein Monatserster | CHECK | `INVALID_MONTH_START` vor jedem Schreiben |
| Schichtart nur TAG/NACHT | CHECK | Mapper; API nimmt nur DAY/NIGHT |
| Minutengenau (keine Sekunden) | CHECK | `HH:mm`-Validator |
| Start ≠ Ende; TAG nicht über Mitternacht | CHECK | `SHIFT_CONFIGURATION_INVALID` vor jedem Schreiben |
| 1–2 Schichtarten je Version | – | DTO (Array 1..2, eindeutige Art) |
| Version wird vollständig ersetzt, keine Mischung | – | Diff-Apply unter Projektsperre in einer Transaktion |
| Nur aktueller oder zukünftiger Monat schreibbar | – (uhrzeitabhängig) | Monatsregel in der Unternehmens-Zeitzone |
| Keine Vererbung fehlender Arten beim Lesen | – | Abfrage wählt erst den Monat, dann alle Zeilen genau dieses Monats |
| INACTIVE blockiert Schreiben | – | Statusprüfung unter Projektsperre |
| Audit gehört zur Änderung | – | Audit auf demselben Transaktions-Client; ein Fehler rollt alles zurück |

### Nebenläufigkeit: Last-Writer-Wins

Jeder schreibende Pfad nimmt zuerst den Actor-Lock (`FOR SHARE` auf Account und Unternehmen), dann `projects … FOR NO KEY UPDATE`. Diese Sperre serialisiert alle Schreiber der Konfiguration eines Projekts und einen gleichzeitigen Statuswechsel (der Projekt-`PATCH` nimmt dieselbe Sperre). Zuordnungs-Schreibzugriffe (`FOR SHARE`) warten kurz; FK-Prüfungen (`KEY SHARE`) werden nicht blockiert.

Zwei gleichzeitige Admin-`PATCH`es auf denselben Monat sind **Last-Writer-Wins**: Beide werden vollständig in Sperrreihenfolge angewendet, der spätere ersetzt das Ergebnis des früheren, und beide Änderungen werden auditiert. Der v1-Vertrag hat für Stammdaten **keine Expected-Version-Vorbedingung**. Ein `PATCH`, der auf einem veralteten Stand beruht, wird daher **nicht** erkannt. Die Zeilensperre verhindert nur gemischte oder unvollständige Mengen; sie verhindert keine Lost Updates im Sinne überschriebener fremder Änderungen. Eine Versionsprüfung bräuchte eine eigene Vertragsfreigabe.

### Temporärer Planungsschutz (bis SP-11)

Monatspläne, Dienste und Plan-Zuordnungen existieren erst ab SP-11. Ihr Fehlen gilt nicht als Nachweis, dass eine Änderung sicher ist. Der Guard prüft konservativ, ob eine Tabelle mit einem der bekannten Planungsnamen existiert (Plural- und Singularform: `monthly_plan(s)`, `duty`/`duties`, `plan_assignment(s)`, `duty_assignment(s)`). Existiert eine, schlägt **jede tatsächliche Änderung** mit `409 SHIFT_CONFIGURATION_CONFLICT` fehl. `GET` und echte No-op-`PATCH`es bleiben erlaubt. Der SP-09-Guard ist davon getrennt und unverändert. SP-11 muss den Guard durch eine echte Abhängigkeitsprüfung ersetzen ([Übergabe an SP-11](../../datenbank/shift-configuration-sp11-handoff.md)).

## Konsequenzen

**Positiv**
- Der API-Vertrag wird ohne neue Endpunkte und ohne neue Fehlercodes erfüllt.
- Frühere Monate bleiben unverändert; SP-11 hat eine eindeutige Quelle „wirksame Konfiguration für Monat X“.
- Gleichzeitige Änderungen erzeugen nie eine gemischte Menge.

**Negativ / erkaufte Nachteile**
- Lesen braucht eine Unterabfrage; mehrere Invarianten liegen nur im Service.
- Eine einmal angelegte Konfiguration kann nicht vollständig entfernt werden.
- Last-Writer-Wins ohne Erkennung veralteter Stände.
- Sobald SP-11 Planungstabellen anlegt, sind alle Schichtänderungen gesperrt, bis die echte Prüfung existiert.

**Was später teuer wird**
- Eine explizit leere Version oder eine Versionsprüfung erfordert eine Vertragsänderung.
- Eine Projekt-Zeitzone würde eine Migration und die Neuberechnung künftiger Dienste erfordern.

## Auswirkung auf Sicherheit und Datenintegrität

Keine Schwächung. Nur `COMPANY_ADMIN` des eigenen Unternehmens; der Tenant-Kontext kommt ausschließlich aus der serverseitig validierten Session. Unbekannte, fremde, archivierte und syntaktisch ungültige Projekt-IDs liefern dasselbe `404`. `PATCH` erzwingt Origin, Session und CSRF über den globalen Guard und prüft den Actor erneut in der Transaktion. Die DTOs sind strikte Whitelists, auch innerhalb jeder Schichtregel (`companyId`, `projectId` oder `id` im Body ergeben `UNKNOWN_FIELD`). Fehlerantworten geben keine Eingabewerte, SQL- oder Constraint-Namen zurück. Ein Audit-Fehler rollt die Änderung vollständig zurück.

## DST und Zeitsemantik (Schnittstelle zu SP-11)

SP-08b speichert validierte **lokale Wanduhrzeiten** und prüft nur nominal (Start ≠ Ende, TAG nicht über Mitternacht; die nominale Dauer liegt damit immer zwischen 0 und 24 Stunden). SP-11 löst konkrete Dienstdaten mit der Unternehmens-Zeitzone in UTC-Zeitpunkte auf. Eine Nachtschicht 18:00–06:00 dauert in Europe/Berlin in der Nacht der Sommerzeit-Umstellung real 11 und in der Nacht der Rückstellung 13 Stunden. Keine Logik darf 12 reale Stunden annehmen.

**Offene Owner-Entscheidung N-1 (vor SP-11):** Wie lokale Uhrzeiten aufgelöst werden, die an Umstellungstagen nicht existieren oder doppelt vorkommen. Das implizite Verhalten von Datenbank oder Bibliotheken darf nicht stillschweigend zur Regel werden.

## Formell fortzuschreibende interne Baselines

Die internen, nicht öffentlichen Baselines müssen diese Entscheidung nachziehen; das ist noch nicht erfolgt:

1. **Physisches DB-Design und Operations-Gate:** versionierte Schichtkonfiguration statt Definition ohne Wirkmonat; Werte TAG/NACHT; Dienste mit aufgelösten Zeitpunkten statt Fremdschlüssel (O-10, Detail in SP-11).
2. **Logisches DB-Design:** DB-Werte TAG/NACHT; „Projekt-Zeitzone“ = Unternehmens-Zeitzone.
3. **API-DTO-Design und OpenAPI-Sicht:** A-SP08b-01 (nullable Wirkmonat, leere Liste); Zeitformat `HH:mm` auch im Beispiel.
4. **API-Validierungsvertrag:** O-2-Klarstellung, O-3 (Untergrenze), O-5 (Full Replacement).
5. **API-Testvertrag:** Testfall für `GET` ohne Version.
6. **Konsolidierte API-Baseline:** Eintrag A-SP08b-01 im Amendment-Register.

## Offene Folgepunkte

- **SP-08b bleibt PARTIAL:** Die React-Admin-UI (Abschnitt „Schichtzeiten“ auf der Projekt-Detailseite) fehlt noch.
- **OPEN – N-1 DST-Auflösung:** Owner-Entscheidung vor SP-11.
- **OPEN – Echte Planungsabhängigkeitsprüfung:** in SP-11; die Regel, welche Dienste eine Änderung blockieren, entscheidet der Owner dort.
- **OPEN – Audit-Aktionskatalog:** `SHIFT_CONFIGURATION_UPDATED` ist vorläufig.
- **OPEN – BR-SHIFT-03 (Ruhezeit Nacht → Tag):** Production-Follow-up, rechtlich zu validieren; nicht Teil von SP-08b.
- **OPEN – Formelle interne Baseline-Fortschreibung** (Liste oben).

## Nachweis des Verständnisses

- [x] Die Entscheidung ist ohne dieses Dokument erklärbar (Monatsversion = einzige vertragskonforme Lesart; vergangene Monate bleiben unverändert).
- [x] Die verworfenen Alternativen A und C sowie A2–A4 sind mit Begründung benannt.
- [x] Der erkaufte Nachteil (Service-Invarianten, Last-Writer-Wins, keine vollständige Entfernung, Sperre ab SP-11) ist bekannt.
