import { IsDefined, IsString, IsInt } from 'class-validator';
import { Body, Controller, Post } from '@nestjs/common';
import { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import { Test } from '@nestjs/testing';
import request from 'supertest';
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
      .send({
        name: 'Test',
        count: 5,
      })
      .expect(201)
      .expect({
        name: 'Test',
        count: 5,
      });
  });
  it('should reject unknown fields', async () => {
  await request(app.getHttpServer())
    .post('/validation-test')
    .send({
      name: 'Test',
      count: 5,
      role: 'ADMIN',
    })
    .expect(400);
});
});
