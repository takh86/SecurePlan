import { Body, Controller, HttpCode, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { LoginAbuseService, LoginRateLimitedError, type LoginAttemptReservation } from './login-abuse.service.js';
import { LoginDto } from './dto/login.dto.js';
import { LoginOriginGuard } from './login-origin.guard.js';
import { LoginService, type LoginResult } from './login.service.js';
import { Public } from './authorization/access-metadata.js';

/** Login HTTP boundary: raw token goes into a Secure host-only cookie, never JSON. */
@Controller('api/v1/auth')
export class LoginController {
  constructor(
    private readonly loginService: LoginService,
    private readonly abuse: LoginAbuseService,
  ) {}

  @Post('login')
  @HttpCode(200)
  @Public()
  @UseGuards(LoginOriginGuard)
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');

    // Use only the direct TCP peer. Never trust spoofable X-Forwarded-For.
    // A future reverse proxy must have an explicit trusted-peer contract.
    let ticket: LoginAttemptReservation;
    try {
      ticket = await this.abuse.beginAttempt(dto.email, request.socket.remoteAddress);
    } catch (error) {
      if (error instanceof LoginRateLimitedError) {
        res.setHeader('Retry-After', String(error.retryAfterSeconds));
      }
      throw error;
    }

    let result: LoginResult;
    try {
      result = await this.loginService.login(dto);
    } catch (error) {
      const response = error instanceof UnauthorizedException
        ? error.getResponse() : null;
      const isInvalidCredentials = typeof response === 'object'
        && response !== null && 'code' in response
        && response.code === 'INVALID_CREDENTIALS';
      await this.abuse.finishAttempt(ticket, isInvalidCredentials ? 'failure' : 'aborted');
      throw error;
    }
    // If shared counter persistence fails, fail closed: do not issue the cookie.
    await this.abuse.finishAttempt(ticket, 'success');
    const maxAgeSeconds = Math.max(
      0,
      Math.floor((result.absoluteExpiresAt.getTime() - Date.now()) / 1000),
    );

    res.setHeader(
      'Set-Cookie',
      `__Host-secureplan_session=${result.rawToken}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`,
    );
    res.setHeader('X-CSRF-Token', result.csrfToken);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');

    // No raw token, CSRF token, password or password hash in JSON.
    return {
      accountId: result.accountId,
      companyId: result.companyId,
      email: result.email,
      role: result.role,
    };
  }
}
