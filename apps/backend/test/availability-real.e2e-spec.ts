/** A01-A43: approved SP-10 behavior on independently verified disposable PostgreSQL. */
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import request from 'supertest';
import { vi } from 'vitest';
import { DatabaseService } from '../src/database/database.service.js';
import { AvailabilityService } from '../src/modules/workforce/availability/availability.service.js';
import { BusinessAuditService, type BusinessAuditEntry } from '../src/modules/audit/business-audit.service.js';
import { createSyntheticAccount, createSyntheticEmployee, createSyntheticSession, createSyntheticTenant, openLocalTestPool,
  realSessionService, removeSyntheticTenants, type SyntheticTenant, type SyntheticEmployee,
  type SyntheticSession, type TestPool } from './helpers/synthetic-tenants.js';
import { bootEmployeesApp, RecordingDelivery, ORIGIN } from './helpers/employees-test-app.js';

let pool: TestPool; let app: INestApplication<App>; let tenant: SyntheticTenant;
let employee: SyntheticEmployee; let admin: SyntheticSession; let instant: string;
const companies: string[] = []; const clock = vi.fn(() => new Date(instant));
let previousOrigin: string | undefined;
type Input = { operation: string; fromDate: string; toDate: string; status?: string; conflictPolicy?: string };
const selection = (extra: Partial<Input> = {}): Input => ({ operation: 'SET', fromDate: '2026-10-28', toDate: '2026-10-29', status: 'SICK', ...extra });
const path = (id = employee.employeeId) => `/api/v1/employees/${id}/availability`;
function post(suffix: string, body: object, key?: string, session = admin, id = employee.employeeId) {
  let call = request(app.getHttpServer()).post(`${path(id)}/${suffix}`).set('Origin', ORIGIN)
    .set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf);
  if (key !== undefined) call = call.set('Idempotency-Key', key);
  return call.send(body);
}
async function preview(input = selection(), id = employee.employeeId) { return post('preview', input, undefined, admin, id); }
async function commit(input = selection(), confirmation?: string, key = randomUUID()) {
  const shown = await preview(input); expect(shown.status).toBe(200);
  return post('batch', { ...input, previewToken: shown.body.previewToken, ...(confirmation ? { confirmation } : {}) }, key);
}
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const table of ['employees', 'employee_availability_days', 'audit_event']) {
    result[table] = (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE company_id = $1 ORDER BY id`, [tenant.companyId])).rows;
  }
  return result;
}
async function audits() { return (await pool.query(`SELECT action, resource_type, resource_id, old_values, new_values,
  actor_account_id, company_id, correlation_id FROM audit_event WHERE company_id = $1 ORDER BY occurred_at, id`, [tenant.companyId])).rows; }
async function revision() { return (await pool.query('SELECT availability_revision::text AS v FROM employees WHERE id = $1', [employee.employeeId])).rows[0].v; }
async function seed(day: string, status: string | null = 'SICK') {
  await pool.query('INSERT INTO employee_availability_days (company_id, employee_id, day, status) VALUES ($1,$2,$3::date,$4)', [tenant.companyId, employee.employeeId, day, status]);
}
async function rawCommit(body: object, headerLines: string[]) {
  const server = app.getHttpServer() as unknown as Server;
  if (!server.listening) await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo; const json = JSON.stringify(body);
  const bytes = [`POST ${path()}/batch HTTP/1.1`, `Host: 127.0.0.1:${port}`, `Origin: ${ORIGIN}`,
    `Cookie: ${admin.cookie}`, `X-CSRF-Token: ${admin.csrf}`, 'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(json)}`, ...headerLines, 'Connection: close', '', json].join('\r\n');
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1'); const chunks: Buffer[] = [];
    socket.setTimeout(4000, () => socket.destroy(new Error('Raw HTTP test timeout')));
    socket.on('connect', () => socket.write(bytes, 'latin1')); socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('latin1'))); socket.on('error', reject);
  });
}
function problem(response: request.Response, status: number, code: string) {
  expect(response.status).toBe(status); expect(response.body.code).toBe(code);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['content-type']).toContain('application/problem+json');
}
beforeAll(() => { pool = openLocalTestPool(10); previousOrigin = process.env.APP_ORIGIN; process.env.APP_ORIGIN = ORIGIN; });
beforeEach(async () => {
  instant = '2026-10-30T12:00:00Z';
  tenant = await createSyntheticTenant(pool, 'SP10'); companies.push(tenant.companyId);
  employee = await createSyntheticEmployee(pool, tenant.employee, 'SP10', { start: '2020-01-01' });
  admin = await createSyntheticSession(realSessionService(pool), tenant.admin);
  app = await bootEmployeesApp(new RecordingDelivery(), { clock });
});
afterEach(async () => { vi.restoreAllMocks(); await app?.close(); await removeSyntheticTenants(pool, companies.splice(0)); });
afterAll(async () => { await pool?.end(); if (previousOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previousOrigin; });

describe('SP-10 atomic date operations and audit', () => {
  it('inserts, replays and true-no-ops without changing timestamps/revision/audit', async () => {
    const input = selection(); const shown = await preview(input); const key = randomUUID();
    expect(shown.body.days.map((d: { effect: string }) => d.effect)).toEqual(['CREATE', 'CREATE']);
    const body = { ...input, previewToken: shown.body.previewToken };
    const saved = await post('batch', body, key);
    expect(saved.status).toBe(200); expect(saved.body).toEqual({ employeeId: employee.employeeId, changedDayCount: 2, unchangedDayCount: 0 });
    expect(saved.headers['idempotency-replayed']).toBe('false');
    expect((await pool.query('SELECT extract(epoch FROM expires_at-completed_at)::numeric AS seconds FROM availability_batch_commands WHERE employee_id=$1', [employee.employeeId])).rows[0].seconds).toBe('86400.000000');
    const state = await snapshot(); expect(await revision()).toBe('1');
    const replay = await post('batch', body, key);
    expect(replay.status).toBe(200); expect(replay.body).toEqual(saved.body); expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.headers['x-correlation-id']).not.toBe(saved.headers['x-correlation-id']);
    const noop = await commit(input); expect(noop.body.changedDayCount).toBe(0); expect(noop.body.unchangedDayCount).toBe(2);
    expect(await snapshot()).toEqual(state);
    const events = await audits(); expect(events).toHaveLength(2);
    expect(events.every((e) => e.action === 'EMPLOYEE_AVAILABILITY_SET' && e.resource_type === 'EMPLOYEE_AVAILABILITY' &&
      e.resource_id === employee.employeeId && e.actor_account_id === tenant.admin.accountId && e.company_id === tenant.companyId &&
      e.old_values === null && Object.keys(e.new_values).join() === 'day' && e.correlation_id === saved.headers['x-correlation-id'])).toBe(true);
  });
  it('rejects the complete mixed batch by default; fresh explicit REPLACE changes only different/absent days', async () => {
    await seed('2026-10-28'); await seed('2026-10-29', 'LEAVE');
    const input = selection({ toDate: '2026-10-30' }); const state = await snapshot();
    const shown = await preview(input); expect(shown.body.canCommit).toBe(false);
    expect(shown.body.days.map((d: { effect: string }) => d.effect)).toEqual(['UNCHANGED', 'CONFLICT', 'CREATE']);
    problem(await post('batch', { ...input, previewToken: shown.body.previewToken }, randomUUID()), 409, 'AVAILABILITY_STATUS_CONFLICT');
    expect(await snapshot()).toEqual(state);
    const replacing = { ...input, conflictPolicy: 'REPLACE' }; const replacement = await preview(replacing);
    problem(await post('batch', { ...replacing, previewToken: replacement.body.previewToken }, randomUUID()), 400, 'INVALID_FIELD_COMBINATION');
    problem(await post('batch', { ...replacing, previewToken: replacement.body.previewToken, confirmation: 'CLEAR' }, randomUUID()), 400, 'INVALID_FIELD_COMBINATION');
    const saved = await post('batch', { ...replacing, previewToken: replacement.body.previewToken, confirmation: 'REPLACE' }, randomUUID());
    expect(saved.body).toMatchObject({ changedDayCount: 2, unchangedDayCount: 1 });
    const events = await audits(); expect(events).toHaveLength(2);
    expect(events.find((e) => e.old_values !== null)).toMatchObject({ old_values: { day: '2026-10-29' }, new_values: { day: '2026-10-29' } });
  });
  it('confirmed CLEAR removes erroneous facts without employment evidence and treats missing days as no-ops', async () => {
    await seed('2026-10-29');
    await pool.query("UPDATE employees SET status='DEACTIVATED', employment_start=NULL, employment_end=NULL WHERE id=$1", [employee.employeeId]);
    const input = { operation: 'CLEAR', fromDate: '2026-10-28', toDate: '2026-10-30' };
    const shown = await preview(input); const before = await snapshot();
    problem(await post('batch', { ...input, previewToken: shown.body.previewToken }, randomUUID()), 400, 'INVALID_FIELD_COMBINATION');
    problem(await post('batch', { ...input, previewToken: shown.body.previewToken, confirmation: 'REPLACE' }, randomUUID()), 400, 'INVALID_FIELD_COMBINATION');
    expect(await snapshot()).toEqual(before);
    const saved = await commit(input, 'CLEAR'); expect(saved.body).toMatchObject({ changedDayCount: 1, unchangedDayCount: 2 });
    expect(await audits()).toMatchObject([{ action: 'EMPLOYEE_AVAILABILITY_CLEARED', old_values: { day: '2026-10-29' }, new_values: null }]);
    const after = await snapshot(); await commit(input, 'CLEAR'); expect(await snapshot()).toEqual(after);
  });
  it.each([
    ['2026-10-01', '2027-01-01', 200, 93], ['2026-10-01', '2027-01-02', 400, 0],
    ['2028-02-28', '2028-03-01', 200, 3], ['2026-12-31', '2027-01-01', 200, 2],
    ['2026-10-30', '2026-10-29', 400, 0],
  ])('range %s through %s -> %s', async (fromDate, toDate, expected, count) => {
    const input = selection({ fromDate: String(fromDate), toDate: String(toDate) });
    const shown = await preview(input); expect(shown.status).toBe(expected);
    if (expected === 200) { expect(shown.body.days).toHaveLength(count); expect((await commit(input)).body.changedDayCount).toBe(count); }
    else { expect(shown.body.code).toBe('AVAILABILITY_RANGE_INVALID'); expect(await revision()).toBe('0'); }
  });
  it('monthly read is bounded, sorted and contains no command internals', async () => {
    await seed('2026-10-29', 'LEAVE'); await seed('2026-10-28'); await seed('2026-11-01');
    const res = await request(app.getHttpServer()).get(`${path()}?monthStart=2026-10-01`).set('Cookie', admin.cookie);
    expect(res.status).toBe(200); expect(res.body).toEqual({ items: [
      { employeeId: employee.employeeId, day: '2026-10-28', status: 'SICK' },
      { employeeId: employee.employeeId, day: '2026-10-29', status: 'LEAVE' }] });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('SP-10 lifecycle and transport/privacy boundaries', () => {
  it.each([
    ['ACTIVE', '2026-10-28', '2026-10-29', '2026-10-28', '2026-10-29', 200, ''],
    ['ACTIVE', null, null, '2026-10-28', '2026-10-29', 409, 'EMPLOYEE_NOT_EMPLOYED_FOR_DAY'],
    ['ACTIVE', '2026-10-29', null, '2026-10-28', '2026-10-29', 409, 'EMPLOYEE_NOT_EMPLOYED_FOR_DAY'],
    ['ACTIVE', '2026-10-28', '2026-10-28', '2026-10-28', '2026-10-29', 409, 'EMPLOYEE_NOT_EMPLOYED_FOR_DAY'],
    ['DEACTIVATED', '2020-01-01', null, '2026-10-29', '2026-10-29', 200, ''],
    ['DEACTIVATED', '2020-01-01', null, '2026-10-30', '2026-10-30', 409, 'EMPLOYEE_INACTIVE'],
    ['DEACTIVATED', '2020-01-01', null, '2026-10-31', '2026-10-31', 409, 'EMPLOYEE_INACTIVE'],
  ])('%s employment %s / %s range %s %s', async (status, start, end, from, to, expected, code) => {
    await pool.query('UPDATE employees SET status=$2, employment_start=$3::date, employment_end=$4::date WHERE id=$1', [employee.employeeId, status, start, end]);
    const res = await preview(selection({ fromDate: from!, toDate: to! }));
    if (expected === 200) expect(res.status).toBe(200); else problem(res, Number(expected), code!);
    expect(await audits()).toEqual([]);
  });
  it.each([
    ['Europe/Berlin', '2026-10-30T23:30:00Z', 200],
    ['America/New_York', '2026-10-30T02:00:00Z', 409],
  ])('uses company-local day in %s at %s', async (zone, at, expected) => {
    instant = at;
    await pool.query('UPDATE companies SET time_zone=$2 WHERE id=$1', [tenant.companyId, zone]);
    await pool.query("UPDATE employees SET status='DEACTIVATED' WHERE id=$1", [employee.employeeId]);
    expect((await preview(selection({ fromDate: '2026-10-30', toDate: '2026-10-30' }))).status).toBe(expected);
  });
  it('fails closed on invalid company zone', async () => {
    await pool.query("UPDATE companies SET time_zone='invalid-zone' WHERE id=$1", [tenant.companyId]);
    const res = await preview(); problem(res, 500, 'INTERNAL_ERROR'); expect(JSON.stringify(res.body)).not.toContain('invalid-zone');
  });
  it.each(['companyId', 'actorAccountId', 'diagnosis', 'symptoms', 'reason', 'medicalText'])('rejects unknown %s without reflection', async (field) => {
    const res = await post('preview', { ...selection(), [field]: 'private-medical-value' });
    problem(res, 400, 'UNKNOWN_FIELD'); expect(JSON.stringify(res.body)).not.toContain('private-medical-value'); expect(await audits()).toEqual([]);
  });
  it.each([{ status: 'KRANK' }, { status: null }, { status: undefined }, { status: 'URLAUB' }, { fromDate: '2027-02-29' },
    { fromDate: '0000-01-01' }, { toDate: '2026-10-29T00:00:00Z' }, { conflictPolicy: null }])('rejects invalid DTO %j', async (change) => {
    problem(await post('preview', { ...selection(), ...change }), 400, 'VALIDATION_FAILED');
  });
  it.each(['', '?monthStart=2026-10-02', '?monthStart=bad', '?monthStart=2026-10-01&companyId=foreign'])('rejects month query %s', async (query) => {
    expect((await request(app.getHttpServer()).get(`${path()}${query}`).set('Cookie', admin.cookie)).status).toBe(400);
  });
  it('conceals foreign/unknown employees and denies employee mutation/read', async () => {
    const other = await createSyntheticTenant(pool, 'SP10 foreign'); companies.push(other.companyId);
    const foreign = await createSyntheticEmployee(pool, other.employee);
    for (const id of [randomUUID(), foreign.employeeId, 'not-a-uuid']) problem(await preview(selection(), id), 404, 'RESOURCE_NOT_FOUND');
    const session = await createSyntheticSession(realSessionService(pool), tenant.employee);
    problem(await post('preview', selection(), undefined, session), 403, 'ACTION_FORBIDDEN');
    problem(await request(app.getHttpServer()).get(`${path()}?monthStart=2026-10-01`).set('Cookie', session.cookie), 403, 'ACTION_FORBIDDEN');
  });
  it('requires Origin, CSRF and session; unsafe requests cannot reach facts', async () => {
    const before = await snapshot();
    expect((await request(app.getHttpServer()).post(`${path()}/preview`).send(selection())).status).toBe(403);
    expect((await request(app.getHttpServer()).post(`${path()}/preview`).set('Origin', ORIGIN).send(selection())).status).toBe(401);
    expect((await request(app.getHttpServer()).post(`${path()}/preview`).set('Origin', ORIGIN).set('Cookie', admin.cookie).send(selection())).status).toBe(403);
    expect(await snapshot()).toEqual(before);
  });
});

describe('SP-10 freshness, replay and full rollback', () => {
  it('rejects token/selection tampering and forbidden confirmation without consuming the original preview', async () => {
    const shown = await preview(); const body = { ...selection(), previewToken: shown.body.previewToken }; const before = await snapshot();
    for (const changed of [
      { ...body, previewToken: 'x'.repeat(43) }, { ...body, status: 'LEAVE' },
      { ...body, fromDate: '2026-10-29' }, { ...body, toDate: '2026-10-30' },
      { ...body, conflictPolicy: 'REPLACE', confirmation: 'REPLACE' },
      { operation: 'CLEAR', fromDate: body.fromDate, toDate: body.toDate, previewToken: body.previewToken, confirmation: 'CLEAR' },
    ]) problem(await post('batch', changed, randomUUID()), 409, 'AVAILABILITY_PREVIEW_STALE');
    problem(await post('batch', { ...body, previewToken: undefined }, randomUUID()), 400, 'VALIDATION_FAILED');
    problem(await post('batch', { ...body, previewToken: 'bad' }, randomUUID()), 400, 'VALIDATION_FAILED');
    problem(await post('batch', { ...body, confirmation: 'REPLACE' }, randomUUID()), 400, 'INVALID_FIELD_COMBINATION');
    expect(await snapshot()).toEqual(before); expect((await post('batch', body, randomUUID())).status).toBe(200);
  });
  it('creates exactly ten minutes of database preview authority and rejects the expiry boundary', async () => {
    const shown = await preview();
    const row = (await pool.query('SELECT extract(epoch FROM preview_expires_at-created_at)::int AS seconds FROM availability_batch_commands WHERE employee_id=$1', [employee.employeeId])).rows[0];
    expect(row.seconds).toBe(600); const before = await snapshot();
    await pool.query('UPDATE availability_batch_commands SET preview_expires_at=clock_timestamp(), expires_at=clock_timestamp() WHERE employee_id=$1', [employee.employeeId]);
    problem(await post('batch', { ...selection(), previewToken: shown.body.previewToken }, randomUUID()), 409, 'AVAILABILITY_PREVIEW_STALE');
    expect(await snapshot()).toEqual(before);
  });
  it('binds previews to another administrator and employee without disclosing ownership', async () => {
    const shown = await preview(); const body = { ...selection(), previewToken: shown.body.previewToken };
    const secondAdmin = await createSyntheticAccount(pool, tenant.companyId, 'COMPANY_ADMIN');
    const other = await createSyntheticSession(realSessionService(pool), secondAdmin);
    const another = await createSyntheticEmployee(pool, await createSyntheticAccount(pool, tenant.companyId, 'EMPLOYEE'), 'SP10 second', { start: '2020-01-01' });
    problem(await post('batch', body, randomUUID(), other), 409, 'AVAILABILITY_PREVIEW_STALE');
    problem(await post('batch', body, randomUUID(), admin, another.employeeId), 409, 'AVAILABILITY_PREVIEW_STALE');
    expect(await revision()).toBe('0'); expect(await audits()).toEqual([]);
  });
  it('normalizes omitted REJECT and JSON order for replay; a changed token or confirmation mismatches', async () => {
    const shown = await preview(); const body = { ...selection(), previewToken: shown.body.previewToken }; const key = randomUUID();
    expect((await post('batch', body, key)).status).toBe(200);
    const reordered = { previewToken: body.previewToken, conflictPolicy: 'REJECT', status: 'SICK', toDate: body.toDate, fromDate: body.fromDate, operation: 'SET' };
    expect((await post('batch', reordered, key)).headers['idempotency-replayed']).toBe('true');
    const next = await preview();
    problem(await post('batch', { ...body, previewToken: next.body.previewToken }, key), 409, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST');
    problem(await post('batch', { ...body, confirmation: 'REPLACE' }, key), 409, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST');
  });
  it('does not reuse a consumed no-op preview, while a separate no-op preserves another preview', async () => {
    await commit(); const before = await snapshot(); const old = await preview();
    const same = await preview(); const body = { ...selection(), previewToken: same.body.previewToken };
    expect((await post('batch', body, randomUUID())).body).toMatchObject({ changedDayCount: 0, unchangedDayCount: 2 });
    problem(await post('batch', body, randomUUID()), 409, 'AVAILABILITY_PREVIEW_STALE');
    expect((await post('batch', { ...selection(), previewToken: old.body.previewToken }, randomUUID())).status).toBe(200);
    expect(await snapshot()).toEqual(before);
  });
  it('detects status ABA and effective changes outside the selected range', async () => {
    await commit(); const old = await preview();
    await commit(selection({ status: 'LEAVE', conflictPolicy: 'REPLACE' }), 'REPLACE');
    await commit(selection({ conflictPolicy: 'REPLACE' }), 'REPLACE');
    problem(await post('batch', { ...selection(), previewToken: old.body.previewToken }, randomUUID()), 409, 'AVAILABILITY_PREVIEW_STALE');
    const recent = await preview(); await commit(selection({ fromDate: '2026-11-02', toDate: '2026-11-02' }));
    problem(await post('batch', { ...selection(), previewToken: recent.body.previewToken }, randomUUID()), 409, 'AVAILABILITY_PREVIEW_STALE');
  });
  it.each(['downgrade', 'revoke', 'expire'] as const)('fresh authorization prevents replay after %s', async (change) => {
    const shown = await preview(); const body = { ...selection(), previewToken: shown.body.previewToken }; const key = randomUUID();
    expect((await post('batch', body, key)).status).toBe(200); const before = await snapshot();
    if (change === 'downgrade') await pool.query("UPDATE accounts SET role='EMPLOYEE' WHERE id=$1", [tenant.admin.accountId]);
    else if (change === 'revoke') await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE account_id=$1', [tenant.admin.accountId]);
    else await pool.query(`UPDATE sessions SET created_at=clock_timestamp()-INTERVAL '2 hours',
      absolute_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE account_id=$1`, [tenant.admin.accountId]);
    const res = await post('batch', body, key);
    expect([401, 403]).toContain(res.status); expect(res.body).not.toHaveProperty('changedDayCount'); expect(await snapshot()).toEqual(before);
  });
  it('expired completed result cannot replay before or after bounded cleanup', async () => {
    const shown = await preview(); const body = { ...selection(), previewToken: shown.body.previewToken }; const key = randomUUID();
    expect((await post('batch', body, key)).status).toBe(200); const before = await snapshot();
    await pool.query(`UPDATE availability_batch_commands SET created_at=clock_timestamp()-INTERVAL '26 hours',
      completed_at=clock_timestamp()-INTERVAL '25 hours', preview_expires_at=clock_timestamp()-INTERVAL '25 hours',
      expires_at=clock_timestamp()-INTERVAL '1 hour' WHERE employee_id=$1`, [employee.employeeId]);
    problem(await post('batch', body, key), 409, 'AVAILABILITY_PREVIEW_STALE');
    const context = { companyId: tenant.companyId, accountId: tenant.admin.accountId, sessionId: randomUUID(), role: 'COMPANY_ADMIN' as const };
    expect(await app.get(AvailabilityService).pruneExpired(context)).toBe(1);
    problem(await post('batch', body, key), 409, 'AVAILABILITY_PREVIEW_STALE'); expect(await snapshot()).toEqual(before);
  });
  it('bounded cleanup skips locked/active rows, is tenant scoped and leaves business/audit unchanged', async () => {
    await commit(); for (let n = 0; n < 4; n++) expect((await preview()).status).toBe(200);
    await pool.query(`UPDATE availability_batch_commands SET created_at=clock_timestamp()-INTERVAL '20 minutes',
      preview_expires_at=clock_timestamp()-INTERVAL '10 minutes', expires_at=clock_timestamp()-INTERVAL '10 minutes'
      WHERE employee_id=$1 AND state='PREVIEWED'`, [employee.employeeId]);
    const before = await snapshot(); const holder = await pool.connect();
    const context = { companyId: tenant.companyId, accountId: tenant.admin.accountId, sessionId: randomUUID(), role: 'COMPANY_ADMIN' as const };
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT id FROM availability_batch_commands WHERE employee_id=$1 AND state='PREVIEWED' ORDER BY expires_at,id LIMIT 1 FOR UPDATE", [employee.employeeId]);
      expect(await app.get(AvailabilityService).pruneExpired(context, 2)).toBe(2);
      expect(await app.get(AvailabilityService).pruneExpired(context, 2)).toBe(1);
      expect(await app.get(AvailabilityService).pruneExpired(context, 2)).toBe(0);
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    expect(await app.get(AvailabilityService).pruneExpired(context, 2)).toBe(1);
    expect((await pool.query('SELECT state FROM availability_batch_commands WHERE employee_id=$1', [employee.employeeId])).rows).toEqual([{ state: 'COMPLETED' }]);
    expect(await snapshot()).toEqual(before);
  });
  it.each([[], ['Idempotency-Key: short'], ['Idempotency-Key: abcdefgh', 'idempotency-key: abcdefgh'],
    ['Idempotency-Key: abcdefgh', 'Idempotency-Key: different-key']].map((lines) => ({ lines })))('validates raw header lines $lines before business effects', async ({ lines }) => {
    const shown = await preview(); const before = await snapshot();
    const raw = await rawCommit({ ...selection(), previewToken: shown.body.previewToken }, lines);
    expect(raw).toMatch(/^HTTP\/1\.1 400 /);
    expect(raw).toContain(lines.length ? '"code":"IDEMPOTENCY_KEY_INVALID"' : '"code":"IDEMPOTENCY_KEY_REQUIRED"');
    expect(await snapshot()).toEqual(before);
  });
  it('binds token to request/employee/actor; same consumed token and new key is stale', async () => {
    const input = selection(); const shown = await preview(); const body = { ...input, previewToken: shown.body.previewToken };
    problem(await post('batch', { ...body, status: 'LEAVE' }, randomUUID()), 409, 'AVAILABILITY_PREVIEW_STALE');
    const other = await createSyntheticSession(realSessionService(pool), tenant.employee);
    problem(await post('batch', body, randomUUID(), other), 403, 'ACTION_FORBIDDEN');
    expect((await post('batch', body, randomUUID())).status).toBe(200);
    problem(await post('batch', body, randomUUID()), 409, 'AVAILABILITY_PREVIEW_STALE');
  });
  it('detects empty -> SET -> CLEAR ABA and company-local midnight change', async () => {
    const input = selection(); const old = await preview();
    await commit(input); await commit({ operation: 'CLEAR', fromDate: input.fromDate, toDate: input.toDate }, 'CLEAR');
    problem(await post('batch', { ...input, previewToken: old.body.previewToken }, randomUUID()), 409, 'AVAILABILITY_PREVIEW_STALE');
    const recent = await preview(); instant = '2026-10-31T12:00:00Z';
    problem(await post('batch', { ...input, previewToken: recent.body.previewToken }, randomUUID()), 409, 'AVAILABILITY_PREVIEW_STALE');
  });
  it('rejects expired preview, but replays committed success after preview expiry and lifecycle changes', async () => {
    const input = selection(); const old = await preview();
    await pool.query(`UPDATE availability_batch_commands SET created_at=clock_timestamp()-INTERVAL '20 minutes',
      preview_expires_at=clock_timestamp()-INTERVAL '10 minutes', expires_at=clock_timestamp()-INTERVAL '10 minutes' WHERE employee_id=$1`, [employee.employeeId]);
    problem(await post('batch', { ...input, previewToken: old.body.previewToken }, randomUUID()), 409, 'AVAILABILITY_PREVIEW_STALE');
    const fresh = await preview(); const body = { ...input, previewToken: fresh.body.previewToken }; const key = randomUUID();
    const saved = await post('batch', body, key); expect(saved.status).toBe(200);
    await pool.query(`UPDATE availability_batch_commands SET created_at=clock_timestamp()-INTERVAL '20 minutes',
      preview_expires_at=clock_timestamp()-INTERVAL '10 minutes' WHERE employee_id=$1`, [employee.employeeId]);
    await pool.query("UPDATE employees SET status='DEACTIVATED', availability_revision=availability_revision+1 WHERE id=$1", [employee.employeeId]);
    expect((await post('batch', body, key)).body).toEqual(saved.body);
    problem(await post('batch', { ...body, status: 'LEAVE' }, key), 409, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST');
  });
  it('invalidates previews on relevant employment edits including ABA; no-op retains revision', async () => {
    const shown = await preview();
    const patch = (body: object) => request(app.getHttpServer()).patch(`/api/v1/employees/${employee.employeeId}`)
      .set('Cookie', admin.cookie).set('Origin', ORIGIN).set('X-CSRF-Token', admin.csrf).send(body);
    expect((await patch({ employmentEnd: '2026-12-31' })).status).toBe(200);
    expect((await patch({ employmentEnd: null })).status).toBe(200); expect(await revision()).toBe('2');
    expect((await patch({ employmentEnd: null })).status).toBe(200); expect(await revision()).toBe('2');
    problem(await post('batch', { ...selection(), previewToken: shown.body.previewToken }, randomUUID()), 409, 'AVAILABILITY_PREVIEW_STALE');
  });
  it('rolls back all markers, revision, audit and token consumption on the second audit failure', async () => {
    class SecondAuditFails extends BusinessAuditService {
      count = 0;
      override async recordBusinessAction(client: Parameters<BusinessAuditService['recordBusinessAction']>[0], entry: BusinessAuditEntry) {
        if (entry.action === 'EMPLOYEE_AVAILABILITY_SET' && ++this.count === 2) throw new Error('synthetic audit failure');
        await super.recordBusinessAction(client, entry);
      }
    }
    await app.close(); app = await bootEmployeesApp(new RecordingDelivery(), { clock, audit: new SecondAuditFails() });
    const shown = await preview(); const before = await snapshot(); const key = randomUUID(); const body = { ...selection(), previewToken: shown.body.previewToken };
    problem(await post('batch', body, key), 500, 'INTERNAL_ERROR'); expect(await snapshot()).toEqual(before);
    expect((await pool.query('SELECT state, key_hash FROM availability_batch_commands WHERE employee_id=$1', [employee.employeeId])).rows).toMatchObject([{ state: 'PREVIEWED', key_hash: null }]);
    expect((await post('batch', body, key)).status).toBe(200); expect(await audits()).toHaveLength(2);
  });
  it('exposes only a privacy-neutral absence projection and conceals foreign employees', async () => {
    await seed('2026-10-28', 'SICK'); await seed('2026-10-29', 'LEAVE');
    const service = app.get(AvailabilityService); const context = { companyId: tenant.companyId, accountId: tenant.admin.accountId, sessionId: randomUUID(), role: 'COMPANY_ADMIN' as const };
    for (const day of ['2026-10-28', '2026-10-29', '2026-10-30']) {
      const result = await app.get(DatabaseService).withTransaction((client) => service.getDailyAvailability(client, context, employee.employeeId, day));
      expect(result).toBe(day === '2026-10-30' ? 'AVAILABLE' : 'NOT_AVAILABLE');
    }
    await expect(app.get(DatabaseService).withTransaction((client) => service.getDailyAvailability(client, context, randomUUID(), '2026-10-28'))).rejects.toThrow();
  });
  it('enforces physical uniqueness, vocabulary, date bounds, tenant FKs and command state', async () => {
    await seed('2026-10-28');
    await expect(seed('2026-10-28', 'LEAVE')).rejects.toMatchObject({ code: '23505' });
    await expect(seed('2026-10-29', 'KRANK')).rejects.toMatchObject({ code: '23514' });
    await expect(seed('infinity')).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('INSERT INTO employee_availability_days(company_id,employee_id,day,status) VALUES($1,$2,$3,$4)',
      [tenant.companyId, randomUUID(), '2026-10-29', 'SICK'])).rejects.toMatchObject({ code: '23503' });
    const other = await createSyntheticTenant(pool, 'SP10 physical'); companies.push(other.companyId);
    const foreign = await createSyntheticEmployee(pool, other.employee);
    await expect(pool.query('INSERT INTO employee_availability_days(company_id,employee_id,day,status) VALUES($1,$2,$3,$4)',
      [tenant.companyId, foreign.employeeId, '2026-10-29', 'SICK'])).rejects.toMatchObject({ code: '23503' });
    await expect(seed('2026-10-29', null)).rejects.toMatchObject({ code: '23502' });
    await expect(pool.query('DELETE FROM employees WHERE id=$1', [employee.employeeId])).rejects.toMatchObject({ code: '23503' });
    await seed('0001-01-01'); await seed('9999-12-31');
    await preview();
    await expect(pool.query("UPDATE availability_batch_commands SET state='COMPLETED' WHERE employee_id=$1", [employee.employeeId])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query("UPDATE availability_batch_commands SET token_hash=decode('00','hex') WHERE employee_id=$1", [employee.employeeId])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('UPDATE availability_batch_commands SET expected_revision=-1 WHERE employee_id=$1', [employee.employeeId])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('UPDATE availability_batch_commands SET actor_account_id=$2 WHERE employee_id=$1', [employee.employeeId, other.admin.accountId])).rejects.toMatchObject({ code: '23503' });
  });
});
