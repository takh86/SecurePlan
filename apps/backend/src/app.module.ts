import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { LoginController } from './auth/login.controller.js';
import { LoginService } from './auth/login.service.js';
import { LoginAbuseService } from './auth/login-abuse.service.js';
import { SessionService } from './auth/session.service.js';
import { AccessControlGuard } from './auth/authorization/access-control.guard.js';
import { SessionController } from './auth/session.controller.js';
import { PasswordPolicyService } from './auth/password-policy.service.js';

import {
  loadPasswordDenylist,
  PASSWORD_DENYLIST,
} from './auth/local-password-denylist.js';

import { DatabaseService } from './database/database.service.js';
import { HealthController } from './database/health.controller.js';
import { ThrottlerModule } from '@nestjs/throttler';

import { BusinessAuditService } from './modules/audit/business-audit.service.js';
import { AccountLifecycleService } from './modules/identity/account-lifecycle.service.js';
import {
  ACTIVATION_DELIVERY,
  createActivationDelivery,
} from './modules/identity/activation-delivery.js';
import { EmployeesController } from './modules/workforce/employees/employees.controller.js';
import { EmployeesService } from './modules/workforce/employees/employees.service.js';
import { ProjectAssignmentsController } from './modules/workforce/project-assignments/project-assignments.controller.js';
import { ProjectAssignmentsService } from './modules/workforce/project-assignments/project-assignments.service.js';
import { ProjectsController } from './modules/workforce/projects/projects.controller.js';
import { ProjectsService } from './modules/workforce/projects/projects.service.js';

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
    EmployeesController,
    ProjectsController,
    ProjectAssignmentsController,
  ],
  providers: [
    AppService,
    DatabaseService,
    AuthService,
    SessionService,
    // SP-06: the ONLY global guard; fixed Origin -> session -> CSRF -> role order.
    { provide: APP_GUARD, useClass: AccessControlGuard },
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
    // SP-07: Identity public contract, Audit and Workforce.
    AccountLifecycleService,
    { provide: ACTIVATION_DELIVERY, useFactory: createActivationDelivery },
    BusinessAuditService,
    EmployeesService,
    // SP-08: projects (minimal slice, no shift configuration yet).
    ProjectsService,
    // SP-09: month-scoped project assignments (create/read slice).
    ProjectAssignmentsService,
  ],
})
export class AppModule {}
