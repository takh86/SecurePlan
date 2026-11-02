/**
 * E-10 static CI tripwire: every relation a migration visibly creates must be
 * classified, and both planning guards must consult the same schema signature
 * built on the central list. This test needs no database and fails fast, but it scans text with
 * regular expressions: DDL built at run time (EXECUTE strings, SELECT INTO) is
 * out of its reach. What the executed migrations really created is checked
 * against pg_catalog in test/planning-classification-catalog-real.e2e-spec.ts;
 * the guards' real-PostgreSQL behavior in test/planning-guards-real.e2e-spec.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PlanningSchemaError } from '../../planning/planning-schema.js';
import { assertNoPlanningDependency } from '../project-assignments/planning-dependency-guard.js';
import { assertNoSavedDutiesForConfiguration } from '../shift-configurations/shift-configuration-planning-guard.js';
import {
  KNOWN_NON_PLANNING_TABLES,
  MIGRATION_LEDGER_TABLES,
  PLANNING_GUARD_TABLES,
} from './planning-table-classification.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../migrations/', import.meta.url));

type CreatedRelation = { schema: string | null; name: string; statement: string };
type SchemaViolation = { statement: string };
type ParsedDdl = { relations: CreatedRelation[]; schemaViolations: SchemaViolation[] };

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED = String.raw`(${IDENT})(?:\s*\.\s*(${IDENT}))?`;

/** Unquoted identifiers fold to lower case; quoted ones keep their exact spelling. */
function identifier(raw: string): string {
  return raw.startsWith('"') ? raw.slice(1, -1).replaceAll('""', '"') : raw.toLowerCase();
}

function qualified(first: string, second: string | undefined): { schema: string | null; name: string } {
  return second === undefined
    ? { schema: null, name: identifier(first) }
    : { schema: identifier(first), name: identifier(second) };
}

/**
 * Finds every statement that creates or renames a relation, or creates or moves
 * a schema. Comments and single-quoted literals are removed first; dollar-quoted
 * bodies are kept on purpose, because DDL inside DO blocks is real DDL.
 */
export function parseDdl(sql: string): ParsedDdl {
  const text = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
  const relations: CreatedRelation[] = [];
  const schemaViolations: SchemaViolation[] = [];
  const create = new RegExp(
    String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:GLOBAL|LOCAL)\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?` +
      String.raw`(?:TABLE|(?:MATERIALIZED\s+)?VIEW|FOREIGN\s+TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?${QUALIFIED}`,
    'gi',
  );
  for (const match of text.matchAll(create)) {
    relations.push({ ...qualified(match[1], match[2]), statement: match[0] });
  }
  const rename = new RegExp(
    String.raw`\bALTER\s+(?:TABLE|(?:MATERIALIZED\s+)?VIEW|FOREIGN\s+TABLE)\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${QUALIFIED}\s+RENAME\s+TO\s+(${IDENT})`,
    'gi',
  );
  for (const match of text.matchAll(rename)) {
    const source = qualified(match[1], match[2]);
    relations.push({ schema: source.schema, name: identifier(match[3]), statement: match[0] });
  }
  for (const match of text.matchAll(/\bCREATE\s+SCHEMA\b[^;]*/gi)) schemaViolations.push({ statement: match[0] });
  for (const match of text.matchAll(/\bALTER\s+(?:TABLE|(?:MATERIALIZED\s+)?VIEW|FOREIGN\s+TABLE|SCHEMA)\b[^;]*?\b(?:SET\s+SCHEMA|RENAME\s+TO)\b[^;]*/gi)) {
    if (/\bSET\s+SCHEMA\b/i.test(match[0]) || /^ALTER\s+SCHEMA/i.test(match[0])) {
      schemaViolations.push({ statement: match[0] });
    }
  }
  return { relations, schemaViolations };
}

function migrations(): Array<{ file: string; ddl: ParsedDdl }> {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, ddl: parseDdl(readFileSync(`${MIGRATIONS_DIR}${file}`, 'utf8')) }));
}

describe('E-10 - DDL parser used by the migration classification gate', () => {
  it('recognises the table forms that occur in PostgreSQL migrations', () => {
    const { relations } = parseDdl(`
      CREATE TABLE duties (id uuid);
      create table if not exists Monthly_Plans (id uuid);
      CREATE UNLOGGED TABLE public.plan_entries (id uuid);
      CREATE TEMPORARY TABLE "Duty" (id uuid);
      CREATE OR REPLACE VIEW duty_view AS SELECT 1;
      CREATE MATERIALIZED VIEW IF NOT EXISTS public."plan" AS SELECT 1;
      CREATE TABLE plan_assignments PARTITION OF something FOR VALUES IN (1);
      ALTER TABLE ONLY public.duties RENAME TO dienste;
      DO $$ BEGIN EXECUTE 'x'; CREATE TABLE inside_do (id int); END $$;
    `);
    expect(relations.map(({ schema, name }) => ({ schema, name }))).toEqual([
      { schema: null, name: 'duties' },
      { schema: null, name: 'monthly_plans' },
      { schema: 'public', name: 'plan_entries' },
      { schema: null, name: 'Duty' },
      { schema: null, name: 'duty_view' },
      { schema: 'public', name: 'plan' },
      { schema: null, name: 'plan_assignments' },
      { schema: null, name: 'inside_do' },
      { schema: 'public', name: 'dienste' },
    ]);
  });

  it('ignores DDL inside comments and string literals', () => {
    const { relations, schemaViolations } = parseDdl(`
      -- CREATE TABLE commented_out (id uuid);
      /* CREATE SCHEMA hidden; CREATE TABLE hidden.duties (id uuid); */
      COMMENT ON TABLE x IS 'CREATE TABLE in_a_string (id uuid)';
    `);
    expect(relations).toEqual([]);
    expect(schemaViolations).toEqual([]);
  });

  it('reports schema creation and moves between schemas', () => {
    const { relations, schemaViolations } = parseDdl(`
      CREATE SCHEMA planning;
      CREATE SCHEMA IF NOT EXISTS other AUTHORIZATION someone;
      ALTER TABLE duties SET SCHEMA planning;
      ALTER SCHEMA planning RENAME TO plans;
      CREATE TABLE planning.duties (id uuid);
    `);
    expect(schemaViolations).toHaveLength(4);
    expect(relations).toEqual([expect.objectContaining({ schema: 'planning', name: 'duties' })]);
  });
});

describe('E-10 - every relation created by a migration is classified', () => {
  const nonPlanning = new Set<string>(KNOWN_NON_PLANNING_TABLES);
  const planning = new Set<string>(PLANNING_GUARD_TABLES);

  it('finds the migrations and at least the known tables', () => {
    const files = migrations();
    expect(files.length).toBeGreaterThanOrEqual(9);
    const created = files.flatMap(({ ddl }) => ddl.relations.map(({ name }) => name));
    // The non-planning list must stay honest: every entry is really created by a migration.
    for (const name of KNOWN_NON_PLANNING_TABLES) expect(created, name).toContain(name);
  });

  it('no migration creates an unclassified relation (unknown names fail CI before they can bypass a guard)', () => {
    const unclassified = migrations().flatMap(({ file, ddl }) =>
      ddl.relations
        .filter(({ name }) => !nonPlanning.has(name) && !planning.has(name))
        .map(({ name, statement }) => `${file}: ${name} (${statement.trim()})`),
    );
    expect(unclassified).toEqual([]);
  });

  it('no migration creates or moves schemas or uses a schema other than public', () => {
    const violations = migrations().flatMap(({ file, ddl }) => [
      ...ddl.schemaViolations.map(({ statement }) => `${file}: ${statement.trim()}`),
      ...ddl.relations
        .filter(({ schema }) => schema !== null && schema !== 'public')
        .map(({ schema, name }) => `${file}: ${schema}.${name}`),
    ]);
    expect(violations).toEqual([]);
  });

  it('the classifications (planning, non-planning, migration ledger) are disjoint and free of duplicates', () => {
    const all: string[] = [...PLANNING_GUARD_TABLES, ...KNOWN_NON_PLANNING_TABLES, ...MIGRATION_LEDGER_TABLES];
    expect(all.filter((name, index) => all.indexOf(name) !== index)).toEqual([]);
  });

  it('every planning name is listed in its singular and its plural form', () => {
    const pairs = [
      ['monthly_plan', 'monthly_plans'],
      ['duty', 'duties'],
      ['plan_assignment', 'plan_assignments'],
      ['duty_assignment', 'duty_assignments'],
      ['monthly_plan_entry', 'monthly_plan_entries'],
      ['plan_entry', 'plan_entries'],
      ['plan', 'plans'],
      ['edit_lease', 'edit_leases'],
      ['cancellation_request', 'cancellation_requests'],
      ['replacement_need', 'replacement_needs'],
      ['replacement_offer', 'replacement_offers'],
    ];
    for (const pair of pairs) for (const name of pair) expect([...planning], name).toContain(name);
    expect(pairs.flat().sort()).toEqual([...PLANNING_GUARD_TABLES].sort());
  });
});

describe('E-10 / SP-11 - both guards consult the same schema signature before any dependency read', () => {
  /** Answers the catalog statement with the given planning relations and records every call. */
  function recordingClient(relations: { schema: string; name: string; kind: string }[]) {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const client = {
      query: (text: string, values: unknown[]) => {
        calls.push({ text, values });
        return Promise.resolve({ rows: [{ relations, columns: [], constraints: [], indexes: [] }] });
      },
    };
    return { calls, client: client as unknown as Parameters<typeof assertNoPlanningDependency>[0] };
  }

  const tuple = { employeeId: 'e', projectId: 'p', monthStart: '2027-01-01' };

  it.each([
    ['ABSENT (migration 0011 missing)', []],
    ['an extra planning relation in another schema', [{ schema: 'planning', name: 'duties', kind: 'r' }]],
    ['a planning view instead of a table', [{ schema: 'public', name: 'plan_entry', kind: 'v' }]],
    ['a temporary planning shadow', [{ schema: 'pg_temp_3', name: 'duties', kind: 'r' }]],
  ] as const)('%s: both guards fail closed as a technical error after exactly one identical catalog read', async (_case, relations) => {
    const sp09 = recordingClient([...relations]);
    const sp08b = recordingClient([...relations]);
    await expect(assertNoPlanningDependency(sp09.client, 'c', [tuple])).rejects.toBeInstanceOf(PlanningSchemaError);
    await expect(assertNoSavedDutiesForConfiguration(sp08b.client, 'c', 'p', '2027-01-01'))
      .rejects.toBeInstanceOf(PlanningSchemaError);
    expect(sp09.calls).toHaveLength(1);
    expect(sp09.calls).toEqual(sp08b.calls);
    expect(sp09.calls[0].values[0]).toEqual([...PLANNING_GUARD_TABLES]);
    // No schema-name exclusion may silently exempt pg_temp_* shadows.
    expect(sp09.calls[0].text).not.toContain("ns.nspname !~ '^pg_'");
    expect(sp09.calls[0].text).not.toContain("'information_schema'");
  });
});
