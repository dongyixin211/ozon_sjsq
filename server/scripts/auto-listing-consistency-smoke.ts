import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { canReleaseAssignment } from "../src/auto-listing-planner.js";
import { pool, withTransaction } from "../src/db.js";
import { isTransientDatabaseError, sendError } from "../src/errors.js";
import { galleryAutoListingRoutes } from "../src/routes/gallery-auto-listing-routes.js";
import { createAuthToken, newId, sha256Hex } from "../src/security.js";

type SmokeState = {
  userId: string;
  token: string;
  planId: string;
  externalShopIds: string[];
  assetIds: string[];
  touchedAssignmentId: string;
};

type ProductImageRuleRow = {
  id: string;
  product_type: string;
  aspect_ratio: string;
  ratio_width: number;
  ratio_height: number;
};

type ReserveAssignment = {
  id: string;
  runId: string;
  sourceAssetId: string;
  externalShopId: string;
  status: string;
  releasedAt: string | null;
};

type ReserveResponse = {
  ok: true;
  run: { id: string };
  assignments: ReserveAssignment[];
};

type RunsResponse = {
  ok: true;
  runs: Array<{
    id: string;
    assignments: Array<{
      id: string;
      sourceAssetId: string;
      externalShopId: string;
      status: string;
      releasedAt: string | null;
    }>;
  }>;
};

type ReserveBody = {
  planId: string;
  quotaByExternalShopId: Record<string, {
    dailyCreateLimit: number;
    dailyCreateUsage: number;
    dailyCreateRemaining: number;
    dailyUpdateLimit: number;
    dailyUpdateUsage: number;
    dailyUpdateRemaining: number;
    totalLimit: number;
    totalUsage: number;
    totalRemaining: number;
    resetAt: string | null;
    operationLimits: unknown;
    fetchedAt: string;
  }>;
};

class RuntimeBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeBlockedError";
  }
}

const smokeMarker = `auto-listing-smoke-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;

await main().catch((error) => {
  if (error instanceof RuntimeBlockedError) {
    console.error(`[runtime blocked] PostgreSQL unavailable: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  console.error(`[smoke failed] ${formatError(error)}`);
  process.exitCode = 1;
});

async function main() {
  if (!(await ensureDatabaseReady())) {
    return;
  }

  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => sendError(reply, error));
  await app.register(galleryAutoListingRoutes);
  await app.ready();

  let state: SmokeState | null = null;
  try {
    state = await createSmokeData();
    const currentState = state;
    assert.ok(currentState);
    const plansResponse = await listPlans(app, currentState.token);
    assert.ok(plansResponse.plans.some((plan) => plan.id === currentState.planId));
    const reserveBody = buildReserveBody(currentState);

    const reserveResponses = await Promise.all([
      reserveAssignments(app, currentState.token, reserveBody),
      reserveAssignments(app, currentState.token, reserveBody),
    ]);

    const populatedResponse = reserveResponses.find((item) => item.assignments.length > 0);
    const emptyResponse = reserveResponses.find((item) => item.assignments.length === 0);
    assert.ok(populatedResponse);
    assert.ok(emptyResponse);
    assert.equal(populatedResponse.assignments.length, 12);
    assert.equal(emptyResponse.assignments.length, 0);

    const combinedAssignments = [...populatedResponse.assignments, ...emptyResponse.assignments];
    const uniqueSourceAssets = new Set(combinedAssignments.map((assignment) => assignment.sourceAssetId));
    const duplicateAssignments = combinedAssignments.length - uniqueSourceAssets.size;
    assert.equal(duplicateAssignments, 0);

    const countsByShop = countAssignmentsByShop(populatedResponse.assignments);
    assert.ok(Math.abs((countsByShop.get(currentState.externalShopIds[0]) ?? 0) - (countsByShop.get(currentState.externalShopIds[1]) ?? 0)) <= 1);

    currentState.touchedAssignmentId = populatedResponse.assignments[0].id;
    await updateAssignmentStatus(app, currentState.token, currentState.touchedAssignmentId);

    const releasableAssignmentIds = combinedAssignments
      .filter((assignment) => canReleaseAssignment({
        status: assignment.id === currentState.touchedAssignmentId ? "preparing" : "reserved",
        batchId: null,
        hasGeneratedWork: false,
      }))
      .map((assignment) => assignment.id);

    assert.equal(releasableAssignmentIds.length, 11);
    const releaseResponse = await releaseAssignments(app, currentState.token, releasableAssignmentIds);
    assert.equal(releaseResponse.assignments.length, 11);

    const runsResponse = await listRuns(app, currentState.token, currentState.planId);
    const firstRun = runsResponse.runs.find((run) => run.id === populatedResponse.run.id);
    assert.ok(firstRun);
    assert.equal(firstRun?.assignments.length, 12);

    const statusByAssignmentId = new Map(firstRun!.assignments.map((assignment) => [assignment.id, assignment]));
    const touchedAssignment = statusByAssignmentId.get(currentState.touchedAssignmentId);
    assert.ok(touchedAssignment);
    assert.equal(touchedAssignment?.status, "preparing");
    assert.equal(touchedAssignment?.releasedAt, null);

    const releasedAssignments = firstRun!.assignments.filter((assignment) => assignment.status === "released");
    assert.equal(releasedAssignments.length, 11);

    console.log(`duplicateAssignments=${duplicateAssignments}`);
  } finally {
    if (state) {
      await cleanupSmokeData(state).catch((error) => {
        console.error(`[cleanup failed] ${formatError(error)}`);
        process.exitCode = 1;
      });
    }
    await app.close().catch(() => undefined);
  }
}

async function createSmokeData(): Promise<SmokeState> {
  return withTransaction(async (client) => {
    const ruleResult = await client.query(
      `
      SELECT id, product_type, aspect_ratio, ratio_width, ratio_height
      FROM product_image_rules
      WHERE enabled = TRUE
      ORDER BY created_at ASC, id ASC
      LIMIT 1
      `,
    );
    const rule = ruleResult.rows[0] as ProductImageRuleRow | undefined;
    if (!rule) {
      throw new Error("No enabled product image rule found");
    }

    const userId = newId();
    const deviceId = newId();
    const sessionId = newId();
    const planId = newId();
    const shopIds = [newId(), newId()];
    const externalShopIds = [`${smokeMarker}-shop-a`, `${smokeMarker}-shop-b`];
    const assetIds = Array.from({ length: 12 }, () => newId());
    const auth = createAuthToken(userId, deviceId);
    const membershipExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    await client.query(
      `
      INSERT INTO users (id, phone, password_hash, display_name, role, membership_plan, membership_expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        userId,
        `188${smokeMarker.slice(-8)}`,
        "smoke-password-hash",
        `${smokeMarker}-user`,
        "member",
        "monthly",
        membershipExpiresAt,
      ],
    );

    await client.query(
      `
      INSERT INTO devices (id, user_id, fingerprint_hash, device_name, last_seen_at)
      VALUES ($1, $2, $3, $4, now())
      `,
      [deviceId, userId, sha256Hex(`${smokeMarker}-device`), `${smokeMarker}-device`],
    );

    await client.query(
      `
      INSERT INTO user_sessions (id, user_id, device_id, token_jti_hash, expires_at)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [sessionId, userId, deviceId, sha256Hex(auth.jti), auth.expiresAt.toISOString()],
    );

    await client.query(
      `
      INSERT INTO shops (id, user_id, external_shop_id, name, ozon_client_id)
      VALUES
        ($1, $2, $3, $4, $5),
        ($6, $2, $7, $8, $9)
      `,
      [
        shopIds[0],
        userId,
        externalShopIds[0],
        `${smokeMarker} shop A`,
        `${smokeMarker}-client-a`,
        shopIds[1],
        externalShopIds[1],
        `${smokeMarker} shop B`,
        `${smokeMarker}-client-b`,
      ],
    );

    const shopConfigs = [
      buildShopConfig(shopIds[0], externalShopIds[0]),
      buildShopConfig(shopIds[1], externalShopIds[1]),
    ];

    await client.query(
      `
      INSERT INTO gallery_auto_listing_plans (
        id, user_id, name, product_image_rule_id, mockup_template_id, mockup_template_name,
        title_prompt_template_id, title_prompt_template_name, title_prompt, shop_configs,
        start_minute, end_minute, batch_size, buffer_size, enabled
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15)
      `,
      [
        planId,
        userId,
        `${smokeMarker} plan`,
        rule.id,
        `${smokeMarker}-mockup`,
        `${smokeMarker} mockup`,
        null,
        null,
        `${smokeMarker} title prompt`,
        JSON.stringify(shopConfigs),
        480,
        1320,
        5,
        10,
        true,
      ],
    );

    const createdAtBase = Date.now();
    for (let index = 0; index < assetIds.length; index += 1) {
      const assetId = assetIds[index];
      const width = rule.ratio_width * 200;
      const height = rule.ratio_height * 200;
      await client.query(
        `
        INSERT INTO gallery_assets (
          id, uploaded_by_user_id, sku, sha256, ratio, ratio_family, width, height,
          object_key, public_url, content_type, size_bytes, source_filename, created_at,
          product_image_rule_id, product_type, aspect_ratio
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        `,
        [
          assetId,
          userId,
          `${smokeMarker}-sku-${index + 1}`,
          sha256Hex(`${smokeMarker}-asset-${index + 1}`),
          Number((width / height).toFixed(4)),
          ratioFamilyForRule(rule.ratio_width, rule.ratio_height),
          width,
          height,
          `smoke/${smokeMarker}/asset-${index + 1}.png`,
          `https://example.invalid/${smokeMarker}/asset-${index + 1}.png`,
          "image/png",
          1,
          `${smokeMarker}-asset-${index + 1}.png`,
          new Date(createdAtBase + index * 1000).toISOString(),
          rule.id,
          rule.product_type,
          rule.aspect_ratio,
        ],
      );
    }

    return {
      userId,
      token: auth.token,
      planId,
      externalShopIds,
      assetIds,
      touchedAssignmentId: "",
    };
  });
}

function buildShopConfig(shopId: string, externalShopId: string) {
  return {
    externalShopId,
    shopName: `${smokeMarker} ${externalShopId}`,
    localShopId: `${smokeMarker}-local-${shopId.slice(0, 8)}`,
    localTemplateId: `${smokeMarker}-template-${shopId.slice(0, 8)}`,
    productTemplateId: newId(),
    productTemplateName: `${smokeMarker} product template`,
    templateProduct: {
      smokeMarker,
      externalShopId,
      shopId,
    },
    autoGenerateBarcode: true,
    autoUpdateStock: true,
    autoAddToAction: true,
  };
}

async function listPlans(app: FastifyInstance, token: string) {
  return injectJson<{ ok: true; plans: Array<{ id: string }> }>(app, "GET", "/gallery/auto-listing/plans", token);
}

async function reserveAssignments(app: FastifyInstance, token: string, body: ReserveBody) {
  return injectJson<ReserveResponse>(app, "POST", "/gallery/auto-listing/reservations", token, body);
}

async function updateAssignmentStatus(app: FastifyInstance, token: string, assignmentId: string) {
  return injectJson(app, "POST", "/gallery/auto-listing/assignments/progress", token, {
    updates: [{ assignmentId, status: "preparing" }],
  });
}

async function releaseAssignments(app: FastifyInstance, token: string, assignmentIds: string[]) {
  return injectJson<{ ok: true; assignments: Array<{ id: string }> }>(app, "POST", "/gallery/auto-listing/assignments/release", token, {
    assignmentIds,
  });
}

async function listRuns(app: FastifyInstance, token: string, planId: string) {
  return injectJson<RunsResponse>(app, "GET", `/gallery/auto-listing/runs?planId=${encodeURIComponent(planId)}&limit=10`, token);
}

async function injectJson<T>(
  app: FastifyInstance,
  method: "GET" | "POST",
  url: string,
  token: string,
  body?: unknown,
): Promise<T> {
  const response = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    payload: body ? JSON.stringify(body) : undefined,
  });
  const parsed = parseJson(response.payload);
  if (response.statusCode === 503 && isDatabaseNotReadyResponse(parsed)) {
    throw new RuntimeBlockedError(parsed.message ?? "database not ready");
  }
  if (response.statusCode >= 400) {
    throw new Error(`${method} ${url} failed with HTTP ${response.statusCode}: ${JSON.stringify(parsed)}`);
  }
  return parsed as T;
}

async function cleanupSmokeData(state: SmokeState) {
  await withTransaction(async (client) => {
    await client.query("DELETE FROM gallery_auto_listing_assignments WHERE user_id = $1", [state.userId]);
    await client.query("DELETE FROM gallery_auto_listing_runs WHERE user_id = $1", [state.userId]);
    await client.query("DELETE FROM gallery_auto_listing_plans WHERE user_id = $1", [state.userId]);
    if (state.assetIds.length) {
      await client.query("DELETE FROM gallery_assets WHERE id = ANY($1::uuid[])", [state.assetIds]);
    }
    await client.query("DELETE FROM users WHERE id = $1", [state.userId]);
  });
}

async function ensureDatabaseReady() {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch (error) {
    if (isTransientDatabaseError(error)) {
      throw new RuntimeBlockedError(formatError(error));
    }
    throw error;
  }
}

function countAssignmentsByShop(assignments: ReserveAssignment[]) {
  const counts = new Map<string, number>();
  for (const assignment of assignments) {
    counts.set(assignment.externalShopId, (counts.get(assignment.externalShopId) ?? 0) + 1);
  }
  return counts;
}

function parseJson(payload: string) {
  try {
    return payload ? JSON.parse(payload) : {};
  } catch {
    return { message: payload };
  }
}

function isDatabaseNotReadyResponse(value: unknown): value is { code?: string; message?: string } {
  return typeof value === "object" && value !== null && (value as { code?: unknown }).code === "DATABASE_NOT_READY";
}

function ratioFamilyForRule(width: number, height: number) {
  if (width === height) {
    return "square";
  }
  if (width < height) {
    return "portrait";
  }
  return width / height >= 1.5 ? "wide" : "landscape";
}

function formatError(error: unknown) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function buildReserveBody(state: SmokeState): ReserveBody {
  const fetchedAt = new Date().toISOString();
  return {
    planId: state.planId,
    quotaByExternalShopId: Object.fromEntries(state.externalShopIds.map((externalShopId) => [
      externalShopId,
      {
        dailyCreateLimit: 10,
        dailyCreateUsage: 0,
        dailyCreateRemaining: 10,
        dailyUpdateLimit: 10,
        dailyUpdateUsage: 0,
        dailyUpdateRemaining: 10,
        totalLimit: 100,
        totalUsage: 0,
        totalRemaining: 100,
        resetAt: null,
        operationLimits: [{ operation: "product_import", limit: 100 }],
        fetchedAt,
      },
    ])),
  };
}
