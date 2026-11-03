import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { RequireRoles } from '../../auth/authorization/access-metadata.js';
import { CurrentTenant } from '../../auth/authorization/current-tenant.decorator.js';
import type { TenantContext } from '../../auth/authorization/tenant-context.js';
import { CorrelationId } from '../../common/http/correlation-id.decorator.js';
import { ResourceIdPipe } from '../../common/http/resource-id.pipe.js';
import { parseIdempotencyKey } from '../../common/http/idempotency-key.js';
import { PlanningJsonGuard } from './planning-json.guard.js';
import {
  SaveEmployeeMonthPipe,
  type SaveEmployeeMonth,
} from './employee-month.contract.js';
import { EmployeeMonthService } from './employee-month.service.js';

@Controller('api/v1/monthly-plans/:planId/employee-months/:employeeId')
export class EmployeeMonthController {
  constructor(private readonly months: EmployeeMonthService) {}
  @Get()
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  read(
    @CurrentTenant() t: TenantContext,
    @Param('planId', ResourceIdPipe) planId: string,
    @Param('employeeId', ResourceIdPipe) employeeId: string,
  ) {
    return this.months.read(t, planId, employeeId);
  }
  @Get('save-result')
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  result(
    @CurrentTenant() t: TenantContext,
    @Param('planId', ResourceIdPipe) planId: string,
    @Param('employeeId', ResourceIdPipe) employeeId: string,
    @Req() req: Request,
  ) {
    return this.months.lookup(t, planId, employeeId, parseIdempotencyKey(req));
  }
  @Post('save')
  @RequireRoles('COMPANY_ADMIN')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @UseGuards(PlanningJsonGuard)
  async save(
    @CurrentTenant() t: TenantContext,
    @Param('planId', ResourceIdPipe) planId: string,
    @Param('employeeId', ResourceIdPipe) employeeId: string,
    @CorrelationId() correlationId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(SaveEmployeeMonthPipe) dto: SaveEmployeeMonth,
  ) {
    try {
      const saved = await this.months.save(
        t,
        planId,
        employeeId,
        parseIdempotencyKey(req),
        dto,
        correlationId,
      );
      res.setHeader('Idempotency-Replayed', String(saved.replayed));
      return saved.result;
    } catch (error) {
      if (
        error instanceof HttpException &&
        (error.getResponse() as { code?: string }).code ===
          'IDEMPOTENCY_REQUEST_IN_PROGRESS'
      )
        res.setHeader('Retry-After', '1');
      throw error;
    }
  }
}
