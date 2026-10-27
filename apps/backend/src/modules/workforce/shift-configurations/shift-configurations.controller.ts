import { Body, Controller, Get, Header, Param, Patch, Query } from '@nestjs/common';
import { RequireRoles } from '../../../auth/authorization/access-metadata.js';
import { CurrentTenant } from '../../../auth/authorization/current-tenant.decorator.js';
import type { TenantContext } from '../../../auth/authorization/tenant-context.js';
import { CorrelationId } from '../../../common/http/correlation-id.decorator.js';
import { ResourceIdPipe } from '../../../common/http/resource-id.pipe.js';
import { ShiftConfigurationQueryDto, UpdateShiftConfigurationDto } from './dto/shift-configuration.dto.js';
import { ShiftConfigurationsService } from './shift-configurations.service.js';

/**
 * SP-08b month-versioned project shift configuration (ADR-0003): read the
 * effective configuration for a month, replace the set of one effective month.
 * COMPANY_ADMIN of the session's own company only. Origin, session, CSRF
 * (unsafe methods) and the live role are enforced by the global
 * AccessControlGuard; tenant scope and 404 concealment in the service SQL.
 */
@Controller('api/v1/projects/:projectId/shift-configuration')
export class ShiftConfigurationsController {
  constructor(private readonly shiftConfigurations: ShiftConfigurationsService) {}

  @Get()
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  get(
    @CurrentTenant() tenant: TenantContext,
    @Param('projectId', ResourceIdPipe) projectId: string,
    @Query() query: ShiftConfigurationQueryDto,
  ) {
    return this.shiftConfigurations.getEffective(tenant, projectId, query);
  }

  @Patch()
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  replace(
    @CurrentTenant() tenant: TenantContext,
    @CorrelationId() correlationId: string,
    @Param('projectId', ResourceIdPipe) projectId: string,
    @Body() dto: UpdateShiftConfigurationDto,
  ) {
    return this.shiftConfigurations.replace(tenant, projectId, dto, correlationId);
  }
}
