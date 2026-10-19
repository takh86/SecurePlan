import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { SessionService, assertSessionCsrf } from './session.service.js';
import { LoginOriginGuard } from './login-origin.guard.js';
import { SessionCookieGuard, type AuthenticatedSessionRequest } from './session-cookie.guard.js';

const COOKIE_NAME = '__Host-secureplan_session';

/** Authenticated identity endpoints: only authoritative DB session context is returned. */
@Controller('api/v1')
export class SessionController {
  constructor(private readonly sessions: SessionService) {}

  @Get('me')
  @UseGuards(SessionCookieGuard)
  me(@Req() request: AuthenticatedSessionRequest, @Res({ passthrough: true }) response: Response) {
    const session = request.validatedSession!; // Populated by SessionCookieGuard.
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
  @UseGuards(LoginOriginGuard, SessionCookieGuard)
  async logout(
    @Req() request: AuthenticatedSessionRequest,
    @Headers('x-csrf-token') suppliedCsrf: string | undefined,
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
    const session = request.validatedSession!;
    assertSessionCsrf(suppliedCsrf, session.csrfToken);
    const revoked = await this.sessions.revoke(request.rawSessionToken!);
    if (!revoked) throw new UnauthorizedException({ code: 'SESSION_REVOKED' });

    response.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
  }
}
