import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from './database.service.js';
import { Public } from '../auth/authorization/access-metadata.js';

@Controller('api/v1/health')
export class HealthController {
  constructor(private readonly database: DatabaseService) {}

  @Get('live')
  @Public()
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  @Public()
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
