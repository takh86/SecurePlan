/**
 * SP-11 real planning guards (D2 assignment correction/removal, D3 shift
 * configuration) and their shared schema signature, against REAL PostgreSQL.
 * Rewritten from the E-10 temporary-guard suite (SP11A-R1 T3/C8):
 * - with migration 0011 applied the schema is COMPLETE and the consumers no
 *   longer refuse merely because planning tables exist;
 * - any extra, moved or misnamed planning relation, any alteration of a
 *   canonical relation and an ABSENT schema still fail closed, now as a
 *   sanitized technical error (PlanningSchemaError -> 500), never as the
 *   business 409 that means "a real dependency was found".
 *
 * Shared-database cases change the catalog only inside transactions that are
 * rolled back, so parallel test files never see it. Committed DDL is exercised
 * in a separate temporary database that is dropped afterwards. Synthetic data
 * only; migrated LOCAL PostgreSQL. The information_schema cases need a
 * superuser (Docker setup, CI).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg, { type PoolClient } from 'pg';
import type { DatabaseService } from '../src/database/database.service.js';
import { BusinessAuditService } from '../src/modules/audit/business-audit.service.js';
import { PLANNING_RELATIONS, PlanningSchemaError, readPlanningSchema } from '../src/modules/planning/planning-schema.js';
import { hasLiveAssignmentDependency } from '../src/modules/planning/planning-dependencies.js';
import { PLANNING_GUARD_TABLES } from '../src/modules/workforce/planning-guard/planning-table-classification.js';
import { assertNoPlanningDependency } from '../src/modules/workforce/project-assignments/planning-dependency-guard.js';
import { ProjectAssignmentsService } from '../src/modules/workforce/project-assignments/project-assignments.service.js';
import { assertNoSavedDutiesForConfiguration } from '../src/modules/workforce/shift-configurations/shift-configuration-planning-guard.js';
import { ShiftConfigurationsService } from '../src/modules/workforce/shift-configurations/shift-configurations.service.js';
import {
  createSyntheticEmployee,
  createSyntheticProject,
  createSyntheticTenant,
  inTransaction,
  removeSyntheticTenants,
  type TestPool,
} from './helpers/synthetic-tenants.js';
import { insertDuty, insertMembership, insertPlan } from './helpers/planning-fixtures.js';
import { isolatedPlanningDatabase } from './helpers/isolated-planning-database.js';

type Queryable = Pick<PoolClient, 'query'>;

// Pinned instant: 15 Dec 2026 midday UTC -> current month December 2026.
const MID_DEC = () => new Date('2026-12-15T12:00:00Z');
const DAY = { shiftKind: 'DAY', startLocal: '06:00', endLocal: '18:00' } as const;
const NIGHT = { shiftKind: 'NIGHT', startLocal: '18:00', endLocal: '06:00' } as const;
const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const EXTRA_NAMES = PLANNING_GUARD_TABLES.filter((name) => !(PLANNING_RELATIONS as readonly string[]).includes(name));

let pool: TestPool | undefined;
let isolated: Awaited<ReturnType<typeof isolatedPlanningDatabase>>;
const createdCompanies: string[] = [];

function db(): TestPool {
  if (!pool) throw new Error('Test database is unavailable');
  return pool;
}

/** Hex suffix: a safe unquoted identifier that never starts with the reserved `pg_`. */
const suffix = () => randomBytes(6).toString('hex');

const TUPLE = { employeeId: randomUUID(), projectId: randomUUID(), monthStart: '2027-01-01' };

async function guardOutcomes(client: Queryable) {
  const settle = async (check: Promise<void>) => {
    try {
      await check;
      return 'PASS';
    } catch (error) {
      if (error instanceof PlanningSchemaError) return `TECHNICAL ${error.state}`;
      const { status, response } = error as { status?: number; response?: { code?: string } };
      return `${status} ${response?.code ?? 'UNEXPECTED_ERROR'}`;
    }
  };
  return {
    d2: await settle(assertNoPlanningDependency(client, randomUUID(), [TUPLE])),
    d3: await settle(assertNoSavedDutiesForConfiguration(client, randomUUID(), randomUUID(), '2027-01-01')),
  };
}

const OPEN = { d2: 'PASS', d3: 'PASS' };
const INVALID = { d2: 'TECHNICAL INVALID', d3: 'TECHNICAL INVALID' };
const ABSENT = { d2: 'TECHNICAL ABSENT', d3: 'TECHNICAL ABSENT' };

/** Runs `work` in a transaction on one connection and always rolls it back. */
async function inRolledBackTransaction(work: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    try {
      await work(client);
    } finally {
      await client.query('ROLLBACK');
    }
  } finally {
    client.release();
  }
}

async function withClient<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    return await work(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

beforeAll(async () => {
  isolated = await isolatedPlanningDatabase();
  pool = isolated.pool;
}, 30_000);

afterAll(async () => {
  if (pool) {
    await removeSyntheticTenants(pool, createdCompanies);
    await isolated.close();
  }
});

describe('SP-11 — planning schema signature, real PostgreSQL', () => {
  it('rejects a weakened month CHECK after accepting the canonical PostgreSQL deparse', async () => {
    await inRolledBackTransaction(async (client) => {
      expect(await readPlanningSchema(client)).toMatchObject({ state: 'COMPLETE' });
      await client.query('ALTER TABLE public.monthly_plans DROP CONSTRAINT ck_monthly_plans__month');
      await client.query(`ALTER TABLE public.monthly_plans ADD CONSTRAINT ck_monthly_plans__month
        CHECK (planning_month >= DATE '0001-01-01' AND extract(day FROM planning_month) = 1)`);
      expect(await readPlanningSchema(client)).toMatchObject({ state: 'INVALID' });
    });
  });

  it.each(['public', 'pg_catalog, public', 'pg_catalog'])('constraint signatures are independent of search_path = %s', async (searchPath) => {
    await inRolledBackTransaction(async (client) => {
      await client.query(`SET LOCAL search_path = ${searchPath}`);
      expect(await readPlanningSchema(client)).toMatchObject({ state: 'COMPLETE' });
    });
  });

  it('the migrated database is COMPLETE: exactly the canonical relations exist and both guards pass without dependencies', async () => {
    const found = await db().query<{ schema: string; name: string; kind: string }>(
      `SELECT ns.nspname AS schema, c.relname AS name, c.relkind::text AS kind
       FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE c.relname = ANY($1::text[]) ORDER BY 2`,
      [[...PLANNING_GUARD_TABLES]],
    );
    expect(found.rows).toEqual([
      { schema: 'public', name: 'cancellation_requests', kind: 'r' },
      { schema: 'public', name: 'duties', kind: 'r' },
      { schema: 'public', name: 'edit_leases', kind: 'r' },
      { schema: 'public', name: 'monthly_plans', kind: 'r' },
      { schema: 'public', name: 'plan_assignments', kind: 'r' },
      { schema: 'public', name: 'project_operating_calendars', kind: 'r' },
      { schema: 'public', name: 'replacement_needs', kind: 'r' },
      { schema: 'public', name: 'replacement_offers', kind: 'r' },
    ]);
    await withClient(async (client) => {
      expect(await readPlanningSchema(client)).toMatchObject({ state: 'COMPLETE' });
      expect(await guardOutcomes(client)).toEqual(OPEN);
    });
  });

  it("PostgreSQL's own relations (pg_catalog, information_schema, TOAST) cause no false positive", async () => {
    // OIDs below 16384 (FirstNormalObjectId) belong to initdb, i.e. to PostgreSQL itself.
    const system = await db().query<{ schema: string; planning: string[] }>(
      `SELECT ns.nspname AS schema,
              coalesce(array_agg(c.relname::text) FILTER (WHERE c.relname = ANY($1::text[])), '{}') AS planning
       FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE c.oid < 16384
       GROUP BY 1 ORDER BY 1`,
      [[...PLANNING_GUARD_TABLES]],
    );
    expect(system.rows.map(({ schema }) => schema)).toEqual(expect.arrayContaining(['information_schema', 'pg_catalog', 'pg_toast']));
    for (const { schema, planning } of system.rows) expect(planning, schema).toEqual([]);
  });

  it.each(EXTRA_NAMES)(
    '%s: as a public table, a public view, a table in another schema and a table in information_schema both guards fail closed as technical errors; rollback reopens them',
    async (name) => {
      for (const ddl of [
        `CREATE TABLE public.${name} (id uuid)`,
        `CREATE VIEW public.${name} AS SELECT 1 AS id`,
        (() => {
          const schema = `sp_e10_${suffix()}`;
          return `CREATE SCHEMA ${schema}; CREATE TABLE ${schema}.${name} (id uuid)`;
        })(),
        `CREATE TABLE information_schema.${name} (id uuid)`,
      ]) {
        await inRolledBackTransaction(async (client) => {
          expect(await guardOutcomes(client), `${ddl} (before)`).toEqual(OPEN);
          await client.query(ddl);
          expect(await guardOutcomes(client), ddl).toEqual(INVALID);
        });
      }
      await withClient(async (client) => expect(await guardOutcomes(client), `${name} after rollback`).toEqual(OPEN));
    },
  );

  it.each([...PLANNING_RELATIONS])('a second %s outside public (other schema, information_schema) makes the schema INVALID', async (name) => {
    for (const ddl of [
      (() => {
        const schema = `sp_e10_${suffix()}`;
        return `CREATE SCHEMA ${schema}; CREATE TABLE ${schema}.${name} (id uuid)`;
      })(),
      `CREATE TABLE information_schema.${name} (id uuid)`,
    ]) {
      await inRolledBackTransaction(async (client) => {
        await client.query(ddl);
        expect(await guardOutcomes(client), ddl).toEqual(INVALID);
      });
    }
  });

  it.each([
    ['a partial unique index is dropped', 'DROP INDEX uq_duties__live_slot'],
    ['a partial unique index loses its predicate', `DROP INDEX uq_plan_assignments__active_employee;
      CREATE UNIQUE INDEX uq_plan_assignments__active_employee ON plan_assignments (company_id, duty_id, employee_id)`],
    ['a renamed index is still recognised by definition', 'ALTER INDEX idx_duties__project_end_live RENAME TO renamed_but_same'],
    ['a CHECK constraint is dropped', 'ALTER TABLE duties DROP CONSTRAINT ck_duties__interval'],
    ['a CHECK constraint is renamed (definition unchanged)', 'ALTER TABLE duties RENAME CONSTRAINT ck_duties__kind TO renamed_kind'],
    ['a composite ownership FK is dropped', 'ALTER TABLE plan_assignments DROP CONSTRAINT fk_plan_assignments__employee'],
    ['an extra column is added', 'ALTER TABLE monthly_plans ADD COLUMN revision integer'],
    ['a column default changes', "ALTER TABLE monthly_plans ALTER COLUMN status SET DEFAULT 'PUBLISHED'"],
    ['a column becomes nullable', 'ALTER TABLE duties ALTER COLUMN ends_at DROP NOT NULL'],
    ['an extra index is added', 'CREATE INDEX sp_e10_extra ON duties (shift_kind)'],
  ] as const)('%s', async (description, ddl) => {
    const stillComplete = description.includes('still recognised') || description.includes('definition unchanged');
    await inRolledBackTransaction(async (client) => {
      await client.query(ddl);
      expect(await guardOutcomes(client), ddl).toEqual(stillComplete ? OPEN : INVALID);
    });
  });

  it('a planning name in the session temporary schema fails closed', async () => {
    await inRolledBackTransaction(async (client) => {
      await client.query('CREATE TEMPORARY TABLE plan_entry (id uuid) ON COMMIT DROP');
      expect(await guardOutcomes(client)).toEqual(INVALID);
    });
  });

  it.each(PLANNING_RELATIONS)('%s: either RLS flag, policies, user triggers and disabled FK triggers are INVALID', async (table) => {
    for (const ddl of [
      `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`,
      `CREATE POLICY sp79_hidden ON public.${table} USING (false)`,
      `CREATE FUNCTION public.sp79_suppress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
       CREATE TRIGGER sp79_suppress BEFORE INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.sp79_suppress()`,
      `CREATE FUNCTION public.sp79_suppress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
       CREATE TRIGGER sp79_suppress BEFORE INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.sp79_suppress();
       ALTER TABLE public.${table} DISABLE TRIGGER sp79_suppress`,
      `ALTER TABLE public.${table} DISABLE TRIGGER ALL`,
      `CREATE RULE sp79_hide_insert AS ON INSERT TO public.${table} DO INSTEAD NOTHING`,
    ]) {
      await inRolledBackTransaction(async (client) => {
        await client.query(ddl);
        expect(await guardOutcomes(client), ddl).toEqual(INVALID);
      });
    }
    await withClient(async (client) => expect(await guardOutcomes(client)).toEqual(OPEN));
  });

  it('unlogged tables and inheritance in either direction are INVALID even with canonical columns/constraints', async () => {
    for (const ddl of [
      'ALTER TABLE public.project_operating_calendars SET UNLOGGED',
      'CREATE TABLE public.sp79_child () INHERITS (public.duties)',
      'CREATE TABLE public.sp79_parent (); ALTER TABLE public.plan_assignments INHERIT public.sp79_parent',
    ]) {
      await inRolledBackTransaction(async (client) => {
        await client.query(ddl);
        expect(await guardOutcomes(client), ddl).toEqual(INVALID);
      });
    }
  });

  it.each(PLANNING_RELATIONS)('temporary %s cannot shadow a real dependency, even with an explicit pg_temp search path', async (table) => {
    await inRolledBackTransaction(async (client) => {
      await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table}) ON COMMIT DROP`);
      await client.query('SET LOCAL search_path = pg_temp, public');
      expect((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
      expect(await guardOutcomes(client)).toEqual(INVALID);
    });
  });

  it('RLS can hide a real membership from a restricted role, but the guard refuses to interpret it as no dependency', async () => {
    const tenant = await createSyntheticTenant(db(), 'SP79 RLS');
    createdCompanies.push(tenant.companyId);
    const employee = await createSyntheticEmployee(db(), tenant.employee);
    const project = await createSyntheticProject(db(), tenant.companyId, 'SP79 RLS');
    const planId = await insertPlan(db(), tenant.companyId, project.projectId, '2027-01-01');
    const dutyId = await insertDuty(db(), { companyId: tenant.companyId, projectId: project.projectId, planId,
      month: '2027-01-01', dutyDate: '2027-01-10', startsAt: '2027-01-10T05:00:00Z', endsAt: '2027-01-10T17:00:00Z' });
    await insertMembership(db(), tenant.companyId, dutyId, employee.employeeId);
    const tuple = { employeeId: employee.employeeId, projectId: project.projectId, monthStart: '2027-01-01' };
    await inRolledBackTransaction(async (client) => {
      expect(await hasLiveAssignmentDependency(client, tenant.companyId, [tuple])).toBe(true);
      const role = `sp79_rls_${suffix()}`;
      await client.query(`CREATE ROLE ${role} NOLOGIN;
        GRANT USAGE ON SCHEMA public TO ${role};
        GRANT SELECT ON public.monthly_plans, public.duties, public.plan_assignments, public.cancellation_requests, public.replacement_needs, public.replacement_offers, public.edit_leases, public.project_operating_calendars TO ${role};
        ALTER TABLE public.plan_assignments ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.plan_assignments FORCE ROW LEVEL SECURITY;
        CREATE POLICY sp79_deny ON public.plan_assignments USING (false);
        SET LOCAL ROLE ${role}`);
      expect((await client.query('SELECT count(*)::int AS n FROM public.plan_assignments WHERE company_id = $1', [tenant.companyId])).rows[0].n).toBe(0);
      await expect(hasLiveAssignmentDependency(client, tenant.companyId, [tuple])).rejects.toBeInstanceOf(PlanningSchemaError);
    });
    await withClient(async (client) => expect(await hasLiveAssignmentDependency(client, tenant.companyId, [tuple])).toBe(true));
  });
});

describe('SP-11 — ABSENT schema and committed versus uncommitted DDL across sessions (isolated temporary database)', () => {
  it('ABSENT fails closed; after the canonical schema commits the next statement of an open transaction passes; a committed alteration fails closed again', async () => {
    const database = `sp_e10_guard_${suffix()}`;
    await db().query(`CREATE DATABASE ${database}`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${database}`;
    const sessionA = new pg.Client({ connectionString: url.toString() });
    const sessionB = new pg.Client({ connectionString: url.toString() });
    const migration = (file: string) => readFileSync(`${MIGRATIONS_DIR}${file}`, 'utf8');
    const files = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
    try {
      await sessionA.connect();
      await sessionB.connect();
      for (const file of files.filter((name) => name < '0011')) await sessionB.query(migration(file));
      expect((await sessionA.query<{ transaction_isolation: string }>('SHOW transaction_isolation')).rows[0].transaction_isolation)
        .toBe('read committed');

      await sessionA.query('BEGIN');
      expect(await guardOutcomes(sessionA), 'no planning relation at all').toEqual(ABSENT);
      await sessionB.query('BEGIN');
      for (const file of files.filter((name) => name >= '0011')) await sessionB.query(migration(file));
      expect(await guardOutcomes(sessionA), 'uncommitted DDL is invisible').toEqual(ABSENT);
      await sessionB.query('COMMIT');
      expect(await guardOutcomes(sessionA), 'committed canonical schema, same open transaction').toEqual(OPEN);

      // A planning relation outside the canonical schema: no lock conflict with A's reads of duties.
      await sessionB.query('BEGIN');
      await sessionB.query('CREATE TABLE public.plan_entry (id uuid)');
      expect(await guardOutcomes(sessionA), 'uncommitted extra relation is invisible').toEqual(OPEN);
      await sessionB.query('COMMIT');
      expect(await guardOutcomes(sessionA), 'committed extra relation, same open transaction').toEqual(INVALID);
      await sessionA.query('ROLLBACK');

      // DDL on a canonical table needs ACCESS EXCLUSIVE, which waits for readers of that
      // table; once committed, the next transaction refuses the altered schema.
      await sessionB.query('DROP TABLE public.plan_entry');
      await sessionA.query('BEGIN');
      expect(await guardOutcomes(sessionA), 'extra relation dropped again').toEqual(OPEN);
      await sessionA.query('COMMIT');
      await sessionB.query('DROP INDEX uq_duties__live_slot');
      await sessionA.query('BEGIN');
      expect(await guardOutcomes(sessionA), 'committed index drop').toEqual(INVALID);
      await sessionA.query('ROLLBACK');
    } finally {
      await sessionA.end().catch(() => {});
      await sessionB.end().catch(() => {});
      await db().query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    }
  }, 60_000); // Creates a database and replays every migration.
});

describe('SP-11 — real services: tables alone never block; an extra planning relation makes every effective change fail closed without a trace', () => {
  it.each([
    [
      'in another schema',
      (): string => {
        const schema = `sp_e10_${suffix()}`;
        return `CREATE SCHEMA ${schema}; CREATE TABLE ${schema}.duty_assignment (id uuid)`;
      },
    ],
    // Needs a superuser (Docker setup, CI).
    ['in information_schema', (): string => 'CREATE TABLE information_schema.duty_assignment (id uuid)'],
  ] as const)('assignment PATCH/DELETE and shift PATCH with a planning relation %s', async (_placement, planningDdl) => {
    const tenantA = await createSyntheticTenant(db(), 'SP11 guards');
    createdCompanies.push(tenantA.companyId);
    const employee = await createSyntheticEmployee(db(), tenantA.employee, 'E10-001', { start: '2026-01-01' });
    const north = await createSyntheticProject(db(), tenantA.companyId, 'E10 Nord');
    const assignmentId = randomUUID();
    const historicalId = randomUUID(); // November 2026: a past month for the pinned clock
    await db().query(
      `INSERT INTO project_assignments (id, company_id, employee_id, project_id, planning_month)
       VALUES ($1, $2, $3, $4, '2027-01-01'), ($5, $2, $3, $4, '2026-11-01')`,
      [assignmentId, tenantA.companyId, employee.employeeId, north.projectId, historicalId],
    );
    const tenant = {
      sessionId: randomUUID(), accountId: tenantA.admin.accountId, companyId: tenantA.companyId, role: 'COMPANY_ADMIN',
    } as const;
    const versionOf = async (client: Queryable, id: string) => Number((await client.query<{ version: string }>(
      'SELECT (extract(epoch FROM updated_at) * 1000000)::bigint::text AS version FROM project_assignments WHERE id = $1',
      [id],
    )).rows[0].version);

    await inRolledBackTransaction(async (probe) => {
      // The real service SQL, driven inside the probe transaction that alone sees the extra relation.
      const database = { withTransaction: <T>(work: (client: PoolClient) => Promise<T>) => work(probe) } as unknown as DatabaseService;
      const assignments = new ProjectAssignmentsService(database, new BusinessAuditService(), MID_DEC);
      const shifts = new ShiftConfigurationsService(database, new BusinessAuditService(), MID_DEC);
      const stored = await shifts.replace(tenant, north.projectId, { effectiveFromMonth: '2027-01-01', shifts: [DAY, NIGHT] }, randomUUID());
      const snapshot = async () => ({
        assignment: (await probe.query('SELECT employee_id, project_id, planning_month::text, updated_at FROM project_assignments WHERE id = ANY($1::uuid[]) ORDER BY id', [[assignmentId, historicalId]])).rows,
        rules: (await probe.query('SELECT id, shift_kind, start_local, end_local, updated_at FROM shift_configurations WHERE project_id = $1 ORDER BY id', [north.projectId])).rows,
        audit: (await probe.query('SELECT count(*)::int AS n FROM audit_event WHERE company_id = $1', [tenantA.companyId])).rows[0].n,
      });

      await probe.query(planningDdl());
      const before = await snapshot();

      // True no-ops never reach the guards.
      expect((await assignments.correct(tenant, assignmentId, { monthStart: '2027-01-01' }, randomUUID())).monthStart).toBe('2027-01-01');
      expect(await shifts.replace(tenant, north.projectId, { effectiveFromMonth: '2027-01-01', shifts: [NIGHT, DAY] }, randomUUID()))
        .toEqual(stored);

      // Every effective change fails closed as a technical error (sanitized 500), never a business 409.
      await expect(assignments.correct(tenant, assignmentId, { monthStart: '2027-02-01' }, randomUUID()))
        .rejects.toBeInstanceOf(PlanningSchemaError);
      await expect(shifts.replace(tenant, north.projectId, { effectiveFromMonth: '2027-01-01', shifts: [DAY] }, randomUUID()))
        .rejects.toBeInstanceOf(PlanningSchemaError);
      await expect(assignments.correct(tenant, historicalId, { monthStart: '2027-03-01' }, randomUUID()))
        .rejects.toBeInstanceOf(PlanningSchemaError);
      await expect(assignments.remove(tenant, assignmentId, await versionOf(probe, assignmentId), randomUUID()))
        .rejects.toBeInstanceOf(PlanningSchemaError);
      // Business refusals that precede the guard keep their codes.
      await expect(assignments.remove(tenant, assignmentId, await versionOf(probe, assignmentId) + 1, randomUUID()))
        .rejects.toMatchObject({ status: 409, response: { code: 'PROJECT_ASSIGNMENT_CONFLICT' } });
      await expect(assignments.remove(tenant, historicalId, await versionOf(probe, historicalId), randomUUID()))
        .rejects.toMatchObject({ status: 409, response: { code: 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT' } });
      await probe.query("UPDATE employees SET employment_end = '2027-01-31' WHERE id = $1", [employee.employeeId]);
      await expect(assignments.correct(tenant, assignmentId, { monthStart: '2027-02-01' }, randomUUID()))
        .rejects.toMatchObject({ status: 409, response: { code: 'EMPLOYEE_NOT_EMPLOYED_FOR_MONTH' } });

      // ... without any write or audit entry.
      await probe.query("UPDATE employees SET employment_end = NULL WHERE id = $1", [employee.employeeId]);
      expect(await snapshot()).toEqual(before);
    });

    // After the rollback the canonical schema alone does not block: all three consumers work on committed state.
    const committed = { withTransaction: <T>(work: (c: PoolClient) => Promise<T>) => inTransaction(db(), work) } as unknown as DatabaseService;
    const assignments = new ProjectAssignmentsService(committed, new BusinessAuditService(), MID_DEC);
    const shifts = new ShiftConfigurationsService(committed, new BusinessAuditService(), MID_DEC);
    expect((await shifts.replace(tenant, north.projectId, { effectiveFromMonth: '2027-01-01', shifts: [DAY] }, randomUUID())).shifts)
      .toHaveLength(1);
    expect((await assignments.correct(tenant, historicalId, { monthStart: '2027-03-01' }, randomUUID())).monthStart).toBe('2027-03-01');
    await assignments.remove(tenant, assignmentId, await withClient((client) => versionOf(client, assignmentId)), randomUUID());
    expect((await db().query('SELECT 1 FROM project_assignments WHERE id = $1', [assignmentId])).rowCount).toBe(0);
    expect((await db().query(
      "SELECT count(*)::int AS n FROM audit_event WHERE resource_id = $1 AND action = 'PROJECT_ASSIGNMENT_REMOVED'",
      [assignmentId],
    )).rows[0].n).toBe(1);
  });
});
