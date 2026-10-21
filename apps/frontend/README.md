# SecurePlan Frontend

React/TypeScript mit Vite. Start über `npm run dev:frontend` im Repository-Root (https://localhost:8443, `/api` wird an das Backend weitergeleitet). Build: `npm run build --workspace=frontend`, Tests: `npm run test --workspace=frontend`. Setup: [Root-README](../../README.md).

## Stand (F1)

- Aktivierung (`/activate`), Login, Logout und Sitzungswiederherstellung über `GET /api/v1/me` (SP-04/SP-05). Session-Cookie bleibt HttpOnly; CSRF-Token und Identität nur im React-Speicher.
- Authentifizierte App-Shell mit rollenbezogener Navigation, Deep Links und Browser-Zurück/Vor (`react-router`, deklarativer Modus). Geschützte Inhalte erscheinen nur nach erfolgreichem Login oder `GET /me`; nach Logout wird die URL auf `/` zurückgesetzt.
- Zwei **Read-only-UI-Vorschauen mit synthetischen Demodaten**; alle übrigen Bereiche sind sichtbar als „folgt“ markierte Platzhalter.

| Pfad | Rolle (`/me`) | Stand |
|---|---|---|
| `/arbeitsuebersicht` | `COMPANY_ADMIN` | UI-Vorschau: offene Absage-/Ersatzvorgänge |
| `/mitarbeitende`, `/projekte`, `/monatsplanung` | `COMPANY_ADMIN` | Platzhalter |
| `/mein-monatsplan`, `/mein-monatsplan/JJJJ-MM` | `EMPLOYEE` | UI-Vorschau: persönlicher Monatsplan |
| `/absagen-und-ersatz`, `/meine-statistik` | `EMPLOYEE` | Platzhalter |

Die Rollenprüfung im Frontend dient nur der Bedienbarkeit. Autorisierung und Tenant-Isolation entscheidet ausschließlich der Server für jede API-Anfrage.

## Demodaten und Integrationsnaht

- Screens laden Daten nur über eine `ReadSource` (`src/shared/data/data-source.ts`) mit `kind: 'preview' | 'api'`. Die Vorschau-Quellen (`*-preview-source.ts`) liefern Fixtures aus dem Speicher: kein Netzwerkaufruf, keine Persistenz, kein erfundener Endpunkt.
- Ist die Quelle `preview`, zeigt der Screen den Hinweis „Demodaten / UI-Vorschau“ und beschriftet Dienstzeiten als „Beispielzeit“.
- **Dienstzeiten in den Vorschauen sind synthetische Beispielwerte** (`src/shared/preview/synthetic-shift-times.ts`), keine freigegebenen Schicht- oder Planungsregeln. Echte Schichtarten und Zeiten sind projektbezogen und kommen künftig aus der API.
- Die View-Model-Typen (`*-types.ts`) sind keine API-Verträge. Eine spätere API-Quelle bildet den freigegebenen Vertrag auf diese Typen ab, ohne die Screens neu zu schreiben.
- Datumswerte kommen über eine injizierbare `Clock` (`src/shared/time/clock.ts`), damit Tests deterministisch sind.

## Blockierte Integrationen

- Admin Work Queue: kein implementierter `/admin/work-queue`-Vertrag; Fallbearbeitung, Entscheidungen und Ersatzauswahl fehlen daher bewusst.
- Persönlicher Monatsplan: kein implementierter `/me/...`-Planvertrag; Zeitzone der Company und Schichtzeiten sind offen.
- Firmenname: `/me` liefert nur die Company-ID, die nicht angezeigt wird.
- Sitzungsablauf in einem anderen Tab wird erst beim nächsten `GET /me` (Neuladen, Wiederherstellung aus dem Browser-Cache) oder Logout erkannt; mit echten Daten ist eine zentrale 401-Behandlung nötig.

## Bekannte Grenzen

- Monatsnavigation: Gültig sind nur Monate von `2000-01` bis `2099-12` (`parseMonth`). Die Links „Vorheriger/Nächster Monat“ werden an den Rändern trotzdem erzeugt (z. B. `2099-12` → `2100-01`); ein solcher Link leitet per `replace` auf `/mein-monatsplan` (aktueller Monat) um. Begrenzen bzw. Deaktivieren der Navigation ist ein offener P2-Punkt und noch nicht umgesetzt.
