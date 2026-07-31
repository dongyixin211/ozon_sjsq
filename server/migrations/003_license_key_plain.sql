ALTER TABLE authorization_keys
ADD COLUMN IF NOT EXISTS key_plain TEXT;

UPDATE authorization_keys
SET key_plain = NULL
WHERE status <> 'unused';
