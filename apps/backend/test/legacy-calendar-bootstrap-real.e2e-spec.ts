/** Development rollout rehearsal; also runs against 0001-0013 before 0014. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ORIGIN, RecordingDelivery, bootEmployeesApp } from './helpers/employees-test-app.js';
import { createSyntheticProject, createSyntheticSession, createSyntheticTenant, openLocalTestPool, realSessionService, removeSyntheticTenants } from './helpers/synthetic-tenants.js';
import { createStaff, insertDuty, insertMembership, insertPlan, insertProjectAssignment } from './helpers/planning-fixtures.js';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));

it('preserves legacy rows through migration, inventories all projects, explicitly bootstraps then creates and First Publishes via HTTP', async () => {
  const pool = openLocalTestPool();
  const companies: string[] = [];
  const oldOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
  let app: Awaited<ReturnType<typeof bootEmployeesApp>> | undefined;
  try {
    const tenant = await createSyntheticTenant(pool, 'A1 rollout'); companies.push(tenant.companyId);
    const historic = await createSyntheticProject(pool, tenant.companyId, 'Historical published dual');
    const empty = await createSyntheticProject(pool, tenant.companyId, 'Retained empty');
    const bare = await createSyntheticProject(pool, tenant.companyId, 'No duties');
    const staff = await createStaff(pool, tenant.companyId);
    const historicalPlan = await insertPlan(pool, tenant.companyId, historic.projectId, '2020-01-01', { byAccountId: tenant.admin.accountId });
    const emptyPlan = await insertPlan(pool, tenant.companyId, empty.projectId, '2020-02-01');
    await insertPlan(pool, tenant.companyId, bare.projectId, '2019-01-01');
    const day = await insertDuty(pool, { companyId: tenant.companyId, projectId: historic.projectId, planId: historicalPlan,
      month: '2020-01-01', dutyDate: '2020-01-05', startsAt: '2020-01-05T05:00Z', endsAt: '2020-01-05T17:00Z' });
    const night = await insertDuty(pool, { companyId: tenant.companyId, projectId: historic.projectId, planId: historicalPlan,
      month: '2020-01-01', dutyDate: '2020-01-05', kind: 'NACHT', startsAt: '2020-01-05T17:00Z', endsAt: '2020-01-06T05:00Z' });
    await insertMembership(pool, tenant.companyId, day, staff.employeeId);
    await insertMembership(pool, tenant.companyId, night, staff.employeeId);
    const emptyDuty = await insertDuty(pool, { companyId: tenant.companyId, projectId: empty.projectId, planId: emptyPlan,
      month: '2020-02-01', dutyDate: '2020-02-01', startsAt: '2020-02-01T05:00Z', endsAt: '2020-02-01T17:00Z' });
    await insertMembership(pool, tenant.companyId, emptyDuty, staff.employeeId, 'REMOVED');
    const snapshot = async () => {
      const rows = [];
      for (const table of ['monthly_plans', 'duties', 'plan_assignments']) {
        rows.push((await pool.query(`SELECT * FROM ${table} WHERE company_id = $1 ORDER BY id`, [tenant.companyId])).rows);
      }
      return rows;
    };
    const before = await snapshot();
    // With a fresh 0001-0013 target this applies 0014 over populated legacy data.
    // In normal CI it proves checksum replay preserves exactly the same rows.
    const migrated = await execute(process.execPath, ['scripts/migrate.mjs'], { cwd: root });
    expect(migrated.stdout).toContain('0014_project_operating_calendars.sql');
    expect(await snapshot()).toEqual(before);
    expect((await pool.query('SELECT 1 FROM project_operating_calendars WHERE company_id = $1', [tenant.companyId])).rowCount).toBe(0);
    const inventory = async () => JSON.parse((await execute(process.execPath, ['scripts/scan-project-calendars.mjs'], { cwd: root })).stdout);
    const initial = await inventory();
    expect(initial.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ project_id: historic.projectId, month: '2020-01-01', violation: 'MISSING', count: 2 }),
      expect.objectContaining({ project_id: historic.projectId, violation: 'DUAL_ASSIGNMENT', count: 1 }),
      expect.objectContaining({ project_id: empty.projectId, violation: 'MISSING', count: 1 }),
    ]));
    expect(initial.projects).toContainEqual(expect.objectContaining({ project_id: bare.projectId, calendar_versions: 0,
      earliest_live_duty_month: null, missing_plan_months: ['2019-01-01'] }));
    expect(await snapshot()).toEqual(before);
    app = await bootEmployeesApp(new RecordingDelivery());
    const session = await createSyntheticSession(realSessionService(pool), tenant.admin);
    const http = (method: 'get' | 'post' | 'patch', path: string, body?: object) => {
      const op = request(app!.getHttpServer())[method](path).set('Origin', ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf);
      return body === undefined ? op : op.send(body);
    };
    const calendar = (id: string) => `/api/v1/projects/${id}/operating-calendar`;
    const configure = async (id: string, month: string, weekdays: number[], bootstrap = true) => {
      const read = (await http('get', `${calendar(id)}?effectiveForMonth=${month}`).expect(200)).body;
      return http('patch', calendar(id), { effectiveFromMonth: month, operatingWeekdays: weekdays, bootstrap,
        expectedExactVersion: read.exactVersion, expectedEffective: read.effective ? { id: read.effective.id, version: read.effective.version } : null,
        expectedNextEffectiveFromMonth: read.nextEffectiveFromMonth });
    };
    // Explicit fixture policies, never derived from the duty inventory.
    expect((await configure(historic.projectId, '2020-01-01', [1])).body.code).toBe('PROJECT_CALENDAR_DEPENDENCY_CONFLICT');
    await configure(historic.projectId, '2020-01-01', [7]).then((r) => expect(r.status).toBe(200));
    expect((await configure(empty.projectId, '2020-02-01', [7])).body.code).toBe('PROJECT_CALENDAR_DEPENDENCY_CONFLICT');
    await configure(empty.projectId, '2020-02-01', [6]).then((r) => expect(r.status).toBe(200));
    expect(await snapshot()).toEqual(before); // Published, retained empty and dual membership history unchanged.
    const current = initial.projects.find((p: { project_id: string }) => p.project_id === bare.projectId).current_month as string;
    expect((await configure(bare.projectId, '2019-01-01', [2])).body.code).toBe('PROJECT_CALENDAR_INVALID');
    await configure(bare.projectId, current, [2]).then((r) => expect(r.status).toBe(200));
    const historicalRead = await http('get', `${calendar(bare.projectId)}?effectiveForMonth=2019-01-01`).expect(200);
    expect(historicalRead.body.state).toBe('MISSING'); // No duties: historical empty plans do not authorize backdating.
    const oldBare = initial.projects.find((p: { project_id: string }) => p.project_id === bare.projectId);
    expect(oldBare.missing_plan_months).toEqual(['2019-01-01']);
    const pastPlan = (await pool.query('SELECT id FROM monthly_plans WHERE project_id = $1', [bare.projectId])).rows[0].id;
    expect((await http('post', `/api/v1/monthly-plans/${pastPlan}/publish`).set('Idempotency-Key', randomUUID())).body.code).toBe('PROJECT_CALENDAR_MISSING');
    // Future demo month; Tuesday policy explicitly supplied by this scenario.
    const month = `${Number(current.slice(0, 4)) + 1}-01-01`;
    await insertProjectAssignment(pool, tenant.companyId, staff.employeeId, bare.projectId, month);
    for (const [kind, start, end] of [['TAG', '06:00', '18:00'], ['NACHT', '18:00', '06:00']]) {
      await pool.query(`INSERT INTO shift_configurations(company_id, project_id, effective_from_month, shift_kind, start_local, end_local)
        VALUES ($1, $2, $3, $4, $5, $6)`, [tenant.companyId, bare.projectId, month, kind, start, end]);
    }
    const plan = await http('post', '/api/v1/monthly-plans', { projectId: bare.projectId, monthStart: month }).expect(201);
    const entries = `/api/v1/monthly-plans/${plan.body.id}/entries`;
    const tuesday = new Date(`${month}T12:00:00Z`);
    while (tuesday.getUTCDay() !== 2) tuesday.setUTCDate(tuesday.getUTCDate() + 1);
    const date = tuesday.toISOString().slice(0, 10);
    const duty = await http('post', entries, { dutyDate: date, shiftKind: 'DAY', assignments: [{ employeeId: staff.employeeId, dutyRole: 'EMPLOYEE' }] }).expect(201);
    const published = await http('post', `/api/v1/monthly-plans/${plan.body.id}/publish`).set('Idempotency-Key', randomUUID()).expect(200);
    expect(published.body.status).toBe('PUBLISHED');
    expect((await pool.query('SELECT id FROM duties WHERE id = $1 AND removed_at IS NULL', [duty.body.id])).rowCount).toBe(1);
    const final = await inventory();
    expect(final.findings.filter((p: { company_id: string }) => p.company_id === tenant.companyId))
      .toEqual([expect.objectContaining({ violation: 'DUAL_ASSIGNMENT', count: 1 })]);
    expect(final.projects).toContainEqual(expect.objectContaining({ project_id: bare.projectId, missing_plan_months: ['2019-01-01'] }));
    const audit = (await pool.query("SELECT new_values FROM audit_event WHERE company_id = $1 AND action = 'PROJECT_OPERATING_CALENDAR_UPDATED'", [tenant.companyId])).rows;
    expect(audit).toHaveLength(3);
    expect(audit.every((row) => row.new_values.bootstrap === true)).toBe(true);
  } finally {
    await app?.close();
    try { await removeSyntheticTenants(pool, companies); } finally { await pool.end(); }
    if (oldOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = oldOrigin;
  }
}, 60000);
