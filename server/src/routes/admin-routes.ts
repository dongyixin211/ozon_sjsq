// @ts-nocheck
import bcrypt from "bcryptjs";
import { z } from "zod";
import { planRules } from "../config.js";
import { requireAdminSession } from "../auth.js";
import { readAiSettings, toPublicAiSettings } from "../ai-settings.js";
import { discoverAiModels } from "../ai-model-service.js";
import { pool, withTransaction } from "../db.js";
import { AppError } from "../errors.js";
import { listAdminMockupTemplates, runMockupTemplatePreviewTest, saveConvertedMockupTemplateFiles, saveMockupTemplatePsd, setMockupTemplateStatus, upsertAdminMockupTemplate, } from "../mockup-template-service.js";
import { listProductImageRules, productImageRuleSchema, setProductImageRuleEnabled, upsertProductImageRule, } from "../product-image-rules.js";
import { createAdminToken, newId, makeLicenseKey, sha256Hex } from "../security.js";
import { invalidateFeatureFlagsCache } from "../feature-service.js";
const adminDeletionClause = (alias, state) => state === "deleted" ? `${alias}.deleted_at IS NOT NULL` : state === "all" ? "TRUE" : `${alias}.deleted_at IS NULL`;
const adminListQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(10), offset: z.coerce.number().int().min(0).default(0), deletionState: z.enum(["active", "deleted", "all"]).default("active") });
const createKeysSchema = z.object({
    plan: z.enum(["monthly", "quarterly", "yearly"]),
    count: z.number().int().min(1).max(200).default(1),
});
const paginationSchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(10),
    offset: z.coerce.number().int().min(0).default(0),
});
const usersQuerySchema = adminListQuerySchema.extend({
    keyword: z.string().trim().max(120).optional().default(""),
    membership: z.enum(["all", "active", "expired", "none"]).default("all"),
});
const userStorageLimitSchema = z.object({
    limitGb: z.coerce.number().min(0).max(1024),
});
const licenseKeysQuerySchema = adminListQuerySchema.extend({
    status: z.enum(["all", "unused", "redeemed", "disabled"]).default("all"),
    plan: z.enum(["all", "monthly", "quarterly", "yearly"]).default("all"),
    keyword: z.string().trim().max(80).optional().default(""),
});
const galleryAssetsQuerySchema = adminListQuerySchema.extend({
    ratioFamily: z.enum(["all", "portrait", "square", "landscape", "wide"]).default("all"),
    keyword: z.string().trim().max(120).optional().default(""),
    userId: z.string().uuid().optional(),
    mockupStatus: z.enum(["all", "with", "without"]).default("all"),
    orderedStatus: z.enum(["all", "ordered", "not_ordered"]).default("all"),
});

const featuredGalleryQuerySchema = adminListQuerySchema.extend({
    keyword: z.string().trim().max(120).optional().default(""),
    status: z.enum(["all", "active", "hidden", "review"]).default("all"),
    userId: z.string().uuid().optional(),
});
const featuredGalleryMutationSchema = z.object({
    assetId: z.string().uuid().optional(),
    status: z.enum(["active", "hidden", "review"]).optional(),
    score: z.coerce.number().int().min(0).max(1000000).optional(),
    adminNote: z.string().trim().max(2000).optional(),
});
const galleryAssetMutationSchema = z.object({
    sku: z.string().trim().min(1).max(160).optional(),
    productType: z.string().trim().max(120).nullable().optional(),
    generatedTitle: z.string().trim().max(500).nullable().optional(),
});
const overviewQuerySchema = z.object({
    period: z.enum(["7d", "30d", "1y", "all"]).default("7d"),
});
const adminDateStringSchema = z.union([
    z.literal(""),
    z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
]);
const adminOrdersQuerySchema = adminListQuerySchema.extend({
    period: z.enum(["today", "7d", "30d", "1y", "all"]).default("today"),
    dateFrom: adminDateStringSchema.optional().default(""),
    dateTo: adminDateStringSchema.optional().default(""),
    userId: z.string().uuid().optional(),
    externalShopId: z.string().trim().max(120).optional().default(""),
    category: z.string().trim().max(120).optional().default(""),
    status: z.string().trim().max(80).optional().default(""),
    keyword: z.string().trim().max(160).optional().default(""),
});
const mockupTemplateSchema = z.object({
    id: z.string().trim().min(2).max(80),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).default(""),
    productType: z.string().trim().max(120).default(""),
    sourceAspectRatio: z.string().trim().max(80).default(""),
});
const mockupStatusSchema = z.object({
    status: z.enum(["draft", "published", "disabled"]),
});
const productImageRuleStatusSchema = z.object({
    enabled: z.boolean(),
});
const aiSettingsSchema = z.object({
    imageProvider: z.string().min(1).max(80),
    imageBaseUrl: z.string().url(),
    imageModel: z.string().min(1).max(120),
    imageApiKey: z.string().optional(),
    textProvider: z.string().min(1).max(80),
    textBaseUrl: z.string().url(),
    textModel: z.string().min(1).max(120),
    textApiKey: z.string().optional(),
    imagePromptTemplate: z.string().max(8000).default(""),
    titlePromptTemplate: z.string().max(8000).default(""),
    descriptionPromptTemplate: z.string().max(8000).default(""),
});
const aiModelsQuerySchema = z.object({
    kind: z.enum(["image", "text"]),
    provider: z.string().trim().min(1).max(80).optional(),
    baseUrl: z.string().trim().url().optional(),
});
function normalizeOptionalSecret(value) {
    const trimmed = value?.trim() ?? "";
    return trimmed && !trimmed.includes("*") ? trimmed : null;
}
export async function adminRoutes(app) {
    app.post("/admin/auth/login", async (request) => {
        const body = z.object({ phone: z.string().trim().min(5).max(32), password: z.string().min(8).max(100) }).parse(request.body);
        const result = await pool.query("SELECT phone, user_id, password_hash, is_active FROM admin_accounts WHERE phone = $1 LIMIT 1", [body.phone]);
        const account = result.rows[0];
        if (!account || !account.is_active || !(await bcrypt.compare(body.password, account.password_hash))) {
            throw new AppError(401, "ADMIN_LOGIN_FAILED", "Phone number or password is incorrect");
        }
        const sessionId = newId();
        const token = createAdminToken(account.phone, sessionId);
        await withTransaction(async (client) => {
            await client.query("INSERT INTO admin_sessions (id, admin_phone, token_jti_hash, expires_at) VALUES ($1, $2, $3, $4)", [sessionId, account.phone, sha256Hex(token.jti), token.expiresAt]);
            await client.query("UPDATE admin_accounts SET last_login_at = now() WHERE phone = $1", [account.phone]);
        });
        return { ok: true, token: token.token, admin: { phone: account.phone } };
    });
    app.get("/admin/auth/session", { preHandler: requireAdminSession }, async (request) => ({ ok: true, admin: { phone: request.currentAdmin!.phone } }));
    app.get("/admin/product-image-rules", { preHandler: requireAdminSession }, async () => {
        const rules = await listProductImageRules(true);
        return { ok: true, rules };
    });
    app.post("/admin/product-image-rules", { preHandler: requireAdminSession }, async (request) => {
        const body = productImageRuleSchema.parse(request.body);
        const rule = await upsertProductImageRule(body);
        return { ok: true, rule };
    });
    app.post("/admin/product-image-rules/:ruleId/status", { preHandler: requireAdminSession }, async (request) => {
        const params = z.object({ ruleId: z.string().uuid() }).parse(request.params);
        const body = productImageRuleStatusSchema.parse(request.body);
        const rule = await setProductImageRuleEnabled(params.ruleId, body.enabled);
        return { ok: true, rule };
    });
    app.delete("/admin/product-image-rules/:ruleId", { preHandler: requireAdminSession }, async (request) => {
        const { ruleId } = z.object({ ruleId: z.string().uuid() }).parse(request.params);
        const result = await pool.query("UPDATE product_image_rules SET deleted_at = now(), deleted_by = 'admin', updated_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id", [ruleId]);
        if (!result.rows[0]) throw new AppError(404, "PRODUCT_IMAGE_RULE_NOT_FOUND", "product image rule not found");
        return { ok: true };
    });
    app.post("/admin/product-image-rules/:ruleId/restore", { preHandler: requireAdminSession }, async (request) => {
        const { ruleId } = z.object({ ruleId: z.string().uuid() }).parse(request.params);
        const result = await pool.query("UPDATE product_image_rules SET deleted_at = NULL, deleted_by = NULL, updated_at = now() WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id", [ruleId]);
        if (!result.rows[0]) throw new AppError(404, "PRODUCT_IMAGE_RULE_NOT_DELETED", "product image rule is not deleted");
        return { ok: true, rule: result.rows[0] };
    });    app.get("/admin/mockup-templates", { preHandler: requireAdminSession }, async () => {
        const templates = await listAdminMockupTemplates();
        return { ok: true, templates };
    });
    app.post("/admin/mockup-templates", { preHandler: requireAdminSession }, async (request) => {
        const body = mockupTemplateSchema.parse(request.body);
        const template = await upsertAdminMockupTemplate(body);
        return { ok: true, template };
    });
    app.post("/admin/mockup-templates/:templateId/psd", { preHandler: requireAdminSession }, async (request) => {
        const params = z.object({ templateId: z.string().trim().min(2).max(80) }).parse(request.params);
        const file = await request.file();
        if (!file) {
            throw new AppError(400, "MOCKUP_PSD_REQUIRED", "请上传 PSD 样机文件");
        }
        const template = await saveMockupTemplatePsd({
            templateId: params.templateId,
            filename: file.filename,
            buffer: await file.toBuffer(),
        });
        return { ok: true, template };
    });
    app.post("/admin/mockup-templates/:templateId/template-files", { preHandler: requireAdminSession }, async (request) => {
        const params = z.object({ templateId: z.string().trim().min(2).max(80) }).parse(request.params);
        const files = [];
        for await (const part of request.files()) {
            const index = String(part.fieldname || "").match(/^file-(\d+)$/)?.[1] || "";
            const fieldValue = index ? multipartFieldValue(part.fields[`relativePath-${index}`]) : undefined;
            files.push({
                relativePath: String(fieldValue || multipartFieldValue(part.fields.relativePath) || part.filename || ""),
                buffer: await part.toBuffer(),
            });
        }
        const template = await saveConvertedMockupTemplateFiles({
            templateId: params.templateId,
            files,
        });
        return { ok: true, template };
    });
    app.post("/admin/mockup-templates/:templateId/test-preview", { preHandler: requireAdminSession }, async (request) => {
        const params = z.object({ templateId: z.string().trim().min(2).max(80) }).parse(request.params);
        const template = await runMockupTemplatePreviewTest(params.templateId);
        return { ok: true, template };
    });
    app.post("/admin/mockup-templates/:templateId/status", { preHandler: requireAdminSession }, async (request) => {
        const params = z.object({ templateId: z.string().trim().min(2).max(80) }).parse(request.params);
        const body = mockupStatusSchema.parse(request.body);
        const template = await setMockupTemplateStatus(params.templateId, body.status);
        return { ok: true, template };
    });
    app.delete("/admin/mockup-templates/:templateId", { preHandler: requireAdminSession }, async (request) => {
        const { templateId } = z.object({ templateId: z.string().trim().min(2).max(80) }).parse(request.params);
        const result = await pool.query("UPDATE mockup_templates SET deleted_at = now(), deleted_by = 'admin', updated_at = now(), status = 'disabled' WHERE id = $1 AND deleted_at IS NULL RETURNING id", [templateId]);
        if (!result.rows[0]) throw new AppError(404, "MOCKUP_TEMPLATE_NOT_FOUND", "mockup template not found");
        return { ok: true };
    });
    app.post("/admin/mockup-templates/:templateId/restore", { preHandler: requireAdminSession }, async (request) => {
        const { templateId } = z.object({ templateId: z.string().trim().min(2).max(80) }).parse(request.params);
        const result = await pool.query("UPDATE mockup_templates SET deleted_at = NULL, deleted_by = NULL, updated_at = now() WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id", [templateId]);
        if (!result.rows[0]) throw new AppError(404, "MOCKUP_TEMPLATE_NOT_DELETED", "mockup template is not deleted");
        return { ok: true, template: result.rows[0] };
    });    app.put("/admin/users/:userId", { preHandler: requireAdminSession }, async (request) => {
  const params = z.object({ userId: z.string().uuid() }).parse(request.params);
  const body = z.object({ displayName: z.string().trim().max(120).nullable().optional(), membershipPlan: z.enum(["monthly", "quarterly", "yearly"]).nullable().optional(), membershipExpiresAt: z.coerce.date().nullable().optional() }).parse(request.body);
  const values = [params.userId, body.displayName ?? null, body.membershipPlan ?? null, body.membershipExpiresAt ?? null];
  const result = await pool.query("UPDATE users SET display_name = COALESCE($2, display_name), membership_plan = COALESCE($3, membership_plan), membership_expires_at = COALESCE($4, membership_expires_at), updated_at = now() WHERE id = $1 RETURNING id, display_name, membership_plan, membership_expires_at, deleted_at, deleted_by", values);
  if (!result.rows[0]) throw new AppError(404, "USER_NOT_FOUND", "user not found");
  return { ok: true, user: result.rows[0] };
});

app.post("/admin/users/:userId/restore", { preHandler: requireAdminSession }, async (request) => {
  const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params);
  const result = await pool.query("UPDATE users SET deleted_at = NULL, deleted_by = NULL, updated_at = now() WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id, deleted_at, deleted_by", [userId]);
  if (!result.rows[0]) throw new AppError(404, "USER_NOT_DELETED", "user is not deleted");
  return { ok: true, user: result.rows[0] };
});

app.put("/admin/license-keys/:keyId", { preHandler: requireAdminSession }, async (request) => {
  const { keyId } = z.object({ keyId: z.string().uuid() }).parse(request.params);
  const body = z.object({ plan: z.enum(["monthly", "quarterly", "yearly"]).optional(), expiresAt: z.coerce.date().nullable().optional(), status: z.enum(["unused", "redeemed", "disabled"]).optional() }).parse(request.body);
  const result = await pool.query("UPDATE authorization_keys SET plan = COALESCE($2, plan), expires_at = COALESCE($3, expires_at), status = COALESCE($4, status) WHERE id = $1 RETURNING id, key_prefix, plan, expires_at, status, deleted_at, deleted_by", [keyId, body.plan ?? null, body.expiresAt ?? null, body.status ?? null]);
  if (!result.rows[0]) throw new AppError(404, "LICENSE_KEY_NOT_FOUND", "license key not found");
  return { ok: true, key: result.rows[0] };
});

app.post("/admin/license-keys/:keyId/restore", { preHandler: requireAdminSession }, async (request) => {
  const { keyId } = z.object({ keyId: z.string().uuid() }).parse(request.params);
  const result = await pool.query("UPDATE authorization_keys SET deleted_at = NULL, deleted_by = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id, key_prefix, deleted_at, deleted_by", [keyId]);
  if (!result.rows[0]) throw new AppError(404, "LICENSE_KEY_NOT_DELETED", "license key is not deleted");
  return { ok: true, key: result.rows[0] };
});
app.get("/admin/overview", { preHandler: requireAdminSession }, async (request) => {
        const query = overviewQuerySchema.parse(request.query);
        const orderWhere = orderPeriodWhere(query.period);
        const [userStats, keyStats, galleryStats, orderStats, userOrderStats, recentUsers, recentKeys] = await Promise.all([
            pool.query(`
        SELECT
          count(*)::int AS total_users,
          count(*) FILTER (WHERE membership_expires_at > now())::int AS active_members,
          count(*) FILTER (WHERE membership_expires_at IS NOT NULL AND membership_expires_at <= now())::int AS expired_members,
          count(*) FILTER (WHERE membership_expires_at IS NULL)::int AS free_users,
          count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS new_users_7d,
          count(*) FILTER (WHERE created_at >= now() - interval '30 days')::int AS new_users_30d
        FROM users
      `),
            pool.query(`
        SELECT
          count(*)::int AS total_keys,
          count(*) FILTER (WHERE status = 'unused')::int AS unused_keys,
          count(*) FILTER (WHERE status = 'redeemed')::int AS redeemed_keys,
          count(*) FILTER (WHERE status = 'disabled')::int AS disabled_keys
        FROM authorization_keys
      `),
            pool.query(`
        SELECT
          count(*)::int AS total_assets,
          COALESCE(sum(size_bytes), 0)::bigint AS total_asset_bytes,
          count(DISTINCT sku)::int AS asset_skus,
          count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS new_assets_7d
        FROM gallery_assets
        WHERE deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM gallery_mockup_results mr
            WHERE mr.result_asset_id = gallery_assets.id
          )
      `),
            pool.query(`
        SELECT
          count(*)::int AS total_orders,
          COALESCE(sum(sales_amount), 0)::numeric(14, 2) AS total_sales,
          count(DISTINCT user_id)::int AS ordering_users,
          count(DISTINCT external_shop_id)::int AS ordering_shops
        FROM order_postings o
        ${orderWhere.sql}
      `, orderWhere.values),
            pool.query(`
        SELECT
          u.id,
          u.phone,
          u.display_name,
          count(o.id)::int AS order_count,
          COALESCE(sum(o.sales_amount), 0)::numeric(14, 2) AS sales_amount,
          max(o.in_process_at) AS last_order_at
        FROM order_postings o
        JOIN users u ON u.id = o.user_id
        ${orderWhere.sql}
        GROUP BY u.id, u.phone, u.display_name
        ORDER BY sales_amount DESC, order_count DESC, last_order_at DESC NULLS LAST
        LIMIT 20
      `),
            pool.query(`
        SELECT id, phone, display_name, membership_plan, membership_expires_at, created_at
        FROM users
        ORDER BY created_at DESC
        LIMIT 8
      `),
            pool.query(`
        SELECT
          k.id,
          k.key_prefix,
          k.plan,
          k.status,
          k.created_at,
          k.redeemed_at,
          u.phone AS assigned_phone
        FROM authorization_keys k
        LEFT JOIN users u ON u.id = k.assigned_user_id
        ORDER BY k.created_at DESC
        LIMIT 8
      `),
        ]);
        return {
            ok: true,
            stats: {
                ...userStats.rows[0],
                ...keyStats.rows[0],
                ...galleryStats.rows[0],
                ...orderStats.rows[0],
            },
            orderPeriod: query.period,
            userOrderStats: userOrderStats.rows,
            recentUsers: recentUsers.rows,
            recentKeys: recentKeys.rows,
        };
    });
    app.get("/admin/ai-settings", { preHandler: requireAdminSession }, async () => {
        const settings = await readAiSettings();
        return { ok: true, settings: toPublicAiSettings(settings) };
    });
    app.get("/admin/ai-models", { preHandler: requireAdminSession }, async (request) => {
        const query = aiModelsQuerySchema.parse(request.query);
        const settings = await readAiSettings();
        const provider = query.provider || (query.kind === "image" ? settings.imageProvider : settings.textProvider);
        const baseUrl = query.baseUrl || (query.kind === "image" ? settings.imageBaseUrl : settings.textBaseUrl);
        const apiKey = query.kind === "image" ? settings.imageApiKey : settings.textApiKey;
        if (!apiKey.trim() && !isLocalProvider(provider)) {
            throw new AppError(400, "AI_KEY_MISSING", `${query.kind === "image" ? "图片" : "文案"} AI Key 未配置，请先保存 API Key。`);
        }
        const models = await discoverAiModels({
            kind: query.kind,
            provider,
            baseUrl,
            apiKey,
        });
        return { ok: true, models };
    });
    app.post("/admin/ai-settings", { preHandler: requireAdminSession }, async (request) => {
        const body = aiSettingsSchema.parse(request.body);
        const nextImageApiKey = normalizeOptionalSecret(body.imageApiKey);
        const nextTextApiKey = normalizeOptionalSecret(body.textApiKey);
        await pool.query(`
      INSERT INTO ai_settings (
        id,
        image_provider,
        image_base_url,
        image_model,
        image_api_key,
        text_provider,
        text_base_url,
        text_model,
        text_api_key,
        image_prompt_template,
        title_prompt_template,
        description_prompt_template,
        updated_at
      )
      VALUES (
        TRUE,
        $1,
        $2,
        $3,
        NULLIF($4, ''),
        $5,
        $6,
        $7,
        NULLIF($8, ''),
        $9,
        $10,
        $11,
        now()
      )
      ON CONFLICT (id) DO UPDATE
      SET image_provider = EXCLUDED.image_provider,
          image_base_url = EXCLUDED.image_base_url,
          image_model = EXCLUDED.image_model,
          image_api_key = COALESCE(EXCLUDED.image_api_key, ai_settings.image_api_key),
          text_provider = EXCLUDED.text_provider,
          text_base_url = EXCLUDED.text_base_url,
          text_model = EXCLUDED.text_model,
          text_api_key = COALESCE(EXCLUDED.text_api_key, ai_settings.text_api_key),
          image_prompt_template = EXCLUDED.image_prompt_template,
          title_prompt_template = EXCLUDED.title_prompt_template,
          description_prompt_template = EXCLUDED.description_prompt_template,
          updated_at = now()
      `, [
            body.imageProvider.trim(),
            body.imageBaseUrl.trim().replace(/\/+$/, ""),
            body.imageModel.trim(),
            nextImageApiKey,
            body.textProvider.trim(),
            body.textBaseUrl.trim().replace(/\/+$/, ""),
            body.textModel.trim(),
            nextTextApiKey,
            body.imagePromptTemplate,
            body.titlePromptTemplate,
            body.descriptionPromptTemplate,
        ]);
        const settings = await readAiSettings();
        return { ok: true, settings: toPublicAiSettings(settings) };
    });
    app.post("/admin/license-keys", { preHandler: requireAdminSession }, async (request) => {
        request.log.info("admin license key creation started");
        const body = createKeysSchema.parse(request.body);
        const rule = planRules[body.plan];
        const keys = [];
        for (let index = 0; index < body.count; index += 1) {
            const key = makeLicenseKey();
            request.log.info({ index, plan: body.plan }, "inserting authorization key");
            await pool.query(`
        INSERT INTO authorization_keys (id, key_hash, key_prefix, key_plain, plan, days, price_cents)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [newId(), sha256Hex(key), key.slice(0, 12), key, body.plan, rule.days, rule.priceCents]);
            request.log.info({ index, plan: body.plan }, "authorization key inserted");
            keys.push({
                key,
                plan: body.plan,
                priceYuan: rule.priceCents / 100,
                days: rule.days,
            });
        }
        request.log.info({ count: keys.length, plan: body.plan }, "admin license key creation completed");
        return { ok: true, keys };
    });
    app.get("/admin/license-keys", { preHandler: requireAdminSession }, async (request) => {
        const query = licenseKeysQuerySchema.parse(request.query);
        const values = [];
        const where = [];
        if (query.status !== "all") {
            values.push(query.status);
            where.push(`k.status = $${values.length}`);
        }
        if (query.plan !== "all") {
            values.push(query.plan);
            where.push(`k.plan = $${values.length}`);
        }
        if (query.keyword) {
            values.push(`%${query.keyword}%`);
            where.push(`(k.key_prefix ILIKE $${values.length} OR COALESCE(u.phone, '') ILIKE $${values.length})`);
        }
        where.unshift(adminDeletionClause("k", query.deletionState));
        const whereSql = `WHERE ${where.join(" AND ")}`;
        const countResult = await pool.query(`
      SELECT count(*)::int AS total
      FROM authorization_keys k
      LEFT JOIN users u ON u.id = k.assigned_user_id
      ${whereSql}
      `, values);
        const listValues = [...values, query.limit, query.offset];
        const limitIndex = listValues.length - 1;
        const offsetIndex = listValues.length;
        const result = await pool.query(`
      SELECT
        k.id,
        k.key_prefix,
        CASE WHEN k.status = 'unused' THEN k.key_plain ELSE NULL END AS key_plain,
        k.plan,
        k.days,
        k.price_cents,
        k.status,
        k.redeemed_at,
        k.expires_at,
        k.created_at,
        u.phone AS assigned_phone
      FROM authorization_keys k
      LEFT JOIN users u ON u.id = k.assigned_user_id
      ${whereSql}
      ORDER BY k.created_at DESC
      LIMIT $${limitIndex}
      OFFSET $${offsetIndex}
      `, listValues);
        return {
            ok: true,
            items: result.rows,
            keys: result.rows,
            total: countResult.rows[0]?.total ?? 0,
            limit: query.limit,
            offset: query.offset,
        };
    });
    app.delete("/admin/license-keys/:keyId", { preHandler: requireAdminSession }, async (request) => {
        const params = z.object({ keyId: z.string().uuid() }).parse(request.params);
        const result = await pool.query(`
      UPDATE authorization_keys
      SET deleted_at = now(), deleted_by = 'admin'
      WHERE id = $1
        AND status = 'unused'
        AND deleted_at IS NULL
      RETURNING id
      `, [params.keyId]);
        if (!result.rowCount) {
            throw new AppError(400, "LICENSE_KEY_NOT_DELETABLE", "只能删除未使用的授权码");
        }
        return { ok: true };
    });
    app.post("/admin/users/:userId/unbind-device", { preHandler: requireAdminSession }, async (request) => {
        const params = z.object({ userId: z.string().uuid() }).parse(request.params);
        await pool.query(`
      UPDATE devices
      SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL
      `, [params.userId]);
        await pool.query(`
      UPDATE user_sessions
      SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL
      `, [params.userId]);
        return { ok: true };
    });
    app.post("/admin/users/:userId/storage-limit", { preHandler: requireAdminSession }, async (request) => {
        const params = z.object({ userId: z.string().uuid() }).parse(request.params);
        const body = userStorageLimitSchema.parse(request.body);
        const limitBytes = Math.round(body.limitGb * 1024 * 1024 * 1024);
        const result = await pool.query(`
      UPDATE users
      SET gallery_storage_limit_bytes = $2,
          updated_at = now()
      WHERE id = $1
      RETURNING id, gallery_storage_limit_bytes
      `, [params.userId, limitBytes]);
        if (!result.rowCount) {
            throw new AppError(404, "USER_NOT_FOUND", "用户不存在");
        }
        return { ok: true, user: result.rows[0] };
    });
    app.delete("/admin/users/:userId", { preHandler: requireAdminSession }, async (request) => {
        const params = z.object({ userId: z.string().uuid() }).parse(request.params);
        return withTransaction(async (client) => {
            const userResult = await client.query("SELECT id, role FROM users WHERE id = $1 FOR UPDATE", [params.userId]);
            const user = userResult.rows[0];
            if (!user) {
                throw new AppError(404, "USER_NOT_FOUND", "用户不存在");
            }
            if (user.role === "admin") {
                throw new AppError(400, "ADMIN_USER_NOT_DELETABLE", "不能删除管理员账号");
            }
            const assetResult = await client.query("UPDATE gallery_assets SET deleted_at = now() WHERE uploaded_by_user_id = $1 AND deleted_at IS NULL RETURNING id", [params.userId]);
            await client.query("UPDATE users SET deleted_at = now(), deleted_by = 'admin', updated_at = now() WHERE id = $1", [params.userId]);
            return { ok: true, deletedAssetCount: assetResult.rowCount ?? 0 };
        });
    });
    app.get("/admin/users", { preHandler: requireAdminSession }, async (request) => {
        const query = usersQuerySchema.parse(request.query);
        const values = [];
        const where = [];
        if (query.keyword) {
            values.push(`%${query.keyword}%`);
            where.push(`(u.phone ILIKE $${values.length} OR COALESCE(u.display_name, '') ILIKE $${values.length})`);
        }
        if (query.membership === "active") {
            where.push("u.membership_expires_at > now()");
        }
        else if (query.membership === "expired") {
            where.push("u.membership_expires_at IS NOT NULL AND u.membership_expires_at <= now()");
        }
        else if (query.membership === "none") {
            where.push("u.membership_expires_at IS NULL");
        }
        where.unshift(adminDeletionClause("u", query.deletionState));
        const whereSql = `WHERE ${where.join(" AND ")}`;
        const countResult = await pool.query(`
      SELECT count(*)::int AS total
      FROM users u
      ${whereSql}
      `, values);
        const listValues = [...values, query.limit, query.offset];
        const limitIndex = listValues.length - 1;
        const offsetIndex = listValues.length;
        const result = await pool.query(`
      WITH filtered_users AS (
        SELECT
          u.id,
          u.phone,
          u.display_name,
          u.role,
          COALESCE((
            SELECT json_agg(ur.role ORDER BY ur.role)
            FROM user_roles ur
            WHERE ur.user_id = u.id
          ), json_build_array(u.role)) AS roles,
          u.membership_plan,
          u.membership_expires_at,
          u.gallery_storage_limit_bytes,
          u.last_login_at,
          u.created_at
        FROM users u
        ${whereSql}
        ORDER BY u.created_at DESC
        LIMIT $${limitIndex}
        OFFSET $${offsetIndex}
      ),
      active_devices AS (
        SELECT DISTINCT ON (d.user_id)
          d.user_id,
          d.device_name,
          d.last_seen_at
        FROM devices d
        JOIN filtered_users fu ON fu.id = d.user_id
        WHERE d.revoked_at IS NULL
        ORDER BY d.user_id, d.last_seen_at DESC
      ),
      shop_counts AS (
        SELECT s.user_id, count(*)::int AS shop_count
        FROM shops s
        JOIN filtered_users fu ON fu.id = s.user_id
        GROUP BY s.user_id
      ),
      gallery_usage_counts AS (
        SELECT gu.user_id, count(*)::int AS gallery_usage_count
        FROM gallery_usage gu
        JOIN filtered_users fu ON fu.id = gu.user_id
        GROUP BY gu.user_id
      ),
      gallery_storage_usage AS (
        SELECT
          a.uploaded_by_user_id AS user_id,
          COALESCE(sum(a.size_bytes), 0)::bigint AS gallery_storage_used_bytes
        FROM gallery_assets a
        JOIN filtered_users fu ON fu.id = a.uploaded_by_user_id
        WHERE a.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM gallery_mockup_results mr
            WHERE mr.result_asset_id = a.id
          )
        GROUP BY a.uploaded_by_user_id
      )
      SELECT
        fu.id,
        fu.phone,
        fu.display_name,
        fu.role,
        fu.roles,
        fu.membership_plan,
        fu.membership_expires_at,
        fu.gallery_storage_limit_bytes,
        fu.last_login_at,
        fu.created_at,
        ad.device_name,
        ad.last_seen_at,
        COALESCE(sc.shop_count, 0) AS shop_count,
        COALESCE(guc.gallery_usage_count, 0) AS gallery_usage_count,
        COALESCE(gsu.gallery_storage_used_bytes, 0)::bigint AS gallery_storage_used_bytes
      FROM filtered_users fu
      LEFT JOIN active_devices ad ON ad.user_id = fu.id
      LEFT JOIN shop_counts sc ON sc.user_id = fu.id
      LEFT JOIN gallery_usage_counts guc ON guc.user_id = fu.id
      LEFT JOIN gallery_storage_usage gsu ON gsu.user_id = fu.id
      ORDER BY fu.created_at DESC
      `, listValues);
        return {
            ok: true,
            items: result.rows,
            users: result.rows,
            total: countResult.rows[0]?.total ?? 0,
            limit: query.limit,
            offset: query.offset,
        };
    });
    app.get("/admin/featured-gallery", { preHandler: requireAdminSession }, async (request) => {
        const query = featuredGalleryQuerySchema.parse(request.query);
        const values = [];
        const where = [adminDeletionClause("f", query.deletionState), "a.deleted_at IS NULL"];
        if (query.status !== "all") {
            values.push(query.status);
            where.push(`f.status = $${values.length}`);
        }
        if (query.userId) {
            values.push(query.userId);
            where.push(`a.uploaded_by_user_id = $${values.length}`);
        }
        if (query.keyword) {
            values.push(`%${query.keyword}%`);
            where.push(`(a.sku ILIKE $${values.length} OR COALESCE(a.source_filename, '') ILIKE $${values.length} OR COALESCE(u.phone, '') ILIKE $${values.length})`);
        }
        const whereSql = `WHERE ${where.join(" AND ")}`;
        const countResult = await pool.query(`
          SELECT count(*)::int AS total
          FROM featured_gallery_assets f
          JOIN gallery_assets a ON a.id = f.asset_id
          LEFT JOIN users u ON u.id = a.uploaded_by_user_id
          ${whereSql}
        `, values);
        const listValues = [...values, query.limit, query.offset];
        const result = await pool.query(`
          SELECT
            f.id,
            f.asset_id,
            f.status,
            f.score,
            f.order_count,
            f.distinct_user_count,
            f.distinct_shop_count,
            f.last_ordered_at,
            f.reason,
            f.source,
            f.admin_note,
            f.created_at,
            f.updated_at,
            f.deleted_at,
            a.sku,
            a.ratio_family,
            a.product_type,
            a.public_url,
            a.thumb_url,
            a.source_filename,
            u.phone AS uploaded_by_phone,
            COALESCE(mockups.items, '[]'::json) AS mockup_results
          FROM featured_gallery_assets f
          JOIN gallery_assets a ON a.id = f.asset_id
          LEFT JOIN users u ON u.id = a.uploaded_by_user_id
          LEFT JOIN LATERAL (
            SELECT json_agg(json_build_object('id', r.id, 'url', r.public_url, 'thumbUrl', r.thumb_url, 'templateName', m.template_name, 'sceneIndex', m.scene_index) ORDER BY m.template_name, m.scene_index) AS items
            FROM gallery_mockup_results m
            JOIN gallery_assets r ON r.id = m.result_asset_id
            WHERE m.source_asset_id = a.id AND r.deleted_at IS NULL
          ) mockups ON TRUE
          ${whereSql}
          ORDER BY f.score DESC, f.last_ordered_at DESC NULLS LAST, f.updated_at DESC
          LIMIT $${listValues.length - 1} OFFSET $${listValues.length}
        `, listValues);
        return { ok: true, items: result.rows, featured: result.rows, total: countResult.rows[0]?.total ?? 0, limit: query.limit, offset: query.offset };
    });
    app.post("/admin/featured-gallery", { preHandler: requireAdminSession }, async (request) => {
        const body = featuredGalleryMutationSchema.required({ assetId: true }).parse(request.body);
        const asset = await pool.query(`
          SELECT id, sku, sha256
          FROM gallery_assets a
          WHERE a.id = $1 AND a.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM gallery_mockup_results source_check WHERE source_check.result_asset_id = a.id)
        `, [body.assetId]);
        if (!asset.rows[0]) throw new AppError(404, "SOURCE_ASSET_NOT_FOUND", "source asset not found");
        const result = await pool.query(`
          INSERT INTO featured_gallery_assets (id, asset_id, sku, sha256, score, status, source, admin_note)
          VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7)
          ON CONFLICT (asset_id) DO UPDATE
            SET score = EXCLUDED.score, status = EXCLUDED.status, source = 'manual', admin_note = EXCLUDED.admin_note,
                deleted_at = NULL, deleted_by = NULL, updated_at = now()
          RETURNING id, asset_id, status, score, source, admin_note, deleted_at
        `, [newId(), asset.rows[0].id, asset.rows[0].sku, asset.rows[0].sha256, body.score ?? 0, body.status ?? "review", body.adminNote ?? ""]);
        return { ok: true, featured: result.rows[0] };
    });
    app.put("/admin/featured-gallery/:featuredId", { preHandler: requireAdminSession }, async (request) => {
        const { featuredId } = z.object({ featuredId: z.string().uuid() }).parse(request.params);
        const body = featuredGalleryMutationSchema.omit({ assetId: true }).parse(request.body);
        const result = await pool.query(`
          UPDATE featured_gallery_assets
          SET status = COALESCE($2, status), score = COALESCE($3, score), admin_note = COALESCE($4, admin_note), updated_at = now()
          WHERE id = $1
          RETURNING id, asset_id, status, score, admin_note, deleted_at
        `, [featuredId, body.status ?? null, body.score ?? null, body.adminNote ?? null]);
        if (!result.rows[0]) throw new AppError(404, "FEATURED_ASSET_NOT_FOUND", "featured asset not found");
        return { ok: true, featured: result.rows[0] };
    });
    app.delete("/admin/featured-gallery/:featuredId", { preHandler: requireAdminSession }, async (request) => {
        const { featuredId } = z.object({ featuredId: z.string().uuid() }).parse(request.params);
        const result = await pool.query("UPDATE featured_gallery_assets SET deleted_at = now(), deleted_by = 'admin', updated_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id", [featuredId]);
        if (!result.rows[0]) throw new AppError(404, "FEATURED_ASSET_NOT_FOUND", "featured asset not found");
        return { ok: true };
    });
    app.post("/admin/featured-gallery/:featuredId/restore", { preHandler: requireAdminSession }, async (request) => {
        const { featuredId } = z.object({ featuredId: z.string().uuid() }).parse(request.params);
        const result = await pool.query("UPDATE featured_gallery_assets SET deleted_at = NULL, deleted_by = NULL, updated_at = now() WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id", [featuredId]);
        if (!result.rows[0]) throw new AppError(404, "FEATURED_ASSET_NOT_DELETED", "featured asset is not deleted");
        return { ok: true, featured: result.rows[0] };
    });
    app.get("/admin/gallery-assets/:assetId", { preHandler: requireAdminSession }, async (request) => {
        const { assetId } = z.object({ assetId: z.string().uuid() }).parse(request.params);
        const result = await pool.query(`
          SELECT a.*, u.phone AS uploaded_by_phone,
            COALESCE(mockups.items, '[]'::json) AS mockup_results
          FROM gallery_assets a
          LEFT JOIN users u ON u.id = a.uploaded_by_user_id
          LEFT JOIN LATERAL (
            SELECT json_agg(json_build_object('id', r.id, 'url', r.public_url, 'thumbUrl', r.thumb_url, 'templateName', m.template_name, 'sceneIndex', m.scene_index) ORDER BY m.template_name, m.scene_index) AS items
            FROM gallery_mockup_results m JOIN gallery_assets r ON r.id = m.result_asset_id
            WHERE m.source_asset_id = a.id AND r.deleted_at IS NULL
          ) mockups ON TRUE
          WHERE a.id = $1
            AND NOT EXISTS (SELECT 1 FROM gallery_mockup_results source_check WHERE source_check.result_asset_id = a.id)
        `, [assetId]);
        if (!result.rows[0]) throw new AppError(404, "SOURCE_ASSET_NOT_FOUND", "source asset not found");
        return { ok: true, asset: result.rows[0] };
    });
    app.put("/admin/gallery-assets/:assetId", { preHandler: requireAdminSession }, async (request) => {
        const { assetId } = z.object({ assetId: z.string().uuid() }).parse(request.params);
        const body = galleryAssetMutationSchema.parse(request.body);
        const result = await pool.query(`
          UPDATE gallery_assets a
          SET sku = COALESCE($2, a.sku), product_type = COALESCE($3, a.product_type), generated_title = COALESCE($4, a.generated_title)
          WHERE a.id = $1
            AND NOT EXISTS (SELECT 1 FROM gallery_mockup_results source_check WHERE source_check.result_asset_id = a.id)
          RETURNING a.id, a.sku, a.product_type, a.generated_title, a.deleted_at
        `, [assetId, body.sku ?? null, body.productType ?? null, body.generatedTitle ?? null]);
        if (!result.rows[0]) throw new AppError(404, "SOURCE_ASSET_NOT_FOUND", "source asset not found");
        return { ok: true, asset: result.rows[0] };
    });
    app.delete("/admin/gallery-assets/:assetId", { preHandler: requireAdminSession }, async (request) => {
        const { assetId } = z.object({ assetId: z.string().uuid() }).parse(request.params);
        const result = await pool.query(`
          UPDATE gallery_assets a SET deleted_at = now()
          WHERE a.id = $1 AND a.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM gallery_mockup_results source_check WHERE source_check.result_asset_id = a.id)
          RETURNING a.id
        `, [assetId]);
        if (!result.rows[0]) throw new AppError(404, "SOURCE_ASSET_NOT_FOUND", "source asset not found");
        return { ok: true };
    });
    app.post("/admin/gallery-assets/:assetId/restore", { preHandler: requireAdminSession }, async (request) => {
        const { assetId } = z.object({ assetId: z.string().uuid() }).parse(request.params);
        const result = await pool.query(`
          UPDATE gallery_assets a SET deleted_at = NULL
          WHERE a.id = $1 AND a.deleted_at IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM gallery_mockup_results source_check WHERE source_check.result_asset_id = a.id)
          RETURNING a.id
        `, [assetId]);
        if (!result.rows[0]) throw new AppError(404, "SOURCE_ASSET_NOT_DELETED", "source asset is not deleted");
        return { ok: true, asset: result.rows[0] };
    });    app.get("/admin/gallery-assets", { preHandler: requireAdminSession }, async (request) => {
        const query = galleryAssetsQuerySchema.parse(request.query);
        const values = [];
        const where = [
            "a.deleted_at IS NULL",
            `NOT EXISTS (
        SELECT 1
        FROM gallery_mockup_results source_check
        WHERE source_check.result_asset_id = a.id
      )`,
        ];
        if (query.ratioFamily !== "all") {
            values.push(query.ratioFamily);
            where.push(`a.ratio_family = $${values.length}`);
        }
        if (query.userId) {
            values.push(query.userId);
            where.push(`a.uploaded_by_user_id = $${values.length}`);
        }
        if (query.keyword) {
            values.push(`%${query.keyword}%`);
            where.push(`(a.sku ILIKE $${values.length} OR a.source_filename ILIKE $${values.length} OR COALESCE(u.phone, '') ILIKE $${values.length})`);
        }
        if (query.mockupStatus === "with") {
            where.push("EXISTS (SELECT 1 FROM gallery_mockup_results mr WHERE mr.source_asset_id = a.id)");
        }
        else if (query.mockupStatus === "without") {
            where.push("NOT EXISTS (SELECT 1 FROM gallery_mockup_results mr WHERE mr.source_asset_id = a.id)");
        }
        if (query.orderedStatus === "ordered") {
            where.push("EXISTS (SELECT 1 FROM order_postings o WHERE a.sku = ANY(o.offer_ids))");
        }
        else if (query.orderedStatus === "not_ordered") {
            where.push("NOT EXISTS (SELECT 1 FROM order_postings o WHERE a.sku = ANY(o.offer_ids))");
        }
        where.unshift(adminDeletionClause("a", query.deletionState));
        const whereSql = `WHERE ${where.join(" AND ")}`;
        const countResult = await pool.query(`
      SELECT count(*)::int AS total
      FROM gallery_assets a
      LEFT JOIN users u ON u.id = a.uploaded_by_user_id
      ${whereSql}
      `, values);
        const listValues = [...values, query.limit, query.offset];
        const limitIndex = listValues.length - 1;
        const offsetIndex = listValues.length;
        const result = await pool.query(`
      WITH filtered_assets AS (
        SELECT
          a.id,
          a.uploaded_by_user_id,
          a.sku,
          a.ratio_family,
          a.product_type,
          a.width,
          a.height,
          a.public_url,
          a.thumb_url,
          a.size_bytes,
          a.source_filename,
          a.generated_title,
          a.generated_title_updated_at,
          a.created_at,
          a.deleted_at
        FROM gallery_assets a
        LEFT JOIN users u ON u.id = a.uploaded_by_user_id
        ${whereSql}
        ORDER BY a.created_at DESC
        LIMIT $${limitIndex}
        OFFSET $${offsetIndex}
      ),
      usage_counts AS (
        SELECT gu.asset_id, count(*)::int AS usage_count
        FROM gallery_usage gu
        JOIN filtered_assets fa ON fa.id = gu.asset_id
        GROUP BY gu.asset_id
      )
      SELECT
        fa.id,
        fa.sku,
        fa.ratio_family,
        fa.product_type,
        fa.width,
        fa.height,
        fa.public_url,
        fa.thumb_url,
        fa.size_bytes,
        fa.source_filename,
        fa.generated_title,
        fa.generated_title_updated_at,
        fa.created_at,
        fa.deleted_at,
        u.phone AS uploaded_by_phone,
        COALESCE(uc.usage_count, 0) AS usage_count,
        COALESCE(mr.mockup_results, '[]'::json) AS mockup_results,
        COALESCE(os.order_count, 0)::int AS order_count,
        COALESCE(os.sales_amount, 0)::numeric(14, 2) AS sales_amount,
        os.last_order_at
      FROM filtered_assets fa
      LEFT JOIN users u ON u.id = fa.uploaded_by_user_id
      LEFT JOIN usage_counts uc ON uc.asset_id = fa.id
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'id', r.id,
            'url', r.public_url,
            'thumbUrl', r.thumb_url,
            'templateName', m.template_name,
            'sceneIndex', m.scene_index
          )
          ORDER BY m.template_name, m.scene_index
        ) AS mockup_results
        FROM gallery_mockup_results m
        JOIN gallery_assets r ON r.id = m.result_asset_id
        WHERE m.source_asset_id = fa.id
          AND r.deleted_at IS NULL
      ) mr ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          count(*)::int AS order_count,
          COALESCE(sum(o.sales_amount), 0)::numeric(14, 2) AS sales_amount,
          max(o.in_process_at) AS last_order_at
        FROM order_postings o
        WHERE fa.sku = ANY(o.offer_ids)
      ) os ON TRUE
      ORDER BY fa.created_at DESC
      `, listValues);
        return {
            ok: true,
            items: result.rows,
            assets: result.rows,
            total: countResult.rows[0]?.total ?? 0,
            limit: query.limit,
            offset: query.offset,
        };
    });
    app.get("/admin/orders", { preHandler: requireAdminSession }, async (request) => {
        const query = adminOrdersQuerySchema.parse(request.query);
        const values = [];
        const where = [];
        const period = orderDateRangeWhere(query.dateFrom, query.dateTo, query.period, values.length);
        where.push(...period.conditions);
        values.push(...period.values);
        if (query.userId) {
            values.push(query.userId);
            where.push(`o.user_id = $${values.length}`);
        }
        if (query.externalShopId) {
            values.push(query.externalShopId);
            where.push(`o.external_shop_id = $${values.length}`);
        }
        if (query.category) {
            values.push(query.category);
            where.push(`COALESCE(o.category, '') = $${values.length}`);
        }
        if (query.status) {
            values.push(query.status);
            where.push(`COALESCE(o.status, '') = $${values.length}`);
        }
        if (query.keyword) {
            values.push(`%${query.keyword}%`);
            where.push(`(
        o.posting_number ILIKE $${values.length}
        OR COALESCE(o.order_number, '') ILIKE $${values.length}
        OR COALESCE(o.tracking_number, '') ILIKE $${values.length}
        OR EXISTS (
          SELECT 1
          FROM unnest(o.offer_ids) AS offer_id
          WHERE offer_id ILIKE $${values.length}
        )
        OR o.products::text ILIKE $${values.length}
        OR COALESCE(u.phone, '') ILIKE $${values.length}
        OR COALESCE(o.shop_name, '') ILIKE $${values.length}
      )`);
        }
        where.unshift(adminDeletionClause("o", query.deletionState));
        const whereSql = `WHERE ${where.join(" AND ")}`;
        const countAndSummary = await pool.query(`
      SELECT
        count(*)::int AS total,
        COALESCE(sum(o.sales_amount), 0)::numeric(14, 2) AS sales_amount
      FROM order_postings o
      JOIN users u ON u.id = o.user_id
      ${whereSql}
      `, values);
        const listValues = [...values, query.limit, query.offset];
        const limitIndex = listValues.length - 1;
        const offsetIndex = listValues.length;
        const orders = await pool.query(`
      SELECT
        o.id,
        o.user_id,
        u.phone AS user_phone,
        u.display_name,
        o.external_shop_id,
        o.shop_name,
        o.posting_kind,
        o.posting_number,
        o.order_number,
        o.order_id,
        o.status,
        o.category,
        o.in_process_at,
        o.shipment_date,
        o.warehouse_name,
        o.tracking_number,
        o.products_count,
        o.offer_ids,
        o.products,
        o.image_url,
        COALESCE(gi.gallery_images, '[]'::json) AS gallery_images,
        o.sales_amount,
        o.currency_code,
        o.downloaded_at,
        o.synced_at
      FROM order_postings o
      JOIN users u ON u.id = o.user_id
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'sku', image_asset.sku,
            'url', image_asset.public_url,
            'thumbUrl', image_asset.thumb_url
          )
          ORDER BY array_position(o.offer_ids, image_asset.sku), image_asset.created_at DESC
        ) AS gallery_images
        FROM (
          SELECT DISTINCT ON (a.sku)
            a.sku,
            a.public_url,
            a.thumb_url,
            a.created_at
          FROM gallery_assets a
          WHERE a.deleted_at IS NULL
            AND a.sku = ANY(o.offer_ids)
            AND NOT EXISTS (
              SELECT 1
              FROM gallery_mockup_results mr
              WHERE mr.result_asset_id = a.id
            )
          ORDER BY a.sku, a.created_at DESC
        ) image_asset
      ) gi ON TRUE
      ${whereSql}
      ORDER BY COALESCE(o.in_process_at, o.shipment_date, o.synced_at) DESC
      LIMIT $${limitIndex}
      OFFSET $${offsetIndex}
      `, listValues);
        const filters = await pool.query(`
      SELECT
        COALESCE(json_agg(DISTINCT jsonb_build_object('id', u.id, 'phone', u.phone, 'displayName', u.display_name)) FILTER (WHERE u.id IS NOT NULL), '[]'::json) AS users,
        COALESCE(json_agg(DISTINCT jsonb_build_object('externalShopId', o.external_shop_id, 'shopName', o.shop_name)) FILTER (WHERE o.external_shop_id IS NOT NULL), '[]'::json) AS shops,
        COALESCE(json_agg(DISTINCT o.category) FILTER (WHERE o.category IS NOT NULL AND o.category <> ''), '[]'::json) AS categories,
        COALESCE(json_agg(DISTINCT o.status) FILTER (WHERE o.status IS NOT NULL AND o.status <> ''), '[]'::json) AS statuses
      FROM order_postings o
      JOIN users u ON u.id = o.user_id
      `);
        return {
            ok: true,
            orders: orders.rows,
            total: countAndSummary.rows[0]?.total ?? 0,
            salesAmount: countAndSummary.rows[0]?.sales_amount ?? "0",
            limit: query.limit,
            offset: query.offset,
            filters: filters.rows[0] ?? { users: [], shops: [], categories: [], statuses: [] },
        };
    });

    // ============================================================
    // RBAC: 角色与功能权限管理
    // ============================================================

    // 列出所有功能标识
    app.get("/admin/features", { preHandler: requireAdminSession }, async () => {
        const result = await pool.query(`
          SELECT key, label, module, description, default_roles, is_active, sort_order, created_at, updated_at
          FROM feature_flags
          ORDER BY sort_order
        `);
        return { ok: true, features: result.rows };
    });

    // 更新功能标识（修改 default_roles 或 is_active）
    app.put("/admin/features/:featureKey", { preHandler: requireAdminSession }, async (request) => {
        const { featureKey } = z.object({ featureKey: z.string().max(80) }).parse(request.params);
        const body = z.object({
            defaultRoles: z.array(z.enum(["member", "beta", "admin"])).optional(),
            isActive: z.boolean().optional(),
        }).parse(request.body);

        const sets: string[] = [];
        const values: unknown[] = [];
        if (body.defaultRoles !== undefined) {
            values.push(body.defaultRoles);
            sets.push(`default_roles = $${values.length}`);
        }
        if (body.isActive !== undefined) {
            values.push(body.isActive);
            sets.push(`is_active = $${values.length}`);
        }
        if (sets.length === 0) {
            throw new AppError(400, "NO_FIELDS", "没有需要更新的字段");
        }
        sets.push("updated_at = now()");
        values.push(featureKey);
        const result = await pool.query(
          `UPDATE feature_flags SET ${sets.join(", ")} WHERE key = $${values.length} RETURNING *`,
          values,
        );
        if (!result.rows[0]) throw new AppError(404, "FEATURE_NOT_FOUND", "功能标识不存在");
        // 清除缓存使变更立即生效
        invalidateFeatureFlagsCache();
        return { ok: true, feature: result.rows[0] };
    });

    // 修改用户角色
    app.put("/admin/users/:userId/role", { preHandler: requireAdminSession }, async (request) => {
        const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params);
        const body = z.object({ roles: z.array(z.enum(["member", "beta", "admin"])).min(1).max(3) }).parse(request.body);
        const roles = [...new Set(body.roles)];
        const primaryRole = roles.includes("admin") ? "admin" : roles.includes("beta") ? "beta" : "member";
        const result = await withTransaction(async (client) => {
          const user = await client.query("SELECT id, phone FROM users WHERE id = $1 FOR UPDATE", [userId]);
          if (!user.rows[0]) throw new AppError(404, "USER_NOT_FOUND", "用户不存在");
          await client.query("DELETE FROM user_roles WHERE user_id = $1", [userId]);
          await client.query("INSERT INTO user_roles (user_id, role) SELECT $1, unnest($2::text[])", [userId, roles]);
          const updated = await client.query("UPDATE users SET role = $2, updated_at = now() WHERE id = $1 RETURNING id, phone, role", [userId, primaryRole]);
          await client.query("INSERT INTO admin_audit_logs (admin_id, action, target_user_id, new_value) VALUES ($1, 'role_change', $2, $3)", [request.currentAdmin?.userId ?? null, userId, roles.join(",")]);
          return updated.rows[0];
        });
        return { ok: true, user: result, roles };
    });

    // 查看用户功能授权列表
    app.get("/admin/users/:userId/features", { preHandler: requireAdminSession }, async (request) => {
        const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params);

        const userResult = await pool.query("SELECT id, phone, role FROM users WHERE id = $1", [userId]);
        if (!userResult.rows[0]) throw new AppError(404, "USER_NOT_FOUND", "用户不存在");

        const accessResult = await pool.query(`
          SELECT ufa.feature_key, ufa.granted_at, ufa.expires_at, ufa.revoked_at,
                 ff.label, ff.module
          FROM user_feature_access ufa
          JOIN feature_flags ff ON ff.key = ufa.feature_key
          WHERE ufa.user_id = $1
          ORDER BY ufa.granted_at DESC
        `, [userId]);

        return {
            ok: true,
            user: userResult.rows[0],
            access: accessResult.rows,
        };
    });

    // 授予用户功能权限
    app.post("/admin/users/:userId/features", { preHandler: requireAdminSession }, async (request) => {
        const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params);
        const body = z.object({
            featureKey: z.string().max(80),
            expiresAt: z.string().datetime().optional(),
        }).parse(request.body);

        // 验证功能标识存在
        const flagResult = await pool.query("SELECT key FROM feature_flags WHERE key = $1 AND is_active = true", [body.featureKey]);
        if (!flagResult.rows[0]) throw new AppError(404, "FEATURE_NOT_FOUND", "功能标识不存在或已下线");

        const adminId = request.currentAdmin?.userId ?? null;
        const result = await pool.query(`
          INSERT INTO user_feature_access (user_id, feature_key, granted_by, expires_at)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (user_id, feature_key)
          DO UPDATE SET revoked_at = NULL, expires_at = $4, granted_at = now(), granted_by = $3
          RETURNING *
        `, [userId, body.featureKey, adminId, body.expiresAt ?? null]);

        await pool.query(
          `INSERT INTO admin_audit_logs (admin_id, action, target_user_id, feature_key, new_value)
           VALUES ($1, 'feature_grant', $2, $3, $4)`,
          [adminId, userId, body.featureKey, body.expiresAt ?? "permanent"],
        );

        return { ok: true, access: result.rows[0] };
    });

    // 撤销用户功能权限
    app.delete("/admin/users/:userId/features/:featureKey", { preHandler: requireAdminSession }, async (request) => {
        const { userId, featureKey } = z.object({
            userId: z.string().uuid(),
            featureKey: z.string().max(80),
        }).parse(request.params);

        const result = await pool.query(`
          UPDATE user_feature_access
          SET revoked_at = now()
          WHERE user_id = $1 AND feature_key = $2 AND revoked_at IS NULL
          RETURNING *
        `, [userId, featureKey]);

        const adminId = request.currentAdmin?.userId ?? null;
        await pool.query(
          `INSERT INTO admin_audit_logs (admin_id, action, target_user_id, feature_key)
           VALUES ($1, 'feature_revoke', $2, $3)`,
          [adminId, userId, featureKey],
        );

        return { ok: true, revoked: result.rows.length > 0 };
    });

    // 查看操作审计日志
    app.get("/admin/audit-logs", { preHandler: requireAdminSession }, async (request) => {
        const query = z.object({
            limit: z.coerce.number().int().min(1).max(100).default(20),
            offset: z.coerce.number().int().min(0).default(0),
            action: z.enum(["all", "role_change", "feature_grant", "feature_revoke"]).default("all"),
        }).parse(request.query);

        const values: unknown[] = [];
        const where: string[] = [];
        if (query.action !== "all") {
            values.push(query.action);
            where.push(`al.action = $${values.length}`);
        }
        const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

        const countResult = await pool.query(`SELECT count(*)::int AS total FROM admin_audit_logs al ${whereSql}`, values);
        const listValues = [...values, query.limit, query.offset];
        const result = await pool.query(`
          SELECT al.id, al.action, al.feature_key, al.old_value, al.new_value, al.created_at,
                 admin.phone AS admin_phone,
                 target.phone AS target_phone
          FROM admin_audit_logs al
          LEFT JOIN users admin ON admin.id = al.admin_id
          LEFT JOIN users target ON target.id = al.target_user_id
          ${whereSql}
          ORDER BY al.created_at DESC
          LIMIT $${listValues.length - 1} OFFSET $${listValues.length}
        `, listValues);

        return {
            ok: true,
            items: result.rows,
            total: countResult.rows[0]?.total ?? 0,
            limit: query.limit,
            offset: query.offset,
        };
    });
}
function multipartFieldValue(field) {
    if (!field || Array.isArray(field) || typeof field !== "object") {
        return undefined;
    }
    const value = field.value;
    return typeof value === "string" ? value : undefined;
}
function isLocalProvider(provider) {
    return provider.trim().toLowerCase() === "ollama";
}
function orderDateRangeWhere(dateFrom, dateTo, period, startIndex = 0) {
    if (dateFrom || dateTo) {
        if (dateFrom && dateTo && dateFrom > dateTo) {
            throw new AppError(400, "INVALID_ORDER_DATE_RANGE", "开始日期不能晚于结束日期");
        }
        const conditions = [];
        const values = [];
        if (dateFrom) {
            values.push(adminDateStart(dateFrom).toISOString());
            conditions.push(`COALESCE(o.in_process_at, o.shipment_date, o.synced_at) >= $${startIndex + values.length}`);
        }
        if (dateTo) {
            values.push(adminDateEndExclusive(dateTo).toISOString());
            conditions.push(`COALESCE(o.in_process_at, o.shipment_date, o.synced_at) < $${startIndex + values.length}`);
        }
        return {
            sql: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
            conditions,
            values,
        };
    }
    return orderPeriodWhere(period, startIndex);
}
function orderPeriodWhere(period, startIndex = 0) {
    if (period === "all") {
        return { sql: "", conditions: [], values: [] };
    }
    const date = period === "today"
        ? adminDateStart(todayInAdminTimezone()).toISOString()
        : new Date(Date.now() - (period === "7d" ? 7 : period === "30d" ? 30 : 365) * 24 * 60 * 60 * 1000).toISOString();
    const condition = `COALESCE(o.in_process_at, o.shipment_date, o.synced_at) >= $${startIndex + 1}`;
    return {
        sql: `WHERE ${condition}`,
        conditions: [condition],
        values: [date],
    };
}
function adminDateStart(value) {
    return new Date(`${value}T00:00:00.000+08:00`);
}
function adminDateEndExclusive(value) {
    return new Date(adminDateStart(value).getTime() + 24 * 60 * 60 * 1000);
}
function todayInAdminTimezone() {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date());
}
