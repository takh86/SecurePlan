/**
 * SP-11 migration 0011 constraints against REAL PostgreSQL (SP11A-R1 T2 group C;
 * acceptance rows DB-01..DB-04, DST-04). Every case writes inside a transaction
 * that is rolled back, so the shared database and parallel files are untouched.
 * Synthetic data only; migrated LOCAL PostgreSQL.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  createSyntheticEmployee,
  createSyntheticProject,
  createSyntheticTenant,
  openLocalTestPool,
  removeSyntheticTenants,
  type SyntheticEmployee,
  type SyntheticProject,
  type SyntheticTenant,
  type TestPool,
} from './helpers/synthetic-tenants.js';

let pool: TestPool | undefined;
let tenantA: SyntheticTenant;
let tenantB: SyntheticTenant;
let projectA: SyntheticProject;
let projectB: SyntheticProject;
let employeeA: SyntheticEmployee;
let employeeB: SyntheticEmployee;
const createdCompanies: string[] = [];

function db(): TestPool {
  if (!pool) throw new Error('Test database is unavailable');
  return pool;
}

/** Runs `work` in one transaction that is always rolled back. */
async function rolledBack(work: (client: PoolClient) => Promise<void>): Promise<void> {
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

/** Expects the statement to fail with SQLSTATE `code` on `constraint`, inside a savepoint. */
async function rejects(client: PoolClient, sql: string, values: unknown[], code: string, constraint: string): Promise<void> {
  await client.query('SAVEPOINT probe');
  await expect(client.query(sql, values), `${constraint}: ${sql}`).rejects.toMatchObject({ code, constraint });
  await client.query('ROLLBACK TO SAVEPOINT probe');
}

async function plan(client: PoolClient, companyId = tenantA.companyId, projectId = projectA.projectId, month = '2027-03-01'): Promise<string> {
  const id = randomUUID();
  await client.query('INSERT INTO monthly_plans (id, company_id, project_id, planning_month) VALUES ($1, $2, $3, $4::date)',
    [id, companyId, projectId, month]);
  return id;
}

const DUTY_SQL = `INSERT INTO duties (id, company_id, project_id, monthly_plan_id, planning_month, duty_date, shift_kind,
    concurrency_version, starts_at, ends_at, time_zone, config_effective_from_month, start_local, end_local, removed_at)
  VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9, $10, $11, $12::date, $13::time, $14::time, $15)`;

type DutyValues = {
  id: string; companyId: string; projectId: string; planId: string; month: string; dutyDate: string; kind: string;
  version: number | string; startsAt: string; endsAt: string; zone: string; configMonth: string; start: string; end: string; removedAt: string | null;
};

function dutyValues(planId: string, overrides: Partial<DutyValues> = {}): unknown[] {
  const value: DutyValues = {
    id: randomUUID(), companyId: tenantA.companyId, projectId: projectA.projectId, planId, month: '2027-03-01',
    dutyDate: '2027-03-10', kind: 'TAG', version: 1, startsAt: '2027-03-10T05:00:00Z', endsAt: '2027-03-10T17:00:00Z',
    zone: 'Europe/Berlin', configMonth: '2027-01-01', start: '06:00', end: '18:00', removedAt: null, ...overrides,
  };
  return [value.id, value.companyId, value.projectId, value.planId, value.month, value.dutyDate, value.kind, value.version,
    value.startsAt, value.endsAt, value.zone, value.configMonth, value.start, value.end, value.removedAt];
}

const MEMBER_SQL = `INSERT INTO plan_assignments (id, company_id, duty_id, employee_id, duty_function, source, state, removed_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

beforeAll(async () => {
  pool = openLocalTestPool(4);
  tenantA = await createSyntheticTenant(db(), 'SP11 schema A');
  tenantB = await createSyntheticTenant(db(), 'SP11 schema B');
  createdCompanies.push(tenantA.companyId, tenantB.companyId);
  projectA = await createSyntheticProject(db(), tenantA.companyId, 'SP11 Schema A');
  projectB = await createSyntheticProject(db(), tenantB.companyId, 'SP11 Schema B');
  employeeA = await createSyntheticEmployee(db(), tenantA.employee);
  employeeB = await createSyntheticEmployee(db(), tenantB.employee);
});

afterAll(async () => {
  if (pool) {
    await removeSyntheticTenants(pool, createdCompanies);
    await pool.end();
  }
});

describe('DB-01 — monthly plan uniqueness and lifecycle metadata', () => {
  it('one plan per company/project/month; month must be a first day; publish metadata only together with PUBLISHED', async () => {
    await rolledBack(async (client) => {
      await plan(client);
      await rejects(client, 'INSERT INTO monthly_plans (company_id, project_id, planning_month) VALUES ($1, $2, $3)',
        [tenantA.companyId, projectA.projectId, '2027-03-01'], '23505', 'uq_monthly_plans__project_month');
      await rejects(client, 'INSERT INTO monthly_plans (company_id, project_id, planning_month) VALUES ($1, $2, $3)',
        [tenantA.companyId, projectA.projectId, '2027-04-02'], '23514', 'ck_monthly_plans__month');
      for (const [status, at, by] of [
        ['UNPUBLISHED', '2027-03-01T00:00:00Z', null],
        ['UNPUBLISHED', null, tenantA.admin.accountId],
        ['PUBLISHED', null, tenantA.admin.accountId],
        ['PUBLISHED', '2027-03-01T00:00:00Z', null],
        ['PUBLISHED', 'infinity', tenantA.admin.accountId],
        ['DRAFT', null, null],
      ]) {
        await rejects(client,
          'INSERT INTO monthly_plans (company_id, project_id, planning_month, status, published_at, published_by_account_id) VALUES ($1, $2, $3, $4, $5, $6)',
          [tenantA.companyId, projectA.projectId, '2027-05-01', status, at, by], '23514', 'ck_monthly_plans__lifecycle');
      }
      await client.query(
        "INSERT INTO monthly_plans (company_id, project_id, planning_month, status, published_at, published_by_account_id) VALUES ($1, $2, '2027-05-01', 'PUBLISHED', '2027-04-30T10:00:00Z', $3)",
        [tenantA.companyId, projectA.projectId, tenantA.admin.accountId],
      );
    });
  });
});

describe('DB-02 — composite ownership keys reject every foreign or orphan link', () => {
  it('foreign project, foreign publisher, a duty of another project/month, foreign members and duties', async () => {
    await rolledBack(async (client) => {
      await rejects(client, 'INSERT INTO monthly_plans (company_id, project_id, planning_month) VALUES ($1, $2, $3)',
        [tenantA.companyId, projectB.projectId, '2027-03-01'], '23503', 'fk_monthly_plans__project');
      await rejects(client,
        "INSERT INTO monthly_plans (company_id, project_id, planning_month, status, published_at, published_by_account_id) VALUES ($1, $2, '2027-06-01', 'PUBLISHED', now(), $3)",
        [tenantA.companyId, projectA.projectId, tenantB.admin.accountId], '23503', 'fk_monthly_plans__publisher');
      const planA = await plan(client);
      const otherProject = await createSyntheticProject(db(), tenantA.companyId, `SP11 Schema A2 ${randomUUID().slice(0, 6)}`);
      // Same tenant, but the plan belongs to another project, or to another month.
      await rejects(client, DUTY_SQL, dutyValues(planA, { projectId: otherProject.projectId }), '23503', 'fk_duties__plan');
      await rejects(client, DUTY_SQL, dutyValues(planA, { month: '2027-04-01', dutyDate: '2027-04-10' }), '23503', 'fk_duties__plan');
      await rejects(client, DUTY_SQL, dutyValues(planA, { companyId: tenantB.companyId }), '23503', 'fk_duties__plan');
      const dutyId = randomUUID();
      await client.query(DUTY_SQL, dutyValues(planA, { id: dutyId }));
      await rejects(client, MEMBER_SQL, [randomUUID(), tenantA.companyId, dutyId, employeeB.employeeId, 'MITARBEITER', 'NORMAL', 'ACTIVE', null],
        '23503', 'fk_plan_assignments__employee');
      await rejects(client, MEMBER_SQL, [randomUUID(), tenantB.companyId, dutyId, employeeB.employeeId, 'MITARBEITER', 'NORMAL', 'ACTIVE', null],
        '23503', 'fk_plan_assignments__duty');
      // RESTRICT everywhere: a referenced parent cannot be deleted.
      await client.query(MEMBER_SQL, [randomUUID(), tenantA.companyId, dutyId, employeeA.employeeId, 'MITARBEITER', 'NORMAL', 'ACTIVE', null]);
      await rejects(client, 'DELETE FROM duties WHERE id = $1', [dutyId], '23503', 'fk_plan_assignments__duty');
      await rejects(client, 'DELETE FROM monthly_plans WHERE id = $1', [planA], '23503', 'fk_duties__plan');
    });
  });

  it('a duty date outside its plan month is rejected even with a matching plan', async () => {
    await rolledBack(async (client) => {
      const planA = await plan(client);
      await rejects(client, DUTY_SQL, dutyValues(planA, { dutyDate: '2027-04-01' }), '23514', 'ck_duties__date_month');
    });
  });
});

describe('DB-03 — live uniqueness with retained history (K1)', () => {
  it('one live duty per slot; a tombstone frees the slot; one ACTIVE membership per employee and duty; REMOVED rows stay', async () => {
    await rolledBack(async (client) => {
      const planA = await plan(client);
      const first = randomUUID();
      await client.query(DUTY_SQL, dutyValues(planA, { id: first }));
      await rejects(client, DUTY_SQL, dutyValues(planA), '23505', 'uq_duties__live_slot');
      await client.query(DUTY_SQL, dutyValues(planA, { kind: 'NACHT', start: '18:00', end: '06:00', startsAt: '2027-03-10T17:00:00Z', endsAt: '2027-03-11T05:00:00Z' }));
      await client.query('UPDATE duties SET removed_at = now() WHERE id = $1', [first]);
      await client.query(DUTY_SQL, dutyValues(planA));

      const memberSql = (state: string, removedAt: string | null) =>
        [randomUUID(), tenantA.companyId, first, employeeA.employeeId, 'MITARBEITER', 'NORMAL', state, removedAt];
      await client.query(MEMBER_SQL, memberSql('ACTIVE', null));
      await rejects(client, MEMBER_SQL, memberSql('ACTIVE', null), '23505', 'uq_plan_assignments__active_employee');
      await client.query("UPDATE plan_assignments SET state = 'REMOVED', removed_at = now() WHERE duty_id = $1", [first]);
      await client.query(MEMBER_SQL, memberSql('ACTIVE', null));
      await client.query(MEMBER_SQL, memberSql('REMOVED', '2027-03-01T00:00:00Z'));
      const history = await client.query<{ state: string; n: number }>(
        'SELECT state, count(*)::int AS n FROM plan_assignments WHERE duty_id = $1 GROUP BY state ORDER BY state', [first]);
      expect(history.rows).toEqual([{ state: 'ACTIVE', n: 1 }, { state: 'REMOVED', n: 2 }]);
    });
  });
});

describe('DB-04 — exact CHECK constraints, no partial rows', () => {
  it.each([
    ['kind', { kind: 'DAY' }, 'ck_duties__kind'],
    ['version 0', { version: 0 }, 'ck_duties__version'],
    ['version 2^53', { version: '9007199254740992' }, 'ck_duties__version'],
    ['ends at the start', { endsAt: '2027-03-10T05:00:00Z' }, 'ck_duties__interval'],
    ['ends before the start', { endsAt: '2027-03-10T04:00:00Z' }, 'ck_duties__interval'],
    ['infinite end', { endsAt: 'infinity' }, 'ck_duties__interval'],
    ['infinite tombstone', { removedAt: 'infinity' }, 'ck_duties__removed'],
    ['local time with seconds', { start: '06:00:30' }, 'ck_duties__local_precision'],
    ['DAY ending before it starts', { start: '18:00', end: '06:00' }, 'ck_duties__local_precision'],
    ['equal local times', { start: '06:00', end: '06:00' }, 'ck_duties__local_precision'],
    ['configuration month after the plan month', { configMonth: '2027-04-01' }, 'ck_duties__config_month'],
    ['configuration month not a first day', { configMonth: '2027-01-15' }, 'ck_duties__config_month'],
    ['empty zone', { zone: '' }, 'ck_duties__zone_nonempty'],
  ] as const)('duty: %s', async (_name, overrides, constraint) => {
    await rolledBack(async (client) => {
      const planA = await plan(client);
      await rejects(client, DUTY_SQL, dutyValues(planA, overrides), '23514', constraint);
      expect((await client.query('SELECT count(*)::int AS n FROM duties WHERE monthly_plan_id = $1', [planA])).rows[0].n).toBe(0);
    });
  });

  it.each([
    ['function', ['LEITER', 'NORMAL', 'ACTIVE', null], 'ck_plan_assignments__function'],
    ['source', ['MITARBEITER', 'AUTO', 'ACTIVE', null], 'ck_plan_assignments__source'],
    ['ACTIVE with removed_at', ['MITARBEITER', 'NORMAL', 'ACTIVE', '2027-03-01T00:00:00Z'], 'ck_plan_assignments__state'],
    ['REMOVED without removed_at', ['MITARBEITER', 'NORMAL', 'REMOVED', null], 'ck_plan_assignments__state'],
    ['unknown state', ['MITARBEITER', 'NORMAL', 'PENDING', null], 'ck_plan_assignments__state'],
  ] as const)('membership: %s', async (_name, [fn, source, state, removedAt], constraint) => {
    await rolledBack(async (client) => {
      const planA = await plan(client);
      const dutyId = randomUUID();
      await client.query(DUTY_SQL, dutyValues(planA, { id: dutyId }));
      await rejects(client, MEMBER_SQL, [randomUUID(), tenantA.companyId, dutyId, employeeA.employeeId, fn, source, state, removedAt], '23514', constraint);
    });
  });

  it('no FK to shift_configurations or to correctable project_assignments exists (ADR-0003 O-10, T2 B6)', async () => {
    const references = await db().query<{ child: string; parent: string }>(
      `SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
       FROM pg_constraint c
       WHERE c.contype = 'f' AND c.conrelid::regclass::text IN ('monthly_plans', 'duties', 'plan_assignments')
       ORDER BY 1, 2`,
    );
    expect(references.rows).toEqual([
      { child: 'duties', parent: 'monthly_plans' },
      { child: 'monthly_plans', parent: 'accounts' },
      { child: 'monthly_plans', parent: 'projects' },
      { child: 'plan_assignments', parent: 'duties' },
      { child: 'plan_assignments', parent: 'employees' },
    ]);
  });
});

describe('DST-04 — stored instants are exact and independent of the session time zone', () => {
  it('reloads the same UTC instants (including historical second offsets) under UTC, New York and Chatham', async () => {
    await rolledBack(async (client) => {
      const planA = await plan(client, tenantA.companyId, projectA.projectId, '0001-01-01');
      const dutyId = randomUUID();
      await client.query(DUTY_SQL, dutyValues(planA, {
        id: dutyId, month: '0001-01-01', dutyDate: '0001-01-01', configMonth: '0001-01-01',
        startsAt: '0001-01-01T05:06:32Z', endsAt: '0001-01-01T17:06:32Z',
      }));
      const readings: string[] = [];
      for (const zone of ['UTC', 'America/New_York', 'Pacific/Chatham']) {
        await client.query(`SET LOCAL TIME ZONE '${zone}'`);
        const row = (await client.query<{ starts: string; ends: string; epoch: string }>(
          `SELECT to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts,
                  to_char(ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends,
                  extract(epoch FROM starts_at)::bigint::text AS epoch
           FROM duties WHERE id = $1`, [dutyId])).rows[0];
        readings.push(JSON.stringify(row));
      }
      expect(new Set(readings).size).toBe(1);
      // 0001-01-01T00:00:00Z is -62135596800; plus 5 h 6 min 32 s.
      expect(JSON.parse(readings[0])).toEqual({ starts: '0001-01-01T05:06:32Z', ends: '0001-01-01T17:06:32Z', epoch: '-62135578408' });
    });
  });
});
