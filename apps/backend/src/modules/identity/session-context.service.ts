import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import type { TenantContext } from '../../auth/authorization/tenant-context.js';
import { assertSessionInTransaction } from '../../auth/session.service.js';
import { WALL_CLOCK, type WallClock } from '../../common/time/wall-clock.js';
import { isCivilDate, isNamedTimeZone } from '../../common/time/civil-time.js';
import { lockAccountsPrefix } from './account-prefix-lock.js';

@Injectable()
export class SessionContextService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(WALL_CLOCK) private readonly clock: WallClock,
  ) {}

  read(tenant: TenantContext) {
    return this.database.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await client.query(
        "SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '15s'",
      );
      await lockAccountsPrefix(client, tenant, ['EMPLOYEE', 'COMPANY_ADMIN']);
      await assertSessionInTransaction(client, tenant);
      const {
        rows: [owner],
      } = await client.query<{
        account_id: string;
        company_id: string;
        email: string;
        role: 'EMPLOYEE' | 'COMPANY_ADMIN';
        time_zone: string;
      }>(
        `SELECT a.id AS account_id, a.company_id, a.email, a.role, c.time_zone
         FROM accounts a JOIN companies c ON c.id = a.company_id
         WHERE a.company_id = $1 AND a.id = $2`,
        [tenant.companyId, tenant.accountId],
      );
      if (!owner || !isNamedTimeZone(owner.time_zone))
        throw new Error('Invalid identity time context');
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: owner.time_zone,
        year: 'numeric',
        month: '2-digit',
      }).formatToParts(this.clock());
      const year = parts
        .find((part) => part.type === 'year')
        ?.value.padStart(4, '0');
      const month = parts.find((part) => part.type === 'month')?.value;
      const currentCompanyMonth = `${year}-${month}-01`;
      if (!isCivilDate(currentCompanyMonth))
        throw new Error('Invalid identity month');
      await assertSessionInTransaction(client, tenant);
      return {
        accountId: owner.account_id,
        companyId: owner.company_id,
        email: owner.email,
        role: owner.role,
        companyTimeZone: owner.time_zone,
        currentCompanyMonth,
      };
    });
  }
}
