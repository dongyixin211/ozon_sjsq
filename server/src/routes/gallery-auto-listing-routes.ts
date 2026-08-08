import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { requireAuth, requireMembership } from "../auth.js";
import {
  allocateRoundRobin,
  DEFAULT_AUTO_LISTING_DAILY_TARGET,
  assertAssignmentBatchUpdate,
  assertAssignmentStatusTransition,
  calculateAvailableReservationSlots,
  calculateRemainingShopCapacity,
  shouldReleaseFailedAssignment,
  canReleaseAssignment,
  validateAutoListingLaunch,
  validateAutoListingPlan,
} from "../auto-listing-planner.js";
import { pool, withTransaction } from "../db.js";
import { AppError } from "../errors.js";
import {
  assertEnabledPlanShopsOwned,
  buildExecutionSnapshots,
  finalizeEmptyAutoListingRun,
  insertAutoListingRun,
  insertReservedAssignments,
  selectAutoListingCandidateIds,
} from "../auto-listing-reservation.js";

const assignmentStatuses = ["reserved", "preparing", "ready", "submitting", "completed", "failed", "paused", "released"] as const;
const runStatuses = ["waiting", "preparing", "submitting", "completed", "failed", "paused"] as const;

const shopConfigSchema = z.object({
  externalShopId: z.string().trim().min(1).max(120),
  shopName: z.string().trim().min(1).max(200),
  localShopId: z.string().trim().min(1).max(200),
  localTemplateId: z.string().trim().min(1).max(200),
  productTemplateId: z.string().uuid(),
  productTemplateName: z.string().trim().min(1).max(200),
  templateProduct: z.unknown(),
  autoGenerateBarcode: z.boolean(),
  autoUpdateStock: z.boolean(),
  autoAddToAction: z.boolean(),
});

const planBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  productImageRuleId: z.string().uuid(),
  mockupTemplateId: z.string().trim().min(1).max(200),
  mockupTemplateName: z.string().trim().min(1).max(200),
  titlePromptTemplateId: z.string().uuid().nullable().optional(),
  titlePromptTemplateName: z.string().trim().max(200).nullable().optional(),
  titlePrompt: z.string().max(20_000),
  shopConfigs: z.array(shopConfigSchema).max(100),
  startMinute: z.number().int(),
  endMinute: z.number().int(),
  batchSize: z.number().int(),
  bufferSize: z.number().int(),
  enabled: z.boolean(),
});

const quotaSchema = z.object({
  dailyCreateLimit: z.number().int().nonnegative(),
  dailyCreateUsage: z.number().int().nonnegative(),
  dailyCreateRemaining: z.number().int().nonnegative(),
  dailyUpdateLimit: z.number().int().nonnegative(),
  dailyUpdateUsage: z.number().int().nonnegative(),
  dailyUpdateRemaining: z.number().int().nonnegative(),
  totalLimit: z.number().int().nonnegative(),
  totalUsage: z.number().int().nonnegative(),
  totalRemaining: z.number().int().nonnegative(),
  resetAt: z.string().nullable().optional(),
  operationLimits: z.unknown().optional(),
  fetchedAt: z.string().min(1),
});

const reserveBodySchema = z.object({
  planId: z.string().uuid(),
  quotaByExternalShopId: z.record(quotaSchema),
});

const assignmentUpdateSchema = z.object({
  assignmentId: z.string().uuid(),
  status: z.enum(assignmentStatuses),
  batchId: z.string().uuid().nullable().optional(),
  retryCount: z.number().int().nonnegative().optional(),
  lastError: z.string().max(10_000).nullable().optional(),
});

const updateAssignmentsBodySchema = z.object({
  updates: z.array(assignmentUpdateSchema).min(1).max(200),
});

const releaseAssignmentsBodySchema = z.object({
  assignmentIds: z.array(z.string().uuid()).min(1).max(200).refine(
    (ids) => new Set(ids).size === ids.length,
    "Duplicate assignment ID",
  ),
});

const runsQuerySchema = z.object({
  planId: z.string().uuid().optional(),
  status: z.enum(runStatuses).optional(),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  compact: z.coerce.boolean().default(false),
});

export async function galleryAutoListingRoutes(app: FastifyInstance) {
  app.get("/gallery/auto-listing/plans", { preHandler: [requireAuth, requireMembership] }, async (request) => {
    const result = await pool.query(`${planSelectSql} WHERE plan.user_id = $1 ORDER BY plan.updated_at DESC`, [request.currentUser!.id]);
    return { ok: true, plans: result.rows.map(mapPlanRow) };
  });

  app.post("/gallery/auto-listing/plans", { preHandler: [requireAuth, requireMembership] }, async (request) => {
    const plan = await savePlan(request.currentUser!.id, null, planBodySchema.parse(request.body));
    return { ok: true, plan };
  });

  app.put("/gallery/auto-listing/plans/:planId", { preHandler: [requireAuth, requireMembership] }, async (request) => {
    const { planId } = z.object({ planId: z.string().uuid() }).parse(request.params);
    const plan = await savePlan(request.currentUser!.id, planId, planBodySchema.parse(request.body));
    return { ok: true, plan };
  });

  app.delete("/gallery/auto-listing/plans/:planId", { preHandler: [requireAuth, requireMembership] }, async (request) => {
    const { planId } = z.object({ planId: z.string().uuid() }).parse(request.params);
    const result = await pool.query(
      `DELETE FROM gallery_auto_listing_plans plan
       WHERE plan.id = $1 AND plan.user_id = $2
         AND NOT EXISTS (SELECT 1 FROM gallery_auto_listing_runs run WHERE run.plan_id = plan.id)
       RETURNING id`,
      [planId, request.currentUser!.id],
    );
    if (!result.rowCount) {
      const exists = await pool.query("SELECT 1 FROM gallery_auto_listing_plans WHERE id = $1 AND user_id = $2", [planId, request.currentUser!.id]);
      if (exists.rowCount) throw new AppError(409, "AUTO_LISTING_PLAN_HAS_RUNS", "Plans with runs cannot be deleted; disable the plan instead");
      throw new AppError(404, "AUTO_LISTING_PLAN_NOT_FOUND", "Automatic listing plan not found");
    }
    return { ok: true, deletedPlanId: planId };
  });

  app.post("/gallery/auto-listing/reservations", { preHandler: [requireAuth, requireMembership] }, async (request) => {
    return { ok: true, ...await reserveBatch(request.currentUser!.id, reserveBodySchema.parse(request.body)) };
  });

  app.post("/gallery/auto-listing/assignments/progress", { preHandler: [requireAuth, requireMembership] }, async (request) => {
    const body = updateAssignmentsBodySchema.parse(request.body);
    return { ok: true, assignments: await updateAssignments(request.currentUser!.id, body.updates) };
  });

  app.post("/gallery/auto-listing/assignments/release", { preHandler: [requireAuth, requireMembership] }, async (request) => {
    const body = releaseAssignmentsBodySchema.parse(request.body);
    return { ok: true, assignments: await releaseAssignments(request.currentUser!.id, body.assignmentIds) };
  });

  app.get("/gallery/auto-listing/runs", { preHandler: [requireAuth, requireMembership] }, async (request) => {
    const query = runsQuerySchema.parse(request.query);
    const values: unknown[] = [request.currentUser!.id];
    const where = ["run.user_id = $1"];
    if (query.planId) { values.push(query.planId); where.push(`run.plan_id = $${values.length}`); }
    if (query.status) { values.push(query.status); where.push(`run.status = $${values.length}`); }
    if (query.dateFrom) { values.push(query.dateFrom); where.push(`run.run_date >= $${values.length}::date`); }
    if (query.dateTo) { values.push(query.dateTo); where.push(`run.run_date <= $${values.length}::date`); }
    values.push(query.limit);
    const runsResult = await pool.query(
      `${runSelectSql} WHERE ${where.join(" AND ")} ORDER BY run.run_date DESC, run.sequence DESC LIMIT $${values.length}`,
      values,
    );
    const runIds = runsResult.rows.map((row) => String(row.id));
    const assignmentRows = runIds.length
      ? (await pool.query(
        `${assignmentSelectSql} WHERE assignment.user_id = $1 AND assignment.run_id = ANY($2::uuid[]) ORDER BY assignment.created_at, assignment.id`,
        [request.currentUser!.id, runIds],
      )).rows
      : [];
    const assignmentsByRun = new Map<string, unknown[]>();
    for (const row of assignmentRows) {
      const items = assignmentsByRun.get(String(row.runId)) ?? [];
      items.push(query.compact ? mapCompactAssignmentRow(row) : mapAssignmentRow(row));
      assignmentsByRun.set(String(row.runId), items);
    }
    return {
      ok: true,
      runs: runsResult.rows.map((row) => ({ ...mapRunRow(row), assignments: assignmentsByRun.get(String(row.id)) ?? [] })),
    };
  });
}

async function savePlan(userId: string, planId: string | null, body: z.infer<typeof planBodySchema>) {
  return withTransaction(async (client) => {
    if (planId) {
      const locked = await client.query("SELECT 1 FROM gallery_auto_listing_plans WHERE id = $1 AND user_id = $2 FOR UPDATE", [planId, userId]);
      if (!locked.rowCount) throw new AppError(404, "AUTO_LISTING_PLAN_NOT_FOUND", "Automatic listing plan not found");
    }
    if (body.enabled) {
      await assertEnabledPlanShopsOwned(client, userId, body.shopConfigs.map((shop) => shop.externalShopId));
    }

    const conflict = body.enabled
      ? await client.query(
        `SELECT 1 FROM gallery_auto_listing_plans
         WHERE user_id = $1 AND product_image_rule_id = $2 AND enabled
           AND ($3::uuid IS NULL OR id <> $3::uuid) LIMIT 1`,
        [userId, body.productImageRuleId, planId],
      )
      : { rowCount: 0 };
    try {
      validateAutoListingPlan({
        startMinute: body.startMinute,
        endMinute: body.endMinute,
        batchSize: body.batchSize,
        bufferSize: body.bufferSize,
        enabled: body.enabled,
        externalShopIds: body.shopConfigs.map((shop) => shop.externalShopId),
      }, Boolean(conflict.rowCount));
    } catch (error) {
      throw new AppError(400, "AUTO_LISTING_PLAN_INVALID", error instanceof Error ? error.message : String(error));
    }
    try {
      const values = planValues(userId, body);
      const result = planId
        ? await client.query(
          `UPDATE gallery_auto_listing_plans SET name=$3, product_image_rule_id=$4, mockup_template_id=$5,
             mockup_template_name=$6, title_prompt_template_id=$7, title_prompt_template_name=$8,
             title_prompt=$9, shop_configs=$10::jsonb, start_minute=$11, end_minute=$12,
             batch_size=$13, buffer_size=$14, enabled=$15, updated_at=now()
           WHERE id=$1 AND user_id=$2 RETURNING *`,
          [planId, ...values],
        )
        : await client.query(
          `INSERT INTO gallery_auto_listing_plans (
             user_id,name,product_image_rule_id,mockup_template_id,mockup_template_name,
             title_prompt_template_id,title_prompt_template_name,title_prompt,shop_configs,
             start_minute,end_minute,batch_size,buffer_size,enabled
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14) RETURNING *`,
          values,
        );
      return mapPlanRow(result.rows[0]);
    } catch (error) {
      if (isPgError(error, "23505")) throw new AppError(409, "AUTO_LISTING_PLAN_ENABLED_CONFLICT", "An enabled plan already exists for this product rule");
      throw error;
    }
  });
}

function planValues(userId: string, body: z.infer<typeof planBodySchema>) {
  return [userId, body.name, body.productImageRuleId, body.mockupTemplateId, body.mockupTemplateName,
    body.titlePromptTemplateId ?? null, body.titlePromptTemplateName ?? null, body.titlePrompt,
    JSON.stringify(body.shopConfigs), body.startMinute, body.endMinute, body.batchSize, body.bufferSize, body.enabled];
}

async function reserveBatch(userId: string, body: z.infer<typeof reserveBodySchema>) {
  return withTransaction(async (client) => {
    const planResult = await client.query("SELECT * FROM gallery_auto_listing_plans WHERE id=$1 AND user_id=$2 FOR UPDATE", [body.planId, userId]);
    const plan = planResult.rows[0];
    if (!plan) throw new AppError(404, "AUTO_LISTING_PLAN_NOT_FOUND", "Automatic listing plan not found");
    if (!plan.enabled) throw new AppError(409, "AUTO_LISTING_PLAN_DISABLED", "Automatic listing plan is disabled");

    const shopConfigs = shopConfigSchema.array().parse(plan.shop_configs);
    await assertEnabledPlanShopsOwned(client, userId, shopConfigs.map((shop) => shop.externalShopId));
    const launchCheck = validateAutoListingLaunch(shopConfigs, body.quotaByExternalShopId);
    if (!launchCheck.ok) {
      const firstIssue = launchCheck.issues[0];
      throw new AppError(
        409,
        "AUTO_LISTING_PREFLIGHT_FAILED",
        firstIssue.reason === "quota_missing"
          ? "Shop quota is missing: " + firstIssue.shopName
          : "Shop quota is invalid: " + firstIssue.shopName,
      );
    }
    const outstandingRows = (await client.query(
      `SELECT external_shop_id AS "externalShopId", count(*)::int AS count
       FROM gallery_auto_listing_assignments
       WHERE user_id=$1 AND plan_id=$2 AND released_at IS NULL AND status IN ('reserved','preparing','ready','submitting','paused')
       GROUP BY external_shop_id`,
      [userId, body.planId],
    )).rows;
    const outstandingByShop = new Map(outstandingRows.map((row) => [String(row.externalShopId), Number(row.count)]));
    const completedRows = (await client.query(
      `SELECT external_shop_id AS "externalShopId", count(*)::int AS count
       FROM gallery_auto_listing_assignments
       WHERE user_id=$1 AND plan_id=$2 AND status='completed' AND updated_at::date=CURRENT_DATE
       GROUP BY external_shop_id`,
      [userId, body.planId],
    )).rows;
    const completedTodayByShop = new Map(completedRows.map((row) => [String(row.externalShopId), Number(row.count)]));
    const targetOutstandingPerShop = Number(plan.batch_size) + Number(plan.buffer_size);
    const shops = shopConfigs.map((shop) => {
      const quota = body.quotaByExternalShopId[shop.externalShopId];
      if (!quota) {
        throw new AppError(409, "AUTO_LISTING_SHOP_QUOTA_MISSING", "Shop quota is missing: " + shop.shopName);
      }
      const capacity = calculateRemainingShopCapacity(
        { createRemaining: quota.dailyCreateRemaining, totalRemaining: quota.totalRemaining },
        DEFAULT_AUTO_LISTING_DAILY_TARGET,
        completedTodayByShop.get(shop.externalShopId) ?? 0,
        outstandingByShop.get(shop.externalShopId) ?? 0,
        targetOutstandingPerShop,
      );
      return { externalShopId: shop.externalShopId, capacity, outstanding: outstandingByShop.get(shop.externalShopId) ?? 0 };
    });
    const reservationLimit = calculateAvailableReservationSlots(shops, targetOutstandingPerShop);
    const candidates = reservationLimit
      ? await selectAutoListingCandidateIds(client, {
        userId,
        productImageRuleId: String(plan.product_image_rule_id),
        limit: reservationLimit,
      })
      : [];

    const firstShopId = shopConfigs[0]?.externalShopId;
    if (!firstShopId) throw new AppError(409, "AUTO_LISTING_SHOP_CONFIG_MISSING", "Automatic listing shop configuration is missing");
    const planSnapshot = buildExecutionSnapshots(plan, firstShopId).plan;
    const snapshotsByShop = new Map(shopConfigs.map((shop) => [
      shop.externalShopId, buildExecutionSnapshots(plan, shop.externalShopId).shop,
    ]));
    const run = await createRun(client, userId, String(plan.id), body.quotaByExternalShopId, planSnapshot);
    const assignments = await insertReservedAssignments(client, {
      userId,
      planId: body.planId,
      runId: run.id,
      planSnapshot,
      allocations: allocateRoundRobin(shops, candidates).map((allocation) => ({
        ...allocation,
        shopSnapshot: snapshotsByShop.get(allocation.externalShopId) ?? {},
      })),
    });
    await finalizeEmptyAutoListingRun(client, run.id, assignments.length);
    return { run, assignments: assignments.map(mapAssignmentRow) };
  });
}

async function createRun(client: PoolClient, userId: string, planId: string, quotaSnapshot: unknown, planSnapshot: unknown) {
  return mapRunRow(await insertAutoListingRun(client, { userId, planId, quotaSnapshot, planSnapshot }));
}

async function updateAssignments(userId: string, updates: Array<z.infer<typeof assignmentUpdateSchema>>) {
  return withTransaction(async (client) => {
    const ids = updates.map((update) => update.assignmentId);
    if (new Set(ids).size !== ids.length) throw new AppError(400, "AUTO_LISTING_ASSIGNMENT_INVALID", "Duplicate assignment ID");
    const existing = await client.query(`${assignmentSelectSql} WHERE assignment.user_id=$1 AND assignment.id=ANY($2::uuid[]) FOR UPDATE OF assignment`, [userId, ids]);
    if (existing.rowCount !== ids.length) throw new AppError(404, "AUTO_LISTING_ASSIGNMENT_NOT_FOUND", "Automatic listing assignment not found");
    const existingById = new Map(existing.rows.map((row) => [String(row.id), row]));
    const runIds = new Set<string>();
    const assignments = [];
    for (const update of updates) {
      const current = existingById.get(update.assignmentId)!;
      try { assertAssignmentStatusTransition(current.status, update.status); }
      catch (error) { throw new AppError(409, "AUTO_LISTING_ASSIGNMENT_TRANSITION_INVALID", error instanceof Error ? error.message : String(error)); }
      if (update.batchId !== undefined) {
        try { assertAssignmentBatchUpdate(current.batchId, update.batchId); }
        catch (error) { throw new AppError(409, "AUTO_LISTING_ASSIGNMENT_BATCH_INVALID", error instanceof Error ? error.message : String(error)); }
      }
      if (update.batchId) {
        const batch = await client.query("SELECT 1 FROM gallery_listing_batches WHERE id=$1 AND user_id=$2", [update.batchId, userId]);
        if (!batch.rowCount) throw new AppError(404, "LISTING_BATCH_NOT_FOUND", "Listing batch not found");
      }
      const result = await client.query(
        `UPDATE gallery_auto_listing_assignments SET status=$3,
           batch_id=CASE WHEN $4::boolean THEN $5::uuid ELSE batch_id END,
           retry_count=COALESCE($6,retry_count),
           last_error=CASE WHEN $7::boolean THEN $8 ELSE last_error END,
           released_at=CASE WHEN $9::boolean THEN COALESCE(released_at, now()) ELSE released_at END,
           updated_at=now()
         WHERE id=$1 AND user_id=$2 RETURNING *`,
        [update.assignmentId, userId, update.status, update.batchId !== undefined, update.batchId ?? null,
          update.retryCount ?? null, update.lastError !== undefined, update.lastError ?? null,
          shouldReleaseFailedAssignment(update.status, update.retryCount ?? Number(current.retryCount ?? 0))],
      );
      assignments.push(mapAssignmentRow(result.rows[0]));
      runIds.add(String(current.runId));
    }
    for (const runId of runIds) await refreshRunStatus(client, userId, runId);
    return assignments;
  });
}

async function releaseAssignments(userId: string, assignmentIds: string[]) {
  return withTransaction(async (client) => {
    const result = await client.query(
      `SELECT assignment.id, assignment.run_id AS "runId", assignment.status,
         assignment.batch_id AS "batchId",
         (asset.generated_title IS NOT NULL OR EXISTS (
           SELECT 1 FROM gallery_mockup_results mockup
           WHERE mockup.user_id=assignment.user_id AND mockup.source_asset_id=assignment.source_asset_id
         )) AS "hasGeneratedWork"
       FROM gallery_auto_listing_assignments assignment
       JOIN gallery_assets asset ON asset.id=assignment.source_asset_id
       WHERE assignment.user_id=$1 AND assignment.id=ANY($2::uuid[]) FOR UPDATE OF assignment`,
      [userId, assignmentIds],
    );
    if (result.rowCount !== assignmentIds.length) throw new AppError(404, "AUTO_LISTING_ASSIGNMENT_NOT_FOUND", "Automatic listing assignment not found");
    for (const row of result.rows) {
      if (!canReleaseAssignment({ status: row.status, batchId: row.batchId, hasGeneratedWork: Boolean(row.hasGeneratedWork) })) {
        throw new AppError(409, "AUTO_LISTING_ASSIGNMENT_NOT_RELEASABLE", "Only untouched reserved assignments can be released");
      }
    }
    const released = await client.query(
      `UPDATE gallery_auto_listing_assignments SET status='released',released_at=now(),updated_at=now()
       WHERE user_id=$1 AND id=ANY($2::uuid[]) RETURNING *`,
      [userId, assignmentIds],
    );
    for (const runId of new Set(result.rows.map((row) => String(row.runId)))) await refreshRunStatus(client, userId, runId);
    return released.rows.map(mapAssignmentRow);
  });
}

async function refreshRunStatus(client: PoolClient, userId: string, runId: string) {
  await client.query(
    `UPDATE gallery_auto_listing_runs run SET status=summary.status,updated_at=now()
     FROM (SELECT CASE
       WHEN count(*) FILTER (WHERE status <> 'released')=0 THEN 'completed'
       WHEN bool_and(status IN ('completed','released')) THEN 'completed'
       WHEN bool_or(status='submitting') THEN 'submitting'
       WHEN bool_or(status IN ('preparing','ready')) THEN 'preparing'
       WHEN bool_or(status='reserved') THEN 'waiting'
       WHEN bool_or(status='failed') THEN 'failed'
       ELSE 'paused' END AS status
       FROM gallery_auto_listing_assignments WHERE user_id=$1 AND run_id=$2) summary
     WHERE run.id=$2 AND run.user_id=$1`,
    [userId, runId],
  );
}

const planSelectSql = `SELECT plan.id,plan.name,plan.product_image_rule_id AS "productImageRuleId",
  plan.mockup_template_id AS "mockupTemplateId",plan.mockup_template_name AS "mockupTemplateName",
  plan.title_prompt_template_id AS "titlePromptTemplateId",plan.title_prompt_template_name AS "titlePromptTemplateName",
  plan.title_prompt AS "titlePrompt",plan.shop_configs AS "shopConfigs",plan.start_minute AS "startMinute",
  plan.end_minute AS "endMinute",plan.batch_size AS "batchSize",plan.buffer_size AS "bufferSize",
  plan.enabled,plan.created_at AS "createdAt",plan.updated_at AS "updatedAt" FROM gallery_auto_listing_plans plan`;

const runSelectSql = `SELECT run.id,run.plan_id AS "planId",run.run_date AS "runDate",run.sequence,run.status,
  run.quota_snapshot AS "quotaSnapshot",run.plan_snapshot AS "planSnapshot",run.created_at AS "createdAt",run.updated_at AS "updatedAt"
  FROM gallery_auto_listing_runs run`;

const assignmentSelectSql = `SELECT assignment.id,assignment.plan_id AS "planId",assignment.run_id AS "runId",
  assignment.source_asset_id AS "sourceAssetId",assignment.external_shop_id AS "externalShopId",
  assignment.plan_snapshot AS "planSnapshot",assignment.shop_snapshot AS "shopSnapshot",assignment.batch_id AS "batchId",assignment.status,assignment.retry_count AS "retryCount",
  assignment.last_error AS "lastError",assignment.released_at AS "releasedAt",
  assignment.created_at AS "createdAt",assignment.updated_at AS "updatedAt"
  FROM gallery_auto_listing_assignments assignment`;

function mapPlanRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    name: String(row.name),
    productImageRuleId: String(valueOf(row, "productImageRuleId", "product_image_rule_id")),
    mockupTemplateId: String(valueOf(row, "mockupTemplateId", "mockup_template_id")),
    mockupTemplateName: String(valueOf(row, "mockupTemplateName", "mockup_template_name")),
    titlePromptTemplateId: nullableString(valueOf(row, "titlePromptTemplateId", "title_prompt_template_id")),
    titlePromptTemplateName: nullableString(valueOf(row, "titlePromptTemplateName", "title_prompt_template_name")),
    titlePrompt: String(valueOf(row, "titlePrompt", "title_prompt")),
    shopConfigs: valueOf(row, "shopConfigs", "shop_configs"),
    startMinute: Number(valueOf(row, "startMinute", "start_minute")),
    endMinute: Number(valueOf(row, "endMinute", "end_minute")),
    batchSize: Number(valueOf(row, "batchSize", "batch_size")),
    bufferSize: Number(valueOf(row, "bufferSize", "buffer_size")),
    enabled: Boolean(row.enabled),
    createdAt: toIsoString(valueOf(row, "createdAt", "created_at")),
    updatedAt: toIsoString(valueOf(row, "updatedAt", "updated_at")),
  };
}
function mapRunRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    planId: String(valueOf(row, "planId", "plan_id")),
    runDate: toDateString(valueOf(row, "runDate", "run_date")),
    sequence: Number(row.sequence),
    status: String(row.status),
    quotaSnapshot: valueOf(row, "quotaSnapshot", "quota_snapshot"),
    planSnapshot: valueOf(row, "planSnapshot", "plan_snapshot"),
    createdAt: toIsoString(valueOf(row, "createdAt", "created_at")),
    updatedAt: toIsoString(valueOf(row, "updatedAt", "updated_at")),
  };
}
export function mapCompactAssignmentRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    sourceAssetId: String(valueOf(row, "sourceAssetId", "source_asset_id")),
    externalShopId: String(valueOf(row, "externalShopId", "external_shop_id")),
    batchId: nullableString(valueOf(row, "batchId", "batch_id")),
    status: String(row.status),
  };
}

function mapAssignmentRow(row: Record<string, unknown>) {
  const releasedAt = valueOf(row, "releasedAt", "released_at");
  return {
    id: String(row.id),
    planId: String(valueOf(row, "planId", "plan_id")),
    runId: String(valueOf(row, "runId", "run_id")),
    sourceAssetId: String(valueOf(row, "sourceAssetId", "source_asset_id")),
    externalShopId: String(valueOf(row, "externalShopId", "external_shop_id")),
    planSnapshot: valueOf(row, "planSnapshot", "plan_snapshot"),
    shopSnapshot: valueOf(row, "shopSnapshot", "shop_snapshot"),
    batchId: nullableString(valueOf(row, "batchId", "batch_id")),
    status: String(row.status),
    retryCount: Number(valueOf(row, "retryCount", "retry_count")),
    lastError: nullableString(valueOf(row, "lastError", "last_error")),
    releasedAt: releasedAt ? toIsoString(releasedAt) : null,
    createdAt: toIsoString(valueOf(row, "createdAt", "created_at")),
    updatedAt: toIsoString(valueOf(row, "updatedAt", "updated_at")),
  };
}
function valueOf(row: Record<string, unknown>, camel: string, snake: string) { return row[camel] ?? row[snake]; }
function nullableString(value: unknown) { return value === null || value === undefined ? null : String(value); }
function toIsoString(value: unknown) { return value instanceof Date ? value.toISOString() : String(value); }
function toDateString(value: unknown) { return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10); }
function isPgError(error: unknown, code: string) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}




