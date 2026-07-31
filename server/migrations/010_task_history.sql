CREATE TABLE IF NOT EXISTS task_history (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  input_path TEXT,
  output_path TEXT,
  result_path TEXT,
  result_excel_path TEXT,
  success_count INTEGER,
  failed_count INTEGER,
  last_error TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS task_history_user_updated_idx
  ON task_history (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS task_history_logs (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS task_history_logs_user_job_created_idx
  ON task_history_logs (user_id, job_id, created_at ASC);
