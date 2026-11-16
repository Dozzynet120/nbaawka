import jwt from 'jsonwebtoken';
import { pool } from './db.js';

export async function currentAdmin(req) {
  try {
    const cookies = (req.headers.cookie || '').split(';');
    const session = cookies.map((part) => part.trim()).find((part) => part.startsWith('nba_admin_session='));
    const token = session?.slice('nba_admin_session='.length) || '';
    const claims = jwt.verify(token, process.env.JWT_SECRET, {
      issuer: 'nba-awka-admin-api',
      audience: 'nba-awka-admin',
    });
    const { rows } = await pool.query('SELECT id,email,role FROM admins WHERE id=$1', [claims.sub]);
    return rows[0] || null;
  } catch {
    return null;
  }
}
