import {
  Body,
  Controller,
  Get,
  Headers,
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
import { parseExpectedVersion } from '../../common/http/expected-version.js';
import { parseIdempotencyKey } from '../../common/http/idempotency-key.js';
import { PlanningJsonGuard } from '../planning/planning-json.guard.js';
import { CreateCancellationDto } from './cancellation.types.js';
import { CancellationRequestsService } from './cancellation-requests.service.js';
@Controller('api/v1/cancellation-requests')
export class CancellationRequestsController {
  constructor(private readonly cancellations: CancellationRequestsService) {}
  @Post()
  @RequireRoles('EMPLOYEE')
  @UseGuards(PlanningJsonGuard)
  async create(
    @CurrentTenant() t: TenantContext,
    @Body() dto: CreateCancellationDto,
    @Headers('expected-version') header: string | string[] | undefined,
    @Req() request: Request,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const version = parseExpectedVersion(header),
      key = parseIdempotencyKey(request);
    const result = await this.cancellations.create(
      t,
      dto.assignmentId.toLowerCase(),
      version,
      key,
      correlationId,
    );
    if (result.replayed) response.setHeader('Idempotency-Replayed', 'true');
    response.location(`/api/v1/cancellation-requests/${result.result.id}`);
    return result.result;
  }
  @Get(':requestId')
  @RequireRoles('EMPLOYEE', 'COMPANY_ADMIN')
  get(
    @CurrentTenant() t: TenantContext,
    @Param('requestId', ResourceIdPipe) id: string,
  ) {
    return this.cancellations.get(t, id);
  }
}
