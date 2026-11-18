import { z } from 'zod';
import { pool } from '../../backend/src/db.js';
import { currentAdmin } from '../../backend/src/admin-auth.js';
import { dueAmount } from '../../backend/src/dues.js';

import { sendMemberAnnouncement } from '../../backend/src/mail.js';

export const config = { api: { bodyParser: { sizeLimit: '3mb' } } };

async function ensureAnnouncementTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS admin_announcements (
    id BIGSERIAL PRIMARY KEY, subject TEXT NOT NULL, meeting_title TEXT NOT NULL, meeting_at TEXT NOT NULL DEFAULT '',
    venue TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, attachment_filename TEXT NOT NULL, attachment_type TEXT NOT NULL,
    attachment_content TEXT NOT NULL, created_by BIGINT REFERENCES admins(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status TEXT NOT NULL DEFAULT 'queued'
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS admin_announcement_recipients (
    id BIGSERIAL PRIMARY KEY, campaign_id BIGINT NOT NULL REFERENCES admin_announcements(id) ON DELETE CASCADE,
    member_id BIGINT REFERENCES members(id) ON DELETE SET NULL, email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','sent','failed')),
    error TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), sent_at TIMESTAMPTZ,
    UNIQUE(campaign_id,email)
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS admin_announcement_recipients_queue_idx ON admin_announcement_recipients(campaign_id,status,id)');
}

const announcementInput = z.object({
  subject: z.string().trim().min(3).max(180),
  meetingTitle: z.string().trim().min(3).max(180),
  meetingAt: z.string().trim().max(120).optional().default(''),
  venue: z.string().trim().max(180).optional().default(''),
  body: z.string().trim().min(10).max(10000),
  attachmentName: z.string().trim().min(1).max(180),
  attachmentType: z.enum(['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/msword']),
  attachmentContent: z.string().min(1).max(2100000),
});

function formatCounts(rows) {
  const counts = { queued: 0, sending: 0, sent: 0, failed: 0 };
  for (const row of rows) counts[row.status] = Number(row.count);
  return counts;
}

async function getAnnouncements(res) {
  const { rows } = await pool.query(`SELECT a.id,a.subject,a.meeting_title,a.meeting_at,a.venue,a.created_at,a.status,
    COALESCE(r.queued,0)::int queued,COALESCE(r.sending,0)::int sending,COALESCE(r.sent,0)::int sent,COALESCE(r.failed,0)::int failed
    FROM admin_announcements a LEFT JOIN (
      SELECT campaign_id,count(*) FILTER(WHERE status='queued') queued,count(*) FILTER(WHERE status='sending') sending,
      count(*) FILTER(WHERE status='sent') sent,count(*) FILTER(WHERE status='failed') failed
      FROM admin_announcement_recipients GROUP BY campaign_id
    ) r ON r.campaign_id=a.id ORDER BY a.created_at DESC LIMIT 30`);
  return res.status(200).json({ announcements: rows });
}

async function createAnnouncement(req, res) {
  const parsed = announcementInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Check the meeting notice details.' });
  const d = parsed.data;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(d.attachmentContent)) return res.status(400).json({ error: 'The minutes attachment could not be read.' });
  const bytes = Buffer.from(d.attachmentContent, 'base64');
  if (!bytes.length || bytes.length > 1572864) return res.status(400).json({ error: 'Attach a PDF or Word minutes file no larger than 1.5 MB.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const recipients = await client.query("SELECT id FROM members WHERE status='active' AND email_verified_at IS NOT NULL");
    if (!recipients.rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'There are no active, email-verified members to receive this notice.' }); }
    const filename = d.attachmentName.replace(/[^A-Za-z0-9._ -]/g, '_').slice(-120);
    const inserted = await client.query('INSERT INTO admin_announcements(subject,meeting_title,meeting_at,venue,body,attachment_filename,attachment_type,attachment_content,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [d.subject,d.meetingTitle,d.meetingAt,d.venue,d.body,filename,d.attachmentType,bytes.toString('base64'),req.admin.id]);
    const id = inserted.rows[0].id;
    await client.query("INSERT INTO admin_announcement_recipients(campaign_id,member_id,email) SELECT $1,id,email FROM members WHERE status='active' AND email_verified_at IS NOT NULL ON CONFLICT(campaign_id,email) DO NOTHING", [id]);
    await client.query('COMMIT');
    return res.status(201).json({ id, queued: recipients.rows.length, message: 'Meeting notice queued for ' + recipients.rows.length + ' active, verified members.' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function processAnnouncement(req, res) {
  const id = Number(req.query?.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'A valid meeting notice ID is required.' });
  const client = await pool.connect();
  let campaign, claimed = [];
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT * FROM admin_announcements WHERE id=$1 FOR UPDATE', [id]);
    if (!found.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Meeting notice not found.' }); }
    campaign = found.rows[0];
    if (req.body?.retryFailed === true) await client.query("UPDATE admin_announcement_recipients SET status='queued',error='',updated_at=now() WHERE campaign_id=$1 AND status='failed'", [id]);
    await client.query("UPDATE admin_announcement_recipients SET status='queued',updated_at=now() WHERE campaign_id=$1 AND status='sending' AND updated_at<now()-interval '10 minutes'", [id]);
    const batch = await client.query("SELECT id,email FROM admin_announcement_recipients WHERE campaign_id=$1 AND status='queued' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 3", [id]);
    claimed = batch.rows;
    for (const recipient of claimed) await client.query("UPDATE admin_announcement_recipients SET status='sending',updated_at=now() WHERE id=$1", [recipient.id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }

  for (const recipient of claimed) {
    try {
      await sendMemberAnnouncement(recipient.email, campaign);
      await pool.query("UPDATE admin_announcement_recipients SET status='sent',error='',sent_at=now(),updated_at=now() WHERE id=$1", [recipient.id]);
    } catch (error) {
      console.error('Member notice delivery failed:', error.message);
      await pool.query("UPDATE admin_announcement_recipients SET status='failed',error=$2,updated_at=now() WHERE id=$1", [recipient.id, String(error.message || 'Mail delivery failed').slice(0,240)]);
    }
  }
  const { rows } = await pool.query("SELECT status,count(*)::int count FROM admin_announcement_recipients WHERE campaign_id=$1 GROUP BY status", [id]);
  const counts = formatCounts(rows);
  const done = counts.queued === 0 && counts.sending === 0;
  await pool.query('UPDATE admin_announcements SET status=$2 WHERE id=$1', [id, done ? (counts.failed ? 'completed_with_errors' : 'sent') : 'sending']);
  return res.status(200).json({ id, counts, done });
}

const duesSchema = z.object({
  memberId: z.coerce.number().int().positive(),
  year: z.coerce.number().int().min(2000).max(2200),
  duesType: z.enum(['branch_dues', 'bar_centre_levy', 'practising_fee']),
  status: z.enum(['unpaid', 'pending', 'paid', 'waived']),
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
  await pool.query('ALTER TABLE member_dues DROP CONSTRAINT IF EXISTS member_dues_status_check');
  await pool.query("ALTER TABLE member_dues ADD CONSTRAINT member_dues_status_check CHECK(status IN ('unpaid','pending','paid','waived'))");
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
    if (req.query?.resource === 'announcements') {
      await ensureAnnouncementTables();
      if (req.method === 'GET') return await getAnnouncements(res);
      if (req.query?.action === 'process') return await processAnnouncement(req, res);
      return await createAnnouncement(req, res);
    }
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
    const client = await pool.connect();
    let rows;
    try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO member_dues(member_id,dues_year,dues_type,amount_ngn,status,payment_reference,verified_by,paid_at,updated_at)
       VALUES($1,$2,$3,$4,$5,NULLIF($6,''),CASE WHEN $5='paid' THEN $7 ELSE NULL END,CASE WHEN $5='paid' THEN now() ELSE NULL END,now())
       ON CONFLICT(member_id,dues_year,dues_type) DO UPDATE SET amount_ngn=excluded.amount_ngn,status=excluded.status,
         payment_reference=excluded.payment_reference,verified_by=excluded.verified_by,paid_at=excluded.paid_at,updated_at=now()
       RETURNING member_id,dues_year,dues_type,amount_ngn,status,payment_reference,verified_by,paid_at,updated_at`,
      [memberId, year, duesType, amount, status, reference, admin.email],
    );
    rows = result.rows;
    const paymentTable = await client.query("SELECT to_regclass('public.member_payments') AS table_name");
    if (paymentTable.rows[0].table_name && status === 'paid') {
      await client.query("UPDATE member_payments SET status='success',reviewed_by=$1,reviewed_at=now(),paid_at=COALESCE(paid_at,now()) WHERE member_id=$2 AND dues_year=$3 AND dues_type=$4 AND payment_reference=NULLIF($5,'') AND status='pending'", [admin.email, memberId, year, duesType, reference]);
    } else if (paymentTable.rows[0].table_name && status === 'unpaid' && reference) {
      await client.query("UPDATE member_payments SET status='rejected',reviewed_by=$1,reviewed_at=now() WHERE member_id=$2 AND dues_year=$3 AND dues_type=$4 AND payment_reference=$5 AND status='pending'", [admin.email, memberId, year, duesType, reference]);
    }
    await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return res.status(200).json({ dues: rows[0], message: status === 'paid' ? 'Payment recorded as verified.' : status === 'waived' ? 'Dues marked as waived.' : status === 'pending' ? 'Transfer marked as awaiting confirmation.' : 'Dues marked unpaid.' });
  } catch (error) {
    console.error('Admin dues request failed:', error.code || 'unknown');
    return res.status(500).json({ error: 'Dues records could not be processed.' });
  }
}
