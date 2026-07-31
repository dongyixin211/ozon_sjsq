CREATE TABLE IF NOT EXISTS product_sales_signals (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  external_shop_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  order_count INTEGER NOT NULL DEFAULT 0,
  quantity INTEGER NOT NULL DEFAULT 0,
  last_ordered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL DEFAULT 'client',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, shop_id, sku),
  CONSTRAINT product_sales_signals_order_count_check CHECK (order_count >= 0),
  CONSTRAINT product_sales_signals_quantity_check CHECK (quantity >= 0)
);

CREATE INDEX IF NOT EXISTS product_sales_signals_sku_idx ON product_sales_signals (sku);
CREATE INDEX IF NOT EXISTS product_sales_signals_last_ordered_desc_idx ON product_sales_signals (last_ordered_at DESC);
CREATE INDEX IF NOT EXISTS product_sales_signals_user_shop_idx ON product_sales_signals (user_id, shop_id);

CREATE TABLE IF NOT EXISTS featured_gallery_assets (
  id UUID PRIMARY KEY,
  asset_id UUID NOT NULL UNIQUE REFERENCES gallery_assets(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  order_count INTEGER NOT NULL DEFAULT 0,
  distinct_user_count INTEGER NOT NULL DEFAULT 0,
  distinct_shop_count INTEGER NOT NULL DEFAULT 0,
  last_ordered_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'review',
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT featured_gallery_assets_status_check CHECK (status IN ('active', 'hidden', 'review')),
  CONSTRAINT featured_gallery_assets_score_check CHECK (score >= 0),
  CONSTRAINT featured_gallery_assets_order_count_check CHECK (order_count >= 0)
);

CREATE INDEX IF NOT EXISTS featured_gallery_assets_status_score_idx
  ON featured_gallery_assets (status, score DESC, last_ordered_at DESC);
CREATE INDEX IF NOT EXISTS featured_gallery_assets_sku_idx ON featured_gallery_assets (sku);
CREATE INDEX IF NOT EXISTS featured_gallery_assets_sha256_idx ON featured_gallery_assets (sha256);

CREATE INDEX IF NOT EXISTS gallery_assets_user_created_idx
  ON gallery_assets (uploaded_by_user_id, created_at DESC)
  WHERE uploaded_by_user_id IS NOT NULL;

ALTER TABLE gallery_assets DROP CONSTRAINT IF EXISTS gallery_assets_object_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS gallery_assets_user_object_key_idx
  ON gallery_assets (uploaded_by_user_id, object_key)
  WHERE uploaded_by_user_id IS NOT NULL;
