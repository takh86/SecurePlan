# Korrektur von Monatszuordnungen: Regeln und Übergabe an SP-11

Stand: 26.10.2026. Betrifft `PATCH /api/v1/project-assignments/{assignmentId}` (SP-09, Stand PARTIAL).

## Umgesetzte Regeln (Owner-Entscheidungen D1–D5)

- **Wer, was:** Nur `COMPANY_ADMIN` des eigenen Unternehmens. Korrigierbar sind `employeeId`, `projectId` und `monthStart`; mindestens ein Feld (`EMPTY_PATCH`). Das vollständige Ergebnis-Tupel wird neu validiert. Eine Korrektur ohne Änderung antwortet 200, ohne Schreibzugriff und ohne Audit.
- **Aktueller Monat (D3):** wird in der IANA-Zeitzone des Unternehmens (`companies.time_zone`) bestimmt, nie in UTC. Die Uhr ist über das Token `WALL_CLOCK` austauschbar, damit Monatsgrenzen deterministisch getestet werden (Europe/Berlin und America/New_York, auch am Jahreswechsel).
- **Zukünftige Korrektur (D1):** alter und neuer Monat liegen nach dem aktuellen Monat. Der Ergebnis-Mitarbeiter und das Ergebnis-Projekt müssen `ACTIVE` sein.
- **Historische Korrektur (D1/D2):** alter oder neuer Monat ist der aktuelle oder ein vergangener Monat. Eine bereits referenzierte inaktive Person oder ein bereits referenziertes inaktives Projekt darf bleiben. **Neu referenziert** werden darf nur Aktives. Wird die Person getauscht, muss ein dokumentierter Beschäftigungszeitraum den Monat überlappen; ein fehlender Beschäftigungsbeginn gilt als **kein Nachweis** (`409 PROJECT_ASSIGNMENT_CORRECTION_CONFLICT`). **Neue Owner-Festlegung (26.10.2026, MVP-Business-Rule):** Beim historischen Wechsel auf einen anderen Mitarbeiter muss eine dokumentierte Beschäftigungsperiode den betroffenen Kalendermonat überlappen; fehlt der Nachweis, wird mit `PROJECT_ASSIGNMENT_CORRECTION_CONFLICT` abgelehnt. Die Regel ist umgesetzt und getestet und muss mit der formellen Baseline-Fortschreibung dokumentiert werden. Grenzfälle (jeweils inklusiv): Beschäftigungsbeginn am Monatsletzten zählt, am Folgetag nicht; Beschäftigungsende am Monatsersten zählt, am Vortag nicht; geprüft wird immer der **Zielmonat** der Korrektur; der Schaltjahr-Februar ist abgedeckt.
- **Mitarbeiterwechsel (D4):** erlaubt. Sperrreihenfolge unabhängig von der Änderungsrichtung: handelnder Admin → Mitarbeiter nach aufsteigender ID → Projekte nach aufsteigender ID → Zuordnungszeile. Die Zeile wird unter der Sperre erneut gelesen; eine zwischenzeitliche Änderung ergibt `409 PROJECT_ASSIGNMENT_CONFLICT`, kein stilles Überschreiben.
- **Archivierte Projekte (F-3):** als Ziel `404`. Eine bestehende Zuordnung auf ein archiviertes Projekt bleibt lesbar.
- **Audit (D5):** `PROJECT_ASSIGNMENT_CORRECTED` (vorläufiger MVP-Name, kein freigegebener Katalog). `old_values`/`new_values` enthalten nur geänderte IDs und `monthStart`, dazu `scope` (`FUTURE` oder `HISTORICAL`). Keine Namen, E-Mail-Adressen oder Mitarbeiter-IDs im Klartext.

## Planungsdaten: fail closed, keine Annahme von Sicherheit

Monatspläne, Dienste und Plan-Zuordnungen (`monthly_plans`, `duties`, `plan_assignments`) existieren erst ab SP-10/SP-11. Dass sie fehlen, gilt **nicht** als Nachweis, dass eine Korrektur sicher ist.

- `planning-dependency-guard.ts` prüft zur Laufzeit, ob eine dieser Tabellen existiert. Existiert eine, schlagen alle Korrekturen mit `409 PROJECT_ASSIGNMENT_CORRECTION_CONFLICT` fehl, bis der Guard ersetzt ist.
- Ein Real-PostgreSQL-Test legt jede der drei Tabellen innerhalb einer zurückgerollten Transaktion an und weist dieses Verhalten nach.

### SP-11-Integrationsaufgabe: Planungsschutz der Korrektur (Gate vor Auslieferung von SP-11)

**Ziel:** `assertPlanningDependencyCheckImplemented` (`planning-dependency-guard.ts`) durch die echte Prüfung ersetzen oder integrieren. Der Guard darf nicht umgangen, auskommentiert oder durch „Tabelle existiert, also egal“ ersetzt werden. Legt SP-11 die Planungstabellen an, ohne den Guard zu ersetzen, sind Korrekturen absichtlich gesperrt.

**Acceptance Criteria**

1. Eine Korrektur (Person, Projekt oder Monat) wird mit `409 PROJECT_ASSIGNMENT_CORRECTION_CONFLICT` abgelehnt, wenn sie eine bestehende Plan-Zuordnung der **alten** Kombination aus Person, Projekt und Monat verwaisen oder ungültig machen würde.
2. Dasselbe gilt für die **neue** Kombination, wenn dort bereits Dienste existieren, die der geänderten Zuordnung widersprechen.
3. Ein veröffentlichter Monatsplan wird nie stillschweigend verändert; die Korrektur ändert ausschließlich `project_assignments` und löst keine Kaskade aus.
4. Ohne abhängige Planungsdaten funktioniert die Korrektur wie bisher (200).
5. Die Prüfung läuft in derselben Transaktion und unter den Sperren der Korrektur. Die Reihenfolge der Planungssperren (Dienst vor Zuordnungen, Phase 8.7) ist mit der Reihenfolge der Korrektur abgestimmt und dokumentiert; kein neuer Deadlock-Pfad.
6. Code und Text bleiben katalogkonform (keine neuen Codes) und geben keine Plandetails preis.
7. Der Tripwire-Test wird durch fachliche Integrationstests ersetzt, nicht gelöscht.

**Integrationstests (Real-PostgreSQL, synthetische Daten)**

- Veröffentlichter Plan mit Diensten der Person: Korrektur von Person, Projekt und Monat je einzeln ergibt 409, Zustand unverändert, kein Audit.
- Unveröffentlichter Plan: gleiche Fälle nach der dann gültigen Regel (vom Owner festzulegen; bis dahin 409).
- Plan eines anderen Projekts oder Monats: Die Korrektur bleibt 200.
- Nebenläufigkeit: Korrektur gegen gleichzeitige Dienstanlage für dieselbe Person und denselben Monat, in beiden Sperrreihenfolgen, ohne Deadlock und ohne verwaiste Plan-Zuordnung.
- Cross-Tenant: Plandaten eines anderen Unternehmens beeinflussen die Entscheidung nie.
- Rollback: Ein Audit-Fehler nach bestandener Prüfung lässt alles unverändert.

**Weitere SP-11-Aufgaben:** `EMPLOYEE_HAS_FUTURE_ASSIGNMENTS` bei der Deaktivierung (D-8.4-11); Eligibility-Prüfungen nutzen `EMPLOYEE_NOT_ASSIGNED_TO_PROJECT_MONTH`.

## Nicht enthalten

Oberfläche für Korrekturen, Entfernen von Zuordnungen (der Vertrag sieht kein DELETE vor) und ein formell freigegebener Audit-Aktionskatalog.

## Restrisiko Sitzungsablauf (kein Polling)

Es gibt bewusst kein periodisches `GET /me`, weil jeder Aufruf die Leerlaufzeit der Sitzung verlängern würde. Beibehalten sind die Prüfung beim Fokus (bfcache-Rückkehr), bei Navigation und bei jedem Request sowie die Cross-Tab-Signale für Logout und Login. Verbleibend: Ein Tab ohne jede Aktion zeigt nach einem serverseitigen Ablauf der Sitzung weiter seine zuletzt geladenen Daten, bis die nächste Aktion eine 401 liefert. Schreibzugriffe und Lesezugriffe sind serverseitig weiterhin geschützt.

## F-1: Beschäftigung muss den Zielmonat überlappen (Owner-Entscheidung Option A, 27.10.2026)

Betrifft `POST /api/v1/project-assignments`. `PATCH` bleibt unverändert (Regeln siehe oben).

- **Regel:** Ein dokumentierter Beschäftigungszeitraum (`employment_start`, `employment_end`) muss den Zielmonat an mindestens einem Kalendertag überlappen. Ein fehlender Beschäftigungsbeginn gilt als fehlender Nachweis. Die Regel gilt für historische, aktuelle und zukünftige Monate; für Zukunftsmonate gibt es kein künstliches Zeitlimit. Grenzfälle sind inklusiv: Beginn am Monatsletzten zählt, Ende am Monatsersten zählt.
- **Begründung:** Eine Zuordnung ist Grundlage der späteren Planung. Ohne Beschäftigungsnachweis für den Monat dürfte die Person dort nicht eingeplant werden. Dieselbe Evidenzregel gilt bereits beim historischen Personenwechsel per PATCH.
- **Fehlercode:** `409 Conflict`, `EMPLOYEE_NOT_EMPLOYED_FOR_MONTH`. Kein HTTP 422; kein anderer Code wurde umdefiniert. Der Code steht im Fehlerkatalog (`error-contract.ts`) und in der Frontend-Fehlerbehandlung des Zuordnungsformulars.
- **Prüfungsreihenfolge:** (1) Mitarbeiter 404 (unbekannt oder fremder Tenant), (2) Projekt 404 (unbekannt, fremder Tenant oder ARCHIVED), (3) `EMPLOYEE_INACTIVE`, (4) `PROJECT_INACTIVE`, (5) `EMPLOYEE_NOT_EMPLOYED_FOR_MONTH`, (6) `PROJECT_ASSIGNMENT_ALREADY_EXISTS` bzw. `PROJECT_ASSIGNMENT_CONFLICT`. Die Beschäftigungsdaten werden in derselben gesperrten Mitarbeiter-Abfrage gelesen; die Ablehnung erfolgt vor INSERT und Audit.
- **Auswirkung auf optionale Beschäftigungsdaten:** `employment_start` ist für Stammdaten weiterhin optional. Wer keinen Beschäftigungsbeginn hat, kann aber keinem Monat zugeordnet werden, bis der Beginn gepflegt ist.
- **Bestand:** Keine rückwirkende Migration und keine Neubewertung bestehender Zuordnungen.
- **Offen (formell):** Die privaten Phase-8-Baselines (API-Vertrag, Fehlerkatalog, Validierungs- und Testvertrag) müssen diese Entscheidung formell fortschreiben. Sie wurden hier nicht verändert.
