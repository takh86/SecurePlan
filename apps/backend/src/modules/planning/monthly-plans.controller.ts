import { BadRequestException, Body, Controller, Delete, Get, Header, Headers, HttpCode, HttpException, Param, Patch, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RequireRoles } from '../../auth/authorization/access-metadata.js';
import { CurrentTenant } from '../../auth/authorization/current-tenant.decorator.js';
import type { TenantContext } from '../../auth/authorization/tenant-context.js';
import { CorrelationId } from '../../common/http/correlation-id.decorator.js';
import { ResourceIdPipe } from '../../common/http/resource-id.pipe.js';
import { parseExpectedVersion } from '../../common/http/expected-version.js';
import { parseIdempotencyKey } from '../../common/http/idempotency-key.js';
import { requireEditLeaseHeader } from './duty-edit-leases.js';
import {
  CreateMonthlyPlanDto,
  CreateMonthlyPlanEntryDto,
  ListMonthlyPlanEntriesQueryDto,
  ListMonthlyPlansQueryDto,
  UpdateMonthlyPlanEntryDto,
} from './dto/monthly-plan.dto.js';
import { MonthlyPlansService } from './monthly-plans.service.js';
import { PlanningJsonGuard } from './planning-json.guard.js';

/**
 * SP-11 foundation and SP-12 single-entry read: COMPANY_ADMIN of the session's own
 * company only. Origin, session, CSRF (unsafe methods) and the live role are
 * enforced by the global AccessControlGuard; tenant scope and 404 concealment
 * in MonthlyPlansService SQL. SP-12 interactive PATCH/DELETE require a lease
 * and Expected-Version. First publish requires request idempotency (SP-13).
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
  @UseGuards(PlanningJsonGuard)
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

  @Post(':planId/publish')
  @HttpCode(200)
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  async publish(
    @CurrentTenant() tenant: TenantContext,
    @CorrelationId() correlationId: string,
    @Param('planId', ResourceIdPipe) planId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const key = parseIdempotencyKey(request);
    if (request.headers['transfer-encoding'] !== undefined || Number(request.headers['content-length'] ?? 0) > 0) {
      throw new BadRequestException({ code: 'INVALID_REQUEST_BODY' });
    }
    try {
      const outcome = await this.plans.publish(tenant, planId, key, correlationId);
      response.setHeader('Idempotency-Replayed', String(outcome.replayed));
      return outcome.result;
    } catch (error) {
      if (error instanceof HttpException && (error.getResponse() as { code?: string }).code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS') {
        response.setHeader('Retry-After', '1');
      }
      throw error;
    }
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

  @Get(':planId/entries/:entryId')
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  getEntry(
    @CurrentTenant() tenant: TenantContext,
    @Param('planId', ResourceIdPipe) planId: string,
    @Param('entryId', ResourceIdPipe) entryId: string,
  ) {
    return this.plans.getEntry(tenant, planId, entryId);
  }

  @Patch(':planId/entries/:entryId')
  @UseGuards(PlanningJsonGuard)
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  updateEntry(
    @CurrentTenant() tenant: TenantContext,
    @CorrelationId() correlationId: string,
    @Param('planId', ResourceIdPipe) planId: string,
    @Param('entryId', ResourceIdPipe) entryId: string,
    @Headers('expected-version') versionHeader: string | string[] | undefined,
    @Headers('edit-lease-token') leaseHeader: string | string[] | undefined,
    @Body() dto: UpdateMonthlyPlanEntryDto,
  ) {
    const version = parseExpectedVersion(versionHeader);
    const token = requireEditLeaseHeader(leaseHeader);
    return this.plans.updateEntry(tenant, planId, entryId, dto, version, token, correlationId);
  }

  @Delete(':planId/entries/:entryId')
  @HttpCode(204)
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  removeEntry(
    @CurrentTenant() tenant: TenantContext,
    @CorrelationId() correlationId: string,
    @Param('planId', ResourceIdPipe) planId: string,
    @Param('entryId', ResourceIdPipe) entryId: string,
    @Headers('expected-version') versionHeader: string | string[] | undefined,
    @Headers('edit-lease-token') leaseHeader: string | string[] | undefined,
  ) {
    const version = parseExpectedVersion(versionHeader);
    const token = requireEditLeaseHeader(leaseHeader);
    return this.plans.removeEntry(tenant, planId, entryId, version, token, correlationId);
  }

  @Post(':planId/entries/:entryId/edit-lease')
  @HttpCode(200)
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  acquireLease(
    @CurrentTenant() tenant: TenantContext,
    @Param('planId', ResourceIdPipe) planId: string,
    @Param('entryId', ResourceIdPipe) entryId: string,
  ) {
    return this.plans.acquireLease(tenant, planId, entryId);
  }

  @Put(':planId/entries/:entryId/edit-lease')
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  renewLease(
    @CurrentTenant() tenant: TenantContext,
    @Param('planId', ResourceIdPipe) planId: string,
    @Param('entryId', ResourceIdPipe) entryId: string,
    @Headers('edit-lease-token') leaseHeader: string | string[] | undefined,
  ) {
    return this.plans.renewLease(tenant, planId, entryId, requireEditLeaseHeader(leaseHeader));
  }

  @Delete(':planId/entries/:entryId/edit-lease')
  @HttpCode(204)
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  releaseLease(
    @CurrentTenant() tenant: TenantContext,
    @Param('planId', ResourceIdPipe) planId: string,
    @Param('entryId', ResourceIdPipe) entryId: string,
    @Headers('edit-lease-token') leaseHeader: string | string[] | undefined,
  ) {
    return this.plans.releaseLease(tenant, planId, entryId, requireEditLeaseHeader(leaseHeader));
  }

  /** Location names the entry resource (Phase 8.2/8.3; dereferenceable since SP-12). */
  @Post(':planId/entries')
  @UseGuards(PlanningJsonGuard)
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
    response.location(`/api/v1/monthly-plans/${planId.toLowerCase()}/entries/${entry.id}`);
    return entry;
  }
}
