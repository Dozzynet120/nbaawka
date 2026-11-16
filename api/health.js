import { pool } from '../backend/src/db.js';

export default async function handler(_req, res) {
  let timeout;
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(Object.assign(new Error('Database health check timed out'), { code: 'DB_CHECK_TIMEOUT' })), 5000);
      })
    ]);
    res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('Health check failed:', error.code || 'unknown', error.message);
    res.status(503).json({ status: 'unavailable' });
  } finally {
    clearTimeout(timeout);
  }
}
