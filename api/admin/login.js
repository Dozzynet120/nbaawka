import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { pool } from '../../backend/src/db.js';

const emailSchema = z.string().trim().email().max(254).transform((value) => value.toLowerCase());
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  await new Promise((resolve) => {
    const fallback = setTimeout(resolve, 0);
    limiter(req, res, () => {
      clearTimeout(fallback);
      resolve();
    });
  });
  if (res.headersSent) return;

  try {
    const { email, password } = z.object({
      email: emailSchema,
      password: z.string().min(1).max(128),
    }).parse(req.body);
    const { rows } = await pool.query(
      'SELECT id,email,role,password_hash FROM admins WHERE email=$1',
      [email],
    );
    if (!rows[0] || !await bcrypt.compare(password, rows[0].password_hash)) {
      return res.status(401).json({ error: 'Email or password not accepted.' });
    }

    const token = jwt.sign(
      { sub: String(rows[0].id), role: rows[0].role },
      process.env.JWT_SECRET,
      { expiresIn: '12h', issuer: 'nba-awka-admin-api', audience: 'nba-awka-admin' },
    );
    res.setHeader('Set-Cookie', `nba_admin_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`);
    return res.status(200).json({
      admin: { id: rows[0].id, email: rows[0].email, role: rows[0].role },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.issues[0]?.message || 'Please check the form.' });
    }
    console.error('Admin login failed:', error.code || 'unknown');
    return res.status(500).json({ error: 'Sign-in could not be completed. Please try again later.' });
  }
}
