/**
 * SecurePlan SP-05 — browser authentication transport.
 * The opaque session token NEVER enters JS; the browser owns the HttpOnly cookie.
 * Only the CSRF token and non-secret identity context are kept in React memory.
 */
import { ApiError, parseApiError, safeCorrelationId } from '../../shared/api/api-error';
import { isCivilDate, isNamedTimeZone } from '../../shared/time/civil-time';

export type IdentityContext = {
  accountId: string;
  companyId: string;
  email: string;
  role: 'EMPLOYEE' | 'COMPANY_ADMIN';
};

export type MeIdentity = IdentityContext & { companyTimeZone: string; currentCompanyMonth: string };
export type RestoredAuthenticatedContext = { identity: MeIdentity; csrfToken: string };

export type AuthenticatedContext = {
  identity: IdentityContext;
  csrfToken: string;
};

const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function invalidResponse(response: Response): never {
  throw new ApiError(
    'invalid-response',
    response.status,
    null,
    safeCorrelationId(response.headers.get('x-correlation-id')),
  );
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

export function parseBaseIdentity(body: unknown): IdentityContext {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!isRecord(body) || typeof body.accountId !== 'string' || !uuid.test(body.accountId) ||
    typeof body.companyId !== 'string' || !uuid.test(body.companyId) || typeof body.email !== 'string' ||
    (body.role !== 'EMPLOYEE' && body.role !== 'COMPANY_ADMIN')) throw new ApiError('invalid-response', 200, null, null);
  return { accountId: body.accountId, companyId: body.companyId, email: body.email, role: body.role };
}
export function parseMeIdentity(body: unknown): MeIdentity {
  const base = parseBaseIdentity(body);
  if (!isRecord(body) || !isNamedTimeZone(body.companyTimeZone) || !isCivilDate(body.currentCompanyMonth) ||
    !body.currentCompanyMonth.endsWith('-01')) throw new ApiError('invalid-response', 200, null, null);
  return { ...base, companyTimeZone: body.companyTimeZone, currentCompanyMonth: body.currentCompanyMonth };
}
async function readAuthenticated<T extends IdentityContext>(response: Response, parse: (body: unknown) => T): Promise<{ identity: T; csrfToken: string }> {
  const csrfToken = response.headers.get('x-csrf-token');
  if (!csrfToken || !CSRF_TOKEN_PATTERN.test(csrfToken)) invalidResponse(response);
  let body: unknown;
  try { body = await response.json(); } catch { invalidResponse(response); }
  return { identity: parse(body), csrfToken };
}

async function send(
  path: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: {
        Accept: 'application/json, application/problem+json',
        ...init.headers,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ApiError('network', null, null, null);
  }
  if (!response.ok) throw await parseApiError(response);
  return response;
}

export async function currentSession(): Promise<RestoredAuthenticatedContext> {
  const response = await send('/api/v1/me', { method: 'GET' });
  return readAuthenticated(response, parseMeIdentity);
}

export async function login(
  email: string,
  password: string,
): Promise<AuthenticatedContext> {
  const response = await send('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Do not trim or normalize passwords.
    body: JSON.stringify({ email, password }),
  });
  return readAuthenticated(response, parseBaseIdentity);
}

export async function logout(csrfToken: string): Promise<void> {
  // Origin is supplied by the browser for same-origin POSTs, not by JS code.
  const response = await send('/api/v1/auth/logout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    },
    body: '{}',
  });
  if (response.status !== 204) invalidResponse(response);
}
