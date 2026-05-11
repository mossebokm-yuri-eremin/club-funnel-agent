import pg from 'pg';
import { config } from '../config.js';
import { log } from '../observability/logger.js';

const { Pool } = pg;
export type { PoolClient, QueryResult, QueryResultRow } from 'pg';

export const pool = new Pool({
  host: config.PG_HOST,
  port: config.PG_PORT,
  database: config.PG_DATABASE,
  user: config.PG_USER,
  password: config.PG_PASSWORD,
  ssl: config.PG_SSL ? { rejectUnauthorized: false } : false,
  max: config.PG_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: config.APP_NAME,
});

pool.on('error', (err) => {
  log.error({ err }, 'pg pool: unexpected idle client error');
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: ReadonlyArray<unknown>,
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  const res = await pool.query<T>(text, params as unknown[]);
  const ms = Date.now() - start;
  if (ms > 250) {
    log.warn({ ms, rowCount: res.rowCount }, 'pg slow query');
  }
  return res;
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
