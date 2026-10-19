import { Module } from '@nestjs/common';

import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { LoginController } from './auth/login.controller.js';
import { LoginService } from './auth/login.service.js';
import { LoginAbuseService } from './auth/login-abuse.service.js';
import { SessionService } from './auth/session.service.js';
import { SessionCookieGuard } from './auth/session-cookie.guard.js';
import { SessionController } from './auth/session.controller.js';
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
    LoginController,
    SessionController,
  ],
  providers: [
    AppService,
    DatabaseService,
    AuthService,
    SessionService,
    SessionCookieGuard,
    LoginService,
    LoginAbuseService,
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
