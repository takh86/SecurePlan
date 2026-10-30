import { Body, Controller, Get, Header, HttpCode, HttpException, Param, Post, Query, Req, Res } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RequireRoles } from '../../../auth/authorization/access-metadata.js';
import { CurrentTenant } from '../../../auth/authorization/current-tenant.decorator.js';
import type { TenantContext } from '../../../auth/authorization/tenant-context.js';
import { CorrelationId } from '../../../common/http/correlation-id.decorator.js';
import { ResourceIdPipe } from '../../../common/http/resource-id.pipe.js';
import { AvailabilityService } from './availability.service.js';
import { AvailabilityCommitDto, AvailabilityMonthQueryDto, AvailabilitySelectionDto } from './dto/availability.dto.js';

export function parseIdempotencyKey(request: Pick<Request, 'headers' | 'rawHeaders'>): string {
  const key = request.headers['idempotency-key'];
  if (key === undefined) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  const count = request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'idempotency-key').length;
  if (count !== 1 || typeof key !== 'string' || !/^[\x21-\x7e]{8,128}$/.test(key)) {
    throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_INVALID' });
  }
  return key;
}

@Controller('api/v1/employees/:employeeId/availability')
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get() @RequireRoles('COMPANY_ADMIN') @Header('Cache-Control', 'no-store')
  list(@CurrentTenant() tenant: TenantContext, @Param('employeeId', ResourceIdPipe) employeeId: string,
    @Query() query: AvailabilityMonthQueryDto) {
    return this.availability.list(tenant, employeeId, query.monthStart);
  }

  @Post('preview') @HttpCode(200) @RequireRoles('COMPANY_ADMIN') @Header('Cache-Control', 'no-store')
  preview(@CurrentTenant() tenant: TenantContext, @Param('employeeId', ResourceIdPipe) employeeId: string,
    @Body() body: AvailabilitySelectionDto) {
    return this.availability.preview(tenant, employeeId, body);
  }

  @Post('batch') @HttpCode(200) @RequireRoles('COMPANY_ADMIN') @Header('Cache-Control', 'no-store')
  async commit(@CurrentTenant() tenant: TenantContext, @Param('employeeId', ResourceIdPipe) employeeId: string,
    @Body() body: AvailabilityCommitDto, @CorrelationId() correlationId: string,
    @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const key = parseIdempotencyKey(request);
    try {
      const outcome = await this.availability.commit(tenant, employeeId, body, key, correlationId);
      response.setHeader('Idempotency-Replayed', String(outcome.replayed));
      return outcome.result;
    } catch (error) {
      if (error instanceof HttpException && (error.getResponse() as { code?: string }).code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS') {
        response.setHeader('Retry-After', '1');
      }
      throw error;
    }
  }
}
