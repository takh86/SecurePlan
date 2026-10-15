import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const PASSWORD_DENYLIST = 'SECUREPLAN_PASSWORD_DENYLIST';
const EXPECTED_SHA256 =
  '444fe688056748aa03573e1c262a15a855a28fe64273a687ee4818c9bb6ecefc';

const EXPECTED_ENTRIES = 430;

export function loadPasswordDenylist(
  filePath: string,
): ReadonlySet<string> {
  if (!filePath) {
    throw new Error('Password denylist path is not configured');
  }

  let file: Buffer;

  try {
    file = readFileSync(filePath);
  } catch {
    throw new Error('Password denylist is unavailable');
  }

  const actualHash = createHash('sha256')
    .update(file)
    .digest('hex');

  if (actualHash !== EXPECTED_SHA256) {
    throw new Error('Password denylist integrity check failed');
  }

  let content: string;

  try {
    content = new TextDecoder('utf-8', {
      fatal: true,
    }).decode(file);
  } catch {
    throw new Error('Password denylist encoding is invalid');
  }

  const entries = content.split('\n');

  if (entries.at(-1) !== '') {
    throw new Error('Password denylist format is invalid');
  }

  entries.pop();

  if (
    entries.length !== EXPECTED_ENTRIES ||
    entries.some(
      (entry, index) =>
        entry.length < 15 ||
        entry.length > 128 ||
        entry !== entry.toLowerCase() ||
        (index > 0 && entries[index - 1] >= entry),
    )
  ) {
    throw new Error('Password denylist contents are invalid');
  }

  return new Set(entries);
}