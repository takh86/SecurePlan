import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter.js';
import { correlationIdMiddleware } from './common/middleware/correlation-id.middleware.js';

export function configureApp(app: INestApplication): void {
  app.use(correlationIdMiddleware);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory:() => {
        return new BadRequestException({
          code: 'VALIDATION_FAILED',
        });
      },
    }),
  );
  app.useGlobalFilters(new ProblemDetailsFilter());
}