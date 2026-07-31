# Local Automatic Listing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local, quota-aware automatic listing workflow where users configure each product type once and the assistant safely assigns each image to one shop, processes only small daily batches, and exposes progress through a batch task center.

**Architecture:** The cloud service stores plans, atomic image assignments, runs, and progress; it never renders mockups or calls Ozon. The local assistant queries Ozon quotas, asks the cloud service to reserve a small fair batch, then reuses the existing mockup/title/`start_auto_listing` pipeline. The web UI provides a plan wizard and a batch-oriented processing view.

**Tech Stack:** React 18, TypeScript, Vitest, Fastify, PostgreSQL, Rust/Tauri, Reqwest, Rusqlite.

## Global Constraints

- One source image may belong to only one shop unless a user explicitly releases it.
- Ozon credentials and all heavy execution remain local.
- Default execution window is `08:00–22:00` local time.
- Default batch size is 10; allowed range is 5–20.
- Default rolling buffer is 20 and may not exceed two batches.
- Shops sharing a product type receive quota-aware round-robin allocation.
- Missing quota fields stop allocation for that shop; never substitute an unlimited value.
- Only `reserved` assignments with no generated or submitted work may be bulk-released.
- Use TDD for every behavior change and run full frontend, server, and Rust validation before deployment.

---

## File Map

- `packages/shared/src/types.ts`: cross-layer plan, quota, run, assignment, and scheduler types.
- `server/migrations/029_auto_listing_plans.sql`: plan/run/assignment schema and uniqueness constraints.
- `server/src/auto-listing-planner.ts`: pure quota math, fair allocation, and state validation.
- `server/src/auto-listing-planner.test.ts`: server-side planning unit tests.
- `server/src/routes/gallery-auto-listing-routes.ts`: plan CRUD, atomic reserve, progress, release, and run queries.
- `server/src/routes/gallery-routes.ts`: register the focused auto-listing route module only.
- `src-tauri/src/core/ozon.rs`: Ozon quota API and compatible parser.
- `src-tauri/src/core/auto_listing_scheduler.rs`: local scheduling loop and recovery decisions.
- `src-tauri/src/core/commands.rs`: quota/status/manual-run Tauri commands.
- `src-tauri/src/core/local_assistant.rs`: browser helper command parity.
- `src-tauri/src/lib.rs`: scheduler startup and command registration.
- `src/lib/api.ts`: typed local command bridge.
- `src/lib/cloudApi.ts`: plan/run/reservation cloud endpoints.
- `src/features/cloud/autoListingUtils.ts`: UI validation and presentation helpers.
- `src/features/cloud/AutoListingPlansPage.tsx`: four-step plan wizard.
- `src/features/cloud/AutoListingPlansPage.test.tsx`: wizard tests.
- `src/features/cloud/AutoListingTaskCenter.tsx`: batch task center.
- `src/features/cloud/AutoListingTaskCenter.test.tsx`: task center tests.
- `src/features/cloud/GalleryManager.tsx`: replace processing overview entry with task center and keep image drill-down.
- `src/workspace/navigation.ts`, `src/App.tsx`: add the automatic-listing plan page.
- `src/lib/localAssistantCommandParity.test.ts`: guarantee browser and Tauri command parity.

---

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

### Task 2: Quota Math and Fair Allocation

**Files:**
- Create: `server/src/auto-listing-planner.ts`
- Create: `server/src/auto-listing-planner.test.ts`
- Modify: `server/package.json`

**Interfaces:**
- Produces: `calculateSafeCreateCount(quota, availableAssets)`, `allocateRoundRobin(shops, assetIds)`, `canReleaseAssignment(assignment)`.

- [ ] **Step 1: Add failing planner tests**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { allocateRoundRobin, calculateSafeCreateCount } from "./auto-listing-planner.js";

test("reserves five percent and at least two create slots", () => {
  assert.equal(calculateSafeCreateCount({ createRemaining: 100, totalRemaining: 500 }, 1000), 95);
  assert.equal(calculateSafeCreateCount({ createRemaining: 10, totalRemaining: 500 }, 1000), 8);
  assert.equal(calculateSafeCreateCount({ createRemaining: 2, totalRemaining: 500 }, 1000), 0);
});

test("round robin redistributes after a shop reaches quota", () => {
  const result = allocateRoundRobin([
    { externalShopId: "A", capacity: 1 },
    { externalShopId: "B", capacity: 3 },
  ], ["1", "2", "3", "4"]);
  assert.deepEqual(result.map(item => item.externalShopId), ["A", "B", "B", "B"]);
});
```

- [ ] **Step 2: Add server test command and verify RED**

```json
"test": "node --import tsx --test src/**/*.test.ts"
```

Run: `cd server; npm test`
Expected: FAIL because planner functions do not exist.

- [ ] **Step 3: Implement pure planner functions**

```ts
export function calculateSafeCreateCount(
  quota: { createRemaining: number; totalRemaining: number },
  availableAssets: number,
) {
  if (quota.createRemaining < 3 || quota.totalRemaining <= 0) return 0;
  const reserve = Math.max(2, Math.ceil(quota.createRemaining * 0.05));
  return Math.max(0, Math.min(quota.createRemaining - reserve, quota.totalRemaining, availableAssets));
}
```

Implement stable round-robin without randomness and reject duplicate asset IDs.

- [ ] **Step 4: Verify GREEN**

Run: `cd server; npm test; npm run check`
Expected: planner tests pass and server compiles.

- [ ] **Step 5: Commit**

```bash
git add server/src/auto-listing-planner.ts server/src/auto-listing-planner.test.ts server/package.json
git commit -m "feat: add quota aware listing planner"
```

### Task 3: Cloud Plan and Reservation API

**Files:**
- Create: `server/src/routes/gallery-auto-listing-routes.ts`
- Modify: `server/src/routes/gallery-routes.ts`
- Modify: `src/lib/cloudApi.ts`
- Test: `server/src/auto-listing-planner.test.ts`

**Interfaces:**
- Produces cloud methods: `listAutoListingPlans`, `saveAutoListingPlan`, `reserveAutoListingBatch`, `updateAutoListingAssignments`, `releaseAutoListingAssignments`, `listAutoListingRuns`.

- [ ] **Step 1: Add failing validation tests**

Test plan rejection for `batchSize=21`, `bufferSize > batchSize * 2`, duplicate shops, and enabling a second plan for the same product rule.

Run: `cd server; npm test`
Expected: FAIL for missing validation functions.

- [ ] **Step 2: Implement plan CRUD routes**

Add:

```text
GET    /gallery/auto-listing/plans
POST   /gallery/auto-listing/plans
PUT    /gallery/auto-listing/plans/:planId
DELETE /gallery/auto-listing/plans/:planId
```

Persist `shopConfigs` as a complete execution snapshot and reject enabled plans without shops.

- [ ] **Step 3: Implement atomic reserve transaction**

Inside one PostgreSQL transaction:

```sql
SELECT id
FROM gallery_assets
WHERE uploaded_by_user_id = $1
  AND product_image_rule_id = $2
  AND deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM gallery_auto_listing_assignments a
    WHERE a.source_asset_id = gallery_assets.id AND a.released_at IS NULL
  )
ORDER BY created_at, id
FOR UPDATE SKIP LOCKED
LIMIT $3;
```

Create the run, apply `allocateRoundRobin`, insert assignments, and return only successfully inserted rows.

- [ ] **Step 4: Implement progress and release guards**

Permit state transitions defined in the spec. Reject release unless status is `reserved`, `batch_id IS NULL`, and no generated mockup/title state exists.

- [ ] **Step 5: Add typed browser client methods**

Add CloudClient signatures and request implementations in `src/lib/cloudApi.ts` for all six endpoints.

- [ ] **Step 6: Verify**

Run: `cd server; npm test; npm run check`
Run: `npm run build:web`
Expected: all commands pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/gallery-auto-listing-routes.ts server/src/routes/gallery-routes.ts server/src/auto-listing-planner.test.ts src/lib/cloudApi.ts
git commit -m "feat: add automatic listing cloud API"
```

### Task 4: Ozon Upload Quota Support

**Files:**
- Modify: `src-tauri/src/core/ozon.rs`
- Modify: `src-tauri/src/core/commands.rs`
- Modify: `src-tauri/src/core/local_assistant.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/api.ts`
- Test: `src/lib/localAssistantCommandParity.test.ts`

**Interfaces:**
- Produces: `OzonSellerClient::product_upload_quota() -> Result<OzonUploadQuota>`, Tauri command `get_shop_upload_quota(shop_id)`, browser helper command of the same name.

- [ ] **Step 1: Write Rust parser tests**

Use a fixture containing:

```json
{
  "daily_create": { "limit": 1500, "usage": 6, "reset_at": "2026-07-29T00:00:00Z" },
  "daily_update": { "limit": 5000, "usage": 12, "reset_at": "2026-07-29T00:00:00Z" },
  "total": { "limit": 252500, "usage": 210 },
  "operation_limits": [{ "operation": "product_import", "limit": 100 }]
}
```

Assert remaining values are 1494, 4988, and 252290 and unknown `operation_limits` content survives serialization.

- [ ] **Step 2: Run Rust test to verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml product_upload_quota`
Expected: FAIL because parser and method do not exist.

- [ ] **Step 3: Implement Ozon request and parser**

Call `request_json("/v4/product/info/limit", json!({}))`. Use saturating subtraction and reject negative or non-numeric required values instead of assuming unlimited quota.

- [ ] **Step 4: Register commands and browser parity**

Add `get_shop_upload_quota` to Tauri `generate_handler!`, local assistant dispatch, and `src/lib/api.ts`.

- [ ] **Step 5: Verify GREEN and parity**

Run: `cargo test --manifest-path src-tauri/Cargo.toml product_upload_quota`
Run: `npm test -- src/lib/localAssistantCommandParity.test.ts`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/core/ozon.rs src-tauri/src/core/commands.rs src-tauri/src/core/local_assistant.rs src-tauri/src/lib.rs src/lib/api.ts src/lib/localAssistantCommandParity.test.ts
git commit -m "feat: query Ozon product upload quotas"
```

### Task 5: Local Scheduler and Recovery

**Files:**
- Create: `src-tauri/src/core/auto_listing_scheduler.rs`
- Modify: `src-tauri/src/core/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/core/commands.rs`
- Modify: `src/lib/api.ts`

**Interfaces:**
- Produces: `AutoListingScheduler::tick`, `scheduler_status`, `run_auto_listing_plan_now`, `pause_auto_listing_plan`.
- Consumes quota command, cloud reserve API, and existing `start_auto_listing` request builder.

- [ ] **Step 1: Add scheduler decision tests**

Test outside-window no-op, date rollover, one active tick per account, quota-unknown shop exclusion, one executing plus one waiting batch, and restart recovery.

- [ ] **Step 2: Verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml auto_listing_scheduler`
Expected: FAIL because scheduler module does not exist.

- [ ] **Step 3: Implement deterministic scheduler core**

Separate pure `decide_next_action(now, status)` from side effects. Store scheduler checkpoints in the existing local SQLite database so restart can resume cloud run IDs and pending progress uploads.

- [ ] **Step 4: Connect existing execution pipeline**

For each reserved batch, load the plan snapshot, render only batch assets, generate only missing titles, create the existing cloud listing batch, then call the existing auto-listing job. Never reserve another executing batch when one is active.

- [ ] **Step 5: Start scheduler from Tauri setup**

Spawn one hidden Tokio loop after app setup. Tick immediately, then every 10 minutes; wake earlier after network recovery or manual run.

- [ ] **Step 6: Verify**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: all Rust tests pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/core/auto_listing_scheduler.rs src-tauri/src/core/mod.rs src-tauri/src/lib.rs src-tauri/src/core/commands.rs src/lib/api.ts
git commit -m "feat: add local automatic listing scheduler"
```

### Task 6: Automatic Listing Plan Wizard

**Files:**
- Create: `src/features/cloud/autoListingUtils.ts`
- Create: `src/features/cloud/AutoListingPlansPage.tsx`
- Create: `src/features/cloud/AutoListingPlansPage.test.tsx`
- Modify: `src/workspace/navigation.ts`
- Modify: `src/workspace/navigation.test.ts`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes CloudClient plan methods and local quota/config checks.
- Produces page key `autoListingPlans` and reusable `validateAutoListingPlanDraft`.

- [ ] **Step 1: Write failing wizard tests**

Test four-step navigation, missing shop template blocking save, batch range 5–20, buffer capped at two batches, and saved plan summary showing product type, mockup, prompt, shops, and window.

- [ ] **Step 2: Verify RED**

Run: `npm test -- src/features/cloud/AutoListingPlansPage.test.tsx`
Expected: FAIL because page does not exist.

- [ ] **Step 3: Implement validation helpers and wizard**

Use the approved four-step layout. Reuse existing product image rules, mockup templates, title prompt templates, shops, product templates, warehouses, and saved listing preferences; do not duplicate their loading logic in `GalleryManager`.

- [ ] **Step 4: Add navigation**

Add “自动上品方案” under the listing/assets workflow and render it from `App.tsx`.

- [ ] **Step 5: Verify GREEN**

Run: `npm test -- src/features/cloud/AutoListingPlansPage.test.tsx src/workspace/navigation.test.ts`
Run: `npm run build`
Expected: tests and build pass.

- [ ] **Step 6: Commit**

```bash
git add src/features/cloud/autoListingUtils.ts src/features/cloud/AutoListingPlansPage.tsx src/features/cloud/AutoListingPlansPage.test.tsx src/workspace/navigation.ts src/workspace/navigation.test.ts src/App.tsx
git commit -m "feat: add automatic listing plan wizard"
```

### Task 7: Batch Task Center and Processing Page Integration

**Files:**
- Create: `src/features/cloud/AutoListingTaskCenter.tsx`
- Create: `src/features/cloud/AutoListingTaskCenter.test.tsx`
- Modify: `src/features/cloud/GalleryManager.tsx`
- Modify: `src/features/cloud/GalleryManager.test.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes cloud run/assignment methods and local scheduler status/actions.
- Produces batch cards with drill-down image details and guarded recovery actions.

- [ ] **Step 1: Write failing task-center tests**

Test summary counts from runs rather than gallery pagination, batch shop allocation, pause/continue, retry-failed-only, release confirmation visibility only for releasable assignments, and quota-error display.

- [ ] **Step 2: Verify RED**

Run: `npm test -- src/features/cloud/AutoListingTaskCenter.test.tsx`
Expected: FAIL because component does not exist.

- [ ] **Step 3: Implement batch-oriented view**

Render stages: waiting, preparing, submitting, completed, failed. Keep existing image cards only inside an expanded batch details region.

- [ ] **Step 4: Integrate with processing page**

Replace the current processing overview/task area with `AutoListingTaskCenter`. Keep manual legacy batches visible as “手动批次” so existing workflows are not lost.

- [ ] **Step 5: Add data-consistency regression tests**

Add a test where gallery total is 15,380 but run processing total is 53; assert every task-center count uses 53/run data and no task label renders 15,380.

- [ ] **Step 6: Verify GREEN**

Run: `npm test -- src/features/cloud/AutoListingTaskCenter.test.tsx src/features/cloud/GalleryManager.test.tsx`
Run: `npm run build:web`
Expected: tests and web build pass.

- [ ] **Step 7: Commit**

```bash
git add src/features/cloud/AutoListingTaskCenter.tsx src/features/cloud/AutoListingTaskCenter.test.tsx src/features/cloud/GalleryManager.tsx src/features/cloud/GalleryManager.test.tsx src/styles.css
git commit -m "feat: add automatic listing batch task center"
```

### Task 8: Full Consistency Verification and Production Rollout

**Files:**
- Create: `server/scripts/auto-listing-consistency-smoke.ts`
- Modify: `server/package.json`
- Modify: `docs/superpowers/specs/2026-07-28-local-auto-listing-design.md` only if implementation reveals a required clarification.

**Interfaces:**
- Produces command `npm run listing:auto:smoke` in `server`.

- [ ] **Step 1: Add smoke script**

The script must create a test plan and candidate assets in a transaction, issue two concurrent reserve requests, assert no duplicate source asset IDs, verify round-robin counts differ by at most one where quotas allow, release only untouched reserved assignments, then roll back.

- [ ] **Step 2: Run all validation**

Run:

```powershell
npm test
npm run build
npm run build:web
Push-Location server
npm test
npm run check
npm run listing:auto:smoke
Pop-Location
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: zero failed tests, successful builds, and smoke output `duplicateAssignments=0`.

- [ ] **Step 3: Manual acceptance test**

Use two enabled local shops and at least 12 disposable test assets:

1. Save one plan with batch size 5 and buffer 10.
2. Mock or use low safe Ozon quota.
3. Trigger “立即执行一次”.
4. Confirm only 10–15 images are reserved, not the full product-type pool.
5. Confirm allocation difference between shops is at most one until a shop reaches quota.
6. Restart the client during preparation and verify the same run resumes.
7. Confirm completed source assets remain assigned and cannot enter another shop.

- [ ] **Step 4: Build and publish client update**

The scheduler and quota command require a new client release. Increment the client version, build the Windows installer, update the updater manifest, and verify the published helper advertises the new commands.

- [ ] **Step 5: Deploy cloud/web changes**

Run the project production deployment skill/script only after the new client update is available. Verify `/health`, the newest hashed web asset, migrations, and one authenticated plan-list request.

- [ ] **Step 6: Commit**

```bash
git add server/scripts/auto-listing-consistency-smoke.ts server/package.json
git commit -m "test: verify automatic listing consistency"
```


