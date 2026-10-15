import { DatabaseService } from '../apps/backend/dist/database/database.service.js';
import { generateAccountToken } from '../apps/backend/dist/auth/account-token.js';
import { ActivationMailService } from '../apps/backend/dist/auth/activation-mail.service.js';
import {
  assertLocalDemoEnvironment,
  isMainModule,
} from './activation-demo-environment.mjs';

export async function reissueActivationDemo(database, mailer, since) {
  assertLocalDemoEnvironment();
  if (!since || Number.isNaN(Date.parse(since))) {
    throw new Error('Failure-test timestamp missing');
  }
  const { rawToken, tokenHash } = generateAccountToken();

  const target = await database.withTransaction(async (client) => {
    const result = await client.query(
      `
      SELECT a.id AS account_id, a.company_id, a.email
      FROM accounts a
      JOIN companies c ON c.id = a.company_id
      WHERE c.name LIKE 'SP04 Demo %'
        AND c.created_at >= $1::timestamptz
        AND c.status = 'ACTIVE'
        AND a.status = 'PENDING_ACTIVATION'
        AND a.account_scope = 'TENANT'
        AND a.password_hash IS NULL
        AND EXISTS (
          SELECT 1 FROM account_tokens t
          WHERE t.company_id = a.company_id
            AND t.account_id = a.id
            AND t.purpose = 'EMAIL_VERIFICATION'
            AND t.used_at IS NULL
            AND t.revoked_at IS NOT NULL
        )
      FOR UPDATE OF a
    `,
      [since],
    );

    if (result.rowCount !== 1) {
      throw new Error('Expected exactly one failed demo account');
    }

    const account = result.rows[0];

    if (!/^[^@\s]+@secureplan\.test$/i.test(account.email)) {
      throw new Error('Not a synthetic test account');
    }

    // Lock ordering: account first, then tokens.
    const tokens = await client.query(
      `
      SELECT used_at, revoked_at
      FROM account_tokens
      WHERE company_id = $1
        AND account_id = $2
        AND purpose = 'EMAIL_VERIFICATION'
      FOR UPDATE
    `,
      [account.company_id, account.account_id],
    );

    // This recovery tool only handles failed deliveries.
    // Do not silently replace a currently issued token.
    if (
      tokens.rows.length === 0 ||
      tokens.rows.some(
        (token) => token.used_at !== null || token.revoked_at === null,
      )
    ) {
      throw new Error('Account is not eligible for failed-mail recovery');
    }

    await client.query(
      `
      INSERT INTO account_tokens
        (company_id, account_id, purpose, token_hash, expires_at)
      VALUES ($1, $2, 'EMAIL_VERIFICATION', $3,
              clock_timestamp() + INTERVAL '24 hours')
    `,
      [account.company_id, account.account_id, tokenHash],
    );

    return account;
  });

  try {
    await mailer.sendActivationEmail(target.email, rawToken);
  } catch {
    await database.withTransaction(async (client) => {
      await client.query(
        `
        UPDATE account_tokens
        SET revoked_at = clock_timestamp()
        WHERE company_id = $1
          AND account_id = $2
          AND token_hash = $3
          AND used_at IS NULL
          AND revoked_at IS NULL
      `,
        [target.company_id, target.account_id, tokenHash],
      );
    });

    throw new Error('Reissue email delivery failed');
  }

  return { email: target.email };
}

if (isMainModule(import.meta.url)) {
  let database;
  try {
    assertLocalDemoEnvironment();
    const mailer = new ActivationMailService();
    database = new DatabaseService();
    const result = await reissueActivationDemo(
      database,
      mailer,
      process.env.SP04_FAILURE_TEST_SINCE,
    );
    console.log('REISSUE=PASS');
    console.log('ACTIVATION_EMAIL=PASS');
    console.log(`TEST_EMAIL=${result.email}`);
  } catch {
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
