/** SP-05 Login use-case. Does not accept tenant or role from the caller. */
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { verifyPassword } from './password-hasher.js';
import { SessionService } from './session.service.js';
import type { LoginDto } from './dto/login.dto.js';

// A synthetic Argon2id hash with the same parameters as real passwords.
// Unknown users still incur password verification work; never log the password.
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$Z2FyYmFnZVNhbHQxNmJ5dGU$Ol4Y9W9T7DAW6Bp8znH+ClM9wO4NFxuSWcXsmW+ICiQ';

type AccountRecord = {
  id: string;
  company_id: string | null;
  email: string;
  role: string;
  account_scope: string;
  status: string;
  company_status: string | null;
  password_hash: string | null;
};

export type LoginResult = {
  accountId: string;
  companyId: string;
  email: string;
  role: 'EMPLOYEE' | 'COMPANY_ADMIN';
  /** Transport-only: the controller puts this into an HttpOnly cookie. */
  rawToken: string;
  csrfToken: string;
  absoluteExpiresAt: Date;
};

function invalidCredentials(): never {
  throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS' });
}

@Injectable()
export class LoginService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sessions: SessionService,
  ) {}

  async login(input: LoginDto): Promise<LoginResult> {
    // Email is globally unique case-insensitively in the approved schema.
    const email = input.email.trim().toLowerCase();
    const account = await this.database.withTransaction(async (client) => {
      const result = await client.query<AccountRecord>(
        `SELECT a.id, a.company_id, a.email, a.role, a.account_scope,
                a.status, a.password_hash, c.status AS company_status
         FROM accounts AS a
         LEFT JOIN companies AS c ON c.id = a.company_id
         WHERE lower(a.email) = $1
         LIMIT 1`,
        [email],
      );
      return result.rows[0] ?? null;
    });

    const toCheck = account?.password_hash ?? DUMMY_PASSWORD_HASH;
    let passwordMatches = false;
    try {
      passwordMatches = await verifyPassword(toCheck, input.password);
    } catch {
      // Treat invalid/corrupt stored credentials like any other login failure.
      passwordMatches = false;
    }

    if (
      !passwordMatches ||
      !account ||
      account.account_scope !== 'TENANT' ||
      account.status !== 'ACTIVE' ||
      account.company_status !== 'ACTIVE' ||
      account.company_id === null ||
      (account.role !== 'EMPLOYEE' && account.role !== 'COMPANY_ADMIN') ||
      account.password_hash === null
    ) {
      invalidCredentials();
    }

    // Under locks, SessionService checks the *same* verified hash, account,
    // company and role again. A concurrent reset/deactivation cannot bypass it.
    const session = await this.sessions.createForAccount({
      companyId: account.company_id,
      accountId: account.id,
      verifiedPasswordHash: account.password_hash,
    });

    return {
      accountId: account.id,
      companyId: account.company_id,
      email: account.email,
      role: account.role,
      rawToken: session.rawToken,
      csrfToken: session.csrfToken,
      absoluteExpiresAt: session.absoluteExpiresAt,
    };
  }
}
