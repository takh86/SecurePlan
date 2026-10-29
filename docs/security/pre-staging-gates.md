# Offene Security- und Production-Gates vor Staging/Produktion

Stand: 26.10.2026, aus dem Review von PR #57 (SP-07). Diese Punkte blockieren den Merge in den Entwicklungs-MVP mit synthetischen Daten nicht, **müssen aber vor jedem Staging mit echten Nutzern und vor Produktion geschlossen oder ausdrücklich freigegeben werden.**

| ID | Gate | Stand | Wo |
|---|---|---|---|
| S7-2 | **Produktiver Mail-Transport und erneutes Senden der Aktivierung.** Es existiert nur der lokale Mailpit-Adapter (nur `@secureplan.test`, nur `NODE_ENV=development`). Außerhalb davon schlägt die Zustellung absichtlich fehl. Schlägt sie fehl, bleibt ein Mitarbeiter mit Konto in `PENDING_ACTIVATION` ohne gültigen Token; es gibt keinen HTTP-Weg zum erneuten Senden (nur ein Entwicklungsskript). Der Vertrag kennt weder Zustellstatus noch Resend. | OFFEN | `activation-delivery.ts`, `employees.service.ts` (`deliverActivation`) |
| S7-3 | **Offenlegung der E-Mail-Existenz über Unternehmen hinweg.** E-Mail-Adressen sind global eindeutig; `409 EMAIL_ALREADY_IN_USE` kann verraten, dass eine Adresse in einem anderen Unternehmen registriert ist. UI-Text und Logs sind neutral, der Trade-off ist nicht freigegeben. Ohne separate Owner-Entscheidung wird die globale Eindeutigkeit **nicht** verändert. | OFFEN (Owner-Entscheidung) | `account-lifecycle.service.ts` (`provisionEmployeeAccount`) |
| S7-7 | **Session-Revocation-Race in laufenden Schreibzugriffen.** Ein Logout oder Widerruf, der nach der Eingangsprüfung, aber vor dem Schreiben committed, wird vom laufenden Write nicht erkannt. Prüfung von Konto, Firma und Rolle unter Sperre bleibt. Strengere Variante aus PR #52 steht aus. | OFFEN (SP-06-Entscheidung) | `actor-in-transaction.ts` |

## Weitere bekannte offene Punkte

- **R-1:** `companies.time_zone` wird nicht validiert. Ein ungültiger Zonenname würde Korrekturen und (seit #73) das Entfernen von Monatszuordnungen mit 500 abbrechen (fail closed). Validierung gehört in den Anlege-Pfad für Unternehmen.
- **SP-11-Planungsschutz:** Die Guards der Zuordnungs-Korrektur und (seit #73) des Entfernens müssen in derselben Slice, die Planungstabellen anlegt, durch die echte Prüfung ersetzt werden (siehe `docs/datenbank/project-assignment-correction-handoff.md`).
- **#73 Audit-Härtung:** Nach dem physischen Entfernen einer Zukunftszuordnung ist das Audit-Ereignis `PROJECT_ASSIGNMENT_REMOVED` der einzige Nachweis. `audit_event` ist nur per Konvention append-only (kein `REVOKE`, kein Trigger). Aufbewahrungsfrist, Zugriffskontrolle (Mitarbeiter-IDs sind pseudonyme personenbezogene Daten) sowie Backup und Wiederherstellung sind nicht festgelegt und werden nicht stillschweigend als unbegrenzt angenommen.
- **#73 Versions-Invariante nicht DB-erzwungen:** Die `version` einer Monatszuordnung ist `updated_at` in Epoch-Mikrosekunden. Ein Schreibzugriff per SQL außerhalb der Anwendung, der `updated_at` nicht nach der `GREATEST`-Regel fortschreibt, würde eine veraltete Bestätigung nicht erkennen. Betriebsregel: keine unreviewten Schreibzugriffe auf `project_assignments`. Erzwingung in der Datenbank (Trigger oder Revisionsspalte) wäre eine eigene, freizugebende Schemaänderung.
- **#73 Proxy und doppelte Header:** Der Backend-Parser lehnt ein mehrfach gesendetes `Expected-Version` ab, solange es zusammengefügt ankommt. Ein vorgeschalteter Proxy darf Duplikate nicht stillschweigend verwerfen; das ist in der Deploy-Konfiguration zu prüfen.
- **Sitzungsablauf ohne Aktivität:** kein periodisches Polling (würde den Idle-Timeout verlängern); ein untätiger Tab zeigt nach serverseitigem Ablauf zuletzt geladene Daten bis zur nächsten Aktion.
- **Audit-Aktionsnamen** sind Annahmen ohne freigegebenen Katalog. Alle Aktionen laufen über `BusinessAuditService` mit der serverseitig erzeugten Request-Correlation-ID, seit E-15T auch `ACCOUNT_ACTIVATED`. `ACCOUNT_ACTIVATION_REISSUED` ist ein **reines Entwicklungsereignis**: Es wird nur vom lokalen Wiederherstellungsskript `scripts/reissue-employee-activation.mjs` geschrieben (nur `NODE_ENV=development`, nur lokale Datenbank), von keinem HTTP-Pfad, und hat eine eigene, skriptinterne Correlation-ID.
- **Formelle Fortschreibung** der privaten Baselines (siehe ADR-0002 und die Übergabedatei).

## Behoben im Review

- **S7-1:** Der Versand der Aktivierungs-Mail hat jetzt explizite SMTP-Timeouts (Verbindung 5 s, Begrüßung 5 s, Inaktivität 10 s) und eine Gesamtfrist von 15 s. Ein Timeout gilt als fehlgeschlagene Zustellung; es gibt keinen Retry.