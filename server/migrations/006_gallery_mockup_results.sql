CREATE TABLE IF NOT EXISTS gallery_mockup_results (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_asset_id UUID NOT NULL REFERENCES gallery_assets(id) ON DELETE CASCADE,
  result_asset_id UUID NOT NULL REFERENCES gallery_assets(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL,
  template_name TEXT NOT NULL,
  scene_index INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, source_asset_id, template_id, scene_index),
  CONSTRAINT gallery_mockup_results_scene_index_check CHECK (scene_index > 0)
);

CREATE INDEX IF NOT EXISTS gallery_mockup_results_user_source_idx
  ON gallery_mockup_results (user_id, source_asset_id, template_id, scene_index);

CREATE INDEX IF NOT EXISTS gallery_mockup_results_user_result_idx
  ON gallery_mockup_results (user_id, result_asset_id);
