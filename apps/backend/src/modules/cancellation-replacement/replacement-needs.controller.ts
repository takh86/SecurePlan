import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { RequireRoles } from '../../auth/authorization/access-metadata.js';
import { CurrentTenant } from '../../auth/authorization/current-tenant.decorator.js';
import type { TenantContext } from '../../auth/authorization/tenant-context.js';
import { CorrelationId } from '../../common/http/correlation-id.decorator.js';
import { ResourceIdPipe } from '../../common/http/resource-id.pipe.js';
import { parseIdempotencyKey } from '../../common/http/idempotency-key.js';
import { ReplacementOffersService } from './replacement-offers.service.js';
function noQuery(request: Request) {
  if (Object.keys(request.query).length)
    throw new BadRequestException({ code: 'UNKNOWN_FIELD' });
}
function positive(value: unknown, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (
    typeof value !== 'string' ||
    !/^[1-9][0-9]*$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) > max
  )
    throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  return Number(value);
}
@Controller('api/v1/me/replacement-needs')
export class MeReplacementNeedsController {
  constructor(private readonly offers: ReplacementOffersService) {}
  @Get()
  @RequireRoles('EMPLOYEE')
  list(
    @CurrentTenant() t: TenantContext,
    @Query() query: Record<string, unknown>,
  ) {
    if (
      Object.keys(query).some(
        (k) => !['monthStart', 'page', 'pageSize'].includes(k),
      )
    )
      throw new BadRequestException({ code: 'UNKNOWN_FIELD' });
    if (typeof query.monthStart !== 'string')
      throw new BadRequestException({ code: 'INVALID_MONTH_START' });
    const pageSize = positive(query.pageSize, 25, 100),
      page = positive(query.page, 1, Math.floor(Number.MAX_SAFE_INTEGER / 100));
    return this.offers.list(t, query.monthStart, page, pageSize);
  }
}
@Controller('api/v1/replacement-needs')
export class ReplacementNeedsController {
  constructor(private readonly offers: ReplacementOffersService) {}
  @Get(':needId')
  @RequireRoles('EMPLOYEE')
  detail(
    @CurrentTenant() t: TenantContext,
    @Param('needId', ResourceIdPipe) id: string,
    @Req() req: Request,
  ) {
    noQuery(req);
    return this.offers.detail(t, id);
  }
  @Post(':needId/offers')
  @RequireRoles('EMPLOYEE')
  async create(
    @CurrentTenant() t: TenantContext,
    @Param('needId', ResourceIdPipe) id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @CorrelationId() correlationId: string,
  ) {
    noQuery(req);
    if (
      req.headers['transfer-encoding'] !== undefined ||
      Number(req.headers['content-length'] ?? 0) > 0
    )
      throw new BadRequestException({ code: 'INVALID_REQUEST_BODY' });
    const result = await this.offers.create(
      t,
      id,
      parseIdempotencyKey(req),
      correlationId,
    );
    if (result.replayed) res.setHeader('Idempotency-Replayed', 'true');
    return result.result;
  }
}
