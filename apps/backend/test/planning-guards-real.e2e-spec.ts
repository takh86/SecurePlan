/**
 * E-10 — temporary fail-closed planning guards (SP-08b shift configuration,
 * SP-09 assignment correction) against REAL PostgreSQL.
 *
 * Shared-database cases create planning relations only inside transactions
 * that are rolled back, so parallel test files never see them. Committed DDL
 * is exercised in a separate temporary database that is dropped afterwards.
 * Synthetic data only; migrated LOCAL PostgreSQL.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import type { DatabaseService } from '../src/database/database.service.js';
import { BusinessAuditService } from '../src/modules/audit/business-audit.service.js';
import { assertPlanningDependencyCheckImplemented } from '../src/modules/workforce/project-assignments/planning-dependency-guard.js';
import { ProjectAssignmentsService } from '../src/modules/workforce/project-assignments/project-assignments.service.js';
import { PLANNING_GUARD_TABLES } from '../src/modules/workforce/planning-guard/planning-table-classification.js';
import { assertShiftConfigurationPlanningCheckImplemented } from '../src/modules/workforce/shift-configurations/shift-configuration-planning-guard.js';
import { ShiftConfigurationsService } from '../src/modules/workforce/shift-configurations/shift-configurations.service.js';
import {
  createSyntheticEmployee,
  createSyntheticProject,
  createSyntheticTenant,
  openLocalTestPool,
  removeSyntheticTenants,
  type TestPool,
} from './helpers/synthetic-tenants.js';

type Queryable = Pick<PoolClient, 'query'>;

// Pinned instant: 15 Dec 2026 midday UTC -> current month December 2026.
const MID_DEC = () => new Date('2026-12-15T12:00:00Z');
const DAY = { shiftKind: 'DAY', startLocal: '06:00', endLocal: '18:00' } as const;
const NIGHT = { shiftKind: 'NIGHT', startLocal: '18:00', endLocal: '06:00' } as const;

let pool: TestPool | undefined;
const createdCompanies: string[] = [];

function db(): TestPool {
  if (!pool) throw new Error('Test database is unavailable');
  return pool;
}

/** Hex suffix: a safe unquoted identifier that never starts with the reserved `pg_`. */
const suffix = () => randomBytes(6).toString('hex');

async function guardOutcomes(client: Queryable) {
  const settle = async (check: Promise<void>) => {
    try {
      await check;
      return 'PASS';
    } catch (error) {
      const { status, response } = error as { status?: number; response?: { code?: string } };
      return `${status} ${response?.code ?? 'UNEXPECTED_ERROR'}`;
    }
  };
  return {
    sp09: await settle(assertPlanningDependencyCheckImplemented(client)),
    sp08b: await settle(assertShiftConfigurationPlanningCheckImplemented(client)),
  };
}

const OPEN = { sp09: 'PASS', sp08b: 'PASS' };
const CLOSED = { sp09: '409 PROJECT_ASSIGNMENT_CORRECTION_CONFLICT', sp08b: '409 SHIFT_CONFIGURATION_CONFLICT' };

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

beforeAll(() => {
  pool = openLocalTestPool(6);
});

afterAll(async () => {
  if (pool) {
    await removeSyntheticTenants(pool, createdCompanies);
    await pool.end();
  }
});

describe('E-10 — shared planning-table classification, real PostgreSQL', () => {
  it('today no planning relation exists in any schema, and both guards pass', async () => {
    const found = await db().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE c.relname = ANY($1::text[])`,
      [[...PLANNING_GUARD_TABLES]],
    );
    expect(found.rows[0].n).toBe(0);
    const client = await db().connect();
    try {
      expect(await guardOutcomes(client)).toEqual(OPEN);
    } finally {
      client.release();
    }
  });

  it('PostgreSQL\'s own relations (pg_catalog, information_schema, TOAST) cause no false positive', async () => {
    // OIDs below 16384 (FirstNormalObjectId) belong to initdb, i.e. to PostgreSQL itself.
    const system = await db().query<{ schema: string; relations: number; planning: string[] }>(
      `SELECT ns.nspname AS schema, count(*)::int AS relations,
              coalesce(array_agg(c.relname::text) FILTER (WHERE c.relname = ANY($1::text[])), '{}') AS planning
       FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE c.oid < 16384
       GROUP BY 1 ORDER BY 1`,
      [[...PLANNING_GUARD_TABLES]],
    );
    expect(system.rows.map(({ schema }) => schema)).toEqual(expect.arrayContaining(['information_schema', 'pg_catalog', 'pg_toast']));
    for (const { schema, relations, planning } of system.rows) {
      expect(relations, schema).toBeGreaterThan(0);
      expect(planning, schema).toEqual([]);
    }
    const client = await db().connect();
    try {
      expect(await guardOutcomes(client)).toEqual(OPEN);
    } finally {
      client.release();
    }
  });

  it.each([...PLANNING_GUARD_TABLES])(
    '%s: both guards fail closed as a public table, a public view, a table in another schema and a table in information_schema; rollback reopens them',
    async (name) => {
      for (const ddl of [
        `CREATE TABLE public.${name} (id uuid)`,
        `CREATE VIEW public.${name} AS SELECT 1 AS id`,
        (() => {
          const schema = `sp_e10_${suffix()}`;
          return `CREATE SCHEMA ${schema}; CREATE TABLE ${schema}.${name} (id uuid)`;
        })(),
        // Needs a superuser (Docker setup, CI); information_schema is not a system schema for the guards.
        `CREATE TABLE information_schema.${name} (id uuid)`,
      ]) {
        await inRolledBackTransaction(async (client) => {
          expect(await guardOutcomes(client), `${ddl} (before)`).toEqual(OPEN);
          await client.query(ddl);
          expect(await guardOutcomes(client), ddl).toEqual(CLOSED);
        });
      }
      const client = await db().connect();
      try {
        expect(await guardOutcomes(client), `${name} after rollback`).toEqual(OPEN);
      } finally {
        client.release();
      }
    },
  );

  it('a relation in a temporary schema of the session does not count (reserved pg_ schemas are system schemas)', async () => {
    await inRolledBackTransaction(async (client) => {
      await client.query('CREATE TEMPORARY TABLE duties (id uuid) ON COMMIT DROP');
      expect(await guardOutcomes(client)).toEqual(OPEN);
    });
  });
});

describe('E-10 — committed versus uncommitted DDL across sessions (isolated temporary database)', () => {
  it('uncommitted DDL of another session is invisible; after its COMMIT the very next guard call in an open READ COMMITTED transaction fails closed', async () => {
    const database = `sp_e10_guard_${suffix()}`;
    await db().query(`CREATE DATABASE ${database}`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${database}`;
    const sessionA = new pg.Client({ connectionString: url.toString() });
    const sessionB = new pg.Client({ connectionString: url.toString() });
    try {
      await sessionA.connect();
      await sessionB.connect();
      expect((await sessionA.query<{ transaction_isolation: string }>('SHOW transaction_isolation')).rows[0].transaction_isolation)
        .toBe('read committed');

      // Table in public.
      await sessionA.query('BEGIN');
      expect(await guardOutcomes(sessionA)).toEqual(OPEN);
      await sessionB.query('BEGIN');
      await sessionB.query('CREATE TABLE public.duties (id uuid)');
      expect(await guardOutcomes(sessionA), 'uncommitted DDL is invisible').toEqual(OPEN);
      await sessionB.query('COMMIT');
      expect(await guardOutcomes(sessionA), 'committed DDL, same open transaction').toEqual(CLOSED);
      await sessionA.query('ROLLBACK');

      // A committed DROP reopens the guards; nothing is cached.
      await sessionB.query('DROP TABLE public.duties');
      expect(await guardOutcomes(sessionA)).toEqual(OPEN);

      // Same sequence for a planning table in another schema.
      await sessionA.query('BEGIN');
      await sessionB.query('BEGIN');
      await sessionB.query('CREATE SCHEMA planning; CREATE TABLE planning.plan_entries (id uuid)');
      expect(await guardOutcomes(sessionA)).toEqual(OPEN);
      await sessionB.query('COMMIT');
      expect(await guardOutcomes(sessionA)).toEqual(CLOSED);
      await sessionA.query('ROLLBACK');
    } finally {
      await sessionA.end().catch(() => {});
      await sessionB.end().catch(() => {});
      await db().query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    }
  });
});

describe('E-10 — real services: true no-op passes, every effective change fails closed and leaves no trace', () => {
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
  ] as const)('SP-09 correction and SP-08b shift configuration with a planning table %s', async (_placement, planningDdl) => {
    const tenantA = await createSyntheticTenant(db(), 'E10 guards');
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

    await inRolledBackTransaction(async (probe) => {
      // The real service SQL, driven inside the probe transaction that alone sees the planning table.
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

      // Effective changes fail closed with 409 and the catalogued codes ...
      await expect(assignments.correct(tenant, assignmentId, { monthStart: '2027-02-01' }, randomUUID()))
        .rejects.toMatchObject({ status: 409, response: { code: 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT' } });
      await expect(shifts.replace(tenant, north.projectId, { effectiveFromMonth: '2027-01-01', shifts: [DAY] }, randomUUID()))
        .rejects.toMatchObject({ status: 409, response: { code: 'SHIFT_CONFIGURATION_CONFLICT' } });
      // #64 decision B: a historical row moved into a future month WITH evidence still meets the guard.
      await expect(assignments.correct(tenant, historicalId, { monthStart: '2027-03-01' }, randomUUID()))
        .rejects.toMatchObject({ status: 409, response: { code: 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT' } });
      // #64 case 1 and decision B: missing employment evidence is refused before the guard is consulted; still a 409.
      await probe.query("UPDATE employees SET employment_end = '2027-01-31' WHERE id = $1", [employee.employeeId]);
      await expect(assignments.correct(tenant, assignmentId, { monthStart: '2027-02-01' }, randomUUID()))
        .rejects.toMatchObject({ status: 409, response: { code: 'EMPLOYEE_NOT_EMPLOYED_FOR_MONTH' } });
      await expect(assignments.correct(tenant, historicalId, { monthStart: '2027-03-01' }, randomUUID()))
        .rejects.toMatchObject({ status: 409, response: { code: 'EMPLOYEE_NOT_EMPLOYED_FOR_MONTH' } });

      // ... without any write or audit entry.
      expect(await snapshot()).toEqual(before);
    });

    // After the rollback the effective correction works again (guards reopened, no leftovers).
    const client = await db().connect();
    try {
      expect(await guardOutcomes(client)).toEqual(OPEN);
    } finally {
      client.release();
    }
  });
});
