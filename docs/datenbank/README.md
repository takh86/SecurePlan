# Datenbankdesign und Implementierungshandoff

Stand: 07.10.2026. Phase 7.1–7.3 sind laut Quellgate Designfreigaben; [Physical DB 7.2](../design-sources/SecurePlan_Phase_7.2_PostgreSQL_Physical_Database_Design_v1.0.md) ist jetzt repo-lokal lesbar.

| Bereich | Status |
| --- | --- |
| Foundation-Migration | Runner + Probe unter apps/backend/migrations |
| Account/Session/Token | [Auth-Persistenzentwurf](auth-persistence-handoff.md), Umsetzung/Review offen |
| Idempotency | [8.7-Abgleich](idempotency-handoff.md), keine Businessmigration |
| Workflow/Schichtzeiten | [Mapping und Optionen](workflow-shift-handoff.md), Reviewentscheidung offen |
| Produkt-DB insgesamt | Nicht migriert / nicht als fertig geprüft |

Der Runner definiert noch kein ORM und keine vollständige operative Backup-/Restore-Strategie. [Laufnachweise](../reviews/setup-evidence.md) unterscheiden echte DB-Smoke-Checks und Test-Doubles.
