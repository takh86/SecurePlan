import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { SessionService, type ValidatedSession } from './session.service.js';
import { SESSION_COOKIE_NAME } from './session-cookie.js';
import { RequireRoles } from './authorization/access-metadata.js';
import { CurrentSession, CurrentSessionToken } from './authorization/current-tenant.decorator.js';

/**
 * Authenticated identity endpoints: only authoritative DB session context is returned.
 * Origin (unsafe methods), session, CSRF (unsafe methods) and role are enforced
 * by the global AccessControlGuard before these handlers run.
 */
@Controller('api/v1')
export class SessionController {
  constructor(private readonly sessions: SessionService) {}

  @Get('me')
  @RequireRoles('EMPLOYEE', 'COMPANY_ADMIN')
  me(@CurrentSession() session: ValidatedSession, @Res({ passthrough: true }) response: Response) {
    response.setHeader('X-CSRF-Token', session.csrfToken);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    return {
      accountId: session.accountId,
      companyId: session.companyId,
      email: session.email,
      role: session.role,
    };
  }

  @Post('auth/logout')
  @HttpCode(204)
  @RequireRoles('EMPLOYEE', 'COMPANY_ADMIN')
  async logout(
    @CurrentSessionToken() rawSessionToken: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    // No business payload on logout. An empty JSON object is tolerated.
    if (body !== undefined && (
      body === null ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length > 0
    )) {
      throw new BadRequestException({ code: 'INVALID_REQUEST_BODY' });
    }
    const revoked = await this.sessions.revoke(rawSessionToken);
    if (!revoked) throw new UnauthorizedException({ code: 'SESSION_REVOKED' });

    response.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
  }
}
