import { SetMetadata, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { vi } from 'vitest';
import type { SessionService, ValidatedSession } from '../session.service.js';
import { AccessControlGuard } from './access-control.guard.js';
import { PUBLIC_ACCESS, Public, RequireRoles } from './access-metadata.js';

const ORIGIN = 'https://localhost:8443';
const TOKEN = 'a'.repeat(43);
const CSRF = 'b'.repeat(43);
const session: ValidatedSession = {
  sessionId: 'a7f6dd29-9f8d-4a48-9827-88529bd1de8d',
  accountId: '04c34213-314b-4798-93e3-50e64997a2b5',
  companyId: '80e455a0-a1ea-4ef4-a4d7-30c919ae48b9',
  email: 'synthetic@secureplan.invalid',
  role: 'EMPLOYEE',
  csrfToken: CSRF,
  absoluteExpiresAt: new Date('2030-01-01T00:00:00Z'),
};

class Handlers {
  @Public() publicRoute(this: void) {}
  @RequireRoles('EMPLOYEE', 'COMPANY_ADMIN') anyTenant(this: void) {}
  @RequireRoles('COMPANY_ADMIN') adminOnly(this: void) {}
  unclassified(this: void) {}
  @Public() @RequireRoles('EMPLOYEE') ambiguous(this: void) {}
}

@SetMetadata(PUBLIC_ACCESS, true)
class ClassLevelPublic {
  handler(this: void) {}
}

type FakeRequest = {
  method: string;
  headers: Record<string, string | undefined>;
  get(name: string): string | undefined;
  validatedSession?: ValidatedSession;
  rawSessionToken?: string;
};

function fakeRequest(method: string, headers: Record<string, string | undefined>): FakeRequest {
  return {
    method,
    headers,
    get: (name: string) => headers[name.toLowerCase()],
  };
}

function contextFor(handler: () => void, request: FakeRequest, type = 'http'): ExecutionContext {
  return {
    getType: () => type,
    getHandler: () => handler,
    getClass: () => Handlers,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const handlers = Handlers.prototype;
const validCookie = `__Host-secureplan_session=${TOKEN}`;

describe('SP-06 — AccessControlGuard (unit)', () => {
  const priorOrigin = process.env.APP_ORIGIN;
  const validateAndTouch = vi.fn<(token: string) => Promise<ValidatedSession>>();
  let guard: AccessControlGuard;

  beforeAll(() => { process.env.APP_ORIGIN = ORIGIN; });
  afterAll(() => {
    if (priorOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = priorOrigin;
  });
  beforeEach(() => {
    validateAndTouch.mockReset().mockResolvedValue(session);
    guard = new AccessControlGuard(
      new Reflector(),
      { validateAndTouch } as unknown as SessionService,
    );
  });

  it('allows @Public handlers without touching the session', async () => {
    const request = fakeRequest('POST', {});
    await expect(guard.canActivate(contextFor(handlers.publicRoute, request))).resolves.toBe(true);
    expect(validateAndTouch).not.toHaveBeenCalled();
    expect(request.validatedSession).toBeUndefined();
  });

  it.each([
    ['unclassified', handlers.unclassified],
    ['ambiguous (@Public + @RequireRoles)', handlers.ambiguous],
    ['class-level @Public only', ClassLevelPublic.prototype.handler],
  ])('denies %s handlers with 403 before any session lookup', async (_name, handler) => {
    const request = fakeRequest('GET', { cookie: validCookie });
    await expect(guard.canActivate(contextFor(handler, request))).rejects.toMatchObject({
      status: 403, response: { code: 'ACTION_FORBIDDEN' },
    });
    expect(validateAndTouch).not.toHaveBeenCalled();
  });

  it('denies non-HTTP execution contexts', async () => {
    const request = fakeRequest('GET', { cookie: validCookie });
    await expect(guard.canActivate(contextFor(handlers.anyTenant, request, 'rpc')))
      .rejects.toMatchObject({ status: 403 });
  });

  it('GET: validates the session exactly once and sets trusted state; no CSRF needed', async () => {
    const request = fakeRequest('GET', { cookie: validCookie });
    await expect(guard.canActivate(contextFor(handlers.anyTenant, request))).resolves.toBe(true);
    expect(validateAndTouch).toHaveBeenCalledOnce();
    expect(validateAndTouch).toHaveBeenCalledWith(TOKEN);
    expect(request.validatedSession).toBe(session);
    expect(request.rawSessionToken).toBe(TOKEN);
  });

  it('unsafe method: Origin is checked before the session lookup', async () => {
    for (const origin of [undefined, 'https://evil.invalid']) {
      const request = fakeRequest('POST', { cookie: validCookie, origin, 'x-csrf-token': CSRF });
      await expect(guard.canActivate(contextFor(handlers.anyTenant, request))).rejects.toMatchObject({
        status: 403, response: { code: 'CSRF_VALIDATION_FAILED' },
      });
    }
    expect(validateAndTouch).not.toHaveBeenCalled();
  });

  it('unsafe method: non-https APP_ORIGIN fails closed with 503 before the session lookup', async () => {
    process.env.APP_ORIGIN = 'http://localhost:5173';
    try {
      const request = fakeRequest('DELETE', { cookie: validCookie, origin: 'http://localhost:5173' });
      await expect(guard.canActivate(contextFor(handlers.anyTenant, request))).rejects.toMatchObject({
        status: 503, response: { code: 'SERVICE_UNAVAILABLE' },
      });
      expect(validateAndTouch).not.toHaveBeenCalled();
    } finally {
      process.env.APP_ORIGIN = ORIGIN;
    }
  });

  it('missing cookie is a 401 without DB access', async () => {
    const request = fakeRequest('GET', {});
    await expect(guard.canActivate(contextFor(handlers.anyTenant, request))).rejects.toMatchObject({
      status: 401, response: { code: 'SESSION_REQUIRED' },
    });
    expect(validateAndTouch).not.toHaveBeenCalled();
  });

  it('unsafe method: CSRF is checked after session validation and leaves no trusted state', async () => {
    for (const csrf of [undefined, 'c'.repeat(43)]) {
      const request = fakeRequest('PATCH', { cookie: validCookie, origin: ORIGIN, 'x-csrf-token': csrf });
      await expect(guard.canActivate(contextFor(handlers.anyTenant, request))).rejects.toMatchObject({
        status: 403, response: { code: 'CSRF_VALIDATION_FAILED' },
      });
      expect(request.validatedSession).toBeUndefined();
    }
    expect(validateAndTouch).toHaveBeenCalledTimes(2);
  });

  it('role mismatch is 403 ACTION_FORBIDDEN after CSRF and leaves no trusted state', async () => {
    const request = fakeRequest('POST', { cookie: validCookie, origin: ORIGIN, 'x-csrf-token': CSRF });
    await expect(guard.canActivate(contextFor(handlers.adminOnly, request))).rejects.toMatchObject({
      status: 403, response: { code: 'ACTION_FORBIDDEN' },
    });
    expect(validateAndTouch).toHaveBeenCalledOnce();
    expect(request.validatedSession).toBeUndefined();
  });

  it('a pre-existing session state (second evaluation) fails closed', async () => {
    const request = fakeRequest('GET', { cookie: validCookie });
    request.validatedSession = session;
    await expect(guard.canActivate(contextFor(handlers.anyTenant, request))).rejects.toThrow();
    expect(validateAndTouch).not.toHaveBeenCalled();
  });
});
