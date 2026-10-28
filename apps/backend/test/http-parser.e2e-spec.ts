/** Issue #51: real Nest/Express parsing before DTOs and credential work. */
import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { LoginAbuseService } from '../src/auth/login-abuse.service.js';
import { LoginService } from '../src/auth/login.service.js';
import { PASSWORD_DENYLIST } from '../src/auth/local-password-denylist.js';
import { ProblemDetailsFilter } from '../src/common/filters/problem-details.filter.js';
import { configureApp } from '../src/configure-app.js';
import { DatabaseService } from '../src/database/database.service.js';

const ORIGIN = 'https://localhost:8443';
const LOGIN_PATH = '/api/v1/auth/login';
const LIMIT_BYTES = 100 * 1024;
const payload = {
  email: 'parser-test@secureplan.invalid',
  password: 'SYNTHETIC_PARSER_PASSWORD',
};

describe('Issue #51 — pre-DTO HTTP parser boundary', () => {
  let app: INestApplication<App>;
  const login = vi.fn();
  const beginAttempt = vi.fn();
  const finishAttempt = vi.fn();
  const withTransaction = vi.fn();

  beforeEach(async () => {
    vi.stubEnv('APP_ORIGIN', ORIGIN);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DatabaseService)
      .useValue({ isReady: vi.fn().mockResolvedValue(true), withTransaction })
      .overrideProvider(PASSWORD_DENYLIST)
      .useValue(new Set<string>())
      .overrideProvider(LoginService)
      .useValue({ login })
      .overrideProvider(LoginAbuseService)
      .useValue({ beginAttempt, finishAttempt })
      .compile();
    app = module.createNestApplication();
    vi.spyOn(ProblemDetailsFilter.prototype, 'catch');
    configureApp(app);
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  // Characterization on dd5f3f8, before the technical fix. These expectations
  // deliberately record the two incorrect 500 responses for reproduction.
  it.each([
    { name: 'malformed JSON', contentType: 'application/json', body: `${JSON.stringify(payload).slice(0, -1)},`,
      status: 400, code: 'INVALID_REQUEST_BODY', type: undefined, parserStatus: undefined },
    { name: 'oversized JSON', contentType: 'application/json', body: ' '.repeat(LIMIT_BYTES) + JSON.stringify(payload),
      status: 500, code: 'INTERNAL_ERROR', type: 'entity.too.large', parserStatus: 413 },
    { name: 'unsupported charset', contentType: 'application/json; charset=iso-8859-1', body: JSON.stringify(payload),
      status: 500, code: 'INTERNAL_ERROR', type: 'charset.unsupported', parserStatus: 415 },
    { name: 'text/plain', contentType: 'text/plain', body: JSON.stringify(payload),
      status: 400, code: 'VALIDATION_FAILED', type: undefined, parserStatus: undefined },
  ])('reproduces $name', async ({ contentType, body, status, code, type, parserStatus }) => {
    const caught = vi.mocked(ProblemDetailsFilter.prototype.catch);
    const logs = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const response = await request(app.getHttpServer())
      .post(LOGIN_PATH)
      .set('Origin', ORIGIN)
      .set('Content-Type', contentType)
      .send(body)
      .expect('Content-Type', /application\/problem\+json/)
      .expect(status);
    expect(response.body).toMatchObject({ status, code });
    expect(response.body.correlationId).toBe(response.headers['x-correlation-id']);
    expect(response.body.instance).toBe(`/problems/occurrences/${response.body.correlationId}`);
    if (type) {
      expect(caught.mock.calls[0][0]).toMatchObject({ type, status: parserStatus, statusCode: parserStatus });
      expect(logs).toHaveBeenCalledTimes(1);
    }
    expect(response.text).not.toContain(payload.password);
    expect(response.text).not.toContain(payload.email);
    expect(login).not.toHaveBeenCalled();
    expect(beginAttempt).not.toHaveBeenCalled();
    expect(finishAttempt).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
  });
});
