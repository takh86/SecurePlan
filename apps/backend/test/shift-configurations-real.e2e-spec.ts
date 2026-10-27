/**
 * SP-08b — month-versioned project shift configuration against REAL PostgreSQL.
 *
 * Owner decisions O-1..O-10 of 27.10.2026 and amendment A-SP08b-01 (ADR-0003).
 * The "current month" comes from an injected wall clock, so the month rules are
 * deterministic. Synthetic data only; migrated LOCAL PostgreSQL (0001–0009).
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { SessionService } from '../src/auth/session.service.js';
import type { DatabaseService } from '../src/database/database.service.js';
import { BusinessAuditService } from '../src/modules/audit/business-audit.service.js';
import {
  SHIFT_GUARD_PLANNING_TABLES,
  assertShiftConfigurationPlanningCheckImplemented,
} from '../src/modules/workforce/shift-configurations/shift-configuration-planning-guard.js';
import { ShiftConfigurationsService } from '../src/modules/workforce/shift-configurations/shift-configurations.service.js';
import {
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

const path = (projectId: string) => `/api/v1/projects/${projectId}/shift-configuration`;
// Pinned instant: 15 Dec 2026 midday UTC -> current month December 2026 (Berlin and UTC alike).
const MID_DEC = () => new Date('2026-12-15T12:00:00Z');
const DAY = { shiftKind: 'DAY', startLocal: '06:00', endLocal: '18:00' } as const;
const NIGHT = { shiftKind: 'NIGHT', startLocal: '18:00', endLocal: '06:00' } as const;
const PROBLEM_JSON = /^application\/problem\+json/;

let pool: TestPool | undefined;
let sessions: SessionService;
let app: INestApplication<App> | undefined;
let tenantA: SyntheticTenant;
let tenantB: SyntheticTenant;
let north: SyntheticProject;
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

function get(projectId: string, month: string | null, session: SyntheticSession | null = adminA) {
  let pending = http().get(month === null ? path(projectId) : `${path(projectId)}?effectiveForMonth=${month}`);
  if (session) pending = pending.set('Cookie', session.cookie);
  return pending;
}

function patch(projectId: string, body: object, session: SyntheticSession | null = adminA) {
  let pending = http().patch(path(projectId)).set('Origin', ORIGIN);
  if (session) pending = pending.set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf);
  return pending.send(body);
}

/** Direct fixture insert (committed), e.g. for versions of months that are already history. */
async function seedVersion(project: SyntheticProject, month: string, rules: [string, string, string][]) {
  for (const [kind, start, end] of rules) {
    await db().query(
      `INSERT INTO shift_configurations (company_id, project_id, effective_from_month, shift_kind, start_local, end_local)
       VALUES ($1, $2, $3::date, $4, $5::time, $6::time)`,
      [project.companyId, project.projectId, month, kind, start, end],
    );
  }
}

async function rowsOf(projectId: string) {
  return (await db().query(
    `SELECT id, shift_kind, start_local::text AS start_local, end_local::text AS end_local,
            effective_from_month::text AS month, updated_at
     FROM shift_configurations WHERE project_id = $1 ORDER BY effective_from_month, shift_kind`,
    [projectId],
  )).rows;
}

async function auditFor(correlationId: string) {
  return (await db().query(
    `SELECT action, resource_type, resource_id, actor_account_id, old_values, new_values
     FROM audit_event WHERE correlation_id = $1`,
    [correlationId],
  )).rows;
}

async function state(companyId: string) {
  const q = async (sql: string) => (await db().query(sql, [companyId])).rows;
  return {
    rules: await q(`SELECT id, project_id, effective_from_month::text, shift_kind, start_local::text, end_local::text, updated_at
                    FROM shift_configurations WHERE company_id = $1 ORDER BY id`),
    audit: await q('SELECT id FROM audit_event WHERE company_id = $1 ORDER BY id'),
  };
}

async function bootApp(options: { clock?: () => Date; audit?: FailingAudit } = {}) {
  if (app) await app.close();
  app = await bootEmployeesApp(new RecordingDelivery(), { clock: MID_DEC, ...options });
}

beforeAll(() => {
  pool = openLocalTestPool(10);
  sessions = realSessionService(db());
  previousOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
});

beforeEach(async () => {
  tenantA = await createSyntheticTenant(db(), 'SP08b A');
  createdCompanies.push(tenantA.companyId);
  tenantB = await createSyntheticTenant(db(), 'SP08b B');
  createdCompanies.push(tenantB.companyId);
  north = await createSyntheticProject(db(), tenantA.companyId, 'Objekt Nord');
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
    throw new Error(`SP-08b fixture cleanup FAILED for companies ${ids.join(', ')}`, { cause: error });
  }
});

afterAll(async () => {
  await pool?.end();
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousOrigin;
});

describe('SP-08b — access, concealment, validation', () => {
  it('401 without session, 403 for EMPLOYEE, 403 without Origin/CSRF; GET is admin-only too; nothing changes', async () => {
    const body = { effectiveFromMonth: '2027-01-01', shifts: [DAY] };
    const before = await state(tenantA.companyId);
    expect((await patch(north.projectId, body, null).expect(401)).body.code).toBe('SESSION_REQUIRED');
    const employee = await createSyntheticSession(sessions, tenantA.employee);
    expect((await patch(north.projectId, body, employee).expect(403)).body.code).toBe('ACTION_FORBIDDEN');
    const noOrigin = await http().patch(path(north.projectId)).set('Cookie', adminA.cookie)
      .set('X-CSRF-Token', adminA.csrf).send(body).expect(403);
    expect(noOrigin.body.code).toBe('CSRF_VALIDATION_FAILED');
    const wrongCsrf = await http().patch(path(north.projectId)).set('Origin', ORIGIN).set('Cookie', adminA.cookie)
      .set('X-CSRF-Token', adminB.csrf).send(body).expect(403);
    expect(wrongCsrf.body.code).toBe('CSRF_VALIDATION_FAILED');
    expect((await get(north.projectId, '2027-01-01', null).expect(401)).body.code).toBe('SESSION_REQUIRED');
    expect((await get(north.projectId, '2027-01-01', employee).expect(403)).body.code).toBe('ACTION_FORBIDDEN');
    expect(await state(tenantA.companyId)).toEqual(before);
  });

  it('unknown, foreign, ARCHIVED and malformed project ids are the same 404 for GET and PATCH; the other tenant stays untouched', async () => {
    await patch(projectB.projectId, { effectiveFromMonth: '2027-01-01', shifts: [DAY] }, adminB).expect(200);
    const archived = await createSyntheticProject(db(), tenantA.companyId, 'Archiv', 'ARCHIVED');
    await seedVersion(archived, '2027-01-01', [['TAG', '06:00', '18:00']]);
    const beforeA = await state(tenantA.companyId);
    const beforeB = await state(tenantB.companyId);
    const shape = (body: Record<string, unknown>) => {
      const { correlationId, instance, ...rest } = body;
      expect([typeof correlationId, typeof instance]).toEqual(['string', 'string']);
      return rest;
    };
    const valid = { effectiveFromMonth: '2027-01-01', shifts: [DAY, NIGHT] };
    const reference = await get(randomUUID(), '2027-01-01').expect(404);
    expect(reference.headers['content-type']).toMatch(PROBLEM_JSON);
    // Thunks: supertest requests must be created only when they are sent.
    const attempts = [
      () => get(projectB.projectId, '2027-01-01'),
      () => get(archived.projectId, '2027-01-01'),
      () => get('not-a-uuid', '2027-01-01'),
      () => patch(randomUUID(), valid),
      () => patch(projectB.projectId, valid),
      () => patch(archived.projectId, valid),
      () => patch('not-a-uuid', valid),
    ];
    for (const attempt of attempts) {
      const response = await attempt().expect(404);
      expect(response.body.code).toBe('RESOURCE_NOT_FOUND');
      expect(shape(response.body)).toEqual(shape(reference.body));
    }
    expect(await state(tenantA.companyId)).toEqual(beforeA);
    expect(await state(tenantB.companyId)).toEqual(beforeB);
    // Admin B cannot read tenant A's project either.
    expect((await get(north.projectId, '2027-01-01', adminB).expect(404)).body.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('GET: effectiveForMonth is required, strictly formatted and the first of a month; no other parameter', async () => {
    const missing = await get(north.projectId, null).expect(400);
    expect(missing.body.code).toBe('VALIDATION_FAILED');
    expect(missing.body.errors).toContainEqual(expect.objectContaining({ pointer: '#/effectiveForMonth', code: 'REQUIRED' }));
    const impossible = await get(north.projectId, '2027-02-30').expect(400);
    expect(impossible.body.errors).toContainEqual(expect.objectContaining({ pointer: '#/effectiveForMonth', code: 'INVALID_FORMAT' }));
    expect((await get(north.projectId, '2027-03-15').expect(400)).body.code).toBe('INVALID_MONTH_START');
    const extra = await http().get(`${path(north.projectId)}?effectiveForMonth=2027-01-01&companyId=${tenantB.companyId}`)
      .set('Cookie', adminA.cookie).expect(400);
    expect(extra.body.code).toBe('UNKNOWN_FIELD');
  });

  it('PATCH: malformed input and tenant/id fields are rejected before any write (field pointers, no echo)', async () => {
    const before = await state(tenantA.companyId);
    const base = { effectiveFromMonth: '2027-01-01', shifts: [DAY, NIGHT] };
    for (const [body, pointer, code] of [
      [{ shifts: [DAY] }, '#/effectiveFromMonth', 'REQUIRED'],
      [{ ...base, effectiveFromMonth: '2027-02-30' }, '#/effectiveFromMonth', 'INVALID_FORMAT'],
      [{ ...base, shifts: null }, '#/shifts', 'REQUIRED'],
      [{ ...base, shifts: [] }, '#/shifts', 'TOO_SHORT'],
      [{ ...base, shifts: [DAY, NIGHT, DAY] }, '#/shifts', 'TOO_LONG'],
      [{ ...base, shifts: [DAY, { ...DAY, startLocal: '07:00' }] }, '#/shifts', 'DUPLICATE_ITEM'],
      [{ ...base, shifts: [{ ...DAY, shiftKind: 'TAG' }] }, '#/shifts/0/shiftKind', 'INVALID_ENUM'],
      [{ ...base, shifts: [{ ...DAY, startLocal: '06:00:00' }] }, '#/shifts/0/startLocal', 'INVALID_FORMAT'],
      [{ ...base, shifts: [DAY, { ...NIGHT, endLocal: '24:00' }] }, '#/shifts/1/endLocal', 'INVALID_FORMAT'],
      [{ ...base, shifts: [{ ...DAY, startLocal: 600 }] }, '#/shifts/0/startLocal', 'INVALID_TYPE'],
    ] as const) {
      const response = await patch(north.projectId, body).expect(400);
      expect(response.body.code, pointer).toBe('VALIDATION_FAILED');
      expect(response.body.errors).toContainEqual(expect.objectContaining({ pointer, code }));
      expect(JSON.stringify(response.body)).not.toContain('06:00:00');
    }
    expect((await patch(north.projectId, { ...base, effectiveFromMonth: '2027-01-15' }).expect(400)).body.code)
      .toBe('INVALID_MONTH_START');
    for (const body of [
      { ...base, companyId: tenantB.companyId },
      { ...base, projectId: projectB.projectId },
      { ...base, shifts: [{ ...DAY, id: randomUUID() }] },
    ]) {
      expect((await patch(north.projectId, body).expect(400)).body.code).toBe('UNKNOWN_FIELD');
    }
    expect(await state(tenantA.companyId)).toEqual(before);
  });

  it('time relations: start = end and a DAY shift past midnight are SHIFT_CONFIGURATION_INVALID; NIGHT may wrap', async () => {
    const before = await state(tenantA.companyId);
    for (const shift of [
      { ...DAY, startLocal: '18:00', endLocal: '06:00' },
      { ...DAY, startLocal: '18:00', endLocal: '00:00' },
      { ...DAY, startLocal: '06:00', endLocal: '06:00' },
      { ...NIGHT, startLocal: '18:00', endLocal: '18:00' },
    ]) {
      const response = await patch(north.projectId, { effectiveFromMonth: '2027-01-01', shifts: [shift] }).expect(400);
      expect(response.body.code, JSON.stringify(shift)).toBe('SHIFT_CONFIGURATION_INVALID');
      expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
    }
    expect(await state(tenantA.companyId)).toEqual(before);

    // Night over midnight, a night that does not wrap, and the widest day shift are valid.
    const wrap = await patch(north.projectId, {
      effectiveFromMonth: '2027-01-01',
      shifts: [{ ...DAY, startLocal: '00:00', endLocal: '23:59' }, { ...NIGHT, startLocal: '22:00', endLocal: '06:00' }],
    }).expect(200);
    expect(wrap.body.shifts.map((s: { startLocal: string; endLocal: string }) => `${s.startLocal}-${s.endLocal}`))
      .toEqual(['00:00-23:59', '22:00-06:00']);
    const early = await patch(north.projectId, {
      effectiveFromMonth: '2027-02-01',
      shifts: [{ ...NIGHT, startLocal: '00:00', endLocal: '06:00' }],
    }).expect(200);
    expect(early.body.shifts).toEqual([expect.objectContaining({ shiftKind: 'NIGHT', startLocal: '00:00', endLocal: '06:00' })]);
  });
});

describe('SP-08b — read and write (A-SP08b-01, versions, replacement)', () => {
  it('GET without any version: 200 with effectiveFromMonth null and no shifts; INACTIVE projects stay readable', async () => {
    const response = await get(north.projectId.toUpperCase(), '2027-01-01').expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.body).toEqual({ projectId: north.projectId, effectiveFromMonth: null, shifts: [] });
    const inactive = await createSyntheticProject(db(), tenantA.companyId, 'Inaktiv', 'INACTIVE');
    expect((await get(inactive.projectId, '2027-01-01').expect(200)).body)
      .toEqual({ projectId: inactive.projectId, effectiveFromMonth: null, shifts: [] });
  });

  it('PATCH stores DAY/NIGHT as TAG/NACHT, returns the version, audits without personal data and persists', async () => {
    const response = await patch(north.projectId, { effectiveFromMonth: '2027-01-01', shifts: [NIGHT, DAY] }).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      projectId: north.projectId,
      effectiveFromMonth: '2027-01-01',
      shifts: [
        { id: expect.any(String), ...DAY },
        { id: expect.any(String), ...NIGHT },
      ],
    });
    expect((await rowsOf(north.projectId)).map(({ shift_kind, start_local, end_local, month }) =>
      [shift_kind, start_local, end_local, month])).toEqual([
      ['NACHT', '18:00:00', '06:00:00', '2027-01-01'],
      ['TAG', '06:00:00', '18:00:00', '2027-01-01'],
    ]);
    const audit = await auditFor(response.headers['x-correlation-id']);
    expect(audit).toEqual([{
      action: 'SHIFT_CONFIGURATION_UPDATED',
      resource_type: 'PROJECT_SHIFT_CONFIGURATION',
      resource_id: north.projectId,
      actor_account_id: tenantA.admin.accountId,
      old_values: null,
      new_values: { effectiveFromMonth: '2027-01-01', shifts: [DAY, NIGHT] },
    }]);
    expect(JSON.stringify(audit)).not.toMatch(/Synthetic|@secureplan|Objekt/);
    // Persisted and effective for later months; not for earlier ones.
    expect((await get(north.projectId, '2027-01-01').expect(200)).body).toEqual(response.body);
    expect((await get(north.projectId, '2027-06-01').expect(200)).body).toEqual(response.body);
    expect((await get(north.projectId, '2026-12-01').expect(200)).body.effectiveFromMonth).toBeNull();
  });

  it('versions: the latest month <= X wins as a complete set; missing kinds are never inherited; year boundary', async () => {
    const december = await patch(north.projectId, { effectiveFromMonth: '2026-12-01', shifts: [DAY, NIGHT] }).expect(200);
    const decemberRows = await rowsOf(north.projectId);
    const march = await patch(north.projectId, {
      effectiveFromMonth: '2027-03-01',
      shifts: [{ ...DAY, startLocal: '07:00', endLocal: '19:00' }],
    }).expect(200);

    expect((await get(north.projectId, '2026-11-01').expect(200)).body.effectiveFromMonth).toBeNull();
    for (const month of ['2026-12-01', '2027-01-01', '2027-02-01']) {
      expect((await get(north.projectId, month).expect(200)).body, month).toEqual(december.body);
    }
    for (const month of ['2027-03-01', '2027-04-01', '2028-01-01']) {
      const effective = (await get(north.projectId, month).expect(200)).body;
      // Only DAY: the December NIGHT rule is NOT carried over into the March version.
      expect(effective, month).toEqual(march.body);
      expect(effective.shifts).toEqual([{ id: expect.any(String), shiftKind: 'DAY', startLocal: '07:00', endLocal: '19:00' }]);
    }
    // Writing March did not touch the December version.
    expect((await rowsOf(north.projectId)).filter((r) => r.month === '2026-12-01')).toEqual(decemberRows);
  });

  it('full replacement keeps the id of a retimed kind, removes a dropped kind and never touches other months', async () => {
    const first = (await patch(north.projectId, { effectiveFromMonth: '2027-01-01', shifts: [DAY, NIGHT] }).expect(200)).body;
    await patch(north.projectId, { effectiveFromMonth: '2027-02-01', shifts: [DAY, NIGHT] }).expect(200);
    const february = (await rowsOf(north.projectId)).filter((r) => r.month === '2027-02-01');
    const nightRowBefore = (await rowsOf(north.projectId)).find((r) => r.month === '2027-01-01' && r.shift_kind === 'NACHT');

    // Retime DAY only: DAY keeps its id; the unchanged NIGHT row is not rewritten (same updated_at).
    const retimed = await patch(north.projectId, {
      effectiveFromMonth: '2027-01-01',
      shifts: [{ ...DAY, startLocal: '07:00', endLocal: '19:00' }, NIGHT],
    }).expect(200);
    expect(retimed.body.shifts.map((s: { id: string }) => s.id)).toEqual(first.shifts.map((s: { id: string }) => s.id));
    expect((await rowsOf(north.projectId)).find((r) => r.month === '2027-01-01' && r.shift_kind === 'NACHT'))
      .toEqual(nightRowBefore);
    expect((await auditFor(retimed.headers['x-correlation-id']))[0]).toMatchObject({
      old_values: { effectiveFromMonth: '2027-01-01', shifts: [DAY, NIGHT] },
      new_values: { effectiveFromMonth: '2027-01-01', shifts: [{ ...DAY, startLocal: '07:00', endLocal: '19:00' }, NIGHT] },
    });

    // Omitting NIGHT removes it from this month on; DAY keeps its id.
    const dayOnly = await patch(north.projectId, {
      effectiveFromMonth: '2027-01-01',
      shifts: [{ ...DAY, startLocal: '07:00', endLocal: '19:00' }],
    }).expect(200);
    expect(dayOnly.body.shifts).toEqual([{ id: first.shifts[0].id, shiftKind: 'DAY', startLocal: '07:00', endLocal: '19:00' }]);
    expect((await get(north.projectId, '2027-01-01').expect(200)).body).toEqual(dayOnly.body);

    // Re-adding NIGHT creates a new row (new id).
    const readded = await patch(north.projectId, { effectiveFromMonth: '2027-01-01', shifts: [DAY, NIGHT] }).expect(200);
    expect(readded.body.shifts[0].id).toBe(first.shifts[0].id);
    expect(readded.body.shifts[1].id).not.toBe(first.shifts[1].id);

    expect((await rowsOf(north.projectId)).filter((r) => r.month === '2027-02-01')).toEqual(february);
  });

  it('no-op: the identical set is 200 without write or audit; a new month equal to the effective version is a real change', async () => {
    const stored = (await patch(north.projectId, { effectiveFromMonth: '2027-01-01', shifts: [DAY, NIGHT] }).expect(200)).body;
    const before = await state(tenantA.companyId);
    const repeated = await patch(north.projectId, { effectiveFromMonth: '2027-01-01', shifts: [NIGHT, DAY] }).expect(200);
    expect(repeated.body).toEqual(stored);
    expect(await state(tenantA.companyId)).toEqual(before);

    const copy = await patch(north.projectId, { effectiveFromMonth: '2027-02-01', shifts: [DAY, NIGHT] }).expect(200);
    expect(copy.body.effectiveFromMonth).toBe('2027-02-01');
    expect(copy.body.shifts.map((s: { id: string }) => s.id)).not.toContain(stored.shifts[0].id);
    expect((await auditFor(copy.headers['x-correlation-id']))[0]).toMatchObject({
      old_values: null,
      new_values: { effectiveFromMonth: '2027-02-01', shifts: [DAY, NIGHT] },
    });
  });
});

describe('SP-08b — month rules, status and error precedence', () => {
  it('past months are immutable (400 SHIFT_CONFIGURATION_INVALID, even if unchanged); the current month is writable', async () => {
    await seedVersion(north, '2026-10-01', [['TAG', '06:00', '18:00']]);
    const history = await rowsOf(north.projectId);
    const before = await state(tenantA.companyId);
    expect((await patch(north.projectId, { effectiveFromMonth: '2026-11-01', shifts: [DAY] }).expect(400)).body.code)
      .toBe('SHIFT_CONFIGURATION_INVALID');
    expect((await patch(north.projectId, { effectiveFromMonth: '2026-10-01', shifts: [DAY] }).expect(400)).body.code)
      .toBe('SHIFT_CONFIGURATION_INVALID');
    expect(await state(tenantA.companyId)).toEqual(before);
    // The past version remains readable and effective until the current month's version.
    expect((await get(north.projectId, '2026-11-01').expect(200)).body.effectiveFromMonth).toBe('2026-10-01');
    const current = await patch(north.projectId, { effectiveFromMonth: '2026-12-01', shifts: [DAY, NIGHT] }).expect(200);
    expect(current.body.effectiveFromMonth).toBe('2026-12-01');
    expect((await rowsOf(north.projectId)).filter((r) => r.month === '2026-10-01')).toEqual(history);
  });

  it('the company time zone decides the current month (Berlin vs New York at the year boundary)', async () => {
    const instant = () => new Date('2026-12-31T23:30:00Z');
    await bootApp({ clock: instant });
    // Berlin: local 01 Jan 2027 00:30, December is already history.
    expect((await patch(north.projectId, { effectiveFromMonth: '2026-12-01', shifts: [DAY] }).expect(400)).body.code)
      .toBe('SHIFT_CONFIGURATION_INVALID');
    await db().query('UPDATE companies SET time_zone = $2 WHERE id = $1', [tenantA.companyId, 'America/New_York']);
    await bootApp({ clock: instant });
    // New York: local 31 Dec 18:30, December is still the current month.
    expect((await patch(north.projectId, { effectiveFromMonth: '2026-12-01', shifts: [DAY] }).expect(200)).body.effectiveFromMonth)
      .toBe('2026-12-01');
  });

  it('a month that became history after a write can no longer be changed; a new version starts later', async () => {
    await patch(north.projectId, { effectiveFromMonth: '2026-12-01', shifts: [DAY, NIGHT] }).expect(200);
    const december = await rowsOf(north.projectId);
    await bootApp({ clock: () => new Date('2027-02-10T12:00:00Z') });
    expect((await patch(north.projectId, { effectiveFromMonth: '2026-12-01', shifts: [DAY] }).expect(400)).body.code)
      .toBe('SHIFT_CONFIGURATION_INVALID');
    await patch(north.projectId, { effectiveFromMonth: '2027-02-01', shifts: [DAY] }).expect(200);
    expect((await rowsOf(north.projectId)).filter((r) => r.month === '2026-12-01')).toEqual(december);
    expect((await get(north.projectId, '2027-01-01').expect(200)).body.effectiveFromMonth).toBe('2026-12-01');
  });

  it('INACTIVE blocks every write, even an unchanged one, before the month rule; reads stay possible; ARCHIVED is 404', async () => {
    const stored = (await patch(north.projectId, { effectiveFromMonth: '2027-01-01', shifts: [DAY] }).expect(200)).body;
    await db().query("UPDATE projects SET status = 'INACTIVE' WHERE id = $1", [north.projectId]);
    const before = await state(tenantA.companyId);
    for (const body of [
      { effectiveFromMonth: '2027-01-01', shifts: [DAY] },
      { effectiveFromMonth: '2027-01-01', shifts: [DAY, NIGHT] },
      { effectiveFromMonth: '2026-11-01', shifts: [DAY] },
    ]) {
      expect((await patch(north.projectId, body).expect(409)).body.code, JSON.stringify(body)).toBe('PROJECT_INACTIVE');
    }
    expect(await state(tenantA.companyId)).toEqual(before);
    expect((await get(north.projectId, '2027-01-01').expect(200)).body).toEqual(stored);
    await db().query("UPDATE projects SET status = 'ARCHIVED' WHERE id = $1", [north.projectId]);
    expect((await get(north.projectId, '2027-01-01').expect(404)).body.code).toBe('RESOURCE_NOT_FOUND');
    expect((await patch(north.projectId, { effectiveFromMonth: '2027-01-01', shifts: [DAY] }).expect(404)).body.code)
      .toBe('RESOURCE_NOT_FOUND');
  });

  it('precedence: tenant-independent payload errors come first, then 404, then state rules; nothing leaks', async () => {
    const foreign = projectB.projectId;
    expect((await patch(foreign, { effectiveFromMonth: '2027-01-01', shifts: [] }).expect(400)).body.code)
      .toBe('VALIDATION_FAILED');
    expect((await patch(foreign, { effectiveFromMonth: '2027-01-15', shifts: [DAY] }).expect(400)).body.code)
      .toBe('INVALID_MONTH_START');
    expect((await patch(foreign, {
      effectiveFromMonth: '2027-01-01',
      shifts: [{ ...DAY, startLocal: '18:00', endLocal: '06:00' }],
    }).expect(400)).body.code).toBe('SHIFT_CONFIGURATION_INVALID');
    // The month rule needs tenant data, so a foreign project is concealed first.
    expect((await patch(foreign, { effectiveFromMonth: '2026-11-01', shifts: [DAY] }).expect(404)).body.code)
      .toBe('RESOURCE_NOT_FOUND');
    expect((await get(projectB.projectId, '2027-01-01', adminB).expect(200)).body.effectiveFromMonth).toBeNull();
  });
});

describe('SP-08b — tenant isolation, integrity, rollback and planning guard', () => {
  it('writes of tenant A never change tenant B configuration of the same month', async () => {
    const b = (await patch(projectB.projectId, { effectiveFromMonth: '2027-01-01', shifts: [DAY, NIGHT] }, adminB).expect(200)).body;
    await patch(north.projectId, { effectiveFromMonth: '2027-01-01', shifts: [DAY, NIGHT] }).expect(200);
    await patch(north.projectId, { effectiveFromMonth: '2027-01-01', shifts: [{ ...NIGHT, startLocal: '20:00' }] }).expect(200);
    expect((await get(projectB.projectId, '2027-01-01', adminB).expect(200)).body).toEqual(b);
    expect((await get(projectB.projectId, '2027-01-01', adminA).expect(404)).body.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('an audit failure rolls the change back completely (new version and replacement)', async () => {
    await seedVersion(north, '2027-01-01', [['TAG', '06:00', '18:00'], ['NACHT', '18:00', '06:00']]);
    await bootApp({ audit: new FailingAudit('SHIFT_CONFIGURATION_UPDATED') });
    const before = await state(tenantA.companyId);
    expect((await patch(north.projectId, { effectiveFromMonth: '2027-02-01', shifts: [DAY] }).expect(500)).body.code)
      .toBe('INTERNAL_ERROR');
    expect((await patch(north.projectId, { effectiveFromMonth: '2027-01-01', shifts: [{ ...DAY, startLocal: '07:00' }] })
      .expect(500)).body.code).toBe('INTERNAL_ERROR');
    expect(await state(tenantA.companyId)).toEqual(before);
  });

  it('database constraints hold for direct SQL (tenant FK, month start, times, kinds, uniqueness, RESTRICT)', async () => {
    const insert = (companyId: string, projectId: string, month: string, kind: string, start: string, end: string) =>
      db().query(
        `INSERT INTO shift_configurations (company_id, project_id, effective_from_month, shift_kind, start_local, end_local)
         VALUES ($1, $2, $3::date, $4, $5::time, $6::time)`,
        [companyId, projectId, month, kind, start, end],
      );
    const a = tenantA.companyId;
    await expect(insert(a, projectB.projectId, '2027-01-01', 'TAG', '06:00', '18:00'))
      .rejects.toMatchObject({ code: '23503', constraint: 'fk_shift_configurations__projects' });
    for (const [args, constraint] of [
      [['2027-01-15', 'TAG', '06:00', '18:00'], 'ck_shift_configurations__month_start'],
      [['2027-01-01', 'NACHT', '18:00', '18:00'], 'ck_shift_configurations__distinct_times'],
      [['2027-01-01', 'TAG', '18:00', '06:00'], 'ck_shift_configurations__day_same_day'],
      [['2027-01-01', 'TAG', '18:00', '00:00'], 'ck_shift_configurations__day_same_day'],
      [['2027-01-01', 'DAY', '06:00', '18:00'], 'ck_shift_configurations__shift_kind'],
      [['2027-01-01', 'NACHT', '18:00:30', '06:00'], 'ck_shift_configurations__minute_precision'],
    ] as const) {
      await expect(insert(a, north.projectId, ...args), constraint).rejects.toMatchObject({ code: '23514', constraint });
    }
    await insert(a, north.projectId, '2027-01-01', 'TAG', '06:00', '18:00');
    await expect(insert(a, north.projectId, '2027-01-01', 'TAG', '07:00', '19:00'))
      .rejects.toMatchObject({ code: '23505', constraint: 'uq_shift_configurations__project_month_kind' });
    await expect(db().query('DELETE FROM projects WHERE id = $1', [north.projectId]))
      .rejects.toMatchObject({ code: '23503', constraint: 'fk_shift_configurations__projects' });
  });

  it('temporary planning guard: with a planning table present, GET and a true no-op work, every effective change fails closed', async () => {
    const stored = (await patch(north.projectId, { effectiveFromMonth: '2027-01-01', shifts: [DAY, NIGHT] }).expect(200)).body;
    const probe = await db().connect();
    // The real service SQL, driven inside the probe transaction that alone sees the table.
    const service = new ShiftConfigurationsService(
      { withTransaction: <T>(work: (client: typeof probe) => Promise<T>) => work(probe) } as unknown as DatabaseService,
      new BusinessAuditService(),
      MID_DEC,
    );
    const tenant = {
      sessionId: randomUUID(), accountId: tenantA.admin.accountId, companyId: tenantA.companyId, role: 'COMPANY_ADMIN',
    } as const;
    const inProbe = async () => ({
      rules: (await probe.query('SELECT id, shift_kind, start_local, end_local, updated_at FROM shift_configurations WHERE project_id = $1 ORDER BY id', [north.projectId])).rows,
      audit: (await probe.query('SELECT count(*)::int AS n FROM audit_event WHERE company_id = $1', [tenantA.companyId])).rows[0].n,
    });
    try {
      // Today none of the planning tables exists; that alone is not treated as proof of safety.
      await expect(assertShiftConfigurationPlanningCheckImplemented(probe)).resolves.toBeUndefined();
      for (const table of SHIFT_GUARD_PLANNING_TABLES) {
        // DDL inside a transaction is invisible to every other connection and rolled back afterwards.
        await probe.query('BEGIN');
        try {
          await probe.query(`CREATE TABLE public.${table} (id uuid)`);
          const before = await inProbe();
          expect(await service.getEffective(tenant, north.projectId, { effectiveForMonth: '2027-01-01' }), table).toEqual(stored);
          expect(await service.replace(tenant, north.projectId, { effectiveFromMonth: '2027-01-01', shifts: [NIGHT, DAY] }, randomUUID()))
            .toEqual(stored);
          for (const change of [
            { effectiveFromMonth: '2027-01-01', shifts: [DAY] },
            { effectiveFromMonth: '2027-02-01', shifts: [DAY, NIGHT] },
          ]) {
            await expect(service.replace(tenant, north.projectId, change, randomUUID()), table)
              .rejects.toMatchObject({ response: { code: 'SHIFT_CONFIGURATION_CONFLICT' } });
          }
          expect(await inProbe()).toEqual(before);
        } finally {
          await probe.query('ROLLBACK');
        }
      }
    } finally {
      probe.release();
    }
  });
});
