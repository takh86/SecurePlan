/**
 * SP-06 shared synthetic multi-tenant fixture for real-PostgreSQL tests.
 * Creates isolated companies/accounts/sessions with random IDs and removes
 * exactly those rows again. Refuses to run against a non-local database.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg, { type PoolClient } from 'pg';
import type { DatabaseService } from '../../src/database/database.service.js';
import { SessionService } from '../../src/auth/session.service.js';
import type { TenantRole } from '../../src/auth/authorization/tenant-context.js';

const { Pool } = pg;
export type TestPool = InstanceType<typeof Pool>;

/** Fixture-only marker; never a real password hash and never verified by Argon2. */
export const SYNTHETIC_PASSWORD_HASH = 'sp06-synthetic-verified-hash';

export type SyntheticAccount = {
  accountId: string;
  companyId: string;
  role: TenantRole;
  email: string;
};

export type SyntheticTenant = {
  companyId: string;
  admin: SyntheticAccount;
  employee: SyntheticAccount;
};

export type SyntheticSession = {
  cookie: string;
  csrf: string;
  rawToken: string;
};

export function openLocalTestPool(max = 6): TestPool {
  if (!process.env.DATABASE_URL) {
    process.loadEnvFile(fileURLToPath(new URL('../../../../.env', import.meta.url)));
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  // Destructive fixture cleanup is allowed only against a local/test DB.
  const host = new URL(process.env.DATABASE_URL).hostname;
  if (!['localhost', '127.0.0.1', '[::1]', 'postgres'].includes(host)) {
    throw new Error('SP-06 integration tests require a local PostgreSQL instance');
  }
  return new Pool({ connectionString: process.env.DATABASE_URL, max, connectionTimeoutMillis: 5000 });
}

export async function inTransaction<T>(
  pool: TestPool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Real SessionService SQL, driven through the test pool's transaction wrapper. */
export function realSessionService(pool: TestPool): SessionService {
  return new SessionService({
    withTransaction: <T>(work: (client: PoolClient) => Promise<T>) => inTransaction(pool, work),
  } as unknown as DatabaseService);
}

function account(companyId: string, role: TenantRole): SyntheticAccount {
  return {
    accountId: randomUUID(),
    companyId,
    role,
    email: `sp06-${role.toLowerCase()}-${randomUUID()}@secureplan.invalid`,
  };
}

/** Commits before returning: HTTP handlers use independent pooled connections. */
export async function createSyntheticTenant(pool: TestPool, label: string): Promise<SyntheticTenant> {
  const companyId = randomUUID();
  const tenant: SyntheticTenant = {
    companyId,
    admin: account(companyId, 'COMPANY_ADMIN'),
    employee: account(companyId, 'EMPLOYEE'),
  };
  await inTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO companies (id, name, status, time_zone)
       VALUES ($1, $2, 'ACTIVE', 'Europe/Berlin')`,
      [companyId, `SP06 Synthetic ${label}`],
    );
    for (const member of [tenant.admin, tenant.employee]) {
      await client.query(
        `INSERT INTO accounts
           (id, company_id, email, account_scope, role, status, password_hash)
         VALUES ($1, $2, $3, 'TENANT', $4, 'ACTIVE', $5)`,
        [member.accountId, companyId, member.email, member.role, SYNTHETIC_PASSWORD_HASH],
      );
    }
  });
  return tenant;
}

/** Additional ACTIVE account inside an existing synthetic tenant (committed). */
export async function createSyntheticAccount(
  pool: TestPool,
  companyId: string,
  role: TenantRole,
): Promise<SyntheticAccount> {
  const member = account(companyId, role);
  await pool.query(
    `INSERT INTO accounts
       (id, company_id, email, account_scope, role, status, password_hash)
     VALUES ($1, $2, $3, 'TENANT', $4, 'ACTIVE', $5)`,
    [member.accountId, companyId, member.email, role, SYNTHETIC_PASSWORD_HASH],
  );
  return member;
}

export type SyntheticEmployee = {
  employeeId: string;
  employeeNumber: string;
  account: SyntheticAccount;
};

/** SP-07: employee master record for an existing synthetic EMPLOYEE account (committed). */
export async function createSyntheticEmployee(
  pool: TestPool,
  account: SyntheticAccount,
  employeeNumber = `SYN-${randomUUID().slice(0, 8)}`,
  /** Opt-in documented employment (YYYY-MM-DD); omitted = no employment evidence. */
  employment: { start: string | null; end?: string | null } = { start: null },
): Promise<SyntheticEmployee> {
  const employeeId = randomUUID();
  await pool.query(
    `INSERT INTO employees
       (id, company_id, account_id, employee_number, first_name, last_name, shift_eligibility,
        employment_start, employment_end)
     VALUES ($1, $2, $3, $4, 'Synthetic', 'Employee', 'BOTH', $5::date, $6::date)`,
    [employeeId, account.companyId, account.accountId, employeeNumber, employment.start, employment.end ?? null],
  );
  return { employeeId, employeeNumber, account };
}

export type SyntheticProject = {
  projectId: string;
  companyId: string;
  name: string;
};

/** SP-08: project in an existing synthetic tenant (committed). */
export async function createSyntheticProject(
  pool: TestPool,
  companyId: string,
  name = `Synthetic Project ${randomUUID().slice(0, 8)}`,
  status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED' = 'ACTIVE',
): Promise<SyntheticProject> {
  const projectId = randomUUID();
  await pool.query(
    'INSERT INTO projects (id, company_id, name, status) VALUES ($1, $2, $3, $4)',
    [projectId, companyId, name, status],
  );
  return { projectId, companyId, name };
}

export async function createSyntheticSession(
  sessions: SessionService,
  member: SyntheticAccount,
): Promise<SyntheticSession> {
  const created = await sessions.createForAccount({
    companyId: member.companyId,
    accountId: member.accountId,
    verifiedPasswordHash: SYNTHETIC_PASSWORD_HASH,
  });
  return {
    cookie: `__Host-secureplan_session=${created.rawToken}`,
    csrf: created.csrfToken,
    rawToken: created.rawToken,
  };
}

/** Deletes only rows belonging to the given synthetic companies. */
export async function removeSyntheticTenants(pool: TestPool, companyIds: string[]): Promise<void> {
  if (companyIds.length === 0) return;
  await inTransaction(pool, async (client) => {
    // Fail visibly (lock_not_available) instead of hanging into a hook timeout
    // if a leaked test transaction still holds a fixture row lock.
    await client.query("SET LOCAL lock_timeout = '5s'");
    // Children before parents (composite FKs ON DELETE RESTRICT): project
    // assignments (SP-09) and shift configurations (SP-08b) before projects
    // (SP-08) and employees (SP-07), employees before accounts.
    for (const table of [
      'sessions', 'account_tokens', 'audit_event', 'project_assignments', 'shift_configurations', 'projects',
      'employees', 'accounts',
    ]) {
      await client.query(`DELETE FROM ${table} WHERE company_id = ANY($1::uuid[])`, [companyIds]);
    }
    await client.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companyIds]);
  });
}

/**
 * Deterministic barrier: resolves once backend `waiterPid` is waiting on a
 * lock held by `holderPid` (per pg_blocking_pids). No wall-clock sleeps; the
 * bounded loop only re-queries server state.
 */
export async function waitUntilBlockedBy(
  pool: TestPool,
  waiterPid: number,
  holderPid: number,
  maxChecks = 2000,
): Promise<void> {
  for (let check = 0; check < maxChecks; check += 1) {
    const result = await pool.query<{ blocked: boolean }>(
      'SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked',
      [waiterPid, holderPid],
    );
    if (result.rows[0]?.blocked) return;
  }
  throw new Error(`Backend ${waiterPid} never blocked on ${holderPid}`);
}

export async function backendPid(client: PoolClient): Promise<number> {
  const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return result.rows[0].pid;
}
