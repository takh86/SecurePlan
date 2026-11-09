/** SP18-P1 actual closure writers with synthetic offers only; no offer-facing API. */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import {
  BusinessAuditService,
  type BusinessAuditEntry,
  type BusinessAuditAction,
} from '../src/modules/audit/business-audit.service.js';
import { DatabaseService } from '../src/database/database.service.js';
import { PlanningMutationDispatcher } from '../src/common/transactions/planning-mutation.js';
import type { SaveEmployeeMonth } from '../src/modules/planning/employee-month.contract.js';
import {
  bootEmployeesApp,
  RecordingDelivery,
  ORIGIN,
} from './helpers/employees-test-app.js';
import {
  dutyMutationFixture,
  dutyPath,
  MUTATION_MONTH,
  MUTATION_NOW,
  type DutyMutationFixture,
} from './helpers/duty-mutation-fixtures.js';
import {
  openLocalTestPool,
  removeSyntheticTenants,
  createSyntheticSession,
  realSessionService,
  backendPid,
  waitUntilBlockedBy,
  type TestPool,
} from './helpers/synthetic-tenants.js';
import {
  insertDuty,
  insertMembership,
  planningState,
} from './helpers/planning-fixtures.js';

let pool: TestPool,
  app: INestApplication<App> | undefined,
  f: DutyMutationFixture;
const companies: string[] = [];
let previousOrigin: string | undefined;
let token = '';
const actions = ['CANCELLATION_OBSOLETED', 'REPLACEMENT_NEED_CLOSED'];
class FailureAfterAudit extends BusinessAuditService {
  constructor(private readonly action: BusinessAuditAction) {
    super();
  }
  override async recordBusinessAction(
    c: Pick<PoolClient, 'query'>,
    entry: BusinessAuditEntry,
  ) {
    await super.recordBusinessAction(c, entry);
    if (entry.action === this.action) await c.query('SELECT 1/0');
  }
}
async function boot(audit?: BusinessAuditService) {
  await app?.close();
  app = await bootEmployeesApp(new RecordingDelivery(), {
    clock: () => new Date(MUTATION_NOW),
    ...(audit ? { audit } : {}),
  });
}
const http = (method: 'post' | 'patch' | 'delete', path = dutyPath(f)) =>
  request(app!.getHttpServer())
    [method](path)
    .set('Origin', ORIGIN)
    .set('Cookie', f.admin.cookie)
    .set('X-CSRF-Token', f.admin.csrf);
async function lease() {
  token = (await http('post', `${dutyPath(f)}/edit-lease`).expect(200)).body
    .leaseToken;
}
const patch = (body: object) =>
  http('patch')
    .set('Expected-Version', '1')
    .set('Edit-Lease-Token', token)
    .send(body);
const remove = () =>
  http('delete').set('Expected-Version', '1').set('Edit-Lease-Token', token);
async function pair(
  c: Pick<PoolClient, 'query'>,
  options: {
    assignment?: string;
    duty?: string;
    employee?: string;
    company?: string;
    status?: string;
    needStatus?: string;
  } = {},
) {
  const cancellation = randomUUID(),
    need = randomUUID();
  const company = options.company ?? f.tenant.companyId,
    duty = options.duty ?? f.dutyId;
  const status = options.status ?? 'OPEN';
  // Terminal fixture metadata must share one database instant, including microseconds.
  const {
    rows: [clock],
  } = await c.query<{ at: string }>('SELECT clock_timestamp()::text AS at');
  await c.query(
    `INSERT INTO public.cancellation_requests
    (id,company_id,assignment_id,duty_id,employee_id,submission_version,status,decided_at,decided_by_account_id,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,1,$6,CASE WHEN $6 IN ('APPROVED','REJECTED') THEN $8::timestamptz END,
      CASE WHEN $6 IN ('APPROVED','REJECTED') THEN $7::uuid END,$8::timestamptz,$8::timestamptz)`,
    [
      cancellation,
      company,
      options.assignment ?? f.membership,
      duty,
      options.employee ?? f.mira.employeeId,
      status,
      f.tenant.admin.accountId,
      clock.at,
    ],
  );
  await c.query(
    `INSERT INTO public.replacement_needs(id,company_id,cancellation_request_id,duty_id,status)
    VALUES($1,$2,$3,$4,$5)`,
    [need, company, cancellation, duty, options.needStatus ?? 'OPEN'],
  );
  return { cancellation, need };
}
async function committedPair(options: Parameters<typeof pair>[1] = {}) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const ids = await pair(c, options);
    await c.query('COMMIT');
    return ids;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}
const workflow = async () =>
  (
    await pool.query(
      `SELECT cr.id,cr.status,rn.status AS need_status,cr.updated_at=rn.updated_at AS same_time
  FROM public.cancellation_requests cr JOIN public.replacement_needs rn ON rn.company_id=cr.company_id AND rn.cancellation_request_id=cr.id
  WHERE cr.company_id=$1 ORDER BY cr.id`,
      [f.tenant.companyId],
    )
  ).rows;
const workflowAudits = async () =>
  (
    await pool.query(
      `SELECT action,resource_id,actor_account_id,old_values,new_values,correlation_id
  FROM audit_event WHERE company_id=$1 AND action=ANY($2::text[]) ORDER BY action,resource_id`,
      [f.tenant.companyId, actions],
    )
  ).rows;
const mutation = () => ({
  companyId: f.tenant.companyId,
  actorAccountId: f.tenant.admin.accountId,
  correlationId: randomUUID(),
  cause: 'DUTY_PATCH' as const,
  changes: [{ dutyId: f.dutyId, removedAssignmentIds: [f.membership] }],
});
async function saveDraft(): Promise<SaveEmployeeMonth> {
  const r = await request(app!.getHttpServer())
    .get(
      `/api/v1/monthly-plans/${f.planId}/employee-months/${f.mira.employeeId}`,
    )
    .set('Cookie', f.admin.cookie)
    .expect(200);
  return {
    expectedPlan: {
      status: r.body.plan.status,
      publishedAt: r.body.plan.publishedAt,
    },
    expectedCreationContext: r.body.creationContextFingerprint,
    expectedCalendar:
      r.body.operatingCalendar.effective === null
        ? null
        : {
            id: r.body.operatingCalendar.effective.id,
            version: r.body.operatingCalendar.effective.version,
          },
    days: r.body.days.map(
      (d: {
        date: string;
        day: { dutyId: string; version: number } | null;
        night: { dutyId: string; version: number } | null;
      }) => ({
        date: d.date,
        expected: {
          day: d.day ? { id: d.day.dutyId, version: d.day.version } : null,
          night: d.night
            ? { id: d.night.dutyId, version: d.night.version }
            : null,
        },
        desired: { state: 'OFF' },
      }),
    ),
  };
}
const save = (body: SaveEmployeeMonth, key = randomUUID()) =>
  http(
    'post',
    `/api/v1/monthly-plans/${f.planId}/employee-months/${f.mira.employeeId}/save`,
  )
    .set('Idempotency-Key', key)
    .send(body);

beforeAll(() => {
  pool = openLocalTestPool(10);
  previousOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
});
beforeEach(async () => {
  f = await dutyMutationFixture(pool, companies);
  token = '';
  await pool.query(
    "UPDATE monthly_plans SET status='PUBLISHED',published_at=clock_timestamp(),published_by_account_id=$2 WHERE id=$1",
    [f.planId, f.tenant.admin.accountId],
  );
  await boot();
});
afterEach(async () => {
  await app?.close();
  app = undefined;
});
afterAll(async () => {
  try {
    await removeSyntheticTenants(pool, companies);
  } finally {
    await pool.end();
  }
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousOrigin;
});

type OfferStatus =
  'OPEN' | 'SELECTED' | 'NOT_SELECTED' | 'INVALIDATED' | 'WITHDRAWN';
async function seedOffers(
  needId: string,
  count = 3,
  status: OfferStatus = 'OPEN',
) {
  return (
    await pool.query<{ id: string; employee_id: string }>(
      `WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at),
     ids AS (SELECT gen_random_uuid() AS id FROM generate_series(1,$3::int)),
     accounts AS (INSERT INTO public.accounts(id,company_id,email,account_scope,role,status,password_hash)
       SELECT id,$1,id::text||'@offers.invalid','TENANT','EMPLOYEE','ACTIVE','synthetic-offer-fixture' FROM ids RETURNING id),
     employees AS (INSERT INTO public.employees(company_id,account_id,employee_number,first_name,last_name,shift_eligibility)
       SELECT $1,id,left(id::text,30),'Synthetic','Candidate','BOTH' FROM accounts RETURNING id)
     INSERT INTO public.replacement_offers(company_id,need_id,duty_id,employee_id,status,created_at,updated_at,decided_at)
       SELECT $1,$2,(SELECT duty_id FROM public.replacement_needs WHERE company_id=$1 AND id=$2),e.id,$4,m.at,m.at,CASE WHEN $4='OPEN' THEN NULL ELSE m.at END
       FROM employees e CROSS JOIN moment m RETURNING id,employee_id`,
      [f.tenant.companyId, needId, count, status],
    )
  ).rows;
}
async function offerRows() {
  return (
    await pool.query(
      `SELECT to_jsonb(o) AS row FROM replacement_offers o WHERE company_id=$1 ORDER BY id`,
      [f.tenant.companyId],
    )
  ).rows;
}
async function offerAudits() {
  return (
    await pool.query(
      `SELECT resource_id,old_values,new_values,actor_account_id,correlation_id FROM audit_event
    WHERE company_id=$1 AND action='REPLACEMENT_OFFER_INVALIDATED' ORDER BY resource_id`,
      [f.tenant.companyId],
    )
  ).rows;
}
async function withdraw(id: string): Promise<request.Response> {
  const session = await createSyntheticSession(
    realSessionService(pool),
    f.mira.account,
  );
  return request(app!.getHttpServer())
    .post(`/api/v1/cancellation-requests/${id}/withdraw`)
    .set('Origin', ORIGIN)
    .set('Cookie', session.cookie)
    .set('X-CSRF-Token', session.csrf);
}
async function close(
  method: 'PATCH' | 'DELETE' | 'WITHDRAW' | 'BATCH',
  id: string,
) {
  if (method === 'WITHDRAW') return withdraw(id);
  if (method === 'BATCH') return save(await saveDraft());
  await lease();
  return method === 'PATCH' ? patch({ assignments: [] }) : remove();
}
async function observedWaiter(holderPid: number) {
  for (let i = 0; i < 2000; i++) {
    const rows = (
      await pool.query<{ pid: number }>(
        'SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))',
        [holderPid],
      )
    ).rows;
    if (rows[0]) {
      await waitUntilBlockedBy(pool, rows[0].pid, holderPid);
      return rows[0].pid;
    }
  }
  throw new Error('No observed PostgreSQL blocker');
}

it.each(['PATCH', 'DELETE', 'WITHDRAW'] as const)(
  '%s invalidates every OPEN offer with shared timestamps and preserves terminal history',
  async (method) => {
    const ids = await committedPair();
    const open = await seedOffers(ids.need);
    for (const status of ['INVALIDATED', 'NOT_SELECTED', 'WITHDRAWN'] as const)
      await seedOffers(ids.need, 1, status);
    const history = (await offerRows()).filter(
      ({ row }) => row.status !== 'OPEN',
    );
    const result = await close(method, ids.cancellation);
    expect(result.status).toBe(method === 'DELETE' ? 204 : 200);
    const rows = (
      await pool.query(
        `SELECT o.status,o.updated_at=r.updated_at AND o.updated_at=n.updated_at
    AND o.decided_at=o.updated_at AS same_time FROM replacement_offers o
    JOIN replacement_needs n ON n.company_id=o.company_id AND n.id=o.need_id
    JOIN cancellation_requests r ON r.company_id=n.company_id AND r.id=n.cancellation_request_id
    WHERE o.id=ANY($1::uuid[])`,
        [open.map((o) => o.id)],
      )
    ).rows;
    expect(rows).toHaveLength(3);
    expect(rows.every((o) => o.status === 'INVALIDATED' && o.same_time)).toBe(
      true,
    );
    expect(
      (await offerRows()).filter(
        ({ row }) => !open.some((o) => o.id === row.id),
      ),
    ).toEqual(history);
    const audits = await offerAudits();
    expect(audits).toHaveLength(3);
    for (const audit of audits) {
      expect(audit.old_values).toEqual({ status: 'OPEN' });
      expect(audit.new_values).toEqual({
        status: 'INVALIDATED',
        needId: ids.need,
        cause:
          method === 'WITHDRAW'
            ? 'CANCELLATION_WITHDRAWN'
            : 'ASSIGNMENT_REMOVED',
      });
      expect(audit.correlation_id).toBe(result.headers['x-correlation-id']);
    }
    if (method === 'WITHDRAW') {
      expect((await withdraw(ids.cancellation)).status).toBe(200);
      expect(await offerAudits()).toEqual(audits);
      expect(
        (
          await pool.query('SELECT state FROM plan_assignments WHERE id=$1', [
            f.membership,
          ])
        ).rows[0].state,
      ).toBe('ACTIVE');
    } else {
      await app!
        .get(DatabaseService)
        .withTransaction((c) =>
          app!.get(PlanningMutationDispatcher).dispatch(c, mutation()),
        );
      expect(await offerAudits()).toEqual(audits);
    }
  },
);

it.each([
  { dutyDate: '2027-01-21' },
  { shiftKind: 'NIGHT' },
  { role: true },
] as const)(
  'retained assignment edit %j leaves offers OPEN',
  async (change) => {
    const ids = await committedPair();
    await seedOffers(ids.need);
    await lease();
    const before = await offerRows();
    const body =
      'role' in change
        ? {
            assignments: [
              { employeeId: f.mira.employeeId, dutyRole: 'SHIFT_LEAD' },
            ],
          }
        : change;
    await patch(body).expect(200);
    expect(await offerRows()).toEqual(before);
    expect(await offerAudits()).toEqual([]);
  },
);

it.each(['PATCH', 'DELETE', 'WITHDRAW', 'BATCH'] as const)(
  '%s rolls back planning, need, offers and all audits if offer audit fails',
  async (method) => {
    const ids = await committedPair();
    await seedOffers(ids.need);
    await boot(new FailureAfterAudit('REPLACEMENT_OFFER_INVALIDATED'));
    if (method === 'PATCH' || method === 'DELETE') await lease();
    const before = await planningState(pool, f.tenant.companyId),
      wf = await workflow(),
      offers = await offerRows();
    const result =
      method === 'PATCH'
        ? await patch({ assignments: [] })
        : method === 'DELETE'
          ? await remove()
          : await close(method, ids.cancellation);
    expect(result.status).toBe(500);
    expect(result.body.code).toBe('INTERNAL_ERROR');
    expect(await planningState(pool, f.tenant.companyId)).toEqual(before);
    expect(await workflow()).toEqual(wf);
    expect(await offerRows()).toEqual(offers);
    expect(await offerAudits()).toEqual([]);
    expect(await workflowAudits()).toEqual([]);
    if (method === 'BATCH')
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM idempotency_records WHERE company_id=$1 AND state='COMPLETED'",
            [f.tenant.companyId],
          )
        ).rows[0].n,
      ).toBe(0);
  },
);

it.each(['PATCH', 'DELETE', 'WITHDRAW'] as const)(
  '%s refuses SELECTED under an OPEN cancellation rather than repairing it',
  async (method) => {
    const ids = await committedPair();
    await seedOffers(ids.need, 1, 'SELECTED');
    if (method !== 'WITHDRAW') await lease();
    const offers = await offerRows(),
      wf = await workflow(),
      before = await planningState(pool, f.tenant.companyId);
    const result =
      method === 'PATCH'
        ? await patch({ assignments: [] })
        : method === 'DELETE'
          ? await remove()
          : await withdraw(ids.cancellation);
    expect(result.status).toBe(500);
    expect(await offerRows()).toEqual(offers);
    expect(await workflow()).toEqual(wf);
    expect(await planningState(pool, f.tenant.companyId)).toEqual(before);
    expect(await offerAudits()).toEqual([]);
  },
);

it('withdrawal replay fails closed on an inconsistent OPEN offer without lazy repair or new audits', async () => {
  const ids = await committedPair();
  await seedOffers(ids.need);
  expect((await withdraw(ids.cancellation)).status).toBe(200);
  await seedOffers(ids.need, 1);
  const before = await offerRows(),
    audits = await offerAudits();
  expect((await withdraw(ids.cancellation)).status).toBe(500);
  expect(await offerRows()).toEqual(before);
  expect(await offerAudits()).toEqual(audits);
});

it('employee-month batch locks and invalidates offers across three duties before any Z audit, replay is stable', async () => {
  for (const day of ['21', '22']) {
    const duty = await insertDuty(pool, {
      companyId: f.tenant.companyId,
      projectId: f.project.projectId,
      planId: f.planId,
      month: MUTATION_MONTH,
      dutyDate: `2027-01-${day}`,
      startsAt: `2027-01-${day}T05:00:00Z`,
      endsAt: `2027-01-${day}T17:00:00Z`,
    });
    const assignment = await insertMembership(
      pool,
      f.tenant.companyId,
      duty,
      f.mira.employeeId,
    );
    const ids = await committedPair({ assignment, duty });
    await seedOffers(ids.need);
  }
  const ids = await committedPair();
  await seedOffers(ids.need);
  class Inspect extends BusinessAuditService {
    override async recordBusinessAction(
      c: Pick<PoolClient, 'query'>,
      entry: BusinessAuditEntry,
    ) {
      if (entry.companyId === f.tenant.companyId) {
        expect(
          (
            await c.query(
              "SELECT count(*)::int AS n FROM replacement_offers WHERE company_id=$1 AND status='OPEN'",
              [entry.companyId],
            )
          ).rows[0].n,
        ).toBe(0);
        expect(
          (
            await c.query(
              "SELECT count(*)::int AS n FROM cancellation_requests WHERE company_id=$1 AND status='OBSOLETE'",
              [entry.companyId],
            )
          ).rows[0].n,
        ).toBe(3);
      }
      await super.recordBusinessAction(c, entry);
    }
  }
  await boot(new Inspect());
  const body = await saveDraft(),
    key = randomUUID();
  await save(body, key).expect(200);
  expect(await offerAudits()).toHaveLength(9);
  expect(await workflowAudits()).toHaveLength(6);
  await save(body, key).expect(200);
  expect(await offerAudits()).toHaveLength(9);
});

it.each(['COMMIT', 'ROLLBACK'] as const)(
  'actual withdrawal waits for W3; concurrent offer finalization %s is reread',
  async (finish) => {
    const ids = await committedPair(),
      offers = await seedOffers(ids.need);
    const holder = await pool.connect();
    let flight: Promise<request.Response> | undefined;
    try {
      await holder.query('BEGIN');
      const pid = await backendPid(holder);
      await holder.query(
        "WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at) UPDATE replacement_offers SET status='WITHDRAWN',decided_at=moment.at,updated_at=moment.at FROM moment WHERE id=$1",
        [offers[0].id],
      );
      // Test-only terminal writer; not an offer-withdrawal API implementation.
      flight = withdraw(ids.cancellation);
      await observedWaiter(pid);
      expect((await workflow())[0].status).toBe('OPEN');
      expect(await offerAudits()).toHaveLength(0);
      await holder.query(finish);
      expect((await flight).status).toBe(200);
      expect(await offerAudits()).toHaveLength(finish === 'COMMIT' ? 2 : 3);
      const preserved = (
        await pool.query('SELECT status FROM replacement_offers WHERE id=$1', [
          offers[0].id,
        ])
      ).rows[0].status;
      expect(preserved).toBe(finish === 'COMMIT' ? 'WITHDRAWN' : 'INVALIDATED');
    } finally {
      await holder.query('ROLLBACK');
      await flight;
      holder.release();
    }
  },
);

it.each(['COMMIT', 'ROLLBACK'] as const)(
  'test-only new-offer transaction holds D before actual PATCH; %s is atomic',
  async (finish) => {
    const ids = await committedPair(),
      candidates = await seedOffers(ids.need);
    await pool.query(
      "WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at) UPDATE replacement_offers SET status='WITHDRAWN',decided_at=moment.at,updated_at=moment.at FROM moment WHERE id=$1",
      [candidates[0].id],
    );
    await lease();
    const holder = await pool.connect();
    let flight: Promise<request.Response> | undefined;
    try {
      await holder.query('BEGIN');
      const pid = await backendPid(holder);
      await holder.query(
        'SELECT id FROM duties WHERE company_id=$1 AND id=$2 FOR UPDATE',
        [f.tenant.companyId, f.dutyId],
      );
      await holder.query(
        'SELECT id FROM cancellation_requests WHERE company_id=$1 AND id=$2 FOR UPDATE',
        [f.tenant.companyId, ids.cancellation],
      );
      await holder.query(
        'SELECT id FROM replacement_needs WHERE company_id=$1 AND id=$2 FOR UPDATE',
        [f.tenant.companyId, ids.need],
      );
      await holder.query(
        'INSERT INTO replacement_offers(company_id,need_id,duty_id,employee_id) VALUES($1,$2,(SELECT duty_id FROM replacement_needs WHERE company_id=$1 AND id=$2),$3)',
        [f.tenant.companyId, ids.need, candidates[0].employee_id],
      );
      flight = patch({ assignments: [] }).then((r) => r);
      await observedWaiter(pid);
      await holder.query(finish);
      expect((await flight).status).toBe(200);
      expect(await offerAudits()).toHaveLength(finish === 'COMMIT' ? 3 : 2);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM replacement_offers WHERE company_id=$1 AND status='OPEN'",
            [f.tenant.companyId],
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await holder.query('ROLLBACK');
      await flight;
      holder.release();
    }
  },
);

it('1000 offers have no quota and close with 1000 bounded audits within writer limits', async () => {
  const ids = await committedPair();
  await seedOffers(ids.need, 1000);
  const start = performance.now();
  const result = await withdraw(ids.cancellation);
  const elapsed = performance.now() - start;
  expect(result.status).toBe(200);
  expect(await offerAudits()).toHaveLength(1000);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM replacement_offers WHERE company_id=$1 AND status='INVALIDATED'",
        [f.tenant.companyId],
      )
    ).rows[0].n,
  ).toBe(1000);
  console.log(
    `SP18_CARDINALITY count=1000 closure_elapsed_ms=${elapsed.toFixed(1)} audit_count=1000`,
  );
}, 30000);

it('observed W3 lock timeout rolls back 1000-offer closure completely', async () => {
  const ids = await committedPair(),
    offers = await seedOffers(ids.need, 1000);
  const holder = await pool.connect();
  let flight: Promise<request.Response> | undefined;
  try {
    await holder.query('BEGIN');
    const pid = await backendPid(holder);
    await holder.query(
      'SELECT id FROM replacement_offers WHERE id=$1 FOR UPDATE',
      [offers[0].id],
    );
    const before = await offerRows(),
      start = performance.now();
    flight = withdraw(ids.cancellation);
    await observedWaiter(pid);
    const result = await flight,
      elapsed = performance.now() - start;
    expect(result.status).toBe(500);
    expect(result.body.code).toBe('INTERNAL_ERROR');
    expect(await offerRows()).toEqual(before);
    expect((await workflow())[0].status).toBe('OPEN');
    expect(await offerAudits()).toHaveLength(0);
    console.log(
      `SP18_TIMEOUT count=1000 observed_blocking=true elapsed_ms=${elapsed.toFixed(1)} status=${result.status} rollback=complete`,
    );
  } finally {
    await holder.query('ROLLBACK');
    await flight;
    holder.release();
  }
}, 15000);

it('unrelated CR03 removal preserves a future resolved case and selected/nonselected offer history', async () => {
  const ids = await committedPair();
  // A RESOLVED need must point at its SELECTED offer (ck_replacement_needs__selection), so offers come first.
  await seedOffers(ids.need, 1, 'SELECTED');
  await seedOffers(ids.need, 2, 'NOT_SELECTED');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const at = (
      await c.query<{ at: string }>('SELECT clock_timestamp()::text AS at')
    ).rows[0].at;
    await c.query(
      "UPDATE cancellation_requests SET status='APPROVED',decided_at=$2::timestamptz,updated_at=$2::timestamptz,decided_by_account_id=$3 WHERE id=$1",
      [ids.cancellation, at, f.tenant.admin.accountId],
    );
    await c.query(
      "UPDATE replacement_needs SET status='RESOLVED',resolved_at=$2::timestamptz,updated_at=$2::timestamptz,selected_offer_id=(SELECT id FROM replacement_offers WHERE company_id=$3 AND need_id=$1 AND status='SELECTED') WHERE id=$1",
      [ids.need, at, f.tenant.companyId],
    );
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
  const offers = await offerRows(),
    wf = await workflow();
  await lease();
  await patch({ assignments: [] }).expect(200);
  expect(await offerRows()).toEqual(offers);
  expect(await workflow()).toEqual(wf);
  expect(await offerAudits()).toEqual([]);
  expect(await workflowAudits()).toEqual([]);
});

it.each(['PATCH', 'DELETE', 'BATCH', 'WITHDRAW'] as const)(
  '%s rechecks session expiry after an observed W3 wait and rolls back every transition',
  async (method) => {
    const ids = await committedPair(),
      offers = await seedOffers(ids.need);
    if (method === 'PATCH' || method === 'DELETE') await lease();
    const body = method === 'BATCH' ? await saveDraft() : undefined;
    const before = await planningState(pool, f.tenant.companyId),
      wf = await workflow(),
      originalOffers = await offerRows();
    const holder = await pool.connect();
    let flight: Promise<request.Response> | undefined;
    try {
      await holder.query('BEGIN');
      const pid = await backendPid(holder);
      await holder.query(
        'SELECT id FROM replacement_offers WHERE id=$1 FOR UPDATE',
        [offers[0].id],
      );
      flight =
        method === 'PATCH'
          ? patch({ assignments: [] }).then((r) => r)
          : method === 'DELETE'
            ? remove().then((r) => r)
            : method === 'BATCH'
              ? save(body!).then((r) => r)
              : withdraw(ids.cancellation);
      await observedWaiter(pid);
      await pool.query(
        "UPDATE sessions SET created_at=clock_timestamp()-interval '10 hours',last_seen_at=clock_timestamp()-interval '9 hours' WHERE company_id=$1 AND account_id=$2",
        [
          f.tenant.companyId,
          method === 'WITHDRAW'
            ? f.mira.account.accountId
            : f.tenant.admin.accountId,
        ],
      );
      await holder.query('COMMIT');
      const result = await flight;
      expect(result.status).toBe(401);
      expect(result.body.code).toBe('SESSION_EXPIRED');
      expect(await planningState(pool, f.tenant.companyId)).toEqual(before);
      expect(await workflow()).toEqual(wf);
      expect(await offerRows()).toEqual(originalOffers);
      expect(await offerAudits()).toEqual([]);
      expect(await workflowAudits()).toEqual([]);
    } finally {
      await holder.query('ROLLBACK');
      await flight;
      holder.release();
    }
  },
);
