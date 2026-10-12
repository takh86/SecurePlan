# ADR-0001 — Readiness-Check mit HTTP 503 und SERVICE_UNAVAILABLE

**Status:** Angenommen  
**Datum:** 12.10.2026  
**Entscheidung durch:** Product Owner / Projektverantwortlicher (im SecurePlan-Review ausdrücklich freigegeben)  
**Geltungsbereich:** Ausschließlich `GET /api/v1/health/ready` (operativer Readiness-Check)  
**Referenzen:** Interne API-Designbaseline Phase 8.5 (Fehlervertrag), Phase 8.11 (konsolidierte API-Baseline); SP-02, PR #13.

## Kontext

SecurePlan verwendet für API-Fehler RFC 9457 Problem Details mit stabilen Anwendungscodes. Die genehmigte fachliche Fehlercode-Liste nennt keinen Status 503 bzw. Code `SERVICE_UNAVAILABLE`. Ein Readiness-Check kann jedoch bei einer nicht verfügbaren Betriebsabhängigkeit (z. B. Datenbank) vorübergehend **nicht bereit** sein, ohne dass dies einen unerwarteten Programmierfehler oder fachlichen Konflikt darstellt.

Der implementierte Readiness-Endpunkt liefert für diesen Zustand bereits HTTP 503 mit `SERVICE_UNAVAILABLE`. Vor dem Merge von SP-02 wird diese bewusst eng gefasste Abweichung als **operative Vertragsergänzung** dokumentiert und genehmigt.

## Betrachtete Optionen

### Option A — Operative 503-Ergänzung (gewählt)
- **Vorteile:** Korrekte HTTP-Semantik für fehlende Bereitschaft; Überwachung und Orchestrierung können zwischen nicht bereit und internen Fehlern unterscheiden; konsistente Problem-Details-Repräsentation.
- **Nachteile:** Ein zusätzlicher stabiler Code muss dokumentiert und dauerhaft kompatibel gehalten werden.
- **Risiko:** Eine spätere, unbeabsichtigte Verwendung des Codes für normale Business-API-Endpunkte würde den fachlichen Fehlerkatalog verwässern.

### Option B — 500 INTERNAL_ERROR (verworfen)
- **Vorteil:** Keine Ergänzung des bisherigen Katalogs.
- **Nachteil:** Eine erwartbare temporäre Nichtbereitschaft würde fälschlich als unerwarteter interner Fehler klassifiziert und die Betriebsdiagnose verschlechtern.

### Option C — 503 ohne stabilen Code / ohne Problem Details (verworfen)
- **Vorteil:** Kein zusätzlicher SecurePlan-Anwendungscode.
- **Nachteil:** Inkonsistente Fehlerrepräsentation gegenüber der zentralen API-Fehlerbehandlung; Clients müssten eine Ausnahme beim Response-Parsing berücksichtigen.

## Entscheidung

**Option A ist angenommen.** Wenn `GET /api/v1/health/ready` erkennt, dass die Anwendung nicht betriebsbereit ist, liefert die API:

- HTTP-Status `503 Service Unavailable`
- Content-Type `application/problem+json`
- Problem-Details-Extension `code: "SERVICE_UNAVAILABLE"`
- `type: "/problems/service-unavailable"`
- `instance: "/problems/occurrences/{correlationId}"`
- `X-Correlation-ID` im Header, identisch zum `correlationId` im Response-Body
- Neutrale, sichere Client-Meldung ohne interne Fehlerursache, Connection Strings, SQL, Credentials oder Stack Trace.

`SERVICE_UNAVAILABLE` ist **keine** generische Erlaubnis, neue 503-Business-Fehler einzuführen, und ersetzt nicht den `500 INTERNAL_ERROR`-Fallback für unerwartete Fehler. Die Ergänzung gilt ausschließlich für den genannten operativen Endpunkt. Der erfolgreiche Readiness-Check bleibt HTTP 200; der Liveness-Check prüft keine Datenbankbereitschaft.

**Ausschlaggebender Grund:** Der HTTP-Status 503 beschreibt einen temporären Betriebszustand präziser als 500 und erlaubt eine konsistente, sichere maschinenlesbare Fehlerantwort.

## Konsequenzen

**Positiv:** Readiness-Monitoring erhält die korrekte HTTP-Semantik. Der bereits implementierte und getestete Endpunkt bleibt ohne unnötigen Codewechsel nutzbar.

**Negativ / Trade-off:** Die bisherige Fehlercode-Liste wird um eine ausdrücklich begrenzte operative Ausnahme erweitert. Clients dürfen `SERVICE_UNAVAILABLE` nur zusammen mit HTTP 503 interpretieren. Ein weiteres Ausweiten erfordert einen neuen dokumentierten Entscheid.

**Bei Revision:** Betrieb/Monitoring, API-Client-Tests und die öffentliche Fehlercode-Semantik müssten gemeinsam migriert werden.

## Sicherheit und Datenintegrität

Readiness gibt nur den aggregierten Zustand zurück; es werden keine Datenbankdetails, Hostnamen, Query-Texte, Credentials oder sonstige sensible Laufzeitdaten veröffentlicht. Der Code darf weder Authentication- noch Authorization-Entscheidungen ersetzen. Die Antwort enthält keine Kundendaten.

## Verifikation / Grenzen

- SP-02 Backend-E2E deckt HTTP 503 für nicht bereite Abhängigkeit ab.
- Backend/Frontend-Contract-Tests prüfen die sichere Fehlerrepräsentation und Codebehandlung; der lokale Stand vor diesem ADR war 51/51 Tests PASS.
- GitHub Actions für PR #13 (`Foundation CI`, Run #22) war vor diesem reinen Dokumentationscommit erfolgreich.
- Neue inhaltliche API-Funktionen, Retry-Automatismen und Logging-Tuning sind **nicht** Bestandteil dieser Entscheidung. Insbesondere gibt es hier keine generelle Freigabe, beliebige POST/PATCH-Kommandos automatisch zu wiederholen.

## Nachweis des Verständnisses

- [x] Entscheidung ist anhand des operativen Readiness-Zustands erklärbar.
- [x] Beide Alternativen und ihre Nachteile sind dokumentiert.
- [x] Vertragliche Erweiterung und ihr enger Geltungsbereich sind benannt.
