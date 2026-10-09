import pg from 'pg';
import { ENV } from '../config/env.js';

const { Pool } = pg;
let pool = null;
let isConnected = false;

export function getPool() {
  if (!pool) {
    if (!ENV.DATABASE_URL) {
      if (ENV.NODE_ENV === 'production') {
        throw new Error('DATABASE_URL is required in production.');
      }
      return null;
    }

    pool = new Pool({
      connectionString: ENV.DATABASE_URL,
      ssl: ENV.DATABASE_URL.includes('sslmode=require') || ENV.DATABASE_URL.includes('railway')
        ? { rejectUnauthorized: false }
        : false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      console.error('Unexpected error on idle PostgreSQL client:', err);
    });
  }
  return pool;
}

export async function query(sql, params = []) {
  const p = getPool();
  if (!p) {
    throw new Error('Database pool is not available.');
  }
  return await p.query(sql, params);
}

export async function getClient() {
  const p = getPool();
  if (!p) {
    throw new Error('Database pool is not available.');
  }
  return await p.connect();
}

export async function withTransaction(callback) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function checkDatabaseHealth() {
  try {
    const res = await query('SELECT 1 as healthy, NOW() as current_time');
    isConnected = true;
    return { isConnected: true, time: res.rows[0].current_time };
  } catch (err) {
    isConnected = false;
    return { isConnected: false, error: err.message };
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
    isConnected = false;
  }
}
