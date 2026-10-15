import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function isMainModule(url) {
  return (
    Boolean(process.argv[1]) && fileURLToPath(url) === resolve(process.argv[1])
  );
}

export function assertLocalDemoEnvironment() {
  if (process.env.NODE_ENV !== 'development') {
    throw new Error('Development mode required');
  }

  let url;
  try {
    url = new URL(process.env.DATABASE_URL);
  } catch {
    // URL errors can contain the original connection string.
    throw new Error('Local SecurePlan database required');
  }

  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.port !== '5432' ||
    url.pathname !== '/secureplan' ||
    url.username !== 'secureplan' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('Local SecurePlan database required');
  }
}
