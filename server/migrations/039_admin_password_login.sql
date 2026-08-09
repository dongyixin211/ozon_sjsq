-- 039_admin_password_login.sql
-- Standalone administrator credentials and revocable administrator sessions.

CREATE TABLE IF NOT EXISTS admin_accounts (
  phone           VARCHAR(32) PRIMARY KEY,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  password_hash   TEXT NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id              UUID PRIMARY KEY,
  admin_phone     VARCHAR(32) NOT NULL REFERENCES admin_accounts(phone) ON DELETE CASCADE,
  token_jti_hash  CHAR(64) NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_sessions_active_idx
  ON admin_sessions (admin_phone, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION update_admin_accounts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_admin_accounts_updated_at ON admin_accounts;
CREATE TRIGGER trg_admin_accounts_updated_at
  BEFORE UPDATE ON admin_accounts
  FOR EACH ROW
  EXECUTE FUNCTION update_admin_accounts_updated_at();
