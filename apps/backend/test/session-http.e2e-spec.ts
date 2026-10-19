/** SP-05 — HTTP transport for GET /me and POST /auth/logout (mocked DB/session). */
import { Test } from '@nestjs/testing';
import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { SessionService, type ValidatedSession } from '../src/auth/session.service.js';
import { DatabaseService } from '../src/database/database.service.js';
import { PASSWORD_DENYLIST } from '../src/auth/local-password-denylist.js';
import { configureApp } from '../src/configure-app.js';

const ORIGIN = 'https://localhost:8443';
const RAW_TOKEN = 'a'.repeat(43);
const CSRF_TOKEN = 'b'.repeat(43);
const COOKIE = `__Host-secureplan_session=${RAW_TOKEN}`;
const context: ValidatedSession = {
  sessionId: 'a7f6dd29-9f8d-4a48-9827-88529bd1de8d',
  accountId: '04c34213-314b-4798-93e3-50e64997a2b5',
  companyId: '80e455a0-a1ea-4ef4-a4d7-30c919ae48b9',
  email: 'synthetic@secureplan.invalid',
  role: 'EMPLOYEE',
  csrfToken: CSRF_TOKEN,
  absoluteExpiresAt: new Date('2030-01-01T00:00:00Z'),
};

describe('SP-05 — /me and logout HTTP transport', () => {
  let app: INestApplication<App> | undefined;
  const priorOrigin = process.env.APP_ORIGIN;
  const validateAndTouch = vi.fn<(token: string) => Promise<ValidatedSession>>();
  const revoke = vi.fn<(token: string) => Promise<boolean>>();

  beforeAll(() => { process.env.APP_ORIGIN = ORIGIN; });
  afterAll(() => {
    if (priorOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = priorOrigin;
  });

  beforeEach(async () => {
    validateAndTouch.mockReset().mockResolvedValue(context);
    revoke.mockReset().mockResolvedValue(true);
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DatabaseService)
      .useValue({ isReady: vi.fn().mockResolvedValue(true) })
      .overrideProvider(PASSWORD_DENYLIST)
      .useValue(new Set<string>())
      .overrideProvider(SessionService)
      .useValue({ validateAndTouch, revoke })
      .compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it('01: GET /me exposes only current identity and the CSRF response header', async () => {
    const result = await request(app!.getHttpServer()).get('/api/v1/me')
      .set('Cookie', COOKIE).expect(200);
    expect(result.body).toEqual({
      accountId: context.accountId,
      companyId: context.companyId,
      email: context.email,
      role: context.role,
    });
    expect(result.headers['x-csrf-token']).toBe(CSRF_TOKEN);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.text).not.toContain(RAW_TOKEN);
    expect(result.text).not.toContain(CSRF_TOKEN);
    expect(validateAndTouch).toHaveBeenCalledWith(RAW_TOKEN);
  });

  it('02: missing Cookie returns a neutral 401 before service lookup', async () => {
    const result = await request(app!.getHttpServer()).get('/api/v1/me').expect(401);
    expect(result.body.code).toBe('SESSION_REQUIRED');
    expect(validateAndTouch).not.toHaveBeenCalled();
  });

  it('03: duplicate session cookies are rejected', async () => {
    await request(app!.getHttpServer()).get('/api/v1/me')
      .set('Cookie', `${COOKIE}; ${COOKIE}`).expect(401);
    expect(validateAndTouch).not.toHaveBeenCalled();
  });

  it('04: a revoked or expired cookie is denied', async () => {
    validateAndTouch.mockRejectedValueOnce(new UnauthorizedException({ code: 'SESSION_REVOKED' }));
    const result = await request(app!.getHttpServer()).get('/api/v1/me')
      .set('Cookie', COOKIE).expect(401);
    expect(result.body.code).toBe('SESSION_REVOKED');
  });

  it('05: valid logout revokes current session, clears cookie and returns 204', async () => {
    const response = await request(app!.getHttpServer()).post('/api/v1/auth/logout')
      .set('Origin', ORIGIN).set('Cookie', COOKIE)
      .set('X-CSRF-Token', CSRF_TOKEN).send({}).expect(204);
    expect(response.text).toBe('');
    expect(revoke).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith(RAW_TOKEN);
    const cookies = response.headers['set-cookie'] as string[] | undefined;
    expect(cookies?.[0]).toMatch(/__Host-secureplan_session=;.*Max-Age=0/);
    expect(cookies?.[0]).toContain('Secure');
    expect(cookies?.[0]).toContain('HttpOnly');
    expect(cookies?.[0]).not.toMatch(/\bDomain=/i);
  });

  it('06: logout without CSRF returns 403 and does not revoke', async () => {
    const response = await request(app!.getHttpServer()).post('/api/v1/auth/logout')
      .set('Origin', ORIGIN).set('Cookie', COOKIE).send({}).expect(403);
    expect(response.body.code).toBe('CSRF_VALIDATION_FAILED');
    expect(revoke).not.toHaveBeenCalled();
  });

  it('07: wrong CSRF returns 403 without revocation', async () => {
    await request(app!.getHttpServer()).post('/api/v1/auth/logout')
      .set('Origin', ORIGIN).set('Cookie', COOKIE)
      .set('X-CSRF-Token', 'c'.repeat(43)).send({}).expect(403);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('08: missing or wrong Origin denies logout before session lookup', async () => {
    for (const origin of [undefined, 'https://evil.invalid']) {
      const call = request(app!.getHttpServer()).post('/api/v1/auth/logout')
        .set('Cookie', COOKIE).set('X-CSRF-Token', CSRF_TOKEN);
      if (origin) call.set('Origin', origin);
      const response = await call.send({}).expect(403);
      expect(response.body.code).toBe('CSRF_VALIDATION_FAILED');
    }
    expect(validateAndTouch).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it('09: invalid logout payload fails closed and does not revoke', async () => {
    const result = await request(app!.getHttpServer()).post('/api/v1/auth/logout')
      .set('Origin', ORIGIN).set('Cookie', COOKIE)
      .set('X-CSRF-Token', CSRF_TOKEN).send({ unexpected: true }).expect(400);
    expect(result.body.code).toBe('INVALID_REQUEST_BODY');
    expect(revoke).not.toHaveBeenCalled();
  });

  it('10: concurrent revocation race fails closed with SESSION_REVOKED', async () => {
    revoke.mockResolvedValueOnce(false);
    const response = await request(app!.getHttpServer()).post('/api/v1/auth/logout')
      .set('Origin', ORIGIN).set('Cookie', COOKIE)
      .set('X-CSRF-Token', CSRF_TOKEN).send({}).expect(401);
    expect(response.body.code).toBe('SESSION_REVOKED');
  });

  it('11: logout with expired session gets 401 and cannot call revoke', async () => {
    validateAndTouch.mockRejectedValueOnce(new UnauthorizedException({ code: 'SESSION_EXPIRED' }));
    const response = await request(app!.getHttpServer()).post('/api/v1/auth/logout')
      .set('Origin', ORIGIN).set('Cookie', COOKIE)
      .set('X-CSRF-Token', CSRF_TOKEN).send({}).expect(401);
    expect(response.body.code).toBe('SESSION_EXPIRED');
    expect(revoke).not.toHaveBeenCalled();
  });
});
