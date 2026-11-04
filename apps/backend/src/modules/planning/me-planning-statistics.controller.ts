import { Controller, Get, Query } from '@nestjs/common';
import { RequireRoles } from '../../auth/authorization/access-metadata.js';
import { CurrentTenant } from '../../auth/authorization/current-tenant.decorator.js';
import type { TenantContext } from '../../auth/authorization/tenant-context.js';
import { MyMonthlyPlansQueryDto } from './dto/my-monthly-plans-query.dto.js';
import { MePlanningStatisticsService } from './me-planning-statistics.service.js';

@Controller('api/v1/me/planning-statistics')
export class MePlanningStatisticsController {
  constructor(private readonly statistics: MePlanningStatisticsService) {}

  @Get()
  @RequireRoles('EMPLOYEE')
  read(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: MyMonthlyPlansQueryDto,
  ) {
    return this.statistics.read(tenant, query.monthStart);
  }
}
