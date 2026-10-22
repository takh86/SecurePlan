import { randomUUID } from 'node:crypto';

import { DatabaseService } from '../apps/backend/dist/database/database.service.js';
import { SessionService } from '../apps/backend/dist/auth/session.service.js';
import { ActivationMailService } from '../apps/backend/dist/auth/activation-mail.service.js';
import { AccountLifecycleService } from '../apps/backend/dist/modules/identity/account-lifecycle.service.js';
import { BusinessAuditService } from '../apps/backend/dist/modules/audit/business-audit.service.js';
import {
  assertLocalDemoEnvironment,
  isMainModule,
} from './activation-demo-environment.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Internal development recovery tool for SP-07 (deliberately no HTTP endpoint).
// Starts a NEW activation-token lifecycle for an employee whose account is still
// PENDING_ACTIVATION, e.g. after a failed activation delivery. Older unused
// tokens are revoked; the raw token is never printed or stored.
// Usage: SP07_COMPANY_ID=<uuid> SP07_EMPLOYEE_ID=<uuid> \
//   node --env-file=.env scripts/reissue-employee-activation.mjs
export async function reissueEmployeeActivation(
  { database, accounts, audit, mailer },
  companyId,
  employeeId,
) {
  assertLocalDemoEnvironment();
  if (!UUID.test(companyId ?? '') || !UUID.test(employeeId ?? '')) {
    throw new Error('Invalid identifiers');
  }

  const correlationId = randomUUID();
  const issued = await database.withTransaction(async (client) => {
    const employee = await client.query(
      'SELECT account_id FROM employees WHERE company_id = $1 AND id = $2',
      [companyId, employeeId],
    );
    if (employee.rowCount !== 1) throw new Error('Employee not found');
    const accountId = employee.rows[0].account_id;

    const reissued = await accounts.reissueActivation(client, companyId, accountId);
    if (!reissued) throw new Error('Account is not pending activation');

    await audit.recordBusinessAction(client, {
      companyId,
      actorAccountId: null,
      action: 'ACCOUNT_ACTIVATION_REISSUED',
      resourceType: 'ACCOUNT',
      resourceId: accountId,
      newValues: { reason: 'INTERNAL_RECOVERY' },
      correlationId,
    });
    return { accountId, ...reissued };
  });

  // SMTP runs outside the database transaction.
  try {
    await mailer.sendActivationEmail(issued.email, issued.activation.rawToken);
  } catch {
    // The new token must not remain usable after a confirmed send failure.
    await database.withTransaction((client) =>
      accounts.revokeUndeliveredActivation(
        client,
        companyId,
        issued.accountId,
        issued.activation.tokenId,
      ),
    );
    throw new Error('Local SMTP delivery failed');
  }
  return { accountId: issued.accountId, correlationId };
}

if (isMainModule(import.meta.url)) {
  let database;
  try {
    assertLocalDemoEnvironment();
    database = new DatabaseService();
    const result = await reissueEmployeeActivation(
      {
        database,
        accounts: new AccountLifecycleService(new SessionService(database)),
        audit: new BusinessAuditService(),
        mailer: new ActivationMailService(),
      },
      process.env.SP07_COMPANY_ID,
      process.env.SP07_EMPLOYEE_ID,
    );
    console.log('REISSUE=PASS');
    console.log(`CORRELATION_ID=${result.correlationId}`);
  } catch {
    // Never print raw tokens, links, addresses or SQL details.
    console.error('REISSUE=FAILED');
    process.exitCode = 1;
  } finally {
    if (database) {
      await database.onApplicationShutdown().catch(() => {
        console.error('REISSUE=FAILED');
        process.exitCode = 1;
      });
    }
  }
}
