CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  membership_plan TEXT,
  membership_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_role_check CHECK (role IN ('member', 'admin'))
);

CREATE TABLE IF NOT EXISTS authorization_keys (
  id UUID PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  key_plain TEXT,
  plan TEXT NOT NULL,
  days INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'unused',
  assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  redeemed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT authorization_keys_plan_check CHECK (plan IN ('monthly', 'quarterly', 'yearly')),
  CONSTRAINT authorization_keys_status_check CHECK (status IN ('unused', 'redeemed', 'disabled'))
);

CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint_hash TEXT NOT NULL,
  device_name TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS devices_one_active_device_per_user
  ON devices(user_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS user_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_jti_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_sessions_user_id_idx ON user_sessions(user_id);

CREATE TABLE IF NOT EXISTS shops (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_shop_id TEXT NOT NULL,
  name TEXT NOT NULL,
  ozon_client_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, external_shop_id)
);

CREATE TABLE IF NOT EXISTS gallery_assets (
  id UUID PRIMARY KEY,
  uploaded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  sku TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  ratio NUMERIC(10, 4) NOT NULL,
  ratio_family TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  public_url TEXT NOT NULL,
  thumb_object_key TEXT,
  thumb_url TEXT,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  source_filename TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gallery_assets_ratio_family_check CHECK (ratio_family IN ('portrait', 'square', 'landscape', 'wide'))
);

CREATE INDEX IF NOT EXISTS gallery_assets_sku_idx ON gallery_assets(sku);
CREATE INDEX IF NOT EXISTS gallery_assets_ratio_family_idx ON gallery_assets(ratio_family);
CREATE INDEX IF NOT EXISTS gallery_assets_sha256_idx ON gallery_assets(sha256);

CREATE TABLE IF NOT EXISTS gallery_usage (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  asset_id UUID NOT NULL REFERENCES gallery_assets(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  usage_type TEXT NOT NULL DEFAULT 'selected',
  used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, shop_id, sku)
);

CREATE INDEX IF NOT EXISTS gallery_usage_user_sku_idx ON gallery_usage(user_id, sku);
CREATE INDEX IF NOT EXISTS gallery_usage_user_shop_idx ON gallery_usage(user_id, shop_id);
