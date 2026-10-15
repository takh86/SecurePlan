import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PasswordPolicyService } from './password-policy.service.js';
import { DatabaseService } from '../database/database.service.js';
import { ActivateAccountDto } from './dto/activate-account.dto.js';
import { hashAccountToken } from './account-token.js';
import { hashPassword } from './password-hasher.js';

@Injectable()
export class AuthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly passwordPolicy: PasswordPolicyService,
  ) {}

  async activate(dto: ActivateAccountDto): Promise<void> {
    const invalidToken = (): never => {
      throw new BadRequestException({
        code: 'ACTIVATION_TOKEN_INVALID_OR_EXPIRED',
      });
    };

    const tokenHash = hashAccountToken(dto.token);

    if (!tokenHash) {
      invalidToken();
    }

    // Preflight: no row locks while Argon2id is running.
    // All security checks are repeated inside the final transaction.
    const owner = await this.database.withTransaction(
      async (client) => {
        const result = await client.query<{
          company_id: string;
          account_id: string;
        }>(
          `
          SELECT t.company_id, t.account_id
          FROM account_tokens AS t
          JOIN accounts AS a
            ON a.id = t.account_id
           AND a.company_id = t.company_id
          WHERE t.token_hash = $1
            AND t.purpose = 'EMAIL_VERIFICATION'
            AND t.used_at IS NULL
            AND t.revoked_at IS NULL
            AND t.expires_at > clock_timestamp()
            AND a.account_scope = 'TENANT'
            AND a.status = 'PENDING_ACTIVATION'
            AND a.password_hash IS NULL
          `,
          [tokenHash],
        );

        return result.rows[0];
      },
    );

    if (!owner) {
      invalidToken();
    }
    await this.passwordPolicy.assertAllowed(dto.password);
    // CPU-intensive hashing happens outside row locks.
    const passwordHash = await hashPassword(dto.password);

    await this.database.withTransaction(async (client) => {
      // Lock order: Account first, then Token.
      const account = await client.query(
        `
        SELECT id
        FROM accounts
        WHERE id = $1
          AND company_id = $2
          AND account_scope = 'TENANT'
          AND status = 'PENDING_ACTIVATION'
          AND password_hash IS NULL
        FOR UPDATE
        `,
        [owner.account_id, owner.company_id],
      );

      if (account.rowCount !== 1) {
        invalidToken();
      }

      const token = await client.query<{ id: string }>(
        `
        SELECT id
        FROM account_tokens
        WHERE token_hash = $1
          AND company_id = $2
          AND account_id = $3
        FOR UPDATE
        `,
        [tokenHash, owner.company_id, owner.account_id],
      );

      if (token.rowCount !== 1) {
        invalidToken();
      }

      // Single-use protection, including expiry revalidation.
      const consumed = await client.query(
        `
        UPDATE account_tokens
        SET used_at = clock_timestamp()
        WHERE id = $1
          AND purpose = 'EMAIL_VERIFICATION'
          AND used_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > clock_timestamp()
        RETURNING id
        `,
        [token.rows[0].id],
      );

      if (consumed.rowCount !== 1) {
        invalidToken();
      }

      const activated = await client.query(
        `
        UPDATE accounts
        SET password_hash = $1,
            email_verified_at = clock_timestamp(),
            status = 'ACTIVE',
            updated_at = clock_timestamp()
        WHERE id = $2
          AND company_id = $3
          AND status = 'PENDING_ACTIVATION'
          AND password_hash IS NULL
        RETURNING id
        `,
        [passwordHash, owner.account_id, owner.company_id],
      );

      if (activated.rowCount !== 1) {
        invalidToken();
      }

      // Only non-sensitive state changes are recorded.
      await client.query(
        `
        INSERT INTO audit_event (
          company_id,
          actor_account_id,
          action,
          resource_type,
          resource_id,
          old_values,
          new_values,
          correlation_id
        )
        VALUES (
          $1, $2,
          'ACCOUNT_ACTIVATED',
          'ACCOUNT',
          $2,
          $3::jsonb,
          $4::jsonb,
          $5
        )
        `,
        [
          owner.company_id,
          owner.account_id,
          JSON.stringify({ status: 'PENDING_ACTIVATION' }),
          JSON.stringify({ status: 'ACTIVE' }),
          randomUUID(),
        ],
      );
    });
  }
}