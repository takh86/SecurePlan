import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('./check-public.mjs', import.meta.url));
const syntheticCredential = ['ghp', '_', 'A'.repeat(36)].join('');

async function fixture(t) {
  const base = await realpath(tmpdir());
  const directory = await mkdtemp(join(base, 'secureplan-public-check-'));
  t.after(async () => {
    if (
      dirname(directory) !== base ||
      !basename(directory).startsWith('secureplan-public-check-')
    ) {
      throw new Error('Unexpected fixture cleanup path');
    }
    await rm(directory, { recursive: true });
  });
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  await writeFile(join(directory, '.gitignore'), '.env\nignored.txt\n');
  execFileSync('git', ['add', '.gitignore'], { cwd: directory });
  return {
    write: (name, value) => writeFile(join(directory, name), value),
    track: (name) =>
      execFileSync('git', ['add', '--force', name], { cwd: directory }),
    check: () =>
      spawnSync(process.execPath, [checker], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 10_000,
      }),
  };
}

test('public check includes untracked source but excludes ignored runtime files', async (t) => {
  const repo = await fixture(t);
  await repo.write('ignored.txt', syntheticCredential);
  await repo.write('.env', syntheticCredential);
  assert.equal(repo.check().status, 0);
  await repo.write('pending.txt', syntheticCredential);
  const result = repo.check();
  assert.equal(result.status, 1);
  assert.equal(result.stderr.includes('pending.txt: credential pattern'), true);
  assert.equal(result.stderr.includes(syntheticCredential), false);
});

test('public check continues to reject credentials in tracked files', async (t) => {
  const repo = await fixture(t);
  await repo.write('tracked.txt', syntheticCredential);
  repo.track('tracked.txt');
  const result = repo.check();
  assert.equal(result.status, 1);
  assert.equal(result.stderr.includes('tracked.txt: credential pattern'), true);
  assert.equal(result.stderr.includes(syntheticCredential), false);
});

test('public check rejects a tracked environment file while allowing its example', async (t) => {
  const repo = await fixture(t);
  await repo.write('.env.example', 'SYNTHETIC_EXAMPLE=only\n');
  assert.equal(repo.check().status, 0);
  await repo.write('.env', 'SYNTHETIC_EXAMPLE=only\n');
  repo.track('.env');
  const result = repo.check();
  assert.equal(result.status, 1);
  assert.equal(result.stderr.includes('.env: internal path'), true);
});
