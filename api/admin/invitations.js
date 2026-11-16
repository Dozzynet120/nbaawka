import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { pool } from '../../backend/src/db.js';
import { sendAdminInviteEmail } from '../../backend/src/mail.js';
import { currentAdmin } from '../../backend/src/admin-auth.js';

const emailSchema = z.string().trim().email().max(254).transform((value) => value.toLowerCase());
const limiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false });
const hashToken = (value) => crypto.createHash('sha256').update(value).digest('hex');

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  await new Promise((resolve) => {
    const fallback = setTimeout(resolve, 0);
    limiter(req, res, () => { clearTimeout(fallback); resolve(); });
  });
  if (res.headersSent) return;

  const admin = await currentAdmin(req);
  if (!admin) return res.status(401).json({ error: 'Please sign in to the admin portal.' });
  if (admin.role !== 'owner') return res.status(403).json({ error: 'Only the initial admin can invite administrators.' });

  let client;
  let raw;
  try {
    client = await pool.connect();
    const email = emailSchema.parse(req.body?.email);
    await client.query('BEGIN');
    await client.query('LOCK TABLE admins IN EXCLUSIVE MODE');
    const count = await client.query('SELECT count(*)::int AS n FROM admins');
    if (count.rows[0].n >= 4) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'The four administrator seats are filled.' });
    }
    const existing = await client.query('SELECT 1 FROM admins WHERE email=$1', [email]);
    if (existing.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'That email already has admin access.' });
    }
    raw = crypto.randomBytes(32).toString('base64url');
    await client.query("INSERT INTO admin_invites(email,role,token_hash,expires_at) VALUES($1,'admin',$2,now()+interval '7 days') ON CONFLICT(email) DO UPDATE SET role='admin',token_hash=excluded.token_hash,expires_at=excluded.expires_at,consumed_at=NULL", [email, hashToken(raw)]);
    await client.query('COMMIT');
    const siteUrl = (process.env.PUBLIC_SITE_URL || '').replace(/\/$/, '');
    await sendAdminInviteEmail(email, `${siteUrl}/admin-setup.html?type=invite&token=${encodeURIComponent(raw)}`);
    return res.status(202).json({ message: `Invitation email sent to ${email}.` });
  } catch (error) {
    await client?.query('ROLLBACK').catch(() => {});
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message || 'Please check the form.' });
    console.error('Admin invitation failed:', error.code || 'unknown');
    return res.status(500).json({ error: 'The administrator invitation could not be sent. Please try again.' });
  } finally {
    client?.release();
  }
}
