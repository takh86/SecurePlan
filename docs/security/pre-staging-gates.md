# Offene Security- und Production-Gates vor Staging/Produktion

Stand: 29.10.2026; ursprüngliche SP-07-Gates vom 26.10. bleiben erhalten. Koordination: [#51](https://github.com/takh86/SecurePlan/issues/51), Verantwortlicher [@takh86](https://github.com/takh86). Diese Punkte blockieren den Merge in den Entwicklungs-MVP mit synthetischen Daten nicht, **müssen aber vor jedem Staging mit echten Nutzern und vor Produktion geschlossen oder ausdrücklich freigegeben werden.** Öffentliche Bereitstellung bleibt durch die zusätzlichen #51-Gates gesperrt.

| ID | Gate | Stand | Wo |
|---|---|---|---|
| S7-2 | **Produktiver Mail-Transport und erneutes Senden der Aktivierung.** Es existiert nur der lokale Mailpit-Adapter (nur `@secureplan.test`, nur `NODE_ENV=development`). Außerhalb davon schlägt die Zustellung absichtlich fehl. Schlägt sie fehl, bleibt ein Mitarbeiter mit Konto in `PENDING_ACTIVATION` ohne gültigen Token; es gibt keinen HTTP-Weg zum erneuten Senden (nur ein Entwicklungsskript). Der Vertrag kennt weder Zustellstatus noch Resend. | OFFEN | `activation-delivery.ts`, `employees.service.ts` (`deliverActivation`) |
| S7-3 | **Offenlegung der E-Mail-Existenz über Unternehmen hinweg.** E-Mail-Adressen sind global eindeutig; `409 EMAIL_ALREADY_IN_USE` kann verraten, dass eine Adresse in einem anderen Unternehmen registriert ist. UI-Text und Logs sind neutral, der Trade-off ist nicht freigegeben. Ohne separate Owner-Entscheidung wird die globale Eindeutigkeit **nicht** verändert. | OFFEN (Owner-Entscheidung) | `account-lifecycle.service.ts` (`provisionEmployeeAccount`) |
| S7-7 | **Session-Revocation-Race in laufenden Schreibzugriffen.** Ein Logout oder Widerruf, der nach der Eingangsprüfung, aber vor dem Schreiben committed, wird vom laufenden Write nicht erkannt. Prüfung von Konto, Firma und Rolle unter Sperre bleibt. Strengere Variante aus PR #52 steht aus. | OFFEN (SP-06-Entscheidung) | `actor-in-transaction.ts` |

## Weitere bekannte offene Punkte

- **R-1:** Der Anlege-/Änderungspfad für `companies.time_zone` braucht verbindliche IANA-Validierung. S-9 und Fall 2 prüfen inzwischen den benannten Zonen-Katalog; vorhandene Korrektur-/DELETE-Pfade bleiben unverändert. Keine stille UTC-Ersatzannahme; ungültige Konfiguration muss fail closed bleiben.
- **SP-11-Planungsschutz:** Beide Guards für Zuordnungs-PATCH/DELETE und Schicht-PATCH müssen mit der Planungstabellen-Integration durch echte Prüfungen ersetzt werden. Business D2/D3 sind genehmigt; relationale Prädikate und LOCK-01 bleiben vor Implementierung offen. Tracking: [#25/#26](../datenbank/sp11-integrity-handoff.md), kein Bypass.
- **#73 Audit-Härtung:** Nach dem physischen Entfernen einer Zukunftszuordnung ist das Audit-Ereignis `PROJECT_ASSIGNMENT_REMOVED` der einzige Nachweis. `audit_event` ist nur per Konvention append-only (kein `REVOKE`, kein Trigger). Aufbewahrungsfrist, Zugriffskontrolle (Mitarbeiter-IDs sind pseudonyme personenbezogene Daten) sowie Backup und Wiederherstellung sind nicht festgelegt und werden nicht stillschweigend als unbegrenzt angenommen.
- **#73 Versions-Invariante nicht DB-erzwungen:** Die `version` einer Monatszuordnung ist `updated_at` in Epoch-Mikrosekunden. Ein Schreibzugriff per SQL außerhalb der Anwendung, der `updated_at` nicht nach der `GREATEST`-Regel fortschreibt, würde eine veraltete Bestätigung nicht erkennen. Betriebsregel: keine unreviewten Schreibzugriffe auf `project_assignments`. Erzwingung in der Datenbank (Trigger oder Revisionsspalte) wäre eine eigene, freizugebende Schemaänderung.
- **#73 Proxy und doppelte Header:** Der Backend-Parser lehnt ein mehrfach gesendetes `Expected-Version` ab, solange es zusammengefügt ankommt. Ein vorgeschalteter Proxy darf Duplikate nicht stillschweigend verwerfen; das ist in der Deploy-Konfiguration zu prüfen.
- **Sitzungsablauf ohne Aktivität:** kein periodisches Polling (würde den Idle-Timeout verlängern); ein untätiger Tab zeigt nach serverseitigem Ablauf zuletzt geladene Daten bis zur nächsten Aktion.
- **Audit-Aktionsnamen:** PO-D1 genehmigt genau `PROJECT_ASSIGNMENT_CREATED`, `PROJECT_ASSIGNMENT_CORRECTED`, `PROJECT_ASSIGNMENT_REMOVED` und `SHIFT_CONFIGURATION_UPDATED` mit ihren bisherigen Bedeutungen. [ADR-0004](../architektur/adr/0004-related-business-audit-catalogue.md) dokumentiert den begrenzten Katalog; unabhängige kontrollierte Dokumentabnahme steht aus. Andere provisorische Namen werden nicht mitratifiziert. HTTP-Aktionen verwenden `BusinessAuditService` und serverseitige Request-Correlation-ID, seit E-15T auch `ACCOUNT_ACTIVATED`. `ACCOUNT_ACTIVATION_REISSUED` ist ein **reines Entwicklungsereignis** des lokalen Wiederherstellungsskripts `scripts/reissue-employee-activation.mjs`, ohne HTTP-Pfad und mit eigener skriptinterner Correlation-ID.
- **Formelle Fortschreibung** der privaten Baselines (siehe ADR-0002 und die Übergabedatei).

## Explizite Übergabe aus #64/#73

- **Browserabnahme:** manueller Smoke und automatisierte Browser-E2E weiterhin **NOT_RUN**. Vor integrierter UX-/Staging-Abnahme den echten Browser→API→isolierte-PG-Ablauf für Korrektur, Zukunfts-DELETE, S-9, Beschäftigungs-Konflikt und Recovery prüfen; keine DB-Fixtures ohne vorher bestätigte Testidentität.
- **Audit-Betrieb:** Retention mit Eigentümer/Frist, DB-Rollen gegen UPDATE/DELETE, berechtigter Audit-Zugriff, Backup und Restore-Nachweis festlegen und testen. Entfernte Zukunftslinks haben nur noch den Audit-Nachweis. Namensratifizierung allein erfüllt keine dieser Kontrollen.
- **Abhängigkeiten:** [main-CI 40899445571](https://github.com/takh86/SecurePlan/actions/runs/40899445571) meldet 10 Befunde (6 moderate, 4 high). Paket-/Transitivpfade, Produktions-Erreichbarkeit, Ausnutzbarkeit und kompatible Abhilfe oder ausdrückliche Security-Risikoentscheidung unter #51 dokumentieren. Kein Upgrade im Dokumentationsaudit.
- **Testziel vor jedem Write:** vor Fixtures die Identität einer ausdrücklich isolierten, wegwerfbaren Instanz/Datenbank/Schema verifizieren; bei Unsicherheit vor dem ersten Write stoppen. Tests dürfen nicht unbeabsichtigt die Entwicklungskonfiguration erben. Das frühere Fixture-Cleanup ist vom Autor berichtet und **hier nicht unabhängig DB-seitig verifiziert**; notwendige Nachprüfung nur separat autorisiert und zunächst lesend. Cleanup-Hooks ersetzen keinen Schutz vor dem Write.
- **Weitere #51-Gates:** Trusted Proxy/Client-IP, Spoofing/Rate-Limit, Counter-Retention/Pending/Crash/HMAC-Rotation, Edge-Grenzen, konsistente Session-Identität, Cookie/Logout/Revocation, Security Review/Alerts und explizite Release-Freigabe bleiben offen. Parser-Härtung (#69) und CI-Key-Masking (#55) sind bereits erledigte Teilnachweise.

SP-09 administrative Schließung, SP-11-Funktionsabnahme und Betriebsfreigabe sind getrennt. [Abschlussmatrizen](../reviews/sp09-closeout-64-73.md) geben weder einen Browser-PASS noch eine Bereitstellungsfreigabe.

## SP-10-Übergabe vom 30.10.2026

- **Revisionsprotokoll:** Die vom Owner genehmigte `availability_revision` wird
  durch Anwendungsschreibpfade fortgeschrieben. SQL außerhalb dieser Pfade kann
  Vorschau-ABA-Schutz umgehen. Schreibrollen, Betriebszugriffe und Wartung müssen
  Sperren und Revision beachten; keine ungeprüften direkten Marker-/Lifecycle-Writes.
- **Technische Retention:** Vorschau-/Wiederholungsautorität ist zeitlich begrenzt;
  tenantbezogene Bereinigung läuft begrenzt mit `SKIP LOCKED`. Der explizite
  Wartungseinstieg benötigt Betriebsscheduling, Monitoring und ein Konzept für
  inaktive Mandanten. Ablaufzeit ist kein Nachweis physischer Löschung.
- **Minimales Audit:** Pro geändertem Tag wird nur das Datum protokolliert.
  Frühere SICK-/LEAVE-Werte sind daraus bewusst nicht rekonstruierbar (Owner-
  Entscheidung). Mitarbeiter-/Datumsbezug bleibt personenbezogen; Zugriff,
  Retention, DB-Rollen und Restore brauchen die bestehenden #51-Nachweise.
- **Transport/Abnahme:** Doppelte `Idempotency-Key`-Zeilen sind am echten
  Node-HTTP-Eingang getestet. Der spätere Proxy darf Duplikate nicht verwerfen.
  Der Browser-Host dieser Sitzung ist nicht verfügbar; die tatsächliche
  Browserabnahme bleibt **NOT_RUN**. [SP-10-Prüfungen](../reviews/sp10-availability.md)
  ersetzen weder diese Abnahme noch offene SP-11- und S7-7-Gates.

## Behoben im Review

- **S7-1:** Der Versand der Aktivierungs-Mail hat jetzt explizite SMTP-Timeouts (Verbindung 5 s, Begrüßung 5 s, Inaktivität 10 s) und eine Gesamtfrist von 15 s. Ein Timeout gilt als fehlgeschlagene Zustellung; es gibt keinen Retry.
