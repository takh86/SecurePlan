/**
 * SP-07 — employee administration against REAL PostgreSQL (SP-06 Slice 2).
 *
 * Drives the real AppModule over HTTP: real global AccessControlGuard, real
 * sessions, real SQL. Two synthetic tenants (A, B) prove tenant isolation on
 * a production business resource. Only outbound effects are replaced
 * (activation delivery recorder, breached-password lookup).
 *
 * Requires a migrated LOCAL PostgreSQL (0001–0006); fixtures are synthetic and
 * removed after each test.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { SessionService } from '../src/auth/session.service.js';
import {
  SYNTHETIC_PASSWORD_HASH,
  createSyntheticEmployee,
  createSyntheticSession,
  createSyntheticTenant,
  openLocalTestPool,
  realSessionService,
  removeSyntheticTenants,
  type SyntheticEmployee,
  type SyntheticSession,
  type SyntheticTenant,
  type TestPool,
} from './helpers/synthetic-tenants.js';
import { ORIGIN, RecordingDelivery, bootEmployeesApp } from './helpers/employees-test-app.js';

const BASE = '/api/v1/employees';
const RESPONSE_KEYS = [
  'accountStatus', 'email', 'employeeCode', 'employmentEnd', 'employmentStart',
  'firstName', 'id', 'lastName', 'shiftEligibility', 'status',
].sort();

let pool: TestPool | undefined;
let sessions: SessionService;
let app: INestApplication<App> | undefined;
let delivery: RecordingDelivery;
let tenantA: SyntheticTenant;
let tenantB: SyntheticTenant;
let employeeA: SyntheticEmployee;
let employeeB: SyntheticEmployee;
let adminA: SyntheticSession;
let adminB: SyntheticSession;
const createdCompanies: string[] = [];
let previousOrigin: string | undefined;

function db(): TestPool {
  if (!pool) throw new Error('Test database is unavailable');
  return pool;
}

const http = () => request(app!.getHttpServer());

function read(path: string, session?: SyntheticSession) {
  const pending = http().get(path);
  return session ? pending.set('Cookie', session.cookie) : pending;
}

function write(method: 'post' | 'patch', path: string, session: SyntheticSession | null, body: object = {}) {
  let pending = http()[method](path).set('Origin', ORIGIN);
  if (session) pending = pending.set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf);
  return pending.send(body);
}

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    employeeCode: `E-${randomUUID().slice(0, 8)}`,
    firstName: 'Alex',
    lastName: 'Beispiel',
    email: `sp07-${randomUUID()}@secureplan.invalid`,
    shiftEligibility: 'DAY',
    ...overrides,
  };
}

/** Everything a tenant-scoped write could have changed, for before/after equality. */
async function tenantState(companyId: string) {
  const query = async (sql: string) => (await db().query(sql, [companyId])).rows;
  return {
    employees: await query(
      `SELECT id, account_id, employee_number, first_name, last_name, shift_eligibility, status,
              employment_start::text, employment_end::text, deactivated_at, updated_at
       FROM employees WHERE company_id = $1 ORDER BY id`,
    ),
    accounts: await query('SELECT id, email, role, status, updated_at FROM accounts WHERE company_id = $1 ORDER BY id'),
    tokens: await query('SELECT id, used_at, revoked_at FROM account_tokens WHERE company_id = $1 ORDER BY id'),
    sessions: await query('SELECT id, revoked_at FROM sessions WHERE company_id = $1 ORDER BY id'),
    audit: await query('SELECT id FROM audit_event WHERE company_id = $1 ORDER BY id'),
  };
}

async function auditRows(companyId: string, correlationId: string) {
  return (await db().query<{
    action: string;
    resource_type: string;
    resource_id: string;
    actor_account_id: string | null;
    old_values: Record<string, unknown> | null;
    new_values: Record<string, unknown> | null;
  }>(
    `SELECT action, resource_type, resource_id, actor_account_id, old_values, new_values
     FROM audit_event WHERE company_id = $1 AND correlation_id = $2 ORDER BY occurred_at, action`,
    [companyId, correlationId],
  )).rows;
}

beforeAll(() => {
  pool = openLocalTestPool(10);
  sessions = realSessionService(db());
  previousOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
});

beforeEach(async () => {
  tenantA = await createSyntheticTenant(db(), 'SP07 Tenant A');
  createdCompanies.push(tenantA.companyId);
  tenantB = await createSyntheticTenant(db(), 'SP07 Tenant B');
  createdCompanies.push(tenantB.companyId);
  employeeA = await createSyntheticEmployee(db(), tenantA.employee, 'A-001');
  employeeB = await createSyntheticEmployee(db(), tenantB.employee, 'B-001');
  adminA = await createSyntheticSession(sessions, tenantA.admin);
  adminB = await createSyntheticSession(sessions, tenantB.admin);
  delivery = new RecordingDelivery();
  app = await bootEmployeesApp(delivery);
});

afterEach(async () => {
  if (app) await app.close();
  app = undefined;
  const ids = createdCompanies.splice(0);
  try {
    await removeSyntheticTenants(db(), ids);
  } catch (error) {
    throw new Error(`SP-07 fixture cleanup FAILED for companies ${ids.join(', ')}`, { cause: error });
  }
});

afterAll(async () => {
  await pool?.end();
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousOrigin;
});

describe('SP-07 — access control on every employee route', () => {
  function routes(employeeId: string) {
    return [
      { name: 'list', run: (s: SyntheticSession | null) => (s ? read(BASE, s) : read(BASE)) },
      { name: 'detail', run: (s: SyntheticSession | null) => (s ? read(`${BASE}/${employeeId}`, s) : read(`${BASE}/${employeeId}`)) },
      { name: 'create', run: (s: SyntheticSession | null) => write('post', BASE, s, createBody()) },
      { name: 'update', run: (s: SyntheticSession | null) => write('patch', `${BASE}/${employeeId}`, s, { firstName: 'Changed' }) },
      { name: 'deactivate', run: (s: SyntheticSession | null) => write('post', `${BASE}/${employeeId}/deactivate`, s) },
    ];
  }

  it('unauthenticated: 401 SESSION_REQUIRED on all five routes and no state change', async () => {
    const before = await tenantState(tenantA.companyId);
    for (const route of routes(employeeA.employeeId)) {
      const response = await route.run(null);
      expect({ route: route.name, status: response.status, code: response.body.code })
        .toEqual({ route: route.name, status: 401, code: 'SESSION_REQUIRED' });
    }
    expect(await tenantState(tenantA.companyId)).toEqual(before);
    expect(delivery.sent).toEqual([]);
  });

  it('EMPLOYEE role: 403 ACTION_FORBIDDEN on all five routes (incl. own record) and no state change', async () => {
    const employee = await createSyntheticSession(sessions, tenantA.employee);
    const before = await tenantState(tenantA.companyId);
    for (const route of routes(employeeA.employeeId)) {
      const response = await route.run(employee);
      expect({ route: route.name, status: response.status, code: response.body.code })
        .toEqual({ route: route.name, status: 403, code: 'ACTION_FORBIDDEN' });
    }
    // Only the employee's own session activity may have moved (last_seen_at is not compared).
    expect(await tenantState(tenantA.companyId)).toEqual(before);
    expect(delivery.sent).toEqual([]);
  });

  it('writes without a valid Origin or CSRF token are rejected before any change', async () => {
    const otherAdminA = await createSyntheticSession(sessions, tenantA.admin);
    const before = await tenantState(tenantA.companyId);
    const target = `${BASE}/${employeeA.employeeId}`;

    // Thunks: supertest requests must be created only when they are sent.
    const attempts = [
      () => http().post(BASE).set('Origin', ORIGIN).set('Cookie', adminA.cookie).send(createBody()),
      () => http().patch(target).set('Origin', ORIGIN).set('Cookie', adminA.cookie)
        .set('X-CSRF-Token', otherAdminA.csrf).send({ firstName: 'Changed' }),
      () => http().post(`${target}/deactivate`).set('Origin', 'https://attacker.example')
        .set('Cookie', adminA.cookie).set('X-CSRF-Token', adminA.csrf).send({}),
      () => http().post(`${target}/deactivate`).set('Cookie', adminA.cookie).set('X-CSRF-Token', adminA.csrf).send({}),
    ];
    for (const attempt of attempts) {
      const response = await attempt();
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('CSRF_VALIDATION_FAILED');
    }
    expect(await tenantState(tenantA.companyId)).toEqual(before);
  });
});

describe('SP-07 — tenant isolation (cases 3, 4, 5, 7, 10)', () => {
  it('admin A lists and reads only tenant A employees; client tenant hints are rejected or ignored', async () => {
    const list = await read(BASE, adminA).set('X-Company-Id', tenantB.companyId).expect(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body.items.map((item: { id: string }) => item.id)).toEqual([employeeA.employeeId]);
    expect(list.body.pagination).toEqual({ page: 1, pageSize: 25, totalItems: 1, totalPages: 1 });

    const listB = await read(BASE, adminB).expect(200);
    expect(listB.body.items.map((item: { id: string }) => item.id)).toEqual([employeeB.employeeId]);

    const hinted = await read(`${BASE}?companyId=${tenantB.companyId}`, adminA).expect(400);
    expect(hinted.body.code).toBe('UNKNOWN_FIELD');

    const detail = await read(`${BASE}/${employeeA.employeeId}`, adminA).expect(200);
    expect(Object.keys(detail.body).sort()).toEqual(RESPONSE_KEYS);
    expect(detail.body).toEqual({
      id: employeeA.employeeId,
      employeeCode: 'A-001',
      firstName: 'Synthetic',
      lastName: 'Employee',
      employmentStart: null,
      employmentEnd: null,
      shiftEligibility: 'BOTH',
      status: 'ACTIVE',
      email: tenantA.employee.email,
      accountStatus: 'ACTIVE',
    });
  });

  it('a tenant B id answers exactly like an unknown id (404) for read, update and deactivate; B stays untouched', async () => {
    const employeeBSession = await createSyntheticSession(sessions, tenantB.employee);
    const beforeB = await tenantState(tenantB.companyId);
    const unknown = randomUUID();

    const shape = (body: Record<string, unknown>) => {
      const { correlationId, instance, ...rest } = body;
      expect(typeof correlationId).toBe('string');
      expect(typeof instance).toBe('string');
      return rest;
    };

    const pairs = [
      [() => read(`${BASE}/${employeeB.employeeId}`, adminA), () => read(`${BASE}/${unknown}`, adminA)],
      [() => write('patch', `${BASE}/${employeeB.employeeId}`, adminA, { firstName: 'Hijacked' }),
        () => write('patch', `${BASE}/${unknown}`, adminA, { firstName: 'Hijacked' })],
      [() => write('post', `${BASE}/${employeeB.employeeId}/deactivate`, adminA),
        () => write('post', `${BASE}/${unknown}/deactivate`, adminA)],
    ] as const;
    for (const [foreignRequest, unknownRequest] of pairs) {
      const foreign = await foreignRequest();
      const missing = await unknownRequest();
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(foreign.body.code).toBe('RESOURCE_NOT_FOUND');
      expect(shape(foreign.body)).toEqual(shape(missing.body));
    }

    // A malformed id cannot exist either: same 404, never a 500 from a uuid cast.
    const malformed = await read(`${BASE}/not-a-uuid`, adminA).expect(404);
    expect(malformed.body.code).toBe('RESOURCE_NOT_FOUND');

    expect(await tenantState(tenantB.companyId)).toEqual(beforeB);
    // B's employee keeps a working session.
    await read('/api/v1/me', employeeBSession).expect(200);
  });

  it('create always lands in the session tenant; body tenant/role/status fields are rejected', async () => {
    for (const forbidden of [
      { companyId: tenantB.companyId },
      { accountId: tenantB.employee.accountId },
      { role: 'COMPANY_ADMIN' },
      { status: 'INACTIVE' },
      { employmentEnd: '2027-01-01' },
    ]) {
      const response = await write('post', BASE, adminA, createBody(forbidden)).expect(400);
      expect(response.body.code).toBe('UNKNOWN_FIELD');
    }
    expect((await db().query('SELECT count(*)::int AS n FROM employees WHERE company_id = $1', [tenantB.companyId])).rows[0].n).toBe(1);

    const created = await write('post', BASE, adminB, createBody()).expect(201);
    const row = await db().query('SELECT company_id FROM employees WHERE id = $1', [created.body.id]);
    expect(row.rows[0].company_id).toBe(tenantB.companyId);
  });
});

describe('SP-07 — create and activation', () => {
  it('provisions an ACTIVE employee with a PENDING_ACTIVATION EMPLOYEE account, a digest-only token and audit', async () => {
    const email = `SP07-Upper-${randomUUID()}@SecurePlan.invalid`;
    const response = await write('post', BASE, adminA, createBody({
      employeeCode: '  A-100  ',
      firstName: '  Mira ',
      lastName: 'Müller',
      email: `  ${email} `,
      employmentStart: '2026-11-01',
      shiftEligibility: 'NIGHT',
    })).expect(201);

    expect(Object.keys(response.body).sort()).toEqual(RESPONSE_KEYS);
    expect(response.body).toMatchObject({
      employeeCode: 'A-100',
      firstName: 'Mira',
      lastName: 'Müller',
      employmentStart: '2026-11-01',
      employmentEnd: null,
      shiftEligibility: 'NIGHT',
      status: 'ACTIVE',
      email: email.toLowerCase(),
      accountStatus: 'PENDING_ACTIVATION',
    });

    const stored = await db().query(
      `SELECT e.company_id, e.shift_eligibility, e.status, a.role, a.account_scope, a.status AS account_status,
              a.password_hash, a.email
       FROM employees e JOIN accounts a ON a.company_id = e.company_id AND a.id = e.account_id
       WHERE e.id = $1`,
      [response.body.id],
    );
    expect(stored.rows[0]).toEqual({
      company_id: tenantA.companyId,
      shift_eligibility: 'NACHT',
      status: 'ACTIVE',
      role: 'EMPLOYEE',
      account_scope: 'TENANT',
      account_status: 'PENDING_ACTIVATION',
      password_hash: null,
      email: email.toLowerCase(),
    });

    const tokens = await db().query(
      `SELECT t.purpose, t.used_at, t.revoked_at, octet_length(t.token_hash) AS digest_bytes,
              t.expires_at - t.created_at > INTERVAL '23 hours' AS about_one_day
       FROM account_tokens t JOIN employees e ON e.company_id = t.company_id AND e.account_id = t.account_id
       WHERE e.id = $1`,
      [response.body.id],
    );
    expect(tokens.rows).toEqual([
      { purpose: 'EMAIL_VERIFICATION', used_at: null, revoked_at: null, digest_bytes: 32, about_one_day: true },
    ]);
    expect(delivery.sent).toHaveLength(1);
    expect(delivery.sent[0].email).toBe(email.toLowerCase());
    expect(delivery.sent[0].rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const correlationId = response.headers['x-correlation-id'];
    const audit = await auditRows(tenantA.companyId, correlationId);
    expect(audit.map((row) => [row.action, row.resource_type, row.actor_account_id])).toEqual([
      ['ACCOUNT_PROVISIONED', 'ACCOUNT', tenantA.admin.accountId],
      ['EMPLOYEE_CREATED', 'EMPLOYEE', tenantA.admin.accountId],
    ]);
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(email.toLowerCase());
    expect(serialized).not.toContain(delivery.sent[0].rawToken);
    expect(serialized).not.toContain('Mira');
  });

  it('the delivered token activates the account through the existing Identity flow', async () => {
    const created = await write('post', BASE, adminA, createBody()).expect(201);
    const token = delivery.tokenFor(created.body.email);

    await http().post('/api/v1/auth/activate')
      .send({ token, password: `Synthetic-${randomBytes(12).toString('hex')}` })
      .expect(200);

    const detail = await read(`${BASE}/${created.body.id}`, adminA).expect(200);
    expect(detail.body.accountStatus).toBe('ACTIVE');
    expect(detail.body.status).toBe('ACTIVE');
  });

  it('employee code: 409 inside the tenant (no orphan account), but reusable in another tenant', async () => {
    await write('post', BASE, adminA, createBody({ employeeCode: 'DUP-1' })).expect(201);
    const secondEmail = `sp07-dup-${randomUUID()}@secureplan.invalid`;
    const duplicate = await write('post', BASE, adminA, createBody({ employeeCode: 'DUP-1', email: secondEmail })).expect(409);
    expect(duplicate.body.code).toBe('EMPLOYEE_CODE_ALREADY_EXISTS');
    expect((await db().query('SELECT count(*)::int AS n FROM accounts WHERE lower(email) = $1', [secondEmail])).rows[0].n).toBe(0);

    await write('post', BASE, adminB, createBody({ employeeCode: 'DUP-1' })).expect(201);
  });

  it('e-mail: unique across tenants and case-insensitive; a conflict leaves no orphan employee or account', async () => {
    const email = `sp07-unique-${randomUUID()}@secureplan.invalid`;
    await write('post', BASE, adminA, createBody({ email })).expect(201);
    const before = await tenantState(tenantB.companyId);

    const sameTenant = await write('post', BASE, adminA, createBody({ employeeCode: 'MAIL-2', email: email.toUpperCase() })).expect(409);
    expect(sameTenant.body.code).toBe('EMAIL_ALREADY_IN_USE');
    // Documented trade-off: global uniqueness means this 409 can reveal enrolment in another tenant.
    const otherTenant = await write('post', BASE, adminB, createBody({ employeeCode: 'MAIL-3', email })).expect(409);
    expect(otherTenant.body.code).toBe('EMAIL_ALREADY_IN_USE');

    expect(await tenantState(tenantB.companyId)).toEqual(before);
    const codes = await db().query(
      "SELECT count(*)::int AS n FROM employees WHERE employee_number IN ('MAIL-2', 'MAIL-3')",
    );
    expect(codes.rows[0].n).toBe(0);
    expect(delivery.sent).toHaveLength(1);
  });

  it('invalid create input: 400 VALIDATION_FAILED with safe pointers and nothing persisted', async () => {
    const before = await tenantState(tenantA.companyId);
    const cases: [Record<string, unknown>, string, string][] = [
      [{ employeeCode: undefined }, '#/employeeCode', 'REQUIRED'],
      [{ employeeCode: '-starts-with-dash' }, '#/employeeCode', 'INVALID_FORMAT'],
      [{ employeeCode: 'X'.repeat(31) }, '#/employeeCode', 'TOO_LONG'],
      [{ firstName: ' A ' }, '#/firstName', 'TOO_SHORT'],
      [{ lastName: 'L'.repeat(51) }, '#/lastName', 'TOO_LONG'],
      [{ email: 'not-an-email' }, '#/email', 'INVALID_FORMAT'],
      [{ employmentStart: '2026-02-30' }, '#/employmentStart', 'INVALID_FORMAT'],
      [{ employmentStart: '01.11.2026' }, '#/employmentStart', 'INVALID_FORMAT'],
      [{ shiftEligibility: 'TAG' }, '#/shiftEligibility', 'INVALID_ENUM'],
      [{ shiftEligibility: undefined }, '#/shiftEligibility', 'REQUIRED'],
    ];
    for (const [override, pointer, code] of cases) {
      const response = await write('post', BASE, adminA, createBody(override)).expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(response.body.errors).toContainEqual(expect.objectContaining({ pointer, code }));
      // Rejected values are never echoed back.
      expect(JSON.stringify(response.body)).not.toContain('starts-with-dash');
    }
    expect(await tenantState(tenantA.companyId)).toEqual(before);
    expect(delivery.sent).toEqual([]);
  });
});

describe('SP-07 — update', () => {
  it('corrects master data and audits the employee-code change with old/new values', async () => {
    const response = await write('patch', `${BASE}/${employeeA.employeeId}`, adminA, {
      employeeCode: 'A-002',
      shiftEligibility: 'NIGHT',
      employmentStart: '2026-01-01',
      employmentEnd: '2026-12-31',
      firstName: 'Renamed',
    }).expect(200);
    expect(response.body).toMatchObject({
      id: employeeA.employeeId,
      employeeCode: 'A-002',
      firstName: 'Renamed',
      shiftEligibility: 'NIGHT',
      employmentStart: '2026-01-01',
      employmentEnd: '2026-12-31',
    });

    const audit = await auditRows(tenantA.companyId, response.headers['x-correlation-id']);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'EMPLOYEE_UPDATED',
      resource_type: 'EMPLOYEE',
      resource_id: employeeA.employeeId,
      actor_account_id: tenantA.admin.accountId,
      old_values: { employeeCode: 'A-001', shiftEligibility: 'BOTH', employmentStart: null, employmentEnd: null },
      new_values: {
        employeeCode: 'A-002',
        shiftEligibility: 'NIGHT',
        employmentStart: '2026-01-01',
        employmentEnd: '2026-12-31',
      },
    });
    expect(audit[0].new_values?.changedFields).toEqual(
      expect.arrayContaining(['employeeCode', 'firstName', 'shiftEligibility', 'employmentStart', 'employmentEnd']),
    );
    // Personal names are recorded as "changed" only.
    expect(JSON.stringify(audit)).not.toContain('Renamed');

    // Clearing a nullable date is allowed.
    const cleared = await write('patch', `${BASE}/${employeeA.employeeId}`, adminA, { employmentEnd: null }).expect(200);
    expect(cleared.body.employmentEnd).toBeNull();
  });

  it('rejects empty, e-mail, null-required, conflicting-date and duplicate-code patches without changes', async () => {
    await write('post', BASE, adminA, createBody({ employeeCode: 'TAKEN-1' })).expect(201);
    const before = await tenantState(tenantA.companyId);
    const target = `${BASE}/${employeeA.employeeId}`;

    expect((await write('patch', target, adminA, {}).expect(400)).body.code).toBe('EMPTY_PATCH');
    expect((await write('patch', target, adminA, { email: 'new@secureplan.invalid' }).expect(400)).body.code)
      .toBe('UNKNOWN_FIELD');
    expect((await write('patch', target, adminA, { status: 'INACTIVE' }).expect(400)).body.code).toBe('UNKNOWN_FIELD');
    const nulled = await write('patch', target, adminA, { employeeCode: null }).expect(400);
    expect(nulled.body.code).toBe('VALIDATION_FAILED');
    expect(nulled.body.errors).toContainEqual(expect.objectContaining({ pointer: '#/employeeCode', code: 'INVALID_TYPE' }));
    expect((await write('patch', target, adminA, { employmentStart: '2026-05-01', employmentEnd: '2026-04-30' })
      .expect(400)).body.code).toBe('EMPLOYMENT_DATE_CONFLICT');
    expect((await write('patch', target, adminA, { employeeCode: 'TAKEN-1' }).expect(409)).body.code)
      .toBe('EMPLOYEE_CODE_ALREADY_EXISTS');

    expect(await tenantState(tenantA.companyId)).toEqual(before);
  });
});

describe('SP-07 — deactivation', () => {
  it('revokes every session and open token immediately, keeps the record and audits the revoke result', async () => {
    const first = await createSyntheticSession(sessions, tenantA.employee);
    const second = await createSyntheticSession(sessions, tenantA.employee);
    await db().query(
      `INSERT INTO account_tokens (company_id, account_id, purpose, token_hash, expires_at)
       VALUES ($1, $2, 'PASSWORD_RESET', $3, now() + INTERVAL '1 hour')`,
      [tenantA.companyId, tenantA.employee.accountId, randomBytes(32)],
    );
    const employeeBSession = await createSyntheticSession(sessions, tenantB.employee);
    await read('/api/v1/me', first).expect(200);

    const response = await write('post', `${BASE}/${employeeA.employeeId}/deactivate`, adminA).expect(200);
    expect(response.body).toMatchObject({ id: employeeA.employeeId, status: 'INACTIVE', accountStatus: 'DEACTIVATED' });

    // Old cookies are dead on the very next request.
    for (const session of [first, second]) {
      const denied = await read('/api/v1/me', session).expect(401);
      expect(denied.body.code).toBe('SESSION_REVOKED');
    }
    const state = await db().query(
      `SELECT
         (SELECT count(*)::int FROM sessions WHERE account_id = $1 AND revoked_at IS NULL) AS live_sessions,
         (SELECT count(*)::int FROM account_tokens WHERE account_id = $1 AND used_at IS NULL AND revoked_at IS NULL) AS open_tokens,
         (SELECT status FROM accounts WHERE id = $1) AS account_status,
         (SELECT status FROM employees WHERE id = $2) AS employee_status,
         (SELECT deactivated_at IS NOT NULL FROM employees WHERE id = $2) AS has_deactivated_at`,
      [tenantA.employee.accountId, employeeA.employeeId],
    );
    expect(state.rows[0]).toEqual({
      live_sessions: 0,
      open_tokens: 0,
      account_status: 'DEACTIVATED',
      employee_status: 'DEACTIVATED',
      has_deactivated_at: true,
    });
    await expect(sessions.createForAccount({
      companyId: tenantA.companyId,
      accountId: tenantA.employee.accountId,
      verifiedPasswordHash: SYNTHETIC_PASSWORD_HASH,
    })).rejects.toMatchObject({ status: 401, response: { code: 'INVALID_CREDENTIALS' } });

    const audit = await auditRows(tenantA.companyId, response.headers['x-correlation-id']);
    expect(audit.map((row) => row.action)).toEqual(['ACCOUNT_DEACTIVATED', 'EMPLOYEE_DEACTIVATED']);
    expect(audit[0].new_values).toEqual({ status: 'DEACTIVATED', revokedSessions: 2, revokedTokens: 1 });

    // History stays readable; filters see the new status.
    const detail = await read(`${BASE}/${employeeA.employeeId}`, adminA).expect(200);
    expect(detail.body).toMatchObject({ status: 'INACTIVE', accountStatus: 'DEACTIVATED' });
    const inactive = await read(`${BASE}?status=INACTIVE`, adminA).expect(200);
    expect(inactive.body.items.map((item: { id: string }) => item.id)).toEqual([employeeA.employeeId]);
    expect((await read(`${BASE}?status=ACTIVE`, adminA).expect(200)).body.items).toEqual([]);

    // Not repeatable; the acting admin and the other tenant are unaffected.
    const again = await write('post', `${BASE}/${employeeA.employeeId}/deactivate`, adminA).expect(409);
    expect(again.body.code).toBe('EMPLOYEE_INACTIVE');
    await read('/api/v1/me', adminA).expect(200);
    await read('/api/v1/me', employeeBSession).expect(200);

    // Master-data correction of an inactive record stays possible (no reactivation path).
    const corrected = await write('patch', `${BASE}/${employeeA.employeeId}`, adminA, { employmentEnd: '2026-10-22' })
      .expect(200);
    expect(corrected.body).toMatchObject({ status: 'INACTIVE', employmentEnd: '2026-10-22', accountStatus: 'DEACTIVATED' });
  });

  it('a pending account can be deactivated and its activation link stops working', async () => {
    const created = await write('post', BASE, adminA, createBody()).expect(201);
    const token = delivery.tokenFor(created.body.email);
    await write('post', `${BASE}/${created.body.id}/deactivate`, adminA).expect(200);

    const activation = await http().post('/api/v1/auth/activate')
      .send({ token, password: `Synthetic-${randomBytes(12).toString('hex')}` })
      .expect(400);
    expect(activation.body.code).toBe('ACTIVATION_TOKEN_INVALID_OR_EXPIRED');
  });

  it('rejects a deactivation payload', async () => {
    const response = await write('post', `${BASE}/${employeeA.employeeId}/deactivate`, adminA, { reason: 'x' }).expect(400);
    expect(response.body.code).toBe('INVALID_REQUEST_BODY');
    expect((await db().query('SELECT status FROM employees WHERE id = $1', [employeeA.employeeId])).rows[0].status)
      .toBe('ACTIVE');
  });
});

describe('SP-07 — list query', () => {
  beforeEach(async () => {
    for (const [employeeCode, firstName, lastName, shiftEligibility] of [
      ['L-003', 'Mira', 'Müller', 'DAY'],
      ['L-001', 'Jonas', 'Albrecht', 'NIGHT'],
      ['L-002', 'Pia', 'Pro%zent', 'BOTH'],
    ]) {
      await write('post', BASE, adminA, createBody({ employeeCode, firstName, lastName, shiftEligibility })).expect(201);
    }
  });

  const codes = (response: { body: { items: { employeeCode: string }[] } }) =>
    response.body.items.map((item) => item.employeeCode);

  it('sorts by name by default and supports whitelisted sorting and pagination', async () => {
    // Albrecht, Employee (fixture A-001), Müller, Pro%zent.
    expect(codes(await read(BASE, adminA).expect(200))).toEqual(['L-001', 'A-001', 'L-003', 'L-002']);
    expect(codes(await read(`${BASE}?sortBy=employeeCode&sortOrder=desc`, adminA).expect(200)))
      .toEqual(['L-003', 'L-002', 'L-001', 'A-001']);
    const paged = await read(`${BASE}?sortBy=employeeCode&pageSize=2&page=2`, adminA).expect(200);
    expect(codes(paged)).toEqual(['L-002', 'L-003']);
    expect(paged.body.pagination).toEqual({ page: 2, pageSize: 2, totalItems: 4, totalPages: 2 });
    const beyond = await read(`${BASE}?page=9`, adminA).expect(200);
    expect(beyond.body.items).toEqual([]);
    expect(beyond.body.pagination.totalItems).toBe(4);
  });

  it('searches code and names case-insensitively, literally, and filters by shift eligibility', async () => {
    expect(codes(await read(`${BASE}?q=mÜl`, adminA).expect(200))).toEqual(['L-003']);
    expect(codes(await read(`${BASE}?q=l-00`, adminA).expect(200))).toEqual(['L-001', 'L-003', 'L-002']);
    expect(codes(await read(`${BASE}?q=${encodeURIComponent('o%z')}`, adminA).expect(200))).toEqual(['L-002']);
    // LIKE metacharacters are matched literally, not as wildcards.
    expect(codes(await read(`${BASE}?q=${encodeURIComponent('%%')}`, adminA).expect(200))).toEqual([]);
    expect(codes(await read(`${BASE}?shiftEligibility=NIGHT`, adminA).expect(200))).toEqual(['L-001']);
    // Tenant B never sees tenant A matches.
    expect(codes(await read(`${BASE}?q=L-00`, adminB).expect(200))).toEqual([]);
  });

  it('rejects invalid query parameters', async () => {
    for (const query of ['pageSize=101', 'pageSize=0', 'page=0', 'page=abc', 'sortBy=salary', 'sortOrder=up',
      'q=a', 'q=%20%20', 'status=DEACTIVATED', 'shiftEligibility=TAG', 'status=']) {
      const response = await read(`${BASE}?${query}`, adminA);
      expect({ query, status: response.status, code: response.body.code })
        .toEqual({ query, status: 400, code: 'VALIDATION_FAILED' });
    }
    expect((await read(`${BASE}?foo=1`, adminA).expect(400)).body.code).toBe('UNKNOWN_FIELD');
  });
});
