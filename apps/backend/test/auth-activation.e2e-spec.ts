import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
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
});
