# NBA Awka member API

Persistent member accounts, admin accounts, bcrypt password hashes, email verification, one-time password reset links, and HTTP-only cookie sessions. The initial admin is configured with `INITIAL_ADMIN_EMAIL`; that owner can invite up to three more admins (four total). One admin approval plus applicant email verification activates a member.

## Deploy

Use Vercel Node.js Functions and managed PostgreSQL through a Marketplace integration (Neon or Supabase are options). Deploy the website and API together from the NBA folder so `/api` and static pages share the same HTTPS origin; this avoids third-party cookie restrictions. Provision a Resend account and verify the sending domain for `MAIL_FROM_ADDRESS`. Never put database, mail API, or JWT secrets in HTML.

1. Import the NBA folder as a Vercel project. Add PostgreSQL from Marketplace and configure `DATABASE_URL` and `DATABASE_SSL=true` as required by its provider. Vercel Marketplace supports Postgres providers such as Neon and Supabase. See [Vercel Marketplace storage](https://vercel.com/docs/marketplace-storage) and [Vercel Node.js Functions](https://vercel.com/docs/functions/runtimes).
2. Set `NODE_ENV=production`, `JWT_SECRET` (unique random secret of 32+ characters), `RESEND_API_KEY`, `MAIL_FROM_NAME`, verified `MAIL_FROM_ADDRESS`, `PUBLIC_SITE_URL`, and the first administrator's email in `INITIAL_ADMIN_EMAIL`.
3. Run the SQL in `backend/schema.sql` once against the production database using the provider's SQL console.
4. Deploy; check `/api/health`. The site and API use the same origin and secure HTTP-only session cookies.
5. Visit `/admin-console.html`, request the initial setup email for `INITIAL_ADMIN_EMAIL`, then use its one-time link to set the owner password. The initial owner can invite up to three more administrators from that page. Invitees receive one-time links to set their passwords. Do this before opening member registration so all admins receive application reviews.
6. New applications email a verification link to the applicant and individual review links to each configured admin. One admin approval plus the applicant's email verification activates the member. Any admin rejection disables a pending application. Review links are single-use and expire.

## Routes

- `POST /api/applications` stores a pending application and sends email verification.
- `POST /api/auth/verify-email` verifies the one-use token.
- `POST /api/admin/decision` records one admin's one-time approval/rejection email link.
- `POST /api/admin/bootstrap/request` and `/api/admin/bootstrap/complete` set up the one configured initial owner.
- `POST /api/admin/invitations` and `/api/admin/invitations/accept` invite the other admins; owner-only, four seats maximum.
- `POST /api/admin/login`, `GET /api/admin/me`, and `POST /api/admin/logout` manage admin access.
- `POST /api/auth/login` accepts email or membership ID for active, verified members.
- `POST /api/auth/forgot-password` sends a reset link without revealing if an account exists.
- `POST /api/auth/reset-password` consumes the one-use link.
- `GET /api/auth/me` and `POST /api/auth/logout` manage the session.
- `GET /api/member-payments` returns the signed-in member's fee schedule and payment history. `POST /api/member-payments` verifies a Paystack transaction against the server-calculated fee and records it to PostgreSQL; the corresponding dues entry is then visible in the admin portal.

Configure `PAYSTACK_PUBLIC_KEY` and `PAYSTACK_SECRET_KEY` in Vercel for the same Paystack mode (both test or both live), then redeploy. The public key is returned to the member page for checkout. The secret key is used only on the server to verify Paystack references. Each online payment must match the member, fee category, currency, and full fee amount before it is recorded. Direct bank transfers remain manually recordable by an admin in the dues ledger.

Legacy browser `localStorage` is not imported: it is device-local and may contain plaintext passwords. Members must register again through the new flow.
