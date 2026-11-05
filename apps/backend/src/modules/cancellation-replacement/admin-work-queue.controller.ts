import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RequireRoles } from '../../auth/authorization/access-metadata.js';
import { CurrentTenant } from '../../auth/authorization/current-tenant.decorator.js';
import type { TenantContext } from '../../auth/authorization/tenant-context.js';
import { AdminWorkQueueService } from './admin-work-queue.service.js';
import { assertEmptyGetBody, queueQuery } from './admin-work-queue.types.js';

@Controller('api/v1/admin/work-queue')
export class AdminWorkQueueController {
  constructor(private readonly queue: AdminWorkQueueService) {}
  @Get()
  @RequireRoles('COMPANY_ADMIN')
  list(@CurrentTenant() tenant: TenantContext, @Query() query: Record<string, unknown>, @Req() request: Request) {
    assertEmptyGetBody(request);
    return this.queue.queue(tenant, queueQuery(query));
  }
}
