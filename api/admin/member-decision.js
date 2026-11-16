import { z } from 'zod';
import { pool } from '../../backend/src/db.js';
import { currentAdmin } from '../../backend/src/admin-auth.js';

const bodySchema = z.object({ memberId: z.coerce.number().int().positive(), decision: z.enum(['approved', 'rejected']) });

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  const admin = await currentAdmin(req);
  if (!admin) return res.status(401).json({ error: 'Please sign in to the admin portal.' });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Choose an application and a valid decision.' });
  const { memberId, decision } = parsed.data;
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const found = await client.query('SELECT id,status,email_verified_at FROM members WHERE id=$1 FOR UPDATE', [memberId]);
    if (!found.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That member application was not found.' });
    }
    if (found.rows[0].status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This application is no longer pending.' });
    }
    await client.query(
      `INSERT INTO admin_approvals(member_id,admin_email,decision)
       VALUES($1,$2,$3)
       ON CONFLICT(member_id,admin_email) DO UPDATE SET decision=excluded.decision,decided_at=now()`,
      [memberId, admin.email, decision],
    );
    if (decision === 'rejected') {
      await client.query("UPDATE members SET status='disabled',updated_at=now() WHERE id=$1", [memberId]);
    } else if (found.rows[0].email_verified_at) {
      await client.query("UPDATE members SET status='active',updated_at=now() WHERE id=$1", [memberId]);
    }
    const { rows } = await client.query('SELECT status,email_verified_at FROM members WHERE id=$1', [memberId]);
    await client.query('COMMIT');
    return res.status(200).json({ message: decision === 'rejected' ? 'Application rejected.' : rows[0].status === 'active' ? 'Application approved and member activated.' : 'Application approved; the member must verify their email before activation.', member: rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Admin member decision failed:', error.code || 'unknown');
    return res.status(500).json({ error: 'The application decision could not be saved.' });
  } finally {
    client.release();
  }
}
