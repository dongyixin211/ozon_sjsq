CREATE TABLE IF NOT EXISTS product_image_rules (
  id UUID PRIMARY KEY,
  product_type TEXT NOT NULL,
  aspect_ratio TEXT NOT NULL,
  ratio_width INTEGER NOT NULL,
  ratio_height INTEGER NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT product_image_rules_product_type_check CHECK (length(trim(product_type)) > 0),
  CONSTRAINT product_image_rules_ratio_width_check CHECK (ratio_width > 0),
  CONSTRAINT product_image_rules_ratio_height_check CHECK (ratio_height > 0),
  CONSTRAINT product_image_rules_aspect_ratio_check CHECK (aspect_ratio ~ '^[1-9][0-9]{0,3}:[1-9][0-9]{0,3}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS product_image_rules_type_ratio_unique
  ON product_image_rules (lower(product_type), aspect_ratio);

CREATE INDEX IF NOT EXISTS product_image_rules_enabled_idx
  ON product_image_rules (enabled, product_type, aspect_ratio);

ALTER TABLE gallery_assets
  ADD COLUMN IF NOT EXISTS product_image_rule_id UUID REFERENCES product_image_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS product_type TEXT,
  ADD COLUMN IF NOT EXISTS aspect_ratio TEXT;

CREATE INDEX IF NOT EXISTS gallery_assets_product_image_rule_idx
  ON gallery_assets(product_image_rule_id);

CREATE INDEX IF NOT EXISTS gallery_assets_aspect_ratio_idx
  ON gallery_assets(aspect_ratio);

ALTER TABLE gallery_upload_tasks
  ADD COLUMN IF NOT EXISTS product_image_rule_id UUID REFERENCES product_image_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS product_type TEXT,
  ADD COLUMN IF NOT EXISTS aspect_ratio TEXT;

INSERT INTO product_image_rules (id, product_type, aspect_ratio, ratio_width, ratio_height, enabled)
VALUES
  ('00000000-0000-4000-8000-000000000101', '方巾 / 头巾 / 丝巾', '1:1', 1, 1, TRUE),
  ('00000000-0000-4000-8000-000000000102', '干发帽 / 浴帽', '1:1', 1, 1, TRUE),
  ('00000000-0000-4000-8000-000000000103', '桌布 / 餐桌布', '3:2', 3, 2, TRUE),
  ('00000000-0000-4000-8000-000000000104', '法兰绒毛毯', '2:3', 2, 3, TRUE),
  ('00000000-0000-4000-8000-000000000105', '法兰绒挂毯', '2:3', 2, 3, TRUE),
  ('00000000-0000-4000-8000-000000000106', '楼梯垫', '4:1', 4, 1, TRUE),
  ('00000000-0000-4000-8000-000000000107', '桌布 / 餐桌布', '1:1', 1, 1, TRUE),
  ('00000000-0000-4000-8000-000000000108', '化妆包', '3:2', 3, 2, TRUE),
  ('00000000-0000-4000-8000-000000000109', '化妆包', '4:3', 4, 3, TRUE),
  ('00000000-0000-4000-8000-000000000110', '束发带', '3:2', 3, 2, TRUE),
  ('00000000-0000-4000-8000-000000000111', '束发带', '4:3', 4, 3, TRUE),
  ('00000000-0000-4000-8000-000000000112', '浴裙套装 / 浴裙+干发帽套装', '3:2', 3, 2, TRUE),
  ('00000000-0000-4000-8000-000000000113', '眼镜布', '2:3', 2, 3, TRUE),
  ('00000000-0000-4000-8000-000000000114', '隔尿垫', '3:2', 3, 2, TRUE),
  ('00000000-0000-4000-8000-000000000115', '束口袋', '3:4', 3, 4, TRUE),
  ('00000000-0000-4000-8000-000000000116', '沙滩包', '4:3', 4, 3, TRUE)
ON CONFLICT (lower(product_type), aspect_ratio) DO NOTHING;
