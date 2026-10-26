/**
 * SP-08 — project administration (minimal slice) against REAL PostgreSQL.
 *
 * Drives the real AppModule over HTTP: real global AccessControlGuard, real
 * sessions, real SQL. Two synthetic tenants (A, B) prove tenant isolation.
 * API v1 contract per owner decision 26.10.2026: name (unique per company,
 * exact after trim) + status ACTIVE/INACTIVE; ARCHIVED is never writable.
 *
 * Requires a migrated LOCAL PostgreSQL (0001–0007); synthetic fixtures only.
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { SessionService } from '../src/auth/session.service.js';
import {
  backendPid,
  createSyntheticProject,
  createSyntheticSession,
  createSyntheticTenant,
  openLocalTestPool,
  realSessionService,
  removeSyntheticTenants,
  type SyntheticProject,
  type SyntheticSession,
  type SyntheticTenant,
  type TestPool,
} from './helpers/synthetic-tenants.js';
import { FailingAudit, ORIGIN, RecordingDelivery, bootEmployeesApp } from './helpers/employees-test-app.js';

const BASE = '/api/v1/projects';
const RESPONSE_KEYS = ['id', 'name', 'status'];

let pool: TestPool | undefined;
let sessions: SessionService;
let app: INestApplication<App> | undefined;
let tenantA: SyntheticTenant;
let tenantB: SyntheticTenant;
let projectA: SyntheticProject;
let projectB: SyntheticProject;
let adminA: SyntheticSession;
let adminB: SyntheticSession;
const createdCompanies: string[] = [];
const heldClients: PoolClient[] = [];
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

/** Everything a tenant-scoped project write could have changed. */
async function tenantState(companyId: string) {
  const query = async (sql: string) => (await db().query(sql, [companyId])).rows;
  return {
    projects: await query('SELECT id, name, status, updated_at FROM projects WHERE company_id = $1 ORDER BY id'),
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

async function bootApp(audit?: FailingAudit) {
  if (app) await app.close();
  app = await bootEmployeesApp(new RecordingDelivery(), audit ? { audit } : {});
}

beforeAll(() => {
  pool = openLocalTestPool(10);
  sessions = realSessionService(db());
  previousOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
});

beforeEach(async () => {
  tenantA = await createSyntheticTenant(db(), 'SP08 Tenant A');
  createdCompanies.push(tenantA.companyId);
  tenantB = await createSyntheticTenant(db(), 'SP08 Tenant B');
  createdCompanies.push(tenantB.companyId);
  projectA = await createSyntheticProject(db(), tenantA.companyId, 'Objekt A');
  projectB = await createSyntheticProject(db(), tenantB.companyId, 'Objekt B');
  adminA = await createSyntheticSession(sessions, tenantA.admin);
  adminB = await createSyntheticSession(sessions, tenantB.admin);
  await bootApp();
});

afterEach(async () => {
  for (const client of heldClients.splice(0)) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
  if (app) await app.close();
  app = undefined;
  const ids = createdCompanies.splice(0);
  try {
    await removeSyntheticTenants(db(), ids);
  } catch (error) {
    throw new Error(`SP-08 fixture cleanup FAILED for companies ${ids.join(', ')}`, { cause: error });
  }
});

afterAll(async () => {
  await pool?.end();
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousOrigin;
});

describe('SP-08 — access control on every project route', () => {
  function routes(projectId: string) {
    return [
      { name: 'list', run: (s: SyntheticSession | null) => (s ? read(BASE, s) : read(BASE)) },
      { name: 'detail', run: (s: SyntheticSession | null) => (s ? read(`${BASE}/${projectId}`, s) : read(`${BASE}/${projectId}`)) },
      { name: 'create', run: (s: SyntheticSession | null) => write('post', BASE, s, { name: 'Neues Objekt' }) },
      { name: 'update', run: (s: SyntheticSession | null) => write('patch', `${BASE}/${projectId}`, s, { name: 'Umbenannt' }) },
    ];
  }

  it('unauthenticated: 401 SESSION_REQUIRED on all four routes and no state change', async () => {
    const before = await tenantState(tenantA.companyId);
    for (const route of routes(projectA.projectId)) {
      const response = await route.run(null);
      expect({ route: route.name, status: response.status, code: response.body.code })
        .toEqual({ route: route.name, status: 401, code: 'SESSION_REQUIRED' });
    }
    expect(await tenantState(tenantA.companyId)).toEqual(before);
  });

  it('EMPLOYEE role: 403 ACTION_FORBIDDEN on all four routes and no state change', async () => {
    const employee = await createSyntheticSession(sessions, tenantA.employee);
    const before = await tenantState(tenantA.companyId);
    for (const route of routes(projectA.projectId)) {
      const response = await route.run(employee);
      expect({ route: route.name, status: response.status, code: response.body.code })
        .toEqual({ route: route.name, status: 403, code: 'ACTION_FORBIDDEN' });
    }
    expect(await tenantState(tenantA.companyId)).toEqual(before);
  });

  it('writes without a valid Origin or CSRF token are rejected before any change', async () => {
    const otherAdminA = await createSyntheticSession(sessions, tenantA.admin);
    const before = await tenantState(tenantA.companyId);
    const target = `${BASE}/${projectA.projectId}`;
    const attempts = [
      () => http().post(BASE).set('Origin', ORIGIN).set('Cookie', adminA.cookie).send({ name: 'Ohne CSRF' }),
      () => http().patch(target).set('Origin', ORIGIN).set('Cookie', adminA.cookie)
        .set('X-CSRF-Token', otherAdminA.csrf).send({ name: 'Fremdes Token' }),
      () => http().patch(target).set('Origin', 'https://attacker.example')
        .set('Cookie', adminA.cookie).set('X-CSRF-Token', adminA.csrf).send({ status: 'INACTIVE' }),
      () => http().post(BASE).set('Cookie', adminA.cookie).set('X-CSRF-Token', adminA.csrf).send({ name: 'Ohne Origin' }),
    ];
    for (const attempt of attempts) {
      const response = await attempt();
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('CSRF_VALIDATION_FAILED');
    }
    expect(await tenantState(tenantA.companyId)).toEqual(before);
  });
});

describe('SP-08 — tenant isolation', () => {
  it('admin A lists and reads only tenant A projects; tenant hints are rejected', async () => {
    const list = await read(BASE, adminA).expect(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body).toEqual({
      items: [{ id: projectA.projectId, name: 'Objekt A', status: 'ACTIVE' }],
      pagination: { page: 1, pageSize: 25, totalItems: 1, totalPages: 1 },
    });
    expect((await read(BASE, adminB).expect(200)).body.items.map((item: { id: string }) => item.id))
      .toEqual([projectB.projectId]);
    expect((await read(`${BASE}?companyId=${tenantB.companyId}`, adminA).expect(400)).body.code).toBe('UNKNOWN_FIELD');

    const detail = await read(`${BASE}/${projectA.projectId}`, adminA).expect(200);
    expect(Object.keys(detail.body).sort()).toEqual(RESPONSE_KEYS);
    expect(detail.body).toEqual({ id: projectA.projectId, name: 'Objekt A', status: 'ACTIVE' });
  });

  it('a tenant B id answers exactly like an unknown id (404) for read and update; B stays untouched', async () => {
    const beforeB = await tenantState(tenantB.companyId);
    const unknown = randomUUID();
    const shape = (body: Record<string, unknown>) => {
      const { correlationId, instance, ...rest } = body;
      expect(typeof correlationId).toBe('string');
      expect(typeof instance).toBe('string');
      return rest;
    };
    const pairs = [
      [() => read(`${BASE}/${projectB.projectId}`, adminA), () => read(`${BASE}/${unknown}`, adminA)],
      [() => write('patch', `${BASE}/${projectB.projectId}`, adminA, { name: 'Gekapert' }),
        () => write('patch', `${BASE}/${unknown}`, adminA, { name: 'Gekapert' })],
      [() => write('patch', `${BASE}/${projectB.projectId}`, adminA, { status: 'INACTIVE' }),
        () => write('patch', `${BASE}/${unknown}`, adminA, { status: 'INACTIVE' })],
    ] as const;
    for (const [foreignRequest, unknownRequest] of pairs) {
      const foreign = await foreignRequest();
      const missing = await unknownRequest();
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(foreign.body.code).toBe('RESOURCE_NOT_FOUND');
      expect(shape(foreign.body)).toEqual(shape(missing.body));
    }
    expect((await read(`${BASE}/not-a-uuid`, adminA).expect(404)).body.code).toBe('RESOURCE_NOT_FOUND');
    expect(await tenantState(tenantB.companyId)).toEqual(beforeB);
  });

  it('create always lands in the session tenant; tenant, status and physical-design-only fields are rejected', async () => {
    const beforeB = await tenantState(tenantB.companyId);
    for (const forbidden of [
      { companyId: tenantB.companyId },
      { id: randomUUID() },
      { status: 'INACTIVE' },
      { address: 'Musterstraße 1' },
      { internalCode: 'CM-01' },
      { note: 'intern' },
    ]) {
      const response = await write('post', BASE, adminA, { name: 'Objekt X', ...forbidden }).expect(400);
      expect(response.body.code).toBe('UNKNOWN_FIELD');
    }
    expect(await tenantState(tenantB.companyId)).toEqual(beforeB);

    const created = await write('post', BASE, adminB, { name: 'Objekt Y' }).expect(201);
    const row = await db().query('SELECT company_id FROM projects WHERE id = $1', [created.body.id]);
    expect(row.rows[0].company_id).toBe(tenantB.companyId);
  });
});

describe('SP-08 — create', () => {
  it('creates an ACTIVE project with trimmed name and a non-sensitive audit entry', async () => {
    const response = await write('post', BASE, adminA, { name: '  Objekt Nord  ' }).expect(201);
    expect(Object.keys(response.body).sort()).toEqual(RESPONSE_KEYS);
    expect(response.body).toMatchObject({ name: 'Objekt Nord', status: 'ACTIVE' });

    const stored = await db().query('SELECT company_id, name, status FROM projects WHERE id = $1', [response.body.id]);
    expect(stored.rows[0]).toEqual({ company_id: tenantA.companyId, name: 'Objekt Nord', status: 'ACTIVE' });

    const audit = await auditRows(tenantA.companyId, response.headers['x-correlation-id']);
    expect(audit).toEqual([{
      action: 'PROJECT_CREATED',
      resource_type: 'PROJECT',
      resource_id: response.body.id,
      actor_account_id: tenantA.admin.accountId,
      old_values: null,
      new_values: { name: 'Objekt Nord', status: 'ACTIVE' },
    }]);

    // Reload: a fresh GET returns the persisted project.
    expect((await read(`${BASE}/${response.body.id}`, adminA).expect(200)).body).toEqual(response.body);
  });

  it('name is unique per company (exact after trim): 409 inside the tenant, allowed in another tenant', async () => {
    const before = await tenantState(tenantA.companyId);
    const duplicate = await write('post', BASE, adminA, { name: ' Objekt A ' }).expect(409);
    expect(duplicate.body.code).toBe('PROJECT_NAME_ALREADY_EXISTS');
    expect(await tenantState(tenantA.companyId)).toEqual(before);

    await write('post', BASE, adminB, { name: 'Objekt A' }).expect(201);
    // Exact uniqueness only: no case folding was approved.
    await write('post', BASE, adminA, { name: 'objekt a' }).expect(201);
  });

  it('invalid create input: 400 VALIDATION_FAILED with safe pointers and nothing persisted', async () => {
    const before = await tenantState(tenantA.companyId);
    const cases: [Record<string, unknown>, string][] = [
      [{}, 'REQUIRED'],
      [{ name: ' A ' }, 'TOO_SHORT'],
      [{ name: 'N'.repeat(101) }, 'TOO_LONG'],
      [{ name: 7 }, 'INVALID_TYPE'],
    ];
    for (const [body, code] of cases) {
      const response = await write('post', BASE, adminA, body).expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(response.body.errors).toContainEqual(expect.objectContaining({ pointer: '#/name', code }));
    }
    expect(await tenantState(tenantA.companyId)).toEqual(before);
  });

  it('name race: the UNIQUE constraint decides and the loser gets 409', async () => {
    const competitor = await db().connect();
    heldClients.push(competitor);
    await competitor.query('BEGIN');
    await competitor.query("SET LOCAL lock_timeout = '10s'");
    await competitor.query("INSERT INTO projects (company_id, name) VALUES ($1, 'Race Objekt')", [tenantA.companyId]);
    const competitorPid = await backendPid(competitor);

    const attempt = write('post', BASE, adminA, { name: 'Race Objekt' }).then((response) => response);
    // Barrier: the HTTP create passed its pre-check and waits on the unique index.
    await waitForAnyBlocked(competitorPid);
    await competitor.query('COMMIT');

    const response = await attempt;
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('PROJECT_NAME_ALREADY_EXISTS');
    expect((await db().query(
      "SELECT count(*)::int AS n FROM projects WHERE company_id = $1 AND name = 'Race Objekt'",
      [tenantA.companyId],
    )).rows[0].n).toBe(1);
  });

  it('an audit failure rolls the create back', async () => {
    await bootApp(new FailingAudit('PROJECT_CREATED'));
    const response = await write('post', BASE, adminA, { name: 'Ohne Audit' }).expect(500);
    expect(response.body.code).toBe('INTERNAL_ERROR');
    expect((await db().query(
      "SELECT count(*)::int AS n FROM projects WHERE company_id = $1 AND name = 'Ohne Audit'",
      [tenantA.companyId],
    )).rows[0].n).toBe(0);
  });
});

/** Barrier without knowing the waiter pid: any backend blocked by the holder. */
async function waitForAnyBlocked(holderPid: number, maxChecks = 4000): Promise<void> {
  for (let check = 0; check < maxChecks; check += 1) {
    const result = await db().query(
      'SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))',
      [holderPid],
    );
    if ((result.rowCount ?? 0) > 0) return;
  }
  throw new Error(`No backend ever blocked on ${holderPid}`);
}

describe('SP-08 — update', () => {
  it('renames and changes status with old/new audit; a no-op patch writes nothing', async () => {
    const target = `${BASE}/${projectA.projectId}`;
    const renamed = await write('patch', target, adminA, { name: '  Objekt A Süd ' }).expect(200);
    expect(renamed.body).toEqual({ id: projectA.projectId, name: 'Objekt A Süd', status: 'ACTIVE' });
    expect(await auditRows(tenantA.companyId, renamed.headers['x-correlation-id'])).toEqual([{
      action: 'PROJECT_UPDATED',
      resource_type: 'PROJECT',
      resource_id: projectA.projectId,
      actor_account_id: tenantA.admin.accountId,
      old_values: { name: 'Objekt A' },
      new_values: { name: 'Objekt A Süd' },
    }]);

    const inactive = await write('patch', target, adminA, { status: 'INACTIVE' }).expect(200);
    expect(inactive.body.status).toBe('INACTIVE');
    expect((await auditRows(tenantA.companyId, inactive.headers['x-correlation-id']))[0]).toMatchObject({
      old_values: { status: 'ACTIVE' },
      new_values: { status: 'INACTIVE' },
    });
    // Reactivation is allowed (D-8.4-12).
    expect((await write('patch', target, adminA, { status: 'ACTIVE' }).expect(200)).body.status).toBe('ACTIVE');

    const before = await tenantState(tenantA.companyId);
    const noop = await write('patch', target, adminA, { name: 'Objekt A Süd', status: 'ACTIVE' }).expect(200);
    expect(noop.body).toEqual({ id: projectA.projectId, name: 'Objekt A Süd', status: 'ACTIVE' });
    expect(await tenantState(tenantA.companyId)).toEqual(before);
  });

  it('rejects empty, ARCHIVED, null, unknown-field and duplicate-name patches without changes', async () => {
    await createSyntheticProject(db(), tenantA.companyId, 'Belegt');
    const before = await tenantState(tenantA.companyId);
    const target = `${BASE}/${projectA.projectId}`;

    expect((await write('patch', target, adminA, {}).expect(400)).body.code).toBe('EMPTY_PATCH');
    const archived = await write('patch', target, adminA, { status: 'ARCHIVED' }).expect(400);
    expect(archived.body.code).toBe('VALIDATION_FAILED');
    expect(archived.body.errors).toContainEqual(expect.objectContaining({ pointer: '#/status', code: 'INVALID_ENUM' }));
    const nulled = await write('patch', target, adminA, { name: null }).expect(400);
    expect(nulled.body.errors).toContainEqual(expect.objectContaining({ pointer: '#/name', code: 'INVALID_TYPE' }));
    expect((await write('patch', target, adminA, { address: 'x' }).expect(400)).body.code).toBe('UNKNOWN_FIELD');
    expect((await write('patch', target, adminA, { name: 'Belegt' }).expect(409)).body.code)
      .toBe('PROJECT_NAME_ALREADY_EXISTS');

    expect(await tenantState(tenantA.companyId)).toEqual(before);
  });

  it('a stored ARCHIVED row (not writable via API v1) fails closed and is not modified', async () => {
    const archived = await createSyntheticProject(db(), tenantA.companyId, 'Archiv', 'ARCHIVED');
    const before = await tenantState(tenantA.companyId);
    expect((await read(`${BASE}/${archived.projectId}`, adminA).expect(500)).body.code).toBe('INTERNAL_ERROR');
    expect((await write('patch', `${BASE}/${archived.projectId}`, adminA, { status: 'ACTIVE' }).expect(500)).body.code)
      .toBe('INTERNAL_ERROR');
    expect(await tenantState(tenantA.companyId)).toEqual(before);
  });

  it('an audit failure rolls the update back', async () => {
    await bootApp(new FailingAudit('PROJECT_UPDATED'));
    await write('patch', `${BASE}/${projectA.projectId}`, adminA, { status: 'INACTIVE' }).expect(500);
    expect((await db().query('SELECT name, status FROM projects WHERE id = $1', [projectA.projectId])).rows[0])
      .toEqual({ name: 'Objekt A', status: 'ACTIVE' });
  });
});

describe('SP-08 — list query', () => {
  beforeEach(async () => {
    await createSyntheticProject(db(), tenantA.companyId, 'Bahnhof Mitte', 'INACTIVE');
    await createSyntheticProject(db(), tenantA.companyId, 'Center 100%');
  });

  const names = (response: { body: { items: { name: string }[] } }) => response.body.items.map((item) => item.name);

  it('sorts by name by default and supports whitelisted sorting, filtering and pagination', async () => {
    expect(names(await read(BASE, adminA).expect(200))).toEqual(['Bahnhof Mitte', 'Center 100%', 'Objekt A']);
    expect(names(await read(`${BASE}?sortBy=name&sortOrder=desc`, adminA).expect(200)))
      .toEqual(['Objekt A', 'Center 100%', 'Bahnhof Mitte']);
    expect(names(await read(`${BASE}?sortBy=status`, adminA).expect(200)))
      .toEqual(['Center 100%', 'Objekt A', 'Bahnhof Mitte']);
    expect(names(await read(`${BASE}?status=INACTIVE`, adminA).expect(200))).toEqual(['Bahnhof Mitte']);
    const paged = await read(`${BASE}?pageSize=2&page=2`, adminA).expect(200);
    expect(names(paged)).toEqual(['Objekt A']);
    expect(paged.body.pagination).toEqual({ page: 2, pageSize: 2, totalItems: 3, totalPages: 2 });
  });

  it('searches the name case-insensitively and literally; tenant B never sees tenant A', async () => {
    expect(names(await read(`${BASE}?q=bahn`, adminA).expect(200))).toEqual(['Bahnhof Mitte']);
    expect(names(await read(`${BASE}?q=${encodeURIComponent('0%')}`, adminA).expect(200))).toEqual(['Center 100%']);
    expect(names(await read(`${BASE}?q=${encodeURIComponent('%%')}`, adminA).expect(200))).toEqual([]);
    expect(names(await read(`${BASE}?q=Objekt`, adminB).expect(200))).toEqual(['Objekt B']);
  });

  it('rejects invalid query parameters', async () => {
    for (const query of ['pageSize=101', 'page=0', 'sortBy=createdAt', 'sortOrder=up', 'q=a', 'status=ARCHIVED', 'status=']) {
      const response = await read(`${BASE}?${query}`, adminA);
      expect({ query, status: response.status, code: response.body.code })
        .toEqual({ query, status: 400, code: 'VALIDATION_FAILED' });
    }
    expect((await read(`${BASE}?foo=1`, adminA).expect(400)).body.code).toBe('UNKNOWN_FIELD');
  });
});
