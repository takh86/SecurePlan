/**
 * E-10 post-migration catalog check against REAL PostgreSQL.
 *
 * After all migrations have been applied (CI: `npm run db:migrate` twice, then
 * `npm run test:e2e`), pg_catalog must match the central classification in
 * planning-table-classification.ts exactly. The static tripwire only reads the
 * migration files; this check sees what the executed SQL really created,
 * including DDL built at run time. Each of these fails the check, so nothing
 * unknown counts as safe:
 * - a schema other than public and information_schema;
 * - a data-bearing relation created after initdb outside schema public;
 * - a relation in public that is not classified;
 * - a non-planning or ledger entry without a relation in public (stale entry).
 *
 * The negative cases execute migration SQL in transactions that are rolled
 * back, so parallel test files never see it. The information_schema case needs
 * a superuser, as in the Docker setup and in CI. Migrated LOCAL PostgreSQL only.
 */
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  KNOWN_NON_PLANNING_TABLES,
  MIGRATION_LEDGER_TABLES,
  PLANNING_GUARD_TABLES,
} from '../src/modules/workforce/planning-guard/planning-table-classification.js';
import { openLocalTestPool, type TestPool } from './helpers/synthetic-tenants.js';

type Queryable = Pick<PoolClient, 'query'>;
type Classification = { planning: readonly string[]; nonPlanning: readonly string[] };

const CENTRAL_CLASSIFICATION: Classification = {
  planning: PLANNING_GUARD_TABLES,
  nonPlanning: [...KNOWN_NON_PLANNING_TABLES, ...MIGRATION_LEDGER_TABLES],
};

/**
 * Compares every non-system schema and every data-bearing relation (table,
 * partitioned table, view, materialized view, foreign table) created after
 * initdb with the classification. PostgreSQL assigns OIDs >= 16384
 * (FirstNormalObjectId) only after initdb, so the system views of
 * information_schema are skipped while a relation that a migration puts there
 * is still found. The pg_ prefix is reserved for system schemas (catalog,
 * TOAST, temporary schemas of sessions).
 */
async function catalogViolations(client: Queryable, classification = CENTRAL_CLASSIFICATION): Promise<string[]> {
  const schemas = await client.query<{ schema: string }>(
    `SELECT nspname AS schema FROM pg_catalog.pg_namespace
     WHERE nspname !~ '^pg_' AND nspname NOT IN ('public', 'information_schema')
     ORDER BY 1`,
  );
  const relations = await client.query<{ schema: string; name: string; kind: string }>(
    `SELECT ns.nspname AS schema, c.relname AS name, c.relkind::text AS kind
     FROM pg_catalog.pg_class AS c
     JOIN pg_catalog.pg_namespace AS ns ON ns.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND c.oid >= 16384
       AND ns.nspname !~ '^pg_'
     ORDER BY 1, 2`,
  );
  const classified = new Set([...classification.planning, ...classification.nonPlanning]);
  const inPublic = new Set(relations.rows.filter(({ schema }) => schema === 'public').map(({ name }) => name));
  return [
    ...schemas.rows.map(({ schema }) => `unexpected schema: ${schema}`),
    ...relations.rows
      .filter(({ schema, name }) => schema !== 'public' || !classified.has(name))
      .map(({ schema, name, kind }) =>
        `${schema === 'public' ? 'unclassified relation' : 'relation outside schema public'}: ${schema}.${name} (relkind ${kind})`),
    ...classification.nonPlanning
      .filter((name) => !inPublic.has(name))
      .map((name) => `classified relation missing: public.${name}`),
  ];
}

let pool: TestPool | undefined;

function db(): TestPool {
  if (!pool) throw new Error('Test database is unavailable');
  return pool;
}

/** Hex suffix: a safe unquoted identifier that never starts with the reserved `pg_`. */
const freshName = () => `sp_e10_${randomBytes(6).toString('hex')}`;

/** Executes one migration's SQL in a transaction, checks the catalog inside it and always rolls back. */
async function violationsAfter(migrationSql: string): Promise<string[]> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query(migrationSql);
      return await catalogViolations(client);
    } finally {
      await client.query('ROLLBACK');
    }
  } finally {
    client.release();
  }
}

const unclassified = (kind: string) => (name: string) => [`unclassified relation: public.${name} (relkind ${kind})`];

beforeAll(() => {
  pool = openLocalTestPool(2);
});

afterAll(async () => {
  await pool?.end();
});

describe('E-10 — post-migration catalog check, real PostgreSQL', () => {
  it('the migrated database matches the central classification exactly', async () => {
    expect(await catalogViolations(db())).toEqual([]);
  });

  it.each([
    ['static CREATE TABLE with an unclassified name', (name: string) => `CREATE TABLE ${name} (id uuid)`, unclassified('r')],
    [
      'dynamic SQL in a DO block (invisible to the static tripwire)',
      (name: string) => `DO $$ BEGIN EXECUTE format('CREATE TABLE %I (id uuid)', '${name}'); END $$`,
      unclassified('r'),
    ],
    [
      'SELECT INTO without any CREATE keyword (invisible to the static tripwire)',
      (name: string) => `SELECT 1 AS id INTO ${name}`,
      unclassified('r'),
    ],
    ['partitioned table', (name: string) => `CREATE TABLE ${name} (id integer) PARTITION BY RANGE (id)`, unclassified('p')],
    ['view', (name: string) => `CREATE VIEW ${name} AS SELECT 1 AS id`, unclassified('v')],
    ['materialized view', (name: string) => `CREATE MATERIALIZED VIEW ${name} AS SELECT 1 AS id`, unclassified('m')],
    ['empty new schema', (name: string) => `CREATE SCHEMA ${name}`, (name: string) => [`unexpected schema: ${name}`]],
    [
      'planning name in a new schema, created by dynamic SQL',
      (name: string) => `DO $$ BEGIN EXECUTE 'CREATE SCHEMA ${name}'; EXECUTE 'CREATE TABLE ${name}.duties (id uuid)'; END $$`,
      (name: string) => [`unexpected schema: ${name}`, `relation outside schema public: ${name}.duties (relkind r)`],
    ],
    [
      'table in information_schema',
      (name: string) => `CREATE TABLE information_schema.${name} (id uuid)`,
      (name: string) => [`relation outside schema public: information_schema.${name} (relkind r)`],
    ],
  ] as const)('%s fails the check', async (_migration, sql, expected) => {
    const name = freshName();
    expect(await violationsAfter(sql(name))).toEqual(expected(name));
  });

  it('a planning relation in public is classified, not a violation: the runtime guards block it instead', async () => {
    expect(await violationsAfter('CREATE TABLE public.plan_entry (id uuid)')).toEqual([]);
  });

  it('a non-planning entry without a relation (stale classification) fails the check', async () => {
    const retired = freshName();
    const stale = { ...CENTRAL_CLASSIFICATION, nonPlanning: [...CENTRAL_CLASSIFICATION.nonPlanning, retired] };
    expect(await catalogViolations(db(), stale))
      .toEqual([`classified relation missing: public.${retired}`]);
  });

  it('after the rolled-back migrations the shared database matches the classification again', async () => {
    expect(await catalogViolations(db())).toEqual([]);
  });
});
