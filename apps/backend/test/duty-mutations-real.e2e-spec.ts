/** Approved SP-12 HTTP/domain/audit contracts against verified disposable PG17. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types.js';
import { BusinessAuditService, type BusinessAuditAction, type BusinessAuditEntry } from '../src/modules/audit/business-audit.service.js';
import { ORIGIN, RecordingDelivery, bootEmployeesApp } from './helpers/employees-test-app.js';
import { openLocalTestPool, removeSyntheticTenants, type TestPool, type SyntheticSession } from './helpers/synthetic-tenants.js';
import { createStaff, insertDuty, insertMembership, insertPlan, planningState } from './helpers/planning-fixtures.js';
import { dutyMutationFixture, dutyPath, MUTATION_DAY, MUTATION_MONTH, MUTATION_NOW, type DutyMutationFixture } from './helpers/duty-mutation-fixtures.js';

// Fail after a real mandatory audit INSERT, forcing PostgreSQL to abort the transaction.
class FailedAudit extends BusinessAuditService {
  constructor(private readonly action: BusinessAuditAction) { super(); }
  override async recordBusinessAction(client: PoolClient, entry: BusinessAuditEntry): Promise<void> {
    await super.recordBusinessAction(client, entry);
    if (entry.action === this.action) await client.query('SELECT 1 / 0');
  }
}

let pool: TestPool;
let app: INestApplication<App> | undefined;
let f: DutyMutationFixture;
let token: string;
let previousOrigin: string | undefined;
const companies: string[] = [];

function write(method: 'post' | 'put' | 'patch' | 'delete', path = dutyPath(f), body?: unknown,
  options: { session?: SyntheticSession | null; token?: string | null; version?: string | null } = {}) {
  const session = options.session === undefined ? f.admin : options.session;
  const pending = request(app!.getHttpServer())[method](path).set('Origin', ORIGIN);
  if (session) pending.set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf);
  if (options.token !== null && (options.token ?? token)) pending.set('Edit-Lease-Token', options.token ?? token);
  if (options.version !== null) pending.set('Expected-Version', options.version ?? '1');
  return body === undefined ? pending : pending.send(body as object);
}
const get = () => request(app!.getHttpServer()).get(dutyPath(f)).set('Cookie', f.admin.cookie);
const lease = async (session = f.admin) => (await write('post', `${dutyPath(f)}/edit-lease`, undefined, { session }).expect(200)).body.leaseToken as string;
const outcome = (r: Response) => [r.status, r.body?.code ?? null];
const state = () => planningState(pool, f.tenant.companyId);
const events = async (response: Response) => (await pool.query(
  `SELECT action, resource_type, resource_id, actor_account_id, old_values, new_values
   FROM audit_event WHERE company_id = $1 AND correlation_id = $2 ORDER BY action, resource_id`,
  [f.tenant.companyId, response.headers['x-correlation-id']],
)).rows;
const D = (entry: Record<string, unknown>) => ({ planId: f.planId, dutyDate: entry.dutyDate, shiftKind: entry.shiftKind, startsAt: entry.startsAt, endsAt: entry.endsAt, version: entry.version });

async function boot(audit?: BusinessAuditService) {
  if (app) await app.close();
  app = await bootEmployeesApp(new RecordingDelivery(), { clock: () => new Date(MUTATION_NOW), ...(audit ? { audit } : {}) });
}
beforeAll(() => { pool = openLocalTestPool(8); previousOrigin = process.env.APP_ORIGIN; process.env.APP_ORIGIN = ORIGIN; });
beforeEach(async () => { f = await dutyMutationFixture(pool, companies); token = ''; await boot(); });
afterEach(async () => { await app?.close(); app = undefined; });
afterAll(async () => {
  try { await removeSyntheticTenants(pool, companies); } finally { await pool.end(); }
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previousOrigin;
});

describe('SP-12 — authenticated edit leases', () => {
  it('acquires a hash-only token for 120 seconds, renews it and rotates same-owner acquisition without advancing the duty', async () => {
    const before = (await get().expect(200)).body;
    token = await lease();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = (await pool.query(`SELECT octet_length(token_hash) AS bytes, encode(token_hash, 'hex') AS hash,
      extract(epoch FROM expires_at - acquired_at)::float AS ttl FROM edit_leases WHERE duty_id = $1`, [f.dutyId])).rows[0];
    expect(stored.bytes).toBe(32);
    expect(stored.hash).not.toContain(token);
    expect(stored.hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(stored.ttl).toBeCloseTo(120, 1);
    const renewed = await write('put', `${dutyPath(f)}/edit-lease`).expect(200);
    expect(Object.keys(renewed.body).sort()).toEqual(['expiresAt', 'leaseToken']);
    expect(renewed.body.leaseToken).toBe(token);
    expect(renewed.body.expiresAt).toMatch(/Z$/);
    expect(renewed.headers['cache-control']).toBe('no-store');
    const old = token;
    token = await lease();
    expect(token).not.toBe(old);
    expect(outcome(await write('delete', `${dutyPath(f)}/edit-lease`, undefined, { token: old }))).toEqual([409, 'EDIT_LEASE_NOT_HELD']);
    expect((await get().expect(200)).body).toEqual(before);
  });

  it('refuses another live owner, then permits takeover only after expiry', async () => {
    token = await lease();
    expect(outcome(await write('post', `${dutyPath(f)}/edit-lease`, undefined, { session: f.admin2 }))).toEqual([409, 'RESOURCE_EDIT_LOCKED']);
    await pool.query("UPDATE edit_leases SET acquired_at = clock_timestamp() - interval '180 seconds', expires_at = clock_timestamp() - interval '1 second' WHERE duty_id = $1", [f.dutyId]);
    const next = await lease(f.admin2);
    expect(outcome(await write('delete', `${dutyPath(f)}/edit-lease`))).toEqual([409, 'EDIT_LEASE_NOT_HELD']);
    expect(outcome(await write('patch', dutyPath(f), { dutyDate: '2027-01-21' }, { token: next }))).toEqual([409, 'EDIT_LEASE_NOT_HELD']);
    await write('delete', `${dutyPath(f)}/edit-lease`, undefined, { session: f.admin2, token: next }).expect(204);
  });

  it.each(['expired', 'released'] as const)('authenticates idempotent %s release, refuses arbitrary tokens and never mutates a second release', async (status) => {
    token = await lease();
    if (status === 'expired') await pool.query("UPDATE edit_leases SET acquired_at = clock_timestamp() - interval '180 seconds', expires_at = clock_timestamp() - interval '1 second' WHERE duty_id = $1", [f.dutyId]);
    if (status === 'released') await write('delete', `${dutyPath(f)}/edit-lease`).expect(204);
    const invalid = await write('delete', `${dutyPath(f)}/edit-lease`, undefined, { token: randomBytes(32).toString('base64url') });
    expect(outcome(invalid)).toEqual([409, 'EDIT_LEASE_NOT_HELD']);
    await write('delete', `${dutyPath(f)}/edit-lease`).expect(204);
    const before = await state();
    const repeated = await write('delete', `${dutyPath(f)}/edit-lease`).expect(204);
    expect(repeated.text).toBe('');
    expect(await state()).toEqual(before);
    expect(await events(repeated)).toEqual([]);
    expect(outcome(await write('put', `${dutyPath(f)}/edit-lease`))).toEqual([409, 'EDIT_LEASE_NOT_HELD']);
  });

  it.each(['missing row', 'wrong token', 'expired', 'released'] as const)('%s is rejected before a stale version, including a normalized no-op', async (reason) => {
    token = reason === 'missing row' ? randomBytes(32).toString('base64url') : await lease();
    if (reason === 'wrong token') token = randomBytes(32).toString('base64url');
    if (reason === 'expired') await pool.query("UPDATE edit_leases SET acquired_at = clock_timestamp() - interval '180 seconds', expires_at = clock_timestamp() - interval '1 second' WHERE duty_id = $1", [f.dutyId]);
    if (reason === 'released') await write('delete', `${dutyPath(f)}/edit-lease`).expect(204);
    const before = await state();
    const response = await write('patch', dutyPath(f), { dutyDate: MUTATION_DAY }, { version: '2' });
    expect(outcome(response)).toEqual([409, 'EDIT_LEASE_NOT_HELD']);
    expect(await events(response)).toEqual([]);
    expect(await state()).toEqual(before);
  });
});

describe('SP-12 — effective edits, audit and retained history', () => {
  it.each(['UNPUBLISHED', 'PUBLISHED'] as const)('edits a %s duty date/kind directly, with one version increment and exact bounded audit', async (status) => {
    if (status === 'PUBLISHED') await pool.query("UPDATE monthly_plans SET status = 'PUBLISHED', published_at = clock_timestamp(), published_by_account_id = $2 WHERE id = $1", [f.planId, f.tenant.admin.accountId]);
    token = await lease();
    const before = (await get().expect(200)).body;
    const planBefore = (await pool.query('SELECT * FROM monthly_plans WHERE id = $1', [f.planId])).rows;
    const result = await write('patch', dutyPath(f), { dutyDate: '2027-01-21', shiftKind: 'NIGHT' }).expect(200);
    expect(result.body).toMatchObject({ id: f.dutyId, dutyDate: '2027-01-21', shiftKind: 'NIGHT', startsAt: '2027-01-21T17:00:00Z', endsAt: '2027-01-22T05:00:00Z', version: 2 });
    expect(result.body.assignments).toEqual(before.assignments);
    expect(await events(result)).toEqual([{
      action: 'DUTY_UPDATED', resource_type: 'DUTY', resource_id: f.dutyId, actor_account_id: f.tenant.admin.accountId,
      old_values: D(before), new_values: D(result.body),
    }]);
    expect((await pool.query('SELECT * FROM monthly_plans WHERE id = $1', [f.planId])).rows).toEqual(planBefore);
    expect(outcome(await write('patch', dutyPath(f), { dutyDate: '2027-01-22' }))).toEqual([409, 'PLAN_CONCURRENT_MODIFICATION']);
  });

  it('role changes retain membership identity/source, additions use NORMAL, and a removed/rejoined member gets a new row', async () => {
    await pool.query("UPDATE plan_assignments SET source = 'REPLACEMENT' WHERE id = $1", [f.membership]);
    token = await lease();
    const before = (await get().expect(200)).body;
    const changed = await write('patch', dutyPath(f), { assignments: [
      { employeeId: f.jonas.employeeId, dutyRole: 'EMPLOYEE' }, { employeeId: f.mira.employeeId, dutyRole: 'SHIFT_LEAD' },
    ] }).expect(200);
    expect(changed.body).toMatchObject({ version: 2, startsAt: before.startsAt, endsAt: before.endsAt });
    expect(changed.body.assignments).toContainEqual({ id: f.membership, employeeId: f.mira.employeeId, dutyRole: 'SHIFT_LEAD', source: 'REPLACEMENT' });
    const audits = await events(changed);
    expect(audits.map((event) => event.action)).toEqual(['DUTY_MEMBERSHIP_ADDED', 'DUTY_MEMBERSHIP_UPDATED', 'DUTY_UPDATED']);
    const added = changed.body.assignments.find((member: { employeeId: string }) => member.employeeId === f.jonas.employeeId);
    expect(audits[0]).toMatchObject({ resource_type: 'DUTY_ASSIGNMENT', resource_id: added.id, old_values: null,
      new_values: { dutyId: f.dutyId, employeeId: f.jonas.employeeId, dutyRole: 'EMPLOYEE', source: 'NORMAL' } });
    expect(audits[1]).toMatchObject({ resource_type: 'DUTY_ASSIGNMENT', resource_id: f.membership,
      old_values: { dutyId: f.dutyId, employeeId: f.mira.employeeId, dutyRole: 'EMPLOYEE', source: 'REPLACEMENT' },
      new_values: { dutyId: f.dutyId, employeeId: f.mira.employeeId, dutyRole: 'SHIFT_LEAD', source: 'REPLACEMENT' } });
    const empty = await write('patch', dutyPath(f), { assignments: [] }, { version: '2' }).expect(200);
    expect(empty.body).toMatchObject({ assignments: [], version: 3 });
    const removed = (await events(empty)).filter((event) => event.action === 'DUTY_MEMBERSHIP_REMOVED');
    expect(removed).toHaveLength(2);
    for (const audit of removed) {
      const persisted = (await pool.query(`SELECT state, to_char(removed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS removed_at FROM plan_assignments WHERE id = $1`, [audit.resource_id])).rows[0];
      expect(audit.new_values).toEqual({ dutyId: f.dutyId, state: 'REMOVED', removedAt: persisted.removed_at });
      expect(persisted.state).toBe('REMOVED');
    }
    const rejoin = await write('patch', dutyPath(f), { assignments: [{ employeeId: f.mira.employeeId, dutyRole: 'EMPLOYEE' }] }, { version: '3' }).expect(200);
    expect(rejoin.body.assignments[0].id).not.toBe(f.membership);
    expect(rejoin.body.assignments[0].source).toBe('NORMAL');
    expect((await pool.query('SELECT count(*)::int AS count FROM plan_assignments WHERE duty_id = $1', [f.dutyId])).rows[0].count).toBe(3);
  });

  it('normalized no-op preserves every domain/lease timestamp and skips later eligibility conflicts', async () => {
    await insertMembership(pool, f.tenant.companyId, f.dutyId, f.jonas.employeeId);
    token = await lease();
    await pool.query("UPDATE employees SET status = 'DEACTIVATED' WHERE id = $1", [f.mira.employeeId]);
    await pool.query("UPDATE projects SET status = 'INACTIVE' WHERE id = $1", [f.project.projectId]);
    await pool.query("INSERT INTO employee_availability_days (company_id, employee_id, day, status) VALUES ($1, $2, $3, 'SICK')", [f.tenant.companyId, f.mira.employeeId, MUTATION_DAY]);
    const before = await state();
    const result = await write('patch', dutyPath(f), { dutyDate: MUTATION_DAY, shiftKind: 'DAY', assignments: [
      { employeeId: f.jonas.employeeId.toUpperCase(), dutyRole: 'EMPLOYEE' }, { employeeId: f.mira.employeeId.toUpperCase(), dutyRole: 'EMPLOYEE' },
    ] }).expect(200);
    expect(result.body.version).toBe(1);
    expect(result.body.availabilityConflicts).toHaveLength(1);
    expect(await state()).toEqual(before);
    expect(await events(result)).toEqual([]);
  });

  it('lease handoff to another Admin cannot overwrite the previous Admin using a stale version', async () => {
    token = await lease();
    await write('patch', dutyPath(f), { dutyDate: '2027-01-21' }).expect(200);
    await write('delete', `${dutyPath(f)}/edit-lease`).expect(204);
    const nextToken = await lease(f.admin2);
    const before = await state();
    const stale = await write('patch', dutyPath(f), { dutyDate: '2027-01-22' }, { session: f.admin2, token: nextToken });
    expect(outcome(stale)).toEqual([409, 'PLAN_CONCURRENT_MODIFICATION']);
    expect(await state()).toEqual(before); expect(await events(stale)).toEqual([]);
    const saved = await write('patch', dutyPath(f), { dutyDate: '2027-01-22' }, { session: f.admin2, token: nextToken, version: '2' }).expect(200);
    expect(saved.body.version).toBe(3);
  });

  it.each(['UNPUBLISHED', 'PUBLISHED'] as const)('removes a %s duty atomically, preserving snapshots/history, exact removal audit and concealed repeated 404', async (status) => {
    if (status === 'PUBLISHED') await pool.query("UPDATE monthly_plans SET status = 'PUBLISHED', published_at = clock_timestamp(), published_by_account_id = $2 WHERE id = $1", [f.planId, f.tenant.admin.accountId]);
    token = await lease();
    const before = (await get().expect(200)).body;
    const result = await write('delete').expect(204);
    expect(result.text).toBe('');
    const duty = (await pool.query(`SELECT concurrency_version::int AS version, starts_at, ends_at,
      to_char(removed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS removed_at FROM duties WHERE id = $1`, [f.dutyId])).rows[0];
    expect(duty.version).toBe(2);
    expect(duty.starts_at.toISOString()).toBe('2027-01-20T05:00:00.000Z');
    expect(duty.ends_at.toISOString()).toBe('2027-01-20T17:00:00.000Z');
    const audit = await events(result);
    expect(audit.find((event) => event.action === 'DUTY_REMOVED')).toMatchObject({ resource_type: 'DUTY', resource_id: f.dutyId, old_values: D(before), new_values: { version: 2, removedAt: duty.removed_at } });
    expect(audit.find((event) => event.action === 'DUTY_MEMBERSHIP_REMOVED')).toMatchObject({ resource_type: 'DUTY_ASSIGNMENT', resource_id: f.membership,
      old_values: { dutyId: f.dutyId, employeeId: f.mira.employeeId, dutyRole: 'EMPLOYEE', source: 'NORMAL' }, new_values: { dutyId: f.dutyId, state: 'REMOVED', removedAt: duty.removed_at } });
    expect(audit).toHaveLength(2);
    expect(outcome(await get())).toEqual([404, 'RESOURCE_NOT_FOUND']);
    const stable = await state();
    const repeated = await write('delete');
    expect(outcome(repeated)).toEqual([404, 'RESOURCE_NOT_FOUND']);
    expect(await events(repeated)).toEqual([]);
    expect(await state()).toEqual(stable);
    expect((await pool.query("SELECT count(*)::int AS count FROM plan_assignments WHERE duty_id = $1 AND state = 'ACTIVE'", [f.dutyId])).rows[0].count).toBe(0);
    // The tombstone frees the unique live slot; a new duty has a new ID.
    const created = await write('post', `/api/v1/monthly-plans/${f.planId}/entries`, { dutyDate: MUTATION_DAY, shiftKind: 'DAY' }).expect(201);
    expect(created.body.id).not.toBe(f.dutyId);
  });

  it('removal resolves inactive employee/project history without demanding fresh staffing eligibility', async () => {
    token = await lease();
    await pool.query("UPDATE employees SET status = 'DEACTIVATED' WHERE id = $1", [f.mira.employeeId]);
    await pool.query("UPDATE projects SET status = 'INACTIVE' WHERE id = $1", [f.project.projectId]);
    await write('delete').expect(204);
  });

  it.each([
    ['Europe/Berlin', '2027-03-27', '2027-03-27T17:00:00Z', '2027-03-28T04:00:00Z'],
    ['America/New_York', '2027-03-13', '2027-03-13T23:00:00Z', '2027-03-14T10:00:00Z'],
  ])('resolves an effective NIGHT edit across DST in %s', async (zone, day, startsAt, endsAt) => {
    await pool.query('UPDATE companies SET time_zone = $2 WHERE id = $1', [f.tenant.companyId, zone]);
    const plan = await insertPlan(pool, f.tenant.companyId, f.project.projectId, '2027-03-01');
    const path = `/api/v1/monthly-plans/${plan}/entries`;
    const duty = (await write('post', path, { dutyDate: day, shiftKind: 'DAY' }).expect(201)).body;
    const entryPath = `${path}/${duty.id}`;
    token = (await write('post', `${entryPath}/edit-lease`).expect(200)).body.leaseToken;
    const result = await write('patch', entryPath, { shiftKind: 'NIGHT' }).expect(200);
    expect(result.body).toMatchObject({ startsAt, endsAt, version: 2 });
    expect((Date.parse(endsAt) - Date.parse(startsAt)) / 3_600_000).toBe(11);
    const saved = (await pool.query('SELECT starts_at, ends_at FROM duties WHERE id = $1', [duty.id])).rows[0];
    expect(saved.starts_at.toISOString()).toBe(new Date(startsAt).toISOString());
    expect(saved.ends_at.toISOString()).toBe(new Date(endsAt).toISOString());
  });

  it('membership-only edits preserve UTC/provenance after a fixture timezone change', async () => {
    token = await lease();
    const query = 'SELECT starts_at, ends_at, time_zone, config_effective_from_month, start_local, end_local FROM duties WHERE id = $1';
    const before = (await pool.query(query, [f.dutyId])).rows;
    await pool.query("UPDATE companies SET time_zone = 'America/New_York' WHERE id = $1", [f.tenant.companyId]);
    await write('patch', dutyPath(f), { assignments: [{ employeeId: f.mira.employeeId, dutyRole: 'SHIFT_LEAD' }] }).expect(200);
    expect((await pool.query(query, [f.dutyId])).rows).toEqual(before);
  });

  it('membership removal frees D2 while the empty live duty still protects D3/D4 until explicit duty removal', async () => {
    token = await lease();
    await write('patch', dutyPath(f), { assignments: [] }).expect(200);
    await write('patch', `/api/v1/project-assignments/${f.assignment}`, { monthStart: '2027-02-01' }, { session: f.admin2 }).expect(200);
    const configuration = { effectiveFromMonth: MUTATION_MONTH, shifts: [{ shiftKind: 'DAY', startLocal: '07:00', endLocal: '19:00' }] };
    expect(outcome(await write('patch', `/api/v1/projects/${f.project.projectId}/shift-configuration`, configuration))).toEqual([409, 'SHIFT_CONFIGURATION_CONFLICT']);
    expect(outcome(await write('patch', `/api/v1/projects/${f.project.projectId}`, { status: 'INACTIVE' }))).toEqual([409, 'PROJECT_HAS_FUTURE_DUTIES']);
    await write('delete', dutyPath(f), undefined, { version: '2' }).expect(204);
    await write('patch', `/api/v1/projects/${f.project.projectId}/shift-configuration`, configuration).expect(200);
    await write('patch', `/api/v1/projects/${f.project.projectId}`, { status: 'INACTIVE' }).expect(200);
  });
});

describe('SP-12 — validation, authorization and whole-aggregate eligibility', () => {
  it.each([
    [{}, 'EMPTY_PATCH'], [{ dutyDate: null }, 'VALIDATION_FAILED'], [{ dutyDate: '2027-02-30' }, 'VALIDATION_FAILED'],
    [{ dutyDate: '2027-02-01' }, 'DUTY_DATE_OUTSIDE_PLAN_MONTH'], [{ shiftKind: 'TAG' }, 'VALIDATION_FAILED'],
    [{ assignments: [[]] }, 'VALIDATION_FAILED'], [{ assignments: null }, 'VALIDATION_FAILED'], [{ companyId: 'private-input' }, 'UNKNOWN_FIELD'],
  ])('rejects invalid input %j atomically with 400 %s', async (body, code) => {
    token = await lease();
    const before = await state();
    const result = await write('patch', dutyPath(f), body);
    expect(outcome(result)).toEqual([400, code]);
    expect(JSON.stringify(result.body)).not.toContain('private-input');
    expect(await state()).toEqual(before);
    expect(await events(result)).toEqual([]);
  });

  it('rejects duplicate employees, unknown nested fields and unsupported media types', async () => {
    token = await lease();
    const item = { employeeId: f.mira.employeeId, dutyRole: 'EMPLOYEE' };
    for (const body of [{ assignments: [item, { ...item, employeeId: f.mira.employeeId.toUpperCase() }] }, { assignments: [{ ...item, source: 'REPLACEMENT' }] }]) {
      expect((await write('patch', dutyPath(f), body)).status).toBe(400);
    }
    const response = await write('patch', dutyPath(f)).set('Content-Type', 'text/plain').send('private-input');
    expect(outcome(response)).toEqual([415, 'UNSUPPORTED_MEDIA_TYPE']);
  });

  it.each(['patch', 'delete'] as const)('%s requires canonical Expected-Version and Edit-Lease-Token headers', async (method) => {
    token = await lease();
    for (const version of [null, '0', '01', '-1', '1.0', '1e0', '9007199254740992', '1, 1']) {
      const result = await write(method, dutyPath(f), method === 'patch' ? { dutyDate: '2027-01-21' } : undefined, { version });
      expect(outcome(result)).toEqual([400, version === null ? 'EXPECTED_VERSION_REQUIRED' : 'INVALID_EXPECTED_VERSION']);
    }
    expect(outcome(await write(method, dutyPath(f), method === 'patch' ? { dutyDate: '2027-01-21' } : undefined, { token: null }))).toEqual([400, 'EDIT_LEASE_TOKEN_REQUIRED']);
  });

  it('a valid lease cannot bypass a stale no-op, and exhausted version space fails atomically as a technical error', async () => {
    token = await lease();
    const before = await state();
    expect(outcome(await write('patch', dutyPath(f), { dutyDate: MUTATION_DAY }, { version: '2' }))).toEqual([409, 'PLAN_CONCURRENT_MODIFICATION']);
    expect(await state()).toEqual(before);
    await pool.query('UPDATE duties SET concurrency_version = 9007199254740991 WHERE id=$1', [f.dutyId]);
    const full = await state();
    const result = await write('patch', dutyPath(f), { dutyDate: '2027-01-21' }, { version: '9007199254740991' });
    expect(outcome(result)).toEqual([500, 'INTERNAL_ERROR']); expect(await state()).toEqual(full); expect(await events(result)).toEqual([]);
  });

  it.each([
    ['inactive', "UPDATE employees SET status = 'DEACTIVATED' WHERE id = $1", 'EMPLOYEE_INACTIVE'],
    ['employment', "UPDATE employees SET employment_start = '2027-01-21' WHERE id = $1", 'EMPLOYEE_NOT_EMPLOYED_FOR_DAY'],
    ['assignment', 'DELETE FROM project_assignments WHERE employee_id = $1', 'EMPLOYEE_NOT_ASSIGNED_TO_PROJECT_MONTH'],
    ['shift', "UPDATE employees SET shift_eligibility = 'NACHT' WHERE id = $1", 'EMPLOYEE_NOT_ELIGIBLE_FOR_SHIFT'],
  ])('revalidates the unchanged resulting member against %s rules', async (_name, sql, code) => {
    token = await lease(); await pool.query(sql, [f.mira.employeeId]);
    const before = await state();
    const result = await write('patch', dutyPath(f), { assignments: [{ employeeId: f.mira.employeeId, dutyRole: 'SHIFT_LEAD' }] });
    expect(outcome(result)).toEqual([409, code]); expect(await state()).toEqual(before); expect(await events(result)).toEqual([]);
  });

  it.each(['SICK', 'LEAVE'])('refuses a resulting %s employee with a neutral conflict', async (status) => {
    token = await lease();
    await pool.query('INSERT INTO employee_availability_days (company_id, employee_id, day, status) VALUES ($1, $2, $3, $4)', [f.tenant.companyId, f.jonas.employeeId, MUTATION_DAY, status]);
    const result = await write('patch', dutyPath(f), { assignments: [{ employeeId: f.jonas.employeeId, dutyRole: 'EMPLOYEE' }] });
    expect(outcome(result)).toEqual([409, 'EMPLOYEE_UNAVAILABLE']);
    expect(JSON.stringify(result.body)).not.toMatch(/SICK|LEAVE/);
  });

  it('refuses overlaps with another duty while excluding itself from membership-only validation', async () => {
    token = await lease();
    await pool.query("UPDATE shift_configurations SET end_local = '07:00' WHERE project_id = $1 AND shift_kind = 'NACHT'", [f.project.projectId]);
    await write('post', `/api/v1/monthly-plans/${f.planId}/entries`, { dutyDate: '2027-01-19', shiftKind: 'NIGHT', assignments: [{ employeeId: f.jonas.employeeId, dutyRole: 'EMPLOYEE' }] }).expect(201);
    const result = await write('patch', dutyPath(f), { assignments: [{ employeeId: f.jonas.employeeId, dutyRole: 'EMPLOYEE' }] });
    expect(outcome(result)).toEqual([409, 'DUTY_ASSIGNMENT_CONFLICT']);
  });

  it('refuses a taken live slot and missing configuration without changing state', async () => {
    token = await lease();
    await insertDuty(pool, { companyId: f.tenant.companyId, projectId: f.project.projectId, planId: f.planId, month: MUTATION_MONTH, dutyDate: '2027-01-21', startsAt: '2027-01-21T05:00:00Z', endsAt: '2027-01-21T17:00:00Z' });
    expect(outcome(await write('patch', dutyPath(f), { dutyDate: '2027-01-21' }))).toEqual([409, 'DUTY_ALREADY_EXISTS']);
    await pool.query("DELETE FROM shift_configurations WHERE project_id = $1 AND shift_kind = 'NACHT'", [f.project.projectId]);
    expect(outcome(await write('patch', dutyPath(f), { shiftKind: 'NIGHT' }))).toEqual([409, 'SHIFT_CONFIGURATION_MISSING']);
  });

  it.each(['patch', 'delete', 'post', 'put', 'release'] as const)('%s enforces role, session, Origin and CSRF before business writes', async (operation) => {
    token = await lease();
    const method = operation === 'release' ? 'delete' : operation;
    const path = ['post', 'put', 'release'].includes(operation) ? `${dutyPath(f)}/edit-lease` : dutyPath(f);
    const body = operation === 'patch' ? { dutyDate: '2027-01-21' } : undefined;
    const before = await state();
    expect((await write(method, path, body, { session: null })).status).toBe(401);
    expect(outcome(await write(method, path, body, { session: f.employeeSession }))).toEqual([403, 'ACTION_FORBIDDEN']);
    expect(outcome(await write(method, path, body).set('Origin', 'https://foreign.invalid'))).toEqual([403, 'CSRF_VALIDATION_FAILED']);
    expect(outcome(await write(method, path, body).set('X-CSRF-Token', 'invalid'))).toEqual([403, 'CSRF_VALIDATION_FAILED']);
    expect(await state()).toEqual(before);
  });

  it.each(['patch', 'delete', 'post', 'put', 'release'] as const)('%s conceals unknown/foreign/mismatched/archived resources', async (operation) => {
    token = await lease();
    const method = operation === 'release' ? 'delete' : operation;
    const suffix = ['post', 'put', 'release'].includes(operation) ? '/edit-lease' : '';
    const body = operation === 'patch' ? { dutyDate: '2027-01-21' } : undefined;
    for (const url of [dutyPath(f, randomUUID()), dutyPath(f, f.dutyId, randomUUID()), dutyPath(f, 'invalid')]) {
      expect(outcome(await write(method, url + suffix, body))).toEqual([404, 'RESOURCE_NOT_FOUND']);
    }
    expect(outcome(await write(method, dutyPath(f) + suffix, body, { session: f.foreignAdmin }))).toEqual([404, 'RESOURCE_NOT_FOUND']);
    await pool.query("UPDATE projects SET status = 'ARCHIVED' WHERE id = $1", [f.project.projectId]);
    expect(outcome(await write(method, dutyPath(f) + suffix, body))).toEqual([404, 'RESOURCE_NOT_FOUND']);
  });

  it('conceals a submitted foreign employee and uses structural 400 before inactive-project business 409', async () => {
    token = await lease();
    const foreign = await createStaff(pool, f.foreign.companyId);
    expect(outcome(await write('patch', dutyPath(f), { assignments: [{ employeeId: foreign.employeeId, dutyRole: 'EMPLOYEE' }] }))).toEqual([404, 'RESOURCE_NOT_FOUND']);
    await pool.query("UPDATE projects SET status = 'INACTIVE' WHERE id = $1", [f.project.projectId]);
    expect(outcome(await write('patch', dutyPath(f), { dutyDate: '2027-02-01' }))).toEqual([400, 'DUTY_DATE_OUTSIDE_PLAN_MONTH']);
    expect(outcome(await write('patch', dutyPath(f), { dutyDate: '2027-02-01' }, { token: 'invalid' }))).toEqual([400, 'DUTY_DATE_OUTSIDE_PLAN_MONTH']);
    expect(outcome(await write('patch', dutyPath(f), { dutyDate: '2027-01-21' }))).toEqual([409, 'PROJECT_INACTIVE']);
  });
});

describe('SP-12 — mandatory audit failures', () => {
  it('a membership audit failure after DUTY_REMOVED rolls back the tombstone and lease retirement', async () => {
    token = await lease(); await boot(new FailedAudit('DUTY_MEMBERSHIP_REMOVED'));
    const before = await state();
    const result = await write('delete');
    expect(outcome(result)).toEqual([500, 'INTERNAL_ERROR']);
    expect(await state()).toEqual(before); expect(await events(result)).toEqual([]);
  });
  it.each(['DUTY_UPDATED', 'DUTY_MEMBERSHIP_ADDED', 'DUTY_MEMBERSHIP_UPDATED', 'DUTY_MEMBERSHIP_REMOVED', 'DUTY_REMOVED'] as const)('%s failure rolls back all domain, version, lease and earlier audit changes', async (action) => {
    token = await lease();
    await boot(new FailedAudit(action));
    const before = await state();
    const body = action === 'DUTY_MEMBERSHIP_ADDED' ? { assignments: [{ employeeId: f.jonas.employeeId, dutyRole: 'EMPLOYEE' }] }
      : action === 'DUTY_MEMBERSHIP_REMOVED' ? { assignments: [] } : { assignments: [{ employeeId: f.mira.employeeId, dutyRole: 'SHIFT_LEAD' }] };
    const result = await write(action === 'DUTY_REMOVED' ? 'delete' : 'patch', dutyPath(f), action === 'DUTY_REMOVED' ? undefined : body);
    expect(outcome(result)).toEqual([500, 'INTERNAL_ERROR']);
    expect(result.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(result.body.correlationId).toBe(result.headers['x-correlation-id']);
    expect(JSON.stringify(result.body)).not.toMatch(/SELECT|division|22012|token_hash|stack/);
    expect(await state()).toEqual(before);
    expect(await events(result)).toEqual([]);
  });
});

describe('SP-12 — database integrity', () => {
  it.each(['foreign owner', 'foreign duty', 'missing duty', 'bad hash'] as const)('composite foreign keys and token constraints reject %s', async (probe) => {
    const companyId = probe === 'foreign duty' ? f.foreign.companyId : f.tenant.companyId;
    const owner = probe === 'foreign owner' || probe === 'foreign duty' ? f.foreign.admin.accountId : f.tenant.admin.accountId;
    const id = probe === 'missing duty' ? randomUUID() : f.dutyId;
    const hash = Buffer.alloc(probe === 'bad hash' ? 31 : 32, 1);
    await expect(pool.query(`INSERT INTO edit_leases(company_id,duty_id,owner_account_id,token_hash,expires_at)
      VALUES($1,$2,$3,$4,clock_timestamp()+interval '120 seconds')`, [companyId,id,owner,hash]))
      .rejects.toMatchObject({ code: probe === 'bad hash' ? '23514' : '23503' });
    expect((await state()).leases).toEqual([]);
  });

  it('one lease slot per duty and retained FK history prevent accidental hard deletion', async () => {
    token = await lease();
    await expect(pool.query(`INSERT INTO edit_leases(company_id,duty_id,owner_account_id,token_hash,expires_at)
      VALUES($1,$2,$3,$4,clock_timestamp()+interval '120 seconds')`, [f.tenant.companyId,f.dutyId,f.tenant.admin.accountId,Buffer.alloc(32,1)]))
      .rejects.toMatchObject({ code: '23505' });
    await expect(pool.query('DELETE FROM duties WHERE company_id=$1 AND id=$2', [f.tenant.companyId,f.dutyId])).rejects.toMatchObject({ code: '23503' });
    await write('delete').expect(204);
    expect((await state()).leases).toHaveLength(1);
    expect((await state()).members).toHaveLength(1);
  });
});
