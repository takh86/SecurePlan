/**
 * Central planning-table classification (E-10), shared by the planning schema
 * signature (src/modules/planning/planning-schema.ts) behind the SP-11 planning
 * guards: assignment correction/removal (D2) and shift configuration (D3).
 *
 * The temporary guards used to keep their own name lists, which had diverged
 * (3 vs. 8 names): a planning table named after the logical design
 * (`monthly_plan`, `duty`, `duty_assignment`) bypassed the SP-09 guard, and
 * both guards missed "plan entry" names and tables outside schema `public`.
 *
 * Defense in three layers:
 * 1. Runtime: the schema signature matches relations from PLANNING_GUARD_TABLES
 *    in ANY schema, including temporary schemas and information_schema.
 *    Only the three canonical relations of
 *    migration 0011, unaltered and in `public`, are trusted; any other
 *    planning-named relation makes every planning check fail closed.
 * 2. CI, static tripwire: planning-table-classification.spec.ts scans the
 *    migration files without a database and fails on a visible unclassified
 *    relation or schema change. It is a regex scan, not a SQL parser: DDL built
 *    at run time (EXECUTE strings, SELECT INTO) is invisible to it.
 * 3. CI, post-migration catalog check: test/planning-classification-catalog-real.e2e-spec.ts
 *    compares pg_catalog of the migrated database with this classification.
 *    Every table, view, materialized view or foreign table the executed SQL
 *    created must be classified and live in schema `public`; no schema besides
 *    `public` and `information_schema` may exist; every non-planning and ledger
 *    entry must exist. Nothing unknown counts as safe.
 *
 * A future planning relation must be added here in the same PR that creates it.
 */

/**
 * Names a planning relation may plausibly get: physical design (plural),
 * logical design (singular), API vocabulary (DutyAssignment, MonthlyPlanEntry).
 * Migration 0011 created monthly_plans, duties and plan_assignments.
 */
export const PLANNING_GUARD_TABLES = [
  'monthly_plans',
  'monthly_plan',
  'duties',
  'duty',
  'plan_assignments',
  'plan_assignment',
  'duty_assignments',
  'duty_assignment',
  'monthly_plan_entries',
  'monthly_plan_entry',
  'plan_entries',
  'plan_entry',
  'plans',
  'plan',
] as const;

/** Every non-planning relation created by migrations 0001-0011; none of them holds planning data. */
export const KNOWN_NON_PLANNING_TABLES = [
  'foundation_probe',
  'companies',
  'accounts',
  'account_tokens',
  'audit_event',
  'sessions',
  'login_abuse_counters',
  'employees',
  'projects',
  'project_assignments',
  'shift_configurations',
  'employee_availability_days',
  'availability_batch_commands',
] as const;

/** Created by the migration runner itself (scripts/migrate.mjs, applied-migration ledger), not by a migration file. */
export const MIGRATION_LEDGER_TABLES = ['schema_migrations'] as const;
