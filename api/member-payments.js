import { z } from 'zod';
import { pool } from '../backend/src/db.js';
import { currentMember } from '../backend/src/member-auth.js';
import { dueAmount, duesTypes } from '../backend/src/dues.js';

async function ensurePaymentTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS member_payments (
    id BIGSERIAL PRIMARY KEY,
    member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    dues_year INTEGER NOT NULL CHECK(dues_year BETWEEN 2000 AND 2200),
    dues_type TEXT NOT NULL CHECK(dues_type IN ('branch_dues','bar_centre_levy','practising_fee')),
    amount_ngn NUMERIC(14,2) NOT NULL CHECK(amount_ngn > 0),
    currency TEXT NOT NULL DEFAULT 'NGN' CHECK(currency='NGN'),
    payment_reference TEXT NOT NULL UNIQUE,
    method TEXT NOT NULL DEFAULT 'bank_transfer',
    status TEXT NOT NULL DEFAULT 'pending',
    transfer_date DATE NOT NULL,
    reviewed_by TEXT,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query("ALTER TABLE member_payments ADD COLUMN IF NOT EXISTS transfer_date DATE NOT NULL DEFAULT CURRENT_DATE");
  await pool.query('ALTER TABLE member_payments ADD COLUMN IF NOT EXISTS reviewed_by TEXT');
  await pool.query('ALTER TABLE member_payments ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE member_payments ALTER COLUMN paid_at DROP NOT NULL');
  await pool.query('ALTER TABLE member_payments DROP CONSTRAINT IF EXISTS member_payments_status_check');
  await pool.query("ALTER TABLE member_payments ADD CONSTRAINT member_payments_status_check CHECK(status IN ('pending','success','rejected'))");
  await pool.query("ALTER TABLE member_dues ADD COLUMN IF NOT EXISTS dues_type TEXT NOT NULL DEFAULT 'branch_dues'");
  await pool.query('ALTER TABLE member_dues DROP CONSTRAINT IF EXISTS member_dues_member_id_dues_year_key');
  await pool.query('ALTER TABLE member_dues DROP CONSTRAINT IF EXISTS member_dues_status_check');
  await pool.query("ALTER TABLE member_dues ADD CONSTRAINT member_dues_status_check CHECK(status IN ('unpaid','pending','paid','waived'))");
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS member_dues_member_year_type_idx ON member_dues(member_id,dues_year,dues_type)');
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS member_payments_one_pending_transfer_idx ON member_payments(member_id,dues_year,dues_type) WHERE method='bank_transfer' AND status='pending'");
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  const member = await currentMember(req);
  if (!member) return res.status(401).json({ error: 'Please sign in to view or submit a bank transfer.' });
  try {
    await ensurePaymentTables();
    if (req.method === 'GET') {
      const year = new Date().getFullYear();
      const [dueResult, paymentResult] = await Promise.all([
        pool.query(
          `SELECT t.dues_type,CASE WHEN d.status='paid' THEN d.amount_ngn ELSE NULL END AS paid_amount,d.status,d.payment_reference,d.paid_at,d.verified_by
           FROM (VALUES ('branch_dues'::text),('bar_centre_levy'::text),('practising_fee'::text)) AS t(dues_type)
           LEFT JOIN member_dues d ON d.member_id=$1 AND d.dues_year=$2 AND d.dues_type=t.dues_type
           ORDER BY t.dues_type`, [member.id, year]),
        pool.query('SELECT dues_year,dues_type,amount_ngn,payment_reference,method,status,transfer_date,reviewed_by,paid_at,created_at FROM member_payments WHERE member_id=$1 ORDER BY created_at DESC LIMIT 100', [member.id]),
      ]);
      const dues = dueResult.rows.map(row => ({ ...row, amount_due: dueAmount(row.dues_type, member.year_of_call, year) }));
      return res.status(200).json({ year, dues, payments: paymentResult.rows });
    }

    const parsed = z.object({
      reference: z.string().trim().min(4).max(160),
      duesType: z.enum(duesTypes),
      transferDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Enter the bank transfer reference and date, then try again.' });
    const { reference, duesType, transferDate } = parsed.data;
    const date = new Date(`${transferDate}T00:00:00Z`);
    const today = new Date();
    today.setUTCHours(23, 59, 59, 999);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== transferDate || date > today) return res.status(400).json({ error: 'Enter a valid transfer date that is not in the future.' });

    const year = new Date().getFullYear();
    const amount = dueAmount(duesType, member.year_of_call, year);
    if (!amount) return res.status(400).json({ error: 'Your Year of Call is missing or invalid. Contact the branch before submitting payment.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${member.id}:${year}:${duesType}`]);
      const current = await client.query('SELECT status FROM member_dues WHERE member_id=$1 AND dues_year=$2 AND dues_type=$3 FOR UPDATE', [member.id, year, duesType]);
      if (current.rows[0]?.status === 'paid') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'This fee is already recorded as paid.' });
      }
      if (current.rows[0]?.status === 'pending') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'A transfer for this fee is already awaiting admin review.' });
      }
      await client.query(
        `INSERT INTO member_payments(member_id,dues_year,dues_type,amount_ngn,payment_reference,method,status,transfer_date)
         VALUES($1,$2,$3,$4,$5,'bank_transfer','pending',$6::date)`,
        [member.id, year, duesType, amount, reference, transferDate],
      );
      await client.query(
        `INSERT INTO member_dues(member_id,dues_year,dues_type,amount_ngn,status,payment_reference,verified_by,paid_at,updated_at)
         VALUES($1,$2,$3,$4,'pending',$5,NULL,NULL,now())
         ON CONFLICT(member_id,dues_year,dues_type) DO UPDATE SET amount_ngn=excluded.amount_ngn,status='pending',payment_reference=excluded.payment_reference,verified_by=NULL,paid_at=NULL,updated_at=now()`,
        [member.id, year, duesType, amount, reference],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.code === '23505') return res.status(409).json({ error: 'That transfer reference is already on file, or this fee has already been submitted.' });
      throw error;
    } finally {
      client.release();
    }
    return res.status(201).json({ message: 'Bank transfer submitted. An administrator will confirm it after checking the branch account statement.', reference, duesType, amount, year });
  } catch (error) {
    console.error('Member bank transfer request failed:', error.code || error.name || 'unknown');
    return res.status(500).json({ error: 'The transfer submission could not be saved. Please try again or contact the branch.' });
  }
}
