-- 041_ai_image_generation_feature.sql
-- Restrict the GPT image generation page to beta users and administrators.

INSERT INTO feature_flags (
  key,
  label,
  module,
  description,
  default_roles,
  sort_order
) VALUES (
  'ai.image_generation',
  'GPT 图片生成',
  '素材',
  '使用 GPT 生成商品图片',
  ARRAY['beta', 'admin'],
  4
)
ON CONFLICT (key) DO UPDATE SET
  label = EXCLUDED.label,
  module = EXCLUDED.module,
  description = EXCLUDED.description,
  default_roles = EXCLUDED.default_roles,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();
