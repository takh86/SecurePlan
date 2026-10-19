import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { SessionService, type ValidatedSession } from './session.service.js';

const COOKIE_NAME = '__Host-secureplan_session';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type AuthenticatedSessionRequest = Request & {
  validatedSession?: ValidatedSession;
  // Volatile server-only value. Never serialize/log this property.
  rawSessionToken?: string;
};

function extractSessionToken(cookieHeader: string | undefined): string {
  if (!cookieHeader) throw new UnauthorizedException({ code: 'SESSION_REQUIRED' });
  const matching = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${COOKIE_NAME}=`));

  // Duplicate cookies can create parser ambiguity and fixation/confusion.
  if (matching.length !== 1) throw new UnauthorizedException({ code: 'SESSION_REQUIRED' });
  const rawToken = matching[0].slice(COOKIE_NAME.length + 1);
  if (!TOKEN_PATTERN.test(rawToken)) {
    throw new UnauthorizedException({ code: 'SESSION_REQUIRED' });
  }
  return rawToken;
}

@Injectable()
export class SessionCookieGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedSessionRequest>();
    const token = extractSessionToken(req.headers.cookie);
    const validated = await this.sessions.validateAndTouch(token);
    req.validatedSession = validated;
    req.rawSessionToken = token;
    return true;
  }
}
