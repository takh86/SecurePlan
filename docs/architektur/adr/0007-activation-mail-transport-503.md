# ADR-0007 — HTTP 503 bei nicht verfügbarem Aktivierungs-Mailtransport

**Status:** Angenommen  
**Datum:** 11.11.2026  
**Entscheidung durch:** Product Owner / Projektverantwortlicher; ausdrückliche Freigabe im SecurePlan-Review am 11.11.2026  
**Geltungsbereich:** Ausschließlich `POST /api/v1/employees` bei fehlendem Aktivierungs-Mailtransport  
**Referenzen:** Issue #129, PR #132, ADR-0001, Phase 8.5 / 8.11 API-Baseline, SP-07.

## Kontext

Mitarbeiterkonten werden zunächst als `PENDING_ACTIVATION` erstellt. Außerhalb `NODE_ENV=development` ist derzeit kein genehmigter Aktivierungs-Mailtransport vorhanden. Eine Kontoanlage trotz dieses bekannten Mangels würde nicht aktivierbare Konten erzeugen. Das bisherige ADR-0001 genehmigte `503 SERVICE_UNAVAILABLE` ausdrücklich nur für den Readiness-Endpunkt. Für die Mitarbeiteranlage ist daher eine eigenständige, eng gefasste Vertragserweiterung erforderlich.

## Betrachtete Optionen

### Option A — Operatives `503 SERVICE_UNAVAILABLE` begrenzt erweitern (gewählt)
- **Vorteile:** Fehlende Betriebsabhängigkeit wird semantisch korrekt signalisiert; bestehende Problem-Details-Verarbeitung verwendbar, kein neuer Anwendungscode.
- **Nachteile:** Dokumentierte Erweiterung des bisherigen API-Vertrags erforderlich.
- **Risiko:** Ohne Begrenzung könnten fachliche Fehler fälschlich 503 verwenden.

### Option B — `500 INTERNAL_ERROR` (verworfen)
- **Vorteil:** Keine neue Fehlervertragsregel.
- **Nachteil:** Ein vorhersehbarer Betriebszustand wird fälschlich als unerwarteter interner Fehler dargestellt.

### Option C — `400/409` oder neuer fachlicher Fehlercode (verworfen)
- **Vorteil:** Separat benennbare Antwort.
- **Nachteil:** Weder Eingabe noch fachlicher Datensatz sind fehlerhaft; eine neue Fachkennung würde ein Betriebsproblem verwechselbar machen.

## Entscheidung

**Option A wird genehmigt.** Wenn bei `POST /api/v1/employees` von vornherein kein genehmigter Aktivierungs-Mailtransport verfügbar ist, wird vor jeder Datenpersistenz mit HTTP `503 Service Unavailable`, `Content-Type: application/problem+json`, `code: "SERVICE_UNAVAILABLE"` und `type: "/problems/service-unavailable"` geantwortet. Die vorhandenen `correlationId`-/`X-Correlation-ID`-Regeln gelten unverändert. Der Client erhält nur einen sicheren, neutralen Fehlertext ohne Zugangsdaten, SMTP-Details, Token oder E-Mail-Adressen.

**Die Authentifizierung und Autorisierung haben Vorrang:** Unberechtigte Zugriffe behalten `401`/`403` und werden nicht als `503` verschleiert. Im 503-Pfad dürfen weder Mitarbeiter-, Konto-, Aktivierungstoken- noch zugehörige Erstellungs-Audit-Einträge entstehen.

**Ausschlaggebender Grund:** Fehlende Aktivierungs-Mailinfrastruktur ist eine operative Nichtverfügbarkeit, kein fachlicher Eingabefehler.

## Abgrenzung und Konsequenzen

- ADR-0001 bleibt als eigenständige Entscheidung für `GET /api/v1/health/ready` unverändert. ADR-0007 ergänzt ausschließlich den oben benannten Mitarbeiter-Endpunkt; es ist **keine generelle Freigabe** für weitere Business-Endpunkte.
- In Development bleibt die synthetische `@secureplan.test`-Empfängerbeschränkung bestehen; abgelehnte Empfänger erhalten vor Persistenz die bestehende `400 VALIDATION_FAILED`-Antwort.
- Ein **erst nach einem erfolgreichen Commit** eintretender SMTP-Zustellfehler bleibt getrennt: bestehendes `201`/`PENDING_ACTIVATION`, Token-Widerruf und Audit. Der sichtbare Zustellstatus und ein Recovery-API-Vertrag benötigen eine separate Entscheidung.
- Der Beschluss genehmigt weder einen produktiven Mailtransport noch eine Änderung der Sicherheitsgrenzen. Ohne genehmigten Transport bleibt die Mitarbeiteranlage außerhalb Development bewusst nicht verfügbar.
- Keine automatische Wiederholung und kein `Retry-After`-Header werden zugesichert.
- Bei späterer Revision müssen Backend-Vorprüfung und Problem-Details-Filter, Frontend-Vertrag, Dokumentation sowie Tests gemeinsam überprüft werden.

## Sicherheit und Datenintegrität

Rollen-/Tenant-Prüfung bleibt vorrangig; vorbekannter Ausfall führt zu keiner Persistenz. Der Fehlertext bleibt neutral. Ein erfolgreicher Preflight garantiert nicht die spätere SMTP-Zustellung.

## Nachweis des Verständnisses

- [x] Entscheidung, Endpoint und Abgrenzung sind erklärt.
- [x] Zwei verworfene Alternativen sind begründet.
- [x] Verfügbarkeit, Fehlervertrag und Datenintegrität sind gegeneinander abgewogen.
