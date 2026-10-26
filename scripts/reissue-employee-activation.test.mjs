// DB-free tests for the SP-07 internal reissue tool. The database-backed core
// (AccountLifecycleService.reissueActivation) is covered against real
// PostgreSQL in apps/backend/test/employees-concurrency-real.e2e-spec.ts.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { reissueEmployeeActivation } from './reissue-employee-activation.mjs';

const COMPANY = '6f1ad9a6-3a0c-4b7c-9c5e-0d4f2a1e8b11';
const EMPLOYEE = '0b9e3c55-6d3e-4a8e-9a77-5b3f6e1c2d44';
const ACCOUNT = '9d2c1b0a-1111-4222-8333-444455556666';
const original = { NODE_ENV: process.env.NODE_ENV, DATABASE_URL: process.env.DATABASE_URL };

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function localEnvironment() {
  process.env.NODE_ENV = 'development';
  process.env.DATABASE_URL = 'postgresql://secureplan:synthetic@127.0.0.1:5432/secureplan';
}

function fakes({ employeeRows = [{ account_id: ACCOUNT }], reissued, mailFails = false } = {}) {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push(['query', sql.trim().split(/\s+/).slice(0, 3).join(' '), params]);
      return { rowCount: employeeRows.length, rows: employeeRows };
    },
  };
  return {
    calls,
    deps: {
      database: { withTransaction: async (work) => work(client) },
      accounts: {
        async reissueActivation(_client, companyId, accountId) {
          calls.push(['reissue', companyId, accountId]);
          return reissued === undefined
            ? { email: 'pending@secureplan.test', activation: { tokenId: 'token-2', rawToken: 'r'.repeat(43) } }
            : reissued;
        },
        async revokeUndeliveredActivation(_client, companyId, accountId, tokenId) {
          calls.push(['revoke', companyId, accountId, tokenId]);
          return true;
        },
      },
      audit: {
        async recordBusinessAction(_client, entry) {
          calls.push(['audit', entry.action, entry.actorAccountId, entry.resourceId]);
        },
      },
      mailer: {
        async sendActivationEmail(email, rawToken) {
          calls.push(['mail', email, rawToken.length]);
          if (mailFails) throw new Error('synthetic SMTP failure');
        },
      },
    },
  };
}

test('environment guard and identifier checks run before any database access', async () => {
  process.env.NODE_ENV = 'production';
  process.env.DATABASE_URL = 'postgresql://secureplan:synthetic@127.0.0.1:5432/secureplan';
  const blocked = fakes();
  await assert.rejects(reissueEmployeeActivation(blocked.deps, COMPANY, EMPLOYEE), /Development mode required/);
  assert.deepEqual(blocked.calls, []);

  localEnvironment();
  const invalid = fakes();
  await assert.rejects(reissueEmployeeActivation(invalid.deps, COMPANY, "1' OR '1'='1"), /Invalid identifiers/);
  await assert.rejects(reissueEmployeeActivation(invalid.deps, undefined, EMPLOYEE), /Invalid identifiers/);
  assert.deepEqual(invalid.calls, []);
});

test('reissues for the tenant-scoped employee, audits without an actor and sends exactly once', async () => {
  localEnvironment();
  const { deps, calls } = fakes();
  const result = await reissueEmployeeActivation(deps, COMPANY, EMPLOYEE);
  assert.equal(result.accountId, ACCOUNT);
  assert.deepEqual(calls[0], ['query', 'SELECT account_id FROM', [COMPANY, EMPLOYEE]]);
  assert.deepEqual(calls.slice(1), [
    ['reissue', COMPANY, ACCOUNT],
    ['audit', 'ACCOUNT_ACTIVATION_REISSUED', null, ACCOUNT],
    ['mail', 'pending@secureplan.test', 43],
  ]);
});

test('unknown employee or non-pending account: no token, no mail', async () => {
  localEnvironment();
  const missing = fakes({ employeeRows: [] });
  await assert.rejects(reissueEmployeeActivation(missing.deps, COMPANY, EMPLOYEE), /Employee not found/);
  assert.equal(missing.calls.some(([kind]) => kind === 'mail' || kind === 'reissue'), false);

  const active = fakes({ reissued: null });
  await assert.rejects(reissueEmployeeActivation(active.deps, COMPANY, EMPLOYEE), /not pending activation/);
  assert.equal(active.calls.some(([kind]) => kind === 'mail' || kind === 'audit'), false);
});

test('a failed send revokes the new token and reports only a sanitized error', async () => {
  localEnvironment();
  const { deps, calls } = fakes({ mailFails: true });
  await assert.rejects(reissueEmployeeActivation(deps, COMPANY, EMPLOYEE), (error) => {
    assert.equal(error.message, 'Local SMTP delivery failed');
    assert.equal(error.message.includes('r'.repeat(43)), false);
    return true;
  });
  assert.deepEqual(calls.at(-1), ['revoke', COMPANY, ACCOUNT, 'token-2']);
});
