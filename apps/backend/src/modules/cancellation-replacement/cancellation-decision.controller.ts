import {
  Body,
  Controller,
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
import { parseExpectedVersion } from '../../common/http/expected-version.js';
import { parseIdempotencyKey } from '../../common/http/idempotency-key.js';
import { ResourceIdPipe } from '../../common/http/resource-id.pipe.js';
import { PlanningJsonGuard } from '../planning/planning-json.guard.js';
import { assertNoAdminQuery } from './admin-work-queue.types.js';
import { CancellationDecisionBodyGuard } from './cancellation-decision-body.guard.js';
import { CancellationDecisionDto } from './cancellation-decision.dto.js';
import {
  CancellationDecisionService,
  type CancellationDecisionCommand,
} from './cancellation-decision.service.js';

@Controller('api/v1/cancellation-requests')
export class CancellationDecisionController {
  constructor(private readonly decisions: CancellationDecisionService) {}

  @Post(':requestId/decision')
  @HttpCode(200)
  @RequireRoles('COMPANY_ADMIN')
  @UseGuards(PlanningJsonGuard, CancellationDecisionBodyGuard)
  async decide(
    @CurrentTenant() tenant: TenantContext,
    @Param('requestId', ResourceIdPipe) requestId: string,
    @Body() dto: CancellationDecisionDto,
    @Headers('expected-version') header: string | string[] | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @CorrelationId() correlationId: string,
  ) {
    const expectedNeedVersion =
      dto.decision === 'APPROVE' || header !== undefined
        ? parseExpectedVersion(header)
        : undefined;
    const key = parseIdempotencyKey(request);
    assertNoAdminQuery(request.query);
    const command: CancellationDecisionCommand =
      dto.decision === 'APPROVE'
        ? {
            decision: 'APPROVE',
            requestId,
            expectedNeedVersion: expectedNeedVersion!,
            expectedDutyVersion: dto.expectedDutyVersion!,
          }
        : { decision: 'REJECT', requestId };
    const result = await this.decisions.decide(
      tenant,
      command,
      key,
      correlationId,
    );
    if (result.replayed) response.setHeader('Idempotency-Replayed', 'true');
    return result.result;
  }
}
