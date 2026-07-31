CREATE TABLE IF NOT EXISTS shop_listing_events (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  external_shop_id TEXT NOT NULL,
  shop_name TEXT NOT NULL,
  batch_id UUID REFERENCES gallery_listing_batches(id) ON DELETE SET NULL,
  source_asset_id UUID REFERENCES gallery_assets(id) ON DELETE SET NULL,
  source_sku TEXT NOT NULL,
  listing_product_id BIGINT,
  listed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, shop_id, source_sku)
);

CREATE INDEX IF NOT EXISTS shop_listing_events_user_listed_idx
  ON shop_listing_events (user_id, listed_at DESC);

CREATE INDEX IF NOT EXISTS shop_listing_events_user_shop_listed_idx
  ON shop_listing_events (user_id, shop_id, listed_at DESC);

CREATE TABLE IF NOT EXISTS shop_daily_listing_stats (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  external_shop_id TEXT NOT NULL,
  shop_name TEXT NOT NULL,
  stat_date DATE NOT NULL,
  listed_count INTEGER NOT NULL DEFAULT 0,
  first_listed_at TIMESTAMPTZ,
  last_listed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, shop_id, stat_date)
);

CREATE INDEX IF NOT EXISTS shop_daily_listing_stats_user_date_idx
  ON shop_daily_listing_stats (user_id, stat_date DESC);

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
  COALESCE(lba.listing_completed_at, bs.uploaded_at, b.updated_at, lba.updated_at, now()) AS listed_at,
  COALESCE(lba.listing_completed_at, bs.uploaded_at, b.updated_at, lba.created_at, now()) AS created_at,
  now() AS updated_at
FROM gallery_listing_batch_assets lba
JOIN gallery_listing_batches b ON b.id = lba.batch_id
LEFT JOIN gallery_listing_batch_shops bs
  ON bs.batch_id = lba.batch_id
  AND bs.shop_id = lba.shop_id
WHERE b.status = 'uploaded'
  OR bs.status = 'uploaded'
  OR lba.listing_product_id IS NOT NULL
  OR lba.listing_completed_at IS NOT NULL
ORDER BY
  lba.user_id,
  lba.shop_id,
  lba.source_sku,
  COALESCE(lba.listing_completed_at, bs.uploaded_at, b.updated_at, lba.updated_at, now()) ASC
ON CONFLICT (user_id, shop_id, source_sku) DO NOTHING;

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
  user_id,
  shop_id,
  (array_agg(external_shop_id ORDER BY listed_at DESC))[1],
  (array_agg(shop_name ORDER BY listed_at DESC))[1],
  (listed_at AT TIME ZONE 'Asia/Shanghai')::date,
  count(*)::int,
  min(listed_at),
  max(listed_at),
  now()
FROM shop_listing_events
GROUP BY user_id, shop_id, (listed_at AT TIME ZONE 'Asia/Shanghai')::date
ON CONFLICT (user_id, shop_id, stat_date)
DO UPDATE SET
  external_shop_id = EXCLUDED.external_shop_id,
  shop_name = EXCLUDED.shop_name,
  listed_count = EXCLUDED.listed_count,
  first_listed_at = EXCLUDED.first_listed_at,
  last_listed_at = EXCLUDED.last_listed_at,
  updated_at = now();
