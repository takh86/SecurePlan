import { Controller, Get, Query } from '@nestjs/common';
import { RequireRoles } from '../../auth/authorization/access-metadata.js';
import { CurrentTenant } from '../../auth/authorization/current-tenant.decorator.js';
import type { TenantContext } from '../../auth/authorization/tenant-context.js';
import { MyMonthlyPlansQueryDto } from '../planning/dto/my-monthly-plans-query.dto.js';
import { CancellationRequestsService } from './cancellation-requests.service.js';

@Controller('api/v1/me/work-items')
export class MeWorkItemsController {
  constructor(private readonly cancellations: CancellationRequestsService) {}

  @Get()
  @RequireRoles('EMPLOYEE')
  read(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: MyMonthlyPlansQueryDto,
  ) {
    return this.cancellations.ownWorkItems(tenant, query.monthStart);
  }
}
