import assert from "node:assert/strict";
import test from "node:test";
import { mapCompactAssignmentRow } from "./gallery-auto-listing-routes.js";

test("compact automatic listing assignment excludes execution snapshots", () => {
  const assignment = mapCompactAssignmentRow({
    id: "assignment-a",
    plan_id: "plan-a",
    run_id: "run-a",
    source_asset_id: "asset-a",
    external_shop_id: "shop-a",
    plan_snapshot: { veryLarge: true },
    shop_snapshot: { veryLarge: true },
    batch_id: "batch-a",
    status: "submitting",
    retry_count: 0,
    last_error: null,
    released_at: null,
    created_at: "2026-07-29T00:00:00.000Z",
    updated_at: "2026-07-29T00:00:00.000Z",
  });

  assert.deepEqual(assignment, {
    id: "assignment-a",
    sourceAssetId: "asset-a",
    externalShopId: "shop-a",
    batchId: "batch-a",
    status: "submitting",
  });
});
