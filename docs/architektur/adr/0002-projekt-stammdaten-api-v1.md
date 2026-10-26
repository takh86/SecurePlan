# ADR-0002 — Projekt-Stammdaten im MVP: API-v1-Vertrag (Name + Status) ist maßgeblich

**Status:** Angenommen  
**Datum:** 26.10.2026  
**Entscheidung durch:** Product Owner / Projektverantwortlicher (Owner-Entscheidung vom 26.10.2026)  
**Geltungsbereich:** Ressource Projekt (`/api/v1/projects`) und Tabelle `projects` (Migration `0007_projects.sql`)  
**Referenzen:** Interne Baselines Phase 7.2 (physisches DB-Design), Phase 5 (UX), Phase 8.3/8.4/8.5/8.11 (API-Vertrag); SP-08, Issue #22.

## Kontext

Für SP-08 (Projekte) und als Voraussetzung für SP-09 (monatsbezogene Projektzuordnung) muss die Tabelle `projects` angelegt werden. Die freigegebenen internen Baselines widersprechen sich in drei Punkten:

1. **Weitere Stammdaten:** Das physische DB-Design und die UX sehen eine Pflichtadresse sowie optionale interne Kennung und Notiz vor. Der konsolidierte API-Vertrag kennt beim Anlegen und Ändern nur den Projektnamen.
2. **Lebenszyklus:** DB-Design und UX kennen `ACTIVE`, `INACTIVE` und `ARCHIVED` (archiviert = read-only). Der API-Vertrag kennt nur `ACTIVE` und `INACTIVE`.
3. **Namens-Eindeutigkeit:** Das DB-Design schließt eine Eindeutigkeit des Namens ausdrücklich aus. Validierungs- und Fehlervertrag verlangen einen je Unternehmen eindeutigen Namen (`409 PROJECT_NAME_ALREADY_EXISTS`).

Ohne Entscheidung ist SP-08 nicht vertragskonform umsetzbar: Eine Pflichtadresse könnte über die API nie befüllt werden. Damit wäre auch SP-09 blockiert, weil die Zuordnung per Composite-FK auf `projects` verweist.

## Betrachtete Optionen

### Option A — API-v1-Vertrag maßgeblich (gewählt)
- **Vorteile:** Keine neuen DTO-Felder, Statuswerte oder Fehlercodes. Der jüngste freigegebene API-Vertrag bleibt unverändert. Das Schema enthält nur, was die API tatsächlich schreiben kann.
- **Nachteile:** Adresse, interne Kennung und Notiz fehlen im MVP. Das physische DB-Design wird bewusst und dokumentiert unterschritten.
- **Risiken:** Wird die Adresse später Pflicht, ist für Bestandsdaten Add → Backfill → Enforce nötig.

### Option B — DB-/UX-Baseline maßgeblich (verworfen)
- **Vorteil:** Vollständige Projekt-Stammdaten wie in der UX vorgesehen.
- **Nachteil:** Erfordert ein Amendment des API-Vertrags (neue Request-/Response-Felder, ARCHIVED-Übergang). Der vertraglich vorgesehene Code `PROJECT_NAME_ALREADY_EXISTS` bliebe ungenutzt. Das ist mehr Scope bei knappem Zeitbudget.

### Option C — Hybrid: Spalten jetzt nullable anlegen, nicht exponieren (verworfen)
- **Vorteil:** Spätere Exposition ohne neue Spalten.
- **Nachteil:** Ungenutzte Spalten ohne Schreibpfad und mit unklarer Semantik („nullable Pflichtfeld“). Die eigentliche Entscheidung (Pflicht oder nicht) würde nur vertagt.

### Option D — SP-08 weiter blockieren (verworfen)
- **Nachteil:** SP-09 bliebe ohne FK-Ziel und damit ebenfalls blockiert.

## Entscheidung

**Option A ist angenommen.**

- **API v1:** Ein Projekt hat `name` (getrimmt, 2..100 Zeichen, je Unternehmen exakt eindeutig, ohne Groß-/Kleinschreibungs-Normalisierung) und `status` (`ACTIVE` | `INACTIVE`). Neue Projekte starten `ACTIVE`.
- **Datenbank:**
  - `UNIQUE (company_id, name)` und tenant-sicheres `UNIQUE (company_id, id)` als FK-Ziel.
  - Adresse, interne Kennung und Notiz werden nicht angelegt.
- **ARCHIVED:**
  - Der DB-CHECK erlaubt den Wert weiterhin (physisches Design), kein API-v1-Pfad schreibt ihn.
  - Eine gespeicherte ARCHIVED-Zeile gilt als Serverdefekt und schlägt geschlossen fehl (500 ohne Details), statt still sichtbar oder änderbar zu sein.

**Ausschlaggebender Grund:** Das Schema soll genau das abbilden, was der freigegebene API-Vertrag schreiben kann. Keine Pflichtspalte ohne Schreibpfad und keine Felder, Statuswerte oder Codes außerhalb des Vertrags.

## Konsequenzen

**Positiv**
- SP-08 (minimaler Slice) und SP-09 sind umsetzbar, ohne neue Business-Regeln zu erfinden.
- Die Namens-Eindeutigkeit ist zusätzlich zur Anwendungsprüfung auf DB-Ebene race-sicher.

**Negativ / erkaufte Nachteile**
- Die UX-Felder Adresse/interne Kennung/Notiz sind im MVP nicht verfügbar.
- Zwei Projekte mit gleichem Namen (z. B. gleicher Objektname an verschiedenen Orten) sind innerhalb eines Unternehmens nicht möglich.

**Was später teuer wird**
- Eine Pflichtadresse erfordert eine additive Migration mit Backfill.
- Eine Aufhebung der Namens-Eindeutigkeit erfordert das Entfernen des Constraints und eine Anpassung des Fehlervertrags.

## Auswirkung auf Sicherheit und Datenintegrität

Keine Schwächung. Tenant-Kontext bleibt ausschließlich serverseitig, alle Abfragen sind per `company_id` gescoped, fremde IDs liefern dasselbe 404 wie unbekannte. Schreibende Endpunkte erzwingen Origin, Session, CSRF und die Rolle `COMPANY_ADMIN`. Das Audit enthält nur Projektname und Status, keine personenbezogenen Daten.

## Offene Folgepunkte

- **SP-08 bleibt PARTIAL:** Die projektbezogene Schichtkonfiguration (TAG/NACHT-Zeiten) fehlt noch.
- **Internes Amendment:** Die Abweichung ist zusätzlich in den internen Baselines nachzuziehen (DB-Design, UX).
- **Offene UX-Frage:** Ein „Blocking Conflict“ beim Inaktivsetzen trotz zukünftiger Zuordnungen hat keinen API-Code. Bis zu einer Freigabe wird nichts blockiert.

## Nachweis des Verständnisses

- [x] Die Entscheidung ist ohne dieses Dokument erklärbar (Schema = Schreibpfad des freigegebenen Vertrags).
- [x] Die verworfenen Alternativen B, C und D sind mit Begründung benannt.
- [x] Der erkaufte Nachteil (fehlende Adresse, eindeutige Namen) ist bekannt.

## Nachtrag vom 26.10.2026 (Review-Gate, vor dem ersten Merge)

Dieser Nachtrag ändert die Entscheidung nicht. Er macht zwei Folgen ausdrücklich, die im Review aufgefallen sind (Findings F-4 und F-3).

### Geänderte Eindeutigkeitsregel für Projektnamen (F-4)

- **Abweichung:** Das physische DB-Design schließt ein `UNIQUE(name)` ausdrücklich aus. Diese Entscheidung führt stattdessen `UNIQUE (company_id, name)` ein (Constraint `uq_projects__company_name`). Das ist eine bewusste Abweichung vom DB-Design.
- **Grundlage:** Validierungs-, Fehler- und Testvertrag der API verlangen einen je Unternehmen eindeutigen Namen (`409 PROJECT_NAME_ALREADY_EXISTS`). Ohne Adresse ist der Name zudem das einzige fachliche Unterscheidungsmerkmal eines Projekts.
- **Vergleichsregel:** exakt nach dem Trimmen, ohne Groß-/Kleinschreibungs- oder Unicode-Normalisierung. „Objekt Nord“ und „objekt nord“ sind also zwei zulässige Namen. Eine Normalisierung wäre eine neue fachliche Entscheidung.
- **Geltungsbereich:** Die Eindeutigkeit gilt je Unternehmen. In verschiedenen Unternehmen darf derselbe Name vorkommen.

### ARCHIVED als gespeicherter, aber nicht exponierter Status (F-3)

- **Ist-Verhalten:** Kein API-v1-Pfad schreibt `ARCHIVED`. Eine trotzdem gespeicherte Zeile, etwa durch manuelles SQL, eine Migration oder ein späteres Feature, wird als Serverdefekt behandelt und schlägt geschlossen fehl (500 ohne Details).
- **Wirkungsradius:** Betroffen sind nicht nur Detail und Änderung dieses einen Projekts.
  - Die Projektliste schlägt für jede Seite fehl, die die Zeile enthält. Ohne Statusfilter ist das die Standardansicht.
  - Das Zuordnungs-Panel lädt alle Projekte des Unternehmens. Eine einzige archivierte Zeile macht die Monatszuordnung daher für **alle** Projekte des Unternehmens unbenutzbar.
  - Ein Anlegen von Zuordnungen auf ein archiviertes Projekt wird mit `409 PROJECT_INACTIVE` abgewiesen.
  - Vertraulichkeit und Integrität sind nicht betroffen, wohl aber die Verfügbarkeit innerhalb des Tenants.
- **Status:** **Offene Owner-Entscheidung.** Bis zur Freigabe bleibt das Verhalten wie oben beschrieben (keine stille Änderung des Statusvertrags). Die Entscheidungsvorlage mit Optionen und Empfehlung liegt dem Review-Bericht vom 26.10.2026 bei.

### Formell fortzuschreibende interne Baselines

Die internen, nicht öffentlichen Baselines müssen diese Entscheidung nachziehen:

1. **Physisches DB-Design, Tabelle `projects`:**
   - Spalten Adresse, interne Kennung und Notiz sind im MVP nicht angelegt.
   - `UNIQUE (company_id, name)` ersetzt „kein UNIQUE(name)“.
   - `ARCHIVED` ist erlaubt, im MVP aber nicht erreichbar.
2. **Physisches DB-Design, Invarianten-Übersicht:** Projektname je Unternehmen eindeutig (DB-Constraint).
3. **DB-Operations-Gate:** Projekt-Lebenszyklus im MVP ist nur `ACTIVE`/`INACTIVE`.
4. **UX (Projekt anlegen, Stammdaten, Lebenszyklus-Zustände):** Pflichtfeld Adresse und Feld interne Kennung entfallen im MVP; der Zustand „Archiviert“ ist nicht erreichbar.
5. **API-Validierungsvertrag (Projektname):** Hinweis auf den exakten Vergleich ohne Normalisierung.
6. **Nach der F-3-Entscheidung:** je nach gewählter Option API-Vertrag, Fehlervertrag und DB-Design.
