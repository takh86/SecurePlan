# SecurePlan

B2B-SaaS für Personal- und Einsatzplanung in Sicherheitsunternehmen. Praxisphase im B.Sc. Informatik an der THM; Fokus auf Backend Engineering mit nachvollziehbaren Anforderungen, Architekturentscheidungen und Tests.

**Stand: 30.10.2026 · geprüfte main-Baseline `5752ca8` · SP-10 im Implementierungsreview**

NestJS-Backend und React-Frontend enthalten Account-Aktivierung, Login/Sessions, Rollen-/Tenant-Schutz, Mitarbeiter, Projekte, Monatszuordnungen und deren freigegebene Korrektur-/Entfernungsabläufe. SP-10 ergänzt administrative Krank-/Urlaubsmarker mit Vorschau, Bestätigung und atomaren Zeitraumbatches. [SP-10-Evidenz und Grenzen](docs/reviews/sp10-availability.md) trennen implementiertes Verhalten, ausgeführte Tests und ausstehende Abnahme. Planung/Dienste sind noch nicht implementiert; Browser-Smoke und Browser-E2E bleiben NOT_RUN.

## Produkt und verbindlicher MVP

- Persönliche Accounts, Session Auth, Rollen und serverseitige Tenant-Isolation.
- Mitarbeiter, Projekte und monatliche Projektzuordnungen.
- Manueller Monatsplan, einmaliges Initial Publish und Mitarbeiteransicht.
- Absagen, Ersatzangebote und atomare Ersatzentscheidung.
- Planbasierte Statistik und abgeleitete Admin Work Queue.
- Validation, stabile Fehlerverträge, Audit-Minimum, Tests, OpenAPI und reproduzierbare Demo.

Excel-Import ist Stretch. Tagesplan, Lohnabrechnung und vollständige Notifications gehören nicht zum verbindlichen Praktikums-MVP. Statistik beschreibt Planung, nicht tatsächliche Anwesenheit.

## Stack und Architektur

| Bereich | Stand |
| --- | --- |
| Backend | TypeScript, NestJS, Node.js 24, ESM |
| Frontend | React, TypeScript, Vite |
| Persistenz | PostgreSQL 17; `pg`, SQL-first Migrationen und Domain-Persistenz bis SP-10 |
| Architekturziel | Tenant-aware Modular Monolith; Identity/Workforce/Audit vorhanden, Planning folgt separat |
| Qualität | Oxlint, Backend Vitest/Supertest, TypeScript Builds, GitHub Actions |

Company = Tenant; jedes Account gehört einer Company. TenantContext wird aus der serverseitigen Identität abgeleitet. Nach dem ersten Publish wirken berechtigte Änderungen direkt nach erfolgreichem Commit; es gibt keinen parallelen Draft/Re-Publish. CR-01 entfernt das frühere Ersatzkontingent.

## Lokal starten

Voraussetzungen: Git, **Node.js 24.x**, npm 11 und Docker mit Compose v2. Alle Befehle im Repository-Root ausführen. Die Beispielzugangsdaten sind ausschließlich für eine lokale Datenbank mit synthetischen Daten.

```bash
git clone https://github.com/takh86/SecurePlan.git
cd SecurePlan
npm ci
cp .env.example .env
npm run db:up
npm run db:migrate
npm run db:verify
```

PowerShell: `Copy-Item .env.example .env` statt `cp`, falls nötig.

Zwei Terminals starten:

```bash
npm run dev:backend
```

```bash
npm run dev:frontend
```

Frontend: HTTPS gemäß `vite.config.ts`, mit den dort referenzierten lokalen Zertifikaten. Backend: http://127.0.0.1:3000. Lokale Konfiguration und Voraussetzungen der [Frontend-](apps/frontend/README.md) und [Backend-README](apps/backend/README.md) beachten.

- `GET /` – Starterantwort.
- `GET /api/v1/health/live` – Prozess erreichbar.
- `GET /api/v1/health/ready` – Verbindung und Foundation-Migration vorhanden; sonst HTTP 503.

Health-Endpunkte sind technische Betriebsendpunkte zusätzlich zu den implementierten Business-Routen. Readiness allein prüft keine vollständige fachliche Abnahme.

```bash
npm run lint
npm run typecheck
npm run build
npm test
npm run test --workspace=frontend
npm run test:e2e
npm run test:scripts
npm run check:public
npm run start:backend
```

`start:backend` benötigt einen vorherigen Build. Backend-HTTP/E2E umfasst sowohl Test-Doubles als auch echte PostgreSQL-Integrations-/Concurrency-Suites. DB- und Skripttests schreiben Fixtures und verlangen vor Testbeginn einen [verifizierten wegwerfbaren PostgreSQL-Container samt Identitätsnachweis](docs/testing/disposable-postgres.md). Die Entwicklungs-`.env` ist kein Test-Fallback. Ohne expliziten Nachweis verweigert der Testlauncher den Start vor dem ersten Fixture-Write.

## Datenbank und Migrationen

`npm run db:down` stoppt die lokale Datenbank, erhält aber das Volume. Für eine vorhandene PostgreSQL-Instanz genügt eine angepasste `DATABASE_URL`; Docker ist dann optional. `.env` wird nicht eingecheckt.

Migrationen liegen in `apps/backend/migrations`. Der Runner serialisiert Aufrufe über einen Advisory Lock, prüft SHA-256-Prüfsummen und führt jede neue Datei samt Ledger-Eintrag atomar aus. Bereits angewendete Dateien nicht verändern; neue Änderungen erhalten eine neue Migration. Ein zweiter Lauf muss ohne erneuten Effekt funktionieren.

Migrationen bis `0010` enthalten Foundation, Identity/Sessions/Audit, Workforce-/Projekt-/Monatszuordnungs-/Schichtkonfigurations-Persistenz und tägliche Verfügbarkeitsmarker samt technischen Batch-Datensätzen. Planungstabellen fehlen noch. Ihr Einführen erfordert die gleichzeitige freigegebene Integration beider [SP-11-Abhängigkeitsprüfungen](docs/datenbank/sp11-integrity-handoff.md); die temporären Guards bleiben bis dahin fail closed. Interne Spezifikationen werden separat gepflegt.

## Repository-Struktur

| Pfad | Verantwortung |
| --- | --- |
| `apps/backend` | API, Backendtests, Migrationen |
| `apps/frontend` | React-Webclient für die implementierten Auth-/Verwaltungsabläufe |
| `infra/docker` | Lokale PostgreSQL-Instanz |
| `scripts` | Migration und DB-Verifikation |
| `.github/workflows` | Build, Lint, Tests, PostgreSQL-Smoke-Checks |
| `docs` | Anforderungen, öffentliche Designzusammenfassungen, Planung und Review-Nachweise |

## Dokumentation und nächste Schritte

- [Dokumentationsindex](docs/README.md)
- [Wirksame MVP-Baseline](docs/requirements/effective-mvp-baseline.md)
- [Architektur](docs/architektur/ueberblick.md)
- [Aktueller Projektstatus](docs/project-status.md)
- [SP-01 Setup-Evidenz](docs/reviews/setup-evidence.md)
- [Öffentliche und interne Dokumentation](docs/public-documentation.md)
- [Öffentliche Reviewübersicht](docs/reviews/g0-handoff.md)
- [Aktueller Arbeitsabschnitt](docs/planung/aktuelle-woche.md)

Nächste Schritte sind das unabhängige SP-10-Code-Review und die tatsächliche Browserabnahme; SP-11 folgt mit eigener Vertragsfreigabe. #64/#73 sind laut GitHub geschlossen; datierte Abschlussunterlagen bleiben als historische Nachweise erhalten. E-Mail-Produktion und [Security-/Operations-Gates #51](docs/security/pre-staging-gates.md) bleiben offen. Kein automatisches Issue-Schließen, Merge oder Deployment. [Contribution Guide](CONTRIBUTING.md) beschreibt Branches und Review.

**Nachweisregel:** DOCUMENTED ≠ IMPLEMENTED ≠ VERIFIED ≠ PRODUCTION READY.

## Veröffentlichungsumfang

Dieses öffentliche Repository zeigt die Engineering-Case-Study und freigegebenen Code. Detaillierte interne Sicherheits-, Datenbank- und Vertragsspezifikationen werden separat gepflegt. Reale Zugangsdaten und Kundendaten werden nicht veröffentlicht. [Dokumentationsregeln](docs/public-documentation.md).
