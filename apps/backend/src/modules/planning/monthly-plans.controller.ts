import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RequireRoles } from '../../auth/authorization/access-metadata.js';
import { CurrentTenant } from '../../auth/authorization/current-tenant.decorator.js';
import type { TenantContext } from '../../auth/authorization/tenant-context.js';
import { CorrelationId } from '../../common/http/correlation-id.decorator.js';
import { ResourceIdPipe } from '../../common/http/resource-id.pipe.js';
import {
  CreateMonthlyPlanDto,
  CreateMonthlyPlanEntryDto,
  ListMonthlyPlanEntriesQueryDto,
  ListMonthlyPlansQueryDto,
} from './dto/monthly-plan.dto.js';
import { MonthlyPlansService } from './monthly-plans.service.js';

/**
 * SP-11 PR-1 planning slice: five routes, COMPANY_ADMIN of the session's own
 * company only. Origin, session, CSRF (unsafe methods) and the live role are
 * enforced by the global AccessControlGuard; tenant scope and 404 concealment
 * in MonthlyPlansService SQL. No publish, edit, removal or lease route exists
 * yet (SP-12/SP-13), and no Idempotency-Key is required on these creates
 * (Phase 8.7: database uniqueness prevents duplicate effects).
 */
@Controller('api/v1/monthly-plans')
export class MonthlyPlansController {
  constructor(private readonly plans: MonthlyPlansService) {}

  @Get()
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  list(@CurrentTenant() tenant: TenantContext, @Query() query: ListMonthlyPlansQueryDto) {
    return this.plans.list(tenant, query);
  }

  @Post()
  @HttpCode(201)
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  async create(
    @CurrentTenant() tenant: TenantContext,
    @CorrelationId() correlationId: string,
    @Body() dto: CreateMonthlyPlanDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const plan = await this.plans.create(tenant, dto, correlationId);
    response.location(`/api/v1/monthly-plans/${plan.id}`);
    return plan;
  }

  @Get(':planId')
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  get(@CurrentTenant() tenant: TenantContext, @Param('planId', ResourceIdPipe) planId: string) {
    return this.plans.get(tenant, planId);
  }

  @Get(':planId/entries')
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  listEntries(
    @CurrentTenant() tenant: TenantContext,
    @Param('planId', ResourceIdPipe) planId: string,
    @Query() query: ListMonthlyPlanEntriesQueryDto,
  ) {
    return this.plans.listEntries(tenant, planId, query);
  }

  /** Location names the entry resource that the SP-12 PATCH/DELETE address (Phase 8.2/8.3). */
  @Post(':planId/entries')
  @HttpCode(201)
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  async createEntry(
    @CurrentTenant() tenant: TenantContext,
    @CorrelationId() correlationId: string,
    @Param('planId', ResourceIdPipe) planId: string,
    @Body() dto: CreateMonthlyPlanEntryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const entry = await this.plans.createEntry(tenant, planId, dto, correlationId);
    response.location(`/api/v1/monthly-plans/${planId}/entries/${entry.id}`);
    return entry;
  }
}
