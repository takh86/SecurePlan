/** Issue #51: real Nest/Express parsing before DTOs and credential work. */
import { HttpException, Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { inspect } from 'node:util';
import { gzipSync } from 'node:zlib';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { vi, type MockInstance } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { LoginAbuseService } from '../src/auth/login-abuse.service.js';
import { LoginService, type LoginResult } from '../src/auth/login.service.js';
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
const identity: LoginResult = {
  accountId: '1c28d85b-aad5-4de7-9206-9ba15d2e1a3e',
  companyId: 'e48aeaa7-488f-410b-8a12-3ed4a6657ca5',
  email: payload.email,
  role: 'EMPLOYEE',
  rawToken: 'a'.repeat(43),
  csrfToken: 'b'.repeat(43),
  absoluteExpiresAt: new Date(Date.now() + 60 * 60_000),
};

function jsonAtSize(bytes: number, input = payload): string {
  const json = JSON.stringify(input);
  return ' '.repeat(bytes - Buffer.byteLength(json)) + json;
}

describe('Issue #51 — pre-DTO HTTP parser boundary', () => {
  let app: INestApplication<App>;
  const login = vi.fn();
  const beginAttempt = vi.fn();
  const finishAttempt = vi.fn();
  const withTransaction = vi.fn();
  let logSpies: ReturnType<typeof vi.spyOn>[];
  let caught: MockInstance<ProblemDetailsFilter['catch']>;

  beforeEach(async () => {
    vi.stubEnv('APP_ORIGIN', ORIGIN);
    login.mockReset().mockResolvedValue(identity);
    beginAttempt.mockReset().mockResolvedValue({
      accountHash: Buffer.alloc(32), windowStartedAt: new Date(),
    });
    finishAttempt.mockReset().mockResolvedValue(undefined);
    withTransaction.mockReset();
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
    caught = vi.spyOn(ProblemDetailsFilter.prototype, 'catch');
    configureApp(app);
    await app.init();
    logSpies = (['error', 'warn', 'log', 'debug', 'verbose', 'fatal'] as const)
      .map((level) => vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined));
  });

  afterEach(async () => {
    await app?.close();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  function expectNoCredentialWork(): void {
    expect(login).not.toHaveBeenCalled();
    expect(beginAttempt).not.toHaveBeenCalled();
    expect(finishAttempt).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
  }

  function expectNoLogs(): void {
    for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
  }

  // Native HTTP preserves raw gzip bytes and chunked framing. Superagent's
  // JSON serializer can transform Buffers or add Content-Length to a string.
  async function postRaw(body: Buffer, headers: Record<string, string> = {}): Promise<{
    status: number; headers: IncomingHttpHeaders; body: unknown;
  }> {
    await app.listen(0, '127.0.0.1');
    const address = (app.getHttpServer() as Server).address();
    if (address === null || typeof address === 'string') throw new Error('Expected TCP listener');
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest({
        host: '127.0.0.1', port: address.port, method: 'POST', path: LOGIN_PATH,
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers },
      }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('error', reject);
        incoming.on('end', () => {
          try {
            const responseBody: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: responseBody });
          } catch (error) {
            reject(error);
          }
        });
      });
      outgoing.on('error', reject);
      outgoing.write(body.subarray(0, 16));
      outgoing.end(body.subarray(16));
    });
  }

  // 413/415 and JSON-only login are PROPOSED API amendments, pending review.
  // Commit 95a5474 preserves the passing pre-fix reproduction on dd5f3f8.
  it.each([
    { name: 'malformed JSON', contentType: 'application/json', body: `${JSON.stringify(payload).slice(0, -1)},`,
      status: 400, code: 'INVALID_REQUEST_BODY', type: undefined, parserStatus: undefined },
    { name: 'oversized JSON', contentType: 'application/json', body: jsonAtSize(LIMIT_BYTES + 1),
      status: 413, code: 'REQUEST_BODY_TOO_LARGE', type: 'entity.too.large', parserStatus: 413 },
    { name: 'unsupported charset', contentType: 'application/json; charset=iso-8859-1', body: JSON.stringify(payload),
      status: 415, code: 'UNSUPPORTED_MEDIA_TYPE', type: 'charset.unsupported', parserStatus: 415 },
    { name: 'unknown UTF charset', contentType: 'application/json; charset=utf-bogus', body: JSON.stringify(payload),
      status: 415, code: 'UNSUPPORTED_MEDIA_TYPE', type: 'charset.unsupported', parserStatus: 415 },
    { name: 'text/plain', contentType: 'text/plain', body: JSON.stringify(payload),
      status: 415, code: 'UNSUPPORTED_MEDIA_TYPE', type: undefined, parserStatus: undefined },
    { name: 'JSON scalar', contentType: 'application/json', body: JSON.stringify(payload.password),
      status: 400, code: 'INVALID_REQUEST_BODY', type: undefined, parserStatus: undefined },
  ])('rejects $name safely before credential work', async ({ contentType, body, status, code, type, parserStatus }) => {
    const response = await request(app.getHttpServer())
      .post(LOGIN_PATH)
      .set('Origin', ORIGIN)
      .set('Content-Type', contentType)
      .send(body)
      .expect('Content-Type', /application\/problem\+json/)
      .expect(status);
    expect(response.body).toEqual({
      type: `/problems/${code.toLowerCase().replaceAll('_', '-')}`,
      title: status === 413 ? 'Content Too Large' : status === 415 ? 'Unsupported Media Type' : 'Bad Request',
      status,
      code,
      detail: status === 413 ? 'The request body exceeds the permitted size.'
        : status === 415 ? 'The request media type, charset or content encoding is not supported.'
          : 'The request could not be processed.',
      correlationId: response.headers['x-correlation-id'],
      instance: `/problems/occurrences/${response.headers['x-correlation-id']}`,
    });
    expect(response.body.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    if (type) {
      expect(caught.mock.calls[0][0]).toMatchObject({ type, status: parserStatus, statusCode: parserStatus });
    }
    expect(response.text).not.toContain(payload.password);
    expect(response.text).not.toContain(payload.email);
    expectNoLogs();
    expectNoCredentialWork();
  });

  it.each(['application/xml', 'application/x-www-form-urlencoded', 'application/octet-stream',
    'application/vnd.secureplan+json', 'application/jsonp'])('rejects unsupported login media type %s', async (type) => {
    const response = await request(app.getHttpServer()).post(LOGIN_PATH)
      .set('Origin', ORIGIN).set('Content-Type', type).send(JSON.stringify(payload)).expect(415);
    expect(response.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expectNoCredentialWork();
    expectNoLogs();
  });

  it('rejects a body without Content-Type', async () => {
    const response = await request(app.getHttpServer()).post(LOGIN_PATH)
      .set('Origin', ORIGIN).send(Buffer.from(JSON.stringify(payload))).unset('Content-Type').expect(415);
    expect(response.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expectNoCredentialWork();
    expectNoLogs();
  });

  it('rejects an unsupported content encoding without echoing it', async () => {
    const response = await request(app.getHttpServer()).post(LOGIN_PATH)
      .set('Origin', ORIGIN).set('Content-Type', 'application/json')
      .set('Content-Encoding', 'synthetic-unsupported-encoding').send(JSON.stringify(payload)).expect(415);
    expect(response.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(response.text).not.toContain('synthetic-unsupported-encoding');
    expect(caught.mock.calls[0][0]).toMatchObject({
      type: 'encoding.unsupported', status: 415, statusCode: 415,
    });
    expectNoCredentialWork();
    expectNoLogs();
  });

  it.each([LIMIT_BYTES - 1, LIMIT_BYTES])('accepts a normal login padded to %i bytes', async (bytes) => {
    const body = jsonAtSize(bytes);
    expect(Buffer.byteLength(body)).toBe(bytes);
    const response = await request(app.getHttpServer()).post(LOGIN_PATH)
      .set('Origin', ORIGIN).set('Content-Type', 'Application/JSON; charset=UTF-8').send(body).expect(200);
    expect(response.body).toEqual({
      accountId: identity.accountId, companyId: identity.companyId, email: identity.email, role: identity.role,
    });
    expect(response.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers['x-csrf-token']).toBe(identity.csrfToken);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie'][0]).toContain('Secure; HttpOnly; SameSite=Lax');
    expect(response.text).not.toContain(payload.password);
    expect(response.text).not.toContain(identity.rawToken);
    expect(login).toHaveBeenCalledExactlyOnceWith(payload);
    expect(beginAttempt).toHaveBeenCalledOnce();
    expect(finishAttempt.mock.calls[0][1]).toBe('success');
    expectNoLogs();
  });

  it('measures the boundary in bytes, including multibyte JSON', async () => {
    const body = jsonAtSize(LIMIT_BYTES + 1, { ...payload, password: 'é'.repeat(500) });
    expect(body.length).toBeLessThan(LIMIT_BYTES);
    expect(Buffer.byteLength(body)).toBe(LIMIT_BYTES + 1);
    const response = await request(app.getHttpServer()).post(LOGIN_PATH)
      .set('Origin', ORIGIN).set('Content-Type', 'application/json').send(body).expect(413);
    expect(response.body.code).toBe('REQUEST_BODY_TOO_LARGE');
    expectNoCredentialWork();
    expectNoLogs();
  });

  it('enforces the same limit without a Content-Length header', async () => {
    const response = await postRaw(Buffer.from(jsonAtSize(LIMIT_BYTES + 1)));
    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({ code: 'REQUEST_BODY_TOO_LARGE' });
    expectNoCredentialWork();
    expectNoLogs();
  });

  it('enforces the limit on inflated JSON', async () => {
    const body = gzipSync(jsonAtSize(LIMIT_BYTES + 1));
    expect(body.byteLength).toBeLessThan(LIMIT_BYTES);
    const response = await postRaw(body, { 'Content-Encoding': 'gzip', 'Content-Length': String(body.byteLength) });
    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({ code: 'REQUEST_BODY_TOO_LARGE' });
    expectNoCredentialWork();
    expectNoLogs();
  });

  it.each(['chunked', 'gzip'])('still accepts supported %s JSON', async (encoding) => {
    const json = Buffer.from(JSON.stringify(payload));
    const response = encoding === 'gzip'
      ? await postRaw(gzipSync(json), { 'Content-Encoding': 'gzip' })
      : await postRaw(json);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ accountId: identity.accountId, email: identity.email });
    expect(login).toHaveBeenCalledExactlyOnceWith(payload);
    expectNoLogs();
  });

  it('keeps empty-body DTO validation and Origin enforcement', async () => {
    const empty = await request(app.getHttpServer()).post(LOGIN_PATH)
      .set('Origin', ORIGIN).expect(400);
    expect(empty.body.code).toBe('VALIDATION_FAILED');
    const origin = await request(app.getHttpServer()).post(LOGIN_PATH)
      .set('Content-Type', 'text/plain').send(JSON.stringify(payload)).expect(403);
    expect(origin.body.code).toBe('CSRF_VALIDATION_FAILED');
    expectNoCredentialWork();
    expectNoLogs();
  });

  it('preserves server-generated correlation IDs and subsequent unrelated requests', async () => {
    const ids = new Set<string>();
    for (const body of ['{"password":', jsonAtSize(LIMIT_BYTES + 1)]) {
      const response = await request(app.getHttpServer()).post(LOGIN_PATH)
        .set('X-Correlation-ID', 'synthetic-caller-controlled-id').set('Content-Type', 'application/json').send(body);
      expect(response.status).toBe(body.length > LIMIT_BYTES ? 413 : 400);
      expect(response.headers['x-correlation-id']).not.toBe('synthetic-caller-controlled-id');
      ids.add(response.headers['x-correlation-id']);
    }
    expect(ids.size).toBe(2);
    await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
    await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200, { status: 'ok' });
    const missing = await request(app.getHttpServer()).get('/no-such-parser-route').expect(404);
    expect(missing.body.code).toBe('RESOURCE_NOT_FOUND');
    const protectedRoute = await request(app.getHttpServer()).post('/api/v1/projects')
      .set('Origin', ORIGIN).send({ name: 'Synthetic project' }).expect(401);
    expect(protectedRoute.body.code).toBe('SESSION_REQUIRED');
    expectNoCredentialWork();
    expectNoLogs();
  });

  const internalSecret = 'SYNTHETIC_SQL_CREDENTIAL_PARSER_INTERNAL';
  it.each([
    { name: 'unexpected exception', error: new Error(internalSecret) },
    { name: 'arbitrary 413 status', error: Object.assign(new Error(internalSecret), { status: 413, statusCode: 413 }) },
    { name: 'unknown parser type', error: Object.assign(new Error(internalSecret), { type: 'unknown.parser', status: 415, statusCode: 415 }) },
    { name: 'mismatched parser status', error: Object.assign(new Error(internalSecret), { type: 'entity.too.large', status: 415, statusCode: 415 }) },
    { name: 'inconsistent metadata', error: Object.assign(new Error(internalSecret), { type: 'entity.too.large', status: 413, statusCode: 500 }) },
    { name: 'non-Error object', error: { message: internalSecret, type: 'entity.too.large', status: 413, statusCode: 413 } },
    { name: 'internal parser fault', error: Object.assign(new Error(internalSecret), { type: 'stream.not.readable', status: 500, statusCode: 500 }) },
    { name: 'unclassified Nest 413', error: new HttpException(internalSecret, 413) },
    { name: 'unapproved Nest 415 code', error: new HttpException({ code: internalSecret }, 415) },
  ])('keeps $name sanitized as 500 in responses and logs', async ({ error }) => {
    login.mockRejectedValue(Object.assign(error, { body: payload, expose: true }));
    const response = await request(app.getHttpServer()).post(LOGIN_PATH)
      .set('Origin', ORIGIN).send(payload).expect('Content-Type', /application\/problem\+json/).expect(500);
    expect(response.body).toEqual({
      type: '/problems/internal-error', title: 'Internal Server Error', status: 500,
      detail: 'An unexpected error occurred. Please try again later.',
      code: 'INTERNAL_ERROR', correlationId: response.headers['x-correlation-id'],
      instance: `/problems/occurrences/${response.headers['x-correlation-id']}`,
    });
    const logs = inspect(logSpies.flatMap((spy) => spy.mock.calls), { depth: null });
    expect(logSpies[0]).toHaveBeenCalledOnce();
    expect(logs).toContain(response.headers['x-correlation-id']);
    for (const value of [response.text, logs]) {
      for (const secret of [internalSecret, payload.password, payload.email, 'unknown.parser',
        'stream.not.readable', 'entity.too.large', 'statusCode', 'expose']) {
        expect(value).not.toContain(secret);
      }
    }
    expect(withTransaction).not.toHaveBeenCalled();
    expect(finishAttempt.mock.calls[0][1]).toBe('aborted');
  });
});
