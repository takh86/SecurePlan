import { Body, Controller, Get, Header, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { PlanningJsonGuard } from '../../planning/planning-json.guard.js';
import { RequireRoles } from '../../../auth/authorization/access-metadata.js';
import { CurrentTenant } from '../../../auth/authorization/current-tenant.decorator.js';
import type { TenantContext } from '../../../auth/authorization/tenant-context.js';
import { CorrelationId } from '../../../common/http/correlation-id.decorator.js';
import { ResourceIdPipe } from '../../../common/http/resource-id.pipe.js';
import { CalendarQueryDto, UpdateCalendarDto } from './operating-calendar.dto.js';
import { OperatingCalendarService } from './operating-calendar.service.js';

@Controller('api/v1/projects/:projectId/operating-calendar')
export class OperatingCalendarController {
  constructor(private readonly calendars: OperatingCalendarService) {}
  @Get() @RequireRoles('COMPANY_ADMIN') @Header('Cache-Control', 'no-store')
  get(@CurrentTenant() tenant: TenantContext, @Param('projectId', ResourceIdPipe) projectId: string, @Query() query: CalendarQueryDto) {
    return this.calendars.get(tenant, projectId, query.effectiveForMonth);
  }
  @Patch() @RequireRoles('COMPANY_ADMIN') @Header('Cache-Control', 'no-store')
  @UseGuards(PlanningJsonGuard)
  replace(@CurrentTenant() tenant: TenantContext, @Param('projectId', ResourceIdPipe) projectId: string,
    @Body() dto: UpdateCalendarDto, @CorrelationId() correlationId: string) {
    return this.calendars.replace(tenant, projectId, dto, correlationId);
  }
}
