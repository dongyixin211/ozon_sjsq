# 自动上架调度重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with review checkpoints.

**Goal:** 将自动上架改造成按店铺独立配额、可补位、可恢复的调度流程，并修复配置页中文乱码。

**Architecture:** 保留现有数据库 run/assignment 模型，不引入新的消息队列。先抽出纯函数统一店铺额度和分配口径，再把 reserve、release、retry、状态汇总接到服务端路由；前端把自动上架文案和状态计算拆到独立模块，避免继续在巨型组件里维护乱码文本。

**Tech Stack:** TypeScript、Fastify、PostgreSQL、React、Vitest、Node test。

## Global Constraints

- 每个启用店铺默认每日目标为 100，店铺额度以服务端实际返回值为上限。
- 普通图库、临时上架空间、自动上架店铺额度彼此独立。
- 失败必须记录具体原因，不能用静默跳过代替失败状态。
- 每一步先写失败测试，再实现最小改动；不做无关重构。

---

### Task 1: 抽出店铺配额算法

**Files:**
- Modify: `server/src/auto-listing-planner.ts`
- Test: `server/src/auto-listing-planner.test.ts`

**Interfaces:**
- Consumes: `PlannerQuota`, `AllocationShop`, `calculateRemainingShopCapacity`, `allocateRoundRobin`
- Produces: `calculateAvailableReservationSlots(shops, perShopWindow)` and updated tests that keep `allocateRoundRobin` behavior unchanged

- [ ] **Step 1: Write the failing test**

```ts
import { calculateAvailableReservationSlots } from "./auto-listing-planner.js";

test("counts reservation slots per shop instead of as one global window", () => {
  const shops = [
    { externalShopId: "A", capacity: 100, outstanding: 0 },
    { externalShopId: "B", capacity: 100, outstanding: 20 },
  ];
  assert.equal(calculateAvailableReservationSlots(shops, 30), 50);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server; node --import tsx --test src/auto-listing-planner.test.ts`
Expected: FAIL because `calculateAvailableReservationSlots` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

```ts
export function calculateAvailableReservationSlots(shops, perShopWindow) {
  return shops.reduce((total, shop) => total + Math.min(Math.max(0, shop.capacity), Math.max(0, perShopWindow - (shop.outstanding ?? 0))), 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server; node --import tsx --test src/auto-listing-planner.test.ts`
Expected: PASS.

### Task 2: 让 reserve 按店铺补位

**Files:**
- Modify: `server/src/routes/gallery-auto-listing-routes.ts`
- Test: `server/src/routes/gallery-auto-listing-routes.test.ts`
- Test: `server/src/auto-listing-reservation.test.ts`

**Interfaces:**
- Consumes: `calculateRemainingShopCapacity`, `calculateAvailableReservationSlots`, `selectAutoListingCandidateIds`, `insertReservedAssignments`
- Produces: reserve 结果按店铺独立容量计算；缺少店铺 quota 时返回明确业务错误

- [ ] **Step 1: Write the failing test**

```ts
test("reserveBatch uses each shop's remaining window independently", async () => {
  // arrange a plan with two shops and enough remaining quota on both
  // expect more than one small global window worth of assignments
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server; node --import tsx --test src/routes/gallery-auto-listing-routes.test.ts`
Expected: FAIL because the current code still uses one shared reservation limit.

- [ ] **Step 3: Write minimal implementation**

```ts
const targetOutstandingPerShop = Number(plan.batch_size) + Number(plan.buffer_size);
const shops = shopConfigs.map((shop) => ({
  externalShopId: shop.externalShopId,
  capacity: calculateRemainingShopCapacity(...),
  outstanding: outstandingByShop.get(shop.externalShopId) ?? 0,
}));
const reservationLimit = calculateAvailableReservationSlots(shops, targetOutstandingPerShop);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server; node --import tsx --test src/routes/gallery-auto-listing-routes.test.ts`
Expected: PASS.

### Task 3: 抽出自动上架文案和状态计算

**Files:**
- Create: `src/features/cloud/auto-listing/autoListingText.ts`
- Create: `src/features/cloud/auto-listing/autoListingStats.ts`
- Modify: `src/features/cloud/GalleryManager.tsx`
- Test: `src/features/cloud/auto-listing/autoListingStats.test.ts`

**Interfaces:**
- Consumes: `CloudListingBatch`, `CloudListingRun`, `CloudListingAssignment`, `ShopDailyListingStat`
- Produces: `buildAutoListingSummary(...)`, `buildAutoListingDisabledReason(...)`, and centralized Chinese text constants

- [ ] **Step 1: Write the failing test**

```ts
import { buildAutoListingSummary } from "./autoListingStats";

test("summarizes per-shop progress without replacement characters", () => {
  const summary = buildAutoListingSummary(...);
  assert.equal(summary.title, "自动上架");
  assert.equal(summary.errors.some((item) => item.includes("�")), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/features/cloud/auto-listing/autoListingStats.test.ts`
Expected: FAIL because the helper does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
export function buildAutoListingSummary(...) {
  return { ... };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/features/cloud/auto-listing/autoListingStats.test.ts`
Expected: PASS.

### Task 4: 修复配置页乱码并接入新模块

**Files:**
- Modify: `src/features/cloud/GalleryManager.tsx`
- Modify: `src/features/cloud/auto-listing/autoListingText.ts`
- Create: `src/features/cloud/auto-listing/autoListingText.test.ts`

**Interfaces:**
- Consumes: centralized text constants and `buildAutoListingSummary`
- Produces: config page text rendered from UTF-8 source only, no dependency on `.broken-encoding.bak`

- [ ] **Step 1: Write the failing test**

```ts
import { autoListingDisabledReasons } from "./autoListingText";

test("provides readable Chinese text for auto listing", () => {
  assert.equal(autoListingDisabledReasons.noShop, "请先添加要上架的店铺");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/features/cloud/auto-listing/autoListingText.test.ts`
Expected: FAIL because the module is not wired yet.

- [ ] **Step 3: Write minimal implementation**

```ts
export const autoListingDisabledReasons = {
  noShop: "请先添加要上架的店铺",
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/features/cloud/auto-listing/autoListingText.test.ts`
Expected: PASS.

### Task 5: 启动检查与进度可视化

**Files:**
- Modify: `server/src/routes/gallery-auto-listing-routes.ts`
- Modify: `src/features/cloud/GalleryManager.tsx`
- Test: `server/src/routes/gallery-auto-listing-routes.test.ts`
- Test: `src/features/cloud/auto-listing/autoListingStats.test.ts`

**Interfaces:**
- Consumes: plan snapshot, quota snapshot, summary helpers
- Produces: start-time validation results and dashboard fields for target/completed/running/failed/remaining

- [ ] **Step 1: Write the failing test**

```ts
test("start validation reports missing quota and template problems", async () => {
  // assert the API returns a concrete reason instead of silently skipping the shop
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server; node --import tsx --test src/routes/gallery-auto-listing-routes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

```ts
throw new AppError(409, "AUTO_LISTING_SHOP_QUOTA_MISSING", "Shop quota is missing: ...");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server; node --import tsx --test src/routes/gallery-auto-listing-routes.test.ts`
Expected: PASS.

### Task 6: 全量验证并发布

**Files:**
- No new source files.

- [ ] **Step 1: Run the full test/build suite**

Run:
- `npm test`
- `npm run build`
- `npm run build:web`
- `cd server; npm test`
- `cd server; npm run check`
- `cd src-tauri; cargo test --lib`

- [ ] **Step 2: Deploy and verify production**

Run the existing deployment script, then check:
- `https://api.dyxtoolai.cn/health`
- `https://api.dyxtoolai.cn/app/`

Expected: service active, newest web asset referenced, no乱码回归.
