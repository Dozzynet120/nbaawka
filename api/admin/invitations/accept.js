import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { pool } from '../../../backend/src/db.js';

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });
const hashToken = (value) => crypto.createHash('sha256').update(value).digest('hex');
const passwordSchema = z.string().min(10).max(128).regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/).regex(/[^A-Za-z0-9]/);

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

  let client;
  try {
    const { token, password } = z.object({ token: z.string().min(40).max(100), password: passwordSchema }).parse(req.body);
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('LOCK TABLE admins IN EXCLUSIVE MODE');
    const { rows } = await client.query("SELECT id,email,role FROM admin_invites WHERE token_hash=$1 AND role='admin' AND consumed_at IS NULL AND expires_at>now() FOR UPDATE", [hashToken(token)]);
    const count = await client.query('SELECT count(*)::int AS n FROM admins');
    if (!rows[0] || count.rows[0].n >= 4) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This invitation is invalid, expired, or the admin limit has been reached.' });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    await client.query("INSERT INTO admins(email,password_hash,role) VALUES($1,$2,'admin')", [rows[0].email, passwordHash]);
    await client.query('UPDATE admin_invites SET consumed_at=now() WHERE id=$1', [rows[0].id]);
    await client.query('COMMIT');
    return res.status(200).json({ message: 'Admin account created. You can now sign in to review applications.' });
  } catch (error) {
    await client?.query('ROLLBACK').catch(() => {});
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message || 'Please check the form.' });
    console.error('Admin invitation acceptance failed:', error.code || 'unknown');
    return res.status(500).json({ error: 'The administrator account could not be created. Please try again.' });
  } finally {
    client?.release();
  }
}
