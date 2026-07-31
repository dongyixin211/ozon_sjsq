CREATE TABLE IF NOT EXISTS title_prompt_templates (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, name)
);

CREATE INDEX IF NOT EXISTS title_prompt_templates_user_updated_idx
  ON title_prompt_templates (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS shop_product_templates (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  external_template_id TEXT,
  category_label TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, shop_id, name)
);

CREATE INDEX IF NOT EXISTS shop_product_templates_shop_updated_idx
  ON shop_product_templates (user_id, shop_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS gallery_listing_batches (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ratio_family TEXT NOT NULL,
  mockup_template_id TEXT NOT NULL,
  mockup_template_name TEXT NOT NULL,
  title_prompt_template_id UUID REFERENCES title_prompt_templates(id) ON DELETE SET NULL,
  title_prompt_template_name TEXT,
  title_prompt TEXT,
  status TEXT NOT NULL DEFAULT 'prepared',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gallery_listing_batches_ratio_family_check CHECK (ratio_family IN ('portrait', 'square', 'landscape', 'wide')),
  CONSTRAINT gallery_listing_batches_status_check CHECK (status IN ('prepared', 'uploaded', 'failed'))
);

CREATE INDEX IF NOT EXISTS gallery_listing_batches_user_updated_idx
  ON gallery_listing_batches (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS gallery_listing_batch_assets (
  id UUID PRIMARY KEY,
  batch_id UUID NOT NULL REFERENCES gallery_listing_batches(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  external_shop_id TEXT NOT NULL,
  shop_name TEXT NOT NULL,
  product_template_id TEXT NOT NULL,
  product_template_name TEXT NOT NULL,
  source_asset_id UUID NOT NULL REFERENCES gallery_assets(id) ON DELETE CASCADE,
  source_sku TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  image_asset_ids UUID[] NOT NULL DEFAULT '{}',
  image_urls TEXT[] NOT NULL DEFAULT '{}',
  title TEXT,
  title_generated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(batch_id, source_asset_id),
  UNIQUE(user_id, source_sku)
);

CREATE INDEX IF NOT EXISTS gallery_listing_batch_assets_user_source_idx
  ON gallery_listing_batch_assets (user_id, source_asset_id);

CREATE INDEX IF NOT EXISTS gallery_listing_batch_assets_batch_shop_idx
  ON gallery_listing_batch_assets (batch_id, shop_id);

CREATE TABLE IF NOT EXISTS gallery_listing_batch_shops (
  id UUID PRIMARY KEY,
  batch_id UUID NOT NULL REFERENCES gallery_listing_batches(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  external_shop_id TEXT NOT NULL,
  shop_name TEXT NOT NULL,
  product_template_id TEXT NOT NULL,
  product_template_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'prepared',
  uploaded_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(batch_id, shop_id),
  CONSTRAINT gallery_listing_batch_shops_status_check CHECK (status IN ('prepared', 'uploaded', 'failed'))
);

CREATE INDEX IF NOT EXISTS gallery_listing_batch_shops_user_shop_idx
  ON gallery_listing_batch_shops (user_id, shop_id, updated_at DESC);
