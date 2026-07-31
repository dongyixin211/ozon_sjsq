CREATE INDEX IF NOT EXISTS users_created_at_desc_idx ON users (created_at DESC);
CREATE INDEX IF NOT EXISTS users_membership_expires_at_idx ON users (membership_expires_at);

CREATE INDEX IF NOT EXISTS authorization_keys_created_at_desc_idx ON authorization_keys (created_at DESC);
CREATE INDEX IF NOT EXISTS authorization_keys_status_created_idx ON authorization_keys (status, created_at DESC);
CREATE INDEX IF NOT EXISTS authorization_keys_plan_created_idx ON authorization_keys (plan, created_at DESC);
CREATE INDEX IF NOT EXISTS authorization_keys_key_prefix_idx ON authorization_keys (key_prefix);

CREATE INDEX IF NOT EXISTS devices_user_active_last_seen_idx
  ON devices (user_id, last_seen_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS shops_user_id_idx ON shops (user_id);
CREATE INDEX IF NOT EXISTS gallery_usage_user_id_idx ON gallery_usage (user_id);
CREATE INDEX IF NOT EXISTS gallery_usage_asset_id_idx ON gallery_usage (asset_id);

CREATE INDEX IF NOT EXISTS gallery_assets_created_at_desc_idx ON gallery_assets (created_at DESC);
CREATE INDEX IF NOT EXISTS gallery_assets_ratio_created_idx ON gallery_assets (ratio_family, created_at DESC);
