# CR-03 reconciliation prerequisite

This slice adds historical workflow persistence and synchronous reconciliation
for effective assignment removals in duty PATCH/DELETE and employee-month saves.
Cancellation submission and resource APIs remain unavailable.

Run tests only with a [verified disposable PostgreSQL 17 target](disposable-postgres.md):

```powershell
node scripts/disposable-test-target.mjs
node scripts/migrate.mjs
node scripts/migrate.mjs
node scripts/verify-db.mjs
node scripts/verified-test-command.mjs e2e cr03-schema-real cr03-reconciliation-real planning-guards-real
```

The schema suite migrates a fresh isolated database through D15, inserts
synthetic planning and publish-receipt history, then applies D16 and checks
preservation. It exercises exact catalogs, tenant/history constraints and
commit-time required-need validation. HTTP tests cover reconciliation,
terminal preservation, retained edits, audit rollback, receipt replay and
explicit PostgreSQL lock barriers in both acquisition orders. Fixture workflow
inserts exercise the prerequisite without exposing a submission command.

D16 requires the matching seven-table application. Drain serving work before
applying the migration and start only that matching build. The prior five-table
build rejects D16; the prerequisite build rejects missing workflow tables.
The separate employee-month receipt schema and its codecs remain unchanged.
Recover with a matching build and preserve workflow history; applied migrations
remain immutable. This document does not authorize deployment or merging.
