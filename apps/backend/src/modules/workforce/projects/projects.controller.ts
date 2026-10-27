import { Body, Controller, Get, Header, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { RequireRoles } from '../../../auth/authorization/access-metadata.js';
import { CurrentTenant } from '../../../auth/authorization/current-tenant.decorator.js';
import type { TenantContext } from '../../../auth/authorization/tenant-context.js';
import { CorrelationId } from '../../../common/http/correlation-id.decorator.js';
import { ResourceIdPipe } from '../../../common/http/resource-id.pipe.js';
import { CreateProjectDto, ListProjectsQueryDto, UpdateProjectDto } from './dto/project.dto.js';
import { ProjectsService } from './projects.service.js';

/**
 * SP-08 project administration (minimal slice: no shift configuration yet).
 * COMPANY_ADMIN of the session's own company only. Origin, session, CSRF
 * (unsafe methods) and the live role are enforced by the global
 * AccessControlGuard; tenant scope and 404 concealment in ProjectsService SQL.
 */
@Controller('api/v1/projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  list(@CurrentTenant() tenant: TenantContext, @Query() query: ListProjectsQueryDto) {
    return this.projects.list(tenant, query);
  }

  @Get(':projectId')
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  get(
    @CurrentTenant() tenant: TenantContext,
    @Param('projectId', ResourceIdPipe) projectId: string,
  ) {
    return this.projects.get(tenant, projectId);
  }

  @Post()
  @HttpCode(201)
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  create(
    @CurrentTenant() tenant: TenantContext,
    @CorrelationId() correlationId: string,
    @Body() dto: CreateProjectDto,
  ) {
    return this.projects.create(tenant, dto, correlationId);
  }

  @Patch(':projectId')
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  update(
    @CurrentTenant() tenant: TenantContext,
    @CorrelationId() correlationId: string,
    @Param('projectId', ResourceIdPipe) projectId: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projects.update(tenant, projectId, dto, correlationId);
  }
}
