import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertRecordedTestEnvironment, connectionHash, validateDisposableContainer } from './disposable-test-target.mjs';

const url = 'postgresql://secureplan:synthetic@127.0.0.1:54321/secureplan';
const runId = 'synthetic-disposable-run';
const container = () => ({ Id: 'a'.repeat(64), State: { Running: true },
  Config: { Image: 'postgres:17', Labels: { 'secureplan.disposable-test': runId },
    Env: ['POSTGRES_DB=secureplan', 'POSTGRES_USER=secureplan'] },
  HostConfig: { Tmpfs: { '/var/lib/postgresql/data': 'rw' } },
  NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '54321' }] } },
  Mounts: [{ Type: 'tmpfs', Destination: '/var/lib/postgresql/data' }] });

test('fresh labelled memory-only container and exact loopback transport accepted', () => {
  assert.equal(validateDisposableContainer(container(), runId, url).port, '54321');
});
for (const [name, change] of [
  ['unlabelled', (c) => { c.Config.Labels = {}; }],
  ['shared volume', (c) => { c.Mounts[0].Type = 'volume'; }],
  ['persistent storage', (c) => { c.HostConfig.Tmpfs = {}; }],
  ['stopped', (c) => { c.State.Running = false; }],
  ['different port', (c) => { c.NetworkSettings.Ports['5432/tcp'][0].HostPort = '5432'; }],
  ['all-interface binding', (c) => { c.NetworkSettings.Ports['5432/tcp'][0].HostIp = '0.0.0.0'; }],
]) test(`refuses ${name} container before database access`, () => {
  const value = container(); change(value);
  assert.throws(() => validateDisposableContainer(value, runId, url), /verified disposable/);
});
test('missing, ambiguous, stale and mismatched receipts fail closed without reading .env', () => {
  const receipt = { kind: 'secureplan-disposable-postgres-v1', containerId: 'a'.repeat(64), runId,
    cluster: '12345', verifiedAt: new Date().toISOString(), connectionHashes: [connectionHash(url)] };
  const read = () => JSON.stringify(receipt);
  assert.throws(() => assertRecordedTestEnvironment({}, read));
  const env = { DATABASE_URL: url, SECUREPLAN_TEST_TARGET_RECEIPT: 'synthetic.json' };
  assert.equal(assertRecordedTestEnvironment(env, read).cluster, '12345');
  for (const unsafe of ['postgresql://secureplan:synthetic@127.0.0.1:5432/secureplan',
    'postgresql://secureplan:synthetic@shared.example/secureplan',
    'postgresql://secureplan:synthetic@production.example/secureplan']) {
    assert.throws(() => assertRecordedTestEnvironment({ ...env, DATABASE_URL: unsafe }, read));
  }
  receipt.verifiedAt = '2020-01-01T00:00:00Z';
  assert.throws(() => assertRecordedTestEnvironment(env, read));
});
