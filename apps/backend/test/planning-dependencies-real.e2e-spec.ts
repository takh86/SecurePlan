/**
 * SP-11 PR-1 workforce writers versus real planning dependencies, over HTTP
 * against REAL PostgreSQL (SP11A-R1 rows D2-01..04, D3-01..04, D4-01,
 * D5-01..03, DEACT-01; PO D2-D5; C7 cutoff ends_at > evaluatedAt).
 *
 * The wall clock is pinned to 2026-12-15T12:00:00Z: the company-local current
 * month is December 2026 and "unresolved future" means ends_at > that instant.
 * Planning rows are synthetic fixtures (PUBLISHED and removed rows included);
 * they do not prove that publish or removal endpoints exist.
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { SessionService } from '../src/auth/session.service.js';
import {
  createSyntheticProject,
  createSyntheticSession,
  createSyntheticTenant,
  openLocalTestPool,
  realSessionService,
  removeSyntheticTenants,
  type SyntheticEmployee,
  type SyntheticProject,
  type SyntheticSession,
  type SyntheticTenant,
  type TestPool,
} from './helpers/synthetic-tenants.js';
import { ORIGIN, RecordingDelivery, bootEmployeesApp } from './helpers/employees-test-app.js';
import {
  STANDARD_SHIFTS,
  createStaff,
  insertDuty,
  insertMembership,
  insertPlan,
  insertProjectAssignment,
  insertShiftConfiguration,
  planningState,
} from './helpers/planning-fixtures.js';

const NOW = '2026-12-15T12:00:00Z';

let pool: TestPool | undefined;
let sessions: SessionService;
let app: INestApplication<App> | undefined;
let tenantA: SyntheticTenant;
let tenantB: SyntheticTenant;
let adminA: SyntheticSession;
let north: SyntheticProject;
let south: SyntheticProject;
let mira: SyntheticEmployee;
let jonas: SyntheticEmployee;
const createdCompanies: string[] = [];
let previousOrigin: string | undefined;

function db(): TestPool {
  if (!pool) throw new Error('Test database is unavailable');
  return pool;
}

const http = () => request(app!.getHttpServer());

function send(method: 'patch' | 'post' | 'delete', path: string, body: object = {}, headers: Record<string, string> = {}) {
  let pending = http()[method](path).set('Origin', ORIGIN).set('Cookie', adminA.cookie).set('X-CSRF-Token', adminA.csrf);
  for (const [name, value] of Object.entries(headers)) pending = pending.set(name, value);
  return pending.send(body);
}

async function assignmentVersion(id: string): Promise<string> {
  return (await db().query<{ version: string }>(
    'SELECT (extract(epoch FROM updated_at) * 1000000)::bigint::text AS version FROM project_assignments WHERE id = $1', [id],
  )).rows[0].version;
}

/** A plan of `project` for `month` (created on demand) with one duty and optional members. */
async function duty(options: {
  project?: SyntheticProject;
  month: string;
  dutyDate: string;
  startsAt: string;
  endsAt: string;
  members?: SyntheticEmployee[];
  published?: boolean;
  removedAt?: string;
  memberState?: 'ACTIVE' | 'REMOVED';
}): Promise<string> {
  const project = options.project ?? north;
  const existing = await db().query<{ id: string }>(
    'SELECT id FROM monthly_plans WHERE company_id = $1 AND project_id = $2 AND planning_month = $3::date',
    [tenantA.companyId, project.projectId, options.month],
  );
  const planId = existing.rows[0]?.id ?? await insertPlan(db(), tenantA.companyId, project.projectId, options.month,
    options.published ? { byAccountId: tenantA.admin.accountId } : undefined);
  const dutyId = await insertDuty(db(), {
    companyId: tenantA.companyId, projectId: project.projectId, planId, month: options.month, dutyDate: options.dutyDate,
    startsAt: options.startsAt, endsAt: options.endsAt, removedAt: options.removedAt,
  });
  for (const member of options.members ?? []) {
    await insertMembership(db(), tenantA.companyId, dutyId, member.employeeId, options.memberState ?? 'ACTIVE');
  }
  return dutyId;
}

beforeAll(() => {
  pool = openLocalTestPool(10);
  sessions = realSessionService(db());
  previousOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
});

beforeEach(async () => {
  tenantA = await createSyntheticTenant(db(), 'SP11 deps A');
  createdCompanies.push(tenantA.companyId);
  tenantB = await createSyntheticTenant(db(), 'SP11 deps B');
  createdCompanies.push(tenantB.companyId);
  adminA = await createSyntheticSession(sessions, tenantA.admin);
  north = await createSyntheticProject(db(), tenantA.companyId, 'SP11 Nord');
  south = await createSyntheticProject(db(), tenantA.companyId, 'SP11 Sued');
  mira = await createStaff(db(), tenantA.companyId);
  jonas = await createStaff(db(), tenantA.companyId);
  app = await bootEmployeesApp(new RecordingDelivery(), { clock: () => new Date(NOW) });
});

afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

afterAll(async () => {
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousOrigin;
  if (pool) {
    await removeSyntheticTenants(pool, createdCompanies);
    await pool.end();
  }
});

describe('D2 — monthly assignment PATCH/DELETE versus live duty memberships', () => {
  it('a live membership on the OLD tuple blocks every effective PATCH and the DELETE, in both plan states (D2-01)', async () => {
    for (const published of [false, true]) {
      const month = published ? '2027-02-01' : '2027-01-01';
      const assignmentId = await insertProjectAssignment(db(), tenantA.companyId, mira.employeeId, north.projectId, month);
      await duty({ month, dutyDate: `${month.slice(0, 8)}10`, startsAt: `${month.slice(0, 8)}10T05:00:00Z`,
        endsAt: `${month.slice(0, 8)}10T17:00:00Z`, members: [mira], published });
      const before = await planningState(db(), tenantA.companyId);
      for (const change of [{ monthStart: '2027-06-01' }, { projectId: south.projectId }, { employeeId: jonas.employeeId }]) {
        const response = await send('patch', `/api/v1/project-assignments/${assignmentId}`, change);
        expect([response.status, response.body.code], JSON.stringify(change)).toEqual([409, 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT']);
      }
      const removal = await send('delete', `/api/v1/project-assignments/${assignmentId}`, {},
        { 'Expected-Version': await assignmentVersion(assignmentId) });
      expect([removal.status, removal.body.code]).toEqual([409, 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT']);
      expect(await planningState(db(), tenantA.companyId)).toEqual(before);
    }
  });

  it('a live membership on the RESULTING tuple blocks the PATCH (D2-01)', async () => {
    const assignmentId = await insertProjectAssignment(db(), tenantA.companyId, jonas.employeeId, south.projectId, '2027-02-01');
    // Inconsistent historical fixture: jonas is a member of a north duty in February.
    await duty({ month: '2027-02-01', dutyDate: '2027-02-10', startsAt: '2027-02-10T05:00:00Z', endsAt: '2027-02-10T17:00:00Z', members: [jonas] });
    const response = await send('patch', `/api/v1/project-assignments/${assignmentId}`, { projectId: north.projectId });
    expect([response.status, response.body.code]).toEqual([409, 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT']);
  });

  it('unrelated employees, months, projects, tenants and removed history never block (D2-02)', async () => {
    const assignmentId = await insertProjectAssignment(db(), tenantA.companyId, mira.employeeId, north.projectId, '2027-01-01');
    await duty({ month: '2027-01-01', dutyDate: '2027-01-10', startsAt: '2027-01-10T05:00:00Z', endsAt: '2027-01-10T17:00:00Z', members: [jonas] });
    await duty({ project: south, month: '2027-01-01', dutyDate: '2027-01-11', startsAt: '2027-01-11T05:00:00Z', endsAt: '2027-01-11T17:00:00Z', members: [mira] });
    await duty({ month: '2027-03-01', dutyDate: '2027-03-10', startsAt: '2027-03-10T05:00:00Z', endsAt: '2027-03-10T17:00:00Z', members: [mira] });
    await duty({ month: '2027-01-01', dutyDate: '2027-01-12', startsAt: '2027-01-12T05:00:00Z', endsAt: '2027-01-12T17:00:00Z', members: [mira], memberState: 'REMOVED' });
    await duty({ month: '2027-01-01', dutyDate: '2027-01-13', startsAt: '2027-01-13T05:00:00Z', endsAt: '2027-01-13T17:00:00Z', members: [mira], removedAt: '2026-12-01T00:00:00Z' });
    const foreignProject = await createSyntheticProject(db(), tenantB.companyId, 'SP11 Fremd');
    const foreignStaff = await createStaff(db(), tenantB.companyId);
    const foreignPlan = await insertPlan(db(), tenantB.companyId, foreignProject.projectId, '2027-01-01');
    const foreignDuty = await insertDuty(db(), { companyId: tenantB.companyId, projectId: foreignProject.projectId, planId: foreignPlan,
      month: '2027-01-01', dutyDate: '2027-01-10', startsAt: '2027-01-10T05:00:00Z', endsAt: '2027-01-10T17:00:00Z' });
    await insertMembership(db(), tenantB.companyId, foreignDuty, foreignStaff.employeeId);

    const moved = await send('patch', `/api/v1/project-assignments/${assignmentId}`, { monthStart: '2027-02-01' }).expect(200);
    expect(moved.body.monthStart).toBe('2027-02-01');
    // The removed rows are retained, not cleaned up.
    expect((await db().query("SELECT count(*)::int AS n FROM plan_assignments WHERE company_id = $1 AND state = 'REMOVED'", [tenantA.companyId])).rows[0].n).toBe(1);
  });

  it('#73 version precedence and the future-only removal stay unchanged (D2-03, D2-04)', async () => {
    const future = await insertProjectAssignment(db(), tenantA.companyId, mira.employeeId, north.projectId, '2027-01-01');
    const current = await insertProjectAssignment(db(), tenantA.companyId, jonas.employeeId, north.projectId, '2026-12-01');
    await duty({ month: '2027-01-01', dutyDate: '2027-01-10', startsAt: '2027-01-10T05:00:00Z', endsAt: '2027-01-10T17:00:00Z', members: [mira] });
    expect((await send('delete', `/api/v1/project-assignments/${future}`)).body.code).toBe('EXPECTED_VERSION_REQUIRED');
    expect((await send('delete', `/api/v1/project-assignments/${future}`, {}, { 'Expected-Version': 'abc' })).body.code).toBe('INVALID_EXPECTED_VERSION');
    const stale = await send('delete', `/api/v1/project-assignments/${future}`, {}, { 'Expected-Version': String(BigInt(await assignmentVersion(future)) + 1n) });
    expect([stale.status, stale.body.code]).toEqual([409, 'PROJECT_ASSIGNMENT_CONFLICT']);
    const currentMonth = await send('delete', `/api/v1/project-assignments/${current}`, {}, { 'Expected-Version': await assignmentVersion(current) });
    expect([currentMonth.status, currentMonth.body.code]).toEqual([409, 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT']);
    // A historical correction without a dependency keeps working (existing exceptions unchanged).
    await send('patch', `/api/v1/project-assignments/${current}`, { projectId: south.projectId }).expect(200);
    // Without a dependency the future-only removal works.
    const free = await insertProjectAssignment(db(), tenantA.companyId, jonas.employeeId, north.projectId, '2027-04-01');
    await send('delete', `/api/v1/project-assignments/${free}`, {}, { 'Expected-Version': await assignmentVersion(free) }).expect(204);
    // A true no-op PATCH answers 200 even with a dependency (it returns before the guard).
    await send('patch', `/api/v1/project-assignments/${future}`, { monthStart: '2027-01-01' }).expect(200);
  });
});

describe('D3 — shift configuration replacement versus saved duties in [M, next version)', () => {
  const shifts = { effectiveFromMonth: '', shifts: [{ shiftKind: 'DAY', startLocal: '07:00', endLocal: '19:00' }] };

  beforeEach(async () => {
    await insertShiftConfiguration(db(), tenantA.companyId, north.projectId, '2027-01-01', STANDARD_SHIFTS);
    await insertShiftConfiguration(db(), tenantA.companyId, north.projectId, '2027-03-01', STANDARD_SHIFTS);
  });

  it('a live duty (empty or staffed) inside [M, N) blocks; before M and exactly at N do not; the open end is protected (D3-01)', async () => {
    const path = `/api/v1/projects/${north.projectId}/shift-configuration`;
    await duty({ month: '2026-12-01', dutyDate: '2026-12-31', startsAt: '2026-12-31T05:00:00Z', endsAt: '2026-12-31T17:00:00Z' });
    await duty({ month: '2027-03-01', dutyDate: '2027-03-01', startsAt: '2027-03-01T05:00:00Z', endsAt: '2027-03-01T17:00:00Z' });
    await send('patch', path, { ...shifts, effectiveFromMonth: '2027-01-01' }).expect(200);
    // Empty duty at N-1 (last day of February).
    await duty({ month: '2027-02-01', dutyDate: '2027-02-28', startsAt: '2027-02-28T05:00:00Z', endsAt: '2027-02-28T17:00:00Z' });
    const before = await planningState(db(), tenantA.companyId);
    const refused = await send('patch', path, { ...shifts, effectiveFromMonth: '2027-01-01', shifts: [{ shiftKind: 'DAY', startLocal: '08:00', endLocal: '20:00' }] });
    expect([refused.status, refused.body.code]).toEqual([409, 'SHIFT_CONFIGURATION_CONFLICT']);
    expect(await planningState(db(), tenantA.companyId)).toEqual(before);
    // The March version is protected forward without end by the March duty.
    const open = await send('patch', path, { ...shifts, effectiveFromMonth: '2027-03-01' });
    expect([open.status, open.body.code]).toEqual([409, 'SHIFT_CONFIGURATION_CONFLICT']);
  });

  it('inserting an intervening version counts as a change; tombstoned duties and other tenants never block (D3-02, D3-03)', async () => {
    const path = `/api/v1/projects/${north.projectId}/shift-configuration`;
    await duty({ month: '2027-01-01', dutyDate: '2027-01-20', startsAt: '2027-01-20T05:00:00Z', endsAt: '2027-01-20T17:00:00Z', members: [mira] });
    await duty({ month: '2027-02-01', dutyDate: '2027-02-10', startsAt: '2027-02-10T05:00:00Z', endsAt: '2027-02-10T17:00:00Z', removedAt: '2026-12-01T00:00:00Z' });
    // February version: [Feb, Mar) holds only a tombstone -> allowed, although the January duty exists.
    await send('patch', path, { ...shifts, effectiveFromMonth: '2027-02-01' }).expect(200);
    await duty({ month: '2027-02-01', dutyDate: '2027-02-11', startsAt: '2027-02-11T05:00:00Z', endsAt: '2027-02-11T17:00:00Z' });
    const refused = await send('patch', path, { ...shifts, effectiveFromMonth: '2027-02-01', shifts: [{ shiftKind: 'DAY', startLocal: '09:00', endLocal: '21:00' }] });
    expect([refused.status, refused.body.code]).toEqual([409, 'SHIFT_CONFIGURATION_CONFLICT']);
    // A true no-op with live duties: 200, no audit.
    const audit = (await db().query('SELECT count(*)::int AS n FROM audit_event WHERE company_id = $1', [tenantA.companyId])).rows[0].n;
    await send('patch', path, { ...shifts, effectiveFromMonth: '2027-02-01' }).expect(200);
    expect((await db().query('SELECT count(*)::int AS n FROM audit_event WHERE company_id = $1', [tenantA.companyId])).rows[0].n).toBe(audit);
    // South (no duties) is independent.
    await send('patch', `/api/v1/projects/${south.projectId}/shift-configuration`, { ...shifts, effectiveFromMonth: '2027-02-01' }).expect(200);
  });

  it('an accepted configuration write never rewrites stored duty snapshots (D3-04)', async () => {
    const dutyId = await duty({ month: '2027-05-01', dutyDate: '2027-05-03', startsAt: '2027-05-03T04:00:00Z', endsAt: '2027-05-03T16:00:00Z' });
    const snapshot = async () => (await db().query('SELECT starts_at, ends_at, start_local, end_local, config_effective_from_month, updated_at FROM duties WHERE id = $1', [dutyId])).rows[0];
    const before = await snapshot();
    await send('patch', `/api/v1/projects/${north.projectId}/shift-configuration`, { ...shifts, effectiveFromMonth: '2027-01-01' }).expect(200);
    expect(await snapshot()).toEqual(before);
  });
});

describe('D4 — project ACTIVE -> INACTIVE versus unresolved future duties (C7 cutoff)', () => {
  const deactivate = () => send('patch', `/api/v1/projects/${north.projectId}`, { status: 'INACTIVE' });

  it.each([
    ['an empty future duty', '2026-12-20T05:00:00Z', '2026-12-20T17:00:00Z', true],
    ['an in-progress duty', '2026-12-15T05:00:00Z', '2026-12-15T17:00:00Z', true],
    ['an overnight duty that started yesterday', '2026-12-14T17:00:00Z', '2026-12-15T12:00:01Z', true],
    ['a duty ending exactly now (finished)', '2026-12-15T00:00:00Z', NOW, false],
    ['a past duty', '2026-12-01T05:00:00Z', '2026-12-01T17:00:00Z', false],
  ] as const)('%s -> %s', async (_name, startsAt, endsAt, blocks) => {
    await duty({ month: '2026-12-01', dutyDate: startsAt.slice(0, 10), startsAt, endsAt });
    const before = await planningState(db(), tenantA.companyId);
    const response = await deactivate();
    if (blocks) {
      expect([response.status, response.body.code]).toEqual([409, 'PROJECT_HAS_FUTURE_DUTIES']);
      expect(response.body.detail).toBe('The project has scheduled duties that require explicit resolution.');
      expect(await planningState(db(), tenantA.companyId)).toEqual(before);
    } else {
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('INACTIVE');
    }
  });

  it('tombstoned duties and monthly assignments alone never block (Case 3b); a mixed rename is refused whole; a rename alone works', async () => {
    await duty({ month: '2027-01-01', dutyDate: '2027-01-10', startsAt: '2027-01-10T05:00:00Z', endsAt: '2027-01-10T17:00:00Z', removedAt: '2026-12-01T00:00:00Z' });
    await insertProjectAssignment(db(), tenantA.companyId, mira.employeeId, south.projectId, '2027-01-01');
    await send('patch', `/api/v1/projects/${south.projectId}`, { status: 'INACTIVE' }).expect(200);
    await send('patch', `/api/v1/projects/${north.projectId}`, { status: 'INACTIVE' }).expect(200);
    await send('patch', `/api/v1/projects/${north.projectId}`, { status: 'ACTIVE' }).expect(200);
    await duty({ month: '2027-01-01', dutyDate: '2027-01-11', startsAt: '2027-01-11T05:00:00Z', endsAt: '2027-01-11T17:00:00Z', published: true });
    const mixed = await send('patch', `/api/v1/projects/${north.projectId}`, { name: 'SP11 Nord neu', status: 'INACTIVE' });
    expect([mixed.status, mixed.body.code]).toEqual([409, 'PROJECT_HAS_FUTURE_DUTIES']);
    expect((await db().query('SELECT name, status FROM projects WHERE id = $1', [north.projectId])).rows[0]).toEqual({ name: 'SP11 Nord', status: 'ACTIVE' });
    await send('patch', `/api/v1/projects/${north.projectId}`, { name: 'SP11 Nord neu' }).expect(200);
  });
});

describe('D5 — employment period versus newly excluded future duties', () => {
  const patchEmployee = (employee: SyntheticEmployee, body: object) => send('patch', `/api/v1/employees/${employee.employeeId}`, body);

  it('newly excluding a covered future duty is refused; inclusive bounds; in-progress counts, finished does not (D5-01)', async () => {
    await duty({ month: '2026-12-01', dutyDate: '2026-12-20', startsAt: '2026-12-20T05:00:00Z', endsAt: '2026-12-20T17:00:00Z', members: [mira] });
    const before = await planningState(db(), tenantA.companyId);
    for (const change of [{ employmentEnd: '2026-12-19' }, { employmentStart: '2026-12-21' }]) {
      const response = await patchEmployee(mira, change);
      expect([response.status, response.body.code], JSON.stringify(change)).toEqual([409, 'EMPLOYMENT_PERIOD_EXCLUDES_FUTURE_DUTIES']);
      expect(response.body.detail).toBe('The employment period excludes scheduled duties.');
      expect(Object.keys(response.body)).not.toContain('conflictingAssignments');
    }
    expect(await planningState(db(), tenantA.companyId)).toEqual(before);
    // The duty date itself is still covered (inclusive end).
    await patchEmployee(mira, { employmentEnd: '2026-12-20' }).expect(200);

    // In progress at the pinned instant: still unresolved.
    await duty({ month: '2026-12-01', dutyDate: '2026-12-15', startsAt: '2026-12-15T05:00:00Z', endsAt: '2026-12-15T17:00:00Z', members: [jonas] });
    expect((await patchEmployee(jonas, { employmentEnd: '2026-12-14' })).body.code).toBe('EMPLOYMENT_PERIOD_EXCLUDES_FUTURE_DUTIES');
    // Finished duties never block.
    const finisher = await createStaff(db(), tenantA.companyId);
    await duty({ month: '2026-12-01', dutyDate: '2026-12-10', startsAt: '2026-12-10T05:00:00Z', endsAt: NOW, members: [finisher] });
    await patchEmployee(finisher, { employmentEnd: '2026-12-09' }).expect(200);
  });

  it('already-uncovered duties never block an unrelated correction; removed history is ignored (D5-01)', async () => {
    const leaver = await createStaff(db(), tenantA.companyId, { end: '2026-12-25' });
    // Inconsistent fixture: a duty after the employment end already exists.
    await duty({ month: '2026-12-01', dutyDate: '2026-12-28', startsAt: '2026-12-28T05:00:00Z', endsAt: '2026-12-28T17:00:00Z', members: [leaver] });
    await duty({ month: '2026-12-01', dutyDate: '2026-12-22', startsAt: '2026-12-22T05:00:00Z', endsAt: '2026-12-22T17:00:00Z', members: [leaver], memberState: 'REMOVED' });
    await patchEmployee(leaver, { employmentEnd: '2026-12-21' }).expect(200);
  });

  it('the existing monthly check wins over the duty check; accepted edits keep exactly one EMPLOYEE_UPDATED without duty fields (D5-02, D5-03)', async () => {
    await insertProjectAssignment(db(), tenantA.companyId, mira.employeeId, north.projectId, '2027-02-01');
    await duty({ month: '2027-02-01', dutyDate: '2027-02-10', startsAt: '2027-02-10T05:00:00Z', endsAt: '2027-02-10T17:00:00Z', members: [mira] });
    const both = await patchEmployee(mira, { employmentEnd: '2027-01-31' });
    expect([both.status, both.body.code]).toEqual([409, 'EMPLOYMENT_PERIOD_EXCLUDES_FUTURE_PROJECT_ASSIGNMENTS']);
    const accepted = await patchEmployee(mira, { employmentEnd: '2027-06-30', firstName: 'Mira' }).expect(200);
    const audit = (await db().query<{ action: string; new_values: Record<string, unknown> }>(
      'SELECT action, new_values FROM audit_event WHERE company_id = $1 AND correlation_id = $2',
      [tenantA.companyId, accepted.headers['x-correlation-id']],
    )).rows;
    expect(audit.map((row) => row.action)).toEqual(['EMPLOYEE_UPDATED']);
    expect(JSON.stringify(audit[0].new_values)).not.toMatch(/[Dd]ut(y|ies)/);
  });
});

describe('Employee deactivation — separate future-duty rule (DEACT-01, D-8.4-11)', () => {
  const deactivate = (employee: SyntheticEmployee) => send('post', `/api/v1/employees/${employee.employeeId}/deactivate`);

  it('a live future membership blocks with EMPLOYEE_HAS_FUTURE_ASSIGNMENTS; employee, account, sessions and audit stay unchanged', async () => {
    const target = await createSyntheticSession(sessions, mira.account);
    await duty({ month: '2027-01-01', dutyDate: '2027-01-10', startsAt: '2027-01-10T05:00:00Z', endsAt: '2027-01-10T17:00:00Z', members: [mira] });
    const before = await planningState(db(), tenantA.companyId);
    const response = await deactivate(mira);
    expect([response.status, response.body.code]).toEqual([409, 'EMPLOYEE_HAS_FUTURE_ASSIGNMENTS']);
    expect(await planningState(db(), tenantA.companyId)).toEqual(before);
    expect((await http().get('/api/v1/me').set('Cookie', target.cookie)).status).toBe(200);
  });

  it('finished duties, removed memberships, tombstones and monthly links alone never block; then account and sessions go together', async () => {
    const target = await createSyntheticSession(sessions, mira.account);
    await duty({ month: '2026-12-01', dutyDate: '2026-12-01', startsAt: '2026-12-01T05:00:00Z', endsAt: '2026-12-01T17:00:00Z', members: [mira] });
    await duty({ month: '2027-01-01', dutyDate: '2027-01-11', startsAt: '2027-01-11T05:00:00Z', endsAt: '2027-01-11T17:00:00Z', members: [mira], memberState: 'REMOVED' });
    await duty({ month: '2027-01-01', dutyDate: '2027-01-12', startsAt: '2027-01-12T05:00:00Z', endsAt: '2027-01-12T17:00:00Z', members: [mira], removedAt: '2026-12-01T00:00:00Z' });
    await insertProjectAssignment(db(), tenantA.companyId, mira.employeeId, north.projectId, '2027-01-01');
    const response = await deactivate(mira).expect(200);
    expect(response.body.status).toBe('INACTIVE');
    expect((await db().query('SELECT status FROM accounts WHERE id = $1', [mira.account.accountId])).rows[0].status).toBe('DEACTIVATED');
    expect((await http().get('/api/v1/me').set('Cookie', target.cookie)).status).toBe(401);
    expect((await db().query("SELECT count(*)::int AS n FROM audit_event WHERE company_id = $1 AND action IN ('EMPLOYEE_DEACTIVATED', 'ACCOUNT_DEACTIVATED')", [tenantA.companyId])).rows[0].n).toBe(2);
  });

  it('EMPLOYEE_INACTIVE precedes the duty rule; unknown and foreign employees are 404', async () => {
    await duty({ month: '2027-01-01', dutyDate: '2027-01-10', startsAt: '2027-01-10T05:00:00Z', endsAt: '2027-01-10T17:00:00Z', members: [jonas] });
    await db().query("UPDATE employees SET status = 'DEACTIVATED' WHERE id = $1", [jonas.employeeId]);
    expect((await deactivate(jonas)).body.code).toBe('EMPLOYEE_INACTIVE');
    const foreign = await createStaff(db(), tenantB.companyId);
    expect((await deactivate(foreign)).status).toBe(404);
    expect((await send('post', `/api/v1/employees/${randomUUID()}/deactivate`)).status).toBe(404);
  });
});
