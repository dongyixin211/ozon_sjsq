# Task 1 Brief

Global constraints are inherited from the implementation plan.

### Task 1: Shared Contracts and Database Schema

**Files:**
- Modify: `packages/shared/src/types.ts`
- Create: `server/migrations/029_auto_listing_plans.sql`

**Interfaces:**
- Produces: `OzonUploadQuota`, `AutoListingPlanShopConfig`, `CloudAutoListingPlan`, `CloudAutoListingRun`, `CloudAutoListingAssignment`, `ReserveAutoListingBatchInput`, `ReserveAutoListingBatchResult`.

- [ ] **Step 1: Add shared types**

```ts
export interface OzonUploadQuota {
  dailyCreateLimit: number;
  dailyCreateUsage: number;
  dailyCreateRemaining: number;
  dailyUpdateLimit: number;
  dailyUpdateUsage: number;
  dailyUpdateRemaining: number;
  totalLimit: number;
  totalUsage: number;
  totalRemaining: number;
  resetAt?: string | null;
  operationLimits?: unknown;
  fetchedAt: string;
}

export type AutoListingAssignmentStatus =
  | "reserved" | "preparing" | "ready" | "submitting"
  | "completed" | "failed" | "paused" | "released";

export interface AutoListingPlanShopConfig {
  externalShopId: string;
  shopName: string;
  localShopId: string;
  localTemplateId: string;
  productTemplateId: string;
  productTemplateName: string;
  templateProduct: unknown;
  autoGenerateBarcode: boolean;
  autoUpdateStock: boolean;
  autoAddToAction: boolean;
}

export interface CloudAutoListingPlan {
  id: string;
  name: string;
  productImageRuleId: string;
  mockupTemplateId: string;
  mockupTemplateName: string;
  titlePromptTemplateId?: string | null;
  titlePromptTemplateName?: string | null;
  titlePrompt: string;
  shopConfigs: AutoListingPlanShopConfig[];
  startMinute: number;
  endMinute: number;
  batchSize: number;
  bufferSize: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 2: Add schema with database-enforced uniqueness**

```sql
CREATE TABLE gallery_auto_listing_plans (
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
CREATE UNIQUE INDEX gallery_auto_listing_active_rule_uq
  ON gallery_auto_listing_plans(user_id, product_image_rule_id) WHERE enabled;

CREATE TABLE gallery_auto_listing_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES gallery_auto_listing_plans(id) ON DELETE CASCADE,
  run_date date NOT NULL,
  sequence int NOT NULL,
  status text NOT NULL,
  quota_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, plan_id, run_date, sequence)
);

CREATE TABLE gallery_auto_listing_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES gallery_auto_listing_plans(id),
  run_id uuid NOT NULL REFERENCES gallery_auto_listing_runs(id),
  source_asset_id uuid NOT NULL REFERENCES gallery_assets(id),
  external_shop_id text NOT NULL,
  batch_id uuid REFERENCES gallery_listing_batches(id),
  status text NOT NULL DEFAULT 'reserved',
  retry_count int NOT NULL DEFAULT 0,
  last_error text,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX gallery_auto_listing_assignment_asset_uq
  ON gallery_auto_listing_assignments(source_asset_id) WHERE released_at IS NULL;
```

- [ ] **Step 3: Run type and migration checks**

Run: `npm run build`
Expected: TypeScript compiles.

Run: `cd server; npm run check; npm run migrate`
Expected: migration 029 applies once and reruns safely.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types.ts server/migrations/029_auto_listing_plans.sql
git commit -m "feat: add automatic listing persistence"
```

