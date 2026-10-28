/**
 * Central planning-table classification shared by the temporary fail-closed
 * planning guards (SP-08b shift configuration, ADR-0003 O-8; SP-09 assignment
 * correction, D-8.4-13).
 *
 * Both guards used to keep their own name lists, which had diverged (3 vs. 8
 * names): a planning table named after the logical design (`monthly_plan`,
 * `duty`, `duty_assignment`) bypassed the SP-09 guard, and both guards missed
 * "plan entry" names and tables outside schema `public`.
 *
 * Defense in three layers, none of which creates or names a business table:
 * 1. Runtime: every guard counts relations from PLANNING_GUARD_TABLES in ANY
 *    schema except PostgreSQL's reserved `pg_*` schemas, information_schema
 *    included. Stricter than before (fail-closed direction only).
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
 * The guards stay fail-closed until SP-11 replaces them with the real
 * dependency checks (docs/datenbank/*-handoff.md). SP-11 must add its table
 * names to PLANNING_GUARD_TABLES in the same PR that creates them.
 */
import type { PoolClient } from 'pg';

type Queryable = Pick<PoolClient, 'query'>;

/**
 * Names a planning relation may plausibly get: physical design (plural),
 * logical design (singular), API vocabulary (DutyAssignment, MonthlyPlanEntry).
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

/** Every relation created by migrations 0001-0009; none of them holds planning data. */
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
] as const;

/** Created by the migration runner itself (scripts/migrate.mjs, applied-migration ledger), not by a migration file. */
export const MIGRATION_LEDGER_TABLES = ['schema_migrations'] as const;

/**
 * Number of relations (any kind) named like a planning table in any schema
 * except the system schemas whose names start with the reserved `pg_` (catalog,
 * toast, other sessions' temporary schemas). information_schema is not exempt:
 * a superuser can create relations there, and none of its system views carries
 * a planning name. Guards run inside READ COMMITTED write transactions, so
 * every call sees the catalog state committed at the start of that statement.
 */
export async function countPlanningRelations(client: Queryable): Promise<number> {
  const present = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n
     FROM pg_catalog.pg_class AS c
     JOIN pg_catalog.pg_namespace AS ns ON ns.oid = c.relnamespace
     WHERE c.relname = ANY($1::text[])
       AND ns.nspname !~ '^pg_'`,
    [[...PLANNING_GUARD_TABLES]],
  );
  return present.rows[0].n;
}
