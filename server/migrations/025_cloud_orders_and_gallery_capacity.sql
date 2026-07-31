ALTER TABLE users
  ADD COLUMN IF NOT EXISTS gallery_storage_limit_bytes BIGINT NOT NULL DEFAULT 10737418240;

CREATE TABLE IF NOT EXISTS order_postings (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shop_id UUID REFERENCES shops(id) ON DELETE SET NULL,
  external_shop_id TEXT NOT NULL,
  shop_name TEXT NOT NULL,
  posting_kind TEXT,
  posting_number TEXT NOT NULL,
  order_number TEXT,
  order_id BIGINT,
  status TEXT,
  category TEXT,
  in_process_at TIMESTAMPTZ,
  shipment_date TIMESTAMPTZ,
  warehouse_name TEXT,
  tracking_number TEXT,
  products_count INTEGER NOT NULL DEFAULT 0,
  offer_ids TEXT[] NOT NULL DEFAULT '{}',
  products JSONB NOT NULL DEFAULT '[]'::jsonb,
  image_url TEXT,
  sales_amount NUMERIC(14, 2),
  currency_code TEXT,
  downloaded_at TIMESTAMPTZ,
  download_output_path TEXT,
  raw_json JSONB,
  first_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, external_shop_id, posting_number)
);

CREATE INDEX IF NOT EXISTS order_postings_user_time_idx
  ON order_postings (user_id, in_process_at DESC NULLS LAST, synced_at DESC);

CREATE INDEX IF NOT EXISTS order_postings_shop_status_idx
  ON order_postings (external_shop_id, status, in_process_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS order_postings_category_time_idx
  ON order_postings (category, in_process_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS order_postings_offer_ids_gin_idx
  ON order_postings USING GIN (offer_ids);
