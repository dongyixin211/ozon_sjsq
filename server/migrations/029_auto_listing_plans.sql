CREATE TABLE IF NOT EXISTS gallery_auto_listing_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  product_image_rule_id uuid NOT NULL REFERENCES product_image_rules(id),
  mockup_template_id text NOT NULL,
  mockup_template_name text NOT NULL,
  title_prompt_template_id uuid,
  title_prompt_template_name text,
  title_prompt text NOT NULL,
  shop_configs jsonb NOT NULL DEFAULT '[]'::jsonb,
  start_minute int NOT NULL DEFAULT 480 CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute int NOT NULL DEFAULT 1320 CHECK (end_minute BETWEEN 1 AND 1440),
  batch_size int NOT NULL DEFAULT 10 CHECK (batch_size BETWEEN 5 AND 20),
  buffer_size int NOT NULL DEFAULT 20 CHECK (buffer_size BETWEEN 0 AND 40),
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS gallery_auto_listing_active_rule_uq
  ON gallery_auto_listing_plans(user_id, product_image_rule_id) WHERE enabled;

CREATE TABLE IF NOT EXISTS gallery_auto_listing_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES gallery_auto_listing_plans(id) ON DELETE CASCADE,
  run_date date NOT NULL,
  sequence int NOT NULL,
  status text NOT NULL CHECK (status IN ('waiting', 'preparing', 'submitting', 'completed', 'failed', 'paused')),
  quota_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, plan_id, run_date, sequence)
);

CREATE TABLE IF NOT EXISTS gallery_auto_listing_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES gallery_auto_listing_plans(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES gallery_auto_listing_runs(id) ON DELETE CASCADE,
  source_asset_id uuid NOT NULL REFERENCES gallery_assets(id),
  external_shop_id text NOT NULL,
  batch_id uuid REFERENCES gallery_listing_batches(id),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'preparing', 'ready', 'submitting', 'completed', 'failed', 'paused', 'released')),
  retry_count int NOT NULL DEFAULT 0,
  last_error text,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS gallery_auto_listing_assignment_asset_uq
  ON gallery_auto_listing_assignments(source_asset_id) WHERE released_at IS NULL;
