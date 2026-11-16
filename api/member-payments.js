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
    method TEXT NOT NULL DEFAULT 'Paystack',
    status TEXT NOT NULL DEFAULT 'success' CHECK(status='success'),
    paid_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query("ALTER TABLE member_dues ADD COLUMN IF NOT EXISTS dues_type TEXT NOT NULL DEFAULT 'branch_dues'");
  await pool.query('ALTER TABLE member_dues DROP CONSTRAINT IF EXISTS member_dues_member_id_dues_year_key');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS member_dues_member_year_type_idx ON member_dues(member_id,dues_year,dues_type)');
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  const member = await currentMember(req);
  if (!member) return res.status(401).json({ error: 'Please sign in to view or record payments.' });
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
        pool.query('SELECT dues_year,dues_type,amount_ngn,payment_reference,method,status,paid_at FROM member_payments WHERE member_id=$1 ORDER BY paid_at DESC LIMIT 100', [member.id]),
      ]);
      const dues = duesResult.rows.map(row => ({ ...row, amount_due: dueAmount(row.dues_type, member.year_of_call, year) }));
      const publicKey = /^pk_(test|live)_/.test(process.env.PAYSTACK_PUBLIC_KEY || '') ? process.env.PAYSTACK_PUBLIC_KEY : '';
      return res.status(200).json({ year, dues, payments: paymentResult.rows, publicKey });
    }

    if (!process.env.PAYSTACK_SECRET_KEY) return res.status(503).json({ error: 'Online payment verification is not configured yet. Please contact the branch.' });
    const parsed = z.object({ reference: z.string().trim().min(8).max(160), duesType: z.enum(duesTypes) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Payment reference or fee type is invalid.' });
    const { reference, duesType } = parsed.data;
    const year = new Date().getFullYear();
    const expectedAmount = dueAmount(duesType, member.year_of_call, year);
    if (!expectedAmount) return res.status(400).json({ error: 'Your Year of Call is missing or invalid. Update your member profile before paying.' });

    const verifiedResponse = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    const verified = await verifiedResponse.json().catch(() => null);
    if (!verifiedResponse.ok || !verified?.status || verified?.data?.status !== 'success') return res.status(400).json({ error: 'Paystack has not confirmed a successful payment for this reference.' });
    const transaction = verified.data;
    const email = String(transaction.customer?.email || '').toLowerCase();
    const membershipId = transaction.metadata?.membership_id;
    const transactionType = transaction.metadata?.payment_type;
    if (transaction.currency !== 'NGN' || Number(transaction.amount) !== expectedAmount * 100 || (email !== member.email.toLowerCase() && membershipId !== member.membership_id) || transactionType !== duesType) {
      return res.status(400).json({ error: 'The verified payment does not match this member, fee type, or amount.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [reference]);
      const existing = await client.query('SELECT member_id,dues_year,dues_type,amount_ngn FROM member_payments WHERE payment_reference=$1 FOR UPDATE', [reference]);
      if (existing.rows[0]) {
        const saved = existing.rows[0];
        if (String(saved.member_id) !== String(member.id) || Number(saved.dues_year) !== year || saved.dues_type !== duesType || Number(saved.amount_ngn) !== expectedAmount) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'This payment reference has already been recorded against another payment.' });
        }
      } else {
        await client.query(
          `INSERT INTO member_payments(member_id,dues_year,dues_type,amount_ngn,payment_reference,paid_at)
           VALUES($1,$2,$3,$4,$5,COALESCE($6::timestamptz,now()))`,
          [member.id, year, duesType, expectedAmount, reference, transaction.paid_at || null],
        );
      }
      await client.query(
        `INSERT INTO member_dues(member_id,dues_year,dues_type,amount_ngn,status,payment_reference,verified_by,paid_at,updated_at)
         VALUES($1,$2,$3,$4,'paid',$5,'Paystack',COALESCE($6::timestamptz,now()),now())
         ON CONFLICT(member_id,dues_year,dues_type) DO UPDATE SET amount_ngn=excluded.amount_ngn,status='paid',payment_reference=excluded.payment_reference,verified_by='Paystack',paid_at=excluded.paid_at,updated_at=now()`,
        [member.id, year, duesType, expectedAmount, reference, transaction.paid_at || null],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return res.status(200).json({ message: 'Payment verified and recorded.', reference, duesType, amount: expectedAmount, year, paidAt: transaction.paid_at });
  } catch (error) {
    console.error('Member payment request failed:', error.code || error.name || 'unknown');
    return res.status(error.name === 'TimeoutError' ? 504 : 500).json({ error: 'Payment records could not be processed. If Paystack charged you, contact the branch with your payment reference.' });
  }
}
