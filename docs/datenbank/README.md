# Datenbankdesign – öffentliche Übersicht

Stand: 07.10.2026. PostgreSQL ist der geplante Persistenzstack. Die öffentliche [Domainübersicht](domain-overview.md) erklärt zentrale fachliche Begriffe, ohne das interne Physical Schema zu veröffentlichen.

Die Foundation enthält einen Migrationsrunner und eine kleine technische Probe. Produktmigrationen und Domain-Persistenz sind noch nicht implementiert. [Laufnachweise](../reviews/setup-evidence.md) unterscheiden Tests mit Test-Doubles und echte PostgreSQL-Smoke-Checks.

[Identity](auth-persistence-handoff.md), [Command-Zuverlässigkeit](idempotency-handoff.md) und [Workflow/Zeitmodell](workflow-shift-handoff.md) sind allgemeine öffentliche Zusammenfassungen. Detaillierte Schema-, Constraint-, Index- und Operationsunterlagen bleiben separat.
