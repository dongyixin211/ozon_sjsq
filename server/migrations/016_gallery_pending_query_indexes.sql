CREATE INDEX IF NOT EXISTS gallery_assets_user_ratio_visible_created_idx
  ON gallery_assets (uploaded_by_user_id, ratio_family, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS gallery_assets_user_sku_visible_idx
  ON gallery_assets (uploaded_by_user_id, sku)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS gallery_usage_user_sku_usage_idx
  ON gallery_usage (user_id, sku, usage_type);

CREATE INDEX IF NOT EXISTS gallery_listing_batch_assets_user_source_sku_idx
  ON gallery_listing_batch_assets (user_id, source_sku);

CREATE INDEX IF NOT EXISTS gallery_listing_batch_assets_user_source_updated_idx
  ON gallery_listing_batch_assets (user_id, source_asset_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS gallery_listing_batch_assets_user_source_shop_updated_idx
  ON gallery_listing_batch_assets (user_id, source_asset_id, external_shop_id, updated_at DESC);
