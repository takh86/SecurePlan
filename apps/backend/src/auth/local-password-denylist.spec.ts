import {
  afterAll,
  describe,
  expect,
  it,
} from 'vitest';

import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadPasswordDenylist } from './local-password-denylist.js';

describe('Local Password Denylist — Security', () => {
  const testDirectory = mkdtempSync(
    join(tmpdir(), 'secureplan-denylist-test-'),
  );

  afterAll(() => {
    rmSync(testDirectory, {
      recursive: true,
      force: true,
    });
  });

  it('rejects a missing configuration path', () => {
    expect(() => loadPasswordDenylist('')).toThrow(
      'Password denylist path is not configured',
    );
  });

  it('rejects a missing denylist file', () => {
    const missingPath = join(
      testDirectory,
      'missing-denylist.txt',
    );

    expect(() => loadPasswordDenylist(missingPath)).toThrow(
      'Password denylist is unavailable',
    );
  });

  it('rejects a modified or untrusted denylist', () => {
    const filePath = join(
      testDirectory,
      'tampered-denylist.txt',
    );

    writeFileSync(
      filePath,
      'this-is-not-the-approved-password-denylist\n',
      'utf8',
    );

    expect(() => loadPasswordDenylist(filePath)).toThrow(
      'Password denylist integrity check failed',
    );
  });
});