ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

UPDATE users
SET last_login_at = COALESCE(last_login_at, created_at)
WHERE last_login_at IS NULL;

CREATE INDEX IF NOT EXISTS users_last_login_at_idx
  ON users (last_login_at DESC NULLS LAST);
