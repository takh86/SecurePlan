/**
 * SP-11 synthetic planning fixtures for real-PostgreSQL tests. Rows are
 * inserted directly (committed) inside synthetic tenants created by
 * synthetic-tenants.ts and removed with removeSyntheticTenants. Fixtures that
 * contain PUBLISHED plans or removed rows do not prove that a publish or
 * removal endpoint exists.
 */
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '../../src/auth/authorization/tenant-context.js';
import {
  createSyntheticAccount,
  createSyntheticEmployee,
  type SyntheticAccount,
  type SyntheticEmployee,
  type TestPool,
} from './synthetic-tenants.js';

export function adminContext(admin: SyntheticAccount): TenantContext {
  return { sessionId: randomUUID(), accountId: admin.accountId, companyId: admin.companyId, role: 'COMPANY_ADMIN' };
}

/** A new EMPLOYEE account plus employee record (employee/account is 1:1 per company). */
export async function createStaff(
  pool: TestPool,
  companyId: string,
  options: { start?: string | null; end?: string | null; eligibility?: 'TAG' | 'NACHT' | 'BOTH' } = {},
): Promise<SyntheticEmployee> {
  const account = await createSyntheticAccount(pool, companyId, 'EMPLOYEE');
  const employee = await createSyntheticEmployee(pool, account, undefined, {
    start: options.start === undefined ? '2020-01-01' : options.start,
    end: options.end ?? null,
  });
  if (options.eligibility && options.eligibility !== 'BOTH') {
    await pool.query('UPDATE employees SET shift_eligibility = $2 WHERE id = $1', [employee.employeeId, options.eligibility]);
  }
  return employee;
}

export async function insertShiftConfiguration(
  pool: TestPool,
  companyId: string,
  projectId: string,
  month: string,
  rules: readonly { kind: 'TAG' | 'NACHT'; start: string; end: string }[],
): Promise<void> {
  // Explicit synthetic seven-day policy for the pre-A1 planning regression suite.
  // This fixture choice is never a runtime/migration default. A1 missing-policy tests remove it explicitly.
  await pool.query(`INSERT INTO project_operating_calendars (company_id, project_id, effective_from_month, weekday_mask)
    VALUES ($1, $2, '0001-01-01', 127) ON CONFLICT (company_id, project_id, effective_from_month) DO NOTHING`, [companyId, projectId]);
  for (const rule of rules) {
    await pool.query(
      `INSERT INTO shift_configurations (company_id, project_id, effective_from_month, shift_kind, start_local, end_local)
       VALUES ($1, $2, $3::date, $4, $5::time, $6::time)`,
      [companyId, projectId, month, rule.kind, rule.start, rule.end],
    );
  }
}

export const STANDARD_SHIFTS = [
  { kind: 'TAG', start: '06:00', end: '18:00' },
  { kind: 'NACHT', start: '18:00', end: '06:00' },
] as const;

export async function insertProjectAssignment(
  pool: TestPool,
  companyId: string,
  employeeId: string,
  projectId: string,
  month: string,
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO project_assignments (id, company_id, employee_id, project_id, planning_month)
     VALUES ($1, $2, $3, $4, $5::date)`,
    [id, companyId, employeeId, projectId, month],
  );
  return id;
}

export async function insertPlan(
  pool: TestPool,
  companyId: string,
  projectId: string,
  month: string,
  published?: { byAccountId: string },
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO monthly_plans (id, company_id, project_id, planning_month, status, published_at, published_by_account_id)
     VALUES ($1, $2, $3, $4::date, $5, $6, $7)`,
    [id, companyId, projectId, month, published ? 'PUBLISHED' : 'UNPUBLISHED',
      published ? '2026-10-31T12:00:00Z' : null, published?.byAccountId ?? null],
  );
  return id;
}

export type DutyFixture = {
  companyId: string;
  projectId: string;
  planId: string;
  month: string;
  dutyDate: string;
  kind?: 'TAG' | 'NACHT';
  startsAt: string;
  endsAt: string;
  removedAt?: string;
};

export async function insertDuty(pool: TestPool, duty: DutyFixture): Promise<string> {
  const id = randomUUID();
  const kind = duty.kind ?? 'TAG';
  await pool.query(
    `INSERT INTO duties (id, company_id, project_id, monthly_plan_id, planning_month, duty_date, shift_kind,
       starts_at, ends_at, time_zone, config_effective_from_month, start_local, end_local, removed_at)
     VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9, 'Europe/Berlin', $5::date, $10::time, $11::time, $12)`,
    [id, duty.companyId, duty.projectId, duty.planId, duty.month, duty.dutyDate, kind, duty.startsAt, duty.endsAt,
      kind === 'TAG' ? '06:00' : '18:00', kind === 'TAG' ? '18:00' : '06:00', duty.removedAt ?? null],
  );
  return id;
}

export async function insertMembership(
  pool: TestPool,
  companyId: string,
  dutyId: string,
  employeeId: string,
  state: 'ACTIVE' | 'REMOVED' = 'ACTIVE',
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO plan_assignments (id, company_id, duty_id, employee_id, duty_function, state, removed_at)
     VALUES ($1, $2, $3, $4, 'MITARBEITER', $5, $6)`,
    [id, companyId, dutyId, employeeId, state, state === 'REMOVED' ? '2026-10-31T12:00:00Z' : null],
  );
  return id;
}

/** Everything a planning-related write could change for one tenant (rows, versions, audit). */
export async function planningState(pool: TestPool, companyId: string) {
  const query = async (sql: string) => (await pool.query(sql, [companyId])).rows;
  return {
    plans: await query('SELECT id, project_id, planning_month::text, status, updated_at FROM monthly_plans WHERE company_id = $1 ORDER BY id'),
    duties: await query('SELECT id, duty_date::text, shift_kind, concurrency_version, starts_at, ends_at, removed_at, updated_at FROM duties WHERE company_id = $1 ORDER BY id'),
    members: await query('SELECT id, duty_id, employee_id, duty_function, source, state, removed_at, updated_at FROM plan_assignments WHERE company_id = $1 ORDER BY id'),
    leases: await query('SELECT id, duty_id, owner_account_id, token_hash, acquired_at, renewed_at, expires_at, released_at FROM edit_leases WHERE company_id = $1 ORDER BY id'),
    employees: await query('SELECT id, status, employment_start::text, employment_end::text, updated_at FROM employees WHERE company_id = $1 ORDER BY id'),
    projects: await query('SELECT id, status, updated_at FROM projects WHERE company_id = $1 ORDER BY id'),
    assignments: await query('SELECT id, employee_id, project_id, planning_month::text, updated_at FROM project_assignments WHERE company_id = $1 ORDER BY id'),
    shifts: await query('SELECT id, effective_from_month::text, shift_kind, start_local::text, end_local::text, updated_at FROM shift_configurations WHERE company_id = $1 ORDER BY id'),
    accounts: await query('SELECT id, status, updated_at FROM accounts WHERE company_id = $1 ORDER BY id'),
    audit: await query('SELECT id, action FROM audit_event WHERE company_id = $1 ORDER BY id'),
  };
}

/**
 * SP-20: turns a synthetic membership into a REPLACEMENT membership through a real offer chain, because the
 * database requires the origin (ck_plan_assignments__replacement_origin). The membership is also the assignment
 * of a WITHDRAWN cancellation; its need is CLOSED and its only offer is SELECTED for the same employee and duty.
 * No other membership or employee is created, so duty rosters are unchanged.
 */
export async function asReplacementMembership(pool: TestPool, membershipId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const m = (await client.query<{ company_id: string; duty_id: string; employee_id: string }>(
      'SELECT company_id, duty_id, employee_id FROM plan_assignments WHERE id = $1',
      [membershipId],
    )).rows[0];
    // Required-need FK is DEFERRABLE INITIALLY DEFERRED: the cancellation and its need commit together.
    const cancellation = randomUUID();
    await client.query(
      `INSERT INTO cancellation_requests (id, company_id, assignment_id, duty_id, employee_id, submission_version, status)
       VALUES ($1, $2, $3, $4, $5, 1, 'WITHDRAWN')`,
      [cancellation, m.company_id, membershipId, m.duty_id, m.employee_id],
    );
    const need = randomUUID();
    await client.query(
      `INSERT INTO replacement_needs (id, company_id, cancellation_request_id, duty_id, status)
       VALUES ($1, $2, $3, $4, 'CLOSED')`,
      [need, m.company_id, cancellation, m.duty_id],
    );
    const offer = randomUUID();
    // One instant for created, updated and decided (ck_replacement_offers__time requires decided <= updated).
    const at = (await client.query<{ at: string }>('SELECT clock_timestamp()::text AS at')).rows[0].at;
    await client.query(
      `INSERT INTO replacement_offers (id, company_id, need_id, duty_id, employee_id, status, created_at, updated_at, decided_at)
       VALUES ($1, $2, $3, $4, $5, 'SELECTED', $6::timestamptz, $6::timestamptz, $6::timestamptz)`,
      [offer, m.company_id, need, m.duty_id, m.employee_id, at],
    );
    await client.query("UPDATE plan_assignments SET source = 'REPLACEMENT', replacement_offer_id = $2 WHERE id = $1", [membershipId, offer]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
