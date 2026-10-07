# Auth/Security-Handoff – G0-R03

Stand: 07.10.2026. Phase 9.2 v1.1 bleibt normative Designquelle; diese Ergänzung ist **Reviewentwurf**, keine neue Product-Owner-Freigabe und keine implementierte Auth.

## Bereits entschieden

15–128 Zeichen laut API-Validation, kein Passwort-Trim/Normalization, keine Kompositionspflicht, Paste/Passwordmanager erlaubt, verbreitete/kompromittierte Passwörter ablehnen. Argon2id initial 19 MiB/t=2/p=1, auf Zielsystem benchmarken. Serverseitige PostgreSQL-Sessions, server-derived TenantContext, Default Deny, Ownership + Business-State. MFA ist Praktikums-Stretch und Production-Gate.

Protected unsafe methods: Session + Origin + synchronizer CSRF. Public Login/Activation/Reset: erlaubte Origin, Abuse-Limit und neutrale Fehler. Login/Reset-Antworten dürfen unbekannte Accounts nicht offenlegen; Dummy-Hashpfad und einheitliches Timingbudget vorsehen.

## Konfigurationsvorschläge – reviewen vor Activation

| Parameter | Vorschlag | Status |
| --- | --- | --- |
| Activation expiry | 24 Stunden | Nicht durch Quelle festgelegt; Review offen |
| Reset expiry | 30 Minuten | Review offen |
| Account failures | 5 in 15 Minuten, anschließend progressive delay | Baseline entschieden |
| Delay nach Schwelle | 1/2/4/8/16/30 Sekunden, cap 30s; timestampbasierte Sperrfrist, kein blockierender sleep | Ausgestaltung offen |
| IP boundary | Login 60 / 15min, Reset request 10 / 15min; shared database-backed store im MVP | Vorschlag; Proxy/Shared-IP-Fairness prüfen |
| Password blocklist | Versionierte lokale Liste für Demo; Quelle/Lizenz/Updateprozess vor Deployment | Review offen |
| Delivery | Lokaler Test-Mailer oder tatsächlicher SMTP-Provider | Ownerentscheidung offen; nichts eingerichtet |
| Local Auth HTTPS | Lokaler TLS-Reverse-Proxy vor Frontend/API, same-origin | Vor Auth-Integration konfigurieren |

Die jetzige HTTP-Foundation setzt keine Auth-Cookies. Sichere Cookies werden bei der Implementierung nicht stillschweigend deaktiviert. Providerzugang/Budget und öffentliche Staging-Origin sind nicht angenommen.

Manuell übergebene Testlinks nur für synthetische Demo-Accounts: sie beweisen keine Mailbox-Ownership. Tokens weder in öffentlichen API-Responses noch Applicationlogs ausgeben. E-Mail-Link muss über konfigurierte origin erzeugt werden, nicht aus einem beliebigen Host-Header.

## Acceptance / Security-Negativfälle

Pending/deactivated Account und suspended Company abweisen; fremder Tenant/Ownership abweisen; Reset neutral; Missing/wrong Origin und CSRF abweisen; Rate-Limits auch für unbekannte E-Mail; keine Passwort-/Token-/SQL-Leaks; Reset und Deactivation widerrufen alle Sessions; Privilegänderung invalidiert/rotiert Session. IP-Ermittlung nur über ausdrücklich vertraute Proxies. Accountbasierte Limits benötigen atomare Zähler, keinen prozesslokalen Map-Ersatz.
