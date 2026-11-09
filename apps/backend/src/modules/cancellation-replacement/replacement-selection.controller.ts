import { Body, Controller, Headers, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RequireRoles } from '../../auth/authorization/access-metadata.js';
import { CurrentTenant } from '../../auth/authorization/current-tenant.decorator.js';
import type { TenantContext } from '../../auth/authorization/tenant-context.js';
import { CorrelationId } from '../../common/http/correlation-id.decorator.js';
import { parseExpectedVersion } from '../../common/http/expected-version.js';
import { parseIdempotencyKey } from '../../common/http/idempotency-key.js';
import { ResourceIdPipe } from '../../common/http/resource-id.pipe.js';
import { PlanningJsonGuard } from '../planning/planning-json.guard.js';
import { SelectReplacementDto } from './replacement-selection.dto.js';
import { ReplacementSelectionService } from './replacement-selection.service.js';

@Controller('api/v1/replacement-needs')
export class ReplacementSelectionController {
  constructor(private readonly selection: ReplacementSelectionService) {}

  @Post(':needId/selection')
  @HttpCode(200)
  @RequireRoles('COMPANY_ADMIN')
  @UseGuards(PlanningJsonGuard)
  async select(
    @CurrentTenant() t: TenantContext,
    @Param('needId', ResourceIdPipe) needId: string,
    @Body() dto: SelectReplacementDto,
    @Headers('expected-version') header: string | string[] | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @CorrelationId() correlationId: string,
  ) {
    const expectedVersion = parseExpectedVersion(header);
    const key = parseIdempotencyKey(request);
    const result = await this.selection.select(t, needId, dto.offerId.toLowerCase(), expectedVersion, key, correlationId);
    if (result.replayed) response.setHeader('Idempotency-Replayed', 'true');
    return result.result;
  }
}
