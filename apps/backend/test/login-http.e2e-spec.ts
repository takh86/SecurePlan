/** SP-05 — login HTTP boundary, mock authentication but real Nest HTTP stack. */
import { Test } from '@nestjs/testing';
import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import { LoginAbuseService, LoginRateLimitedError } from '../src/auth/login-abuse.service.js';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { LoginService, type LoginResult } from '../src/auth/login.service.js';
import { DatabaseService } from '../src/database/database.service.js';
import { configureApp } from '../src/configure-app.js';
import { PASSWORD_DENYLIST } from '../src/auth/local-password-denylist.js';

const HTTPS_ORIGIN = 'https://localhost:8443';
const rawToken = 'a'.repeat(43);
const csrfToken = 'b'.repeat(43);
const validPayload = {
  email: 'test@secureplan.invalid',
  password: 'A synthetic login test password',
};
const identity: LoginResult = {
  accountId: '1c28d85b-aad5-4de7-9206-9ba15d2e1a3e',
  companyId: 'e48aeaa7-488f-410b-8a12-3ed4a6657ca5',
  email: validPayload.email,
  role: 'EMPLOYEE',
  rawToken,
  csrfToken,
  absoluteExpiresAt: new Date(Date.now() + 60 * 60_000),
};

describe('SP-05 — Login HTTP transport', () => {
  let app: INestApplication<App>;
  let priorOrigin: string | undefined;
  const loginMock = vi.fn<(_dto: typeof validPayload) => Promise<LoginResult>>();
  const beginAttemptMock = vi.fn();
  const finishAttemptMock = vi.fn();

  beforeAll(() => {
    priorOrigin = process.env.APP_ORIGIN;
    process.env.APP_ORIGIN = HTTPS_ORIGIN;
  });

  afterAll(() => {
    if (priorOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = priorOrigin;
  });

  beforeEach(async () => {
    loginMock.mockReset().mockResolvedValue(identity);
    beginAttemptMock.mockReset().mockResolvedValue({
      accountHash: Buffer.alloc(32), windowStartedAt: new Date(),
    });
    finishAttemptMock.mockReset().mockResolvedValue(undefined);
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DatabaseService)
      .useValue({ isReady: vi.fn().mockResolvedValue(true) })
      .overrideProvider(LoginService)
      .useValue({ login: loginMock })
      .overrideProvider(PASSWORD_DENYLIST)
      .useValue(new Set<string>())
      .overrideProvider(LoginAbuseService)
      .useValue({ beginAttempt: beginAttemptMock, finishAttempt: finishAttemptMock })
      .compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('01: returns only identity JSON, Secure cookie and CSRF response header', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', HTTPS_ORIGIN)
      .send(validPayload)
      .expect(200);
    expect(response.body).toEqual({
      accountId: identity.accountId,
      companyId: identity.companyId,
      email: identity.email,
      role: identity.role,
    });
    expect(response.headers['x-csrf-token']).toBe(csrfToken);
    expect(response.headers['cache-control']).toBe('no-store');
    const header: unknown = response.headers['set-cookie'];
    const cookies: unknown[] = Array.isArray(header) ? header : [header];
    expect(cookies).toHaveLength(1);
    const [cookie] = cookies;
    if (typeof cookie !== 'string') throw new Error('Expected one Set-Cookie header');
    expect(cookie).toContain(`__Host-secureplan_session=${rawToken}`);
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toMatch(/\bDomain=/i);
    expect(response.text).not.toContain(rawToken);
    expect(response.text).not.toContain(csrfToken);
  });

  it('02: missing Origin is rejected before password processing', async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/login')
      .send(validPayload).expect(403);
    expect(loginMock).not.toHaveBeenCalled();
  });

  it('03: mismatched Origin is rejected before password processing', async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/login')
      .set('Origin', 'https://evil.example').send(validPayload).expect(403);
    expect(loginMock).not.toHaveBeenCalled();
  });

  it('04: extra request properties are rejected by the global strict DTO pipe', async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/login')
      .set('Origin', HTTPS_ORIGIN).send({ ...validPayload, companyId: identity.companyId })
      .expect(400);
    expect(loginMock).not.toHaveBeenCalled();
  });

  it('05: bad credentials get the neutral approved error code', async () => {
    loginMock.mockRejectedValue(new UnauthorizedException({ code: 'INVALID_CREDENTIALS' }));
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login')
      .set('Origin', HTTPS_ORIGIN).send(validPayload).expect(401);
    expect(response.body.code).toBe('INVALID_CREDENTIALS');
    expect(response.text).not.toContain(validPayload.password);
  });

  it('06: successful logins do not count as failed credentials', async () => {
    for (let i = 0; i < 6; i++) {
      await request(app.getHttpServer()).post('/api/v1/auth/login')
        .set('Origin', HTTPS_ORIGIN).send(validPayload).expect(200);
    }
    expect(loginMock).toHaveBeenCalledTimes(6);
    expect(finishAttemptMock).toHaveBeenCalledTimes(6);
    expect(finishAttemptMock.mock.calls.every((call) => call[1] === 'success')).toBe(true);
  });

  it('07: rate-limited responses are 429 LOGIN_RATE_LIMITED with Retry-After', async () => {
    beginAttemptMock.mockRejectedValueOnce(new LoginRateLimitedError(17));
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login')
      .set('Origin', HTTPS_ORIGIN).send(validPayload).expect(429);
    expect(response.body.code).toBe('LOGIN_RATE_LIMITED');
    expect(response.headers['retry-after']).toBe('17');
    expect(loginMock).not.toHaveBeenCalled();
  });

  it('08: ignores spoofed forwarded IP addresses', async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/login')
      .set('Origin', HTTPS_ORIGIN)
      .set('X-Forwarded-For', '203.0.113.123')
      .set('X-Real-IP', '198.51.100.9')
      .send(validPayload).expect(200);
    expect(beginAttemptMock).toHaveBeenCalledTimes(1);
    expect(beginAttemptMock.mock.calls[0][1]).not.toBe('203.0.113.123');
    expect(beginAttemptMock.mock.calls[0][1]).not.toBe('198.51.100.9');
  });
});
