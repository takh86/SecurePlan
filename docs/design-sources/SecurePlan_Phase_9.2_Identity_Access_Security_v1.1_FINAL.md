# SecurePlan_Phase_9.2_Identity_Access_Security_v1.1_FINAL

> Designquelle: SecurePlan_Phase_9.2_Identity_Access_Security_v1.1_FINAL.docx. Markdown-Übertragung vom 07.10.2026; Quellstatus ist keine Implementierungsfreigabe. Bei Konflikten gelten CRs, 8.11 und der G0-Handoff.

SecurePlan

9.2 Identity & Access Security

Phase 9 - Security Design

| Dokument | 9.2 Identity & Access Security |
| --- | --- |
| Version / Status | v1.1 - FINAL - APPROVED |
| Projektphase | Phase 9 - Security Design |
| Basis | Phase 2 Requirements v1.1; Phase 3 Scope/MVP v1.1; Amendment v1.2 (CR-01); Phase 4 Systemanalyse v1.1; Phase 8 API Design |
| Zweck | Legt Authentication, Password-/MFA-Mechanismen, Session-Lifecycle, Account-Lifecycle und serverseitige Authorization fuer SecurePlan fest. |
| Freigegebene Entscheidungen | SD-01 Server-side Sessions; SD-02 TOTP-MFA fuer Buero/Admin; SD-03 Inaktivitaet 30 Min Admin / 8 Std Mitarbeiter; SD-04 Absolute Session Lifetime 12 Std Admin / 7 Tage Mitarbeiter |

| Freigegebene Security Decisions |
| --- |
| SD-01: Server-side Sessions + Secure HttpOnly Cookie. SD-02: TOTP-MFA + Recovery Codes fuer Buero/Admin. SD-03: Inaktivitaet 30 Minuten fuer Buero/Admin und 8 Stunden fuer Mitarbeiter. SD-04: Absolute Session Lifetime 12 Stunden fuer Buero/Admin und 7 Tage fuer Mitarbeiter. |

## 1. Identity Model

Im Praktikums-MVP existieren persoenliche Accounts fuer Buero/Admin und Mitarbeiter. Shared Accounts sind nicht vorgesehen. Die Schichtleiter-Funktion bleibt dienstbezogen und darf nicht als permanente Account-Rolle modelliert werden.

| Account-Typ | Authentifizierung | MFA | Kernrechte |
| --- | --- | --- | --- |
| Buero/Admin | E-Mail + Passwort | Product Target verpflichtend; TOTP + Recovery Codes. Umsetzung im Praktikum darf Stretch bleiben. | Mitarbeiter/Projekte, Monatsplan, Publish, Absage/Ersatz-Entscheidungen, Work Queue, Audit-Minimum. |
| Mitarbeiter | E-Mail + Passwort | Nicht verpflichtend in V1. | Eigener veroeffentlichter Plan, eigene Absagen, Ersatzangebote, eigener Status, eigene Statistik. |

## 2. Password Security

| Regel | Design |
| --- | --- |
| Laenge | Mindestens 15 Zeichen; mindestens 64 Zeichen werden unterstuetzt. |
| Komposition | Keine erzwungenen Gross-/Klein-/Zahl-/Sonderzeichen-Regeln. |
| Password Manager / Paste | Explizit erlaubt und unterstuetzt. |
| Kompromittierte Passwoerter | Uebliche oder bekannte kompromittierte Passwoerter werden abgelehnt. |
| Speicherung | Argon2id; Salt durch die Library; Hashformat enthaelt Parameter fuer spaetere Rehash-Upgrades. |
| Argon2id Baseline | Initial m=19 MiB, t=2, p=1; vor Deployment auf Zielsystem benchmarken und bei Bedarf erhoehen. |
| Logging | Passwort niemals im Klartext, in Audit-Logs, Application Logs oder Error Responses. |

## 3. Account Activation, E-Mail Change & Password Reset

Buero/Admin legt den Mitarbeiteraccount mit eindeutiger E-Mail an.

System erzeugt fuer Aktivierung/Reset einen kryptographisch zufaelligen, kurzlebigen Einmal-Token. Der Raw Token wird nur an den Benutzer ausgegeben; in der Datenbank wird ausschliesslich SHA-256(token) zusammen mit expiry und usedAt gespeichert.

Aktivierungslink verifiziert die E-Mail und erlaubt das Setzen des initialen Passworts. Nach erfolgreicher Nutzung wird der Token dauerhaft ungueltig.

Password Reset verwendet dasselbe One-Time-Token-Prinzip. Nach erfolgreichem Reset werden alle bestehenden Sessions des Accounts widerrufen.

Bei authentifizierter Passwortaenderung werden alle anderen Sessions widerrufen; die aktuelle Session darf nach Re-Authentication bestehen bleiben.

Eine neue oder geaenderte E-Mail wird zunaechst als pendingEmail gespeichert. Die bisherige verifizierte E-Mail bleibt fuer Security-Funktionen aktiv, bis pendingEmail erfolgreich verifiziert wurde; erst dann wird sie ersetzt.

| Anti-Enumeration |
| --- |
| Login, Aktivierung, E-Mail-Aenderung und Reset verwenden neutrale Antworten. Das System bestaetigt oeffentlich nicht, ob eine E-Mail oder Mitarbeiter-ID existiert. |

## 4. MFA fuer Buero/Admin

| Aspekt | Entscheidung |
| --- | --- |
| Verfahren | TOTP nach RFC-6238-kompatiblem Standard; kompatibel mit ueblichen Authenticator Apps. |
| Enrollment | Nach primaerer Authentifizierung Secret erzeugen, QR/Key anzeigen, erst nach erfolgreichem Bestätigungscode aktivieren. |
| Secret Storage | TOTP-Secret nicht loggen; verschluesselt at rest speichern; Schluessel ausserhalb der DB halten. |
| Recovery Codes | Einmalige Recovery Codes; nur gehasht speichern; bei Verwendung sofort invalidieren. |
| Admin Login | Passwort korrekt -> MFA Challenge -> privilegierte Session erst nach erfolgreicher MFA. |
| Rate Limiting | TOTP-Challenges werden rate-limited; wiederholte Fehlversuche erzeugen progressive Verzoegerung/temporäre Sperre der Challenge. |
| Replay Protection | Ein erfolgreich verwendeter TOTP-Code desselben Time-Step wird fuer dieselbe Challenge nicht erneut akzeptiert. |
| Reset/Recovery | MFA-Reset ist privilegierter Admin/Support-Prozess, erfordert starke Re-Authentication und wird auditiert; kein unsicherer Self-Service-Bypass. |

## 5. Server-side Session Design

| Element | Design |
| --- | --- |
| Cookie | Opaque random session token; Secure; HttpOnly; SameSite=Lax; Path=/; kein LocalStorage fuer Auth-Tokens. |
| Server Storage | PostgreSQL Session Store im MVP. In der DB wird nur ein kryptographischer Hash des Session-Tokens gespeichert. |
| Inaktivitaet | Buero/Admin 30 Minuten; Mitarbeiter 8 Stunden. Werte sind konfigurierbar. |
| Absolute Max Lifetime | Buero/Admin 12 Stunden; Mitarbeiter 7 Tage; danach erneute Authentifizierung unabhaengig von Aktivitaet. |
| Rotation | Session-ID nach Login und nach Privilege-/MFA-Uebergang rotieren, um Session Fixation zu verhindern. |
| Logout | Session serverseitig widerrufen; Cookie loeschen. |
| Account Deactivation | Alle Sessions des Accounts sofort serverseitig widerrufen. |
| Session Data | Nur minimale technische Informationen: userId, createdAt, lastSeenAt, expiresAt, revokedAt; keine unnoetigen personenbezogenen Inhalte. |

## 6. Login Abuse Protection

| Kontrolle | Default / Regel |
| --- | --- |
| Account-basierte Begrenzung | Nach 5 Fehlversuchen innerhalb 15 Minuten progressive Verzoegerung; kein dauerhaftes Hard-Lockout, um Lockout-DoS zu vermeiden. |
| IP-basierte Begrenzung | Zusaetzliche grobe Rate-Limit-Boundary fuer Login, Reset und MFA; Grenzwerte environment-basiert. |
| Antwortverhalten | Neutrale Fehlermeldung; gleiche semantische Antwort fuer unbekannte E-Mail und falsches Passwort. |
| Monitoring | Wiederholte Fehlversuche technisch loggen; erfolgreiche/auffaellige Admin-Logins sicherheitsrelevant erfassen, ohne Secrets. |

## 7. Authorization Model

SecurePlan verwendet kein reines Rollenmodell. Authorization kombiniert Rolle + Ownership/Scope + aktuellen Business-State. Jede Entscheidung erfolgt serverseitig.

| Ressource / Aktion | Mitarbeiter | Buero/Admin |
| --- | --- | --- |
| Eigenen veroeffentlichten Monatsplan lesen | Allow: nur eigene Dienste | Allow: administrative Planungssicht |
| Fremden Mitarbeiterplan lesen | Deny | Allow im administrativen Kontext |
| Monatsplan erstellen/bearbeiten/publishen | Deny | Allow |
| Absage erstellen/zurueckziehen | Allow: nur eigener geplanter Dienst / eigener offener Antrag | Admin entscheidet separat |
| Ersatzangebot abgeben | Allow: nur eigener Account und bei aktueller Eligibility | Admin prueft/entscheidet; kein Mitarbeiterangebot |
| Ersatz auswaehlen / Absage entscheiden | Deny | Allow mit Revalidation des aktuellen Planstands |
| Eigene Statistik | Allow | Optional administrative Einsicht nach fachlichem Bedarf |
| Audit Log | Deny | Allow: fachlicher Audit-Zugriff |

## 8. Authorization Implementation Rules

Authentication Guard prueft gueltige Session und Account-Status.

Role/Policy Layer prueft, ob die Aktion fuer Mitarbeiter oder Buero/Admin grundsaetzlich erlaubt ist.

Resource-Level Policy prueft Ownership, Projekt-/Monatsbezug und aktuellen Business-State.

DTO-Felder wie userId, role oder ownerId werden nie ungeprueft vom Client uebernommen; Identitaet kommt aus der Session.

Listen und Suchabfragen filtern bereits serverseitig auf erlaubte Datensaetze.

Bei fehlender Berechtigung wird 403 verwendet; 404 ist erlaubt, wenn die Existenz einer sensiblen Ressource nicht offengelegt werden soll.

## 9. Security Acceptance Criteria

| ID | Kriterium |
| --- | --- |
| AC-IAM-01 | Manipulierte Mitarbeiter-ID/Plan-ID gewaehrt keinen Zugriff auf fremde Ressourcen. |
| AC-IAM-02 | Mitarbeiter kann keinen Admin-Endpunkt direkt aufrufen. |
| AC-IAM-03 | Deaktivierung eines Accounts macht alle bestehenden Sessions unmittelbar ungueltig. |
| AC-IAM-04 | Admin-Session wird nach 30 Minuten Inaktivitaet ungueltig; Mitarbeiter-Session nach 8 Stunden. |
| AC-IAM-05 | Absolute Session Lifetime: Admin 12 Stunden, Mitarbeiter 7 Tage. |
| AC-IAM-06 | Session Cookie ist Secure/HttpOnly/SameSite und Auth-Token liegt nicht im LocalStorage. |
| AC-IAM-07 | Recovery Code und TOTP-Challenge koennen nicht erfolgreich wiederverwendet werden. |
| AC-IAM-08 | Activation-/Reset-Token ist kurzlebig, einmal verwendbar und nur gehasht in der DB gespeichert. |
| AC-IAM-09 | Password Reset widerruft alle bestehenden Sessions. |
| AC-IAM-10 | Neue E-Mail wird erst nach erfolgreicher Verifikation fuer Security-Funktionen wirksam. |

| 9.2 Gate |
| --- |
| APPROVED. Identity, Authentication, MFA, Session-Lifecycle, Account-Lifecycle und Resource-Level Authorization sind ausreichend fuer die Umsetzung spezifiziert. |

### Quellen und Traceability

| Quelle | Relevanz |
| --- | --- |
| Normative Baselines (Phase 2/3/4) | AuthN/AuthZ, Passwort/Reset/Session, E-Mail-Verifikation, Account-Deaktivierung, MVP-Scope und Login/Ownership-Use-Cases. |
| OWASP Password Storage Cheat Sheet | Externe Referenz fuer Argon2id und Password-Storage-Baseline. |
