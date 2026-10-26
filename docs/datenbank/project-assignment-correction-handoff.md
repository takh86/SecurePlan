# Korrektur von Monatszuordnungen: Regeln und Übergabe an SP-11

Stand: 26.10.2026. Betrifft `PATCH /api/v1/project-assignments/{assignmentId}` (SP-09, Stand PARTIAL).

## Umgesetzte Regeln (Owner-Entscheidungen D1–D5)

- **Wer, was:** Nur `COMPANY_ADMIN` des eigenen Unternehmens. Korrigierbar sind `employeeId`, `projectId` und `monthStart`; mindestens ein Feld (`EMPTY_PATCH`). Das vollständige Ergebnis-Tupel wird neu validiert. Eine Korrektur ohne Änderung antwortet 200, ohne Schreibzugriff und ohne Audit.
- **Aktueller Monat (D3):** wird in der IANA-Zeitzone des Unternehmens (`companies.time_zone`) bestimmt, nie in UTC. Die Uhr ist über das Token `WALL_CLOCK` austauschbar, damit Monatsgrenzen deterministisch getestet werden (Europe/Berlin und America/New_York, auch am Jahreswechsel).
- **Zukünftige Korrektur (D1):** alter und neuer Monat liegen nach dem aktuellen Monat. Der Ergebnis-Mitarbeiter und das Ergebnis-Projekt müssen `ACTIVE` sein.
- **Historische Korrektur (D1/D2):** alter oder neuer Monat ist der aktuelle oder ein vergangener Monat. Eine bereits referenzierte inaktive Person oder ein bereits referenziertes inaktives Projekt darf bleiben. **Neu referenziert** werden darf nur Aktives. Wird die Person getauscht, muss ein dokumentierter Beschäftigungszeitraum den Monat überlappen; ein fehlender Beschäftigungsbeginn gilt als **kein Nachweis** (`409 PROJECT_ASSIGNMENT_CORRECTION_CONFLICT`). Diese Auslegung von „historische Korrekturbedingungen“ ist konservativ und noch nicht formell freigegeben.
- **Mitarbeiterwechsel (D4):** erlaubt. Sperrreihenfolge unabhängig von der Änderungsrichtung: handelnder Admin → Mitarbeiter nach aufsteigender ID → Projekte nach aufsteigender ID → Zuordnungszeile. Die Zeile wird unter der Sperre erneut gelesen; eine zwischenzeitliche Änderung ergibt `409 PROJECT_ASSIGNMENT_CONFLICT`, kein stilles Überschreiben.
- **Archivierte Projekte (F-3):** als Ziel `404`. Eine bestehende Zuordnung auf ein archiviertes Projekt bleibt lesbar.
- **Audit (D5):** `PROJECT_ASSIGNMENT_CORRECTED` (vorläufiger MVP-Name, kein freigegebener Katalog). `old_values`/`new_values` enthalten nur geänderte IDs und `monthStart`, dazu `scope` (`FUTURE` oder `HISTORICAL`). Keine Namen, E-Mail-Adressen oder Mitarbeiter-IDs im Klartext.

## Planungsdaten: fail closed, keine Annahme von Sicherheit

Monatspläne, Dienste und Plan-Zuordnungen (`monthly_plans`, `duties`, `plan_assignments`) existieren erst ab SP-10/SP-11. Dass sie fehlen, gilt **nicht** als Nachweis, dass eine Korrektur sicher ist.

- `planning-dependency-guard.ts` prüft zur Laufzeit, ob eine dieser Tabellen existiert. Existiert eine, schlagen alle Korrekturen mit `409 PROJECT_ASSIGNMENT_CORRECTION_CONFLICT` fehl, bis der Guard ersetzt ist.
- Ein Real-PostgreSQL-Test legt jede der drei Tabellen innerhalb einer zurückgerollten Transaktion an und weist dieses Verhalten nach.

### Aufgaben für SP-11 (vor Auslieferung)

1. Den Guard durch die echte Prüfung ersetzen (D-8.4-13): Eine Korrektur darf keine bestehende Plan-Zuordnung ungültig machen, weder für die alte noch die neue Kombination aus Person, Projekt und Monat. Veröffentlichte Pläne werden nie stillschweigend verändert.
2. Tests: Korrektur mit bestehenden Diensten und veröffentlichtem Plan (409), ohne Abhängigkeit (200), je Richtung (Person, Projekt, Monat), Nebenläufigkeit mit Dienstanlage.
3. `EMPLOYEE_HAS_FUTURE_ASSIGNMENTS` bei der Deaktivierung (D-8.4-11) ergänzen.
4. Die Lock-Reihenfolge der Planung gegen die Reihenfolge dieser Korrektur prüfen (Planung sperrt Dienst vor Zuordnungen, siehe 8.7).

## Nicht enthalten

Oberfläche für Korrekturen, Entfernen von Zuordnungen (der Vertrag sieht kein DELETE vor) und ein formell freigegebener Audit-Aktionskatalog.

## Restrisiko Sitzungsablauf (kein Polling)

Es gibt bewusst kein periodisches `GET /me`, weil jeder Aufruf die Leerlaufzeit der Sitzung verlängern würde. Beibehalten sind die Prüfung beim Fokus (bfcache-Rückkehr), bei Navigation und bei jedem Request sowie die Cross-Tab-Signale für Logout und Login. Verbleibend: Ein Tab ohne jede Aktion zeigt nach einem serverseitigen Ablauf der Sitzung weiter seine zuletzt geladenen Daten, bis die nächste Aktion eine 401 liefert. Schreibzugriffe und Lesezugriffe sind serverseitig weiterhin geschützt.
