# SecurePlan_Phase_9.4_Security_Assurance_Risk_Management_v1.1_FINAL

> Designquelle: SecurePlan_Phase_9.4_Security_Assurance_Risk_Management_v1.1_FINAL.docx. Markdown-Übertragung vom 07.10.2026; Quellstatus ist keine Implementierungsfreigabe. Bei Konflikten gelten CRs, 8.11 und der G0-Handoff.

SecurePlan

9.4 Security Assurance & Risk Management

Phase 9 - Security Design

| Dokument | 9.4 Security Assurance & Risk Management |
| --- | --- |
| Version / Status | v1.1 - FINAL - APPROVED |
| Projektphase | Phase 9 - Security Design |
| Basis | Phase 2 Requirements v1.1; Phase 3 Scope/MVP v1.1; Amendment v1.2 (CR-01); Phase 4 Systemanalyse v1.1; Phase 8 API Design |
| Zweck | Definiert Security-Verifikation, OWASP-Mapping, Abuse Cases, Risk Register, Test Backlog und das Final Gate fuer MVP und Production. |
| Freigegebene Entscheidungen | SD-01 Server-side Sessions; SD-02 TOTP-MFA fuer Buero/Admin; SD-03 Inaktivitaet 30 Min Admin / 8 Std Mitarbeiter; SD-04 Absolute Session Lifetime 12 Std Admin / 7 Tage Mitarbeiter |

| Assurance-Prinzip |
| --- |
| Security gilt nicht als umgesetzt, weil ein Guard oder Header existiert. Kritische Controls benoetigen negative Tests, nachvollziehbare Evidence und dokumentierte Rest-Risiken. |

## 1. Security Verification Strategy

| Ebene | Ziel | Beispiele |
| --- | --- | --- |
| Unit Tests | Business-/Policy-Regeln isoliert pruefen. | Eligibility, Statusuebergaenge, Permission Policies, Token/Session-Lifecycle. |
| Integration Tests | DB-Constraints, Transactions und Repository/Service-Verhalten. | Atomare Ersatzuebernahme, Session Revoke, Unique Constraints, Rollback. |
| API Security Tests | Endpunkte aus Angreiferperspektive pruefen. | 401/403, IDOR, Mass Assignment, invalid payloads, CSRF, rate limits. |
| E2E Tests | Kritische Rollen- und Workflow-Grenzen. | Admin publish -> Mitarbeiter sieht nur eigenen Plan -> Absage -> Ersatz -> Entscheidung. |
| Dependency/Build Checks | Supply-Chain-Risiko begrenzen. | Lockfile install, vulnerability scan, build/lint/test in CI. |
| Manual Review | Fehlkonfigurationen und Design-Gaps erkennen. | Cookie flags, Headers, CORS, Swagger exposure, Secrets, Error leakage. |

## 2. Kritische Abuse Cases

| ID | Abuse Case | Erwartetes Systemverhalten |
| --- | --- | --- |
| ABU-01 | Mitarbeiter ruft fremden Plan ueber manipulierte ID auf. | Zugriff serverseitig verweigert; keine fremden Daten im Response. |
| ABU-02 | Mitarbeiter sendet role=ADMIN oder fremde ownerId im JSON Body. | Unknown/forbidden property -> 400; Identitaet ausschliesslich aus Session/Policy. |
| ABU-03 | Angreifer wiederholt Login mit vielen Passwoertern. | Rate Limit/progressive Verzoegerung; neutrale Fehlermeldung; kein Enumeration Leak. |
| ABU-04 | Cross-site Formular versucht Absage zu erzeugen. | Request ohne gueltigen CSRF/Origin-Schutz wird abgelehnt. |
| ABU-05 | Dasselbe Absage-Request wird mehrfach schnell gesendet. | Genau ein fachlicher Vorgang; keine Duplikate. |
| ABU-06 | Admin waehlt Ersatz, waehrend Plan zwischenzeitlich geaendert wurde. | Aktueller Business-State wird revalidiert; ungueltige Auswahl atomar verworfen. |
| ABU-07 | Account wird deaktiviert, Browser besitzt alten Session-Cookie. | Session ist serverseitig widerrufen und liefert 401. |
| ABU-08 | Fehler provoziert DB Exception. | Client erhaelt sicheres RFC-9457-Problem ohne Stack Trace/SQL/Secret. |
| ABU-09 | Reset-Link wird nach erfolgreicher Nutzung erneut aufgerufen. | Replay wird abgelehnt; token hash ist used/expired. |
| ABU-10 | Benutzer sendet HTML/Script in textuelles Feld. | Inhalt wird als Text gerendert; keine Script-Ausfuehrung. |

## 3. OWASP Top 10:2025 Mapping

| OWASP 2025 | SecurePlan-Relevanz | Hauptkontrollen |
| --- | --- | --- |
| A01 Broken Access Control | Sehr hoch | Serverseitige Role + Ownership Policies; IDOR-Tests; Default Deny. |
| A02 Security Misconfiguration | Hoch | Environment-basierte sichere Defaults; CORS/CSP/Headers; kein offenes Swagger ohne Entscheidung. |
| A03 Software Supply Chain Failures | Mittel/Hoch | Lockfile, Dependency Scan, kontrollierte Updates, reproduzierbarer CI-Build. |
| A04 Cryptographic Failures | Hoch | Argon2id; TLS; sichere Tokens; geschuetzte TOTP-Secrets/Recovery Codes. |
| A05 Injection | Hoch | DTO-Allowlist/Validation; parametrisierte DB-Zugriffe; keine dynamischen Query-Fragmente. |
| A06 Insecure Design | Hoch | Threat Model, Trust Boundaries, Business-State-Revalidation, Security-by-Design. |
| A07 Authentication Failures | Hoch | Server-side Sessions, Admin-MFA, Login Abuse Protection, sichere Reset/Activation Flows. |
| A08 Software or Data Integrity Failures | Hoch | Transaktionen, Migrationen/Constraints, Idempotenz, kontrollierte Dependencies/CI. |
| A09 Security Logging and Alerting Failures | Mittel/Hoch | Audit/Application-Log-Trennung; security-relevante Events; Production Monitoring spaeter. |
| A10 Mishandling of Exceptional Conditions | Hoch | RFC 9457, Fail Closed, Rollback, sichere Exception-Behandlung, keine Teilzustaende. |

## 4. Risk Rating Methodology

Das Risk Register verwendet eine qualitative 3-stufige Bewertung. Sie dient der Priorisierung im Praktikum und ist keine formale quantitative Risikoberechnung.

| Dimension | Low | Medium / High |
| --- | --- | --- |
| Likelihood | Unwahrscheinlicher Pfad; erfordert besondere Voraussetzungen. | Medium: plausibler Angriffspfad. High: realistisch/erwartbar bei Internet-Exposure oder haeufigem Fehlgebrauch. |
| Impact | Begrenzte Auswirkung ohne sensible Fremddaten oder kritische Business-State-Aenderung. | Medium: spuerbarer Benutzer-/Betriebseffekt. High: Account-Kompromittierung, unbefugte Datenoffenlegung oder Korruption des verbindlichen Plans. |
| Residual Risk | Nach Kontrollen verbleibendes Risiko wird erneut qualitativ bewertet. | Critical/High residual risks im MVP-Kern blockieren das Release. |

## 5. Risk Register

| ID | Risk | L | I | Mitigation | Residual |
| --- | --- | --- | --- | --- | --- |
| R-01 | Broken Access Control / IDOR | High | High | Resource-Level Policies + negative API/E2E tests. | Low/Med |
| R-02 | Admin Account Compromise | Med | High | TOTP-MFA, strong passwords, short admin inactivity, audit. | Low/Med |
| R-03 | Session Theft | Med | High | TLS, Secure/HttpOnly cookie, hashed store token, rotation, revoke, timeouts. | Low/Med |
| R-04 | Credential Stuffing / Brute Force | High | Med/High | Rate limiting, breached-password check, neutral errors, Admin-MFA. | Med |
| R-05 | Injection / Mass Assignment | Med | High | DTO allowlist, unknown props -> 400, validation, parameterized DB access. | Low |
| R-06 | CSRF on state-changing actions | Med | High | SameSite + CSRF token + Origin check. | Low |
| R-07 | Race Condition / stale decision | Med | High | DB transaction, current-state revalidation, constraints/locking. | Low/Med |
| R-08 | Sensitive data in logs/errors | Med | High | Safe errors, log allowlist/redaction, tests/review. | Low |
| R-09 | Dependency vulnerability | Med | Med/High | Lockfile, CI scan, controlled upgrade policy. | Med |
| R-10 | Production misconfiguration | Med | High | Deployment checklist, HTTPS/HSTS, CORS/secret checks, staging validation. | Med |
| R-11 | Reset/MFA token replay | Med | High | Hashed one-time reset tokens, expiry/usedAt, TOTP replay protection, rate limiting. | Low |
| R-12 | Stored/Reflected XSS | Med | Med/High | Text rendering by default, no untrusted raw HTML, CSP, sanitization if rich HTML added. | Low |

## 6. MVP Security Gate

| Gate | PASS-Kriterium |
| --- | --- |
| Authentication | Passwoerter sicher gehasht; Sessions serverseitig; Login/Logout/Deaktivierung korrekt; keine Secrets in Logs. |
| Authorization | Alle MVP-Ressourcen serverseitig geschuetzt; IDOR-/Privilege-Escalation-Negativtests vorhanden. |
| Input/API | DTO-Validation mit unknown props -> 400; Allowlist; RFC 9457; keine Stack Traces/DB-Interna. |
| Browser Security | HTTPS fuer externe Staging/Production, sichere Cookie-Flags, CSRF/CORS bewusst konfiguriert. |
| Business Integrity | Kritische Absage/Ersatz-Aenderungen transaktional; idempotente Kernaktionen; stale-state Revalidation. |
| Audit | Kritische MVP-Aktionen nachvollziehbar; normaler Mitarbeiter hat keinen zentralen Audit-Zugriff. |
| CI | Build/Lint/Test automatisiert; Dependency Findings vor Release bewertet. |
| Known Risks | Offene Risiken dokumentiert; keine bekannte Critical/High Security- oder Datenintegritaetsluecke im MVP-Kern. |

## 7. Production Security Gates

| Bereich | Vor Production verpflichtend |
| --- | --- |
| MFA | TOTP-MFA fuer alle Buero/Admin-Accounts vollstaendig aktiviert; Recovery-/Reset-Prozess getestet. |
| HTTPS/Headers | TLS/HSTS und Security Headers gegen reale Deployment-Konfiguration verifiziert. |
| Retention/Privacy | Datenkategoriespezifisches Aufbewahrungs- und Loeschkonzept dokumentiert und technisch beruecksichtigt. |
| Secrets | Production Secret Store, Rotation und getrennte Credentials etabliert. |
| Monitoring/Alerting | Security-/Error-Monitoring, Health Checks und Alerts eingerichtet, ohne sensitive Daten offenzulegen. |
| Backup/Restore | Backup und Restore praktisch getestet; RPO/RTO-Ziele operationalisiert. |
| Security Review | Erneute Threat-/Risk-Review gegen tatsaechliche Deployment-Architektur und externe Exposure. |

## 8. Security Test Backlog fuer Implementation

| ID | Testziel |
| --- | --- |
| TEST-SEC-01 | 401 ohne Session auf jedem geschuetzten MVP-Endpunkt. |
| TEST-SEC-02 | 403/404 bei fremder Ressource und bei Admin-Aktion durch Mitarbeiter. |
| TEST-SEC-03 | Mass-Assignment-Versuch mit role/status/ownerId oder unbekannter Property -> 400. |
| TEST-SEC-04 | Account-Deaktivierung invalidiert alle Sessions. |
| TEST-SEC-05 | CSRF-negative Tests fuer alle state-changing Browser-Endpunkte. |
| TEST-SEC-06 | Rate-Limit/Abuse-Test auf Login, Password Reset und MFA Challenge. |
| TEST-SEC-07 | Duplicate Absence / Duplicate Replacement Offer erzeugt keinen zweiten fachlichen Vorgang. |
| TEST-SEC-08 | Fehlerantworten enthalten correlationId, aber keinen Stack Trace, SQL oder Secret. |
| TEST-SEC-09 | Atomare Ersatzuebernahme rollt vollstaendig zurueck, wenn ein Teilschritt fehlschlaegt. |
| TEST-SEC-10 | Audit-Events fuer Publish, Admin-Entscheidung, Ersatz-Auswahl, Mitarbeiter-ID-Aenderung und Deaktivierung. |
| TEST-SEC-11 | Activation-/Reset-Token expired oder bereits used -> Request wird abgelehnt. |
| TEST-SEC-12 | Session Fixation: Session-ID wird nach Login und MFA/Privilege-Uebergang rotiert; alte ID ungueltig. |
| TEST-SEC-13 | TOTP-Code / Recovery Code Replay -> zweite Verwendung wird abgelehnt. |
| TEST-SEC-14 | Neue, noch nicht verifizierte E-Mail wird nicht als Security-E-Mail aktiv. |
| TEST-SEC-15 | Untrusted HTML/Script in Textfeld wird als Text gerendert; keine Script-Ausfuehrung. |

## 9. Final Gate Status

| PHASE 9 - FINAL GATE |
| --- |
| APPROVED. Die vier Security-Design-Dokumente sind konsistent mit den eingefrorenen Baselines und den freigegebenen Security Decisions. Es bestehen keine offenen blockierenden Design-Fragen fuer den Praktikums-MVP. Production-spezifische Gates bleiben bewusst als spaetere Freigabekriterien dokumentiert. |

### Quellen und Traceability

| Quelle | Relevanz |
| --- | --- |
| Phase 2 Requirements Baseline v1.1 | Security, Privacy, Audit, Error Handling, Reliability und Residual Risk. |
| Phase 3 Scope & MVP v1.1 | Security/Data-Integrity Guardrails; MFA als Stretch; Production Gates getrennt. |
| Baseline Amendment v1.2 (CR-01) | Authorization, Audit, Idempotenz und Datenintegritaet bleiben unveraendert. |
| Phase 8 API Design | RFC 9457 Problem Details. |
| OWASP Top 10:2025 | Referenz fuer Risk Mapping. |
| OWASP Password Storage Cheat Sheet | Referenz fuer Argon2id Password Storage. |
