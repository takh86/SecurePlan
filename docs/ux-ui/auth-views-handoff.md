# Activation/Reset Views – G0-R03

Stand: 07.10.2026. Ergänzung zum bestehenden UX-Handoff; keine implementierten Screens.

| View | Eingabe und Zustände | Erfolg / Navigation |
| --- | --- | --- |
| Activation | Token vom Link; Passwort + Bestätigung; loading, field-validation, invalid/expired/used, network/error | Initiales Passwort gesetzt; zum Login, kein impliziter Auto-Login |
| Reset request | E-Mail; loading, syntaktischer Fehler, rate-limit, neutraler Erfolg | Gleicher Text unabhängig von Accountexistenz: „Wenn ein passendes Konto existiert, erhältst du weitere Informationen.“ |
| Reset completion | Token; neues Passwort + Bestätigung; invalid/expired/used, submitting, error | Passwort geändert, frühere Sessions ungültig; Login |
| Login/session expired | E-Mail + Passwort; submitting, neutraler credentials-error, delay, session-expired | /me bestimmt erlaubte Navigation; Rücksprung nur auf erlaubten lokalen Pfad |

Passwordmanager/Paste zulassen; keine Passwortnormalisierung; Fieldlabels und Fehlermeldungen programmgesteuert verknüpfen. Beim Fehler Fokus auf Zusammenfassung, Erfolg als zugängliche Statusmeldung; Tastaturbedienung und Touchgrößen prüfen. Kein Tokenscan durch Analytics, keine externen Assets auf Tokenviews; Referrer-Policy no-referrer. Token früh aus URL entfernen und nur flüchtig in Memory halten. Zustandswechsel dürfen nicht versehentlich den Token verbrauchen; nur expliziter Submit konsumiert ihn.

Acceptance: loading verhindert Doppelsubmit; Server bleibt dennoch atomar; expired/used/invalid verständlich; Reset request neutral; Passwort nie im Log; Navigation/Reload-Verhalten testen; Reauth nach Sessionexpiry.
