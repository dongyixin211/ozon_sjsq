ALTER TABLE gallery_listing_batch_shops
  ADD COLUMN IF NOT EXISTS config_snapshot JSONB;

ALTER TABLE gallery_listing_batch_assets
  ADD COLUMN IF NOT EXISTS config_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS stage_progress JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS listing_progress INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS listing_stage TEXT NOT NULL DEFAULT 'queued',
  ADD COLUMN IF NOT EXISTS listing_stage_message TEXT,
  ADD COLUMN IF NOT EXISTS listing_product_id BIGINT,
  ADD COLUMN IF NOT EXISTS listing_completed_at TIMESTAMPTZ;

ALTER TABLE gallery_listing_batch_assets
  DROP CONSTRAINT IF EXISTS gallery_listing_batch_assets_batch_id_source_asset_id_key;

ALTER TABLE gallery_listing_batch_assets
  DROP CONSTRAINT IF EXISTS gallery_listing_batch_assets_user_id_source_sku_key;

DROP INDEX IF EXISTS gallery_usage_one_uploaded_shop_per_user_sku;

CREATE UNIQUE INDEX IF NOT EXISTS gallery_listing_batch_assets_batch_asset_shop_uidx
  ON gallery_listing_batch_assets (batch_id, source_asset_id, shop_id);

CREATE UNIQUE INDEX IF NOT EXISTS gallery_listing_batch_assets_user_shop_sku_uidx
  ON gallery_listing_batch_assets (user_id, shop_id, source_sku);

CREATE INDEX IF NOT EXISTS gallery_listing_batch_assets_user_stage_idx
  ON gallery_listing_batch_assets (user_id, listing_stage, updated_at DESC);

CREATE INDEX IF NOT EXISTS gallery_listing_batch_assets_user_external_shop_idx
  ON gallery_listing_batch_assets (user_id, external_shop_id, updated_at DESC);
