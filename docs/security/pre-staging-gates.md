# Offene Security- und Production-Gates vor Staging/Produktion

Stand: 26.10.2026, aus dem Review von PR #57 (SP-07). Diese Punkte blockieren den Merge in den Entwicklungs-MVP mit synthetischen Daten nicht, **müssen aber vor jedem Staging mit echten Nutzern und vor Produktion geschlossen oder ausdrücklich freigegeben werden.**

| ID | Gate | Stand | Wo |
|---|---|---|---|
| S7-2 | **Produktiver Mail-Transport und erneutes Senden der Aktivierung.** Es existiert nur der lokale Mailpit-Adapter (nur `@secureplan.test`, nur `NODE_ENV=development`). Außerhalb davon schlägt die Zustellung absichtlich fehl. Schlägt sie fehl, bleibt ein Mitarbeiter mit Konto in `PENDING_ACTIVATION` ohne gültigen Token; es gibt keinen HTTP-Weg zum erneuten Senden (nur ein Entwicklungsskript). Der Vertrag kennt weder Zustellstatus noch Resend. | OFFEN | `activation-delivery.ts`, `employees.service.ts` (`deliverActivation`) |
| S7-3 | **Offenlegung der E-Mail-Existenz über Unternehmen hinweg.** E-Mail-Adressen sind global eindeutig; `409 EMAIL_ALREADY_IN_USE` kann verraten, dass eine Adresse in einem anderen Unternehmen registriert ist. UI-Text und Logs sind neutral, der Trade-off ist nicht freigegeben. Ohne separate Owner-Entscheidung wird die globale Eindeutigkeit **nicht** verändert. | OFFEN (Owner-Entscheidung) | `account-lifecycle.service.ts` (`provisionEmployeeAccount`) |
| S7-7 | **Session-Revocation-Race in laufenden Schreibzugriffen.** Ein Logout oder Widerruf, der nach der Eingangsprüfung, aber vor dem Schreiben committed, wird vom laufenden Write nicht erkannt. Prüfung von Konto, Firma und Rolle unter Sperre bleibt. Strengere Variante aus PR #52 steht aus. | OFFEN (SP-06-Entscheidung) | `actor-in-transaction.ts` |

## Weitere bekannte offene Punkte

- **R-1:** `companies.time_zone` wird nicht validiert. Ein ungültiger Zonenname würde Korrekturen von Monatszuordnungen mit 500 abbrechen (fail closed). Validierung gehört in den Anlege-Pfad für Unternehmen.
- **SP-11-Planungsschutz:** Der Guard der Zuordnungs-Korrektur muss durch die echte Prüfung ersetzt werden (siehe `docs/datenbank/project-assignment-correction-handoff.md`).
- **Sitzungsablauf ohne Aktivität:** kein periodisches Polling (würde den Idle-Timeout verlängern); ein untätiger Tab zeigt nach serverseitigem Ablauf zuletzt geladene Daten bis zur nächsten Aktion.
- **Audit-Aktionsnamen** sind Annahmen ohne freigegebenen Katalog. Alle Aktionen laufen über `BusinessAuditService` mit der serverseitig erzeugten Request-Correlation-ID, seit E-15T auch `ACCOUNT_ACTIVATED`. `ACCOUNT_ACTIVATION_REISSUED` ist ein **reines Entwicklungsereignis**: Es wird nur vom lokalen Wiederherstellungsskript `scripts/reissue-employee-activation.mjs` geschrieben (nur `NODE_ENV=development`, nur lokale Datenbank), von keinem HTTP-Pfad, und hat eine eigene, skriptinterne Correlation-ID.
- **Formelle Fortschreibung** der privaten Baselines (siehe ADR-0002 und die Übergabedatei).

## Behoben im Review

- **S7-1:** Der Versand der Aktivierungs-Mail hat jetzt explizite SMTP-Timeouts (Verbindung 5 s, Begrüßung 5 s, Inaktivität 10 s) und eine Gesamtfrist von 15 s. Ein Timeout gilt als fehlgeschlagene Zustellung; es gibt keinen Retry.