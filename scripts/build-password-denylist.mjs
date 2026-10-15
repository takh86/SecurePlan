import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SOURCE_REVISION =
  '997dd861b9fa2623f06f30d5f9085713ce830f0c';

const sources = [
  {
    name: '100k-most-used-passwords-NCSC.txt',
    sha256:
      'C2E5696882C603B76BB67A47EE970897E5A76FC4C3F5547ABE3D0CA340C576E0',
  },
  {
    name: 'Pwdb_top-100000.txt',
    sha256:
      '07F876A616F08FB2CC5C3E0CE04E4A6D1123380580472B0997BAEBC4E8226977',
  },
];

const folder = join(tmpdir(), 'secureplan-password-denylist');
const passwords = new Set();

for (const source of sources) {
  const file = await readFile(join(folder, source.name));

  const actualHash = createHash('sha256')
    .update(file)
    .digest('hex')
    .toUpperCase();

  if (actualHash !== source.sha256) {
    throw new Error(`Source integrity check failed: ${source.name}`);
  }

  const content = new TextDecoder('utf-8', {
    fatal: true,
  }).decode(file);

  let accepted = 0;

  for (const password of content.split(/\r?\n/)) {
    if (password.length < 15 || password.length > 128) {
      continue;
    }

    // Only normalize for comparison, never for password hashing.
    passwords.add(password.toLowerCase());
    accepted++;
  }

  console.log(`VERIFIED: ${source.name}`);
  console.log(`ELIGIBLE_ENTRIES: ${accepted}`);
}

if (passwords.size === 0) {
  throw new Error('Generated denylist must not be empty');
}

const outputPath = join(folder, 'secureplan-local-denylist.txt');
const output = [...passwords].sort().join('\n') + '\n';

await writeFile(outputPath, output, {
  encoding: 'utf8',
  mode: 0o600,
});

const outputHash = createHash('sha256')
  .update(output, 'utf8')
  .digest('hex');

console.log(`SOURCE_REVISION=${SOURCE_REVISION}`);
console.log(`UNIQUE_PASSWORDS=${passwords.size}`);
console.log(`OUTPUT_SHA256=${outputHash}`);
console.log(`OUTPUT_PATH=${outputPath}`);
console.log('GENERATOR=PASS');