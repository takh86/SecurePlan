# Phase 8.1 – API Resource Analysis

**Status:** v0.1 WORKING DRAFT; Resource Identification Complete, Endpoint Design noch nicht begonnen.\
**Quelle:** [Arbeitsdokument](../sources/phase-8/SecurePlan_Phase_8.1_API_Resource_Analysis_v0.1.docx).

**Baseline-Review offen:** Die Quelle nennt Phase 4 v1.1 und CR-01. Vor Phase 8.2 muss sie gegen Phase 4 FINAL v1.2, CR-02, CR-03 sowie die Final-Gates 6.11 und 7.3 geprüft werden. Dieses Dokument genehmigt keine neuen API-Contracts.

Die folgende Markdown-Fassung überträgt den Text und die Tabellen des Arbeitsdokuments.

SecurePlan

Phase 8 – API Design

8.1 Resource Identification & Use-Case Mapping

| Dokument | SecurePlan – Phase 8.1 API Resource Analysis |
| --- | --- |
| Version | v0.1 – Working Draft |
| Basis | Phase 4 Systemanalyse v1.1 + gültige Requirements-/MVP-Baselines + CR-01 |
| Zweck | Ableitung von API-Resource-Kandidaten aus den 17 MVP-Use-Cases |
| Status | RESOURCE IDENTIFICATION COMPLETE – API ENDPOINT DESIGN NOT YET STARTED |
| Nächster Schritt | Phase 8.2 – REST Endpoint Design |

Hinweis: Dieses Dokument definiert noch keine finalen URLs, HTTP-Methoden oder DTOs.

## 1. Ziel der Resource-Analyse

Die Resource-Analyse übersetzt die fachlichen Use Cases aus Phase 4 in eine API-orientierte Sicht. Dabei wird bewusst noch nicht entschieden, wie konkrete REST-Endpunkte aussehen. Zuerst wird geklärt, welche fachlichen oder technischen Objekte im System eine stabile Identität, Daten und einen eigenen Lebenszyklus besitzen.

- Use Case = was ein Akteur erreichen möchte.

- Resource = fachliches oder technisches Objekt, auf das die API zugreift.

- Action = Zustandsänderung auf einer Resource, z. B. veröffentlichen, zurückziehen oder auswählen.

- Read Model = für eine Ansicht berechnete oder zusammengestellte Darstellung; nicht zwingend persistierte Resource.

- Actor = Nutzerrolle, die eine Aktion ausführt; z. B. Büro/Admin ist nicht automatisch eine API-Resource.

## 2. Entscheidungsregeln

| ID | Regel |
| --- | --- |
| R1 | Ein Substantiv ist nur dann ein Resource-Kandidat, wenn es im System fachlich/technisch eigenständig relevant ist. |
| R2 | Verben wie veröffentlichen, prüfen, entscheiden, zurückziehen oder auswählen sind Actions und keine Resources. |
| R3 | Eine UI-Seite ist nicht automatisch eine Resource. Work Queue und Statistik können Read Models sein. |
| R4 | Core Resources werden im Use Case unmittelbar gelesen oder verändert; Related Resources liefern Kontext oder Regeln. |
| R5 | CR-01 bleibt verbindlich: Es gibt kein festes Kontingent von drei Ersatzübernahmen pro Mitarbeiter und Monat. |

## 3. Vollständiges Use-Case-to-Resource Mapping

Die folgende Matrix vervollständigt die Resource-Identifikation für alle 17 MVP-Use-Cases. Die Einordnung ist ein API-Design-Arbeitsstand und wird in Phase 8.2 gegen konkrete Endpoints und DTOs geprüft.

| UC | Use Case | Core Resource(s) | Related | Einordnung | Action / API-Sicht |
| --- | --- | --- | --- | --- | --- |
| UC-01 | Anmelden | Session / Benutzerkonto | Mitarbeiter, Büro/Admin-Kontext | Technischer Auth-Resource-Kandidat | Session erzeugen |
| UC-02 | Abmelden | Session | Benutzerkonto | Technischer Auth-Resource-Kandidat | Session beenden |
| UC-03 | Monatsplan erstellen | Monatsplan | Projekt, Projektzuordnung, Mitarbeiter, Dienst | Business Resource | Entwurf erstellen |
| UC-04 | Monatsplan bearbeiten | Monatsplan | Projekt, Mitarbeiter, Dienst | Business Resource | Planinhalt ändern |
| UC-05 | Monatsplan veröffentlichen | Monatsplan | Projekt, Mitarbeiter, Dienst | Business Resource | Publish / Statusübergang |
| UC-06 | Eigenen Monatsplan anzeigen | Monatsplan | Mitarbeiter, Dienst | Read-orientierte Sicht auf Business Resources | Nur eigene veröffentlichte Dienste lesen |
| UC-07 | Absageantrag erstellen | Absageantrag | Mitarbeiter, Dienst, Monatsplan, Ersatzbedarf | Business Resource | Absage anlegen; Ersatzbedarf automatisch erzeugen |
| UC-08 | Absageantrag zurückziehen | Absageantrag | Mitarbeiter, Dienst, Ersatzbedarf, Ersatzangebot | Business Resource | Zurückziehen; Ersatzbedarf schließen |
| UC-09 | Absageanträge prüfen und entscheiden | Absageantrag | Mitarbeiter, Dienst, Monatsplan, Ersatzbedarf | Business Resource | Genehmigen / ablehnen / gegenstandslos |
| UC-10 | Ersatzangebot abgeben | Ersatzangebot | Ersatzbedarf, Mitarbeiter, Dienst, Monatsplan | Business Resource | Angebot erzeugen |
| UC-11 | Ersatzangebote prüfen | Ersatzbedarf, Ersatzangebot | Mitarbeiter, Dienst, Monatsplan | Business Resources | Gültigkeit prüfen; noch keine Auswahl |
| UC-12 | Ersatzmitarbeiter auswählen | Ersatzbedarf, Ersatzangebot | Absageantrag, Mitarbeiter, Dienst, Monatsplan | Business Resources | Auswahl + atomare Planänderung |
| UC-13 | Antragsstatus anzeigen | Absageantrag, Ersatzangebot | Mitarbeiter, Ersatzbedarf | Read Model auf Business Resources | Eigene Vorgänge und Status lesen |
| UC-14 | Offene Absage-/Ersatzvorgänge anzeigen | Absageantrag, Ersatzbedarf, Ersatzangebot | Mitarbeiter, Dienst, Monatsplan | Read Model: Admin Work Queue | Offene Vorgänge aggregiert anzeigen |
| UC-15 | Mitarbeiter verwalten | Mitarbeiter | – | Business Resource | Anlegen / bearbeiten / deaktivieren |
| UC-16 | Projekte und Projektzuordnungen verwalten | Projekt, Projektzuordnung | Mitarbeiter, Kalendermonat | Business Resources | Projekt pflegen / Monatszuordnung verwalten |
| UC-17 | Eigene planbasierte Statistik anzeigen | Monatsplan | Mitarbeiter, Dienst | Read Model: planbasierte Statistik | Aus veröffentlichtem Plan berechnen |

## 4. Konsolidierter Candidate Resource Catalog

| Resource | Typ | Verantwortung / Bedeutung | Use Cases |
| --- | --- | --- | --- |
| Mitarbeiter | Business | Mitarbeiter-Stammdaten und Status | UC-03/04/05/06/07/08/09/10/11/12/13/14/15/16/17 |
| Projekt | Business | Einsatzobjekt/Projekt der Planung | UC-03/04/05/16 |
| Projektzuordnung | Business | Monatsbezogene Zuordnung Mitarbeiter → Projekt | UC-03/16 |
| Monatsplan | Business | Plan für Projekt + Kalendermonat; Published State ist Source of Truth | UC-03/04/05/06/07/09/10/11/12/14/17 |
| Dienst | Business | Konkreter geplanter Einsatz an Datum + Schicht | UC-03/04/05/06/07/08/09/10/11/12/14/17 |
| Absageantrag | Business | Antrag eines Mitarbeiters, einen eigenen Dienst abzusagen | UC-07/08/09/12/13/14 |
| Ersatzbedarf | Business | Offener Bedarf, der aus gültiger Absage entsteht | UC-07/08/09/10/11/12/13/14 |
| Ersatzangebot | Business | Angebot eines geeigneten Mitarbeiters für Ersatzbedarf | UC-08/10/11/12/13/14 |
| Benutzerkonto | Technical/Auth | Authentifizierungs- und Account-Kontext | UC-01/02 |
| Session | Technical/Auth | Authentifizierte Sitzung | UC-01/02 |

## 5. Read Models / Views – keine eigenständigen Domain Resources

| Read Model | Use Case | Ableitung |
| --- | --- | --- |
| Persönliche Monatsplanansicht | UC-06 | Gefilterte Sicht auf veröffentlichten Monatsplan und eigene Dienste. |
| Eigene Antrags-/Angebotsübersicht | UC-13 | Zusammengestellte Sicht auf eigene Absageanträge und Ersatzangebote inklusive Status. |
| Admin Work Queue | UC-14 | Aggregierte Sicht auf offene Absageanträge, Ersatzbedarfe und Ersatzangebote. |
| Planbasierte Statistik | UC-17 | Berechnung aus aktuellem Monatsplan; keine Arbeitszeiterfassung und nicht zwingend persistent. |

## 6. Actions – ausdrücklich keine Resources

| Action | Warum keine Resource? |
| --- | --- |
| Anmelden / Abmelden | Erzeugen bzw. Beenden einer Session. |
| Monatsplan veröffentlichen | Statusübergang des Monatsplans nach Revalidierung. |
| Absage zurückziehen | Statusübergang des Absageantrags mit Folgeeffekt auf Ersatzbedarf. |
| Absage genehmigen / ablehnen | Entscheidung auf einem bestehenden Absageantrag. |
| Ersatzmitarbeiter auswählen | Auswahl eines gültigen Ersatzangebots und atomare Planänderung. |

## 7. Tech-Lead Review

Ergebnis Phase 8.1: Die Resource-Identifikation ist als Arbeitsgrundlage ausreichend. Die zentralen Business Resources sind von Actions, Actors und Read Models getrennt. Besonders wichtig ist, dass Admin Work Queue und Statistik nicht voreilig als persistente Domain Entities modelliert werden.

- Kein REST-Endpoint wird allein aus dem Namen eines Use Cases abgeleitet.

- In Phase 8.2 wird für jede Resource entschieden: Collection, Einzelresource, Subresource oder explizite Domain Action.

- Authorization wird serverseitig pro Endpoint/Resource geprüft.

- Atomare Geschäftsoperationen wie Ersatz-Auswahl werden nicht in mehrere unsichere Client-Schritte zerlegt.

- CR-01 bleibt wirksam; kein API-Contract darf das entfernte 3er-Ersatzlimit wieder einführen.

## 8. Nächster Schritt – Phase 8.2

Als Nächstes werden aus diesem Katalog konkrete REST-Endpunkte abgeleitet. Dabei werden nacheinander URI-Struktur, HTTP-Methode, Request/Response DTOs, Statuscodes, Authorization, Validation und Error Model definiert. Erst danach beginnt die OpenAPI-/Swagger-Spezifikation.

## 9. Dokumentbasis

- SecurePlan – Phase 4 Systemanalyse v1.1 Professional Revision

- SecurePlan – Phase 2 Requirements Baseline v1.1 FINAL

- SecurePlan – Phase 3 Scope & MVP Baseline v1.1 FINAL

- SecurePlan – Baseline Amendment v1.2 (CR-01)
