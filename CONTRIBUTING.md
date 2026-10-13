# Entwicklung und Review

Feature-Branches von `main`: `feat/<thema>`, `fix/<thema>` oder `chore/<thema>`. Kleine nachvollziehbare Commits, z. B. `feat(auth): add account activation`. Keine Secrets, personenbezogenen Kundendaten oder `.env` committen.

Vor einem PR: `npm run lint`, `npm run build`, `npm test`, `npm run test --workspace=frontend`, `npm run test:e2e`; für Persistenzänderungen außerdem Migration + DB-Verifikation.

PR beschreibt Problem, Verhalten, Scope, Akzeptanzkriterien, Testevidenz und verbleibende Grenzen. Fehlende Tests als `NOT_RUN` markieren. `main` wird erst nach Review und grünen relevanten Checks integriert.

Migrationen sind nach Anwendung unveränderlich. Feature-Tests aus Acceptance Criteria ableiten, insbesondere Ownership, Tenant-Isolation, parallele Writes und Rollback.

Zusätzliche Schutzregeln wie verpflichtende Reviews müssen im GitHub-Repository konfiguriert werden; dieses Dokument aktiviert keine Branch Protection.

Vor Veröffentlichung: `npm run check:public`; außerdem [Dokumentationsregeln](docs/public-documentation.md) beachten. Interne Unterlagen außerhalb dieses Repositories pflegen.

## Pull Request Review Checklist

### 1. Branch und Scope

- [ ] Der Pull Request richtet sich gegen den Branch `main`.
- [ ] Die Änderungen gehören ausschließlich zur beschriebenen Aufgabe.
- [ ] Der PR enthält keine unbeabsichtigten Änderungen oder temporären Testdateien.

### 2. Codequalität und Tests

- [ ] Backend- und Frontend-Build sind erfolgreich.
- [ ] Linting wurde ohne Fehler abgeschlossen.
- [ ] Backend Unit Tests wurden erfolgreich ausgeführt.
- [ ] Frontend Tests wurden erfolgreich ausgeführt.
- [ ] Backend E2E Tests wurden erfolgreich ausgeführt.
- [ ] Fehlende oder nicht ausgeführte Tests sind als `NOT_RUN` dokumentiert.

### 3. Datenbank und Migrationen

- [ ] Bei Datenbankänderungen wurden Migrationen überprüft und erfolgreich ausgeführt.
- [ ] Die Datenbankverifikation wurde erfolgreich abgeschlossen.
- [ ] Tests verwenden ausschließlich isolierte Testdaten und keine produktiven Daten.
- [ ] Bekannte Einschränkungen der Datenbanktests sind dokumentiert.

### 4. Sicherheit

- [ ] Es wurden keine Secrets, Passwörter oder Zugangsdaten veröffentlicht.
- [ ] Es wurden keine `.env`-Dateien oder personenbezogenen Kundendaten committed.
- [ ] Sicherheitsrelevante Änderungen wurden auf Authentication, Authorization und Input Validation geprüft, soweit zutreffend.

### 5. Pull Request Review und Merge

- [ ] Der Code-Diff wurde vollständig überprüft.
- [ ] Die Änderungen erfüllen die relevanten Acceptance Criteria.
- [ ] Die GitHub Actions Pipeline ist erfolgreich abgeschlossen.
- [ ] Testnachweise und bekannte Einschränkungen sind im Pull Request dokumentiert.
- [ ] Die erforderliche Code-Review- und Merge-Entscheidung liegt vor.
- [ ] Der Merge erfolgt erst nach erfolgreicher Prüfung aller relevanten Quality Gates.

**Hinweis:** Eine erfolgreiche CI-Pipeline allein verhindert keinen Merge. Verbindliche Merge-Sperren müssen über GitHub Branch Protection oder Repository Rulesets konfiguriert und überprüft werden.