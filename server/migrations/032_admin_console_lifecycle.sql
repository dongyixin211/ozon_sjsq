ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by TEXT;

ALTER TABLE authorization_keys
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by TEXT;

ALTER TABLE order_postings
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by TEXT;

ALTER TABLE featured_gallery_assets
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by TEXT,
  ADD COLUMN IF NOT EXISTS admin_note TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'automatic';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'featured_gallery_assets_source_check'
      AND conrelid = 'featured_gallery_assets'::regclass
  ) THEN
    ALTER TABLE featured_gallery_assets
      ADD CONSTRAINT featured_gallery_assets_source_check
      CHECK (source IN ('automatic', 'manual'));
  END IF;
END
$$;

ALTER TABLE product_image_rules
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by TEXT;

ALTER TABLE mockup_templates
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by TEXT;

CREATE INDEX IF NOT EXISTS users_active_created_at_desc_idx
  ON users (created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS authorization_keys_active_created_at_desc_idx
  ON authorization_keys (created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS order_postings_active_in_process_at_desc_idx
  ON order_postings (in_process_at DESC NULLS LAST, synced_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS featured_gallery_assets_active_status_score_idx
  ON featured_gallery_assets (status, score DESC, last_ordered_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS product_image_rules_active_updated_at_desc_idx
  ON product_image_rules (updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS mockup_templates_active_updated_at_desc_idx
  ON mockup_templates (updated_at DESC)
  WHERE deleted_at IS NULL;
