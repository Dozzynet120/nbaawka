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
 amount_ngn NUMERIC(14,2),
 status TEXT NOT NULL DEFAULT 'unpaid' CHECK(status IN ('unpaid','paid','waived')),
 payment_reference TEXT,
 verified_by TEXT,
 paid_at TIMESTAMPTZ,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(member_id,dues_year)
);
