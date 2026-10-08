import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { DatabaseService } from '../src/database/database.service.js';
import { AppModule } from './../src/app.module.js';
import { configureApp } from '../src/configure-app.js';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  const database = { isReady: vi.fn() };

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DatabaseService)
      .useValue(database)
      .compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  it('readiness returns 503 without leaking database errors', async () => {
    database.isReady.mockResolvedValue(false);
    const response = await request(app.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(503);
    expect(response.body.message).toBe('Service not ready');
  });

  it('readiness returns 200 after a successful probe', async () => {
    database.isReady.mockResolvedValue(true);
    await request(app.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('liveness does not require database availability', async () => {
    await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
  });

  afterEach(async () => {
    await app.close();
  });
});
