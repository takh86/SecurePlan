import { Controller, Get, Query } from '@nestjs/common';
import { RequireRoles } from '../../auth/authorization/access-metadata.js';
import { CurrentTenant } from '../../auth/authorization/current-tenant.decorator.js';
import type { TenantContext } from '../../auth/authorization/tenant-context.js';
import { MyMonthlyPlansQueryDto } from './dto/my-monthly-plans-query.dto.js';
import { MeMonthlyPlansReadService } from './me-monthly-plans-read.service.js';

@Controller('api/v1/me/monthly-plans')
export class MeMonthlyPlansController {
  constructor(private readonly plans: MeMonthlyPlansReadService) {}

  @Get()
  @RequireRoles('EMPLOYEE')
  read(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: MyMonthlyPlansQueryDto,
  ) {
    return this.plans.read(tenant, query.monthStart);
  }
}
