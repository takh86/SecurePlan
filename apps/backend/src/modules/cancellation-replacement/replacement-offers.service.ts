import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../../auth/authorization/tenant-context.js';
import { assertSessionInTransaction } from '../../auth/session.service.js';
import { DatabaseService } from '../../database/database.service.js';
import { reserveCommand } from '../../common/transactions/command-reservation.js';
import {
  lockAttempt,
  reservationLock,
} from '../../common/transactions/idempotency-lock.js';
import { lockAccountsPrefix } from '../identity/account-prefix-lock.js';
import { currentEmployee } from '../workforce/employees/employee-context.js';
import {
  lockReplacementProject,
  replacementCandidateFacts,
  replacementCandidateJoin,
} from '../workforce/employees/replacement-candidate.js';
import {
  lockReplacementDuty,
  replacementPlanningFacts,
  replacementPlanningJoin,
} from '../planning/replacement-planning.js';
import { assertPlanningSchemaComplete } from '../planning/planning-schema.js';
import { assertEmployeeMonthReceiptSchema } from '../planning/employee-month-receipt-schema.js';
import { assertMyPlanMonth } from '../planning/me-monthly-plans-read.service.js';
import { PLANNING_WRITER_TIMEOUTS } from '../planning/planning-locks.js';
import { BusinessAuditService } from '../audit/business-audit.service.js';
import {
  lockReplacementOffers,
  assertUnresolvedOffers,
} from './replacement-offer-invalidation.js';
import {
  eligibleReplacementSql,
  replacementIneligibility,
  type EligibilityFacts,
} from './replacement-eligibility.js';
import { ownOffer, type ReplacementOffer } from './replacement-offers.store.js';
const OP = 'CREATE_REPLACEMENT_OFFER',
  RETENTION = 86400,
  STALE = 300;
const digest = (s: string) => createHash('sha256').update(s).digest();
export const replacementFingerprint = (id: string) =>
  digest(JSON.stringify(['create-replacement-offer-v1', id.toLowerCase()]));
type Facts = EligibilityFacts & {
  id: string;
  cancellation_request_id: string;
  assignment_id: string;
  project_id: string;
  plan_id: string;
  planning_month: string;
  duty_id: string;
  duty_date: string;
  shift_kind: 'DAY' | 'NIGHT';
  starts_at: string;
  ends_at: string;
  time_zone: string;
  project_name: string;
  status: 'OPEN' | 'OPEN_UNFILLED' | 'RESOLVED' | 'CLOSED';
  resolved_at: Date | null;
  open_offer_count: number;
  contextual: boolean;
  pair_consistent: boolean;
};
const factsSql = `WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at), facts AS (
 SELECT n.id,n.cancellation_request_id,r.assignment_id,n.status,n.resolved_at,
 (CASE WHEN r.status='OPEN' THEN n.status='OPEN' WHEN r.status='APPROVED' THEN n.status IN ('RESOLVED','OPEN_UNFILLED') ELSE n.status='CLOSED' END) AS pair_consistent,
 (n.status='OPEN' AND r.status='OPEN') AS open,r.employee_id<>$2 AS not_self,
 (r.employee_id=$2 OR EXISTS(SELECT 1 FROM public.replacement_offers o WHERE o.company_id=n.company_id AND o.need_id=n.id AND o.employee_id=$2)) AS contextual,
 (SELECT count(*)::int FROM public.replacement_offers o WHERE o.company_id=n.company_id AND o.need_id=n.id AND o.status='OPEN') AS open_offer_count,
 ${replacementPlanningFacts},${replacementCandidateFacts}
 FROM public.replacement_needs n JOIN public.cancellation_requests r ON r.company_id=n.company_id AND r.id=n.cancellation_request_id AND r.duty_id=n.duty_id
 ${replacementPlanningJoin} ${replacementCandidateJoin} CROSS JOIN moment WHERE n.company_id=$1)`;
function needDto(f: Facts) {
  return {
    id: f.id,
    cancellationRequestId: f.cancellation_request_id,
    duty: {
      id: f.duty_id,
      dutyDate: f.duty_date,
      shiftKind: f.shift_kind,
      startsAt: f.starts_at,
      endsAt: f.ends_at,
    },
    status: f.status,
    resolvedAt:
      f.resolved_at === null ? null : new Date(f.resolved_at).toISOString(),
    openOfferCount: f.open_offer_count,
    project: { id: f.project_id, name: f.project_name },
    timeZone: f.time_zone,
  };
}
@Injectable()
export class ReplacementOffersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: BusinessAuditService,
  ) {}
  private async enter(c: PoolClient, t: TenantContext) {
    await c.query(PLANNING_WRITER_TIMEOUTS);
    await lockAccountsPrefix(c, t, ['EMPLOYEE']);
    await assertSessionInTransaction(c, t);
    await assertPlanningSchemaComplete(c);
    await assertEmployeeMonthReceiptSchema(c);
  }
  private async facts(
    c: PoolClient,
    t: TenantContext,
    employee: string,
    id: string,
  ) {
    const row = (
      await c.query<Facts>(`${factsSql} SELECT * FROM facts WHERE id=$4`, [
        t.companyId,
        employee,
        t.accountId,
        id,
      ])
    ).rows[0];
    if (!row) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
    return row;
  }
  private conceal(f: Facts) {
    if (!f.contextual && !f.linked)
      throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
  }
  list(t: TenantContext, month: string, page: number, pageSize: number) {
    assertMyPlanMonth(month);
    return this.database.withTransaction(async (c) => {
      await this.enter(c, t);
      const employee = await currentEmployee(c, t);
      await currentEmployee(c, t, employee.id);
      // Count and page share one statement snapshot, after every eligibility filter.
      const result = (
        await c.query<{
          total: number;
          items: (Facts & {
            own_id: string | null;
            own_status: ReplacementOffer['status'];
            own_created: string;
            own_decided: string | null;
          })[];
        }>(
          `${factsSql}, visible AS MATERIALIZED (SELECT * FROM facts WHERE planning_month=$4 AND ${eligibleReplacementSql}),
   page AS (SELECT * FROM visible ORDER BY duty_date,id LIMIT $5 OFFSET $6)
   SELECT (SELECT count(*)::int FROM visible) AS total,coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.duty_date,x.id) FROM (
    SELECT page.*,o.id AS own_id,o.status AS own_status,
    to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS own_created,
    to_char(o.decided_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS own_decided
    FROM page LEFT JOIN LATERAL (SELECT id,status,created_at,decided_at FROM public.replacement_offers
     WHERE company_id=$1 AND need_id=page.id AND employee_id=$2 ORDER BY (status IN ('OPEN','SELECTED')) DESC,created_at DESC,id DESC LIMIT 1) o ON true
   ) x),'[]'::jsonb) AS items`,
          [
            t.companyId,
            employee.id,
            t.accountId,
            month,
            pageSize,
            (page - 1) * pageSize,
          ],
        )
      ).rows[0];
      await assertSessionInTransaction(c, t);
      return {
        items: result.items.map((f) => ({
          need: needDto(f),
          myOffer: f.own_id
            ? {
                id: f.own_id,
                needId: f.id,
                employee,
                status: f.own_status,
                createdAt: f.own_created,
                decidedAt: f.own_decided,
              }
            : null,
        })),
        pagination: {
          page,
          pageSize,
          totalItems: result.total,
          totalPages: Math.ceil(result.total / pageSize),
        },
      };
    });
  }
  detail(t: TenantContext, id: string) {
    return this.database.withTransaction(async (c) => {
      await this.enter(c, t);
      const employee = await currentEmployee(c, t);
      await currentEmployee(c, t, employee.id);
      const f = await this.facts(c, t, employee.id, id);
      await assertSessionInTransaction(c, t);
      if (replacementIneligibility(f))
        throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
      return needDto(f);
    });
  }
  async create(
    t: TenantContext,
    id: string,
    key: string,
    correlationId: string,
  ) {
    const keyHash = digest(key),
      requestHash = replacementFingerprint(id);
    const lockId = digest(
      JSON.stringify([
        'replacement-offer-reservation-v1',
        t.companyId,
        t.accountId,
        OP,
        keyHash.toString('hex'),
      ]),
    )
      .readBigInt64BE()
      .toString();
    const reserved = await this.database.withTransaction(async (c) => {
      await this.enter(c, t);
      const employee = await currentEmployee(c, t);
      this.conceal(await this.facts(c, t, employee.id, id));
      const owner = async () => {
        await currentEmployee(c, t, employee.id);
        await assertSessionInTransaction(c, t);
        this.conceal(await this.facts(c, t, employee.id, id));
      };
      return reserveCommand(c, {
        tenant: t,
        operation: OP,
        keyHash,
        requestHash,
        lockId,
        retention: RETENTION,
        stale: STALE,
        beforeWrite: owner,
        replay: async (prior) => {
          await owner();
          if (
            !prior.result_replacement_offer_id ||
            prior.result_plan_id !== null
          )
            throw new Error('Invalid typed offer receipt');
          const result = await ownOffer(
            c,
            t.companyId,
            employee,
            prior.result_replacement_offer_id,
          );
          await assertSessionInTransaction(c, t);
          if (result.needId !== id)
            throw new Error('Offer receipt context mismatch');
          return result;
        },
      });
    });
    if ('result' in reserved) return reserved;
    const claim = reserved.claim;
    try {
      return await this.database.withTransaction(async (c) => {
        await this.enter(c, t);
        const employee = await currentEmployee(c, t),
          found = await this.facts(c, t, employee.id, id);
        this.conceal(found);
        await reservationLock(c, lockId);
        await lockAttempt(
          c,
          t.companyId,
          t.accountId,
          OP,
          keyHash,
          claim.id,
          claim.attempt_id,
        );
        await currentEmployee(c, t, employee.id);
        await lockReplacementProject(
          c,
          t.companyId,
          employee.id,
          found.project_id,
          found.planning_month,
        );
        await lockReplacementDuty(c, t.companyId, employee.id, found);
        await c.query(
          'SELECT id FROM public.cancellation_requests WHERE company_id=$1 AND id=$2 ORDER BY id FOR UPDATE',
          [t.companyId, found.cancellation_request_id],
        );
        await c.query(
          'SELECT id FROM public.replacement_needs WHERE company_id=$1 AND id=$2 ORDER BY id FOR UPDATE',
          [t.companyId, id],
        );
        const offers = await lockReplacementOffers(c, t.companyId, [id]);
        await assertSessionInTransaction(c, t);
        const live = await currentEmployee(c, t);
        if (live.id !== employee.id)
          throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
        const f = await this.facts(c, t, employee.id, id);
        this.conceal(f);
        for (const k of [
          'project_id',
          'plan_id',
          'duty_id',
          'planning_month',
          'assignment_id',
          'cancellation_request_id',
        ] as const)
          if (f[k] !== found[k])
            throw new Error('Offer context changed during lock discovery');
        if (!f.pair_consistent)
          throw new Error('Inconsistent replacement need pair');
        const reason = replacementIneligibility(f);
        if (reason) throw new ConflictException({ code: reason });
        assertUnresolvedOffers(offers);
        if (
          (
            await c.query(
              "SELECT id FROM public.replacement_offers WHERE company_id=$1 AND need_id=$2 AND employee_id=$3 AND status IN ('OPEN','SELECTED')",
              [t.companyId, id, employee.id],
            )
          ).rowCount
        )
          throw new ConflictException({
            code: 'REPLACEMENT_OFFER_ALREADY_EXISTS',
          });
        const created = (
          await c.query<{ id: string }>(
            `WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at)
     INSERT INTO public.replacement_offers(company_id,need_id,duty_id,employee_id,created_at,updated_at) SELECT $1,$2,$4,$3,at,at FROM moment RETURNING id`,
            [t.companyId, id, employee.id, found.duty_id],
          )
        ).rows[0];
        await assertSessionInTransaction(c, t);
        await this.audit.recordBusinessAction(c, {
          companyId: t.companyId,
          actorAccountId: t.accountId,
          correlationId,
          action: 'REPLACEMENT_OFFER_CREATED',
          resourceType: 'REPLACEMENT_OFFER',
          resourceId: created.id,
          newValues: { needId: id, employeeId: employee.id, status: 'OPEN' },
        });
        const done = await c.query(
          `WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at)
     UPDATE public.idempotency_records SET state='COMPLETED',result_replacement_offer_id=$4,completed_at=moment.at,expires_at=moment.at+$5::int*interval '1 second' FROM moment
     WHERE company_id=$1 AND id=$2 AND attempt_id=$3 AND state='IN_PROGRESS'`,
          [t.companyId, claim.id, claim.attempt_id, created.id, RETENTION],
        );
        if (done.rowCount !== 1)
          throw new Error('Offer completion lost its attempt fence');
        const result = await ownOffer(c, t.companyId, employee, created.id);
        await assertSessionInTransaction(c, t);
        return { result, replayed: false };
      });
    } catch (error) {
      await this.database
        .withTransaction(async (c) => {
          await c.query(PLANNING_WRITER_TIMEOUTS);
          await lockAccountsPrefix(c, t, ['EMPLOYEE']);
          await assertSessionInTransaction(c, t);
          await reservationLock(c, lockId);
          await c.query(
            `UPDATE public.idempotency_records SET state='FAILED' WHERE company_id=$1 AND actor_account_id=$2 AND operation=$3 AND key_hash=$4 AND id=$5 AND attempt_id=$6 AND state='IN_PROGRESS'`,
            [t.companyId, t.accountId, OP, keyHash, claim.id, claim.attempt_id],
          );
        })
        .catch(() => {});
      throw error;
    }
  }
}
