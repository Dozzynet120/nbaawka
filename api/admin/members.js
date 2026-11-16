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
    const status = ['pending', 'active', 'disabled', 'all'].includes(req.query?.status) ? req.query.status : 'all';
    const { rows } = await pool.query(
      `SELECT m.id,m.first_name,m.middle_name,m.last_name,m.email,m.membership_id,m.phone,
              m.year_of_call,m.law_school,m.practice_type,m.firm_name,m.status,
              m.email_verified_at,m.created_at,
              COALESCE(a.approvals,0)::int AS approvals,
              COALESCE(a.last_decision,'') AS last_decision
       FROM members m
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE decision='approved') AS approvals,
                (array_agg(decision ORDER BY decided_at DESC))[1] AS last_decision
         FROM admin_approvals WHERE member_id=m.id
       ) a ON true
       WHERE ($1='all' OR m.status=$1)
       ORDER BY CASE WHEN m.status='pending' THEN 0 ELSE 1 END, m.created_at DESC
       LIMIT 500`,
      [status],
    );
    return res.status(200).json({ members: rows });
  } catch (error) {
    console.error('Admin member list failed:', error.code || 'unknown');
    return res.status(500).json({ error: 'Member records could not be loaded.' });
  }
}
