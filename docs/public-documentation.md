# Öffentliche Dokumentation und interne Unterlagen

Dieses Repository ist eine öffentliche Engineering-Case-Study. Es zeigt Problem, Scope, allgemeine Architektur, Entwicklungsprozess, ausführbaren freigegebenen Code und nachvollziehbare Build-/Testnachweise.

Nicht zur Veröffentlichung vorgesehen: echte Kundendaten, personenbezogene Betriebsdaten, Zugangsdaten, Produktionskonfigurationen, ausführliche Threat Models, vollständige interne Schemas/API-Verträge, interne Sicherheitsparameter und nicht freigegebene Reviewberichte. Interne Dokumente werden separat gepflegt und nicht unter diesem Git-Repository gespeichert.

`.env.example` und lokale Compose-/CI-Werte sind absichtlich synthetisch. Öffentlicher Code und seine Entwicklungsbeispiele können von Besuchern gelesen werden; `.gitignore` ist kein Zugriffsschutz und entfernt keine bereits gespeicherten Commits. Vor einer Veröffentlichung müssen sensible Inhalte aus Code, Dateien, PRs, Issues und Artefakten geprüft werden.

`npm run check:public` prüft den aktuellen getrackten Dateiinhalt auf bestimmte Credentialmuster und verbotene interne Pfade. Das ist eine zusätzliche Kontrolle, kein vollständiger Secret- oder Datenschutz-Audit und keine Bereinigung von Git-Historie.
