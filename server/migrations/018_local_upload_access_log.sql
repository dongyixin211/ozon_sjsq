CREATE TABLE IF NOT EXISTS local_upload_access_log (
  object_key TEXT PRIMARY KEY,
  last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  access_count BIGINT NOT NULL DEFAULT 1,
  last_source TEXT NOT NULL,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS local_upload_access_log_last_accessed_idx
  ON local_upload_access_log (last_accessed_at DESC);

CREATE INDEX IF NOT EXISTS local_upload_access_log_last_source_idx
  ON local_upload_access_log (last_source);

CREATE TABLE IF NOT EXISTS local_upload_access_state (
  state_key TEXT PRIMARY KEY,
  state_value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO local_upload_access_state (state_key, state_value)
VALUES ('access_tracking_started_at', now()::text)
ON CONFLICT (state_key) DO NOTHING;
