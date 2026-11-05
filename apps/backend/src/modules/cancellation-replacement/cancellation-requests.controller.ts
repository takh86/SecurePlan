import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
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
import { AdminWorkQueueService } from './admin-work-queue.service.js';
import { assertEmptyGetBody, assertNoAdminQuery } from './admin-work-queue.types.js';
@Controller('api/v1/cancellation-requests')
export class CancellationRequestsController {
  constructor(private readonly cancellations: CancellationRequestsService, private readonly admin: AdminWorkQueueService) {}
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
  @Post(':requestId/withdraw')
  @HttpCode(200)
  @RequireRoles('EMPLOYEE')
  withdraw(
    @CurrentTenant() t: TenantContext,
    @Param('requestId', ResourceIdPipe) id: string,
    @CorrelationId() correlationId: string,
    @Req() request: Request,
  ) {
    if (
      request.headers['transfer-encoding'] !== undefined ||
      Number(request.headers['content-length'] ?? 0) > 0
    )
      throw new BadRequestException({ code: 'INVALID_REQUEST_BODY' });
    return this.cancellations.withdraw(t, id, correlationId);
  }
  @Get(':requestId')
  @RequireRoles('EMPLOYEE', 'COMPANY_ADMIN')
  get(
    @CurrentTenant() t: TenantContext,
    @Param('requestId', ResourceIdPipe) id: string,
    @Req() request: Request,
  ) {
    if (t.role === 'COMPANY_ADMIN') {
      assertEmptyGetBody(request);
      assertNoAdminQuery(request.query);
      return this.admin.cancellation(t, id);
    }
    return this.cancellations.get(t, id);
  }
}
