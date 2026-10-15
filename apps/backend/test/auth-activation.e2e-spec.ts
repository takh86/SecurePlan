import { Test } from '@nestjs/testing';
import { BadRequestException, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { vi } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { AuthService } from '../src/auth/auth.service.js';
import { ActivateAccountDto } from '../src/auth/dto/activate-account.dto.js';
import { configureApp } from '../src/configure-app.js';
import { DatabaseService } from '../src/database/database.service.js';

describe('Auth Activation — HTTP wiring', () => {
  let app: INestApplication<App>;

  const authServiceMock = {
    activate: vi.fn<(dto: ActivateAccountDto) => void>(),
  };

  const validRequest = {
    token: 'a'.repeat(43),
    password: 'SecurePlan activation test passphrase',
  };

  beforeEach(async () => {
    authServiceMock.activate.mockReset();

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DatabaseService)
      .useValue({ isReady: vi.fn().mockResolvedValue(true) })
      .overrideProvider(AuthService)
      .useValue(authServiceMock)
      .compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('rejects a short password before calling AuthService', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/activate')
      .send({ ...validRequest, password: '12345678' })
      .expect(400);

    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(response.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pointer: '#/password' }),
      ]),
    );
    expect(authServiceMock.activate).not.toHaveBeenCalled();
  });

  it('forwards a valid activation request to AuthService', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/activate')
      .send(validRequest)
      .expect(200);

    expect(authServiceMock.activate).toHaveBeenCalledTimes(1);
    expect(authServiceMock.activate).toHaveBeenCalledWith(validRequest);
  });

  it('allows five requests and returns a safe HTTP 429 without another service call', async () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/activate')
        // Forwarded headers are untrusted in the approved direct-access setup.
        .set('X-Forwarded-For', `192.0.2.${attempt}`)
        .send(validRequest)
        .expect(200);

      expect(response.text).toBe('');
      expect(Number(response.headers['x-ratelimit-limit'])).toBe(5);
      expect(Number(response.headers['x-ratelimit-remaining'])).toBe(
        5 - attempt,
      );
    }

    expect(authServiceMock.activate).toHaveBeenCalledTimes(5);

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/activate')
      .set('X-Forwarded-For', '198.51.100.1')
      .set('X-Real-IP', '203.0.113.1')
      .send(validRequest)
      .expect('Content-Type', /application\/problem\+json/)
      .expect(429);

    expect(response.body).toEqual({
      type: '/problems/rate-limited',
      title: 'Too Many Requests',
      status: 429,
      detail: 'Too many requests. Please try again later.',
      instance: `/problems/occurrences/${response.headers['x-correlation-id']}`,
      code: 'RATE_LIMITED',
      correlationId: response.headers['x-correlation-id'],
    });
    expect(response.body.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(response.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(response.text.includes(validRequest.token)).toBe(false);
    expect(response.text.includes(validRequest.password)).toBe(false);
    expect(authServiceMock.activate).toHaveBeenCalledTimes(5);

    await request(app.getHttpServer())
      .post('/api/v1/auth/activate')
      .send(validRequest)
      .expect(429);
    expect(authServiceMock.activate).toHaveBeenCalledTimes(5);

    await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
  });

  it('counts validation failures toward the limit before any service call', async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/activate')
        .send({ ...validRequest, password: 'short' })
        .expect(400);
    }

    await request(app.getHttpServer())
      .post('/api/v1/auth/activate')
      .send(validRequest)
      .expect(429);
    expect(authServiceMock.activate).not.toHaveBeenCalled();
  });

  it('counts rejected tokens toward the same limit', async () => {
    authServiceMock.activate.mockImplementation(() => {
      throw new BadRequestException({
        code: 'ACTIVATION_TOKEN_INVALID_OR_EXPIRED',
      });
    });

    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/activate')
        .send(validRequest)
        .expect(400);
      expect(response.body.code).toBe('ACTIVATION_TOKEN_INVALID_OR_EXPIRED');
    }

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/activate')
      .send(validRequest)
      .expect(429);
    expect(response.body.code).toBe('RATE_LIMITED');
    expect(authServiceMock.activate).toHaveBeenCalledTimes(5);
  });
});
