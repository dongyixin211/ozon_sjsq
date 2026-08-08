import test from "node:test";
import assert from "node:assert/strict";
import {
  assertEnabledPlanShopsOwned,
  assertManualAssetsAvailableForListing,
  buildExecutionSnapshots,
  finalizeEmptyAutoListingRun,
  filterOccupiedAutoListingSelections,
  insertAutoListingRun,
  insertReservedAssignments,
  selectAutoListingCandidateIds,
} from "./auto-listing-reservation.js";

test("automatic listing filters source assets occupied by the same shop", () => {
  const result = filterOccupiedAutoListingSelections(
    [
      { sourceAssetId: "asset-used", externalShopId: "shop-a" },
      { sourceAssetId: "asset-new", externalShopId: "shop-a" },
      { sourceAssetId: "asset-used", externalShopId: "shop-b" },
    ],
    new Set(["asset-used:shop-a"]),
  );

  assert.deepEqual(result.occupied, [{ sourceAssetId: "asset-used", externalShopId: "shop-a" }]);
  assert.deepEqual(result.available, [
    { sourceAssetId: "asset-new", externalShopId: "shop-a" },
    { sourceAssetId: "asset-used", externalShopId: "shop-b" },
  ]);
});

test("automatic listing candidates exclude previous mockup result assets", async () => {
  let queryText = "";
  let queryValues: unknown[] = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      queryText = sql;
      queryValues = values;
      return { rowCount: 1, rows: [{ id: "asset-original" }] };
    },
  };

  const assetIds = await selectAutoListingCandidateIds(client, {
    userId: "user-a",
    productImageRuleId: "rule-a",
    limit: 30,
  });

  assert.deepEqual(assetIds, ["asset-original"]);
  assert.match(queryText, /gallery_mockup_results/i);
  assert.match(queryText, /result_asset_id\s*=\s*asset\.id/i);
  assert.deepEqual(queryValues, ["user-a", "rule-a", 30]);
});

test("manual listing rejects a source asset with an active automatic assignment", async () => {
  const queries: string[] = [];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("FROM gallery_assets")) {
        return { rowCount: 1, rows: [{ id: "asset-a" }] };
      }
      return { rowCount: 1, rows: [{ sourceAssetId: "asset-a", runId: "run-other" }] };
    },
  };

  await assert.rejects(
    () => assertManualAssetsAvailableForListing(client, "user-a", ["asset-a"]),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ASSET_RESERVED_FOR_AUTO_LISTING"
    ),
  );
  assert.match(queries[0], /FOR UPDATE OF asset/i);
  assert.match(queries[1], /released_at IS NULL/i);
  assert.match(queries[1], /FOR UPDATE OF assignment/i);
  assert.doesNotMatch(queries[1], /LIMIT 1/i);
});

test("automatic listing may create a batch for its own reserved source assets", async () => {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const runId = "11111111-1111-4111-8111-111111111111";
  const client = {
    async query(sql: string, values: unknown[] = []) {
      queries.push({ sql, values });
      if (sql.includes("FROM gallery_assets")) {
        return { rowCount: 1, rows: [{ id: "asset-a" }] };
      }
      return { rowCount: 1, rows: [{ sourceAssetId: "asset-a", runId }] };
    },
  };

  await assert.doesNotReject(
    () => assertManualAssetsAvailableForListing(client, "user-a", ["asset-a"], runId),
  );
  assert.match(queries[1].sql, /assignment\.user_id = \$2/i);
  assert.match(queries[1].sql, /assignment\.run_id AS "runId"/i);
  assert.deepEqual(queries[1].values, [["asset-a"], "user-a"]);
});

test("automatic listing rejects assets not reserved by the provided run", async () => {
  const client = {
    async query(sql: string) {
      if (sql.includes("FROM gallery_assets")) {
        return { rowCount: 1, rows: [{ id: "asset-a" }] };
      }
      return { rowCount: 0, rows: [] };
    },
  };

  await assert.rejects(
    () => assertManualAssetsAvailableForListing(
      client,
      "user-a",
      ["asset-a"],
      "11111111-1111-4111-8111-111111111111",
    ),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "AUTO_LISTING_ASSIGNMENT_MISMATCH"
    ),
  );
});

test("execution snapshots stay unchanged after the editable plan changes", () => {
  const plan = {
    id: "plan-a",
    name: "Plan A",
    product_image_rule_id: "rule-a",
    mockup_template_id: "mockup-a",
    mockup_template_name: "Mockup A",
    title_prompt_template_id: "title-template-a",
    title_prompt_template_name: "Title A",
    title_prompt: "Original prompt",
    shop_configs: [{
      externalShopId: "shop-a",
      shopName: "Shop A",
      localShopId: "local-a",
      localTemplateId: "local-template-a",
      productTemplateId: "11111111-1111-4111-8111-111111111111",
      productTemplateName: "Product A",
      templateProduct: { offerId: "offer-a" },
      autoGenerateBarcode: true,
      autoUpdateStock: false,
      autoAddToAction: true,
    }],
    start_minute: 480,
    end_minute: 1320,
    batch_size: 10,
    buffer_size: 20,
  };

  const snapshots = buildExecutionSnapshots(plan, "shop-a");
  plan.title_prompt = "Edited prompt";
  plan.shop_configs[0].productTemplateName = "Edited product";
  (plan.shop_configs[0].templateProduct as { offerId: string }).offerId = "edited-offer";

  const planSnapshot = snapshots.plan as { shopConfigs: Array<{ productTemplateName: string }> };
  assert.equal(snapshots.plan.titlePrompt, "Original prompt");
  assert.equal(planSnapshot.shopConfigs[0].productTemplateName, "Product A");
  assert.equal(snapshots.shop.productTemplateName, "Product A");
  assert.deepEqual(snapshots.shop.templateProduct, { offerId: "offer-a" });
});

test("concurrent uniqueness conflicts return only successfully inserted assignments", async () => {
  let insertCount = 0;
  const queryValues: unknown[][] = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      queryValues.push(values);
      insertCount += 1;
      return insertCount === 1
        ? { rowCount: 1, rows: [{ id: "assignment-a", source_asset_id: "asset-a" }] }
        : { rowCount: 0, rows: [] };
    },
  };

  const inserted = await insertReservedAssignments(client, {
    userId: "user-a",
    planId: "plan-a",
    runId: "run-a",
    planSnapshot: { name: "Plan A" },
    allocations: [
      { assetId: "asset-a", externalShopId: "shop-a", shopSnapshot: { shopName: "Shop A" } },
      { assetId: "asset-b", externalShopId: "shop-b", shopSnapshot: { shopName: "Shop B" } },
    ],
  });

  assert.deepEqual(inserted, [{ id: "assignment-a", source_asset_id: "asset-a" }]);
  assert.equal(queryValues[0][5], JSON.stringify({ name: "Plan A" }));
  assert.equal(queryValues[0][6], JSON.stringify({ shopName: "Shop A" }));
});


test("enabled plans reject shops outside the current user", async () => {
  const client = {
    async query() {
      return { rowCount: 1, rows: [{ external_shop_id: "shop-a" }] };
    },
  };

  await assert.rejects(
    () => assertEnabledPlanShopsOwned(client, "user-a", ["shop-a", "shop-b"]),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "SHOP_NOT_SYNCED"
    ),
  );
});

test("run insertion persists the immutable plan snapshot", async () => {
  let queryText = "";
  let queryValues: unknown[] = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      queryText = sql;
      queryValues = values;
      return { rowCount: 1, rows: [{ id: "run-a", plan_snapshot: { name: "Plan A" } }] };
    },
  };

  const row = await insertAutoListingRun(client, {
    userId: "user-a",
    planId: "plan-a",
    quotaSnapshot: { "shop-a": { dailyCreateRemaining: 10 } },
    planSnapshot: { name: "Plan A" },
  });

  assert.equal(row.id, "run-a");
  assert.match(queryText, /plan_snapshot/i);
  assert.equal(queryValues[3], JSON.stringify({ name: "Plan A" }));
});

test("empty automatic listing runs are completed instead of blocking later scheduler ticks", async () => {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      queries.push({ sql, values });
      return { rowCount: 1, rows: [] };
    },
  };

  await finalizeEmptyAutoListingRun(client, "run-empty", 0);
  await finalizeEmptyAutoListingRun(client, "run-with-assignments", 2);

  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /status='completed'/i);
  assert.deepEqual(queries[0].values, ["run-empty"]);
});
