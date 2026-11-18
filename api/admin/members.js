import { z } from 'zod';
import { pool } from '../../backend/src/db.js';
import { currentAdmin } from '../../backend/src/admin-auth.js';

export default async function handler(req, res) {
  if (req.method === 'PATCH') {
    try {
      const admin = await currentAdmin(req);
      if (!admin) return res.status(401).json({ error: 'Please sign in to the admin portal.' });
      const d = z.object({
        memberId: z.coerce.number().int().positive(),
        firstName: z.string().trim().min(1).max(80),
        middleName: z.string().trim().max(80).optional().default(''),
        lastName: z.string().trim().min(1).max(80),
        membershipId: z.string().trim().toUpperCase().regex(/^SCN[0-9]{5,}$/, 'Enter a valid NBA membership number.'),
        phone: z.string().trim().min(7).max(32),
        yearOfCall: z.coerce.number().int().min(1900).max(new Date().getFullYear()),
        lawSchool: z.string().trim().max(120).optional().default(''),
        practiceType: z.string().trim().max(120).optional().default(''),
        firmName: z.string().trim().max(180).optional().default(''),
      }).parse(req.body);
      const { rows } = await pool.query(
        'UPDATE members SET first_name=$1,middle_name=$2,last_name=$3,membership_id=$4,phone=$5,year_of_call=$6,law_school=$7,practice_type=$8,firm_name=$9,updated_at=now() WHERE id=$10 RETURNING id,first_name,middle_name,last_name,email,membership_id,phone,year_of_call,law_school,practice_type,firm_name,status,email_verified_at,created_at',
        [d.firstName,d.middleName,d.lastName,d.membershipId,d.phone,d.yearOfCall,d.lawSchool,d.practiceType,d.firmName,d.memberId],
      );
      if (!rows[0]) return res.status(404).json({ error: 'Member record not found.' });
      return res.status(200).json({ member: rows[0], message: 'Member profile updated.' });
    } catch (error) {
      if (error?.code === '23505') return res.status(409).json({ error: 'That membership number is already assigned to another member.' });
      if (error?.name === 'ZodError') return res.status(400).json({ error: error.issues?.[0]?.message || 'Please check the profile fields.' });
      console.error('Admin member update failed:', error.code || 'unknown');
      return res.status(500).json({ error: 'Member profile could not be updated.' });
    }
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, PATCH');
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
