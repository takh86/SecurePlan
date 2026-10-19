import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { ValidatedSession } from './session.service.js';

export const SESSION_COOKIE_NAME = '__Host-secureplan_session';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Request state written ONLY by AccessControlGuard after server-side session
 * validation. Handlers read it through @CurrentTenant()/@CurrentSession().
 */
export type AuthenticatedSessionRequest = Request & {
  validatedSession?: ValidatedSession;
  // Volatile server-only value. Never serialize/log this property.
  rawSessionToken?: string;
};

/** Pure cookie parsing; performs no database access. */
export function extractSessionToken(cookieHeader: string | undefined): string {
  if (!cookieHeader) throw new UnauthorizedException({ code: 'SESSION_REQUIRED' });
  const matching = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`));

  // Duplicate cookies can create parser ambiguity and fixation/confusion.
  if (matching.length !== 1) throw new UnauthorizedException({ code: 'SESSION_REQUIRED' });
  const rawToken = matching[0].slice(SESSION_COOKIE_NAME.length + 1);
  if (!TOKEN_PATTERN.test(rawToken)) {
    throw new UnauthorizedException({ code: 'SESSION_REQUIRED' });
  }
  return rawToken;
}
