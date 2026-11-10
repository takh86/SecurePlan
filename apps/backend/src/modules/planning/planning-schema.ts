/**
 * SP-11 planning schema signature (SP11A-R1 T3 / C8).
 *
 * Every planning dependency check and every planning write first reads the
 * catalog and classifies the planning schema as:
 * - COMPLETE: exactly public.monthly_plans, public.duties,
 *   public.plan_assignments, public.edit_leases, public.project_operating_calendars,
 *   public.cancellation_requests, public.replacement_needs and public.replacement_offers exist as ordinary tables,
 *   with the columns, constraints and indexes of migrations 0011/0012/0014/0016/0018 (compared by definition, index
 *   names normalized away), and no other relation anywhere carries a planning
 *   name from the central classification (including temporary schemas).
 *   RLS, policies, user triggers/rules, inheritance/partitioning, unlogged
 *   tables and disabled integrity triggers/indexes are unsupported;
 * - ABSENT: no planning-named relation exists;
 * - INVALID: anything else (partial, altered, misnamed, extra or moved).
 *
 * Only COMPLETE lets a check run. ABSENT and INVALID fail closed with a
 * sanitized technical error (500 INTERNAL_ERROR via ProblemDetailsFilter): a
 * broken deployment is not a business conflict, and an empty result from a
 * missing or altered table must never be read as "no dependency". The real
 * reason is logged server-side only.
 *
 * The definitions are PostgreSQL 17 deparse output of migrations 0011/0012/0014/0016/0018. A later
 * migration that changes these relations must update this signature in the
 * same change; until then the guards refuse to trust the altered schema.
 */
import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { PLANNING_GUARD_TABLES } from '../workforce/planning-guard/planning-table-classification.js';

type Queryable = Pick<PoolClient, 'query'>;

export const PLANNING_RELATIONS = ['monthly_plans', 'duties', 'plan_assignments', 'edit_leases', 'project_operating_calendars', 'cancellation_requests', 'replacement_needs', 'replacement_offers'] as const;
type PlanningRelation = (typeof PLANNING_RELATIONS)[number];

export type PlanningSchemaState = 'ABSENT' | 'COMPLETE' | 'INVALID';

/** `name type [NOT NULL] [DEFAULT expr]`, as rendered by format_type/pg_get_expr. */
const EXPECTED_COLUMNS: Record<PlanningRelation, readonly string[]> = {
  replacement_offers: [
    "id uuid NOT NULL DEFAULT gen_random_uuid()",
    "company_id uuid NOT NULL",
    "need_id uuid NOT NULL",
    "employee_id uuid NOT NULL",
    "status text NOT NULL DEFAULT 'OPEN'::text",
    "created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()",
    "updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()",
    "decided_at timestamp with time zone",
    "duty_id uuid NOT NULL"
  ],
  cancellation_requests: [
    "id uuid NOT NULL DEFAULT gen_random_uuid()",
    "company_id uuid NOT NULL",
    "assignment_id uuid NOT NULL",
    "duty_id uuid NOT NULL",
    "employee_id uuid NOT NULL",
    "submission_version bigint NOT NULL",
    "status text NOT NULL DEFAULT 'OPEN'::text",
    "created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()",
    "updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()",
    "decided_at timestamp with time zone",
    "decided_by_account_id uuid",
  ],
  replacement_needs: [
    "id uuid NOT NULL DEFAULT gen_random_uuid()",
    "company_id uuid NOT NULL",
    "cancellation_request_id uuid NOT NULL",
    "duty_id uuid NOT NULL",
    "status text NOT NULL DEFAULT 'OPEN'::text",
    "created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()",
    "updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()",
    "resolved_at timestamp with time zone",
    "selected_offer_id uuid",
    "concurrency_version bigint NOT NULL DEFAULT 1",
  ],
  project_operating_calendars: [
    'id uuid NOT NULL DEFAULT gen_random_uuid()',
    'company_id uuid NOT NULL',
    'project_id uuid NOT NULL',
    'effective_from_month date NOT NULL',
    'weekday_mask smallint NOT NULL',
    'version bigint NOT NULL DEFAULT 1',
    'created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()',
    'updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()',
  ],
  edit_leases: [
    'id uuid NOT NULL DEFAULT gen_random_uuid()',
    'company_id uuid NOT NULL',
    'duty_id uuid NOT NULL',
    'owner_account_id uuid NOT NULL',
    'token_hash bytea NOT NULL',
    'acquired_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()',
    'renewed_at timestamp with time zone',
    'expires_at timestamp with time zone NOT NULL',
    'released_at timestamp with time zone',
  ],
  monthly_plans: [
    'id uuid NOT NULL DEFAULT gen_random_uuid()',
    'company_id uuid NOT NULL',
    'project_id uuid NOT NULL',
    'planning_month date NOT NULL',
    "status text NOT NULL DEFAULT 'UNPUBLISHED'::text",
    'published_at timestamp(0) with time zone',
    'published_by_account_id uuid',
    'created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()',
    'updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()',
  ],
  duties: [
    'id uuid NOT NULL DEFAULT gen_random_uuid()',
    'company_id uuid NOT NULL',
    'project_id uuid NOT NULL',
    'monthly_plan_id uuid NOT NULL',
    'planning_month date NOT NULL',
    'duty_date date NOT NULL',
    'shift_kind text NOT NULL',
    'concurrency_version bigint NOT NULL DEFAULT 1',
    'starts_at timestamp(0) with time zone NOT NULL',
    'ends_at timestamp(0) with time zone NOT NULL',
    'time_zone text NOT NULL',
    'config_effective_from_month date NOT NULL',
    'start_local time(0) without time zone NOT NULL',
    'end_local time(0) without time zone NOT NULL',
    'removed_at timestamp with time zone',
    'created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()',
    'updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()',
  ],
  plan_assignments: [
    'id uuid NOT NULL DEFAULT gen_random_uuid()',
    'company_id uuid NOT NULL',
    'duty_id uuid NOT NULL',
    'employee_id uuid NOT NULL',
    'duty_function text NOT NULL',
    "source text NOT NULL DEFAULT 'NORMAL'::text",
    "state text NOT NULL DEFAULT 'ACTIVE'::text",
    'removed_at timestamp with time zone',
    'created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()',
    'updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()',
    'replacement_offer_id uuid',
  ],
};

/** `contype pg_get_constraintdef(oid)`; constraint names are deliberately ignored. */
const EXPECTED_CONSTRAINTS: Record<PlanningRelation, readonly string[]> = {
  replacement_offers: [
    "c CHECK ((((status = 'OPEN'::text) AND (decided_at IS NULL)) OR ((status = ANY (ARRAY['SELECTED'::text, 'NOT_SELECTED'::text, 'INVALIDATED'::text, 'WITHDRAWN'::text])) AND (decided_at IS NOT NULL))))",
    "c CHECK ((status = ANY (ARRAY['OPEN'::text, 'SELECTED'::text, 'NOT_SELECTED'::text, 'INVALIDATED'::text, 'WITHDRAWN'::text])))",
    "c CHECK ((isfinite(created_at) AND isfinite(updated_at) AND (updated_at >= created_at) AND ((decided_at IS NULL) OR (isfinite(decided_at) AND (decided_at >= created_at) AND (decided_at <= updated_at)))))",
    "f FOREIGN KEY (company_id, employee_id) REFERENCES public.employees(company_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT",
    "f FOREIGN KEY (company_id, need_id) REFERENCES public.replacement_needs(company_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT",
    "f FOREIGN KEY (company_id, need_id, duty_id) REFERENCES public.replacement_needs(company_id, id, duty_id) ON DELETE RESTRICT",
    "u UNIQUE (company_id, id, need_id)",
    "u UNIQUE (company_id, id, duty_id, employee_id)",
    "p PRIMARY KEY (id)",
    "u UNIQUE (company_id, id)"
  ],
  cancellation_requests: [
    "c CHECK ((isfinite(created_at) AND isfinite(updated_at) AND (updated_at >= created_at) AND ((decided_at IS NULL) OR (isfinite(decided_at) AND (decided_at >= created_at) AND (decided_at <= updated_at)))))",
    "c CHECK ((((status = ANY (ARRAY['APPROVED'::text, 'REJECTED'::text])) AND (decided_at IS NOT NULL) AND (decided_by_account_id IS NOT NULL)) OR ((status = ANY (ARRAY['OPEN'::text, 'WITHDRAWN'::text, 'OBSOLETE'::text])) AND (decided_at IS NULL) AND (decided_by_account_id IS NULL))))",
    "c CHECK ((status = ANY (ARRAY['OPEN'::text, 'WITHDRAWN'::text, 'REJECTED'::text, 'APPROVED'::text, 'OBSOLETE'::text])))",
    "c CHECK (((submission_version >= 1) AND (submission_version <= '9007199254740991'::bigint)))",
    "f FOREIGN KEY (company_id, assignment_id, duty_id, employee_id) REFERENCES public.plan_assignments(company_id, id, duty_id, employee_id) ON UPDATE RESTRICT ON DELETE RESTRICT",
    "f FOREIGN KEY (company_id, decided_by_account_id) REFERENCES public.accounts(company_id, id) ON DELETE RESTRICT",
    "f FOREIGN KEY (company_id, duty_id) REFERENCES public.duties(company_id, id) ON DELETE RESTRICT",
    "f FOREIGN KEY (company_id, employee_id) REFERENCES public.employees(company_id, id) ON DELETE RESTRICT",
    "f FOREIGN KEY (company_id, id) REFERENCES public.replacement_needs(company_id, cancellation_request_id) DEFERRABLE INITIALLY DEFERRED",
    "p PRIMARY KEY (id)",
    "u UNIQUE (company_id, id)",
    "u UNIQUE (company_id, id, duty_id)",
  ],
  replacement_needs: [
    "c CHECK ((isfinite(created_at) AND isfinite(updated_at) AND (updated_at >= created_at) AND ((resolved_at IS NULL) OR (isfinite(resolved_at) AND (resolved_at >= created_at) AND (resolved_at <= updated_at)))))",
    "c CHECK ((status = ANY (ARRAY['OPEN'::text, 'OPEN_UNFILLED'::text, 'RESOLVED'::text, 'CLOSED'::text])))",
    "c CHECK ((((status = 'RESOLVED'::text) AND (resolved_at IS NOT NULL)) OR ((status = ANY (ARRAY['OPEN'::text, 'OPEN_UNFILLED'::text, 'CLOSED'::text])) AND (resolved_at IS NULL))))",
    "f FOREIGN KEY (company_id, cancellation_request_id, duty_id) REFERENCES public.cancellation_requests(company_id, id, duty_id) ON DELETE RESTRICT",
    "f FOREIGN KEY (company_id, duty_id) REFERENCES public.duties(company_id, id) ON DELETE RESTRICT",
    "p PRIMARY KEY (id)",
    "c CHECK (((status = 'RESOLVED'::text) = (selected_offer_id IS NOT NULL)))",
    "c CHECK (((concurrency_version >= 1) AND (concurrency_version <= '9007199254740991'::bigint)))",
    "f FOREIGN KEY (company_id, selected_offer_id, id) REFERENCES public.replacement_offers(company_id, id, need_id) ON DELETE RESTRICT",
    "u UNIQUE (company_id, id, duty_id)",
    "u UNIQUE (company_id, cancellation_request_id)",
    "u UNIQUE (company_id, id)",
  ],
  project_operating_calendars: [
    "c CHECK (((effective_from_month >= '0001-01-01'::date) AND (effective_from_month <= '9999-12-01'::date) AND (EXTRACT(day FROM effective_from_month) = (1)::numeric)))",
    'c CHECK ((isfinite(created_at) AND isfinite(updated_at)))',
    "c CHECK (((version >= 1) AND (version <= '9007199254740991'::bigint)))",
    'c CHECK (((weekday_mask >= 1) AND (weekday_mask <= 127)))',
    'f FOREIGN KEY (company_id, project_id) REFERENCES public.projects(company_id, id) ON DELETE RESTRICT',
    'p PRIMARY KEY (id)',
    'u UNIQUE (company_id, id)',
    'u UNIQUE (company_id, project_id, effective_from_month)',
  ],
  edit_leases: [
    'c CHECK ((isfinite(acquired_at) AND isfinite(expires_at) AND (expires_at > acquired_at) AND ((renewed_at IS NULL) OR (isfinite(renewed_at) AND (renewed_at >= acquired_at) AND (renewed_at < expires_at))) AND ((released_at IS NULL) OR (isfinite(released_at) AND (released_at >= acquired_at)))))',
    'c CHECK ((octet_length(token_hash) = 32))',
    'f FOREIGN KEY (company_id, duty_id) REFERENCES public.duties(company_id, id) ON DELETE RESTRICT',
    'f FOREIGN KEY (company_id, owner_account_id) REFERENCES public.accounts(company_id, id) ON DELETE RESTRICT',
    'p PRIMARY KEY (id)',
    'u UNIQUE (company_id, duty_id)',
    'u UNIQUE (company_id, id)',
  ],
  monthly_plans: [
    "c CHECK (((planning_month >= '0001-01-01'::date) AND (planning_month <= '9999-12-01'::date) AND (EXTRACT(day FROM planning_month) = (1)::numeric)))",
    "c CHECK ((((status = 'UNPUBLISHED'::text) AND (published_at IS NULL) AND (published_by_account_id IS NULL)) OR ((status = 'PUBLISHED'::text) AND (published_at IS NOT NULL) AND isfinite(published_at) AND (published_by_account_id IS NOT NULL))))",
    'f FOREIGN KEY (company_id, project_id) REFERENCES public.projects(company_id, id) ON DELETE RESTRICT',
    'f FOREIGN KEY (company_id, published_by_account_id) REFERENCES public.accounts(company_id, id) ON DELETE RESTRICT',
    'p PRIMARY KEY (id)',
    'u UNIQUE (company_id, id)',
    'u UNIQUE (company_id, project_id, planning_month)',
    'u UNIQUE (company_id, project_id, planning_month, id)',
  ],
  duties: [
    "c CHECK (((concurrency_version >= 1) AND (concurrency_version <= '9007199254740991'::bigint)))",
    "c CHECK (((config_effective_from_month >= '0001-01-01'::date) AND (config_effective_from_month <= '9999-12-01'::date) AND (EXTRACT(day FROM config_effective_from_month) = (1)::numeric) AND (config_effective_from_month <= planning_month)))",
    "c CHECK (((duty_date >= '0001-01-01'::date) AND (duty_date <= '9999-12-31'::date) AND (EXTRACT(day FROM planning_month) = (1)::numeric) AND (EXTRACT(year FROM duty_date) = EXTRACT(year FROM planning_month)) AND (EXTRACT(month FROM duty_date) = EXTRACT(month FROM planning_month))))",
    "c CHECK (((EXTRACT(second FROM start_local) = (0)::numeric) AND (EXTRACT(second FROM end_local) = (0)::numeric) AND (start_local < '24:00:00'::time without time zone) AND (end_local < '24:00:00'::time without time zone) AND (start_local <> end_local) AND ((shift_kind <> 'TAG'::text) OR (end_local > start_local))))",
    'c CHECK ((isfinite(starts_at) AND isfinite(ends_at) AND (ends_at > starts_at)))',
    'c CHECK (((length(time_zone) >= 1) AND (length(time_zone) <= 255)))',
    'c CHECK (((removed_at IS NULL) OR isfinite(removed_at)))',
    "c CHECK ((shift_kind = ANY (ARRAY['TAG'::text, 'NACHT'::text])))",
    'f FOREIGN KEY (company_id, project_id, planning_month, monthly_plan_id) REFERENCES public.monthly_plans(company_id, project_id, planning_month, id) ON DELETE RESTRICT',
    'p PRIMARY KEY (id)',
    'u UNIQUE (company_id, id)',
  ],
  plan_assignments: [
    "c CHECK ((duty_function = ANY (ARRAY['MITARBEITER'::text, 'SCHICHTLEITER'::text])))",
    "c CHECK ((source = ANY (ARRAY['NORMAL'::text, 'REPLACEMENT'::text])))",
    "c CHECK ((((state = 'ACTIVE'::text) AND (removed_at IS NULL)) OR ((state = 'REMOVED'::text) AND (removed_at IS NOT NULL) AND isfinite(removed_at))))",
    'f FOREIGN KEY (company_id, duty_id) REFERENCES public.duties(company_id, id) ON DELETE RESTRICT',
    'f FOREIGN KEY (company_id, employee_id) REFERENCES public.employees(company_id, id) ON DELETE RESTRICT',
    'p PRIMARY KEY (id)',
    'u UNIQUE (company_id, id)',
    'u UNIQUE (company_id, id, duty_id, employee_id)',
    "c CHECK ((((source = 'NORMAL'::text) AND (replacement_offer_id IS NULL)) OR ((source = 'REPLACEMENT'::text) AND (replacement_offer_id IS NOT NULL))))",
    "f FOREIGN KEY (company_id, replacement_offer_id, duty_id, employee_id) REFERENCES public.replacement_offers(company_id, id, duty_id, employee_id) ON DELETE RESTRICT",
  ],
};

/** PostgreSQL 17 patch levels can deparse these four identical CHECK expressions
 * with or without one redundant group of parentheses. Only the four exact
 * migration-derived alternate signatures are accepted; all other schema drift
 * remains INVALID. This is NOT general SQL/parenthesis normalization.
 */
const PG17_CHECK_DEPARSE_ALIASES = new Map<string, string>();
for (const [relation, field] of [
  ['monthly_plans', 'planning_month'],
  ['duties', 'config_effective_from_month'],
  ['duties', 'duty_date'],
  ['project_operating_calendars', 'effective_from_month'],
] as const) {
  const expected = EXPECTED_CONSTRAINTS[relation].filter(
    (signature) => signature.startsWith(`c CHECK (((${field} >= '0001-01-01'::date)`),
  );
  if (expected.length !== 1) throw new Error(`Unrecognized signed CHECK: ${relation}.${field}`);
  const canonical = expected[0];
  const alternate = canonical
    .replace('c CHECK (((', 'c CHECK ((((')
    .replace('::date) AND (EXTRACT', '::date)) AND (EXTRACT');
  if (alternate === canonical || PG17_CHECK_DEPARSE_ALIASES.has(alternate)) {
    throw new Error(`Ambiguous CHECK deparse alias: ${relation}.${field}`);
  }
  PG17_CHECK_DEPARSE_ALIASES.set(alternate, canonical);
}

/** pg_get_indexdef of valid indexes that do not back a constraint, index name normalized to `?`. */
const EXPECTED_INDEXES: Record<PlanningRelation, readonly string[]> = {
  replacement_offers: [
    "CREATE INDEX ? ON public.replacement_offers USING btree (company_id, employee_id, created_at, id)",
    "CREATE INDEX ? ON public.replacement_offers USING btree (company_id, need_id, created_at, id)",
    "CREATE UNIQUE INDEX ? ON public.replacement_offers USING btree (company_id, need_id, employee_id) WHERE (status = ANY (ARRAY['OPEN'::text, 'SELECTED'::text]))",
    "CREATE UNIQUE INDEX ? ON public.replacement_offers USING btree (company_id, need_id) WHERE (status = 'SELECTED'::text)"
  ],
  cancellation_requests: [
    "CREATE UNIQUE INDEX ? ON public.cancellation_requests USING btree (company_id, duty_id, employee_id) WHERE (status = 'OPEN'::text)",
  ],
  replacement_needs: [
  ],
  project_operating_calendars: [],
  edit_leases: ['CREATE INDEX ? ON public.edit_leases USING btree (expires_at)'],
  monthly_plans: [
    'CREATE INDEX ? ON public.monthly_plans USING btree (company_id, planning_month DESC, id)',
  ],
  duties: [
    'CREATE INDEX ? ON public.duties USING btree (company_id, project_id, duty_date) WHERE (removed_at IS NULL)',
    'CREATE INDEX ? ON public.duties USING btree (company_id, project_id, ends_at) WHERE (removed_at IS NULL)',
    'CREATE UNIQUE INDEX ? ON public.duties USING btree (company_id, monthly_plan_id, duty_date, shift_kind) WHERE (removed_at IS NULL)',
  ],
  plan_assignments: [
    "CREATE INDEX ? ON public.plan_assignments USING btree (company_id, employee_id, duty_id) WHERE (state = 'ACTIVE'::text)",
    "CREATE UNIQUE INDEX ? ON public.plan_assignments USING btree (company_id, duty_id, employee_id) WHERE (state = 'ACTIVE'::text)",
    "CREATE UNIQUE INDEX ? ON public.plan_assignments USING btree (company_id, replacement_offer_id) WHERE (source = 'REPLACEMENT'::text)",
  ],
};

type CatalogRow = {
  relations: { schema: string; name: string; kind: string; safe: boolean }[];
  columns: { relation: string; signature: string }[];
  constraints: { relation: string; signature: string }[];
  indexes: { relation: string; signature: string }[];
};

/**
 * One catalog statement (one snapshot). Planning names are matched in every
 * schema, including pg_temp_*: temporary names can shadow ordinary tables.
 */
const CATALOG_SQL = `
  WITH planning AS (
    SELECT c.oid, ns.nspname AS schema, c.relname AS name, c.relkind::text AS kind,
           c.relpersistence = 'p' AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
           AND NOT c.relispartition
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid = c.oid OR i.inhparent = c.oid)
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid)
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = c.oid
                           AND (NOT t.tgisinternal OR t.tgenabled <> 'O'))
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite r WHERE r.ev_class = c.oid)
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = c.oid
                           AND (NOT k.convalidated OR (k.contype = 'f' AND NOT EXISTS (
                             SELECT 1 FROM pg_catalog.pg_class parent
                             JOIN pg_catalog.pg_namespace pns ON pns.oid = parent.relnamespace
                             WHERE parent.oid = k.confrelid AND pns.nspname = 'public'))))
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index x WHERE x.indrelid = c.oid
                           AND (NOT x.indisvalid OR NOT x.indisready OR NOT x.indislive)) AS safe
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS ns ON ns.oid = c.relnamespace
    WHERE c.relname = ANY($1::text[])
  ), canonical AS (
    SELECT oid, name FROM planning
    WHERE schema = 'public' AND kind = 'r' AND name = ANY($2::text[])
  )
  SELECT
    (SELECT coalesce(jsonb_agg(jsonb_build_object('schema', schema, 'name', name, 'kind', kind, 'safe', safe)), '[]'::jsonb)
       FROM planning) AS relations,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('relation', t.name, 'signature',
              a.attname || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod)
              || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
              || coalesce(' DEFAULT ' || pg_catalog.pg_get_expr(d.adbin, d.adrelid), '')) ORDER BY t.name, a.attnum), '[]'::jsonb)
       FROM canonical AS t
       JOIN pg_catalog.pg_attribute AS a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
       LEFT JOIN pg_catalog.pg_attrdef AS d ON d.adrelid = t.oid AND d.adnum = a.attnum) AS columns,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('relation', t.name, 'signature',
              k.contype::text || ' ' || regexp_replace(pg_catalog.pg_get_constraintdef(k.oid),
                'REFERENCES (projects|accounts|monthly_plans|duties|employees|plan_assignments|cancellation_requests|replacement_needs|replacement_offers)\\(', 'REFERENCES public.\\1('))), '[]'::jsonb)
       FROM canonical AS t
       JOIN pg_catalog.pg_constraint AS k ON k.conrelid = t.oid) AS constraints,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('relation', t.name, 'signature',
              regexp_replace(pg_catalog.pg_get_indexdef(x.indexrelid), '^(CREATE (UNIQUE )?INDEX) \\S+ ON', '\\1 ? ON'))), '[]'::jsonb)
       FROM canonical AS t
       JOIN pg_catalog.pg_index AS x ON x.indrelid = t.oid AND x.indisvalid AND x.indisready
       WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS k WHERE k.conindid = x.indexrelid)) AS indexes`;

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const sorted = [...actual].sort();
  return [...expected].sort().every((value, index) => value === sorted[index]);
}

export type PlanningSchemaReport = { state: PlanningSchemaState; reason: string };

export function classifyPlanningSchema(catalog: CatalogRow): PlanningSchemaReport {
  if (catalog.relations.length === 0) return { state: 'ABSENT', reason: 'no planning relation exists' };
  const canonical = catalog.relations.filter(
    ({ schema, name, kind }) => schema === 'public' && kind === 'r' && (PLANNING_RELATIONS as readonly string[]).includes(name),
  );
  if (canonical.length !== PLANNING_RELATIONS.length ||
    !PLANNING_RELATIONS.every((name) => canonical.filter((row) => row.name === name).length === 1) || catalog.relations.length !== canonical.length) {
    const found = catalog.relations.map(({ schema, name, kind }) => `${schema}.${name}(${kind})`).sort().join(', ');
    return { state: 'INVALID', reason: `unexpected planning relation set: ${found}` };
  }
  if (canonical.some(({ safe }) => safe !== true)) {
    return { state: 'INVALID', reason: 'unsupported planning table visibility, persistence or integrity state' };
  }
  for (const relation of PLANNING_RELATIONS) {
    const of = (rows: { relation: string; signature: string }[]) =>
      rows.filter((row) => row.relation === relation).map((row) => row.signature);
    if (JSON.stringify(of(catalog.columns)) !== JSON.stringify(EXPECTED_COLUMNS[relation])) {
      return { state: 'INVALID', reason: `columns of public.${relation} differ from migrations 0011/0012/0014/0016/0018` };
    }
    if (!sameSet(of(catalog.constraints).map((s) => PG17_CHECK_DEPARSE_ALIASES.get(s) ?? s), EXPECTED_CONSTRAINTS[relation])) {
      return { state: 'INVALID', reason: `constraints of public.${relation} differ from migrations 0011/0012/0014/0016/0018` };
    }
    if (!sameSet(of(catalog.indexes), EXPECTED_INDEXES[relation])) {
      return { state: 'INVALID', reason: `indexes of public.${relation} differ from migrations 0011/0012/0014/0016/0018` };
    }
  }
  return { state: 'COMPLETE', reason: 'planning schema matches migrations 0011/0012/0014/0016/0018' };
}

export async function readPlanningSchema(client: Queryable): Promise<PlanningSchemaReport> {
  const result = await client.query<CatalogRow>(CATALOG_SQL, [[...PLANNING_GUARD_TABLES], [...PLANNING_RELATIONS]]);
  return classifyPlanningSchema(result.rows[0]);
}

/** Not an HttpException on purpose: ProblemDetailsFilter turns it into a sanitized 500. */
export class PlanningSchemaError extends Error {
  constructor(readonly state: Exclude<PlanningSchemaState, 'COMPLETE'>) {
    super('Planning schema is not usable');
    this.name = 'PlanningSchemaError';
  }
}

const logger = new Logger('PlanningSchema');

/**
 * Call inside the caller's transaction before planning queries.
 * REPEATABLE READ readers must opt into beforeSnapshot immediately after SET
 * TRANSACTION, before any snapshot-producing statement. LOCK TABLE does not
 * establish that data snapshot; DDL which committed during its wait is then
 * visible to the FIRST catalog read. Later reads retain coherent RR behavior.
 */
const PLANNING_SCHEMA_LOCK = 'LOCK TABLE public.monthly_plans, public.duties, public.plan_assignments, public.edit_leases, public.project_operating_calendars, public.cancellation_requests, public.replacement_needs, public.replacement_offers IN ACCESS SHARE MODE';
export async function assertPlanningSchemaComplete(
  client: Queryable,
  options: { beforeSnapshot?: boolean } = {},
): Promise<void> {
  if (options.beforeSnapshot) await client.query(PLANNING_SCHEMA_LOCK);
  let report = await readPlanningSchema(client);
  if (report.state === 'COMPLETE') {
    // Protect against ACCESS EXCLUSIVE canonical DDL until the caller commits.
    // Re-read after any lock wait; do not authorize using a pre-wait snapshot.
    if (!options.beforeSnapshot) await client.query(PLANNING_SCHEMA_LOCK);
    report = await readPlanningSchema(client);
    if (report.state === 'COMPLETE') return;
  }
  logger.error(JSON.stringify({ event: 'planning.schema.not_usable', state: report.state, reason: report.reason }));
  throw new PlanningSchemaError(report.state);
}
