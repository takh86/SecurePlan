import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyRecordedTestTarget } from './disposable-test-target.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
try {
  await verifyRecordedTestTarget();
  const command = process.argv[2];
  let args; let cwd = root;
  if (command === 'e2e') {
    cwd = fileURLToPath(new URL('../apps/backend/', import.meta.url));
    args = [fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)),
      'run', '--config', './vitest.config.e2e.ts', ...process.argv.slice(3)];
  } else if (command === 'scripts') {
    args = ['--test', 'scripts/activation-demo.test.mjs', 'scripts/check-public.test.mjs',
      'scripts/reissue-employee-activation.test.mjs', 'scripts/disposable-test-target.test.mjs',
      'scripts/migration-safety.test.mjs'];
  } else { throw new Error('Unknown verified test command'); }
  // No env-file fallback. Children inherit only the explicitly verified connection.
  const child = spawn(process.execPath, args, { cwd, env: process.env, stdio: 'inherit' });
  child.on('error', () => { console.error('Verified test process failed to start'); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
} catch {
  console.error('Tests refused before loading fixtures: verified disposable PostgreSQL target required.');
  process.exitCode = 1;
}
