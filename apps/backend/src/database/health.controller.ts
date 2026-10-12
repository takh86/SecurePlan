import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from './database.service.js';

@Controller('api/v1/health')
export class HealthController {
  constructor(private readonly database: DatabaseService) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    if (!(await this.database.isReady())) {
      throw new ServiceUnavailableException({
        message: 'Service not ready',
        code: 'SERVICE_UNAVAILABLE',
      });
    }
    return { status: 'ok' };
  }
}
