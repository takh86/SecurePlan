import { Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../../auth/authorization/tenant-context.js';
import { assertSessionInTransaction } from '../../auth/session.service.js';
import { DatabaseService } from '../../database/database.service.js';
import { lockAccountsPrefix } from '../identity/account-prefix-lock.js';
import { PLANNING_WRITER_TIMEOUTS } from '../planning/planning-locks.js';
import { assertPlanningSchemaComplete } from '../planning/planning-schema.js';
import { assertEmployeeMonthReceiptSchema } from '../planning/employee-month-receipt-schema.js';
import { isCivilDate, isNamedTimeZone, isUtcSecond } from '../../common/time/civil-time.js';
import { detailSql, queueSql } from './admin-work-queue.query.js';
import type { AdminOffer, AdminOfferContext, AdminQueueItem, OffersQuery, QueueQuery } from './admin-work-queue.types.js';

type PageRow<T> = { invalid: boolean; total: number; items: T[] };
type DetailRow = PageRow<AdminOffer> & { found: number; context: AdminOfferContext | null };
function page(totalItems: number, pageNumber: number, pageSize: number) {
  if (!Number.isSafeInteger(totalItems) || totalItems < 0) throw new Error('Invalid page count');
  return { page: pageNumber, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) };
}
function assertProjection(duty: AdminQueueItem['duty'], month: string, timeZone: string, raw: number, eligible: number) {
  if (!isCivilDate(month) || !month.endsWith('-01') || !isCivilDate(duty.dutyDate) ||
      duty.dutyDate.slice(0, 7) !== month.slice(0, 7) || !isNamedTimeZone(timeZone) ||
      !isUtcSecond(duty.startsAt) || !isUtcSecond(duty.endsAt) || duty.startsAt >= duty.endsAt ||
      !['DAY', 'NIGHT'].includes(duty.shiftKind) || !Number.isSafeInteger(raw) || raw < 0 ||
      !Number.isSafeInteger(eligible) || eligible < 0 || eligible > raw)
    throw new Error('Invalid administrative workflow projection');
}
@Injectable()
export class AdminWorkQueueService {
  constructor(private readonly database: DatabaseService) {}
  private read<T>(tenant: TenantContext, run: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.database.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await client.query(PLANNING_WRITER_TIMEOUTS);
      await lockAccountsPrefix(client, tenant, ['COMPANY_ADMIN']);
      await assertSessionInTransaction(client, tenant);
      await assertPlanningSchemaComplete(client);
      await assertEmployeeMonthReceiptSchema(client);
      const result = await run(client);
      await assertSessionInTransaction(client, tenant);
      return result;
    });
  }
  queue(tenant: TenantContext, query: QueueQuery) {
    return this.read(tenant, async (client) => {
      const row = (await client.query<PageRow<AdminQueueItem> & { project_visible: boolean; evaluated_at: string }>(
        queueSql(query.sortBy, query.sortOrder), [tenant.companyId, null, null, query.projectId, query.monthStart,
          query.type, query.offerPresence, query.pageSize, (query.page - 1) * query.pageSize],
      )).rows[0];
      if (!row.project_visible) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
      if (row.invalid) throw new Error('Inconsistent administrative workflow state');
      for (const item of row.items) assertProjection(item.duty, item.monthStart, item.timeZone, item.openOfferCount, item.eligibleOpenOfferCount);
      return { items: row.items, pagination: page(row.total, query.page, query.pageSize), evaluatedAt: row.evaluated_at };
    });
  }
  private detail(tenant: TenantContext, requestId: string | null, needId: string | null, query: OffersQuery) {
    return this.read(tenant, async (client) => {
      const row = (await client.query<DetailRow>(detailSql, [tenant.companyId, requestId, needId, query.status, query.pageSize,
        (query.page - 1) * query.pageSize])).rows[0];
      if (!row.found) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
      if (row.invalid || !row.context || row.found !== 1) throw new Error('Inconsistent administrative workflow state');
      assertProjection(row.context.need.duty, row.context.monthStart, row.context.need.timeZone,
        row.context.need.openOfferCount, row.context.eligibleOpenOfferCount);
      return { items: row.items, pagination: page(row.total, query.page, query.pageSize), context: row.context };
    });
  }
  async cancellation(tenant: TenantContext, id: string) {
    return (await this.detail(tenant, id, null, { status: null, page: 1, pageSize: 1 })).context.cancellation;
  }
  async need(tenant: TenantContext, id: string) {
    return (await this.detail(tenant, null, id, { status: null, page: 1, pageSize: 1 })).context.need;
  }
  offers(tenant: TenantContext, id: string, query: OffersQuery) { return this.detail(tenant, null, id, query); }
}
