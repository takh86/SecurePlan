# SecurePlan_Phase_9.1_Threat_Model_Security_Architecture_v1.1_FINAL

> Designquelle: SecurePlan_Phase_9.1_Threat_Model_Security_Architecture_v1.1_FINAL.docx. Markdown-Übertragung vom 07.10.2026; Quellstatus ist keine Implementierungsfreigabe. Bei Konflikten gelten CRs, 8.11 und der G0-Handoff.

SecurePlan

9.1 Threat Model & Security Architecture

Phase 9 - Security Design

| Dokument | 9.1 Threat Model & Security Architecture |
| --- | --- |
| Version / Status | v1.1 - FINAL - APPROVED |
| Projektphase | Phase 9 - Security Design |
| Basis | Phase 2 Requirements v1.1; Phase 3 Scope/MVP v1.1; Amendment v1.2 (CR-01); Phase 4 Systemanalyse v1.1; Phase 8 API Design |
| Zweck | Definiert Schutzgueter, Trust Boundaries, Angreiferprofile, priorisierte Bedrohungen und Sicherheitsprinzipien des Praktikums-MVP. |
| Freigegebene Entscheidungen | SD-01 Server-side Sessions; SD-02 TOTP-MFA fuer Buero/Admin; SD-03 Inaktivitaet 30 Min Admin / 8 Std Mitarbeiter; SD-04 Absolute Session Lifetime 12 Std Admin / 7 Tage Mitarbeiter |

| Design-Gate 9.1 |
| --- |
| SecurePlan wird als internetfaehige, rollenbasierte Webanwendung betrachtet. Hauptziel ist der Schutz von Identitaet, Berechtigungen, Planintegritaet und personenbezogenen Daten. Production-Hardening wird klar vom 12-Wochen-MVP getrennt. |

## 1. Security Context

SecurePlan verarbeitet personenbezogene Mitarbeiterdaten und geschaeftskritische Planungszustaende. Der veroeffentlichte Monatsplan ist fachlich die Source of Truth; Absage- und Ersatzentscheidungen veraendern diesen Zustand. Deshalb sind insbesondere Zugriffskontrolle und Integritaet sicherheitskritisch.

MVP-Akteure: Buero/Admin und Mitarbeiter. Die Schichtleiter-Funktion gehoert zum spaeteren Tagesplan-Vertical und ist keine permanente Account-Rolle.

MVP-Kern: Authentifizierung, Mitarbeiter/Projekte, Monatsplan, Absage/Ersatz, Admin Work Queue und planbasierte Statistik.

Out of Scope im Praktikums-MVP: Tagesplan, Lohnabrechnungen, vollstaendige Notification-Matrix, GPS/WKS, KI und umfassende Production-Operations.

## 2. Schutzgueter (Assets)

| Asset | C | I | A | Security-Relevanz |
| --- | --- | --- | --- | --- |
| Zugangsdaten / Passwort-Hashes | High | High | Medium | Kompromittierung ermoeglicht Account-Uebernahme. |
| Server-side Sessions | High | High | High | Gestohlene oder nicht widerrufene Sessions umgehen die primaere Authentifizierung. |
| Admin-MFA Secrets / Recovery Codes | High | High | Medium | Schuetzen privilegierte Admin-Zugaenge; Recovery Codes sind Einmal-Geheimnisse. |
| Mitarbeiter-Stammdaten | High | High | Medium | Personenbezogene Daten; unbefugte Einsicht oder Manipulation muss verhindert werden. |
| Monatsplan / Publish-State | Medium | High | High | Fachliche Source of Truth. Falsche Aenderungen beeinflussen Dienstplanung und Folgeprozesse. |
| Absage- und Ersatzvorgaenge | Medium | High | High | Status und Entscheidungen muessen konsistent, autorisiert und nachvollziehbar bleiben. |
| Projektzuordnungen / Eligibility | Medium | High | Medium | Fehlerhafte Zuordnung kann unerlaubte Planung oder Ersatzwahl ausloesen. |
| Audit Log | High | High | Medium | Belegt sicherheits- und geschaeftskritische Aktionen; darf nicht normal manipulierbar sein. |
| Secrets / Runtime Credentials | High | High | High | DB-, Crypto- und Deployment-Secrets ermoeglichen weitreichenden Systemzugriff. |
| KRANK-Statusdaten | High | High | Medium | Es wird ausschliesslich Datum + Status KRANK gespeichert; keine Diagnose, Symptome oder medizinische Freitexte. |

## 3. Trust Boundaries & Attack Surface

| Boundary | Vertrauenswechsel | Kontrolle |
| --- | --- | --- |
| Browser <-> Backend API | Untrusted Client zu vertrauenswuerdiger Serverlogik | HTTPS; Authentifizierung; CSRF/CORS; serverseitige Validation und Authorization. |
| Backend <-> PostgreSQL | Applikationsprozess zu persistenten Geschaeftsdaten | Least-Privilege DB-Account; parametrisierte Zugriffe; Migrationen/Constraints; Transaktionen. |
| Frontend State <-> Business State | Manipulierbarer Clientzustand zu Source of Truth | Keine Sicherheitsentscheidung nur im Frontend; Server revalidiert Rolle, Ownership und aktuellen Planstand. |
| Repository/CI <-> Runtime Secrets | Quellcode/Build zu sensibler Konfiguration | Keine Secrets im Git; Environment/Secret Store; getrennte dev/staging/prod Werte. |
| Audit/Application Logs <-> personenbezogene Daten | Diagnose/Nachvollziehbarkeit zu Privacy | Allowlist der Logdaten; keine Passwoerter, Tokens, Secrets oder unnoetigen PII. |

## 4. Threat Actors

| Actor | Motivation / Faehigkeit | Sicherheitsannahme |
| --- | --- | --- |
| Nicht authentifizierter Angreifer | Credential Stuffing, Login-Abuse, Enumeration, Ausnutzen oeffentlicher Endpunkte. | Internet-Client ist grundsaetzlich nicht vertrauenswuerdig. |
| Authentifizierter Mitarbeiter | Versuch auf fremde Plaene/Vorgaenge, ID-Manipulation, unerlaubte Admin-Aktionen. | Legitimer Account bedeutet nicht Berechtigung auf fremde Ressourcen. |
| Kompromittiertes Admin-Konto | Missbrauch privilegierter Funktionen und Business-State-Manipulation. | Hoechster Impact; MFA, kurze Inaktivitaet und Audit reduzieren Risiko. |
| Fehlerhafter/kompromittierter Client | Manipulierte Requests, Replay, Mass Assignment, CSRF. | Frontend-Validierung ist UX, niemals Security Boundary. |
| Supply-Chain/Deployment-Fehler | Unsichere Dependency, falsche Konfiguration oder offenes Secret. | CI/Dependency-Pruefung und sichere Runtime-Konfiguration sind erforderlich. |

## 5. Priorisierte Threat Scenarios

| ID | Threat | Beispiel | Risiko | Hauptkontrolle |
| --- | --- | --- | --- | --- |
| T-01 | Broken Access Control / IDOR | Mitarbeiter aendert Resource-ID und liest fremden Plan oder Antrag. | High | Resource-Level Authorization; Ownership serverseitig pruefen. |
| T-02 | Privilege Escalation | Mitarbeiter ruft Admin-Endpunkt direkt auf. | High | Default-Deny; serverseitige Roles/Policies. |
| T-03 | Session Theft / Replay | Gestohlener Cookie wird wiederverwendet. | High | Secure+HttpOnly; TLS; Token-Hash im Store; Rotation; Revocation; Timeouts. |
| T-04 | Credential Attack | Automatisierte Passwortversuche / Credential Stuffing. | High | Rate limiting; progressive Verzoegerung; compromised-password check; Admin-MFA. |
| T-05 | CSRF | Fremde Site loest schreibenden Request mit Session-Cookie aus. | High | SameSite + Anti-CSRF-Token + Origin/Referer-Pruefung. |
| T-06 | Injection / Mass Assignment | Manipulierte Felder veraendern role/status/ownerId. | High | DTO-Allowlist; unbekannte Felder -> 400; parametrisierte DB-Zugriffe. |
| T-07 | Race / Lost Update | Plan oder Ersatzbedarf aendert sich zwischen Anzeige und Entscheidung. | High | Transaktion; Revalidation; Constraints; Optimistic Concurrency wo noetig. |
| T-08 | Sensitive Data Leakage | Secrets/PII landen in Logs, Errors oder Responses. | High | Safe Error Model; Log-Allowlist; Redaction; keine Stack Traces. |
| T-09 | Audit Tampering | Kritische Aktion wird ohne nachvollziehbaren Trail veraendert. | Medium/High | Append-orientiertes Audit; kein normaler Update/Delete-Flow; Admin-only read. |
| T-10 | Security Misconfiguration | Wildcard-CORS, Debug-Modus, fehlendes HTTPS oder Default-Secret. | High | Sichere Defaults; Fail-Fast; CI/Deployment Checks; Production Gate. |

## 6. Security Architecture Principles

Default Deny: Zugriff ist verboten, bis Authentifizierung, Rolle und Ressourcenbezug positiv geprueft sind.

Server Authoritative: Clientdaten, Rollenhinweise und UI-Zustaende sind niemals alleinige Grundlage einer Sicherheitsentscheidung.

Least Privilege: Mitarbeiter sehen nur eigene Daten; Buero/Admin nur die fuer den administrativen Workflow vorgesehenen Rechte.

Defense in Depth: Session-Cookie, CSRF-Schutz, Validation, Authorization, DB-Constraints und Audit ergaenzen sich.

Fail Closed: Bei unklarer Berechtigung, stale state oder Fehlern wird die Aktion nicht ausgefuehrt.

Minimum Data: KRANK speichert ausschliesslich Datum + Status KRANK; kein medizinischer Freitext.

Transactional Integrity: Zusammengehoerige Plan- und Ersatz-Aenderungen erfolgen atomar.

Secure by Environment: Debug/Swagger/CORS/Secrets werden bewusst zwischen Development, Staging und Production getrennt.

## 7. MVP vs. Production Boundary

| Im Praktikums-MVP verpflichtend | Vor echtem Production-Go-live zusaetzlich |
| --- | --- |
| Serverseitige AuthN/AuthZ; sichere Sessions; Password Hashing; Validation; CSRF/CORS; Safe Errors; Audit-Minimum; Security Tests. | Vollstaendiges MFA-Rollout fuer Buero/Admin; Retention/Loeschkonzept; Hardening/Monitoring/Alerting; Backup/Restore-Drills; Production Secret Store; erneute Threat-/Risk-Review. |

| 9.1 Gate |
| --- |
| APPROVED. Threat Model, Assets, Trust Boundaries, priorisierte Threats und Security Principles sind fuer den Praktikums-MVP ausreichend definiert. Offene Production-Massnahmen sind explizit getrennt. |

### Quellen und Traceability

| Quelle | Relevanz |
| --- | --- |
| Phase 2 Requirements Baseline v1.1 | SEC-AUTHZ, SEC-AUTH/PWD/RESET/LOGIN/SESSION/TRANSPORT/LOG, PRIV-*, FR/BR-AUD, NFR-ERR/REL. |
| Phase 3 Scope & MVP v1.1 | M2 Auth & RBAC, M8 Qualitaetsminimum, Security/Data-Integrity Guardrails; MFA als Stretch im Praktikums-MVP. |
| Baseline Amendment v1.2 (CR-01) | Entfernt das 3er-Ersatzlimit; Authorization, Audit, Idempotenz und Datenintegritaet bleiben unveraendert. |
| Phase 4 Systemanalyse v1.1 | MVP-Akteure und Use Cases fuer Login, Monatsplan, Absage/Ersatz, Admin Work Queue und Statistik. |
| Phase 8 API Design | RFC 9457 Problem Details mit stable code, correlationId und optional errors[]. |
| OWASP Top 10:2025 | Externe Referenz fuer Security-Assurance-Mapping; keine zusaetzliche Produktanforderung. |
