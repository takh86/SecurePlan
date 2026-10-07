# SecurePlan Backend

NestJS/TypeScript mit Node.js 24 und ESM. Setup und Befehle stehen im [Root-README](../../README.md). Noch keine Auth- oder Business-API implementiert.

`DatabaseService` besitzt einen kleinen PostgreSQL-Pool. Readiness prüft die Foundation-Migration; DB-Fehler werden nicht an den Client ausgegeben. Shutdown schließt den Pool. Der Entwicklungsserver bindet an Loopback; eine spätere Container-/Staging-Konfiguration braucht ein ausdrücklich konfiguriertes Interface.

[Auth-Handoff](../../docs/datenbank/auth-persistence-handoff.md) und [G0](../../docs/reviews/g0-handoff.md) steuern die nächsten Änderungen.
