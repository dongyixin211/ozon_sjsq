ALTER TABLE shop_product_templates
  ALTER COLUMN shop_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS shop_product_templates_user_shared_name_idx
  ON shop_product_templates (user_id, name)
  WHERE shop_id IS NULL;

CREATE INDEX IF NOT EXISTS shop_product_templates_shared_updated_idx
  ON shop_product_templates (user_id, updated_at DESC)
  WHERE shop_id IS NULL;
