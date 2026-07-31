import { AppError } from "./errors.js";

export interface QueryClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

export interface PlanExecutionSource extends Record<string, unknown> {
  shop_configs: unknown;
}

export interface ReservedAllocation {
  assetId: string;
  externalShopId: string;
  shopSnapshot: unknown;
}

export async function assertEnabledPlanShopsOwned(
  client: QueryClient,
  userId: string,
  externalShopIds: string[],
) {
  const shops = await client.query(
    `SELECT external_shop_id
     FROM shops
     WHERE user_id = $1 AND external_shop_id = ANY($2::text[])`,
    [userId, externalShopIds],
  );
  const ownedShopIds = new Set(shops.rows.map((row) => String(row.external_shop_id)));
  if (externalShopIds.some((externalShopId) => !ownedShopIds.has(externalShopId))) {
    throw new AppError(404, "SHOP_NOT_SYNCED", "启用方案只能使用当前用户已同步的店铺");
  }
}

export async function insertAutoListingRun(
  client: QueryClient,
  input: { userId: string; planId: string; quotaSnapshot: unknown; planSnapshot: unknown },
) {
  const result = await client.query(
    `INSERT INTO gallery_auto_listing_runs (user_id,plan_id,run_date,sequence,status,quota_snapshot,plan_snapshot)
     SELECT $1,$2,CURRENT_DATE,COALESCE(MAX(sequence),0)+1,'waiting',$3::jsonb,$4::jsonb
     FROM gallery_auto_listing_runs WHERE user_id=$1 AND plan_id=$2 AND run_date=CURRENT_DATE RETURNING *`,
    [
      input.userId,
      input.planId,
      JSON.stringify(input.quotaSnapshot),
      JSON.stringify(input.planSnapshot),
    ],
  );
  return result.rows[0];
}

export async function selectAutoListingCandidateIds(
  client: QueryClient,
  input: { userId: string; productImageRuleId: string; limit: number },
) {
  const result = await client.query(
    `SELECT asset.id FROM gallery_assets asset
     WHERE asset.uploaded_by_user_id = $1
       AND asset.product_image_rule_id = $2
       AND asset.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM gallery_mockup_results mockup
         WHERE mockup.user_id = $1 AND mockup.result_asset_id = asset.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM gallery_auto_listing_assignments assignment
         WHERE assignment.source_asset_id = asset.id AND assignment.released_at IS NULL
       )
       AND NOT EXISTS (
         SELECT 1 FROM gallery_usage usage
         WHERE usage.user_id = $1 AND usage.asset_id = asset.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM gallery_listing_batch_assets batch_asset
         WHERE batch_asset.user_id = $1 AND batch_asset.source_asset_id = asset.id
       )
     ORDER BY asset.created_at, asset.id
     FOR UPDATE OF asset SKIP LOCKED
     LIMIT $3`,
    [input.userId, input.productImageRuleId, input.limit],
  );
  return result.rows.map((row) => String(row.id));
}

export async function assertManualAssetsAvailableForListing(
  client: QueryClient,
  userId: string,
  sourceAssetIds: string[],
  autoListingRunId?: string,
) {
  const locked = await client.query(
    `SELECT asset.id
     FROM gallery_assets asset
     WHERE asset.uploaded_by_user_id = $1
       AND asset.id = ANY($2::uuid[])
       AND asset.deleted_at IS NULL
     ORDER BY asset.id
     FOR UPDATE OF asset`,
    [userId, sourceAssetIds],
  );
  if (locked.rowCount !== sourceAssetIds.length) {
    throw new AppError(404, "ASSET_NOT_FOUND", "有原图不存在或不是可上架原图");
  }

  const activeAssignments = await client.query(
    `SELECT assignment.source_asset_id AS "sourceAssetId", assignment.run_id AS "runId"
     FROM gallery_auto_listing_assignments assignment
     WHERE assignment.source_asset_id = ANY($1::uuid[])
       AND assignment.user_id = $2
       AND assignment.released_at IS NULL
     FOR UPDATE OF assignment`,
    [sourceAssetIds, userId],
  );
  if (autoListingRunId) {
    const ownedAssetIds = new Set(
      activeAssignments.rows
        .filter((row) => String(row.runId) === autoListingRunId)
        .map((row) => String(row.sourceAssetId)),
    );
    if (sourceAssetIds.some((assetId) => !ownedAssetIds.has(assetId))) {
      throw new AppError(409, "AUTO_LISTING_ASSIGNMENT_MISMATCH", "自动上架批次包含不属于当前运行的预留原图");
    }
  }
  const conflictingAssignment = activeAssignments.rows.some(
    (row) => !autoListingRunId || String(row.runId) !== autoListingRunId,
  );
  if (conflictingAssignment) {
    throw new AppError(409, "ASSET_RESERVED_FOR_AUTO_LISTING", "有原图已被自动上架任务预留，请先释放后再创建手工批次");
  }
}

export function buildExecutionSnapshots(plan: PlanExecutionSource, externalShopId: string) {
  const planSnapshot = cloneJson({
    id: plan.id,
    name: plan.name,
    productImageRuleId: plan.product_image_rule_id,
    mockupTemplateId: plan.mockup_template_id,
    mockupTemplateName: plan.mockup_template_name,
    titlePromptTemplateId: plan.title_prompt_template_id ?? null,
    titlePromptTemplateName: plan.title_prompt_template_name ?? null,
    titlePrompt: plan.title_prompt,
    shopConfigs: cloneJson(plan.shop_configs),
    startMinute: plan.start_minute,
    endMinute: plan.end_minute,
    batchSize: plan.batch_size,
    bufferSize: plan.buffer_size,
  });
  const shop = (planSnapshot.shopConfigs as Array<Record<string, unknown>>).find((item) => item.externalShopId === externalShopId);
  if (!shop) {
    throw new AppError(409, "AUTO_LISTING_SHOP_CONFIG_MISSING", "Automatic listing shop configuration is missing");
  }
  return {
    plan: planSnapshot,
    shop: cloneJson(shop),
  };
}

export async function insertReservedAssignments(
  client: QueryClient,
  input: {
    userId: string;
    planId: string;
    runId: string;
    planSnapshot: unknown;
    allocations: ReservedAllocation[];
  },
) {
  const insertedRows: Array<Record<string, unknown>> = [];
  for (const allocation of input.allocations) {
    const inserted = await client.query(
      `INSERT INTO gallery_auto_listing_assignments (
         user_id,plan_id,run_id,source_asset_id,external_shop_id,plan_snapshot,shop_snapshot
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)
       ON CONFLICT DO NOTHING RETURNING *`,
      [
        input.userId,
        input.planId,
        input.runId,
        allocation.assetId,
        allocation.externalShopId,
        JSON.stringify(input.planSnapshot),
        JSON.stringify(allocation.shopSnapshot),
      ],
    );
    if (inserted.rows[0]) insertedRows.push(inserted.rows[0]);
  }
  return insertedRows;
}

export async function finalizeEmptyAutoListingRun(
  client: QueryClient,
  runId: string,
  assignmentCount: number,
) {
  if (assignmentCount > 0) return;
  await client.query(
    `UPDATE gallery_auto_listing_runs
     SET status='completed', updated_at=now()
     WHERE id=$1 AND status='waiting'`,
    [runId],
  );
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
