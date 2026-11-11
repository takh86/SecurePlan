# Lokaler Docker-Stack

Lokale Entwicklungsumgebung mit synthetischen Daten. **Kein Produktions-Deployment** (siehe „Bekannte Grenzen“).

| Dienst | Image | Erreichbar | Zweck |
| --- | --- | --- | --- |
| `frontend` | `secureplan-frontend:local` (nginx) | `https://localhost:8443` (nur Loopback) | React-Build, TLS, Proxy `/api/` → `backend:3000` |
| `backend` | `secureplan-backend:local` (Node 24) | nur im Compose-Netz | NestJS-API, `NODE_ENV=development` |
| `postgres` | `postgres:17` | `127.0.0.1:5432` | Volume `docker_secureplan_pgdata` |
| `mailpit` | `axllent/mailpit:v1.31.5` | UI `http://127.0.0.1:8025`, SMTP `127.0.0.1:1025` | fängt Aktivierungsmails ab |

Alle Dienste haben Healthchecks; `frontend` startet erst bei gesundem Backend (Readiness inkl. DB).

## Voraussetzungen

- Docker Desktop mit Compose v2 (verifiziert: Compose v5.5.1)
- Node.js **24.x** und npm 11 auf dem Host (Migrationen, Denylist-Build, Tests)
- [mkcert](https://github.com/FiloSottile/mkcert) für das lokale TLS-Zertifikat

## Einrichtung (einmalig)

1. `npm ci`
2. `.env` aus `.env.example` anlegen und **zusätzlich** setzen (nicht in `.env.example` enthalten):
   - `SECUREPLAN_LOGIN_HMAC_KEY` – 64 Hex-Zeichen, z. B. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `SECUREPLAN_PASSWORD_DENYLIST_PATH` – absoluter Pfad der Datei aus `scripts/build-password-denylist.mjs`
   - `APP_ORIGIN=https://localhost:8443` (der Wert aus `.env.example` wird vom Login-Origin-Guard abgelehnt)

   Fehlt einer der ersten beiden Werte, bricht jeder `docker compose`-Aufruf mit einem Hinweis auf diese Datei ab.
3. TLS-Zertifikat (gitignored, nie committen): `mkcert -install`, dann
   `mkcert -cert-file infra/tls/localhost.pem -key-file infra/tls/localhost-key.pem localhost 127.0.0.1`

Zertifikat, Schlüssel, `.env` und Denylist werden zur Laufzeit read-only gemountet bzw. als Variable übergeben; `.dockerignore` hält sie aus den Images heraus.

## Start, Status, Stopp (Repository-Root)

```powershell
npm run stack:up      # baut beide Images und wartet, bis alle Dienste healthy sind
npm run stack:ps
npm run db:migrate    # vom Host gegen 127.0.0.1:5432; idempotent
npm run db:verify
npm run stack:down    # entfernt Container und Netz, NICHT das Volume
```

`npm run db:up` / `db:down` starten bzw. stoppen nur `postgres` und `mailpit` – für den Host-Entwicklungsmodus (`dev:backend` + `dev:frontend`). Host-Modus und Docker-`frontend` belegen beide Port 8443; nur eins davon gleichzeitig.

Migrationen laufen bewusst nur vom Host (das Backend-Image enthält weder `scripts/` noch Migrationsdateien). Nach einem neuen Pull also `npm run db:migrate` vor bzw. nach `stack:up`.

## Onboarding-Demo (Mailpit)

1. Als `COMPANY_ADMIN` unter `https://localhost:8443` anmelden.
2. Mitarbeitende mit einer Adresse **`…@secureplan.test`** anlegen. Andere Domains lehnt die lokale Umgebung vor jedem Schreibzugriff mit `400 VALIDATION_FAILED` (`#/email`) ab (Issue #129); die UI zeigt den Hinweis am E-Mail-Feld.
3. Mail in `http://127.0.0.1:8025` öffnen, Link `https://localhost:8443/activate#token=…` aufrufen, Passwort setzen, anmelden.

Scheitert der Versand trotz gültiger Adresse (z. B. Mailpit gestoppt), bleibt der Mitarbeitende angelegt, der Token wird widerrufen und `ACCOUNT_ACTIVATION_DELIVERY_FAILED` auditiert; die API antwortet weiterhin `201` mit `PENDING_ACTIVATION`. Wiederherstellung über das interne Werkzeug (kein HTTP-Endpunkt):

```powershell
$env:SP07_COMPANY_ID = '<company-uuid>'; $env:SP07_EMPLOYEE_ID = '<employee-uuid>'
node --env-file=.env scripts/reissue-employee-activation.mjs
```

## Migrationen und Zeilenenden

Der Runner hasht die **exakten Dateibytes**. Mit `core.autocrlf=true` (Windows) hängen diese vom Checkout ab; nur neuere Migrationen sind per `.gitattributes` auf `eol=lf` fixiert. Das Ledger einer Datenbank hält deshalb die Bytes, die beim Anwenden auf der Platte lagen – das kann je Datei CRLF oder LF sein.

Meldet `db:migrate`
`Applied migration NNNN_… differs from the ledger only in line endings`,
ist nur das Zeilenende der Arbeitskopie anders als beim Anwenden. Abhilfe: Zeilenenden **dieser Datei** in der Arbeitskopie auf den aufgezeichneten Stand zurücksetzen (Inhalt unverändert). Niemals das Ledger editieren, die Prüfung abschalten oder die Datenbank neu aufsetzen. Die Prüfung bleibt ein harter Fehler; die Meldung nennt nur den Dateinamen.

Eine Git-Operation, die Dateien neu auscheckt (Checkout, Stash, Reset), kann die Zeilenenden ändern. Vorher prüfen:
`git ls-files --eol apps/backend/migrations/`.

## Prüfungen

```powershell
docker compose --env-file .env -f infra/docker/compose.yaml config -q
docker exec docker-frontend-1 nginx -t
curl.exe --ssl-no-revoke -s -o NUL -w "%{http_code}" https://localhost:8443/api/v1/health/ready   # 200
```

DB-schreibende Tests (`test:e2e`, `test:scripts`) laufen **nie** gegen dieses Volume, sondern nur gegen einen [verifizierten Wegwerf-Container](testing/disposable-postgres.md).

## Backup und Wiederherstellung

```powershell
docker exec docker-postgres-1 pg_dump -U secureplan -d secureplan -Fc -f /tmp/secureplan.dump
docker cp docker-postgres-1:/tmp/secureplan.dump "$env:USERPROFILE\SecurePlanBackups\secureplan-$(Get-Date -Format yyyyMMdd-HHmm).dump"
```

Ein Restore ist **nicht verifiziert**. Vor einem echten Restore zuerst in einen Wegwerf-Container einspielen und mit `db:verify` prüfen; nie direkt über das Entwicklungs-Volume.

## Sicheres Aufräumen

- `npm run stack:down` erhält Daten. **Niemals** `docker compose down -v`, `docker volume rm docker_secureplan_pgdata` oder `docker system prune --volumes`.
- Wegwerf-Testcontainer nur nach Prüfung ihres exakten Labels/IDs entfernen, nie per breitem Prune.

## Fehlersuche

| Symptom | Ursache / Abhilfe |
| --- | --- |
| `required variable SECUREPLAN_… is missing` | Variable in `.env` ergänzen (siehe Einrichtung). |
| Login/Logout `503` | `APP_ORIGIN` ist nicht `https://localhost:8443`. |
| `frontend` startet nicht, Bind-Fehler `localhost.pem` | Zertifikat fehlt in `infra/tls/`. |
| `backend` unhealthy | `docker logs docker-backend-1` – Logs enthalten Ereignis + Korrelations-ID, keine Secrets. Readiness `503` = DB nicht erreichbar oder nicht migriert. |
| Aktivierungsmail fehlt | Adresse muss auf `@secureplan.test` enden; `docker logs docker-backend-1` auf `employee.activation.delivery_failed` prüfen; Reissue s. o. |
| `429` bei Aktivierung/Login | Drosselung; hinter nginx teilen sich alle Clients einen Zähler (s. u.). `Retry-After` abwarten. |

## Bekannte Grenzen (Produktionsblocker)

- **Client-IP hinter dem Proxy:** Das Backend vertraut bewusst keinen `X-Forwarded-*`-Headern (kein `trust proxy`). Login-IP-Limit (60/15 min, `login_abuse_counters`) und Aktivierungs-Drosselung (5/min, `ThrottlerGuard`) sehen daher nur die nginx-Adresse: **alle Clients teilen sich einen Zähler**. Lokal unkritisch, für jede gemeinsam genutzte Umgebung ein Verfügbarkeitsrisiko. Lösung (eng begrenzte Proxy-Vertrauensgrenze) erfordert eine eigene Sicherheitsentscheidung.
- Kein Mailversand außerhalb `NODE_ENV=development`; Produktions-Mailpolicy ist ein separates Gate.
- Zugangsdaten der lokalen Datenbank stehen in `compose.yaml` (nur synthetische Daten, nur Loopback).
- Keine Content-Security-Policy im nginx (gleicher Stand wie der Vite-Dev-Server).
- Image-Builds sind nicht bit-identisch reproduzierbar (gleiche Quelle kann andere Image-IDs ergeben); Basis-Images `node:24-bookworm-slim`, `nginx:stable-alpine`, `postgres:17` sind nicht per Digest fixiert.
