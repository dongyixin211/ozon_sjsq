# Task 2 Brief

Global constraints are inherited from the implementation plan.

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

