CREATE TABLE IF NOT EXISTS legacy_listing_upload_grants (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  sku TEXT NOT NULL,
  source_filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS legacy_listing_upload_grants_user_created_at_idx
  ON legacy_listing_upload_grants(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS legacy_listing_upload_grants_expires_at_idx
  ON legacy_listing_upload_grants(expires_at);