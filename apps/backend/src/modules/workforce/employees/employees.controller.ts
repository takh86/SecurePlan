import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { RequireRoles } from '../../../auth/authorization/access-metadata.js';
import { CurrentTenant } from '../../../auth/authorization/current-tenant.decorator.js';
import type { TenantContext } from '../../../auth/authorization/tenant-context.js';
import { CorrelationId } from '../../../common/http/correlation-id.decorator.js';
import { ResourceIdPipe } from '../../../common/http/resource-id.pipe.js';
import { CreateEmployeeDto, ListEmployeesQueryDto, UpdateEmployeeDto } from './dto/employee.dto.js';
import { EmployeesService } from './employees.service.js';

/**
 * SP-07 employee administration. COMPANY_ADMIN of the session's own company
 * only. Origin, session, CSRF (unsafe methods) and the live role are enforced
 * by the global AccessControlGuard before any handler runs; tenant scope and
 * 404 concealment are enforced in EmployeesService SQL.
 */
@Controller('api/v1/employees')
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  list(@CurrentTenant() tenant: TenantContext, @Query() query: ListEmployeesQueryDto) {
    return this.employees.list(tenant, query);
  }

  @Get(':employeeId')
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  get(
    @CurrentTenant() tenant: TenantContext,
    @Param('employeeId', ResourceIdPipe) employeeId: string,
  ) {
    return this.employees.get(tenant, employeeId);
  }

  @Post()
  @HttpCode(201)
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  create(
    @CurrentTenant() tenant: TenantContext,
    @CorrelationId() correlationId: string,
    @Body() dto: CreateEmployeeDto,
  ) {
    return this.employees.create(tenant, dto, correlationId);
  }

  @Patch(':employeeId')
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  update(
    @CurrentTenant() tenant: TenantContext,
    @CorrelationId() correlationId: string,
    @Param('employeeId', ResourceIdPipe) employeeId: string,
    @Body() dto: UpdateEmployeeDto,
  ) {
    return this.employees.update(tenant, employeeId, dto, correlationId);
  }

  @Post(':employeeId/deactivate')
  @HttpCode(200)
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  deactivate(
    @CurrentTenant() tenant: TenantContext,
    @CorrelationId() correlationId: string,
    @Param('employeeId', ResourceIdPipe) employeeId: string,
    @Body() body: unknown,
  ) {
    // Domain action without payload. No body or an empty JSON object is tolerated.
    if (body !== undefined && (
      body === null ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length > 0
    )) {
      throw new BadRequestException({ code: 'INVALID_REQUEST_BODY' });
    }
    return this.employees.deactivate(tenant, employeeId, correlationId);
  }
}
