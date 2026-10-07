# G0 – Review und Implementierungshandoff

Stand: 07.10.2026. Reviewbasis: `main` Commit `1fb8983`, bereitgestellte Phasen 2–10, CR-01/02/03. Diese PR ergänzt Foundation und konsolidiert Dokumente; G0 wird nicht allein durch Dokumentmenge bestanden.

## Review-Ergebnis

Repository enthielt NestJS/React-Starter, striktes TypeScript und Startertests, aber keinen DB-Pfad, keine Migration und keine CI. README/Status verwiesen veraltet auf API 8.1. API 8.11 (06.10.) und Security 9.1–9.4 v1.1 liegen als Design vor.

| ID | Befund | Änderung / Status | Acceptance / Dependency |
| --- | --- | --- | --- |
| G0-R01 | Phase-10-Wording widerspricht CR-03 | [Planungsabgleich](../planung/g0-backlog.md); DOCUMENTED | SP-12/13/20/22 ohne parallelen Draft/Re-Publish implementieren |
| G0-R02 | Auth-Persistenz fehlte | [Schema/Sequenzen](../datenbank/auth-persistence-handoff.md); REVIEW DRAFT | Composite FKs, single consume, revocation in echten Migrationtests; vor SP-04/05 |
| G0-R03 | Delivery/Views/operative Werte offen | [Security](../security/auth-handoff.md), [Views](../ux-ui/auth-views-handoff.md); NEEDS DECISION/REVIEW | Delivery + TTL/Abusewerte festlegen, UI/API-Testfälle; vor SP-04 |
| G0-R04 | Idempotency DB ohne actor/state/hash | [Schemaabgleich](../datenbank/idempotency-handoff.md); REVIEW DRAFT | replay/race/crash/fencing; vor kritischem idempotentem POST |
| G0-R05 | Enums und Schichthistorie uneinheitlich | [Mapping/Optionen](../datenbank/workflow-shift-handoff.md); REVIEW DRAFT | Persistenzoption/DST bestätigen, Tests; vor SP-08/16 |
| G0-R06 | Setup nicht nachgewiesen | DB-Scripts/Health/CI ergänzt; siehe [Evidenz](setup-evidence.md) | clean install/build/start + PostgreSQL/migration repeat, vor G0 PASS |

Diese Handoffs sind konkrete Reviewartefakte. Vorschläge sind nicht heimlich zu früheren Ownerentscheidungen erklärt. Vor Auth muss der Junior die Account-/Session-/Token-Migration und die atomaren Abläufe erklären können.

## G0-Entscheidung

**NEEDS WORK**: Auth-Migrationen und Delivery sind noch offen; PostgreSQL-Smoke-Checks benötigen Laufnachweis. Foundation kann weitergeführt werden. Business-Features und produktive Sicherheit sind nicht fertig. Framework-Startertests ersetzen keine Tenant-/Auth-Negativfälle.

## Restforecast

Phase 10: 272h Restkapazität 07.10.–03.12., 200h geplant/72h Reserve. Nach Block 07.–08.10. bleiben 256h. 188h Implementierung einschließlich SP-01 sind vorläufig; nur bei vollständig belegtem SP-01 dürfen 4h abgezogen werden. Keine tatsächlichen Arbeitsstunden aus dieser automatisierten Bearbeitung ableiten.

Mit dem Code ist jetzt klar: DB- und CI-Foundation fehlten, Auth/Businessimplementation fehlt weiterhin. Aufwand für offen gebliebenen Handoff nur einmal im SP-Budget oder als Zusatz R zählen; Reserve nach bestandenem SP-01 = 72h − R. Belastbares Reforecast nach erstem Authslice, gemessener Durchlaufzeit und bestätigter Abwesenheit. Kein stiller Ausgleich durch Freitags-/Wochenendarbeit.
