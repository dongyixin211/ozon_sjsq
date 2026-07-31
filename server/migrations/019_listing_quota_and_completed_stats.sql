DELETE FROM shop_listing_events e
WHERE NOT EXISTS (
  SELECT 1
  FROM gallery_listing_batch_assets lba
  WHERE lba.user_id = e.user_id
    AND lba.shop_id = e.shop_id
    AND lba.source_sku = e.source_sku
    AND lba.listing_completed_at IS NOT NULL
);

INSERT INTO shop_listing_events (
  user_id,
  shop_id,
  external_shop_id,
  shop_name,
  batch_id,
  source_asset_id,
  source_sku,
  listing_product_id,
  listed_at,
  created_at,
  updated_at
)
SELECT DISTINCT ON (lba.user_id, lba.shop_id, lba.source_sku)
  lba.user_id,
  lba.shop_id,
  lba.external_shop_id,
  lba.shop_name,
  lba.batch_id,
  lba.source_asset_id,
  lba.source_sku,
  lba.listing_product_id,
  lba.listing_completed_at,
  lba.listing_completed_at,
  now()
FROM gallery_listing_batch_assets lba
WHERE lba.listing_completed_at IS NOT NULL
ORDER BY
  lba.user_id,
  lba.shop_id,
  lba.source_sku,
  lba.listing_completed_at ASC
ON CONFLICT (user_id, shop_id, source_sku)
DO UPDATE SET
  external_shop_id = EXCLUDED.external_shop_id,
  shop_name = EXCLUDED.shop_name,
  batch_id = EXCLUDED.batch_id,
  source_asset_id = EXCLUDED.source_asset_id,
  listing_product_id = EXCLUDED.listing_product_id,
  listed_at = EXCLUDED.listed_at,
  updated_at = now();

DELETE FROM shop_daily_listing_stats;

INSERT INTO shop_daily_listing_stats (
  user_id,
  shop_id,
  external_shop_id,
  shop_name,
  stat_date,
  listed_count,
  first_listed_at,
  last_listed_at,
  updated_at
)
SELECT
  lba.user_id,
  lba.shop_id,
  (array_agg(lba.external_shop_id ORDER BY lba.listing_completed_at DESC))[1],
  (array_agg(lba.shop_name ORDER BY lba.listing_completed_at DESC))[1],
  (lba.listing_completed_at AT TIME ZONE 'Asia/Shanghai')::date,
  count(*)::int,
  min(lba.listing_completed_at),
  max(lba.listing_completed_at),
  now()
FROM gallery_listing_batch_assets lba
WHERE lba.listing_completed_at IS NOT NULL
GROUP BY
  lba.user_id,
  lba.shop_id,
  (lba.listing_completed_at AT TIME ZONE 'Asia/Shanghai')::date
ON CONFLICT (user_id, shop_id, stat_date)
DO UPDATE SET
  external_shop_id = EXCLUDED.external_shop_id,
  shop_name = EXCLUDED.shop_name,
  listed_count = EXCLUDED.listed_count,
  first_listed_at = EXCLUDED.first_listed_at,
  last_listed_at = EXCLUDED.last_listed_at,
  updated_at = now();
