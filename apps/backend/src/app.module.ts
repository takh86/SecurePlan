import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { DatabaseService } from './database/database.service.js';
import { HealthController } from './database/health.controller.js';

@Module({
  imports: [],
  controllers: [AppController, HealthController, AuthController],
  providers: [AppService, DatabaseService, AuthService],
})
export class AppModule {}
