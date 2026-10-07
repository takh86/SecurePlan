import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';

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

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
