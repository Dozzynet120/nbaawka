import { z } from 'zod';
import { pool } from '../../backend/src/db.js';
import { currentAdmin } from '../../backend/src/admin-auth.js';
import { dueAmount } from '../../backend/src/dues.js';

const duesSchema = z.object({
  memberId: z.coerce.number().int().positive(),
  year: z.coerce.number().int().min(2000).max(2200),
  duesType: z.enum(['branch_dues', 'bar_centre_levy', 'practising_fee']),
  status: z.enum(['unpaid', 'paid', 'waived']),
  amount: z.union([z.coerce.number().finite().nonnegative(), z.literal(''), z.null()]).optional(),
  reference: z.string().trim().max(160).optional().default(''),
});

async function ensureDuesTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS member_dues (
    id BIGSERIAL PRIMARY KEY,
    member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    dues_year INTEGER NOT NULL CHECK(dues_year BETWEEN 2000 AND 2200),
    amount_ngn NUMERIC(14,2),
    status TEXT NOT NULL DEFAULT 'unpaid' CHECK(status IN ('unpaid','paid','waived')),
    payment_reference TEXT,
    verified_by TEXT,
    paid_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    dues_type TEXT NOT NULL DEFAULT 'branch_dues' CHECK(dues_type IN ('branch_dues','bar_centre_levy','practising_fee'))
  )`);
  await pool.query("ALTER TABLE member_dues ADD COLUMN IF NOT EXISTS dues_type TEXT NOT NULL DEFAULT 'branch_dues' CHECK(dues_type IN ('branch_dues','bar_centre_levy','practising_fee'))");
  await pool.query('ALTER TABLE member_dues DROP CONSTRAINT IF EXISTS member_dues_member_id_dues_year_key');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS member_dues_member_year_type_idx ON member_dues(member_id,dues_year,dues_type)');
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  const admin = await currentAdmin(req);
  if (!admin) return res.status(401).json({ error: 'Please sign in to the admin portal.' });
  try {
    await ensureDuesTable();
    if (req.method === 'GET') {
      const parsedYear = Number(req.query?.year);
      const year = Number.isInteger(parsedYear) && parsedYear >= 2000 && parsedYear <= 2200 ? parsedYear : new Date().getFullYear();
      const { rows } = await pool.query(
        `SELECT m.id AS member_id,m.first_name,m.middle_name,m.last_name,m.email,m.membership_id,m.year_of_call,
                t.dues_type,d.id AS dues_id,d.dues_year,d.amount_ngn,d.status,d.payment_reference,d.verified_by,d.paid_at,d.updated_at
         FROM members m
         CROSS JOIN (VALUES ('branch_dues'::text),('bar_centre_levy'::text),('practising_fee'::text)) AS t(dues_type)
         LEFT JOIN member_dues d ON d.member_id=m.id AND d.dues_year=$1 AND d.dues_type=t.dues_type
         WHERE m.status='active'
         ORDER BY m.last_name,m.first_name`,
        [year],
      );
      return res.status(200).json({ year, dues: rows.map(row => ({ ...row, amount_due_ngn: dueAmount(row.dues_type, row.year_of_call, year) })) });
    }
    const parsed = duesSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Check the dues details.' });
    const { memberId, year, duesType, status, reference } = parsed.data;
    const amount = parsed.data.amount === '' || parsed.data.amount == null ? null : parsed.data.amount;
    if (status === 'paid' && (!Number.isFinite(amount) || amount <= 0)) return res.status(400).json({ error: 'Enter the amount received before marking dues paid.' });
    const member = await pool.query("SELECT id FROM members WHERE id=$1 AND status='active'", [memberId]);
    if (!member.rows[0]) return res.status(404).json({ error: 'Active member was not found.' });
    const { rows } = await pool.query(
      `INSERT INTO member_dues(member_id,dues_year,dues_type,amount_ngn,status,payment_reference,verified_by,paid_at,updated_at)
       VALUES($1,$2,$3,$4,$5,NULLIF($6,''),CASE WHEN $5='paid' THEN $7 ELSE NULL END,CASE WHEN $5='paid' THEN now() ELSE NULL END,now())
       ON CONFLICT(member_id,dues_year,dues_type) DO UPDATE SET amount_ngn=excluded.amount_ngn,status=excluded.status,
         payment_reference=excluded.payment_reference,verified_by=excluded.verified_by,paid_at=excluded.paid_at,updated_at=now()
       RETURNING member_id,dues_year,dues_type,amount_ngn,status,payment_reference,verified_by,paid_at,updated_at`,
      [memberId, year, duesType, amount, status, reference, admin.email],
    );
    return res.status(200).json({ dues: rows[0], message: status === 'paid' ? 'Payment recorded as verified.' : status === 'waived' ? 'Dues marked as waived.' : 'Dues marked unpaid.' });
  } catch (error) {
    console.error('Admin dues request failed:', error.code || 'unknown');
    return res.status(500).json({ error: 'Dues records could not be processed.' });
  }
}
