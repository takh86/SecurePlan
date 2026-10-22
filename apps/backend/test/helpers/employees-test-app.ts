/**
 * SP-07 test harness: the REAL AppModule (real DatabaseService SQL, real
 * global AccessControlGuard, real SessionService) with only outbound side
 * effects replaced: activation delivery (recorded in memory), the external
 * breached-password lookup, and, where a test asks for it, the audit writer.
 */
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/configure-app.js';
import { PASSWORD_DENYLIST } from '../../src/auth/local-password-denylist.js';
import { PasswordPolicyService } from '../../src/auth/password-policy.service.js';
import {
  ACTIVATION_DELIVERY,
  type ActivationDelivery,
} from '../../src/modules/identity/activation-delivery.js';
import {
  BusinessAuditService,
  type BusinessAuditAction,
  type BusinessAuditEntry,
} from '../../src/modules/audit/business-audit.service.js';

export const ORIGIN = 'https://localhost:8443';

export class RecordingDelivery implements ActivationDelivery {
  readonly sent: { email: string; rawToken: string }[] = [];
  fail = false;

  async deliver(email: string, rawToken: string): Promise<void> {
    if (this.fail) throw new Error('synthetic delivery failure');
    this.sent.push({ email, rawToken });
  }

  tokenFor(email: string): string {
    const match = this.sent.filter((entry) => entry.email === email);
    if (match.length !== 1) throw new Error(`Expected exactly one delivery, got ${match.length}`);
    return match[0].rawToken;
  }
}

/** Real audit writer that fails on one configured action (fault injection). */
export class FailingAudit extends BusinessAuditService {
  constructor(private readonly failOn: BusinessAuditAction) {
    super();
  }

  override async recordBusinessAction(
    client: Parameters<BusinessAuditService['recordBusinessAction']>[0],
    entry: BusinessAuditEntry,
  ): Promise<void> {
    if (entry.action === this.failOn) throw new Error(`synthetic audit failure (${entry.action})`);
    await super.recordBusinessAction(client, entry);
  }
}

export type EmployeesAppOptions = { audit?: BusinessAuditService };

export async function bootEmployeesApp(
  delivery: RecordingDelivery,
  options: EmployeesAppOptions = {},
): Promise<INestApplication<App>> {
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PASSWORD_DENYLIST)
    .useValue(new Set<string>())
    // No network in tests: the breached-password lookup is outside SP-07.
    .overrideProvider(PasswordPolicyService)
    .useValue({ assertAllowed: async () => {} })
    .overrideProvider(ACTIVATION_DELIVERY)
    .useValue(delivery);
  if (options.audit) {
    builder = builder.overrideProvider(BusinessAuditService).useValue(options.audit);
  }
  const moduleFixture = await builder.compile();
  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.init();
  return app;
}
