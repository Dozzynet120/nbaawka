import { pool } from '../../backend/src/db.js';
import { currentAdmin } from '../../backend/src/admin-auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  try {
    const admin = await currentAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Please sign in to the admin portal.' });
    const { rows } = await pool.query('SELECT email,role,created_at FROM admins ORDER BY id');
    return res.status(200).json({ admin, admins: rows, maxAdmins: 4 });
  } catch (error) {
    console.error('Admin session lookup failed:', error.code || 'unknown');
    return res.status(500).json({ error: 'The admin portal could not be loaded. Please try again.' });
  }
}
