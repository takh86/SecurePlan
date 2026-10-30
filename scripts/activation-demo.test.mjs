import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseService } from '../apps/backend/dist/database/database.service.js';
import { hashAccountToken } from '../apps/backend/dist/auth/account-token.js';
import { bootstrapActivationDemo, DEMO_ROLES } from './bootstrap-activation-demo.mjs';
import { reissueActivationDemo } from './reissue-activation-demo.mjs';
import { assertLocalDemoEnvironment } from './activation-demo-environment.mjs';
import { verifyRecordedTestTarget } from './disposable-test-target.mjs';

let database;
const companies = [];
// Isolate recovery selection from pre-existing synthetic demos without changing them.
const since = new Date(Date.now() + 86_400_000).toISOString();

before(async () => {
  await verifyRecordedTestTarget();
  assertLocalDemoEnvironment();
  database = new DatabaseService();
});

afterEach(async () => {
  for (const id of companies.splice(0)) {
    await database.withTransaction(async (client) => {
      await client.query('DELETE FROM account_tokens WHERE company_id = $1', [
        id,
      ]);
      await client.query('DELETE FROM accounts WHERE company_id = $1', [id]);
      await client.query('DELETE FROM companies WHERE id = $1', [id]);
    });
  }
});
after(async () => {
  if (database) await database.onApplicationShutdown();
});

async function state(email) {
  return database.withTransaction(async (client) => {
    const account = await client.query(
      'SELECT id, company_id, account_scope, role, status, password_hash FROM accounts WHERE email = $1',
      [email],
    );
    const tokens = await client.query(
      'SELECT token_hash, used_at, revoked_at FROM account_tokens WHERE account_id = $1 ORDER BY created_at',
      [account.rows[0].id],
    );
    return { account: account.rows[0], tokens: tokens.rows };
  });
}

async function failedDemo() {
  let email;
  await assert.rejects(
    bootstrapActivationDemo(database, {
      sendActivationEmail: async (recipient) => {
        email = recipient;
        throw new Error('Synthetic SMTP failure');
      },
    }),
    { message: 'Local SMTP delivery failed' },
  );
  const result = await state(email);
  companies.push(result.account.company_id);
  await database.withTransaction((client) =>
    client.query('UPDATE companies SET created_at = $1 WHERE id = $2', [
      since,
      result.account.company_id,
    ]),
  );
  return { email, ...result };
}

test('bootstrap stores only a token digest and sends a synthetic recipient', async () => {
  let delivery;
  const result = await bootstrapActivationDemo(database, {
    sendActivationEmail: async (email, token) => {
      delivery = { email, token };
    },
  });
  companies.push(result.companyId);
  const stored = await state(result.email);
  assert.equal(stored.account.role, 'EMPLOYEE');
  assert.equal(stored.account.status, 'PENDING_ACTIVATION');
  assert.equal(stored.account.password_hash, null);
  assert.equal(stored.tokens.length, 1);
  assert.equal(
    stored.tokens[0].token_hash.equals(hashAccountToken(delivery.token)),
    true,
  );
  assert.equal(stored.tokens[0].revoked_at, null);
  assert.match(delivery.email, /^sp04-[0-9a-f-]+@secureplan\.test$/);
  assert.deepEqual(Object.keys(result).sort(), ['companyId', 'email']);
});

test('failed bootstrap revokes its token and safe reissue retains the old revocation', async () => {
  const fixture = await failedDemo();
  assert.notEqual(fixture.tokens[0].revoked_at, null);
  let delivery;
  await reissueActivationDemo(
    database,
    {
      sendActivationEmail: async (email, token) => {
        delivery = { email, token };
      },
    },
    since,
  );
  const current = await state(fixture.email);
  assert.equal(current.account.status, 'PENDING_ACTIVATION');
  assert.equal(current.tokens.length, 2);
  const usable = current.tokens.filter(
    (token) => token.revoked_at === null && token.used_at === null,
  );
  assert.equal(usable.length, 1);
  assert.equal(
    usable[0].token_hash.equals(hashAccountToken(delivery.token)),
    true,
  );
  assert.equal(
    usable[0].token_hash.equals(fixture.tokens[0].token_hash),
    false,
  );
});

test('a failed reissue revokes the new token as well', async () => {
  const fixture = await failedDemo();
  await assert.rejects(
    reissueActivationDemo(
      database,
      {
        sendActivationEmail: async () => {
          throw new Error('Synthetic SMTP failure');
        },
      },
      since,
    ),
    { message: 'Reissue email delivery failed' },
  );
  const current = await state(fixture.email);
  assert.equal(current.tokens.length, 2);
  assert.equal(
    current.tokens.every(
      (token) => token.revoked_at !== null && token.used_at === null,
    ),
    true,
  );
});

test('concurrent reissues send exactly once and cannot replace a live token', async () => {
  const fixture = await failedDemo();
  let deliveries = 0;
  const mailer = {
    sendActivationEmail: async () => {
      deliveries++;
    },
  };
  const results = await Promise.allSettled([
    reissueActivationDemo(database, mailer, since),
    reissueActivationDemo(database, mailer, since),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [
    'fulfilled',
    'rejected',
  ]);
  assert.equal(deliveries, 1);
  const current = await state(fixture.email);
  assert.equal(current.tokens.length, 2);
  assert.equal(
    current.tokens.filter((token) => token.revoked_at === null).length,
    1,
  );
  await assert.rejects(reissueActivationDemo(database, mailer, since), {
    message: 'Account is not eligible for failed-mail recovery',
  });
  assert.equal(deliveries, 1);
});

test('ambiguous recovery targets cause no delivery or token writes', async () => {
  const first = await failedDemo();
  const second = await failedDemo();
  let deliveries = 0;
  await assert.rejects(
    reissueActivationDemo(
      database,
      {
        sendActivationEmail: async () => {
          deliveries++;
        },
      },
      since,
    ),
    { message: 'Expected exactly one failed demo account' },
  );
  assert.equal(deliveries, 0);
  assert.equal((await state(first.email)).tokens.length, 1);
  assert.equal((await state(second.email)).tokens.length, 1);
});

test('recovery refuses a recipient outside the synthetic demo domain', async () => {
  const fixture = await failedDemo();
  const email = `${randomUUID()}@example.invalid`;
  await database.withTransaction((client) =>
    client.query('UPDATE accounts SET email = $1 WHERE id = $2', [
      email,
      fixture.account.id,
    ]),
  );
  let deliveries = 0;
  await assert.rejects(
    reissueActivationDemo(
      database,
      {
        sendActivationEmail: async () => {
          deliveries++;
        },
      },
      since,
    ),
    { message: 'Not a synthetic test account' },
  );
  assert.equal(deliveries, 0);
  assert.equal((await state(email)).tokens.length, 1);
});

test('environment guard rejects nonlocal and connection-parameter overrides before any write', async () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
  };
  const databaseStub = {
    withTransaction: () => {
      assert.fail('Unexpected database access');
    },
  };
  const mailer = {
    sendActivationEmail: () => {
      assert.fail('Unexpected delivery');
    },
  };
  try {
    for (const url of [
      'synthetic-invalid-connection',
      'postgresql://secureplan@database.example.invalid:5432/secureplan',
      'postgresql://secureplan@127.0.0.1:5432/secureplan?host=database.example.invalid',
    ]) {
      process.env.DATABASE_URL = url;
      await assert.rejects(bootstrapActivationDemo(databaseStub, mailer), {
        message: 'Local SecurePlan database required',
      });
      await assert.rejects(reissueActivationDemo(databaseStub, mailer, since), {
        message: 'Local SecurePlan database required',
      });
    }
    process.env.DATABASE_URL = original.DATABASE_URL;
    process.env.NODE_ENV = 'production';
    await assert.rejects(bootstrapActivationDemo(databaseStub, mailer), {
      message: 'Development mode required',
    });
    await assert.rejects(reissueActivationDemo(databaseStub, mailer, since), {
      message: 'Development mode required',
    });
    process.env.NODE_ENV = original.NODE_ENV;
    await assert.rejects(
      reissueActivationDemo(databaseStub, mailer, 'invalid-date'),
      { message: 'Failure-test timestamp missing' },
    );
  } finally {
    Object.assign(process.env, original);
  }
});

/** In-memory stand-in that records the SQL a bootstrap would run, without any database. */
function recordingDatabase() {
  const queries = [];
  return {
    queries,
    withTransaction: async (work) =>
      work({
        query: async (sql, params) => {
          queries.push({ sql, params });
          return { rows: [], rowCount: 1 };
        },
      }),
  };
}

test('demo role (no database): only EMPLOYEE and COMPANY_ADMIN are supported', () => {
  assert.deepEqual([...DEMO_ROLES], ['EMPLOYEE', 'COMPANY_ADMIN']);
  assert.equal(Object.isFrozen(DEMO_ROLES), true);
});

test('demo role (no database): unsupported roles are rejected before any database access or delivery', async () => {
  const databaseStub = {
    withTransaction: () => {
      assert.fail('Unexpected database access');
    },
  };
  const mailer = {
    sendActivationEmail: () => {
      assert.fail('Unexpected delivery');
    },
  };
  for (const role of ['PLATFORM_ADMIN', 'ADMIN', 'company_admin', ' COMPANY_ADMIN', '', null, 42, ['COMPANY_ADMIN']]) {
    await assert.rejects(bootstrapActivationDemo(databaseStub, mailer, role), {
      message: 'Unsupported demo role',
    });
  }
  // The local-environment guard still runs first, also for COMPANY_ADMIN.
  const original = { NODE_ENV: process.env.NODE_ENV, DATABASE_URL: process.env.DATABASE_URL };
  try {
    process.env.DATABASE_URL = 'postgresql://secureplan@database.example.invalid:5432/secureplan';
    await assert.rejects(bootstrapActivationDemo(databaseStub, mailer, 'COMPANY_ADMIN'), {
      message: 'Local SecurePlan database required',
    });
    process.env.DATABASE_URL = original.DATABASE_URL;
    process.env.NODE_ENV = 'production';
    await assert.rejects(bootstrapActivationDemo(databaseStub, mailer, 'COMPANY_ADMIN'), {
      message: 'Development mode required',
    });
  } finally {
    Object.assign(process.env, original);
  }
});

test('demo role (no database): default EMPLOYEE and explicit COMPANY_ADMIN are bound as a query parameter', async () => {
  for (const [args, expectedRole] of [
    [[], 'EMPLOYEE'],
    [['EMPLOYEE'], 'EMPLOYEE'],
    [['COMPANY_ADMIN'], 'COMPANY_ADMIN'],
  ]) {
    const fake = recordingDatabase();
    let delivered;
    const result = await bootstrapActivationDemo(
      fake,
      {
        sendActivationEmail: async (email) => {
          delivered = email;
        },
      },
      ...args,
    );
    // Exactly one company, one account and one token insert; nothing else.
    assert.deepEqual(
      fake.queries.map(({ sql }) => sql.match(/INSERT INTO (\w+)/)?.[1]),
      ['companies', 'accounts', 'account_tokens'],
    );
    const accountInsert = fake.queries[1];
    assert.match(accountInsert.sql, /'TENANT', \$4, 'PENDING_ACTIVATION'/);
    assert.doesNotMatch(accountInsert.sql, /EMPLOYEE|COMPANY_ADMIN|PLATFORM_ADMIN/);
    assert.equal(accountInsert.params[3], expectedRole);
    assert.equal(delivered, result.email);
    assert.deepEqual(Object.keys(result).sort(), ['companyId', 'email']);
  }
});

test('demo role (no database): CLI rejects an unsupported SP04_DEMO_ROLE with only the sanitized marker', () => {
  for (const role of ['PLATFORM_ADMIN', 'admin', '']) {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('bootstrap-activation-demo.mjs', import.meta.url))],
      {
        env: { ...process.env, SP04_DEMO_ROLE: role },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'BOOTSTRAP=FAILED');
  }
});

test('demo role (real database): bootstrap creates a pending COMPANY_ADMIN tenant account with a digest-only token', async () => {
  let delivery;
  const result = await bootstrapActivationDemo(
    database,
    {
      sendActivationEmail: async (email, token) => {
        delivery = { email, token };
      },
    },
    'COMPANY_ADMIN',
  );
  companies.push(result.companyId);
  const stored = await state(result.email);
  assert.equal(stored.account.role, 'COMPANY_ADMIN');
  assert.equal(stored.account.account_scope, 'TENANT');
  assert.equal(stored.account.status, 'PENDING_ACTIVATION');
  assert.equal(stored.account.password_hash, null);
  assert.equal(stored.account.company_id, result.companyId);
  assert.equal(stored.tokens.length, 1);
  assert.equal(stored.tokens[0].token_hash.equals(hashAccountToken(delivery.token)), true);
  assert.equal(stored.tokens[0].revoked_at, null);
  assert.match(delivery.email, /^sp04-[0-9a-f-]+@secureplan\.test$/);
});

test('CLI configuration failures print only sanitized failure markers', () => {
  for (const [script, marker] of [
    ['bootstrap-activation-demo.mjs', 'BOOTSTRAP=FAILED'],
    ['reissue-activation-demo.mjs', 'REISSUE=FAILED'],
  ]) {
    for (const override of [
      { DATABASE_URL: 'synthetic-private-connection' },
      { APP_ORIGIN: 'synthetic-private-origin' },
    ]) {
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL(script, import.meta.url))],
        {
          env: { ...process.env, ...override },
          encoding: 'utf8',
          timeout: 10_000,
        },
      );
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr.trim(), marker);
    }
  }
});
