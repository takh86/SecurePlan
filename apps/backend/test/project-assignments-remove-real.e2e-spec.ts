/**
 * #73 — DELETE /project-assignments/{id} (FUTURE months only) and the
 * assignment `version` against REAL PostgreSQL.
 *
 * PO decisions D73-1..8 (#73 comment 6491464511); TL/API sign-off of the R1
 * precondition with S-2 revision R2 (comments 6492069623, 6492654582):
 * `Expected-Version` = row version (updated_at in epoch µs), strictly
 * increasing per effective write; 400/400/409 and 404/409 semantics; audit
 * PROJECT_ASSIGNMENT_REMOVED with the full removed tuple.
 * The "current month" comes from an injected wall clock (company IANA zone).
 * Every refusal asserts: row, version and audit count unchanged.
 * Synthetic data only; migrated LOCAL PostgreSQL.
 */
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { SessionService } from '../src/auth/session.service.js';
import type { DatabaseService } from '../src/database/database.service.js';
import { BusinessAuditService } from '../src/modules/audit/business-audit.service.js';
import { ProjectAssignmentsService } from '../src/modules/workforce/project-assignments/project-assignments.service.js';
import {
  createSyntheticAccount,
  createSyntheticEmployee,
  createSyntheticProject,
  createSyntheticSession,
  createSyntheticTenant,
  inTransaction,
  openLocalTestPool,
  realSessionService,
  removeSyntheticTenants,
  type SyntheticEmployee,
  type SyntheticProject,
  type SyntheticSession,
  type SyntheticTenant,
  type TestPool,
} from './helpers/synthetic-tenants.js';
import { FailingAudit, ORIGIN, RecordingDelivery, bootEmployeesApp } from './helpers/employees-test-app.js';

const BASE = '/api/v1/project-assignments';
// Pinned instant: 15 Dec 2026 midday UTC -> current month December 2026 (Berlin and UTC alike).
const MID_DEC = () => new Date('2026-12-15T12:00:00Z');
const VERSION_SQL = '(extract(epoch FROM updated_at) * 1000000)::bigint::text';

let pool: TestPool | undefined;
let sessions: SessionService;
let app: INestApplication<App> | undefined;
let tenantA: SyntheticTenant;
let tenantB: SyntheticTenant;
let mira: SyntheticEmployee;
let jonas: SyntheticEmployee;
let employeeB: SyntheticEmployee;
let north: SyntheticProject;
let south: SyntheticProject;
let projectB: SyntheticProject;
let adminA: SyntheticSession;
let adminB: SyntheticSession;
const createdCompanies: string[] = [];
let previousOrigin: string | undefined;

function db(): TestPool {
  if (!pool) throw new Error('Test database is unavailable');
  return pool;
}

const http = () => request(app!.getHttpServer());
const read = (path: string, session: SyntheticSession = adminA) => http().get(path).set('Cookie', session.cookie);

/** DELETE with an optional Expected-Version (a string array is sent as several header lines). */
function remove(id: string, expected?: number | string | string[], session: SyntheticSession | null = adminA) {
  let pending = http().delete(`${BASE}/${id}`).set('Origin', ORIGIN);
  if (session) pending = pending.set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf);
  if (typeof expected === 'number') pending = pending.set('Expected-Version', String(expected));
  // superagent types allow arrays only for Cookie; at runtime Node sends one header line per element.
  else if (expected !== undefined) pending = pending.set('Expected-Version', expected as string);
  return pending;
}

function patch(id: string, body: object, session: SyntheticSession = adminA) {
  return http().patch(`${BASE}/${id}`).set('Origin', ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send(body);
}

/**
 * A request written byte for byte on a socket: duplicate header lines and
 * non-ASCII bytes reach Node's HTTP parser exactly as sent.
 */
async function rawDelete(id: string, headerLines: string[], session: SyntheticSession = adminA) {
  const server = app!.getHttpServer() as unknown as Server;
  if (!server.listening) await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const head = [
    `DELETE ${BASE}/${id} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    `Origin: ${ORIGIN}`,
    `Cookie: ${session.cookie}`,
    `X-CSRF-Token: ${session.csrf}`,
    ...headerLines,
    'Connection: close',
    '',
    '',
  ].join('\r\n');
  const raw = await new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
    socket.on('error', reject);
    socket.write(Buffer.from(head, 'utf8'));
  });
  const separator = raw.indexOf('\r\n\r\n');
  const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1]);
  const text = raw.slice(separator + 4);
  return { status, body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

/** Direct fixture insert (committed); returns the assignment id. */
async function seed(employee: SyntheticEmployee, project: SyntheticProject, month: string): Promise<string> {
  const id = randomUUID();
  await db().query(
    `INSERT INTO project_assignments (id, company_id, employee_id, project_id, planning_month)
     VALUES ($1, $2, $3, $4, $5::date)`,
    [id, employee.account.companyId, employee.employeeId, project.projectId, month],
  );
  return id;
}

/** The stored version exactly as the API must render it; null when the row is gone. */
async function versionOf(id: string): Promise<number | null> {
  const { rows } = await db().query<{ version: string }>(
    `SELECT ${VERSION_SQL} AS version FROM project_assignments WHERE id = $1`,
    [id],
  );
  return rows.length === 0 ? null : Number(rows[0].version);
}

async function exists(id: string): Promise<boolean> {
  return (await db().query('SELECT 1 FROM project_assignments WHERE id = $1', [id])).rowCount === 1;
}

async function auditFor(correlationId: string) {
  return (await db().query(
    `SELECT company_id, action, resource_type, resource_id, actor_account_id, old_values, new_values,
            correlation_id, occurred_at IS NOT NULL AS has_time
     FROM audit_event WHERE correlation_id = $1`,
    [correlationId],
  )).rows;
}

/** Assignments with their exact µs version, plus the audit ids of one tenant. */
async function state(companyId: string) {
  const q = async (sql: string) => (await db().query(sql, [companyId])).rows;
  return {
    assignments: await q(`SELECT id, employee_id, project_id, planning_month::text, ${VERSION_SQL} AS version
                          FROM project_assignments WHERE company_id = $1 ORDER BY id`),
    audit: await q('SELECT id FROM audit_event WHERE company_id = $1 ORDER BY id'),
  };
}

const shape = (body: Record<string, unknown>) => {
  const { correlationId, instance, ...rest } = body;
  expect([typeof correlationId, typeof instance]).toEqual(['string', 'string']);
  return rest;
};

async function bootApp(options: { clock?: () => Date; audit?: FailingAudit } = {}) {
  if (app) await app.close();
  app = await bootEmployeesApp(new RecordingDelivery(), { clock: MID_DEC, ...options });
}

async function setEmployment(employee: SyntheticEmployee, start: string | null, end: string | null) {
  await db().query('UPDATE employees SET employment_start = $2::date, employment_end = $3::date WHERE id = $1', [
    employee.employeeId, start, end,
  ]);
}

const setZone = (zone: string) => db().query('UPDATE companies SET time_zone = $2 WHERE id = $1', [tenantA.companyId, zone]);

beforeAll(() => {
  pool = openLocalTestPool(10);
  sessions = realSessionService(db());
  previousOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
});

beforeEach(async () => {
  tenantA = await createSyntheticTenant(db(), '#73 REMOVE A');
  createdCompanies.push(tenantA.companyId);
  tenantB = await createSyntheticTenant(db(), '#73 REMOVE B');
  createdCompanies.push(tenantB.companyId);
  mira = await createSyntheticEmployee(db(), tenantA.employee, 'A-001', { start: '2020-01-01' });
  jonas = await createSyntheticEmployee(
    db(), await createSyntheticAccount(db(), tenantA.companyId, 'EMPLOYEE'), 'A-002', { start: '2020-01-01' },
  );
  employeeB = await createSyntheticEmployee(db(), tenantB.employee, 'B-001', { start: '2020-01-01' });
  north = await createSyntheticProject(db(), tenantA.companyId, 'Objekt Nord');
  south = await createSyntheticProject(db(), tenantA.companyId, 'Objekt Süd');
  projectB = await createSyntheticProject(db(), tenantB.companyId, 'Objekt B');
  adminA = await createSyntheticSession(sessions, tenantA.admin);
  adminB = await createSyntheticSession(sessions, tenantB.admin);
  await bootApp();
});

afterEach(async () => {
  if (app) await app.close();
  app = undefined;
  const ids = createdCompanies.splice(0);
  try {
    await removeSyntheticTenants(db(), ids);
  } catch (error) {
    throw new Error(`#73 REMOVE fixture cleanup FAILED for companies ${ids.join(', ')}`, { cause: error });
  }
});

afterAll(async () => {
  await pool?.end();
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousOrigin;
});

describe('#73 API-PROJ-12 — removing a future assignment', () => {
  it('204 without body, row gone, exactly one complete audit event; the month is free for a new POST', async () => {
    const id = await seed(mira, north, '2027-02-01');
    const other = await seed(mira, south, '2027-03-01');
    const listed = (await read(`${BASE}?monthStart=2027-02-01`).expect(200)).body.items;
    expect(listed).toEqual([{
      id, employeeId: mira.employeeId, projectId: north.projectId, monthStart: '2027-02-01', version: await versionOf(id),
    }]);

    const response = await remove(id, listed[0].version).expect(204);
    expect(response.text).toBe('');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toBeUndefined();
    expect(await exists(id)).toBe(false);
    expect(await exists(other)).toBe(true);

    const correlationId = response.headers['x-correlation-id'];
    expect(await auditFor(correlationId)).toEqual([{
      company_id: tenantA.companyId,
      action: 'PROJECT_ASSIGNMENT_REMOVED',
      resource_type: 'PROJECT_ASSIGNMENT',
      resource_id: id,
      actor_account_id: tenantA.admin.accountId,
      // The complete removed tuple: IDs and month only, no names or e-mail addresses.
      old_values: { employeeId: mira.employeeId, projectId: north.projectId, monthStart: '2027-02-01' },
      new_values: null,
      correlation_id: correlationId,
      has_time: true,
    }]);
    expect((await read(`${BASE}?monthStart=2027-02-01`).expect(200)).body.items).toEqual([]);

    // Nothing cascades: the employee's employment and status are untouched; the month is free again.
    expect((await db().query(
      "SELECT status, to_char(employment_start, 'YYYY-MM-DD') AS start, employment_end FROM employees WHERE id = $1",
      [mira.employeeId],
    )).rows[0]).toEqual({ status: 'ACTIVE', start: '2020-01-01', employment_end: null });
    const recreated = await http().post(BASE).set('Origin', ORIGIN).set('Cookie', adminA.cookie).set('X-CSRF-Token', adminA.csrf)
      .send({ employeeId: mira.employeeId, projectId: south.projectId, monthStart: '2027-02-01' }).expect(201);
    expect(recreated.body.id).not.toBe(id);
  });
});

describe('#73 API-PROJ-13 — only months after the company\'s current month (IANA time zone)', () => {
  it('next month and next year: 204; current and past month: 409 PROJECT_ASSIGNMENT_CORRECTION_CONFLICT without a trace', async () => {
    const january = await seed(mira, north, '2027-01-01');
    const nextYear = await seed(jonas, north, '2028-06-01');
    const current = await seed(mira, south, '2026-12-01');
    const past = await seed(mira, north, '2026-11-01');
    const before = await state(tenantA.companyId);
    for (const id of [current, past]) {
      const refused = await remove(id, (await versionOf(id))!).expect(409);
      expect(refused.body.code).toBe('PROJECT_ASSIGNMENT_CORRECTION_CONFLICT');
      expect(await auditFor(refused.headers['x-correlation-id'])).toEqual([]);
    }
    expect(await state(tenantA.companyId)).toEqual(before);
    await remove(january, (await versionOf(january))!).expect(204);
    await remove(nextYear, (await versionOf(nextYear))!).expect(204);
    expect([await exists(current), await exists(past)]).toEqual([true, true]);
  });

  it('30 Nov 23:30 UTC: a December row is current in Berlin (409) but future in New York (204)', async () => {
    await bootApp({ clock: () => new Date('2026-11-30T23:30:00Z') });
    const id = await seed(mira, north, '2026-12-01');
    const version = (await versionOf(id))!;
    expect((await remove(id, version).expect(409)).body.code).toBe('PROJECT_ASSIGNMENT_CORRECTION_CONFLICT');
    expect(await versionOf(id)).toBe(version);
    await setZone('America/New_York');
    await remove(id, version).expect(204);
  });

  it('31 Dec 23:30 UTC (year boundary): a January row is current in Berlin (409) but future in New York (204)', async () => {
    await bootApp({ clock: () => new Date('2026-12-31T23:30:00Z') });
    const id = await seed(mira, north, '2027-01-01');
    const version = (await versionOf(id))!;
    expect((await remove(id, version).expect(409)).body.code).toBe('PROJECT_ASSIGNMENT_CORRECTION_CONFLICT');
    expect(await versionOf(id)).toBe(version);
    await setZone('America/New_York');
    await remove(id, version).expect(204);
  });
});

describe('#73 API-PROJ-14 — status and employment are not checked (PO)', () => {
  it('a deactivated employee (and account), a row without employment evidence, an INACTIVE and an ARCHIVED project: 204 each', async () => {
    const deactivated = await seed(mira, north, '2027-02-01');
    const noEvidence = await seed(jonas, north, '2027-02-01');
    const inactiveProject = await createSyntheticProject(db(), tenantA.companyId, 'Inaktiv', 'INACTIVE');
    const archivedProject = await createSyntheticProject(db(), tenantA.companyId, 'Archiv', 'ARCHIVED');
    const onInactive = await seed(mira, inactiveProject, '2027-03-01');
    const onArchived = await seed(mira, archivedProject, '2027-04-01');
    await db().query("UPDATE employees SET status = 'DEACTIVATED' WHERE id = $1", [mira.employeeId]);
    await db().query("UPDATE accounts SET status = 'DEACTIVATED' WHERE id = $1", [mira.account.accountId]);
    await setEmployment(jonas, null, null);
    for (const id of [deactivated, noEvidence, onInactive, onArchived]) {
      const response = await remove(id, (await versionOf(id))!).expect(204);
      expect(await auditFor(response.headers['x-correlation-id'])).toHaveLength(1);
      expect(await exists(id)).toBe(false);
    }
  });
});

describe('#73 API-PROJ-15/16/28 — the Expected-Version header', () => {
  it('missing: 400 EXPECTED_VERSION_REQUIRED (never 204); If-Match alone does not replace it', async () => {
    const id = await seed(mira, north, '2027-02-01');
    const version = (await versionOf(id))!;
    const before = await state(tenantA.companyId);
    expect((await remove(id).expect(400)).body.code).toBe('EXPECTED_VERSION_REQUIRED');
    expect((await remove(id).set('If-Match', `"${version}"`).expect(400)).body.code).toBe('EXPECTED_VERSION_REQUIRED');
    expect((await remove(id).set('If-Match', '*').expect(400)).body.code).toBe('EXPECTED_VERSION_REQUIRED');
    expect((await remove(id).set('If-Match', String(version)).expect(400)).body.code).toBe('EXPECTED_VERSION_REQUIRED');
    expect(await state(tenantA.companyId)).toEqual(before);
  });

  it('If-Match never takes precedence: a stale Expected-Version stays 409 with the current If-Match; a valid one wins over a bogus If-Match', async () => {
    const id = await seed(mira, north, '2027-02-01');
    const stale = (await versionOf(id))!;
    await patch(id, { projectId: south.projectId }).expect(200);
    const current = (await versionOf(id))!;
    const before = await state(tenantA.companyId);
    const refused = await remove(id, stale).set('If-Match', String(current)).expect(409);
    expect(refused.body.code).toBe('PROJECT_ASSIGNMENT_CONFLICT');
    expect((await remove(id, stale).set('If-Match', '*').expect(409)).body.code).toBe('PROJECT_ASSIGNMENT_CONFLICT');
    expect(await state(tenantA.companyId)).toEqual(before);
    await remove(id, current).set('If-Match', '"not-a-version"').expect(204);
  });

  it.each([
    ['empty', ''],
    ['letters', 'abc'],
    ['zero', '0'],
    ['negative', '-1'],
    ['explicit plus', '+1'],
    ['leading zero', '01'],
    ['decimal', '1.0'],
    ['exponent', '1e3'],
    ['inner whitespace', '1 2'],
    ['comma-joined list', '1, 2'],
    ['first unsafe integer', '9007199254740992'],
  ])('invalid (%s): 400 INVALID_EXPECTED_VERSION before any lookup; nothing changes', async (_label, header) => {
    const id = await seed(mira, north, '2027-02-01');
    const before = await state(tenantA.companyId);
    const response = await remove(id, header).expect(400);
    expect(response.body.code).toBe('INVALID_EXPECTED_VERSION');
    expect(await state(tenantA.companyId)).toEqual(before);
  });

  it('surrounding whitespace is stripped by the HTTP layer: the current version still removes', async () => {
    const id = await seed(mira, north, '2027-02-01');
    const response = await rawDelete(id, [`Expected-Version:    ${(await versionOf(id))!}   `]);
    expect(response.status).toBe(204);
    expect(await exists(id)).toBe(false);
  });

  it('sent twice (raw header lines and an array header), even with the CURRENT version twice: 400 INVALID_EXPECTED_VERSION', async () => {
    const id = await seed(mira, north, '2027-02-01');
    const version = String((await versionOf(id))!);
    const before = await state(tenantA.companyId);
    for (const lines of [['Expected-Version: 1', 'Expected-Version: 2'], [`Expected-Version: ${version}`, `Expected-Version: ${version}`]]) {
      const response = await rawDelete(id, lines);
      expect([response.status, response.body.code]).toEqual([400, 'INVALID_EXPECTED_VERSION']);
    }
    expect((await remove(id, [version, version]).expect(400)).body.code).toBe('INVALID_EXPECTED_VERSION');
    expect(await state(tenantA.companyId)).toEqual(before);
  });

  it('non-ASCII digits on the wire: 400 INVALID_EXPECTED_VERSION; a missing header via raw socket stays 400 REQUIRED', async () => {
    const id = await seed(mira, north, '2027-02-01');
    const before = await state(tenantA.companyId);
    for (const value of ['١٢', '１', '¹']) {
      const response = await rawDelete(id, [`Expected-Version: ${value}`]);
      expect([response.status, response.body.code]).toEqual([400, 'INVALID_EXPECTED_VERSION']);
    }
    const missing = await rawDelete(id, []);
    expect([missing.status, missing.body.code]).toEqual([400, 'EXPECTED_VERSION_REQUIRED']);
    expect(await state(tenantA.companyId)).toEqual(before);
  });
});

describe('#73 API-PROJ-17/18 — a changed assignment cannot be removed with an old version', () => {
  it.each([
    ['employee', () => ({ employeeId: jonas.employeeId })],
    ['project', () => ({ projectId: south.projectId })],
    ['month', () => ({ monthStart: '2027-03-01' })],
  ] as const)('after a %s correction: 409 PROJECT_ASSIGNMENT_CONFLICT; the fresh version removes', async (_label, change) => {
    const id = await seed(mira, north, '2027-02-01');
    const stale = (await versionOf(id))!;
    const corrected = await patch(id, change()).expect(200);
    expect(corrected.body.version).toBeGreaterThan(stale);
    const before = await state(tenantA.companyId);
    const refused = await remove(id, stale).expect(409);
    expect(refused.body.code).toBe('PROJECT_ASSIGNMENT_CONFLICT');
    expect(await auditFor(refused.headers['x-correlation-id'])).toEqual([]);
    expect(await state(tenantA.companyId)).toEqual(before);
    await remove(id, corrected.body.version).expect(204);
  });

  it('ABA: A -> B -> A gives a new version; the version confirmed for the first A is refused', async () => {
    const id = await seed(mira, north, '2027-02-01');
    const v1 = (await read(`${BASE}?monthStart=2027-02-01`).expect(200)).body.items[0].version as number;
    const v2 = (await patch(id, { projectId: south.projectId }).expect(200)).body.version as number;
    const back = await patch(id, { projectId: north.projectId }).expect(200);
    const v3 = back.body.version as number;
    // Same tuple as at v1, but a different version.
    expect(back.body).toMatchObject({ employeeId: mira.employeeId, projectId: north.projectId, monthStart: '2027-02-01' });
    expect(v1 < v2 && v2 < v3).toBe(true);
    expect((await remove(id, v1).expect(409)).body.code).toBe('PROJECT_ASSIGNMENT_CONFLICT');
    expect((await remove(id, v2).expect(409)).body.code).toBe('PROJECT_ASSIGNMENT_CONFLICT');
    expect(await exists(id)).toBe(true);
    await remove(id, v3).expect(204);
  });

  it('a version from the future (never issued) is stale too', async () => {
    const id = await seed(mira, north, '2027-02-01');
    const version = (await versionOf(id))!;
    expect((await remove(id, version + 1).expect(409)).body.code).toBe('PROJECT_ASSIGNMENT_CONFLICT');
    expect((await remove(id, Number.MAX_SAFE_INTEGER).expect(409)).body.code).toBe('PROJECT_ASSIGNMENT_CONFLICT');
    expect(await versionOf(id)).toBe(version);
  });
});

describe('#73 API-PROJ-19 — version semantics on LIST, POST and PATCH', () => {
  it('exact microseconds: rows one microsecond apart get versions one apart; never millisecond-rounded', async () => {
    const first = await seed(mira, north, '2027-02-01');
    const second = await seed(jonas, north, '2027-02-01');
    await db().query("UPDATE project_assignments SET updated_at = '2026-10-29T08:00:00.123456Z' WHERE id = $1", [first]);
    await db().query("UPDATE project_assignments SET updated_at = '2026-10-29T08:00:00.123457Z' WHERE id = $1", [second]);
    const items = (await read(`${BASE}?monthStart=2027-02-01`).expect(200)).body.items as { id: string; version: number }[];
    expect(Object.fromEntries(items.map((item) => [item.id, item.version])))
      .toEqual({ [first]: 1793260800123456, [second]: 1793260800123457 });
  });

  it('two reads without a write agree; POST and PATCH answers equal the following read; each effective PATCH increases it', async () => {
    const created = await http().post(BASE).set('Origin', ORIGIN).set('Cookie', adminA.cookie).set('X-CSRF-Token', adminA.csrf)
      .send({ employeeId: mira.employeeId, projectId: north.projectId, monthStart: '2027-02-01' }).expect(201);
    const listed = async (month: string) => (await read(`${BASE}?monthStart=${month}`).expect(200)).body.items;
    expect(await listed('2027-02-01')).toEqual([created.body]);
    expect(await listed('2027-02-01')).toEqual([created.body]);
    expect(Number.isSafeInteger(created.body.version) && created.body.version > 0).toBe(true);
    expect(created.body.version).toBe(await versionOf(created.body.id));

    let previous = created.body.version as number;
    for (const change of [{ projectId: south.projectId }, { monthStart: '2027-03-01' }, { employeeId: jonas.employeeId }]) {
      const corrected = await patch(created.body.id, change).expect(200);
      expect(corrected.body.version).toBeGreaterThan(previous);
      expect(await listed(corrected.body.monthStart)).toEqual([corrected.body]);
      previous = corrected.body.version;
    }
  });

  it('a genuine no-op PATCH answers the unchanged version; refused and rolled-back PATCHes leave it unchanged', async () => {
    const id = await seed(mira, north, '2027-02-01');
    const version = (await versionOf(id))!;
    const noop = await patch(id, { projectId: north.projectId, monthStart: '2027-02-01' }).expect(200);
    expect(noop.body.version).toBe(version);
    expect(await versionOf(id)).toBe(version);

    await db().query("UPDATE employees SET status = 'DEACTIVATED' WHERE id = $1", [jonas.employeeId]);
    expect((await patch(id, { employeeId: jonas.employeeId }).expect(409)).body.code).toBe('EMPLOYEE_INACTIVE');
    expect(await versionOf(id)).toBe(version);

    await bootApp({ audit: new FailingAudit('PROJECT_ASSIGNMENT_CORRECTED') });
    expect((await patch(id, { projectId: south.projectId }).expect(500)).body.code).toBe('INTERNAL_ERROR');
    expect(await versionOf(id)).toBe(version);
  });

  it('API-PROJ-25 frozen or backward clock: each effective PATCH still moves the version by exactly 1 µs; only the last removes', async () => {
    const id = await seed(mira, north, '2027-02-01');
    // The stored value is a day ahead of the database clock (clock skew / clock set back).
    await db().query("UPDATE project_assignments SET updated_at = clock_timestamp() + interval '1 day' WHERE id = $1", [id]);
    const v0 = (await read(`${BASE}?monthStart=2027-02-01`).expect(200)).body.items[0].version as number;
    const v1 = (await patch(id, { projectId: south.projectId }).expect(200)).body.version as number;
    const v2 = (await patch(id, { projectId: north.projectId }).expect(200)).body.version as number;
    // One microsecond apart: a millisecond-based token could not tell these writes apart.
    expect([v1 - v0, v2 - v1]).toEqual([1, 1]);
    for (const stale of [v0, v1]) expect((await remove(id, stale).expect(409)).body.code).toBe('PROJECT_ASSIGNMENT_CONFLICT');
    await remove(id, v2).expect(204);
  });

  it('API-PROJ-26 range fail closed: versions 0 and 2^53 answer 500 on LIST, no-op PATCH and DELETE without leaking the value; 2^53-1 works', async () => {
    const epoch = await seed(mira, north, '2027-05-01');
    const tooLate = await seed(jonas, north, '2027-06-01');
    const lastSafe = await seed(mira, north, '2027-07-01');
    await db().query("UPDATE project_assignments SET updated_at = '1970-01-01T00:00:00Z' WHERE id = $1", [epoch]);
    await db().query("UPDATE project_assignments SET updated_at = '2255-06-05T23:47:34.740992Z' WHERE id = $1", [tooLate]);
    await db().query("UPDATE project_assignments SET updated_at = '2255-06-05T23:47:34.740991Z' WHERE id = $1", [lastSafe]);
    const before = await state(tenantA.companyId);
    expect(before.assignments.map((row) => String(row.version)).sort((a, b) => a.localeCompare(b)))
      .toEqual(['0', '9007199254740991', '9007199254740992']);

    for (const [id, month] of [[epoch, '2027-05-01'], [tooLate, '2027-06-01']] as const) {
      const responses = [
        await read(`${BASE}?monthStart=${month}`).expect(500),
        await patch(id, { monthStart: month }).expect(500),
        await remove(id, 1).expect(500),
        await remove(id, Number.MAX_SAFE_INTEGER).expect(500),
      ];
      for (const response of responses) {
        expect(response.body.code).toBe('INTERNAL_ERROR');
        expect(JSON.stringify(response.body)).not.toMatch(/9007199254740992|"version"/);
      }
    }
    expect(await state(tenantA.companyId)).toEqual(before);

    const items = (await read(`${BASE}?monthStart=2027-07-01`).expect(200)).body.items;
    expect(items).toEqual([expect.objectContaining({ id: lastSafe, version: Number.MAX_SAFE_INTEGER })]);
    await remove(lastSafe, Number.MAX_SAFE_INTEGER).expect(204);
  });
});

describe('#73 API-PROJ-20 — precedence (S-5)', () => {
  it('guard before the id pipe, id pipe before the header, header before any lookup, version before the month', async () => {
    const current = await seed(mira, north, '2026-12-01');
    const foreign = await seed(employeeB, projectB, '2027-02-01');
    const employee = await createSyntheticSession(sessions, tenantA.employee);
    // Guard first: even a malformed id without a header is 401/403 for an unauthorized caller.
    expect((await remove('not-a-uuid', undefined, null).expect(401)).body.code).toBe('SESSION_REQUIRED');
    expect((await remove('not-a-uuid', undefined, employee).expect(403)).body.code).toBe('ACTION_FORBIDDEN');
    const noCsrf = await http().delete(`${BASE}/not-a-uuid`).set('Origin', ORIGIN).set('Cookie', adminA.cookie).expect(403);
    expect(noCsrf.body.code).toBe('CSRF_VALIDATION_FAILED');
    // Then the id format (404), then the header (400), whatever exists.
    expect((await remove('not-a-uuid').expect(404)).body.code).toBe('RESOURCE_NOT_FOUND');
    expect((await remove('not-a-uuid', 'abc').expect(404)).body.code).toBe('RESOURCE_NOT_FOUND');
    for (const id of [randomUUID(), foreign, current]) {
      expect((await remove(id).expect(400)).body.code).toBe('EXPECTED_VERSION_REQUIRED');
      expect((await remove(id, '01').expect(400)).body.code).toBe('INVALID_EXPECTED_VERSION');
    }
    // A valid header on an unknown id: 404.
    expect((await remove(randomUUID(), 1).expect(404)).body.code).toBe('RESOURCE_NOT_FOUND');
    // Stale version on a current-month row: the version decides first.
    const version = (await versionOf(current))!;
    expect((await remove(current, version + 1).expect(409)).body.code).toBe('PROJECT_ASSIGNMENT_CONFLICT');
    expect((await remove(current, version).expect(409)).body.code).toBe('PROJECT_ASSIGNMENT_CORRECTION_CONFLICT');
    expect(await versionOf(current)).toBe(version);
  });
});

describe('#73 API-PROJ-21 — repeat, unknown and foreign rows are the same 404', () => {
  it('a repeated DELETE is 404 with a single audit event; foreign rows stay untouched in both tenants', async () => {
    const own = await seed(mira, north, '2027-02-01');
    const foreign = await seed(employeeB, projectB, '2027-02-01');
    const ownVersion = (await versionOf(own))!;
    const foreignVersion = (await versionOf(foreign))!;
    const reference = await remove(randomUUID(), 1).expect(404);

    const first = await remove(own, ownVersion).expect(204);
    const repeat = await remove(own, ownVersion).expect(404);
    expect(shape(repeat.body)).toEqual(shape(reference.body));
    expect(await auditFor(repeat.headers['x-correlation-id'])).toEqual([]);
    expect((await db().query(
      "SELECT count(*)::int AS n FROM audit_event WHERE resource_id = $1 AND action = 'PROJECT_ASSIGNMENT_REMOVED'",
      [own],
    )).rows[0].n).toBe(1);
    expect(await auditFor(first.headers['x-correlation-id'])).toHaveLength(1);

    const beforeA = await state(tenantA.companyId);
    const beforeB = await state(tenantB.companyId);
    // Tenant A's admin with the foreign row's VALID version: indistinguishable from unknown.
    expect(shape((await remove(foreign, foreignVersion).expect(404)).body)).toEqual(shape(reference.body));
    // Tenant B's admin cannot touch tenant A's rows either.
    const remaining = await seed(jonas, north, '2027-03-01');
    expect(shape((await remove(remaining, (await versionOf(remaining))!, adminB).expect(404)).body)).toEqual(shape(reference.body));
    expect(await state(tenantB.companyId)).toEqual(beforeB);
    expect((await state(tenantA.companyId)).audit).toEqual(beforeA.audit);
    expect(await versionOf(foreign)).toBe(foreignVersion);
  });
});

describe('#73 API-PROJ-22 — access control', () => {
  it('EMPLOYEE 403; no session 401; expired 401; revoked 401; missing/foreign CSRF and wrong/missing Origin 403; nothing written', async () => {
    const id = await seed(mira, north, '2027-02-01');
    const version = (await versionOf(id))!;
    const before = await state(tenantA.companyId);
    const employee = await createSyntheticSession(sessions, tenantA.employee);
    expect((await remove(id, version, employee).expect(403)).body.code).toBe('ACTION_FORBIDDEN');
    expect((await remove(id, version, null).expect(401)).body.code).toBe('SESSION_REQUIRED');

    // Dedicated admins, so their sessions can be expired / revoked by token digest.
    const expired = await createSyntheticSession(sessions, await createSyntheticAccount(db(), tenantA.companyId, 'COMPANY_ADMIN'));
    await db().query(
      `UPDATE sessions SET created_at = now() - interval '2 hours', last_seen_at = now() - interval '2 hours'
       WHERE token_hash = sha256(convert_to($1, 'UTF8'))`,
      [expired.rawToken],
    );
    expect((await remove(id, version, expired).expect(401)).body.code).toBe('SESSION_EXPIRED');
    const revoked = await createSyntheticSession(sessions, await createSyntheticAccount(db(), tenantA.companyId, 'COMPANY_ADMIN'));
    await db().query('UPDATE sessions SET revoked_at = now() WHERE token_hash = sha256(convert_to($1, \'UTF8\'))', [revoked.rawToken]);
    expect((await remove(id, version, revoked).expect(401)).body.code).toBe('SESSION_REVOKED');

    const withHeaders = (origin: string | null, csrf: string | null) => {
      let pending = http().delete(`${BASE}/${id}`).set('Cookie', adminA.cookie).set('Expected-Version', String(version));
      if (origin) pending = pending.set('Origin', origin);
      if (csrf) pending = pending.set('X-CSRF-Token', csrf);
      return pending;
    };
    for (const [origin, csrf] of [[ORIGIN, null], [ORIGIN, adminB.csrf], ['https://attacker.example', adminA.csrf], [null, adminA.csrf]] as const) {
      expect((await withHeaders(origin, csrf).expect(403)).body.code).toBe('CSRF_VALIDATION_FAILED');
    }
    expect(await state(tenantA.companyId)).toEqual(before);
  });

  it('actor recheck inside the transaction: a role demoted or a company suspended after the guard writes nothing', async () => {
    const id = await seed(mira, north, '2027-02-01');
    const version = (await versionOf(id))!;
    const before = await state(tenantA.companyId);
    // The TenantContext the guard produced, used after the change committed (TOCTOU window).
    const staleAdmin = {
      sessionId: randomUUID(), accountId: tenantA.admin.accountId, companyId: tenantA.companyId, role: 'COMPANY_ADMIN',
    } as const;
    const service = new ProjectAssignmentsService(
      { withTransaction: <T>(work: (client: PoolClient) => Promise<T>) => inTransaction(db(), work) } as unknown as DatabaseService,
      new BusinessAuditService(),
      MID_DEC,
    );
    await db().query("UPDATE accounts SET role = 'EMPLOYEE' WHERE id = $1", [tenantA.admin.accountId]);
    await expect(service.remove(staleAdmin, id, version, randomUUID()))
      .rejects.toMatchObject({ status: 403, response: { code: 'ACTION_FORBIDDEN' } });
    await db().query("UPDATE accounts SET role = 'COMPANY_ADMIN' WHERE id = $1", [tenantA.admin.accountId]);
    await db().query("UPDATE companies SET status = 'SUSPENDED' WHERE id = $1", [tenantA.companyId]);
    await expect(service.remove(staleAdmin, id, version, randomUUID()))
      .rejects.toMatchObject({ status: 401, response: { code: 'SESSION_REVOKED' } });
    expect(await state(tenantA.companyId)).toEqual(before);
    // Over HTTP the suspended company is refused at the guard already.
    expect((await remove(id, version).expect(401)).body.code).toBe('SESSION_REVOKED');
    expect(await state(tenantA.companyId)).toEqual(before);
  });
});

describe('#73 API-PROJ-23/24 — isolation and rollback', () => {
  it('a body or query with tenant hints is ignored: only the addressed row is removed, everything else stays', async () => {
    const target = await seed(mira, north, '2027-02-01');
    const others = [
      await seed(mira, south, '2027-03-01'),
      await seed(jonas, north, '2027-02-01'),
      await seed(mira, north, '2026-10-01'),
    ];
    const foreign = await seed(employeeB, projectB, '2027-02-01');
    const beforeB = await state(tenantB.companyId);
    const before = (await state(tenantA.companyId)).assignments.filter((row) => row.id !== target);
    await http().delete(`${BASE}/${target}?companyId=${tenantB.companyId}&employeeId=${jonas.employeeId}`)
      .set('Origin', ORIGIN).set('Cookie', adminA.cookie).set('X-CSRF-Token', adminA.csrf)
      .set('Expected-Version', String((await versionOf(target))!))
      .send({ companyId: tenantB.companyId, employeeId: jonas.employeeId, id: foreign }).expect(204);
    expect((await state(tenantA.companyId)).assignments).toEqual(before);
    const byText = (a: string, b: string) => a.localeCompare(b);
    expect(before.map((row) => String(row.id)).sort(byText)).toEqual([...others].sort(byText));
    expect(await state(tenantB.companyId)).toEqual(beforeB);
  });

  it('an audit failure rolls the removal back: the row and its version stay, no audit event', async () => {
    const id = await seed(mira, north, '2027-02-01');
    await bootApp({ audit: new FailingAudit('PROJECT_ASSIGNMENT_REMOVED') });
    const before = await state(tenantA.companyId);
    const response = await remove(id, (await versionOf(id))!).expect(500);
    expect(response.body.code).toBe('INTERNAL_ERROR');
    expect(await state(tenantA.companyId)).toEqual(before);
  });
});
