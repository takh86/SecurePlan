import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DatabaseService } from '../src/database/database.service.js';

describe('DatabaseService — Transactions', () => {
  let database: DatabaseService;

  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      process.loadEnvFile('../../.env');
    }

    database = new DatabaseService();
  });

  afterAll(async () => {
    await database.onApplicationShutdown();
  });

  it('commits a successful transaction', async () => {
    const result = await database.withTransaction(async (client) => {
      const response = await client.query('SELECT 1 AS value');
      return response.rows[0].value as number;
    });

    expect(result).toBe(1);
  });

  it('rolls back changes when an operation fails', async () => {
    const companyId = randomUUID();

    await expect(
      database.withTransaction(async (client) => {
        await client.query(
          `INSERT INTO companies (id, name, status, time_zone)
           VALUES ($1, $2, $3, $4)`,
          [companyId, 'Rollback Test', 'ACTIVE', 'Europe/Berlin'],
        );

        throw new Error('Simulated transaction failure');
      }),
    ).rejects.toThrow('Simulated transaction failure');

    const result = await database.withTransaction((client) =>
      client.query('SELECT id FROM companies WHERE id = $1', [companyId]),
    );

    expect(result.rowCount).toBe(0);
  });
});