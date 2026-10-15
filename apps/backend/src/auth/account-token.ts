import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function digestToken(token: string): Buffer {
  return createHash('sha256')
    .update(token, 'utf8')
    .digest();
}

export function generateAccountToken(): {
  rawToken: string;
  tokenHash: Buffer;
} {
  const rawToken = randomBytes(TOKEN_BYTES).toString('base64url');

  return {
    rawToken,
    tokenHash: digestToken(rawToken),
  };
}

export function hashAccountToken(token: string): Buffer | null {
  if (!TOKEN_PATTERN.test(token)) {
    return null;
  }

  return digestToken(token);
}