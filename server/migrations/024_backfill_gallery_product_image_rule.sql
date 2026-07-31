INSERT INTO product_image_rules (id, product_type, aspect_ratio, ratio_width, ratio_height, enabled)
VALUES ('00000000-0000-4000-8000-000000000101', '方巾 / 头巾 / 丝巾', '1:1', 1, 1, TRUE)
ON CONFLICT (id) DO UPDATE
SET product_type = EXCLUDED.product_type,
    aspect_ratio = EXCLUDED.aspect_ratio,
    ratio_width = EXCLUDED.ratio_width,
    ratio_height = EXCLUDED.ratio_height,
    enabled = TRUE,
    updated_at = now();

ALTER TABLE gallery_listing_batches
  ADD COLUMN IF NOT EXISTS product_image_rule_id UUID REFERENCES product_image_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS product_type TEXT,
  ADD COLUMN IF NOT EXISTS aspect_ratio TEXT;

CREATE INDEX IF NOT EXISTS gallery_listing_batches_product_image_rule_idx
  ON gallery_listing_batches(product_image_rule_id);

UPDATE gallery_assets
SET product_image_rule_id = '00000000-0000-4000-8000-000000000101',
    product_type = '方巾 / 头巾 / 丝巾',
    aspect_ratio = '1:1'
WHERE product_image_rule_id IS NULL;

UPDATE gallery_listing_batches
SET product_image_rule_id = '00000000-0000-4000-8000-000000000101',
    product_type = '方巾 / 头巾 / 丝巾',
    aspect_ratio = '1:1'
WHERE product_image_rule_id IS NULL;
