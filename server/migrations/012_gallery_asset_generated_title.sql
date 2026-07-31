ALTER TABLE gallery_assets
  ADD COLUMN IF NOT EXISTS generated_title TEXT,
  ADD COLUMN IF NOT EXISTS generated_title_image_asset_id UUID REFERENCES gallery_assets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS generated_title_prompt TEXT,
  ADD COLUMN IF NOT EXISTS generated_title_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS gallery_assets_generated_title_updated_idx
  ON gallery_assets (uploaded_by_user_id, generated_title_updated_at DESC)
  WHERE generated_title IS NOT NULL AND deleted_at IS NULL;
