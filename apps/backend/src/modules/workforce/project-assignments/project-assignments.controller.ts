import { Body, Controller, Get, Header, HttpCode, Post, Query } from '@nestjs/common';
import { RequireRoles } from '../../../auth/authorization/access-metadata.js';
import { CurrentTenant } from '../../../auth/authorization/current-tenant.decorator.js';
import type { TenantContext } from '../../../auth/authorization/tenant-context.js';
import { CorrelationId } from '../../../common/http/correlation-id.decorator.js';
import { CreateProjectAssignmentDto, ListProjectAssignmentsQueryDto } from './dto/project-assignment.dto.js';
import { ProjectAssignmentsService } from './project-assignments.service.js';

/**
 * SP-09 month-scoped project assignments (create/read slice; the correction
 * PATCH is not implemented yet, and there is deliberately no DELETE).
 * COMPANY_ADMIN of the session's own company only. Origin, session, CSRF
 * (unsafe methods) and the live role are enforced by the global
 * AccessControlGuard; tenant scope and 404 concealment in the service SQL.
 */
@Controller('api/v1/project-assignments')
export class ProjectAssignmentsController {
  constructor(private readonly assignments: ProjectAssignmentsService) {}

  @Get()
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  list(@CurrentTenant() tenant: TenantContext, @Query() query: ListProjectAssignmentsQueryDto) {
    return this.assignments.list(tenant, query);
  }

  @Post()
  @HttpCode(201)
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  create(
    @CurrentTenant() tenant: TenantContext,
    @CorrelationId() correlationId: string,
    @Body() dto: CreateProjectAssignmentDto,
  ) {
    return this.assignments.create(tenant, dto, correlationId);
  }
}
