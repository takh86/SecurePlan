import { randomUUID } from 'node:crypto';

import { DatabaseService } from '../apps/backend/dist/database/database.service.js';
import { generateAccountToken } from '../apps/backend/dist/auth/account-token.js';
import { ActivationMailService } from '../apps/backend/dist/auth/activation-mail.service.js';
import {
  assertLocalDemoEnvironment,
  isMainModule,
} from './activation-demo-environment.mjs';

// Tenant roles the local demo may create. PLATFORM_ADMIN is deliberately excluded.
export const DEMO_ROLES = Object.freeze(['EMPLOYEE', 'COMPANY_ADMIN']);

// Internal development tool only. Never use with production data.
// Usage: node --env-file=.env scripts/bootstrap-activation-demo.mjs
//   optional SP04_DEMO_ROLE=EMPLOYEE (default) | COMPANY_ADMIN; anything else is rejected.
// Writes one new company, one PENDING_ACTIVATION account and one activation token.
// If local mail delivery fails, only that new token is revoked; nothing else is changed.
export async function bootstrapActivationDemo(database, mailer, role = 'EMPLOYEE') {
  assertLocalDemoEnvironment();
  if (!DEMO_ROLES.includes(role)) {
    throw new Error('Unsupported demo role');
  }

  const companyId = randomUUID();
  const accountId = randomUUID();
  const email = `sp04-${accountId}@secureplan.test`;

  const { rawToken, tokenHash } = generateAccountToken();

  // The account and hashed token are committed together.
  await database.withTransaction(async (client) => {
    await client.query(
      `INSERT INTO companies
         (id, name, status, time_zone)
       VALUES ($1, $2, 'ACTIVE', 'Europe/Berlin')`,
      [companyId, `SP04 Demo ${companyId.slice(0, 8)}`],
    );

    await client.query(
      `INSERT INTO accounts
         (id, company_id, email, account_scope, role, status)
       VALUES
         ($1, $2, $3, 'TENANT', $4, 'PENDING_ACTIVATION')`,
      [accountId, companyId, email, role],
    );

    await client.query(
      `INSERT INTO account_tokens
         (company_id, account_id, purpose, token_hash, expires_at)
       VALUES
         ($1, $2, 'EMAIL_VERIFICATION', $3,
          clock_timestamp() + INTERVAL '24 hours')`,
      [companyId, accountId, tokenHash],
    );
  });

  // SMTP must run outside the database transaction.
  try {
    await mailer.sendActivationEmail(email, rawToken);
  } catch {
    // The token must not remain usable after confirmed send failure.
    await database.withTransaction(async (client) => {
      await client.query(
        `UPDATE account_tokens
         SET revoked_at = clock_timestamp()
         WHERE company_id = $1
           AND account_id = $2
           AND token_hash = $3
           AND used_at IS NULL
           AND revoked_at IS NULL`,
        [companyId, accountId, tokenHash],
      );
    });

    throw new Error('Local SMTP delivery failed');
  }

  return { email, companyId };
}

if (isMainModule(import.meta.url)) {
  let database;
  try {
    assertLocalDemoEnvironment();
    const mailer = new ActivationMailService();
    database = new DatabaseService();
    const role = process.env.SP04_DEMO_ROLE ?? 'EMPLOYEE';
    const result = await bootstrapActivationDemo(database, mailer, role);
    console.log('BOOTSTRAP=PASS');
    console.log('ACTIVATION_EMAIL=PASS');
    console.log(`TEST_EMAIL=${result.email}`);
    console.log(`TEST_COMPANY_ID=${result.companyId}`);
    console.log(`TEST_ROLE=${role}`);
  } catch {
    // Never print raw tokens, URLs or sensitive SMTP details.
    console.error('BOOTSTRAP=FAILED');
    process.exitCode = 1;
  } finally {
    if (database) {
      await database.onApplicationShutdown().catch(() => {
        console.error('BOOTSTRAP=FAILED');
        process.exitCode = 1;
      });
    }
  }
}
