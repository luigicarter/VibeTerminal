import { Pool, type PoolClient } from 'pg';
import type { Config } from '../config';
import { log } from '../monitoring/log';
export function createPool(
  config: Pick<Config, 'DATABASE_URL' | 'DB_POOL_MAX'>,
) {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30000,
    statement_timeout: 5000,
    query_timeout: 6000,
    application_name: 'lina-account-server',
  });
  pool.on('error', () => log('error', 'database_connection_error'));
  return pool;
}
export async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
