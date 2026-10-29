# Korrektur von Monatszuordnungen: Regeln und Übergabe an SP-11

Stand: 26.10.2026, ergänzt am 28.10.2026 um #64 Fall 1 und Owner-Entscheidung B sowie am 29.10.2026 um den #64-Status-Guard für Zukunftsmonate. Betrifft `PATCH /api/v1/project-assignments/{assignmentId}` (SP-09, Stand PARTIAL).

## Umgesetzte Regeln (Owner-Entscheidungen D1–D5)

- **Wer, was:** Nur `COMPANY_ADMIN` des eigenen Unternehmens. Korrigierbar sind `employeeId`, `projectId` und `monthStart`; mindestens ein Feld (`EMPTY_PATCH`). Das vollständige Ergebnis-Tupel wird neu validiert. Eine Korrektur ohne Änderung antwortet 200, ohne Schreibzugriff und ohne Audit.
- **Aktueller Monat (D3):** wird in der IANA-Zeitzone des Unternehmens (`companies.time_zone`) bestimmt, nie in UTC. Die Uhr ist über das Token `WALL_CLOCK` austauschbar, damit Monatsgrenzen deterministisch getestet werden (Europe/Berlin und America/New_York, auch am Jahreswechsel).
- **Zukünftige Korrektur (D1):** alter und neuer Monat liegen nach dem aktuellen Monat. Der Ergebnis-Mitarbeiter und das Ergebnis-Projekt müssen `ACTIVE` sein. Seit #64 Fall 1 braucht der Ergebnis-Mitarbeiter außerdem einen Beschäftigungsnachweis für den Ergebnis-Monat, wie beim POST (`409 EMPLOYEE_NOT_EMPLOYED_FOR_MONTH`, siehe Abschnitt „#64 Fall 1“).
- **Historische Korrektur (D1/D2):** alter oder neuer Monat ist der aktuelle oder ein vergangener Monat. Eine bereits referenzierte inaktive Person oder ein bereits referenziertes inaktives Projekt darf bleiben, solange der Zielmonat nicht in der Zukunft liegt (seit dem #64-Status-Guard, Abschnitt „#64 Status-Guard für Zukunftsmonate“). **Neu referenziert** werden darf nur Aktives. Wird die Person getauscht, muss ein dokumentierter Beschäftigungszeitraum den Monat überlappen; ein fehlender Beschäftigungsbeginn gilt als **kein Nachweis** (`409 PROJECT_ASSIGNMENT_CORRECTION_CONFLICT`). **Neue Owner-Festlegung (26.10.2026, MVP-Business-Rule):** Beim historischen Wechsel auf einen anderen Mitarbeiter muss eine dokumentierte Beschäftigungsperiode den betroffenen Kalendermonat überlappen; fehlt der Nachweis, wird mit `PROJECT_ASSIGNMENT_CORRECTION_CONFLICT` abgelehnt. Die Regel ist umgesetzt und getestet und muss mit der formellen Baseline-Fortschreibung dokumentiert werden. Grenzfälle (jeweils inklusiv): Beschäftigungsbeginn am Monatsletzten zählt, am Folgetag nicht; Beschäftigungsende am Monatsersten zählt, am Vortag nicht; geprüft wird immer der **Zielmonat** der Korrektur; der Schaltjahr-Februar ist abgedeckt. Liegt der Zielmonat in der Zukunft, wird seit Owner-Entscheidung B auch ohne Personenwechsel geprüft (Abschnitt „#64 Owner-Entscheidung B“).
- **Mitarbeiterwechsel (D4):** erlaubt. Sperrreihenfolge unabhängig von der Änderungsrichtung: handelnder Admin → Mitarbeiter nach aufsteigender ID → Projekte nach aufsteigender ID → Zuordnungszeile. Die Zeile wird unter der Sperre erneut gelesen; eine zwischenzeitliche Änderung ergibt `409 PROJECT_ASSIGNMENT_CONFLICT`, kein stilles Überschreiben.
- **Archivierte Projekte (F-3):** als Ziel `404`. Eine bestehende Zuordnung auf ein archiviertes Projekt bleibt lesbar. Bleibt ein bereits referenziertes archiviertes Projekt unverändert, darf es innerhalb der Historie bleiben; liegt der Zielmonat in der Zukunft, antwortet die Korrektur `409 PROJECT_INACTIVE`.
- **Audit (D5):** `PROJECT_ASSIGNMENT_CORRECTED` (vorläufiger MVP-Name, kein freigegebener Katalog). `old_values`/`new_values` enthalten nur geänderte IDs und `monthStart`, dazu `scope` (`FUTURE` oder `HISTORICAL`). Keine Namen, E-Mail-Adressen oder Mitarbeiter-IDs im Klartext.

## Planungsdaten: fail closed, keine Annahme von Sicherheit

Monatspläne, Dienste und Plan-Zuordnungen (`monthly_plans`, `duties`, `plan_assignments`) existieren erst ab SP-10/SP-11. Dass sie fehlen, gilt **nicht** als Nachweis, dass eine Korrektur sicher ist.

- `planning-dependency-guard.ts` prüft zur Laufzeit, ob eine Relation mit einem Namen aus der zentralen Liste `PLANNING_GUARD_TABLES` (`planning-guard/planning-table-classification.ts`, Singular- und Pluralformen inklusive „plan entry“) in irgendeinem Schema existiert. Ausgenommen sind nur die reservierten PostgreSQL-Systemschemas `pg_*`; `information_schema` zählt mit. Existiert eine, schlagen alle Korrekturen mit `409 PROJECT_ASSIGNMENT_CORRECTION_CONFLICT` fehl, bis der Guard ersetzt ist. Der SP-08b-Guard verwendet dieselbe Liste und dieselbe Abfrage.
- Real-PostgreSQL-Tests legen jeden Namen als Tabelle, als View und in einem fremden Schema innerhalb zurückgerollter Transaktionen an. Committete gegenüber nicht committeter DDL zweier Sessions wird in einer eigenen temporären Datenbank geprüft (`planning-guards-real.e2e-spec.ts`).
- Zwei CI-Prüfungen halten die Klassifikation vollständig:
  - Der statische Tripwire `planning-table-classification.spec.ts` liest die Migrationsdateien. Er ist schnell und braucht keine Datenbank, sieht aber keine erst zur Laufzeit gebaute DDL (`EXECUTE`, `SELECT INTO`).
  - Die Post-Migration-Prüfung `planning-classification-catalog-real.e2e-spec.ts` vergleicht nach allen Migrationen `pg_catalog` mit der Klassifikation. Unklassifizierte Relationen, fremde Schemas und Einträge ohne Relation schlagen fehl.

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

Betrifft `POST /api/v1/project-assignments`. Für `PATCH` galt die Regel zunächst nicht; für zukünftige Korrekturen gilt sie seit #64 Fall 1 (nächster Abschnitt).

- **Regel:** Ein dokumentierter Beschäftigungszeitraum (`employment_start`, `employment_end`) muss den Zielmonat an mindestens einem Kalendertag überlappen. Ein fehlender Beschäftigungsbeginn gilt als fehlender Nachweis. Die Regel gilt für historische, aktuelle und zukünftige Monate; für Zukunftsmonate gibt es kein künstliches Zeitlimit. Grenzfälle sind inklusiv: Beginn am Monatsletzten zählt, Ende am Monatsersten zählt.
- **Begründung:** Eine Zuordnung ist Grundlage der späteren Planung. Ohne Beschäftigungsnachweis für den Monat dürfte die Person dort nicht eingeplant werden. Dieselbe Evidenzregel gilt bereits beim historischen Personenwechsel per PATCH.
- **Fehlercode:** `409 Conflict`, `EMPLOYEE_NOT_EMPLOYED_FOR_MONTH`. Kein HTTP 422; kein anderer Code wurde umdefiniert. Der Code steht im Fehlerkatalog (`error-contract.ts`) und in der Frontend-Fehlerbehandlung des Zuordnungsformulars.
- **Prüfungsreihenfolge:** (1) Mitarbeiter 404 (unbekannt oder fremder Tenant), (2) Projekt 404 (unbekannt, fremder Tenant oder ARCHIVED), (3) `EMPLOYEE_INACTIVE`, (4) `PROJECT_INACTIVE`, (5) `EMPLOYEE_NOT_EMPLOYED_FOR_MONTH`, (6) `PROJECT_ASSIGNMENT_ALREADY_EXISTS` bzw. `PROJECT_ASSIGNMENT_CONFLICT`. Die Beschäftigungsdaten werden in derselben gesperrten Mitarbeiter-Abfrage gelesen; die Ablehnung erfolgt vor INSERT und Audit.
- **Auswirkung auf optionale Beschäftigungsdaten:** `employment_start` ist für Stammdaten weiterhin optional. Wer keinen Beschäftigungsbeginn hat, kann aber keinem Monat zugeordnet werden, bis der Beginn gepflegt ist.
- **Bestand:** Keine rückwirkende Migration und keine Neubewertung bestehender Zuordnungen.
- **Offen (formell):** Die privaten Phase-8-Baselines (API-Vertrag, Fehlerkatalog, Validierungs- und Testvertrag) müssen diese Entscheidung formell fortschreiben. Sie wurden hier nicht verändert.

## #64 Fall 1: Beschäftigungsnachweis bei zukünftigen Korrekturen (Owner-Entscheidung 1a, 28.10.2026)

Entscheidung: [#64, Kommentar vom 28.10.2026](https://github.com/takh86/SecurePlan/issues/64#issuecomment-6474708196). Die Fälle 2–5 desselben Issues sind hier **nicht** umgesetzt.

- **Regel:** Bei einer zukünftigen Korrektur (alter **und** neuer Monat nach dem aktuellen Monat) muss die resultierende Kombination aus Mitarbeiter und Monat dieselbe Beschäftigungsregel erfüllen wie der POST (F-1). Das gilt auch, wenn der PATCH nur das Projekt ändert. Geprüft wird nur das Ergebnis; ob die gespeicherte Zuordnung den Nachweis hatte, spielt keine Rolle.
- **Fehlercode:** `409 EMPLOYEE_NOT_EMPLOYED_FOR_MONTH`, mit derselben Bedeutung wie beim POST. Es gibt keinen neuen Code und keine neue Bedeutung eines bestehenden Codes. Abgelehnt wird vor UPDATE und Audit.
- **Prüfungsreihenfolge:** (1) 404 für Zuordnung, Mitarbeiter oder Projekt, (2) Sperren und erneutes Lesen der Zeile (`PROJECT_ASSIGNMENT_CONFLICT` bei zwischenzeitlicher Änderung), (3) No-op, (4) `EMPLOYEE_INACTIVE`, (5) `PROJECT_INACTIVE`, (6) fehlender Beschäftigungsnachweis, (7) Planungsschutz (fail closed, unverändert), (8) `PROJECT_ASSIGNMENT_ALREADY_EXISTS` bzw. `PROJECT_ASSIGNMENT_CONFLICT`.
- **No-op:** Ein PATCH ohne Änderung bleibt 200, ohne Schreibzugriff und ohne Audit. Das gilt auch, wenn die gespeicherte Zuordnung keinen Nachweis mehr hat: Es entsteht kein neuer Zustand, der zu prüfen wäre. Dasselbe gilt schon für die Statusregeln.
- **Historische Korrekturen bleiben unverändert (D2):** Ohne Personenwechsel wird kein Nachweis geprüft. Beim Personenwechsel bleibt es bei `409 PROJECT_ASSIGNMENT_CORRECTION_CONFLICT`. Es gibt keine neue rückwirkende Einschränkung. Ausnahme ist seit Owner-Entscheidung B die Verschiebung in einen Zukunftsmonat (nächster Abschnitt).
- **Sperren:** Die Beschäftigungsdaten stammen aus der bereits mit `FOR NO KEY UPDATE` gesperrten Mitarbeiterzeile. Eine gleichzeitige Änderung der Beschäftigungsdaten wird dadurch serialisiert. Es gibt keine neue Sperre und keine geänderte Sperrreihenfolge.
- **Bestand:** Bestehende Zuordnungen werden weder migriert noch neu bewertet. Eine zukünftige Zuordnung ohne Nachweis, etwa nach einer späteren Änderung der Beschäftigungsdaten (Fall 2, noch nicht umgesetzt), lässt sich erst wieder korrigieren, wenn das Ergebnis den Nachweis hat.
- **Verschiebung aus dem aktuellen oder einem vergangenen Monat in einen Zukunftsmonat:** Diese Lücke war hier zunächst offen. Sie ist durch Owner-Entscheidung B geschlossen (nächster Abschnitt).
- **Tests:** Unit-Matrix `employment-covers.spec.ts`. Real-PostgreSQL: `project-assignments-patch-real.e2e-spec.ts` (nur Projekt, nur Monat, nur Mitarbeiter, kombiniert, Grenzfälle, Schaltjahr, Reihenfolge, No-op, Tenant-Isolation, historische Fälle, Zeitzonen), `project-assignments-patch-concurrency-real.e2e-spec.ts` (gleichzeitige Änderung der Beschäftigungsdaten in beiden Sperrreihenfolgen) und `planning-guards-real.e2e-spec.ts` (Reihenfolge vor dem Planungsschutz).

## #64 Owner-Entscheidung B: historische Korrektur in einen Zukunftsmonat (28.10.2026)

Entscheidung: [#64, Kommentar vom 28.10.2026](https://github.com/takh86/SecurePlan/issues/64#issuecomment-6476351354). Die Fälle 2–5 und DST N-1 sind hier **nicht** umgesetzt.

- **Regel:** Wird eine Zuordnung aus dem aktuellen oder einem vergangenen Monat in einen Zukunftsmonat korrigiert, muss der dokumentierte Beschäftigungszeitraum des resultierenden Mitarbeiters den Zielmonat an mindestens einem Kalendertag überlappen. Das gilt auch, wenn `employeeId` unverändert bleibt. Ob ein Monat aktuell, vergangen oder zukünftig ist, bestimmt die IANA-Zeitzone des Unternehmens (D3).
- **Klassifikation unverändert (D1):** Die Korrektur bleibt eine historische Korrektur, weil der alte Monat zählt. Das Audit protokolliert weiter `scope: HISTORICAL`.
- **Ohne Personenwechsel:** `409 EMPLOYEE_NOT_EMPLOYED_FOR_MONTH`, mit derselben Bedeutung wie beim POST und bei zukünftigen Korrekturen (Zielmonat nicht durch Beschäftigung gedeckt). Es gibt keinen neuen Code.
- **Mit Personenwechsel:** Es bleibt bei der historischen Mitarbeiterwechsel-Prüfung (D2) und ihrem Code `409 PROJECT_ASSIGNMENT_CORRECTION_CONFLICT`. Geprüft wird wie bisher der Zielmonat.
- **Zur Prüfung im ADR-/API-Review:** Für denselben fachlichen Befund (Zielmonat in der Zukunft, kein Nachweis) gibt es damit zwei Codes, je nachdem, ob die Person wechselt. Das folgt der Vorgabe, den D2-Vertrag unverändert zu lassen. Bis zum Review ist es eine Auslegung, kein normativer Vertrag.
- **Prüfungsreihenfolge (unverändert):** (1) 404 für Zuordnung, Mitarbeiter oder Projekt, (2) Sperren und erneutes Lesen der Zeile, (3) No-op, (4) `EMPLOYEE_INACTIVE`, (5) `PROJECT_INACTIVE`, (6) fehlender Beschäftigungsnachweis, (7) Planungsschutz (fail closed), (8) `PROJECT_ASSIGNMENT_ALREADY_EXISTS` bzw. `PROJECT_ASSIGNMENT_CONFLICT`. Abgelehnt wird vor UPDATE und Audit. Mit Entscheidung B galten (4) und (5) nur für neu referenzierte Mitarbeiter und Projekte; seit dem #64-Status-Guard gelten sie bei einem Zukunftsmonat auch für unveränderte (nächster Abschnitt).
- **No-op:** unverändert 200, ohne Schreibzugriff und ohne Audit, auch ohne Nachweis.
- **Korrekturen innerhalb der Historie** (Zielmonat aktuell oder vergangen, auch von einem Zukunftsmonat zurück): unverändert. Ohne Personenwechsel wird kein Nachweis geprüft.
- **Sperren:** Es gibt keine neue Sperre und keine geänderte Sperrreihenfolge. Die Beschäftigungsdaten stammen aus der bereits gesperrten Mitarbeiterzeile.
- **Bestand:** keine rückwirkende Migration, keine automatische Löschung, kein Umschreiben bestehender Zuordnungen.
- **Statusregeln bei dieser Verschiebung:** Zunächst offen geblieben; inzwischen durch den #64-Status-Guard entschieden (nächster Abschnitt).
- **Tests:** Unit-Matrix `employment-covers.spec.ts`. Real-PostgreSQL: `project-assignments-patch-real.e2e-spec.ts` (ohne und mit Nachweis, aus dem vergangenen und dem aktuellen Monat, inklusive Monatsgrenzen, Schaltjahr, Personenwechsel, Korrekturen innerhalb der Historie, Reihenfolge, No-op, Rollen, CSRF, Tenant-Isolation, Berlin gegen New York auch am Jahreswechsel), `project-assignments-patch-concurrency-real.e2e-spec.ts` (gleichzeitige Änderung der Beschäftigungsdaten in beiden Sperrreihenfolgen, Wettlauf mit einem POST) und `planning-guards-real.e2e-spec.ts` (mit Nachweis greift der Planungsschutz weiterhin, ohne Nachweis wird vorher abgelehnt).

## #64 Status-Guard für Zukunftsmonate (Owner-Entscheidung vom 28.10.2026)

Entscheidung: [#64, Kommentar vom 28.10.2026](https://github.com/takh86/SecurePlan/issues/64#issuecomment-6476989126). Die Fälle 2–5 und DST N-1 sind hier **nicht** umgesetzt.

- **Regel:** Liegt der Zielmonat einer wirksamen Korrektur nach dem aktuellen Monat (IANA-Zeitzone des Unternehmens, D3), müssen der resultierende Mitarbeiter und das resultierende Projekt `ACTIVE` sein. Das gilt unabhängig davon, welches Feld der PATCH ändert, also auch für einen unveränderten Mitarbeiter oder ein unverändertes Projekt, wenn nur `monthStart` aus dem aktuellen oder einem vergangenen Monat in die Zukunft wechselt. Die Beschäftigungsprüfung (#64 Fall 1, Entscheidung B) gilt weiterhin zusätzlich.
- **Zukünftige Korrekturen (D1):** unverändert. Sie prüften den Status schon vorher unabhängig vom geänderten Feld; die Regel schwächt nichts ab.
- **Klassifikation unverändert (D1):** Eine Verschiebung aus dem aktuellen oder einem vergangenen Monat in die Zukunft bleibt eine historische Korrektur; das Audit protokolliert weiter `scope: HISTORICAL`.
- **Fehlercodes:** `409 EMPLOYEE_INACTIVE` und `409 PROJECT_INACTIVE`, mit derselben Bedeutung wie beim POST und bei zukünftigen Korrekturen. Es gibt keinen neuen Code und keine neue Bedeutung eines bestehenden Codes.
- **Archivierte Projekte:**
  - **Neu referenziert** (Projektwechsel auf ein archiviertes Projekt): unverändert `404 RESOURCE_NOT_FOUND` wie ein unbekanntes Projekt (F-3), noch vor dem Sperren der Zuordnungszeile.
  - **Unverändert referenziert, Zielmonat in der Zukunft:** `409 PROJECT_INACTIVE`. So antworteten zukünftige Korrekturen schon vor dieser Regel; die Verschiebung aus der Historie in die Zukunft verhält sich jetzt gleich.
  - **Unverändert referenziert, Zielmonat in der Historie:** darf bleiben (D2).
  - **Zur Prüfung im API-Review:** Die Owner-Entscheidung bat darum, für diesen Fall die 404-Semantik von F-3 zu erhalten. F-3 regelt aber nur das Zuordnen oder Umhängen **auf** ein archiviertes Projekt. Für eine unveränderte Referenz in einem Zukunftsmonat antwortete die API bereits mit `409 PROJECT_INACTIVE`. Bei der Umsetzung wurde auf Rückfrage festgelegt (29.10.2026), dieses Verhalten beizubehalten, statt eine bestehende Antwort von 409 auf 404 zu ändern. `PROJECT_INACTIVE` umfasst damit für unveränderte Referenzen weiterhin auch archivierte Projekte. Der Status „archiviert“ wird nicht offengelegt.
- **Prüfungsreihenfolge:** (1) 404 für Zuordnung, Mitarbeiter oder Projekt (unbekannt, fremder Tenant, neu referenziertes archiviertes Projekt), (2) Sperren und erneutes Lesen der Zeile (`PROJECT_ASSIGNMENT_CONFLICT` bei zwischenzeitlicher Änderung), (3) echtes No-op: 200 ohne Schreibzugriff und ohne Audit, auch mit inaktiven Referenzen, (4) `EMPLOYEE_INACTIVE`, (5) `PROJECT_INACTIVE`, (6) fehlender Beschäftigungsnachweis (`EMPLOYEE_NOT_EMPLOYED_FOR_MONTH`, bei historischem Personenwechsel `PROJECT_ASSIGNMENT_CORRECTION_CONFLICT`), (7) Planungsschutz (fail closed, unverändert), (8) `PROJECT_ASSIGNMENT_ALREADY_EXISTS` bzw. `PROJECT_ASSIGNMENT_CONFLICT`. Bei einem Zielmonat in der Historie gelten (4) und (5) wie bisher nur für neu referenzierte Mitarbeiter und Projekte. Abgelehnt wird vor UPDATE und Audit.
- **Korrekturen innerhalb der Historie und aus der Zukunft zurück:** unverändert (D2). Unveränderte inaktive oder archivierte Referenzen dürfen bleiben.
- **Sperren:** Es gibt keine neue Sperre und keine geänderte Sperrreihenfolge. Der Status stammt aus den bereits gesperrten Zeilen (Mitarbeiter `FOR NO KEY UPDATE`, Projekt `FOR SHARE`). Eine gleichzeitige Deaktivierung, ein Inaktivsetzen oder Archivieren wird dadurch serialisiert.
- **Bestand:** keine rückwirkende Migration, keine automatische Löschung, kein Umschreiben bestehender Zuordnungen.
- **Tests:** Unit-Matrix `correction-status-conflict.spec.ts`. Real-PostgreSQL: `project-assignments-patch-real.e2e-spec.ts` (vergangener und aktueller Monat in die Zukunft mit unveränderter deaktivierter Person, inaktivem oder archiviertem Projekt, jeweils nur Monat, mit ausdrücklich unveränderten IDs und mit Wechsel der anderen Referenz; Positivfall mit Audit `HISTORICAL`; Zukunft zu Zukunft; Zukunft zurück in die Historie; Reihenfolge inklusive No-op; Rollen, CSRF und Tenant-Isolation; Berlin gegen New York auch am Jahreswechsel), `project-assignments-patch-concurrency-real.e2e-spec.ts` (Statusänderung festgeschrieben oder zurückgerollt, während die Korrektur wartet, und die umgekehrte Sperrreihenfolge) und `planning-guards-real.e2e-spec.ts` (Statusablehnung vor Beschäftigungsprüfung und Planungsschutz).
- **Offen:** Die privaten Phase-8-Baselines sind für diese Regel noch nicht formell fortgeschrieben.
