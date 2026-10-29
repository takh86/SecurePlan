import { Body, Controller, Delete, Get, Header, Headers, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { RequireRoles } from '../../../auth/authorization/access-metadata.js';
import { CurrentTenant } from '../../../auth/authorization/current-tenant.decorator.js';
import type { TenantContext } from '../../../auth/authorization/tenant-context.js';
import { CorrelationId } from '../../../common/http/correlation-id.decorator.js';
import { parseExpectedVersion } from '../../../common/http/expected-version.js';
import { ResourceIdPipe } from '../../../common/http/resource-id.pipe.js';
import {
  CreateProjectAssignmentDto,
  ListProjectAssignmentsQueryDto,
  UpdateProjectAssignmentDto,
} from './dto/project-assignment.dto.js';
import { ProjectAssignmentsService } from './project-assignments.service.js';

/**
 * SP-09 month-scoped project assignments: create, read and correction PATCH;
 * DELETE only for assignments of months after the company's current month
 * (#73), so current and past months (history) stay.
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

  @Patch(':assignmentId')
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  correct(
    @CurrentTenant() tenant: TenantContext,
    @CorrelationId() correlationId: string,
    @Param('assignmentId', ResourceIdPipe) assignmentId: string,
    @Body() dto: UpdateProjectAssignmentDto,
  ) {
    return this.assignments.correct(tenant, assignmentId, dto, correlationId);
  }

  /**
   * #73: 204 without body. No request body or query is read; If-Match has no
   * effect. Precedence: guard -> 404 id format (pipe) -> 400 Expected-Version
   * (first handler statement) -> service checks.
   */
  @Delete(':assignmentId')
  @HttpCode(204)
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  async remove(
    @CurrentTenant() tenant: TenantContext,
    @CorrelationId() correlationId: string,
    @Param('assignmentId', ResourceIdPipe) assignmentId: string,
    // Raw value on purpose: NestJS runs no pipes on @Headers() (a pipe would fail open).
    @Headers('expected-version') expectedVersionHeader: string | undefined,
  ): Promise<void> {
    const expectedVersion = parseExpectedVersion(expectedVersionHeader);
    await this.assignments.remove(tenant, assignmentId, expectedVersion, correlationId);
  }
}
