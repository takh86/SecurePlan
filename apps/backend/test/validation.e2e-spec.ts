import {
  Body,
  ForbiddenException,
  HttpException,
  UnauthorizedException,
  ConflictException,
  Controller,
  Get,
  Logger,
  Post,
  ServiceUnavailableException,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsDefined, IsInt, IsString } from 'class-validator';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { vi } from 'vitest';
import { configureApp } from '../src/configure-app.js';

class ValidationTestDto {
  @IsDefined()
  @IsString()
  name!: string;

  @IsDefined()
  @IsInt()
  count!: number;
}

@Controller('validation-test')
class ValidationTestController {
  @Post()
  validate(@Body() body: ValidationTestDto) {
    return body;
  }

  @Get('unexpected-error')
  unexpectedError(): never {
    throw new Error('FAKE_DATABASE_SECRET_FOR_TEST');
  }

  @Get('conflict')
  conflict(): never {
    throw new ConflictException({
      code: 'PLAN_CONCURRENT_MODIFICATION',
    });
  }

  @Get('unknown-conflict-code')
  unknownConflictCode(): never {
    throw new ConflictException({
      code: 'SQL_CONSTRAINT_SECRET_FOR_TEST',
      message: 'FAKE_DATABASE_SECRET_FOR_TEST',
    });
  }

  @Get('unauthorized')
  unauthorized(): never {
    throw new UnauthorizedException();
  }

  @Get('session-expired')
  sessionExpired(): never {
    throw new UnauthorizedException({ code: 'SESSION_EXPIRED' });
  }

  @Get('forbidden')
  forbidden(): never {
    throw new ForbiddenException({ code: 'ACTION_FORBIDDEN' });
  }

  @Get('throttled')
  throttled(): never {
    throw new HttpException({ code: 'LOGIN_RATE_LIMITED' }, 429);
  }

  @Get('edit-lease-conflict')
  editLeaseConflict(): never {
    throw new ConflictException({ code: 'RESOURCE_EDIT_LOCKED' });
  }

  @Get('service-unavailable')
  serviceUnavailable(): never {
    throw new ServiceUnavailableException({
      code: 'SERVICE_UNAVAILABLE',
      message: 'FAKE_DATABASE_SECRET_FOR_TEST',
    });
  }
}

describe('Validation (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture = await Test.createTestingModule({
      controllers: [ValidationTestController],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('should accept valid data', async () => {
    await request(app.getHttpServer())
      .post('/validation-test')
      .send({ name: 'Test', count: 5 })
      .expect(201)
      .expect({ name: 'Test', count: 5 });
  });

  it('should reject unknown fields', async () => {
    await request(app.getHttpServer())
      .post('/validation-test')
      .send({ name: 'Test', count: 5, role: 'ADMIN' })
      .expect(400);
  });

  it('should reject missing required fields', async () => {
    await request(app.getHttpServer())
      .post('/validation-test')
      .send({ name: 'Test' })
      .expect(400);
  });

  it('should reject wrong data types', async () => {
    await request(app.getHttpServer())
      .post('/validation-test')
      .send({ name: 'Test', count: '5' })
      .expect(400);
  });

  it('should return problem details for validation errors', async () => {
    await request(app.getHttpServer())
      .post('/validation-test')
      .send({ name: 'Test', count: 5, role: 'ADMIN' })
      .expect('Content-Type', /application\/problem\+json/)
      .expect(400)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          type: '/problems/unknown-field',
          title: 'Bad Request',
          status: 400,
          code: 'UNKNOWN_FIELD',
        });
        expect(body.instance).toBe(`/problems/occurrences/${body.correlationId}`);
        expect(body).toHaveProperty('detail');
      });
  });

  it('should sanitize unexpected server errors', async () => {
    await request(app.getHttpServer())
      .get('/validation-test/unexpected-error')
      .expect('Content-Type', /application\/problem\+json/)
      .expect(500)
      .expect(({ body, headers }) => {
        expect(body).toMatchObject({
          title: 'Internal Server Error',
          status: 500,
          code: 'INTERNAL_ERROR',
        });
        expect(JSON.stringify(body)).not.toContain('FAKE_DATABASE_SECRET_FOR_TEST');
        expect(body.correlationId).toEqual(expect.any(String));
        expect(body.correlationId).toBe(headers['x-correlation-id']);
      });
  });

  it('should generate different correlation IDs for different requests', async () => {
    const firstResponse = await request(app.getHttpServer())
      .get('/validation-test/unexpected-error')
      .expect(500);

    const secondResponse = await request(app.getHttpServer())
      .get('/validation-test/unexpected-error')
      .expect(500);

    expect(firstResponse.body.correlationId).toEqual(expect.any(String));
    expect(secondResponse.body.correlationId).toEqual(expect.any(String));
    expect(firstResponse.body.correlationId).not.toBe(secondResponse.body.correlationId);
  });

  it('should attach a correlation ID to successful requests', async () => {
    const response = await request(app.getHttpServer())
      .post('/validation-test')
      .send({ name: 'Test', count: 5 })
      .expect(201);

    expect(response.headers['x-correlation-id']).toEqual(expect.any(String));
  });

  it('should log unexpected errors safely', async () => {
    const logSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    try {
      const response = await request(app.getHttpServer())
        .get('/validation-test/unexpected-error')
        .expect(500);

      const logs = logSpy.mock.calls
        .map((args) => args.map(String).join(' '))
        .join('\n');

      expect(logs).toContain(response.headers['x-correlation-id']);
      expect(logs).not.toContain('FAKE_DATABASE_SECRET_FOR_TEST');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('should not log validation errors as server failures', async () => {
    const logSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    try {
      await request(app.getHttpServer())
        .post('/validation-test')
        .send({ name: 'Test', count: 5, role: 'ADMIN' })
        .expect(400);

      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('should preserve the approved explicit error code for 409 Conflict', async () => {
    await request(app.getHttpServer())
      .get('/validation-test/conflict')
      .expect('Content-Type', /application\/problem\+json/)
      .expect(409)
      .expect(({ body, headers }) => {
        expect(body).toMatchObject({
          title: 'Conflict',
          status: 409,
          code: 'PLAN_CONCURRENT_MODIFICATION',
          type: '/problems/plan-concurrent-modification',
        });
        expect(body.correlationId).toBe(headers['x-correlation-id']);
      });
  });

  it('should map an unknown route to RESOURCE_NOT_FOUND', async () => {
    await request(app.getHttpServer())
      .get('/validation-test/not-a-real-route')
      .expect('Content-Type', /application\/problem\+json/)
      .expect(404)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          title: 'Not Found',
          status: 404,
          code: 'RESOURCE_NOT_FOUND',
          type: '/problems/resource-not-found',
        });
      });
  });

  it('should map an unclassified 409 to sanitized 500 rather than omit code', async () => {
    await request(app.getHttpServer())
      .get('/validation-test/unknown-conflict-code')
      .expect('Content-Type', /application\/problem\+json/)
      .expect(500)
      .expect(({ body }) => {
        expect(body.status).toBe(500);
        expect(body.code).toBe('INTERNAL_ERROR');
        expect(JSON.stringify(body)).not.toContain('SQL_CONSTRAINT_SECRET_FOR_TEST');
        expect(JSON.stringify(body)).not.toContain('FAKE_DATABASE_SECRET_FOR_TEST');
      });
  });

  it('should preserve safe service-unavailable mapping without leaking internals', async () => {
    await request(app.getHttpServer())
      .get('/validation-test/service-unavailable')
      .expect('Content-Type', /application\/problem\+json/)
      .expect(503)
      .expect(({ body, headers }) => {
        expect(body).toMatchObject({
          title: 'Service Unavailable',
          status: 503,
          code: 'SERVICE_UNAVAILABLE',
        });
        expect(body.correlationId).toBe(headers['x-correlation-id']);
        expect(JSON.stringify(body)).not.toContain('FAKE_DATABASE_SECRET_FOR_TEST');
      });
  });
  it('returns required RFC 9457 type/instance/code on unexpected 500', async () => {
    const response = await request(app.getHttpServer())
      .get('/validation-test/unexpected-error')
      .expect('Content-Type', /application\/problem\+json/)
      .expect(500);

    expect(response.body).toMatchObject({
      type: '/problems/internal-error',
      status: 500,
      code: 'INTERNAL_ERROR',
      instance: `/problems/occurrences/${response.headers['x-correlation-id']}`,
      correlationId: response.headers['x-correlation-id'],
    });
    expect(response.body).not.toHaveProperty('errors');
  });

  it('returns safe field validation pointers and stable subcodes', async () => {
    const response = await request(app.getHttpServer())
      .post('/validation-test')
      .send({ name: 99, count: '5' })
      .expect(400);

    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(response.body.type).toBe('/problems/validation-failed');
    expect(response.body.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ pointer: '#/name', code: 'INVALID_TYPE' }),
      expect.objectContaining({ pointer: '#/count', code: 'INVALID_TYPE' }),
    ]));
    expect(JSON.stringify(response.body.errors)).not.toContain('rejectedValue');
    expect(response.body.instance).toBe(`/problems/occurrences/${response.body.correlationId}`);
  });

  it('returns REQUIRED without exposing a missing field value', async () => {
    const response = await request(app.getHttpServer())
      .post('/validation-test')
      .send({ name: 'Test' })
      .expect(400);

    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(response.body.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ pointer: '#/count', code: 'REQUIRED' }),
    ]));
  });

  it('maps malformed JSON to approved INVALID_REQUEST_BODY', async () => {
    const response = await request(app.getHttpServer())
      .post('/validation-test')
      .set('Content-Type', 'application/json')
      .send('{"name":')
      .expect(400);
    expect(response.body).toMatchObject({
      type: '/problems/invalid-request-body',
      status: 400,
      code: 'INVALID_REQUEST_BODY',
    });
  });

  it('maps code-less authentication to SESSION_REQUIRED', async () => {
    const response = await request(app.getHttpServer())
      .get('/validation-test/unauthorized')
      .expect(401);
    expect(response.body).toMatchObject({
      status: 401,
      code: 'SESSION_REQUIRED',
      type: '/problems/session-required',
    });
  });

  it('preserves approved SESSION_EXPIRED, ACTION_FORBIDDEN and LOGIN_RATE_LIMITED', async () => {
    const cases = [
      ['session-expired', 401, 'SESSION_EXPIRED'],
      ['forbidden', 403, 'ACTION_FORBIDDEN'],
      ['throttled', 429, 'LOGIN_RATE_LIMITED'],
    ] as const;
    for (const [route, status, code] of cases) {
      const response = await request(app.getHttpServer())
        .get(`/validation-test/${route}`)
        .expect(status);
      expect(response.body.code).toBe(code);
      expect(response.body.type).toBe(`/problems/${code.toLowerCase().replaceAll('_', '-')}`);
    }
  });

  it('preserves Phase 8.7 edit-lease conflict code', async () => {
    const response = await request(app.getHttpServer())
      .get('/validation-test/edit-lease-conflict')
      .expect(409);
    expect(response.body.code).toBe('RESOURCE_EDIT_LOCKED');
    expect(response.body.type).toBe('/problems/resource-edit-locked');
  });

  it('never returns 422 for DTO validation', async () => {
    const response = await request(app.getHttpServer())
      .post('/validation-test')
      .send({ count: 'oops' })
      .expect(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

});
