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
import {
  currentEmployee,
  employeeSummary,
} from '../workforce/employees/employee-context.js';
import { assertPlanningSchemaComplete } from '../planning/planning-schema.js';
import { assertEmployeeMonthReceiptSchema } from '../planning/employee-month-receipt-schema.js';
import {
  assertCancellationEligible,
  cancellationContext,
  lockCancellationContext,
} from '../planning/cancellation-context.js';
import { PLANNING_WRITER_TIMEOUTS } from '../planning/planning-locks.js';
import { BusinessAuditService } from '../audit/business-audit.service.js';
import type { CancellationResponse } from './cancellation.types.js';
const OP = 'CREATE_CANCELLATION';
const RETENTION = 86400,
  STALE = 300;
const digest = (value: string) => createHash('sha256').update(value).digest();
export function cancellationFingerprint(
  assignmentId: string,
  version: number,
): Buffer {
  return digest(
    JSON.stringify([
      'create-cancellation-v1',
      assignmentId.toLowerCase(),
      version,
    ]),
  );
}
type CaseRow = {
  id: string;
  assignment_id: string;
  employee_id: string;
  duty_id: string;
  status: CancellationResponse['status'];
  created_at: Date;
  decided_at: Date | null;
  need_id: string | null;
  need_status: CancellationResponse['replacementNeed']['status'] | null;
  resolved_at: Date | null;
};
@Injectable()
export class CancellationRequestsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: BusinessAuditService,
  ) {}
  private async enter(
    c: PoolClient,
    t: TenantContext,
    roles: ('EMPLOYEE' | 'COMPANY_ADMIN')[] = ['EMPLOYEE'],
  ) {
    await c.query(PLANNING_WRITER_TIMEOUTS);
    await lockAccountsPrefix(c, t, roles);
    await assertSessionInTransaction(c, t);
    await assertPlanningSchemaComplete(c);
    await assertEmployeeMonthReceiptSchema(c);
  }
  private async resource(
    c: PoolClient,
    t: TenantContext,
    id: string,
    ownerId?: string,
  ): Promise<CancellationResponse> {
    // One statement observes the cancellation/need pair at a single MVCC snapshot.
    const row = (
      await c.query<CaseRow>(
        `SELECT r.id,r.assignment_id,r.employee_id,r.duty_id,r.status,r.created_at,r.decided_at,
      n.id AS need_id,n.status AS need_status,n.resolved_at
      FROM public.cancellation_requests r LEFT JOIN public.replacement_needs n
        ON n.company_id=r.company_id AND n.cancellation_request_id=r.id AND n.duty_id=r.duty_id
      WHERE r.company_id=$1 AND r.id=$2`,
        [t.companyId, id],
      )
    ).rows[0];
    if (!row || (ownerId && row.employee_id !== ownerId))
      throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
    if (!row.need_id || !row.need_status)
      throw new Error('Missing required replacement need');
    const validPair =
      row.status === 'OPEN'
        ? row.need_status === 'OPEN'
        : row.status === 'APPROVED'
          ? ['RESOLVED', 'OPEN_UNFILLED'].includes(row.need_status)
          : ['WITHDRAWN', 'REJECTED', 'OBSOLETE'].includes(row.status) &&
            row.need_status === 'CLOSED';
    if (!validPair) throw new Error('Inconsistent cancellation result');
    const context = await cancellationContext(
      c,
      t.companyId,
      row.assignment_id,
      ownerId,
    );
    if (
      context.duty_id !== row.duty_id ||
      context.employee_id !== row.employee_id
    )
      throw new Error('Inconsistent historical result');
    const employee = await employeeSummary(c, t.companyId, row.employee_id);
    await assertSessionInTransaction(c, t);
    return {
      id: row.id,
      assignmentId: row.assignment_id,
      employee,
      duty: {
        id: row.duty_id,
        dutyDate: context.dutyDate,
        shiftKind: context.shiftKind,
        startsAt: context.startsAt,
        endsAt: context.endsAt,
      },
      status: row.status,
      createdAt: row.created_at.toISOString(),
      decidedAt: row.decided_at?.toISOString() ?? null,
      replacementNeed: {
        id: row.need_id,
        status: row.need_status,
        resolvedAt: row.resolved_at?.toISOString() ?? null,
      },
    };
  }
  get(t: TenantContext, id: string): Promise<CancellationResponse> {
    return this.database.withTransaction(async (c) => {
      await this.enter(c, t, ['EMPLOYEE', 'COMPANY_ADMIN']);
      const employee =
        t.role === 'EMPLOYEE' ? await currentEmployee(c, t) : undefined;
      if (employee) await currentEmployee(c, t, employee.id);
      return this.resource(c, t, id, employee?.id);
    });
  }
  async create(
    t: TenantContext,
    assignmentId: string,
    version: number,
    key: string,
    correlationId: string,
  ) {
    const keyHash = digest(key),
      requestHash = cancellationFingerprint(assignmentId, version);
    const lockId = digest(
      JSON.stringify([
        'cancellation-reservation-v1',
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
      await cancellationContext(c, t.companyId, assignmentId, employee.id); // conceal before key inspection
      return reserveCommand(c, {
        tenant: t,
        operation: OP,
        keyHash,
        requestHash,
        lockId,
        retention: RETENTION,
        stale: STALE,
        beforeWrite: async () => {
          await currentEmployee(c, t, employee.id);
          await assertSessionInTransaction(c, t);
          await cancellationContext(c, t.companyId, assignmentId, employee.id);
        },
        replay: async (prior) => {
          await currentEmployee(c, t, employee.id);
          await assertSessionInTransaction(c, t);
          if (
            !prior.result_cancellation_request_id ||
            prior.result_plan_id !== null
          )
            throw new Error('Invalid typed cancellation receipt');
          const result = await this.resource(
            c,
            t,
            prior.result_cancellation_request_id,
            employee.id,
          );
          if (result.assignmentId !== assignmentId)
            throw new Error('Invalid cancellation receipt context');
          return result;
        },
      });
    });
    if ('result' in reserved) return reserved;
    const claim = reserved.claim;
    try {
      return await this.database.withTransaction(async (c) => {
        await this.enter(c, t);
        const employee = await currentEmployee(c, t);
        const found = await cancellationContext(
          c,
          t.companyId,
          assignmentId,
          employee.id,
        );
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
        const context = await lockCancellationContext(c, t, found);
        await assertSessionInTransaction(c, t); // fresh clock after every business lock wait
        await currentEmployee(c, t); // revalidate live employee context without acquiring earlier locks
        assertCancellationEligible(context, version);
        const existing = await c.query<{ id: string }>(
          `SELECT id FROM public.cancellation_requests WHERE company_id=$1 AND duty_id=$2 AND employee_id=$3 AND status='OPEN' ORDER BY id FOR UPDATE`,
          [t.companyId, context.duty_id, employee.id],
        );
        if (existing.rowCount) {
          const needs = await c.query<{
            cancellation_request_id: string;
            duty_id: string;
            status: string;
          }>(
            `SELECT cancellation_request_id,duty_id,status FROM public.replacement_needs
              WHERE company_id=$1 AND cancellation_request_id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
            [t.companyId, existing.rows.map((row) => row.id)],
          );
          if (
            needs.rowCount !== 1 ||
            needs.rows[0].status !== 'OPEN' ||
            needs.rows[0].duty_id !== context.duty_id
          )
            throw new Error('Inconsistent existing cancellation pair');
          throw new ConflictException({ code: 'CANCELLATION_ALREADY_EXISTS' });
        }
        const created = (
          await c.query<{ id: string }>(
            `INSERT INTO public.cancellation_requests(company_id,assignment_id,duty_id,employee_id,submission_version)
          VALUES($1,$2,$3,$4,$5) RETURNING id`,
            [t.companyId, assignmentId, context.duty_id, employee.id, version],
          )
        ).rows[0];
        const need = (
          await c.query<{ id: string }>(
            `INSERT INTO public.replacement_needs(company_id,cancellation_request_id,duty_id)
          VALUES($1,$2,$3) RETURNING id`,
            [t.companyId, created.id, context.duty_id],
          )
        ).rows[0];
        await assertSessionInTransaction(c, t);
        await this.audit.recordBusinessAction(c, {
          companyId: t.companyId,
          actorAccountId: t.accountId,
          correlationId,
          action: 'CANCELLATION_CREATED',
          resourceType: 'CANCELLATION_REQUEST',
          resourceId: created.id,
          newValues: {
            assignmentId,
            dutyId: context.duty_id,
            employeeId: employee.id,
            submissionVersion: version,
            status: 'OPEN',
            needId: need.id,
          },
        });
        const done = await c.query(
          `WITH moment AS (SELECT clock_timestamp() AS at)
          UPDATE public.idempotency_records SET state='COMPLETED',result_cancellation_request_id=$4,
          completed_at=moment.at,expires_at=moment.at+$5::int*interval '1 second' FROM moment
          WHERE company_id=$1 AND id=$2 AND attempt_id=$3 AND state='IN_PROGRESS'`,
          [t.companyId, claim.id, claim.attempt_id, created.id, RETENTION],
        );
        if (done.rowCount !== 1)
          throw new Error('Cancellation completion lost its fence');
        return {
          result: await this.resource(c, t, created.id, employee.id),
          replayed: false,
        };
      });
    } catch (error) {
      // An acknowledged or unacknowledged successful COMMIT is never downgraded.
      await this.database
        .withTransaction(async (c) => {
          await c.query(PLANNING_WRITER_TIMEOUTS);
          await lockAccountsPrefix(c, t, ['EMPLOYEE']);
          await assertSessionInTransaction(c, t);
          await reservationLock(c, lockId);
          await c.query(
            `UPDATE public.idempotency_records SET state='FAILED'
          WHERE company_id=$1 AND actor_account_id=$2 AND operation=$3 AND key_hash=$4 AND id=$5 AND attempt_id=$6 AND state='IN_PROGRESS'`,
            [t.companyId, t.accountId, OP, keyHash, claim.id, claim.attempt_id],
          );
        })
        .catch(() => {});
      throw error;
    }
  }
}
