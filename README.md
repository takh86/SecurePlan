# SecurePlan

B2B-SaaS für Personal- und Einsatzplanung in Sicherheitsunternehmen. Praxisphase im B.Sc. Informatik an der THM; Fokus auf Backend Engineering mit nachvollziehbaren Anforderungen, Architekturentscheidungen und Tests.

**Stand: 07.10.2026 · SP-01 Foundation VERIFIED · G0: DESIGN READY FOR FIRST IDENTITY SLICE**

Der Repository-Stand enthält ein NestJS-Backend und ein React-Frontend. Die lokale Foundation ist unter Windows und in Linux-CI reproduzierbar nachgewiesen. Die Benutzeroberfläche ist noch der Starter. Auth, Mitarbeiterverwaltung und Planung sind entworfen, aber noch nicht implementiert. Build- und Foundationtests belegen keine fertigen Produktfunktionen.

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
| Persistenz | PostgreSQL 17; `pg` als Foundation-Verbindung, SQL-first Migrationen |
| Architekturziel | Tenant-aware Modular Monolith; fachliche Module noch aufzubauen |
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

Frontend: http://localhost:5173. Backend: http://127.0.0.1:3000.

- `GET /` – Starterantwort.
- `GET /api/v1/health/live` – Prozess erreichbar.
- `GET /api/v1/health/ready` – Verbindung und Foundation-Migration vorhanden; sonst HTTP 503.

Health-Endpunkte sind technische Betriebsendpunkte, zusätzlich zu den entworfenen MVP-Endpunkten. Sie prüfen keine fertig implementierte Business-Domäne.

```bash
npm run lint
npm run build
npm test
npm run test:e2e
npm run start:backend
```

`start:backend` benötigt einen vorherigen Build. Die E2E-Startertests ersetzen den DB-Provider durch einen Test-Double; echte PostgreSQL-Evidenz kommt separat aus `db:verify`, lokalem Runtime-Check und CI.

## Datenbank und Migrationen

`npm run db:down` stoppt die lokale Datenbank, erhält aber das Volume. Für eine vorhandene PostgreSQL-Instanz genügt eine angepasste `DATABASE_URL`; Docker ist dann optional. `.env` wird nicht eingecheckt.

Migrationen liegen in `apps/backend/migrations`. Der Runner serialisiert Aufrufe über einen Advisory Lock, prüft SHA-256-Prüfsummen und führt jede neue Datei samt Ledger-Eintrag atomar aus. Bereits angewendete Dateien nicht verändern; neue Änderungen erhalten eine neue Migration. Ein zweiter Lauf muss ohne erneuten Effekt funktionieren.

`0001_foundation.sql` ist eine kleine Infrastrukturprobe. Produkt-, Account-, Session- und Workflowtabellen sind noch nicht migriert. Die nächste Arbeit betrifft Identity und die fachliche Persistenz; genaue interne Spezifikationen werden separat gepflegt.

## Repository-Struktur

| Pfad | Verantwortung |
| --- | --- |
| `apps/backend` | API, Backendtests, Migrationen |
| `apps/frontend` | Webclient – aktuell Starter |
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

G0 ist als Design-/Handoff-Gate für den ersten Identity-Slice abgeschlossen. Nächster Schritt: Validation/Errorhandling, danach Activation/Reset → Login/Logout/Session → Tenant/RBAC implementieren und testen. E-Mail-Zustellung und Deployment sind noch nicht nachgewiesen. [Contribution Guide](CONTRIBUTING.md) beschreibt Branches und Review.

**Nachweisregel:** DOCUMENTED ≠ IMPLEMENTED ≠ VERIFIED ≠ PRODUCTION READY.

## Veröffentlichungsumfang

Dieses öffentliche Repository zeigt die Engineering-Case-Study und freigegebenen Code. Detaillierte interne Sicherheits-, Datenbank- und Vertragsspezifikationen werden separat gepflegt. Reale Zugangsdaten und Kundendaten werden nicht veröffentlicht. [Dokumentationsregeln](docs/public-documentation.md).
