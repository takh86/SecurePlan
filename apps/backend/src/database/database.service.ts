import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly pool: Pool;

  constructor() {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 3000,
      max: 5,
    });
    this.pool.on('error', () =>
      console.error('Database pool connection failed'),
    );
  }

  async isReady(): Promise<boolean> {
    try {
      const result = await this.pool.query(
        'SELECT id FROM foundation_probe WHERE id = 1',
      );
      return result.rowCount === 1;
    } catch {
      return false;
    }
  }
  async withTransaction<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();

    let transactionStarted = false;
    let destroyClient = false;

    try {
      await client.query('BEGIN');
      transactionStarted = true;

      const result = await work(client);

      await client.query('COMMIT');
      transactionStarted = false;

      return result;
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query('ROLLBACK');
        } catch {
          destroyClient = true;
        }
      } else {
        destroyClient = true;
      }

      throw error;
    } finally {
      client.release(destroyClient);
    }
  }
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
