CREATE TABLE IF NOT EXISTS ai_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE,
  image_provider TEXT NOT NULL DEFAULT 'pixel',
  image_base_url TEXT NOT NULL DEFAULT 'https://ai-pixel.online/v1',
  image_model TEXT NOT NULL DEFAULT 'gpt-image-2',
  image_api_key TEXT,
  text_provider TEXT NOT NULL DEFAULT 'xiaoqian',
  text_base_url TEXT NOT NULL DEFAULT 'https://xiaoqian.art/v1',
  text_model TEXT NOT NULL DEFAULT 'gpt-5-high',
  text_api_key TEXT,
  image_prompt_template TEXT NOT NULL DEFAULT '',
  title_prompt_template TEXT NOT NULL DEFAULT '',
  description_prompt_template TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_settings_singleton CHECK (id = TRUE)
);

INSERT INTO ai_settings (id)
VALUES (TRUE)
ON CONFLICT (id) DO NOTHING;
