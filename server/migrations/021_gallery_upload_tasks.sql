CREATE TABLE IF NOT EXISTS gallery_upload_tasks (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  total_files INTEGER NOT NULL DEFAULT 0,
  total_bytes BIGINT NOT NULL DEFAULT 0,
  uploaded INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gallery_upload_tasks_status_check CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed'))
);

CREATE TABLE IF NOT EXISTS gallery_upload_task_items (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES gallery_upload_tasks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes BIGINT NOT NULL DEFAULT 0,
  temp_path TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  asset_id UUID REFERENCES gallery_assets(id) ON DELETE SET NULL,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gallery_upload_task_items_status_check CHECK (status IN ('queued', 'running', 'succeeded', 'failed'))
);

CREATE INDEX IF NOT EXISTS gallery_upload_tasks_user_status_idx
  ON gallery_upload_tasks(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS gallery_upload_task_items_task_status_idx
  ON gallery_upload_task_items(task_id, status, created_at);
