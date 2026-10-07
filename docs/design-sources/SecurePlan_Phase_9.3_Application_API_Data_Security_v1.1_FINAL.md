# SecurePlan_Phase_9.3_Application_API_Data_Security_v1.1_FINAL

> Designquelle: SecurePlan_Phase_9.3_Application_API_Data_Security_v1.1_FINAL.docx. Markdown-Übertragung vom 07.10.2026; Quellstatus ist keine Implementierungsfreigabe. Bei Konflikten gelten CRs, 8.11 und der G0-Handoff.

SecurePlan

9.3 Application, API & Data Security

Phase 9 - Security Design

| Dokument | 9.3 Application, API & Data Security |
| --- | --- |
| Version / Status | v1.1 - FINAL - APPROVED |
| Projektphase | Phase 9 - Security Design |
| Basis | Phase 2 Requirements v1.1; Phase 3 Scope/MVP v1.1; Amendment v1.2 (CR-01); Phase 4 Systemanalyse v1.1; Phase 8 API Design |
| Zweck | Definiert Schutzmassnahmen fuer API, Browser-Sicherheit, Datenverarbeitung, Secrets, Logging, Output Handling und geschaeftskritische Transaktionen. |
| Freigegebene Entscheidungen | SD-01 Server-side Sessions; SD-02 TOTP-MFA fuer Buero/Admin; SD-03 Inaktivitaet 30 Min Admin / 8 Std Mitarbeiter; SD-04 Absolute Session Lifetime 12 Std Admin / 7 Tage Mitarbeiter |

| Leitentscheidung |
| --- |
| Frontend-Validierung dient der UX. Sicherheits- und Business-Invarianten werden ausschliesslich serverseitig autorisiert, validiert und - wenn zusammengehoerig - transaktional gespeichert. |

## 1. API Input Security

| Bereich | Design |
| --- | --- |
| DTO Validation | Jeder schreibende Endpoint verwendet explizite Request DTOs. Unbekannte Properties werden nicht still ignoriert, sondern mit 400 VALIDATION_FAILED abgelehnt. |
| Allowlist statt Mass Assignment | Nur explizit freigegebene Felder werden in Domain-Objekte uebernommen; role, ownerId, status, audit fields etc. niemals blind aus Request Bodies. |
| Type/Format Checks | UUID/ID, E-Mail, Datum, Enum, Stringlaenge und fachliche Grenzen werden serverseitig validiert. |
| Business Validation | Eligibility, Projektzuordnung, Planstatus und zulaessige Statusuebergaenge werden nach DTO-Validation erneut fachlich geprueft. |
| Database Access | Parametrisierte Queries/ORM-Mechanismen; keine String-Konkatenation fuer untrusted Input. |
| Pagination/Filtering | Feste Grenzen fuer page size, sort fields und Filter; keine beliebigen Feldnamen oder dynamischen SQL-Fragmente vom Client. |

## 2. API Error Security

SecurePlan verwendet RFC 9457 Problem Details als kanonisches API-Fehlerformat. Erweiterungen sind stable code, correlationId und optional errors[].

| Regel | Umsetzung |
| --- | --- |
| Keine Interna | Keine Stack Traces, SQL/DB-Details, Secrets oder internen Dateipfade in Client-Responses. |
| Stable Codes | Clients reagieren auf stabile machine-readable codes; sichtbare Texte bleiben sicher und verstaendlich. |
| Correlation ID | Jeder relevante Request erhaelt eine correlationId; sie enthaelt keine sensitiven Informationen. |
| Validation Errors | Feldfehler duerfen Feldname, stabilen Code und sichere Message enthalten; niemals Server-Interna. |
| Exceptional Conditions | Teiltransaktionen werden zurueckgerollt; unerwartete Fehler werden zentral technisch erfasst. |

## 3. Browser & Transport Security

| Control | SecurePlan Baseline |
| --- | --- |
| HTTPS | Production ausschliesslich HTTPS; HTTP wird auf HTTPS umgeleitet. |
| Cookie | Secure + HttpOnly + SameSite=Lax; kein Auth-Token im LocalStorage. |
| CSRF | Fuer POST/PUT/PATCH/DELETE: Anti-CSRF-Token + Origin/Referer-Pruefung; SameSite ist zusaetzliche Schicht, nicht alleiniger Schutz. |
| CORS | Production-Allowlist nur fuer definierte Frontend-Origin; credentials=true nur mit expliziter Origin; niemals wildcard + credentials. |
| CSP | default-src self; object-src none; base-uri none; frame-ancestors none; form-action self; weitere Direktiven minimal nach Build-Bedarf. |
| Security Headers | HSTS in Production; nosniff; Referrer-Policy; Permissions-Policy; Clickjacking-Schutz primaer ueber CSP frame-ancestors. |
| Swagger/OpenAPI | Development/Staging kontrolliert verfuegbar; Production nur nach bewusster Freigabe, nicht automatisch oeffentlich. |

## 4. Output Handling & XSS Prevention

User-controlled text wird standardmaessig als Text gerendert, nicht als HTML.

dangerouslySetInnerHTML oder vergleichbare APIs duerfen keine untrusted Inhalte erhalten.

Falls spaeter Rich-HTML fachlich notwendig wird, ist eine explizite Sanitization mit allowlist-basierter Policy verpflichtend.

CSP ist Defense in Depth und ersetzt kein sicheres Output Encoding / Rendering.

## 5. Secrets & Environment Configuration

.env-Dateien mit echten Secrets werden nicht committed; Repository enthaelt nur .env.example ohne Geheimnisse.

Database credentials, session/crypto keys und externe Provider-Secrets sind je Environment getrennt.

Production nutzt Plattform-Secrets/Secret Store; Rotation muss ohne Codeaenderung moeglich sein.

Default-Werte fuer sicherheitskritische Secrets sind unzulaessig; fehlende Secrets fuehren beim Start zu Fail-Fast.

Application Logs geben nie komplette Environment-Konfiguration aus.

## 6. Data & Privacy Security

| Datenklasse | MVP-Regel | Schutz |
| --- | --- | --- |
| Account/E-Mail | Nur notwendige Identitaetsdaten. | Authorization; eindeutige E-Mail; keine oeffentliche Enumeration; pendingEmail bis Verifikation. |
| KRANK | Ausschliesslich Datum + Status KRANK; keine Diagnose, Symptome oder medizinische Freitexte. | Datensparsamkeit; kein Freitextfeld; restriktive Anzeige. |
| Monatsplan | Persoenlicher Plan nur fuer betroffenen Mitarbeiter; Admin verwaltet Gesamtplan. | Resource-Level Authorization; serverseitige Filterung; Integritaets-Constraints. |
| Absage/Ersatz | Eigene Vorgaenge fuer Mitarbeiter; administrativ relevante Vorgaenge fuer Buero/Admin. | Ownership/Role Checks; Status-Machine; Revalidation vor Entscheidung. |
| Audit | Nur Buero/Admin; keine Passwoerter, Tokens oder PDF-Inhalte. | Append-orientierte Speicherung; keine normalen Edit/Delete-Endpunkte. |

## 7. Audit & Application Logging

Fachlicher Audit Log und technisches Application Logging werden konzeptionell getrennt. Audit beantwortet "wer hat was wann geaendert?", Application Logs beantworten "was ist technisch passiert?"

| Event | Audit? | Technisches Log? | Hinweis |
| --- | --- | --- | --- |
| Mitarbeiter-ID geaendert | Ja | Ja | Old/New Value ohne unnoetige PII. |
| Monatsplan veroeffentlicht | Ja | Ja | Actor, Plan/Projekt/Monat, Zeitpunkt, Version/State. |
| Absage entschieden | Ja | Ja | Entscheidung und relevante Resource-IDs. |
| Ersatz ausgewaehlt | Ja | Ja | Ausgewaehlter Ersatz + atomare Planänderung nachvollziehbar. |
| Account deaktiviert | Ja | Ja | Inkl. Session-Revoke-Result. |
| Login fehlgeschlagen | Nein als Business Audit | Ja | Keine Passwortwerte; fuer Abuse Detection. |
| Admin MFA reset | Ja | Ja | Security-critical event. |
| Validation 400 | Nein | Optional aggregiert | Keine Payload-Dumps. |

## 8. Transactional & Concurrency Security

Absage + offener Ersatzbedarf werden als zusammengehoeriger fachlicher Vorgang konsistent erzeugt.

Auswahl eines Ersatzmitarbeiters revalidiert unmittelbar vor Commit: Angebot offen, Mitarbeiter weiterhin geeignet/verfuegbar, Ersatzbedarf noch offen.

Entfernen des absagenden Mitarbeiters und Einplanen des Ersatzmitarbeiters erfolgen in einer Datenbanktransaktion; bei Fehler keine Teilaenderung.

Wiederholte identische Requests duerfen keine doppelten Absagen, Ersatzangebote oder Veroeffentlichungen erzeugen.

Planänderungen, die offene Vorgaenge ungueltig machen, fuehren zu definierten Statusuebergaengen (z. B. GEGENSTANDSLOS) statt zu inkonsistenten Restzustaenden.

## 9. Supply Chain & Build Security

| Kontrolle | MVP-Umsetzung |
| --- | --- |
| Lockfile | package-lock.json ist versioniert; CI verwendet reproduzierbare Installation. |
| Dependency Review | Automatischer Dependency-/Vulnerability-Scan in CI; High/Critical Findings werden vor Release bewertet. |
| Updates | Keine automatischen Major-Updates direkt in Production; kontrollierte PRs mit Tests. |
| Build | CI fuehrt Lint, Tests und Build aus; Release-Artefakt entsteht aus nachvollziehbarem Commit. |
| Container | Nur benoetigte Runtime-Komponenten; non-root wo praktikabel; keine Secrets im Image. |

## 10. Nicht im MVP, aber sicherheitsseitig vorbereitet

| Capability | Security-Folge |
| --- | --- |
| Lohnabrechnungen | Eigenes Post-MVP Security/Privacy Vertical: authentifizierter Download, PDF-Validation, private Storage URLs, Retention. |
| Tagesplan / Schichtleiter | Temporäre Berechtigung muss dienstbezogen aus veroeffentlichtem Plan abgeleitet werden; kein permanenter Role Flag. |
| Multi-Company | companyId wird bei spaeterer Einfuehrung zusaetzliche harte Authorization Boundary und DB-Invariante. |

| 9.3 Gate |
| --- |
| APPROVED. API, Browser, Output/XSS, Secrets, Privacy, Logging sowie transaktionale Integritaet sind fuer den MVP konsistent und implementierbar definiert. |

### Quellen und Traceability

| Quelle | Relevanz |
| --- | --- |
| Phase 2 Requirements Baseline v1.1 | SEC-AUTHZ, SEC-TRANSPORT/LOG, PRIV-*, FR/BR-AUD, NFR-ERR/REL. |
| Phase 3 Scope & MVP v1.1 | M8 Qualitaetsminimum, M9 Environment/Secrets-Trennung und HTTPS bei externer Bereitstellung. |
| Baseline Amendment v1.2 (CR-01) | Authorization, Audit, Idempotenz und Datenintegritaet bleiben unveraendert. |
| Phase 8 API Design | RFC 9457 Problem Details mit stable code, correlationId und optional errors[]. |
