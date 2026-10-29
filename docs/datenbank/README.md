# Datenbankdesign – öffentliche Übersicht

Stand: 29.10.2026, Implementierungsbaseline `7107781`. PostgreSQL 17 ist der verwendete Persistenzstack. Die öffentliche [Domainübersicht](domain-overview.md) erklärt zentrale fachliche Begriffe, ohne das interne Physical Schema zu veröffentlichen.

Migrationen bis `0009` enthalten Identity/Sessions/Audit sowie Workforce-/Projekt-/Zuordnungs-/Schichtkonfigurations-Persistenz. Echte Planungstabellen fehlen noch. Die [Abschlussevidenz #64/#73](../reviews/sp09-closeout-64-73.md) verlinkt bestehende isolierte CI-/Real-PG-Nachweise; der reine Dokumentationsaudit führt keine DB-Tests oder Migrationen aus.

[Identity](auth-persistence-handoff.md), [Command-Zuverlässigkeit](idempotency-handoff.md) und [Workflow/Zeitmodell](workflow-shift-handoff.md) sind allgemeine öffentliche Zusammenfassungen. Detaillierte Schema-, Constraint-, Index- und Operationsunterlagen bleiben separat.

Verbindliche nächste Übergabe: [SP-11 D1–D6 und LOCK-01](sp11-integrity-handoff.md). Beide temporären Guards bleiben fail closed; ihre realen Prüfungen für Assignment-PATCH/DELETE und Schicht-PATCH müssen mit der ersten Planungstabellen-Integration freigegeben und getestet werden. Kein Guard-Bypass durch neue Tabellen.
