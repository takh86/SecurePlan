import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PASSWORD_DENYLIST } from './local-password-denylist.js';

async function readLimitedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) {
    throw new Error('Response body is missing');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });

  let totalBytes = 0;
  let text = '';
  let completed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        completed = true;
        break;
      }

      totalBytes += value.byteLength;

      if (totalBytes > maxBytes) {
        throw new Error('Response body is too large');
      }

      text += decoder.decode(value, { stream: true });
    }

    text += decoder.decode();

    if (totalBytes === 0) {
      throw new Error('Response body is empty');
    }

    return text;
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // Ignore cleanup errors.
      }
    }

    reader.releaseLock();
  }
}

@Injectable()
export class PasswordPolicyService {
  constructor(
    @Inject(PASSWORD_DENYLIST)
    private readonly localDenylist: ReadonlySet<string>,
  ) {}
  async assertAllowed(password: string): Promise<void> {
    // Defense in depth: also validate direct service calls.
    if (
      typeof password !== 'string' ||
      password.length < 15 ||
      password.length > 128
    ) {
      this.rejectPassword();
    }

    // Case-insensitive comparison only.
    // Never modify the password before hashing it with Argon2id.
    if (this.localDenylist.has(password.toLowerCase())) {
      this.rejectPassword();
    }
    const sha1 = createHash('sha1')
      .update(password, 'utf8')
      .digest('hex')
      .toUpperCase();

    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    let responseBody: string;

    try {
      const response = await fetch(
        `https://api.pwnedpasswords.com/range/${prefix}`,
        {
          headers: {
            'Add-Padding': 'true',
            'User-Agent': 'SecurePlan/1.0',
          },
          signal: AbortSignal.timeout(5000),
        },
      );

      if (!response.ok) {
        throw new Error('Password breach lookup unavailable');
      }

      responseBody = await readLimitedText(response, 200_000);

      if (responseBody.length === 0 || responseBody.length > 200_000) {
        throw new Error('Invalid breach lookup response');
      }
    } catch {
      // Do not log the password, its hash, or provider response.
      throw new ServiceUnavailableException({
        code: 'SERVICE_UNAVAILABLE',
      });
    }

    for (const line of responseBody.trim().split(/\r?\n/)) {
      const match = /^([A-Fa-f0-9]{35}):(\d+)$/.exec(line.trim());

      if (!match) {
        throw new ServiceUnavailableException({
          code: 'SERVICE_UNAVAILABLE',
        });
      }

      const matchedSuffix = match[1].toUpperCase() === suffix;
      const breachedCount = Number(match[2]);

      // Count 0 indicates a padding entry.
      if (matchedSuffix && breachedCount > 0) {
        this.rejectPassword();
      }
    }
  }

  private rejectPassword(): never {
    throw new BadRequestException({
      code: 'PASSWORD_POLICY_VIOLATION',
    });
  }
}
