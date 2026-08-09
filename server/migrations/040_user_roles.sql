-- 040_user_roles.sql
-- Preserve the legacy primary role while allowing users to hold multiple roles.

CREATE TABLE IF NOT EXISTS user_roles (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('member', 'beta', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

CREATE INDEX IF NOT EXISTS user_roles_role_idx ON user_roles (role, user_id);

INSERT INTO user_roles (user_id, role)
SELECT id, role
FROM users
WHERE role IN ('member', 'beta', 'admin')
ON CONFLICT (user_id, role) DO NOTHING;

DELETE FROM user_roles
WHERE user_id = (SELECT id FROM users WHERE phone = '18338062216' LIMIT 1)
  AND role = 'beta';

INSERT INTO user_roles (user_id, role)
SELECT id, 'admin'
FROM users
WHERE phone = '18338062216'
ON CONFLICT (user_id, role) DO NOTHING;

UPDATE users
SET role = 'admin', updated_at = now()
WHERE phone = '18338062216';
