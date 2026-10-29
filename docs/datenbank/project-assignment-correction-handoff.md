# Korrektur von Monatszuordnungen: Regeln und Übergabe an SP-11

Stand: 26.10.2026, ergänzt am 28.10.2026 um #64 Fall 1 und Owner-Entscheidung B sowie am 29.10.2026 um den #64-Status-Guard für Zukunftsmonate und um #73 (Entfernen von Zuordnungen künftiger Monate, `version`). Betrifft `PATCH` und seit #73 `DELETE /api/v1/project-assignments/{assignmentId}` (SP-09, Stand PARTIAL).

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

Entfernen von Zuordnungen des aktuellen oder eines vergangenen Monats (seit #73 gibt es `DELETE` nur für Zukunftsmonate, siehe Abschnitt „#73“) und ein formell freigegebener Audit-Aktionskatalog.

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

## #73: Entfernen von Zuordnungen künftiger Monate (29.10.2026)

Entscheidungen: [PO-Freigabe D73-1 bis D73-5, D73-8, R1, R2](https://github.com/takh86/SecurePlan/issues/73#issuecomment-6491464511) und [finaler TL/API-Sign-off mit Revision R2](https://github.com/takh86/SecurePlan/issues/73#issuecomment-6492654582) (Delta: [Kommentar 6492472218](https://github.com/takh86/SecurePlan/issues/73#issuecomment-6492472218)). #64 Fall 2 ist hier **nicht** umgesetzt.

### Vertrag

- **Endpunkt:** `DELETE /api/v1/project-assignments/{assignmentId}`, nur `COMPANY_ADMIN`. Origin, Sitzung, CSRF und Rolle prüft der globale Guard; der Actor wird in der Transaktion erneut geprüft. Kein Body und keine Query werden gelesen.
- **Pflicht-Header `Expected-Version`:** genau eine positive Dezimalzahl ohne Vorzeichen und führende Null, höchstens `9007199254740991`. Der Wert ist die `version` der Zuordnung, die der Admin bestätigt hat. `If-Match` wird nicht ausgewertet und hat keinen Vorrang; es gibt kein ETag, kein 412 und kein 428.
- **Erfolg:** `204 No Content` mit `Cache-Control: no-store`. Die Zeile wird physisch gelöscht; in derselben Transaktion entsteht ein Audit-Ereignis `PROJECT_ASSIGNMENT_REMOVED` (vorläufiger MVP-Name) mit `old_values = { employeeId, projectId, monthStart }` (vollständiges entferntes Tupel), `new_values = null`, Unternehmen, Actor und Correlation-ID. Schlägt das Audit fehl, wird nichts gelöscht.
- **Nur Zukunftsmonate:** `planning_month` muss nach dem aktuellen Monat des Unternehmens liegen (IANA-Zeitzone `companies.time_zone`, D3).
- **Nicht geprüft (PO):** Status von Mitarbeiter und Projekt sowie Beschäftigungsnachweis. Eine unerwünschte Zukunftszuordnung einer deaktivierten Person ist entfernbar.
- **Keine Kaskade:** kein Ersatz, keine Vakanz, keine Änderung von Beschäftigungsdaten oder Diensten. Der Monat ist danach für eine neue, bewusste Zuordnung (POST) frei.
- **Schema:** keine Migration, kein neuer Fehlercode. Der Kommentar der bereits angewendeten Migration `0008` („no DELETE endpoint“) bleibt unverändert, weil angewendete Migrationen unveränderlich sind; maßgeblich ist dieser Abschnitt.

| Status / Code | Wann |
|---|---|
| 401 / 403 | Guard (Origin → Sitzung → CSRF → Rolle), vor jeder Parameterprüfung; Actor-Recheck in der Transaktion |
| 404 `RESOURCE_NOT_FOUND` | ID-Format ungültig (vor der Header-Prüfung); unbekannt, fremder Tenant oder bereits entfernt (nach der Header-Prüfung). Gleicher Body für alle Fälle; eine Wiederholung schreibt kein zweites Audit |
| 400 `EXPECTED_VERSION_REQUIRED` | Header fehlt (auch wenn nur `If-Match` gesendet wird) |
| 400 `INVALID_EXPECTED_VERSION` | leer, nicht dezimal, 0, Vorzeichen, führende Null, Nachkommastellen, Exponent, außerhalb des sicheren Bereichs oder mehrfach gesendet (Node fügt Duplikate zu `a, b` zusammen, auch bei gleichem Wert) |
| 409 `PROJECT_ASSIGNMENT_CONFLICT` | Tupel unter der Zeilensperre geändert oder Version veraltet (auch nach A→B→A) |
| 409 `PROJECT_ASSIGNMENT_CORRECTION_CONFLICT` | Monat ist der aktuelle oder ein vergangener (D73-2, ausdrücklich freigegebene Auslegung) oder der Planungsschutz E-10 greift |
| 500 `INTERNAL_ERROR` | fail closed, z. B. Version außerhalb des unterstützten Bereichs |

**Reihenfolge:** Guard → 404 ID-Format → 400 Header (erste Anweisung im Handler; NestJS führt an `@Headers()` keine Pipes aus, ein Pipe dort würde still übersprungen) → Actor-Recheck → 404 Lookup → Sperren Mitarbeiter (`FOR NO KEY UPDATE`) → Projekt (`FOR SHARE`) → Zeile (`FOR UPDATE`) → 404 verschwunden / 409 Tupel geändert → 409 Version → 409 Monat → 409 Planungsschutz → DELETE und Audit → 204. Jede Ablehnung schreibt nichts und kein Erfolgs-Audit.

### `version` (S-2 Revision R2, ohne Migration)

- **Wert:** `(extract(epoch FROM updated_at) * 1000000)::bigint`, also `updated_at` in Epoch-Mikrosekunden. Er steht in jeder Antwort von LIST, POST und PATCH, auch beim No-op. Clients behandeln ihn als opakes Token, nicht als Zeitstempel und nicht als Berechtigung.
- **Umwandlung:** node-pg liefert den `bigint` als Dezimalstring. Der Mapper akzeptiert nur `^[1-9][0-9]{0,15}$`, einen sicheren Integer und eine exakte Rundreise; sonst 500. Nie über JS `Date` (nur Millisekunden) oder `date_part` (Gleitkomma).
- **Unterstützter Bereich:** `1970-01-01T00:00:00.000001Z` (1) bis `2255-06-05T23:47:34.740991Z` (2^53 − 1). Außerhalb antworten LIST, No-op-PATCH und DELETE fail closed mit 500, ohne den Wert zu zeigen.
- **Schreibinvariante:** Jeder **wirksame** UPDATE von `project_assignments` setzt `updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')` (`PROJECT_ASSIGNMENT_TOUCH`). Ein echtes No-op schreibt nichts. INSERT behält den Default. Damit steigt die Version je Zeile streng, auch bei eingefrorener oder zurückgestellter Uhr und innerhalb derselben Mikrosekunde; ein veraltetes Token kann nie einer späteren Version gleichen (kein ABA, keine Kollision).
- **No-op-PATCH:** antwortet seit #73 mit der **gesperrten** Zeile statt mit dem ungesperrten Erstlesen, damit nach einem zwischenzeitlichen A→B→A keine veraltete Version ausgeliefert wird.
- **Grenze (akzeptiert, nicht blockierend):** Die Invariante ist nicht in der Datenbank erzwungen. Ein Schreibzugriff per SQL außerhalb der Anwendung ohne diese Regel würde die Version nicht ändern. Abgesichert durch den statischen Tripwire `assignment-version-tripwire.spec.ts` und die Betriebsregel „keine unreviewten Schreibzugriffe“ (Pre-Staging-Gate).

### Oberfläche (Projekt → Monatspanel)

- „Entfernen“ steht neben „Korrigieren“. Ob die Aktion angeboten wird, hängt nur am Zeitpunkt, nicht an der Browser-Zeitzone: Alle unterstützten Zonen liegen zwischen UTC−12 und UTC+14. Ist der Monat in keiner Zone mehr künftig, fehlt die Aktion; im Fenster von etwa 26 Stunden um einen Monatswechsel wird sie mit dem Hinweis angeboten, dass die Zeitzone des Unternehmens entscheidet. Bei korrekter Geräteuhr wird nie eine entfernbare Zeile verborgen; der Server entscheidet immer.
- Die Inline-Bestätigung ist an die angezeigte Zeile gebunden (ID, Version, Person, Projekt, Monat) und nennt, was **nicht** passiert. Jedes Ergebnis lädt den Monat neu und schließt die Bestätigung; eine abgelehnte Entfernung wird nie automatisch wiederholt. Eine neue Bestätigung verwendet die frisch geladene Version.
- Ein Netzwerkfehler gilt als „Ergebnis unbekannt“: kein Retry, Neuladen zeigt den tatsächlichen Stand.

### Tests (Real-PostgreSQL, synthetische Daten)

- `project-assignments-remove-real.e2e-spec.ts`: Erfolg mit Audit-Inhalt und Correlation-ID, freier Monat danach; aktueller, vergangener, nächster Monat und Folgejahr; Berlin gegen New York am Monatsende und am Jahreswechsel; Statusunabhängigkeit; fehlende, ungültige, doppelte (Rohsocket und Array-Header) und nicht-ASCII-Header; `If-Match` ohne Wirkung; veraltete Version nach jeder Korrekturart, A→B→A, nie ausgegebene Version; exakte Mikrosekunden; LIST/POST/PATCH-Antwort gleich folgendem LIST; No-op, abgelehnter und zurückgerollter PATCH; eingefrorene Uhr (+1 µs je Schreibvorgang); Bereichsgrenzen fail closed; Reihenfolge Guard → ID → Header → Version → Monat; Wiederholung, unbekannt und fremder Tenant mit identischem 404; Rollen, abgelaufene und widerrufene Sitzung, CSRF, Origin; Actor-Recheck nach Rollen- bzw. Firmenänderung; ignorierte Tenant-Hinweise in Body und Query; Audit-Fehler rollt zurück.
- `project-assignments-remove-concurrency-real.e2e-spec.ts` (deterministische Sperr-Barrieren, kein Sleep): zwei Entfernungen (COMMIT und Rollback der ersten); Entfernen gegen Korrektur (Personenwechsel, Zukunftsmonat, in die Historie) in beiden Reihenfolgen und mit zurückgerollter Korrektur; Änderung zwischen ungesperrtem Lesen und Sperre (anderes Tupel, A→B→A); No-op-PATCH liefert nach A→B→A die gesperrte Version; Entfernen gegen POST, Beschäftigungsänderung, Deaktivierung und Projektstatus in beiden Reihenfolgen; Stresslauf mit Tausch-Korrekturen ohne Deadlock und ohne 500; Touch-Regel unter Nebenläufigkeit und Uhrschiefe.
- `planning-guards-real.e2e-spec.ts`: Mit einer Planungsrelation scheitert das Entfernen einer Zukunftszeile mit gültiger Version fail closed; veraltete Version und Nicht-Zukunftsmonat werden davor abgelehnt; nach dem Rollback funktioniert das Entfernen wieder.
- `route-access-inventory.e2e-spec.ts`: genau eine zusätzliche Route `DELETE /api/v1/project-assignments/:assignmentId`, nur `COMPANY_ADMIN`.

### SP-11-Übergabe (D73-6/D73-9, verbindlich)

1. Das Entfernen ist der dritte Nutzer von `assertPlanningDependencyCheckImplemented` und ruft es nach den Sperren, der Versions- und der Monatsprüfung auf. Der Guard bleibt fail closed; es gibt keinen Bypass.
2. Der erste PR, der echte Planungstabellen anlegt, ersetzt die anwendbaren temporären Guards (Korrektur **und** Entfernen) **in derselben Integrations-Slice** durch echte tenant-, monats- und zuordnungsbezogene Prüfungen. Sonst sind beide Operationen gesperrt; zusammen mit einem durchgesetzten #64 Fall 2 wäre ein vorzeitiger Austritt dann nicht mehr erfassbar.
3. Tabellen aus SP-10 (Verfügbarkeit) werden nach ihrem tatsächlichen Schema klassifiziert, nicht nach der Phase.
4. Vorschlag zur Ablehnungsregel (Entscheidung PO/TL bei SP-11): Entfernen von (Person, Projekt, Monat) wird abgelehnt, solange ein geplanter Dienst bzw. eine Plan-Zuordnung dieser Person auf diesem Projekt in diesem Monat existiert, veröffentlicht oder nicht. Code `409 PROJECT_ASSIGNMENT_CORRECTION_CONFLICT`, ohne Plandetails. Abhilfe: zuerst die Dienste im Planungsablauf ändern, dann die Monatszuordnung entfernen.
5. Jeder künftige Schreiber, der eine Abhängigkeit von einer Monatszuordnung erzeugt, nimmt vor der Revalidierung die Mitarbeiterzeile mindestens `FOR SHARE` oder eine mit DELETE kollidierende Sperre bzw. einen FK auf die Zuordnungszeile. Beide Sperrreihenfolgen sind mit Real-PostgreSQL-Tests zu belegen.
6. Jeder künftige Schreiber von `project_assignments` hält die Versions-Schreibinvariante ein (der Tripwire schlägt sonst an).

### Offboarding-Ablauf und offene Punkte

- **Ablauf:** künftige Zuordnungen der Person finden → jede unerwünschte einzeln entfernen (je ein Audit-Ereignis) → Beschäftigungsende im Mitarbeiterstamm setzen → optional deaktivieren → später und getrennt einen Ersatz zuordnen. Nichts wird automatisch angelegt.
- **Offen (D73-7 / S-9):** Schritt 1 hat noch keinen eigenen Aufruf; das Monatspanel je Projekt reicht für das Offboarding nicht aus. Eine mitarbeiterbezogene Abfrage oder eine begrenzte Konfliktliste im 409 von #64 Fall 2 ist ein Gate vor #64 Fall 2.
- **Offen (S-8):** Der Korrektur-PATCH hat weiterhin keine Vorbedingung; sein Lost-Update-Fall bleibt bewusst außerhalb von #73.
- **Pre-Staging:** Audit-Unveränderlichkeit, Aufbewahrung und Zugriff sowie die Versionsgrenze, siehe `docs/security/pre-staging-gates.md`.
