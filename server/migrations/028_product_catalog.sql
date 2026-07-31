CREATE TABLE IF NOT EXISTS product_catalog_sync_state (
  source TEXT PRIMARY KEY,
  syncing BOOLEAN NOT NULL DEFAULT false,
  sync_id UUID,
  started_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  categories_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  product_count INTEGER NOT NULL DEFAULT 0,
  asset_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_catalog_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  source_product_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  category_id BIGINT,
  category_name TEXT,
  price_min NUMERIC(14, 2),
  price_max NUMERIC(14, 2),
  weight_min NUMERIC(14, 3),
  weight_max NUMERIC(14, 3),
  delivery_time_text TEXT,
  cover_source_url TEXT,
  cover_url TEXT,
  content_hash TEXT NOT NULL,
  detail_json JSONB NOT NULL,
  source_active BOOLEAN NOT NULL DEFAULT true,
  source_first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, source_product_id)
);

CREATE INDEX IF NOT EXISTS product_catalog_products_query_idx
  ON product_catalog_products (source_active DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS product_catalog_products_category_idx
  ON product_catalog_products (category_id, source_active);

CREATE TABLE IF NOT EXISTS product_catalog_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_url TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  object_key TEXT NOT NULL,
  public_url TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  source_filename TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_catalog_assets_sha_idx
  ON product_catalog_assets (sha256);

CREATE TABLE IF NOT EXISTS product_catalog_product_assets (
  product_id UUID NOT NULL REFERENCES product_catalog_products(id) ON DELETE CASCADE,
  asset_id UUID NOT NULL REFERENCES product_catalog_assets(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  PRIMARY KEY (product_id, source_url)
);

CREATE TABLE IF NOT EXISTS product_catalog_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES product_catalog_products(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  snapshot_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, content_hash)
);
