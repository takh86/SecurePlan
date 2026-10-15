import { Module } from '@nestjs/common';

import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { PasswordPolicyService } from './auth/password-policy.service.js';

import {
  loadPasswordDenylist,
  PASSWORD_DENYLIST,
} from './auth/local-password-denylist.js';

import { DatabaseService } from './database/database.service.js';
import { HealthController } from './database/health.controller.js';
import { ThrottlerModule } from '@nestjs/throttler';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 5,
      },
    ]),
  ],
  controllers: [
    AppController,
    HealthController,
    AuthController,
  ],
  providers: [
    AppService,
    DatabaseService,
    AuthService,
    PasswordPolicyService,
    {
      provide: PASSWORD_DENYLIST,
      useFactory: () =>
        loadPasswordDenylist(
          process.env.SECUREPLAN_PASSWORD_DENYLIST_PATH ?? '',
        ),
    },
  ],
})
export class AppModule {}