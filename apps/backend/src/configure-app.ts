import { ValidationPipe, type INestApplication } from '@nestjs/common';
import type { ExpressAdapter } from '@nestjs/platform-express';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter.js';
import { createValidationException } from './common/errors/validation-error.factory.js';
import { correlationIdMiddleware } from './common/middleware/correlation-id.middleware.js';

export function configureApp(app: INestApplication): void {
  app.use(correlationIdMiddleware);
  // Pin the existing Express default (100 KiB), before DTOs/guards. Registering
  // jsonParser here replaces Nest's automatic JSON parser, not its form parser.
  const adapter = app.getHttpAdapter() as ExpressAdapter;
  adapter.useBodyParser('json', false, {
    limit: 100 * 1024,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: createValidationException,
    }),
  );
  app.useGlobalFilters(new ProblemDetailsFilter());
}
