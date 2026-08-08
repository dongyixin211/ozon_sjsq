CREATE TABLE IF NOT EXISTS legacy_listing_upload_cleanup_audit (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  action TEXT NOT NULL CHECK (action IN ('object_delete', 'record_delete', 'grant_delete')),
  status TEXT NOT NULL CHECK (status IN ('dry_run', 'deleted', 'failed', 'skipped')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS legacy_listing_upload_cleanup_audit_object_idx
  ON legacy_listing_upload_cleanup_audit(object_key, created_at DESC);
CREATE INDEX IF NOT EXISTS legacy_listing_upload_cleanup_audit_user_idx
  ON legacy_listing_upload_cleanup_audit(user_id, created_at DESC);
