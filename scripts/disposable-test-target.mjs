/** Fail closed before fixture-capable commands. Receipts contain no credentials. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const fail = () => { throw new Error('A verified disposable PostgreSQL test target is required'); };
export const connectionHash = (value) => createHash('sha256').update(value).digest('hex');

export function validateDisposableContainer(container, runId, connectionString) {
  let url;
  try { url = new URL(connectionString); } catch { fail(); }
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(runId ?? '') ||
      !/^[a-f0-9]{64}$/.test(container?.Id ?? '') || !container.State?.Running ||
      container.Config?.Labels?.['secureplan.disposable-test'] !== runId ||
      container.Config?.Image !== 'postgres:17' ||
      !Object.hasOwn(container.HostConfig?.Tmpfs ?? {}, '/var/lib/postgresql/data') ||
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/secureplan' || url.username !== 'secureplan' || url.search || url.hash) fail();
  const binding = container.NetworkSettings?.Ports?.['5432/tcp'];
  if (!binding?.some((port) => port.HostIp === '127.0.0.1' && port.HostPort === url.port)) fail();
  const env = container.Config.Env ?? [];
  if (!env.includes('POSTGRES_DB=secureplan') || !env.includes('POSTGRES_USER=secureplan') ||
      env.some((entry) => entry.startsWith('PGDATA=') && entry !== 'PGDATA=/var/lib/postgresql/data')) fail();
  if (container.Mounts?.some((mount) => mount.Destination === '/var/lib/postgresql/data' && mount.Type !== 'tmpfs')) fail();
  return url;
}

async function identity(connectionString) {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const { rows: [row] } = await client.query(`SELECT current_database() AS database,
      current_user AS role, current_setting('server_version_num')::int AS version,
      inet_server_port() AS port, system_identifier::text AS cluster
      FROM pg_control_system()`);
    if (row.database !== 'secureplan' || row.role !== 'secureplan' || row.port !== 5432 ||
        row.version < 170000 || row.version >= 180000 || !/^\d+$/.test(row.cluster)) fail();
    return row;
  } finally { await client.end().catch(() => {}); }
}

export function assertRecordedTestEnvironment(env = process.env, read = readFileSync) {
  if (!env.DATABASE_URL || !env.SECUREPLAN_TEST_TARGET_RECEIPT) fail();
  let receipt;
  try { receipt = JSON.parse(read(env.SECUREPLAN_TEST_TARGET_RECEIPT, 'utf8').replace(/^\uFEFF/, '')); }
  catch { fail(); }
  const age = Date.now() - Date.parse(receipt.verifiedAt);
  if (receipt.kind !== 'secureplan-disposable-postgres-v1' ||
      !/^[a-f0-9]{64}$/.test(receipt.containerId ?? '') ||
      !/^[a-zA-Z0-9-]{8,80}$/.test(receipt.runId ?? '') ||
      !/^\d+$/.test(receipt.cluster ?? '') ||
      !Number.isFinite(age) || age < -60_000 || age > 86_400_000 ||
      !receipt.connectionHashes?.includes(connectionHash(env.DATABASE_URL))) fail();
  return receipt;
}

export async function verifyRecordedTestTarget(env = process.env) {
  const receipt = assertRecordedTestEnvironment(env);
  const actual = await identity(env.DATABASE_URL);
  if (actual.cluster !== receipt.cluster) fail();
  return receipt;
}

async function record() {
  const { DATABASE_URL, SECUREPLAN_TEST_CONTAINER_ID: containerId,
    SECUREPLAN_TEST_RUN_ID: runId, SECUREPLAN_TEST_TARGET_RECEIPT: target } = process.env;
  if (!target || !/^[a-f0-9]{64}$/.test(containerId ?? '')) fail();
  const [container] = JSON.parse(execFileSync(process.env.SECUREPLAN_TEST_DOCKER_PATH ?? 'docker',
    ['inspect', containerId], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  if (container.Id !== containerId) fail();
  const url = validateDisposableContainer(container, runId, DATABASE_URL);
  const actual = await identity(DATABASE_URL);
  const internal = new URL(url); internal.hostname = '127.0.0.1'; internal.port = '5432';
  const receipt = { kind: 'secureplan-disposable-postgres-v1', containerId, runId,
    createdAt: container.Created, verifiedAt: new Date().toISOString(), cluster: actual.cluster,
    connectionHashes: [...new Set([connectionHash(DATABASE_URL), connectionHash(internal.href)])] };
  writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  console.log(`Verified disposable PostgreSQL 17: ${containerId.slice(0, 12)} / ${runId}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'record') await record();
    else { await verifyRecordedTestTarget(); console.log('Disposable test identity reverified (read-only).'); }
  } catch {
    console.error('Disposable test target verification failed; no fixture or migration write was authorized.');
    process.exitCode = 1;
  }
}
