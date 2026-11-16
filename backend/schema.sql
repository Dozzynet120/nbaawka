CREATE TABLE IF NOT EXISTS members (
 id BIGSERIAL PRIMARY KEY, first_name TEXT NOT NULL, middle_name TEXT, last_name TEXT NOT NULL,
 email TEXT NOT NULL UNIQUE, membership_id TEXT NOT NULL UNIQUE, phone TEXT NOT NULL,
 year_of_call INTEGER NOT NULL, law_school TEXT, practice_type TEXT, firm_name TEXT, password_hash TEXT,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','disabled')),
 email_verified_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auth_tokens (
 id BIGSERIAL PRIMARY KEY, member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 purpose TEXT NOT NULL CHECK(purpose IN ('verify_email','reset_password')), token_hash TEXT NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_tokens_lookup_idx ON auth_tokens(token_hash,purpose,expires_at) WHERE consumed_at IS NULL;
CREATE TABLE IF NOT EXISTS admin_approvals (
 member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 admin_email TEXT NOT NULL,
 decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
 decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(member_id,admin_email)
);
CREATE TABLE IF NOT EXISTS admin_action_tokens (
 id BIGSERIAL PRIMARY KEY, member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 admin_email TEXT NOT NULL, token_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 consumed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(member_id,admin_email)
);
CREATE TABLE IF NOT EXISTS admins (
 id BIGSERIAL PRIMARY KEY,
 email TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('owner','admin')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS admin_invites (
 id BIGSERIAL PRIMARY KEY,
 email TEXT NOT NULL UNIQUE,
 role TEXT NOT NULL CHECK(role IN ('owner','admin')),
 token_hash TEXT NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL,
 consumed_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS member_dues (
 id BIGSERIAL PRIMARY KEY,
 member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 dues_year INTEGER NOT NULL CHECK(dues_year BETWEEN 2000 AND 2200),
 dues_type TEXT NOT NULL DEFAULT 'branch_dues' CHECK(dues_type IN ('branch_dues','bar_centre_levy','practising_fee')),
 amount_ngn NUMERIC(14,2),
 status TEXT NOT NULL DEFAULT 'unpaid' CHECK(status IN ('unpaid','pending','paid','waived')),
 payment_reference TEXT,
 verified_by TEXT,
 paid_at TIMESTAMPTZ,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(member_id,dues_year,dues_type)
);
CREATE TABLE IF NOT EXISTS member_payments (
 id BIGSERIAL PRIMARY KEY,
 member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 dues_year INTEGER NOT NULL CHECK(dues_year BETWEEN 2000 AND 2200),
 dues_type TEXT NOT NULL CHECK(dues_type IN ('branch_dues','bar_centre_levy','practising_fee')),
 amount_ngn NUMERIC(14,2) NOT NULL CHECK(amount_ngn > 0),
 currency TEXT NOT NULL DEFAULT 'NGN' CHECK(currency='NGN'),
 payment_reference TEXT NOT NULL UNIQUE,
 method TEXT NOT NULL DEFAULT 'bank_transfer',
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','success','rejected')),
 transfer_date DATE NOT NULL,
 reviewed_by TEXT,
 reviewed_at TIMESTAMPTZ,
 paid_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS member_payments_member_paid_idx ON member_payments(member_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS member_payments_one_pending_transfer_idx ON member_payments(member_id,dues_year,dues_type) WHERE method='bank_transfer' AND status='pending';
