ALTER TABLE gallery_assets
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE gallery_assets
  ADD COLUMN IF NOT EXISTS deleted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS gallery_assets_user_visible_created_idx
  ON gallery_assets (uploaded_by_user_id, created_at DESC)
  WHERE uploaded_by_user_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS gallery_assets_deleted_idx
  ON gallery_assets (deleted_at)
  WHERE deleted_at IS NOT NULL;
