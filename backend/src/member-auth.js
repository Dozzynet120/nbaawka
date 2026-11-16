import jwt from 'jsonwebtoken';
import { pool } from './db.js';

export async function currentMember(req) {
  try {
    const cookies = (req.headers.cookie || '').split(';');
    const session = cookies.map(part => part.trim()).find(part => part.startsWith('nba_session='));
    const token = session?.slice('nba_session='.length) || '';
    const claims = jwt.verify(token, process.env.JWT_SECRET, {
      issuer: 'nba-awka-member-api',
      audience: 'nba-awka-site',
    });
    const { rows } = await pool.query("SELECT * FROM members WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL", [claims.sub]);
    return rows[0] || null;
  } catch {
    return null;
  }
}
