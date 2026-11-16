import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { pool } from '../../../backend/src/db.js';
import { sendAdminSetupEmail } from '../../../backend/src/mail.js';

const emailSchema = z.string().trim().email().max(254).transform((value) => value.toLowerCase());
const limiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false });
const hashToken = (value) => crypto.createHash('sha256').update(value).digest('hex');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  await new Promise((resolve) => {
    const fallback = setTimeout(resolve, 0);
    limiter(req, res, () => {
      clearTimeout(fallback);
      resolve();
    });
  });
  if (res.headersSent) return;

  try {
    const email = emailSchema.parse(req.body?.email);
    if (email === (process.env.INITIAL_ADMIN_EMAIL || '').trim().toLowerCase()) {
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM admins');
      if (rows[0].n === 0) {
        const raw = crypto.randomBytes(32).toString('base64url');
        await pool.query("INSERT INTO admin_invites(email,role,token_hash,expires_at) VALUES($1,'owner',$2,now()+interval '30 minutes') ON CONFLICT(email) DO UPDATE SET role='owner',token_hash=excluded.token_hash,expires_at=excluded.expires_at,consumed_at=NULL", [email, hashToken(raw)]);
        const siteUrl = (process.env.PUBLIC_SITE_URL || '').replace(/\/$/, '');
        await sendAdminSetupEmail(email, `${siteUrl}/admin-setup.html?type=bootstrap&token=${encodeURIComponent(raw)}`);
      }
    }
    res.json({ message: 'If initial admin setup is available for that address, a setup link will arrive by email.' });
  } catch (error) {
    console.error('Admin bootstrap request failed:', error.code || 'unknown', error.message);
    res.status(500).json({ error: 'The setup email could not be requested. Please try again later.' });
  }
}
