/**
 * SP-06 — global AccessControlGuard over real HTTP (mocked session/DB).
 * Proves execution order (Origin -> session -> CSRF -> role), single session
 * validation, default deny and that spoofed identity input has no effect.
 */
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { SessionService, type ValidatedSession } from '../src/auth/session.service.js';
import { DatabaseService } from '../src/database/database.service.js';
import { PASSWORD_DENYLIST } from '../src/auth/local-password-denylist.js';
import { configureApp } from '../src/configure-app.js';
import {
  AuthorizationProbeController,
  ClassLevelPublicProbeController,
  probeCalls,
} from './helpers/authorization-probe.controller.js';

const ORIGIN = 'https://localhost:8443';
const RAW_TOKEN = 'a'.repeat(43);
const CSRF_TOKEN = 'b'.repeat(43);
const COOKIE = `__Host-secureplan_session=${RAW_TOKEN}`;
const FOREIGN_COMPANY = '5b0c2b55-6f4f-4c3e-9b0e-6f3d9d1b9a01';

function sessionFor(role: ValidatedSession['role']): ValidatedSession {
  return {
    sessionId: 'a7f6dd29-9f8d-4a48-9827-88529bd1de8d',
    accountId: '04c34213-314b-4798-93e3-50e64997a2b5',
    companyId: '80e455a0-a1ea-4ef4-a4d7-30c919ae48b9',
    email: 'synthetic@secureplan.invalid',
    role,
    csrfToken: CSRF_TOKEN,
    absoluteExpiresAt: new Date('2030-01-01T00:00:00Z'),
  };
}

describe('SP-06 — AccessControlGuard order and default deny (HTTP)', () => {
  let app: INestApplication<App> | undefined;
  const priorOrigin = process.env.APP_ORIGIN;
  const validateAndTouch = vi.fn<(token: string) => Promise<ValidatedSession>>();
  const revoke = vi.fn<(token: string) => Promise<boolean>>();

  const http = () => request(app!.getHttpServer());

  beforeAll(() => { process.env.APP_ORIGIN = ORIGIN; });
  afterAll(() => {
    if (priorOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = priorOrigin;
  });

  beforeEach(async () => {
    probeCalls.length = 0;
    validateAndTouch.mockReset().mockResolvedValue(sessionFor('EMPLOYEE'));
    revoke.mockReset().mockResolvedValue(true);
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [AuthorizationProbeController, ClassLevelPublicProbeController],
    })
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

  describe('order and single validation', () => {
    it('F1/F2: missing, duplicate or malformed cookie -> 401 without session lookup', async () => {
      for (const cookie of [undefined, `${COOKIE}; ${COOKIE}`, '__Host-secureplan_session=short']) {
        const call = http().get('/test-only/authz-probe/employee');
        if (cookie) call.set('Cookie', cookie);
        const response = await call.expect(401);
        expect(response.body.code).toBe('SESSION_REQUIRED');
      }
      expect(validateAndTouch).not.toHaveBeenCalled();
      expect(probeCalls).toEqual([]);
    });

    it('F3/F4: unsafe request with missing/foreign Origin -> 403 before session lookup', async () => {
      for (const path of ['/api/v1/auth/logout', '/test-only/authz-probe/admin']) {
        for (const origin of [undefined, 'https://evil.invalid', 'http://localhost:8443']) {
          const call = http().post(path).set('Cookie', COOKIE).set('X-CSRF-Token', CSRF_TOKEN);
          if (origin) call.set('Origin', origin);
          const response = await call.send({}).expect(403);
          expect(response.body.code).toBe('CSRF_VALIDATION_FAILED');
        }
      }
      expect(validateAndTouch).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
      expect(probeCalls).toEqual([]);
    });

    it('F5: non-https APP_ORIGIN -> 503 on unsafe protected routes before session lookup', async () => {
      process.env.APP_ORIGIN = 'http://localhost:5173';
      try {
        const response = await http().post('/api/v1/auth/logout')
          .set('Origin', 'http://localhost:5173').set('Cookie', COOKIE)
          .set('X-CSRF-Token', CSRF_TOKEN).send({}).expect(503);
        expect(response.body.code).toBe('SERVICE_UNAVAILABLE');
        expect(validateAndTouch).not.toHaveBeenCalled();
      } finally {
        process.env.APP_ORIGIN = ORIGIN;
      }
    });

    it('F6: valid Origin + session but missing/wrong CSRF -> 403 after exactly one validation', async () => {
      validateAndTouch.mockResolvedValue(sessionFor('COMPANY_ADMIN'));
      for (const csrf of [undefined, 'c'.repeat(43)]) {
        validateAndTouch.mockClear();
        const call = http().post('/test-only/authz-probe/admin')
          .set('Origin', ORIGIN).set('Cookie', COOKIE);
        if (csrf) call.set('X-CSRF-Token', csrf);
        const response = await call.send({}).expect(403);
        expect(response.body.code).toBe('CSRF_VALIDATION_FAILED');
        expect(validateAndTouch).toHaveBeenCalledOnce();
      }
      expect(probeCalls).toEqual([]);
    });

    it('F7: successful /me and logout validate the session exactly once', async () => {
      await http().get('/api/v1/me').set('Cookie', COOKIE).expect(200);
      expect(validateAndTouch).toHaveBeenCalledOnce();

      validateAndTouch.mockClear();
      await http().post('/api/v1/auth/logout').set('Origin', ORIGIN).set('Cookie', COOKIE)
        .set('X-CSRF-Token', CSRF_TOKEN).send({}).expect(204);
      expect(validateAndTouch).toHaveBeenCalledOnce();
      expect(revoke).toHaveBeenCalledOnce();
      expect(revoke).toHaveBeenCalledWith(RAW_TOKEN);
    });

    it('F8: logout with bad CSRF AND bad body -> 403 (CSRF is enforced before the body)', async () => {
      const response = await http().post('/api/v1/auth/logout')
        .set('Origin', ORIGIN).set('Cookie', COOKIE)
        .set('X-CSRF-Token', 'c'.repeat(43)).send({ unexpected: true }).expect(403);
      expect(response.body.code).toBe('CSRF_VALIDATION_FAILED');
      expect(revoke).not.toHaveBeenCalled();
    });

    it('F9: logout with valid CSRF and bad body keeps 400 INVALID_REQUEST_BODY', async () => {
      const response = await http().post('/api/v1/auth/logout')
        .set('Origin', ORIGIN).set('Cookie', COOKIE)
        .set('X-CSRF-Token', CSRF_TOKEN).send({ unexpected: true }).expect(400);
      expect(response.body.code).toBe('INVALID_REQUEST_BODY');
      expect(revoke).not.toHaveBeenCalled();
    });

    it('F15: safe GET requests do not require Origin or CSRF', async () => {
      await http().get('/api/v1/me').set('Cookie', COOKIE).expect(200);
    });
  });

  describe('RBAC and default deny', () => {
    it('F10: EMPLOYEE on an admin-only route -> 403 ACTION_FORBIDDEN, handler not reached', async () => {
      const read = await http().get('/test-only/authz-probe/admin').set('Cookie', COOKIE).expect(403);
      expect(read.body.code).toBe('ACTION_FORBIDDEN');
      const write = await http().post('/test-only/authz-probe/admin')
        .set('Origin', ORIGIN).set('Cookie', COOKIE).set('X-CSRF-Token', CSRF_TOKEN)
        .send({ note: 'x' }).expect(403);
      expect(write.body.code).toBe('ACTION_FORBIDDEN');
      expect(probeCalls).toEqual([]);
    });

    it('COMPANY_ADMIN on an EMPLOYEE-only route is also denied (no implicit hierarchy)', async () => {
      validateAndTouch.mockResolvedValue(sessionFor('COMPANY_ADMIN'));
      await http().get('/test-only/authz-probe/employee').set('Cookie', COOKIE).expect(403);
      expect(probeCalls).toEqual([]);
    });

    it('permitted roles reach the handler with the session-derived TenantContext only', async () => {
      validateAndTouch.mockResolvedValue(sessionFor('COMPANY_ADMIN'));
      const response = await http().get('/test-only/authz-probe/admin').set('Cookie', COOKIE).expect(200);
      expect(response.body).toEqual({
        sessionId: sessionFor('COMPANY_ADMIN').sessionId,
        accountId: sessionFor('COMPANY_ADMIN').accountId,
        companyId: sessionFor('COMPANY_ADMIN').companyId,
        role: 'COMPANY_ADMIN',
      });
      expect(probeCalls).toEqual(['adminRead']);
    });

    it('F11: unclassified, ambiguous and class-level-public handlers -> 403 for every role, no lookup', async () => {
      for (const role of ['EMPLOYEE', 'COMPANY_ADMIN'] as const) {
        validateAndTouch.mockResolvedValue(sessionFor(role));
        for (const path of [
          '/test-only/authz-probe/unclassified',
          '/test-only/authz-probe/ambiguous',
          '/test-only/authz-class-public',
        ]) {
          const response = await http().get(path).set('Cookie', COOKIE).expect(403);
          expect(response.body.code).toBe('ACTION_FORBIDDEN');
        }
        await http().post('/test-only/authz-probe/unclassified')
          .set('Origin', ORIGIN).set('Cookie', COOKIE).set('X-CSRF-Token', CSRF_TOKEN)
          .send({}).expect(403);
      }
      // Unauthenticated callers get the same default deny (no 401 probing oracle).
      await http().get('/test-only/authz-probe/unclassified').expect(403);
      expect(validateAndTouch).not.toHaveBeenCalled();
      expect(probeCalls).toEqual([]);
    });
  });

  describe('client-supplied identity has no effect', () => {
    it('F12: spoofed role/company headers are ignored (outcome equals the real role)', async () => {
      const spoof = {
        'X-Role': 'COMPANY_ADMIN',
        'X-Company-Id': FOREIGN_COMPANY,
        'X-Account-Id': FOREIGN_COMPANY,
      };
      const denied = await http().get('/test-only/authz-probe/admin')
        .set('Cookie', COOKIE).set(spoof).expect(403);
      expect(denied.body.code).toBe('ACTION_FORBIDDEN');

      const me = await http().get('/api/v1/me').set('Cookie', COOKIE).set(spoof).expect(200);
      expect(me.body.role).toBe('EMPLOYEE');
      expect(me.body.companyId).toBe(sessionFor('EMPLOYEE').companyId);
      expect(probeCalls).toEqual([]);
    });

    it('F13: identity in the query string is ignored', async () => {
      const me = await http()
        .get(`/api/v1/me?companyId=${FOREIGN_COMPANY}&role=COMPANY_ADMIN&accountId=${FOREIGN_COMPANY}`)
        .set('Cookie', COOKIE).expect(200);
      expect(me.body).toMatchObject({ companyId: sessionFor('EMPLOYEE').companyId, role: 'EMPLOYEE' });
    });

    it('F14: role/companyId injected into a DTO body -> 400 UNKNOWN_FIELD, handler not reached', async () => {
      validateAndTouch.mockResolvedValue(sessionFor('COMPANY_ADMIN'));
      for (const injected of [{ role: 'COMPANY_ADMIN' }, { companyId: FOREIGN_COMPANY }]) {
        const response = await http().post('/test-only/authz-probe/admin')
          .set('Origin', ORIGIN).set('Cookie', COOKIE).set('X-CSRF-Token', CSRF_TOKEN)
          .send({ note: 'x', ...injected }).expect(400);
        expect(response.body.code).toBe('UNKNOWN_FIELD');
      }
      expect(probeCalls).toEqual([]);

      const ok = await http().post('/test-only/authz-probe/admin')
        .set('Origin', ORIGIN).set('Cookie', COOKIE).set('X-CSRF-Token', CSRF_TOKEN)
        .send({ note: 'x' }).expect(201);
      expect(ok.body.tenant.companyId).toBe(sessionFor('COMPANY_ADMIN').companyId);
      expect(probeCalls).toEqual(['adminWrite']);
    });
  });

  describe('public routes keep their own contracts', () => {
    it('F16: login Origin check still precedes any processing; health/root stay public', async () => {
      const response = await http().post('/api/v1/auth/login')
        .set('Origin', 'https://evil.invalid')
        .send({ email: 'synthetic@secureplan.invalid', password: 'x' }).expect(403);
      expect(response.body.code).toBe('CSRF_VALIDATION_FAILED');
      await http().get('/api/v1/health/live').expect(200);
      await http().get('/').expect(200);
      expect(validateAndTouch).not.toHaveBeenCalled();
    });
  });
});
