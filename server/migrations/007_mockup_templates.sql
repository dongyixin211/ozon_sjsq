CREATE TABLE IF NOT EXISTS mockup_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  product_type TEXT NOT NULL DEFAULT '',
  source_aspect_ratio TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  source_type TEXT NOT NULL DEFAULT 'custom',
  template_dir TEXT NOT NULL,
  source_psd_filename TEXT,
  source_psd_path TEXT,
  source_psd_size_bytes BIGINT,
  test_preview_object_key TEXT,
  test_preview_url TEXT,
  last_test_status TEXT NOT NULL DEFAULT 'pending',
  last_test_message TEXT NOT NULL DEFAULT '',
  last_test_at TIMESTAMPTZ,
  scene_count INTEGER NOT NULL DEFAULT 0,
  output_width INTEGER NOT NULL DEFAULT 0,
  output_height INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mockup_templates_id_check CHECK (id ~ '^[a-z0-9][a-z0-9_-]{1,79}$'),
  CONSTRAINT mockup_templates_status_check CHECK (status IN ('draft', 'published', 'disabled')),
  CONSTRAINT mockup_templates_source_type_check CHECK (source_type IN ('system', 'custom')),
  CONSTRAINT mockup_templates_last_test_status_check CHECK (last_test_status IN ('pending', 'succeeded', 'failed')),
  CONSTRAINT mockup_templates_scene_count_check CHECK (scene_count >= 0),
  CONSTRAINT mockup_templates_output_width_check CHECK (output_width >= 0),
  CONSTRAINT mockup_templates_output_height_check CHECK (output_height >= 0)
);

CREATE INDEX IF NOT EXISTS mockup_templates_status_updated_idx
  ON mockup_templates (status, updated_at DESC);

INSERT INTO mockup_templates (
  id,
  name,
  description,
  product_type,
  source_aspect_ratio,
  status,
  source_type,
  template_dir,
  last_test_status,
  last_test_message,
  scene_count,
  output_width,
  output_height,
  updated_at
)
VALUES (
  'fangjin',
  '方巾样机',
  '适合 1:1 方形平面图，生成头巾、方巾、丝巾类商品效果图。',
  '方巾 / 头巾 / 丝巾',
  '1:1 方图',
  'published',
  'system',
  'fangjin',
  'succeeded',
  '系统内置样机，已通过测试。',
  6,
  800,
  1067,
  now()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO mockup_templates (
  id,
  name,
  description,
  product_type,
  source_aspect_ratio,
  status,
  source_type,
  template_dir,
  last_test_status,
  last_test_message,
  scene_count,
  output_width,
  output_height,
  updated_at
)
VALUES (
  'zhuobu',
  '桌布样机',
  '适合 3:2 横图平面图，生成桌布室内、户外、尺寸和细节场景效果图。',
  '桌布 / 餐桌布',
  '3:2 横图',
  'published',
  'system',
  'zhuobu',
  'succeeded',
  '系统内置样机，已通过本地渲染测试。',
  9,
  800,
  1067,
  now()
)
ON CONFLICT (id) DO NOTHING;
