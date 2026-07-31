# Task 1 Review Package

No git diff is available because git is unavailable. This package contains all Task 1 requirements, claims, and changed content.

## Task Brief

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



## Implementer Report

# Task 1 Report

## 状态
- 结果：部分完成。
- 已完成：`packages/shared/src/types.ts` 已补充 Task 1 共享契约；`server/migrations/029_auto_listing_plans.sql` 已新增并按可重放方式编写（`CREATE TABLE IF NOT EXISTS` / `CREATE UNIQUE INDEX IF NOT EXISTS`）。
- 未完全完成项：无法在真实 PostgreSQL 上完成 `npm run migrate` 的成功重放验证，因为当前环境的 `127.0.0.1:5432` 不可连接。

## 修改文件
- `E:\tool\ozon_sjsq\packages\shared\src\types.ts`
- `E:\tool\ozon_sjsq\server\migrations\029_auto_listing_plans.sql`

## 测试命令与结果
1. `npm run build`
   - 结果：通过（exit 0）。
   - 摘要：TypeScript 编译成功，Vite 生产构建成功；存在既有 chunk size / dynamic import warnings，但不影响退出码。

2. `cd server; npm run check`
   - 结果：通过（exit 0）。
   - 摘要：`tsc -p tsconfig.json --noEmit` 成功。

3. `cd server; npm run migrate`
   - 结果：失败（exit 1）。
   - 摘要：PostgreSQL 连接失败，错误为 `connect ECONNREFUSED 127.0.0.1:5432`；因此未能在真实数据库中验证 029 首次执行与二次重放。

4. 迁移幂等性静态自检
   - 命令：人工检查 `E:\tool\ozon_sjsq\server\migrations\029_auto_listing_plans.sql`
   - 结果：通过静态检查。
   - 摘要：本次新增对象均使用 `IF NOT EXISTS`；未包含会在重复执行时必然失败的 `INSERT` / `ALTER TABLE ADD COLUMN` / `DROP` 语句。

## 自检
- 仅修改了 Task 1 允许的实现文件，未触碰 Task 2+ 代码。
- 新增类型与任务简报列出的名称一致：`OzonUploadQuota`、`AutoListingPlanShopConfig`、`CloudAutoListingPlan`、`CloudAutoListingRun`、`CloudAutoListingAssignment`、`ReserveAutoListingBatchInput`、`ReserveAutoListingBatchResult`。
- `CloudAutoListingRun` / `CloudAutoListingAssignment` / `ReserveAutoListingBatch*` 的字段在简报未给出完整结构；本次按最小原则，直接对齐 029 表结构与预期预留接口命名，没有扩展 Task 2+ 行为。
- 029 迁移遵循现有迁移风格，保持最小变更并显式添加唯一索引约束。

## 风险
- 主要风险：迁移未在真实 PostgreSQL 实例中完成一次成功执行与二次重放验证；虽然 SQL 形式上具备幂等性，仍不能替代真实数据库验证。
- 次要风险：`CloudAutoListingRun`、`CloudAutoListingAssignment`、`ReserveAutoListingBatchInput`、`ReserveAutoListingBatchResult` 的精确字段可能在 Task 2/3 落地时需要微调，但当前命名和最小字段集已与 Task 1 brief 和 029 schema 保持一致。


## Changed Shared Types Region

```ts
export interface CloudProductImageRule {
  id: string;
  productType: string;
  aspectRatio: string;
  ratioWidth: number;
  ratioHeight: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

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
  | "reserved"
  | "preparing"
  | "ready"
  | "submitting"
  | "completed"
  | "failed"
  | "paused"
  | "released";

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

export interface CloudAutoListingRun {
  id: string;
  planId: string;
  runDate: string;
  sequence: number;
  status: string;
  quotaSnapshot: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface CloudAutoListingAssignment {
  id: string;
  planId: string;
  runId: string;
  sourceAssetId: string;
  externalShopId: string;
  batchId?: string | null;
  status: AutoListingAssignmentStatus;
  retryCount: number;
  lastError?: string | null;
  releasedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReserveAutoListingBatchInput {
  planId: string;
  quotaByExternalShopId: Record<string, OzonUploadQuota>;
}

export interface ReserveAutoListingBatchResult {
  run: CloudAutoListingRun;
  assignments: CloudAutoListingAssignment[];
}

export interface LocalMockupRenderAssetInput {
  id: string;
  sku: string;
  sourceFilename?: string;
  publicUrl?: string;
}

export interface LocalMockupRenderRequest {
  cloudApiBaseUrl?: string;
  cloudAuthToken?: string;
  templateId: string;
  templateName?: string;
  assets: LocalMockupRenderAssetInput[];
  maxWorkers?: number;
}

export interface LocalMockupRenderItemResult {
  sourceAssetId: string;
  sourceSku: string;
  ok: boolean;
  assets: CloudMockupAsset[];
  error?: string;
}

export interface LocalMockupRenderResult {
  ok: boolean;
  templateId: string;
  templateName: string;
  generated: number;
  successCount: number;
  failedCount: number;
  items: LocalMockupRenderItemResult[];
}

export interface LocalMockupProgressItem {
  sourceAssetId: string;
  sourceSku: string;
  error?: string;
}

export interface LocalMockupProgress {
  total: number;
  workerCount: number;
  started: number;
  completed: number;
  failed: number;
  queued: number;
  active: number;
  running: LocalMockupProgressItem[];
  completedAssetIds: string[];
  failedItems: LocalMockupProgressItem[];
}

export interface CloudTitlePromptTemplate {
  id: string;
  name: string;
  prompt: string;
```

## New Migration

```sql
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
  status text NOT NULL,
  quota_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, plan_id, run_date, sequence)
);

CREATE TABLE IF NOT EXISTS gallery_auto_listing_assignments (
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

CREATE UNIQUE INDEX IF NOT EXISTS gallery_auto_listing_assignment_asset_uq
  ON gallery_auto_listing_assignments(source_asset_id) WHERE released_at IS NULL;

```
