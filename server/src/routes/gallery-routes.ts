// @ts-nocheck
var __defProp = Object.defineProperty;
var __name = (target, value) =>
  __defProp(target, "name", { value, configurable: true });
var __defProp2 = Object.defineProperty;
var __name2 = __name(
  (target, value) => __defProp2(target, "name", { value, configurable: true }),
  "__name",
);
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { requireAuth, requireMembership } from "../auth.js";
import { fetchAiUpstream } from "../ai-http.js";
import { readAiSettings } from "../ai-settings.js";
import { config } from "../config.js";
import { pool } from "../db.js";
import { AppError } from "../errors.js";
import { assertManualAssetsAvailableForListing } from "../auto-listing-reservation.js";
import { refreshFeaturedGallery } from "../featured-gallery.js";
import {
  getEnabledProductImageRule,
  imageMatchesAspectRatio,
  listProductImageRules,
} from "../product-image-rules.js";
import { assertRateLimit } from "../rate-limit.js";
import { newId } from "../security.js";
import {
  createDirectUploadUrl,
  objectExists,
  prepareImage,
  publicUrlForObjectKey,
  readObjectBuffer,
  readObjectMetadata,
  thumbnailObjectKeyForOriginal,
  uploadObject,
  uploadPreparedImage,
} from "../storage.js";
import { galleryAutoListingRoutes } from "./gallery-auto-listing-routes.js";
const MAX_BATCH_UPLOAD_FILES = config.LEGACY_UPLOAD_MAX_FILES;
const MAX_BATCH_UPLOAD_BYTES = config.LEGACY_UPLOAD_MAX_BYTES_MB * 1024 * 1024;
const MAX_BATCH_UPLOAD_CONCURRENCY = 2;
const MAX_ACTIVE_UPLOAD_TASKS = 2;
const UPLOAD_TASK_TEMP_ROOT = path.join(os.tmpdir(), "ozon-sjsq-upload-tasks");
const OZON_IMAGE_MAX_WIDTH = 1500;
const OZON_IMAGE_MAX_HEIGHT = 2e3;
const OZON_IMAGE_QUALITY = 50;
const SHARED_PRODUCT_TEMPLATE_SHOP_ID = "__shared__";
const SHARED_PRODUCT_TEMPLATE_SHOP_NAME =
  "\u6240\u6709\u5E97\u94FA\u5171\u7528";
const TITLE_GENERATION_GLOBAL_CONCURRENCY =
  config.TITLE_GENERATION_GLOBAL_CONCURRENCY;
const TITLE_GENERATION_USER_CONCURRENCY =
  config.TITLE_GENERATION_USER_CONCURRENCY;
const TITLE_GENERATION_QUEUE_TIMEOUT_MS = 5 * 60 * 1e3;
const TITLE_GENERATION_UPSTREAM_TIMEOUT_MS = 6e4;
const TITLE_IMAGE_DOWNLOAD_TIMEOUT_MS = 2e4;
const TITLE_IMAGE_MAX_DOWNLOAD_BYTES = 12 * 1024 * 1024;
const TITLE_IMAGE_INLINE_MAX_WIDTH = 1024;
const TITLE_IMAGE_INLINE_MAX_HEIGHT = 1024;
const DEFAULT_DAILY_LISTING_LIMIT = 300;
const activeUploadTasks = new Set();
const uploadTaskQueue = [];
let activeTitleGenerationCount = 0;
const activeTitleGenerationByUser = new Map();
const titleGenerationQueue = [];
const listQuerySchema = z.object({
  ratioFamily: z.enum(["portrait", "square", "landscape", "wide"]).optional(),
  productImageRuleId: z.string().uuid().optional(),
  keyword: z.string().max(120).optional(),
  externalShopId: z.string().trim().min(1).max(120).optional(),
  excludeAssetIds: z
    .union([z.string(), z.array(z.string()).max(2e4)])
    .optional()
    .transform((value) => {
      const items = Array.isArray(value) ? value : (value?.split(",") ?? []);
      return items
        .map((item) => item.trim())
        .filter((item) => z.string().uuid().safeParse(item).success);
    }),
  hideUsed: z.coerce.boolean().default(true),
  listingStatus: z.enum(["pending", "processing", "uploaded"]).optional(),
  mockupTemplateId: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9_-]{1,79}$/)
    .optional(),
  mockupStatus: z.enum(["all", "not_rendered", "rendered"]).default("all"),
  limit: z.coerce.number().int().min(1).max(500).default(40),
  offset: z.coerce.number().int().min(0).default(0),
  includeTotal: z.coerce.boolean().default(true),
});
const featuredListQuerySchema = z.object({
  ratioFamily: z.enum(["portrait", "square", "landscape", "wide"]).optional(),
  productImageRuleId: z.string().uuid().optional(),
  keyword: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
  offset: z.coerce.number().int().min(0).default(0),
  includeTotal: z.coerce.boolean().default(true),
});
const useAssetSchema = z.object({
  shopId: z.string().uuid(),
  usageType: z.string().max(40).default("selected"),
});
const useAssetByExternalShopSchema = z.object({
  externalShopId: z.string().min(1).max(120),
  usageType: z.string().max(40).default("selected"),
});
const salesSignalSchema = z.object({
  externalShopId: z.string().min(1).max(120),
  sku: z.string().trim().min(1).max(240),
  orderCount: z.coerce.number().int().min(0).max(1e6).default(0),
  quantity: z.coerce.number().int().min(0).max(1e6).default(0),
  lastOrderedAt: z.coerce.date().optional(),
  source: z.string().trim().max(80).default("client"),
});
const salesSignalsSyncSchema = z.object({
  signals: z.array(salesSignalSchema).min(1).max(1e3),
});
const titlePromptTemplateSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(8e3),
});
const shopProductTemplateBaseSchema = z.object({
  externalShopId: z.string().min(1).max(120).optional(),
  shared: z.boolean().optional().default(false),
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  externalTemplateId: z.string().trim().max(160).optional(),
  categoryLabel: z.string().trim().max(160).optional(),
  payload: z.unknown().optional(),
});
const shopProductTemplateSchema = shopProductTemplateBaseSchema.superRefine(
  (value, ctx) => {
    if (!value.shared && !value.externalShopId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["externalShopId"],
        message:
          "\u4FDD\u5B58\u5355\u5E97\u94FA\u6A21\u677F\u65F6\u9700\u8981\u9009\u62E9\u5E97\u94FA",
      });
    }
  },
);
const listingPreferenceShopConfigSchema = z.object({
  externalShopId: z.string().min(1).max(120),
  productTemplateId: z.string().trim().max(160).optional().default(""),
  productTemplateName: z.string().trim().max(120).optional().default(""),
  newTemplateName: z.string().trim().max(120).optional().default(""),
  categoryLabel: z.string().trim().max(160).optional().default(""),
  productTemplateShared: z.boolean().optional().default(true),
  localTemplateId: z.string().trim().max(160).optional().default(""),
  autoGenerateBarcode: z.boolean().optional().default(false),
  autoUpdateStock: z.boolean().optional().default(false),
  autoAddToAction: z.boolean().optional().default(false),
  autoWarehouseId: z
    .union([z.number().int().positive(), z.literal("")])
    .optional()
    .default(""),
  autoStock: z.coerce.number().int().min(0).max(1e6).optional().default(50),
  autoActionId: z
    .union([z.number().int().positive(), z.literal("")])
    .optional()
    .default(""),
  autoActionPrice: z.string().trim().max(80).optional().default(""),
  autoActionStock: z.coerce
    .number()
    .int()
    .min(1)
    .max(1e6)
    .optional()
    .default(50),
  actionDelayMinutes: z.coerce
    .number()
    .int()
    .min(0)
    .max(10080)
    .optional()
    .default(30),
  actionRetryCount: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(6),
  actionRetryIntervalMinutes: z.coerce
    .number()
    .int()
    .min(1)
    .max(1440)
    .optional()
    .default(30),
  dailyListingLimit: z.coerce
    .number()
    .int()
    .min(1)
    .max(1e4)
    .optional()
    .default(DEFAULT_DAILY_LISTING_LIMIT),
});
const listingConfigSnapshotSchema = z.object({
  externalShopId: z.string().min(1).max(120),
  shopName: z.string().trim().min(1).max(160).optional(),
  localShopId: z.string().trim().min(1).max(160).optional(),
  localTemplateId: z.string().trim().max(160).optional(),
  localTemplateName: z.string().trim().max(160).optional(),
  productTemplateId: z.string().trim().max(160).optional(),
  productTemplateName: z.string().trim().max(160).optional(),
  templateProduct: z.unknown().optional(),
  templateVideoLinks: z
    .array(z.string().trim().max(2e3))
    .max(20)
    .optional()
    .default([]),
  uploadTemplateVideo: z.boolean().optional().default(false),
  autoGenerateBarcode: z.boolean().optional().default(false),
  autoUpdateStock: z.boolean().optional().default(false),
  autoAddToAction: z.boolean().optional().default(false),
  autoWarehouseId: z.number().int().positive().optional(),
  autoStock: z.number().int().min(0).max(1e6).optional().default(50),
  autoActionId: z.number().int().positive().optional(),
  autoActionPrice: z.string().trim().max(80).optional(),
  autoActionStock: z.number().int().min(1).max(1e6).optional().default(50),
  postListingDelayMinutes: z
    .number()
    .int()
    .min(0)
    .max(1440)
    .optional()
    .default(0),
  actionDelayMinutes: z.number().int().min(0).max(10080).optional().default(0),
  actionRetryCount: z.number().int().min(1).max(200).optional().default(72),
  actionRetryIntervalMinutes: z
    .number()
    .int()
    .min(1)
    .max(1440)
    .optional()
    .default(10),
  dailyListingLimit: z
    .number()
    .int()
    .min(1)
    .max(1e4)
    .optional()
    .default(DEFAULT_DAILY_LISTING_LIMIT),
});
const shopProductTemplateWithSnapshotSchema =
  shopProductTemplateBaseSchema.extend({
    externalShopId: z.string().min(1).max(120),
    configSnapshot: listingConfigSnapshotSchema.optional(),
  });
const listingPreferencesSchema = z.object({
  ratioFamily: z
    .union([z.enum(["portrait", "square", "landscape", "wide"]), z.literal("")])
    .optional()
    .default(""),
  productImageRuleId: z
    .union([z.string().uuid(), z.literal("")])
    .optional()
    .default(""),
  selectedShopId: z.string().trim().max(120).optional().default(""),
  selectedMockupTemplate: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9_-]{1,79}$/)
    .optional()
    .default("fangjin"),
  selectedTitlePromptId: z
    .union([z.string().uuid(), z.literal("")])
    .optional()
    .default(""),
  titlePromptName: z.string().trim().max(80).optional().default(""),
  titlePrompt: z.string().trim().max(8e3).optional().default(""),
  shopListingConfigs: z
    .array(listingPreferenceShopConfigSchema)
    .max(200)
    .optional()
    .default([]),
});
const listingAssetSelectionSchema = z.object({
  sourceAssetId: z.string().uuid(),
  externalShopId: z.string().min(1).max(120),
  imageAssetIds: z.array(z.string().uuid()).min(1).max(20),
  title: z.string().trim().max(500).optional(),
});
const listingOccupancyCheckSchema = z.object({
  items: z
    .array(
      z.object({
        sourceAssetId: z.string().uuid(),
        externalShopId: z.string().min(1).max(120),
      }),
    )
    .min(1)
    .max(5e3),
});
const createListingBatchSchema = z.object({
  ratioFamily: z.enum(["portrait", "square", "landscape", "wide"]).optional(),
  productImageRuleId: z.string().uuid(),
  mockupTemplateId: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9_-]{1,79}$/),
  mockupTemplateName: z.string().trim().min(1).max(160),
  titlePromptTemplateId: z.string().uuid().optional(),
  titlePromptTemplateName: z.string().trim().max(120).optional(),
  titlePrompt: z.string().trim().max(8e3).optional(),
  autoListingRunId: z.string().uuid().optional(),
  shopTargets: z.array(shopProductTemplateWithSnapshotSchema).min(1).max(200),
  assets: z.array(listingAssetSelectionSchema).min(1).max(500),
});
const markListingBatchUploadedSchema = z.object({
  externalShopIds: z.array(z.string().min(1).max(120)).max(200).optional(),
  sourceAssetIds: z.array(z.string().uuid()).max(500).optional(),
});
const deleteListingUploadsSchema = z
  .object({
    batchIds: z.array(z.string().uuid()).max(500).optional().default([]),
    sourceAssetIds: z.array(z.string().uuid()).max(5e3).optional().default([]),
  })
  .refine(
    (value) => value.batchIds.length > 0 || value.sourceAssetIds.length > 0,
    {
      message:
        "\u8BF7\u9009\u62E9\u8981\u505C\u6B62\u5E76\u5220\u9664\u7684\u4E0A\u4F20\u4EFB\u52A1",
    },
  );
const updateListingRepairImagesSchema = z.object({
  items: z
    .array(
      z.object({
        batchId: z.string().uuid().optional(),
        externalShopId: z.string().min(1).max(120),
        sourceAssetId: z.string().uuid().optional(),
        sourceSku: z.string().trim().min(1).max(240),
        imageAssetIds: z.array(z.string().uuid()).min(1).max(15),
      }),
    )
    .min(1)
    .max(500),
});
const listingProgressStageSchema = z.enum([
  "mockup",
  "title",
  "listing",
  "stock",
  "barcode",
  "action",
  "workflow",
]);
const listingProgressStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "done",
  "failed",
  "skipped",
]);
const listingBatchProgressSchema = z.object({
  items: z
    .array(
      z.object({
        sourceAssetId: z.string().uuid(),
        externalShopId: z.string().trim().min(1).max(120).optional(),
        stage: listingProgressStageSchema,
        status: listingProgressStatusSchema,
        progress: z.coerce.number().int().min(0).max(100).optional(),
        overallProgress: z.coerce.number().int().min(0).max(100).optional(),
        message: z.string().trim().max(500).optional(),
        productId: z.preprocess(
          (value) => (value === null || value === "" ? void 0 : value),
          z.coerce.number().int().positive().optional(),
        ),
        completed: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(500),
});
const listingImageRepairQuerySchema = z.object({
  externalShopId: z.string().min(1).max(120).optional(),
  keyword: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});
const dailyListingStatsQuerySchema = z.object({
  dateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  dateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  externalShopId: z.string().trim().min(1).max(120).optional(),
});
const generateTitleSchema = z.object({
  sourceAssetId: z.string().uuid(),
  imageAssetId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(8e3),
});
const uploadTaskParamsSchema = z.object({ taskId: z.string().uuid() });
const uploadMetaSchema = z.object({ productImageRuleId: z.string().uuid() });
const directUploadItemSchema = z.object({
  clientItemId: z.string().min(1).max(100),
  filename: z.string().min(1).max(255),
  contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(100 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int().positive().max(5e4),
  height: z.number().int().positive().max(5e4),
  sku: z.string().min(1).max(120),
});
const directUploadBatchSchema = z.object({
  productImageRuleId: z.string().uuid(),
  items: z.array(directUploadItemSchema).min(1).max(50),
});
const legacyListingPresignSchema = z.object({
  sku: z.string().trim().min(1).max(240),
  filename: z.string().trim().min(1).max(240),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  sizeBytes: z.coerce.number().int().positive().max(MAX_BATCH_UPLOAD_BYTES),
});
const legacyListingCompleteSchema = z
  .object({ objectKey: z.string().trim().min(1).max(600) })
  .strict();
function buildLegacyListingUploadObjectKey(userId, input) {
  const sku =
    input.sku
      .trim()
      .replace(/[^\p{L}\p{N}._-]+/gu, "_")
      .replace(/^_+|_+$/g, "") || "sku";
  const ext =
    path
      .extname(input.filename)
      .toLowerCase()
      .replace(/[^.a-z0-9]/g, "") || ".jpg";
  return `legacy-listing/${userId}/${sku}/${input.requestId}${ext}`;
}
__name(buildLegacyListingUploadObjectKey, "buildLegacyListingUploadObjectKey");
__name2(buildLegacyListingUploadObjectKey, "buildLegacyListingUploadObjectKey");
function parseLegacyListingCompleteBody(body) {
  return legacyListingCompleteSchema.parse(body);
}
__name(parseLegacyListingCompleteBody, "parseLegacyListingCompleteBody");
__name2(parseLegacyListingCompleteBody, "parseLegacyListingCompleteBody");
function legacyListingStorageUsageTotals(input) {
  return {
    usedBytes:
      input.galleryBytes +
      input.confirmedLegacyBytes +
      input.reservedLegacyBytes,
  };
}
__name(legacyListingStorageUsageTotals, "legacyListingStorageUsageTotals");
__name2(legacyListingStorageUsageTotals, "legacyListingStorageUsageTotals");
function validateLegacyListingUploadQuota(usage, incomingBytes) {
  if (
    incomingBytes <= 0 ||
    usage.limitBytes <= 0 ||
    usage.usedBytes + incomingBytes <= usage.limitBytes
  ) {
    return { ok: true };
  }
  return { ok: false, code: "GALLERY_STORAGE_LIMIT_EXCEEDED" };
}
__name(validateLegacyListingUploadQuota, "validateLegacyListingUploadQuota");
__name2(validateLegacyListingUploadQuota, "validateLegacyListingUploadQuota");
function validateLegacyListingUploadGrant(userId, grant, now = new Date()) {
  if (!grant) {
    return {
      ok: false,
      status: 404,
      code: "LEGACY_LISTING_UPLOAD_GRANT_NOT_FOUND",
    };
  }
  if (grant.userId !== userId) {
    return {
      ok: false,
      status: 403,
      code: "LEGACY_LISTING_UPLOAD_GRANT_FORBIDDEN",
    };
  }
  if (!grant.completedAt && grant.expiresAt.getTime() <= now.getTime()) {
    return {
      ok: false,
      status: 410,
      code: "LEGACY_LISTING_UPLOAD_GRANT_EXPIRED",
    };
  }
  return { ok: true, completed: Boolean(grant.completedAt) };
}
__name(validateLegacyListingUploadGrant, "validateLegacyListingUploadGrant");
__name2(validateLegacyListingUploadGrant, "validateLegacyListingUploadGrant");
function validateLegacyListingUploadObjectMetadata(grant, metadata) {
  if (!metadata) {
    return { ok: false, status: 404, code: "LEGACY_LISTING_OBJECT_NOT_FOUND" };
  }
  const actualContentType = metadata.contentType
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (
    actualContentType !== grant.contentType.toLowerCase() ||
    metadata.sizeBytes !== grant.sizeBytes
  ) {
    return {
      ok: false,
      status: 409,
      code: "LEGACY_LISTING_OBJECT_METADATA_MISMATCH",
    };
  }
  return { ok: true };
}
__name(
  validateLegacyListingUploadObjectMetadata,
  "validateLegacyListingUploadObjectMetadata",
);
__name2(
  validateLegacyListingUploadObjectMetadata,
  "validateLegacyListingUploadObjectMetadata",
);
function legacyListingUploadCompleteRecord(userId, grant) {
  return {
    userId,
    sku: grant.sku,
    sourceFilename: grant.sourceFilename,
    objectKey: grant.objectKey,
    publicUrl: publicUrlForObjectKey(grant.objectKey),
    contentType: grant.contentType,
    sizeBytes: grant.sizeBytes,
  };
}
__name(legacyListingUploadCompleteRecord, "legacyListingUploadCompleteRecord");
__name2(legacyListingUploadCompleteRecord, "legacyListingUploadCompleteRecord");
function legacyListingUploadGrantFromRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    userId: row.userId,
    sku: row.sku,
    sourceFilename: row.sourceFilename,
    objectKey: row.objectKey,
    contentType: row.contentType,
    sizeBytes: Number(row.sizeBytes),
    expiresAt: new Date(row.expiresAt),
    completedAt: row.completedAt ? new Date(row.completedAt) : null,
  };
}
__name(legacyListingUploadGrantFromRow, "legacyListingUploadGrantFromRow");
__name2(legacyListingUploadGrantFromRow, "legacyListingUploadGrantFromRow");
function legacyListingUploadRecordMatches(row, record) {
  return (
    Boolean(row) &&
    row.userId === record.userId &&
    row.sku === record.sku &&
    row.sourceFilename === record.sourceFilename &&
    row.objectKey === record.objectKey &&
    row.publicUrl === record.publicUrl &&
    row.contentType === record.contentType &&
    Number(row.sizeBytes) === record.sizeBytes
  );
}
__name(legacyListingUploadRecordMatches, "legacyListingUploadRecordMatches");
__name2(legacyListingUploadRecordMatches, "legacyListingUploadRecordMatches");
async function galleryRoutes(app) {
  await app.register(galleryAutoListingRoutes);
  app.get(
    "/gallery/sync-version",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      const result = await pool.query(
        `
      SELECT COALESCE(MAX(sync_version), 0)::bigint AS version
      FROM gallery_assets
      WHERE uploaded_by_user_id = $1
      `,
        [request.currentUser.id],
      );
      return { ok: true, version: Number(result.rows[0]?.version ?? 0) };
    },
  );
  app.get(
    "/gallery/product-image-rules",
    { preHandler: [requireAuth, requireMembership] },
    async () => {
      const rules = await listProductImageRules(false);
      return { ok: true, rules };
    },
  );
  const listAssets = __name2(async (request) => {
    const query = listQuerySchema.parse(
      request.method === "POST" ? request.body : request.query,
    );
    const filterValues = [request.currentUser.id];
    const where = ["a.uploaded_by_user_id = $1", "a.deleted_at IS NULL"];
    let externalShopFilterIndex = null;
    if (query.productImageRuleId) {
      filterValues.push(query.productImageRuleId);
      const productImageRuleIndex = filterValues.length;
      where.push(
        query.listingStatus === "processing" ||
          query.listingStatus === "uploaded"
          ? `(
          a.product_image_rule_id = $${productImageRuleIndex}
          OR EXISTS (
            SELECT 1
            FROM gallery_listing_batch_assets rule_lba
            JOIN gallery_listing_batches rule_lb ON rule_lb.id = rule_lba.batch_id
            WHERE rule_lba.user_id = $1
              AND rule_lba.source_asset_id = a.id
              AND rule_lb.product_image_rule_id = $${productImageRuleIndex}
          )
        )`
          : `a.product_image_rule_id = $${productImageRuleIndex}`,
      );
    } else if (query.ratioFamily) {
      filterValues.push(query.ratioFamily);
      where.push(`a.ratio_family = $${filterValues.length}`);
    }
    if (query.keyword) {
      filterValues.push(`%${query.keyword}%`);
      where.push(`a.sku ILIKE $${filterValues.length}`);
    }
    if (query.excludeAssetIds.length > 0) {
      filterValues.push(query.excludeAssetIds);
      where.push(`a.id <> ALL($${filterValues.length}::uuid[])`);
    }
    if (query.externalShopId) {
      filterValues.push(query.externalShopId);
      externalShopFilterIndex = filterValues.length;
      if (query.listingStatus === "uploaded") {
        where.push(`(
          EXISTS (
            SELECT 1
            FROM gallery_listing_batch_assets lba
            JOIN gallery_listing_batches lb ON lb.id = lba.batch_id
            LEFT JOIN gallery_listing_batch_shops lbs ON lbs.batch_id = lba.batch_id AND lbs.shop_id = lba.shop_id
            WHERE lba.user_id = $1
              AND lba.source_asset_id = a.id
              AND lba.external_shop_id = $${externalShopFilterIndex}
              AND (lb.status = 'uploaded' OR lbs.status = 'uploaded' OR lba.listing_product_id IS NOT NULL OR lba.listing_completed_at IS NOT NULL)
          )
          OR EXISTS (
            SELECT 1
            FROM gallery_usage u
            JOIN shops s ON s.id = u.shop_id
            WHERE u.user_id = $1
              AND u.sku = a.sku
              AND u.usage_type = 'uploaded'
              AND s.external_shop_id = $${externalShopFilterIndex}
          )
        )`);
      } else if (query.listingStatus === "processing") {
        where.push(`EXISTS (
          SELECT 1
          FROM gallery_listing_batch_assets lba
          JOIN gallery_listing_batches lb ON lb.id = lba.batch_id
          LEFT JOIN gallery_listing_batch_shops lbs ON lbs.batch_id = lba.batch_id AND lbs.shop_id = lba.shop_id
          WHERE lba.user_id = $1
            AND lba.source_asset_id = a.id
            AND lba.external_shop_id = $${externalShopFilterIndex}
            AND NOT (lb.status = 'uploaded' OR lbs.status = 'uploaded' OR lba.listing_completed_at IS NOT NULL)
        )`);
      } else {
        where.push(`EXISTS (
          SELECT 1
          FROM gallery_listing_batch_assets lba
          WHERE lba.user_id = $1
            AND lba.source_asset_id = a.id
            AND lba.external_shop_id = $${externalShopFilterIndex}
        )`);
      }
    }
    if (
      query.hideUsed &&
      query.listingStatus !== "processing" &&
      query.listingStatus !== "uploaded"
    ) {
      where.push(
        "NOT EXISTS (SELECT 1 FROM gallery_usage u WHERE u.user_id = $1 AND u.sku = a.sku)",
      );
      where.push(
        "NOT EXISTS (SELECT 1 FROM gallery_listing_batch_assets lba WHERE lba.user_id = $1 AND lba.source_sku = a.sku)",
      );
    }
    if (query.listingStatus === "pending") {
      where.push(
        "NOT EXISTS (SELECT 1 FROM gallery_usage u WHERE u.user_id = $1 AND u.sku = a.sku AND u.usage_type = 'uploaded')",
      );
      where.push(
        "NOT EXISTS (SELECT 1 FROM gallery_listing_batch_assets lba WHERE lba.user_id = $1 AND lba.source_asset_id = a.id)",
      );
    }
    if (query.listingStatus === "processing") {
      where.push(`EXISTS (
        SELECT 1
        FROM gallery_listing_batch_assets lba
        JOIN gallery_listing_batches lb ON lb.id = lba.batch_id
        LEFT JOIN gallery_listing_batch_shops lbs ON lbs.batch_id = lba.batch_id AND lbs.shop_id = lba.shop_id
        WHERE lba.user_id = $1
          AND lba.source_asset_id = a.id
          AND NOT (lb.status = 'uploaded' OR lbs.status = 'uploaded' OR lba.listing_completed_at IS NOT NULL)
      )`);
    }
    if (query.listingStatus === "uploaded") {
      where.push(`(
        EXISTS (SELECT 1 FROM gallery_usage u WHERE u.user_id = $1 AND u.sku = a.sku AND u.usage_type = 'uploaded')
        OR EXISTS (
          SELECT 1
          FROM gallery_listing_batch_assets lba
          JOIN gallery_listing_batches lb ON lb.id = lba.batch_id
          JOIN gallery_listing_batch_shops lbs ON lbs.batch_id = lba.batch_id AND lbs.shop_id = lba.shop_id
          WHERE lba.user_id = $1
            AND lba.source_asset_id = a.id
            AND (lb.status = 'uploaded' OR lbs.status = 'uploaded' OR lba.listing_product_id IS NOT NULL OR lba.listing_completed_at IS NOT NULL)
        )
      )`);
    }
    if (query.mockupStatus !== "all") {
      if (!query.mockupTemplateId) {
        throw new AppError(
          400,
          "MOCKUP_TEMPLATE_REQUIRED",
          "\u8BF7\u5148\u9009\u62E9\u6837\u673A\u540E\u518D\u7B5B\u9009\u5957\u56FE\u72B6\u6001",
        );
      }
      filterValues.push(query.mockupTemplateId);
      const templateIndex = filterValues.length;
      const statusSql = `
        SELECT 1
        FROM gallery_mockup_results ms
        WHERE ms.user_id = $1
          AND ms.source_asset_id = a.id
          AND ms.template_id = $${templateIndex}
      `;
      where.push(
        query.mockupStatus === "not_rendered"
          ? `NOT EXISTS (${statusSql})`
          : `EXISTS (${statusSql})`,
      );
    }
    where.push("a.sku !~ '-fangjin-[0-9]+$'");
    where.push(
      "NOT EXISTS (SELECT 1 FROM gallery_mockup_results mr WHERE mr.user_id = $1 AND mr.result_asset_id = a.id)",
    );
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const listingBatchStatusSql =
      query.listingStatus === "processing"
        ? "AND NOT (b.status = 'uploaded' OR bs.status = 'uploaded' OR lba.listing_completed_at IS NOT NULL)"
        : query.listingStatus === "uploaded"
          ? "AND (b.status = 'uploaded' OR bs.status = 'uploaded')"
          : "";
    const usageStatusSql =
      query.listingStatus === "uploaded" ? "AND u.usage_type = 'uploaded'" : "";
    const total = query.includeTotal
      ? await countGalleryAssets(whereSql, filterValues)
      : void 0;
    const values = [...filterValues];
    let mockupResultTemplateIndex = null;
    if (query.mockupTemplateId) {
      values.push(query.mockupTemplateId);
      mockupResultTemplateIndex = values.length;
    }
    values.push(query.limit, query.offset);
    const limitIndex = values.length - 1;
    const offsetIndex = values.length;
    const result = await pool.query(
      `
      SELECT
        a.id,
        a.sku,
        a.sha256,
        a.ratio::float AS ratio,
        a.ratio_family AS "ratioFamily",
        a.product_image_rule_id AS "productImageRuleId",
        a.product_type AS "productType",
        a.aspect_ratio AS "aspectRatio",
        a.width,
        a.height,
        a.public_url AS "publicUrl",
        a.thumb_url AS "thumbUrl",
        a.content_type AS "contentType",
        a.size_bytes AS "sizeBytes",
        a.source_filename AS "sourceFilename",
        a.created_at AS "createdAt",
        a.generated_title AS "generatedTitle",
        a.generated_title_image_asset_id AS "generatedTitleImageAssetId",
        a.generated_title_prompt AS "generatedTitlePrompt",
        a.generated_title_updated_at AS "generatedTitleUpdatedAt",
        COALESCE(mr.mockup_results, '[]'::json) AS "mockupResults",
        COALESCE(ls.listing_status, lu.listing_status) AS "listingStatus"
      FROM gallery_assets a
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'id', r.id,
            'sku', r.sku,
            'sha256', r.sha256,
            'ratio', r.ratio::float,
            'ratioFamily', r.ratio_family,
            'productImageRuleId', r.product_image_rule_id,
            'productType', r.product_type,
            'aspectRatio', r.aspect_ratio,
            'width', r.width,
            'height', r.height,
            'publicUrl', r.public_url,
            'thumbUrl', r.thumb_url,
            'contentType', r.content_type,
            'sizeBytes', r.size_bytes,
            'sourceFilename', r.source_filename,
            'createdAt', r.created_at,
            'generatedTitle', r.generated_title,
            'generatedTitleImageAssetId', r.generated_title_image_asset_id,
            'generatedTitlePrompt', r.generated_title_prompt,
            'generatedTitleUpdatedAt', r.generated_title_updated_at,
            'templateId', m.template_id,
            'templateName', m.template_name,
            'sceneIndex', m.scene_index
          )
          ORDER BY m.template_id, m.scene_index
        ) AS mockup_results
        FROM gallery_mockup_results m
        JOIN gallery_assets r ON r.id = m.result_asset_id
        WHERE m.user_id = $1 AND m.source_asset_id = a.id AND r.deleted_at IS NULL
          ${mockupResultTemplateIndex ? `AND m.template_id = $${mockupResultTemplateIndex}` : ""}
      ) mr ON TRUE
      LEFT JOIN LATERAL (
        SELECT json_build_object(
          'batchId', b.id,
          'status', b.status,
          'title', lba.title,
          'uploadedAt', bs.uploaded_at,
          'stage', lba.listing_stage,
          'progress', lba.listing_progress,
          'stageMessage', lba.listing_stage_message,
          'stageProgress', lba.stage_progress,
          'productId', lba.listing_product_id,
          'completedAt', lba.listing_completed_at,
          'shops', json_build_array(json_build_object(
            'externalShopId', lba.external_shop_id,
            'shopName', lba.shop_name,
            'productTemplateName', lba.product_template_name,
            'status', COALESCE(bs.status, b.status),
            'stage', lba.listing_stage,
            'progress', lba.listing_progress,
            'stageMessage', lba.listing_stage_message
          ))
        ) AS listing_status
        FROM gallery_listing_batch_assets lba
        JOIN gallery_listing_batches b ON b.id = lba.batch_id
        LEFT JOIN gallery_listing_batch_shops bs ON bs.batch_id = lba.batch_id AND bs.shop_id = lba.shop_id
        WHERE lba.user_id = $1 AND lba.source_asset_id = a.id
          ${externalShopFilterIndex ? `AND lba.external_shop_id = $${externalShopFilterIndex}` : ""}
          ${listingBatchStatusSql}
        ORDER BY lba.updated_at DESC
        LIMIT 1
      ) ls ON TRUE
      LEFT JOIN LATERAL (
        SELECT json_build_object(
          'batchId', '',
          'status', CASE WHEN u.usage_type = 'uploaded' THEN 'uploaded' ELSE 'prepared' END,
          'title', NULL,
          'uploadedAt', u.used_at,
          'shops', json_agg(json_build_object(
            'externalShopId', s.external_shop_id,
            'shopName', s.name,
            'productTemplateName', '',
            'status', CASE WHEN u.usage_type = 'uploaded' THEN 'uploaded' ELSE 'prepared' END
          ) ORDER BY u.used_at DESC)
        ) AS listing_status
        FROM gallery_usage u
        JOIN shops s ON s.id = u.shop_id
        WHERE u.user_id = $1 AND u.sku = a.sku
          ${externalShopFilterIndex ? `AND s.external_shop_id = $${externalShopFilterIndex}` : ""}
          ${usageStatusSql}
        GROUP BY u.usage_type, u.used_at
        ORDER BY u.used_at DESC
        LIMIT 1
      ) lu ON TRUE
      ${whereSql}
      ORDER BY a.created_at DESC
      LIMIT $${limitIndex}
      OFFSET $${offsetIndex}
      `,
      values,
    );
    return {
      ok: true,
      assets: result.rows,
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }, "listAssets");
  app.get(
    "/gallery/assets",
    { preHandler: [requireAuth, requireMembership] },
    listAssets,
  );
  app.post(
    "/gallery/assets/query",
    { preHandler: [requireAuth, requireMembership] },
    listAssets,
  );
  app.get(
    "/gallery/featured-assets",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      const query = featuredListQuerySchema.parse(request.query);
      const filterValues = [];
      const where = [
        "f.status = 'active'",
        "f.deleted_at IS NULL",
        "a.deleted_at IS NULL",
      ];
      if (query.productImageRuleId) {
        filterValues.push(query.productImageRuleId);
        where.push(`a.product_image_rule_id = $${filterValues.length}`);
      } else if (query.ratioFamily) {
        filterValues.push(query.ratioFamily);
        where.push(`a.ratio_family = $${filterValues.length}`);
      }
      if (query.keyword) {
        filterValues.push(`%${query.keyword}%`);
        where.push(`f.sku ILIKE $${filterValues.length}`);
      }
      const whereSql = `WHERE ${where.join(" AND ")}`;
      const total = query.includeTotal
        ? await countFeaturedGalleryAssets(whereSql, filterValues)
        : void 0;
      const values = [...filterValues, query.limit, query.offset];
      const limitIndex = values.length - 1;
      const offsetIndex = values.length;
      const result = await pool.query(
        `
      SELECT
        a.id,
        f.sku,
        a.sha256,
        a.ratio::float AS ratio,
        a.ratio_family AS "ratioFamily",
        a.product_image_rule_id AS "productImageRuleId",
        a.product_type AS "productType",
        a.aspect_ratio AS "aspectRatio",
        a.width,
        a.height,
        a.public_url AS "publicUrl",
        a.thumb_url AS "thumbUrl",
        a.content_type AS "contentType",
        a.size_bytes AS "sizeBytes",
        f.sku AS "sourceFilename",
        a.created_at AS "createdAt",
        a.generated_title AS "generatedTitle",
        a.generated_title_image_asset_id AS "generatedTitleImageAssetId",
        a.generated_title_prompt AS "generatedTitlePrompt",
        a.generated_title_updated_at AS "generatedTitleUpdatedAt",
        f.score,
        f.order_count AS "orderCount",
        f.distinct_user_count AS "distinctUserCount",
        f.distinct_shop_count AS "distinctShopCount",
        f.last_ordered_at AS "lastOrderedAt",
        f.reason
      FROM featured_gallery_assets f
      JOIN gallery_assets a ON a.id = f.asset_id
      ${whereSql}
      ORDER BY f.score DESC, f.last_ordered_at DESC NULLS LAST, f.updated_at DESC
      LIMIT $${limitIndex}
      OFFSET $${offsetIndex}
      `,
        values,
      );
      return {
        ok: true,
        assets: result.rows,
        total,
        limit: query.limit,
        offset: query.offset,
      };
    },
  );
  app.get(
    "/gallery/listing-image-repairs",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      const query = listingImageRepairQuerySchema.parse(request.query);
      const result = await listListingImageRepairItems(
        request.currentUser.id,
        query,
      );
      return { ok: true, ...result };
    },
  );
  async function countGalleryAssets(whereSql, values) {
    const countResult = await pool.query(
      `
      SELECT count(*)::int AS total
      FROM gallery_assets a
      ${whereSql}
      `,
      values,
    );
    return countResult.rows[0]?.total ?? 0;
  }
  __name(countGalleryAssets, "countGalleryAssets");
  __name2(countGalleryAssets, "countGalleryAssets");
  async function countFeaturedGalleryAssets(whereSql, values) {
    const countResult = await pool.query(
      `
      SELECT count(*)::int AS total
      FROM featured_gallery_assets f
      JOIN gallery_assets a ON a.id = f.asset_id
      ${whereSql}
      `,
      values,
    );
    return countResult.rows[0]?.total ?? 0;
  }
  __name(countFeaturedGalleryAssets, "countFeaturedGalleryAssets");
  __name2(countFeaturedGalleryAssets, "countFeaturedGalleryAssets");
  app.post(
    "/gallery/listing-image-repairs/images",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      const body = updateListingRepairImagesSchema.parse(request.body);
      const userId = request.currentUser.id;
      const items = [];
      const errors = [];
      for (const item of body.items) {
        try {
          const imageUrls = await resolveOzonListingImageUrls(
            userId,
            item.imageAssetIds,
          );
          const updated = await updateListingRepairImageRecord(
            userId,
            item,
            imageUrls,
          );
          if (!updated) {
            errors.push({
              sourceSku: item.sourceSku,
              externalShopId: item.externalShopId,
              message: "Uploaded listing record not found",
            });
            continue;
          }
          items.push(updated);
        } catch (error) {
          errors.push({
            sourceSku: item.sourceSku,
            externalShopId: item.externalShopId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { ok: errors.length === 0, updated: items.length, items, errors };
    },
  );
  app.post(
    "/gallery/sales-signals/sync",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      const body = salesSignalsSyncSchema.parse(request.body);
      const userId = request.currentUser.id;
      const externalShopIds = [
        ...new Set(body.signals.map((signal) => signal.externalShopId)),
      ];
      const shopsResult = await pool.query(
        `
      SELECT id, external_shop_id
      FROM shops
      WHERE user_id = $1 AND external_shop_id = ANY($2::text[])
      `,
        [userId, externalShopIds],
      );
      const shopIdByExternalId = new Map(
        shopsResult.rows.map((row) => [
          String(row.external_shop_id),
          String(row.id),
        ]),
      );
      const missingShopIds = externalShopIds.filter(
        (externalShopId) => !shopIdByExternalId.has(externalShopId),
      );
      if (missingShopIds.length) {
        throw new AppError(
          404,
          "SHOP_NOT_SYNCED",
          `\u6709 ${missingShopIds.length} \u4E2A\u5E97\u94FA\u8FD8\u6CA1\u6709\u540C\u6B65\u5230\u4E91\u7AEF\uFF0C\u8BF7\u5148\u540C\u6B65\u5E97\u94FA`,
        );
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        let synced = 0;
        for (const signal of body.signals) {
          const shopId = shopIdByExternalId.get(signal.externalShopId);
          if (!shopId) {
            continue;
          }
          await client.query(
            `
          INSERT INTO product_sales_signals (
            id,
            user_id,
            shop_id,
            external_shop_id,
            sku,
            order_count,
            quantity,
            last_ordered_at,
            source,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, now()), $9, now())
          ON CONFLICT (user_id, shop_id, sku)
          DO UPDATE SET
            external_shop_id = excluded.external_shop_id,
            order_count = GREATEST(product_sales_signals.order_count, excluded.order_count),
            quantity = GREATEST(product_sales_signals.quantity, excluded.quantity),
            last_ordered_at = GREATEST(product_sales_signals.last_ordered_at, excluded.last_ordered_at),
            source = excluded.source,
            updated_at = now()
          `,
            [
              newId(),
              userId,
              shopId,
              signal.externalShopId,
              signal.sku,
              signal.orderCount,
              signal.quantity,
              signal.lastOrderedAt ?? null,
              signal.source,
            ],
          );
          synced += 1;
        }
        const refreshed = await refreshFeaturedGallery(client);
        await client.query("COMMIT");
        return { ok: true, synced, featuredUpdated: refreshed };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );
  app.get(
    "/gallery/title-prompts",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      const result = await pool.query(
        `
      SELECT
        id,
        name,
        prompt,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM title_prompt_templates
      WHERE user_id = $1
      ORDER BY updated_at DESC, name ASC
      `,
        [request.currentUser.id],
      );
      return { ok: true, templates: result.rows };
    },
  );
  app.post(
    "/gallery/title-prompts",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      const body = titlePromptTemplateSchema.parse(request.body);
      if (body.id) {
        const result2 = await pool.query(
          `
        UPDATE title_prompt_templates
        SET name = $3, prompt = $4, updated_at = now()
        WHERE id = $1 AND user_id = $2
        RETURNING
          id,
          name,
          prompt,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        `,
          [body.id, request.currentUser.id, body.name, body.prompt],
        );
        if (result2.rowCount) {
          return { ok: true, template: result2.rows[0] };
        }
      }
      const result = await pool.query(
        `
      INSERT INTO title_prompt_templates (id, user_id, name, prompt)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, name)
      DO UPDATE SET
        prompt = excluded.prompt,
        updated_at = now()
      RETURNING
        id,
        name,
        prompt,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      `,
        [body.id ?? newId(), request.currentUser.id, body.name, body.prompt],
      );
      return { ok: true, template: result.rows[0] };
    },
  );
  app.get(
    "/gallery/product-templates",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      const query = z
        .object({ externalShopId: z.string().min(1).max(120).optional() })
        .parse(request.query);
      const values = [request.currentUser.id];
      const where = ["t.user_id = $1"];
      if (query.externalShopId) {
        values.push(query.externalShopId);
        where.push(
          `(t.shop_id IS NULL OR s.external_shop_id = $${values.length})`,
        );
      }
      const result = await pool.query(
        `
      SELECT
        t.id,
        COALESCE(s.external_shop_id, '${SHARED_PRODUCT_TEMPLATE_SHOP_ID}') AS "externalShopId",
        COALESCE(s.name, '${SHARED_PRODUCT_TEMPLATE_SHOP_NAME}') AS "shopName",
        (t.shop_id IS NULL) AS shared,
        t.name,
        t.external_template_id AS "externalTemplateId",
        t.category_label AS "categoryLabel",
        t.payload,
        t.created_at AS "createdAt",
        t.updated_at AS "updatedAt"
      FROM shop_product_templates t
      LEFT JOIN shops s ON s.id = t.shop_id
      WHERE ${where.join(" AND ")}
      ORDER BY (t.shop_id IS NULL) DESC, s.name ASC NULLS FIRST, t.updated_at DESC
      `,
        values,
      );
      return { ok: true, templates: result.rows };
    },
  );
  app.post(
    "/gallery/product-templates",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      const body = shopProductTemplateSchema.parse(request.body);
      const userId = request.currentUser.id;
      const shared =
        body.shared || body.externalShopId === SHARED_PRODUCT_TEMPLATE_SHOP_ID;
      const shop = shared
        ? null
        : await findUserShopByExternalId(userId, body.externalShopId);
      if (body.id) {
        const result2 = await pool.query(
          `
        UPDATE shop_product_templates
        SET
          shop_id = $3,
          name = $4,
          external_template_id = $5,
          category_label = $6,
          payload = $7,
          updated_at = now()
        WHERE id = $1 AND user_id = $2
        RETURNING
          id,
          name,
          external_template_id AS "externalTemplateId",
          category_label AS "categoryLabel",
          payload,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        `,
          [
            body.id,
            userId,
            shop?.id ?? null,
            body.name,
            body.externalTemplateId || null,
            body.categoryLabel || null,
            body.payload === void 0 ? null : JSON.stringify(body.payload),
          ],
        );
        if (result2.rowCount) {
          return {
            ok: true,
            template: {
              ...result2.rows[0],
              externalShopId:
                shop?.externalShopId ?? SHARED_PRODUCT_TEMPLATE_SHOP_ID,
              shopName: shop?.name ?? SHARED_PRODUCT_TEMPLATE_SHOP_NAME,
              shared: shop ? false : true,
            },
          };
        }
      }
      if (shared) {
        const result2 = await pool.query(
          `
        INSERT INTO shop_product_templates (
          id,
          user_id,
          shop_id,
          name,
          external_template_id,
          category_label,
          payload
        )
        VALUES ($1, $2, NULL, $3, $4, $5, $6)
        ON CONFLICT (user_id, name) WHERE shop_id IS NULL
        DO UPDATE SET
          external_template_id = excluded.external_template_id,
          category_label = excluded.category_label,
          payload = excluded.payload,
          updated_at = now()
        RETURNING
          id,
          name,
          external_template_id AS "externalTemplateId",
          category_label AS "categoryLabel",
          payload,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        `,
          [
            newId(),
            userId,
            body.name,
            body.externalTemplateId || null,
            body.categoryLabel || null,
            body.payload === void 0 ? null : JSON.stringify(body.payload),
          ],
        );
        return {
          ok: true,
          template: {
            ...result2.rows[0],
            externalShopId: SHARED_PRODUCT_TEMPLATE_SHOP_ID,
            shopName: SHARED_PRODUCT_TEMPLATE_SHOP_NAME,
            shared: true,
          },
        };
      }
      const result = await pool.query(
        `
      INSERT INTO shop_product_templates (
        id,
        user_id,
        shop_id,
        name,
        external_template_id,
        category_label,
        payload
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (user_id, shop_id, name)
      DO UPDATE SET
        external_template_id = excluded.external_template_id,
        category_label = excluded.category_label,
        payload = excluded.payload,
        updated_at = now()
      RETURNING
        id,
        name,
        external_template_id AS "externalTemplateId",
        category_label AS "categoryLabel",
        payload,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      `,
        [
          body.id ?? newId(),
          userId,
          shop.id,
          body.name,
          body.externalTemplateId || null,
          body.categoryLabel || null,
          body.payload === void 0 ? null : JSON.stringify(body.payload),
        ],
      );
      return {
        ok: true,
        template: {
          ...result.rows[0],
          externalShopId: shop.externalShopId,
          shopName: shop.name,
          shared: false,
        },
      };
    },
  );
  app.get(
    "/gallery/listing-preferences",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      const result = await pool.query(
        `
      SELECT preferences, updated_at AS "updatedAt"
      FROM gallery_listing_preferences
      WHERE user_id = $1
      LIMIT 1
      `,
        [request.currentUser.id],
      );
      const row = result.rows[0];
      return {
        ok: true,
        preferences: row
          ? listingPreferencesSchema.parse(row.preferences)
          : listingPreferencesSchema.parse({}),
        updatedAt: row?.updatedAt ?? null,
      };
    },
  );
  app.put(
    "/gallery/listing-preferences",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      const preferences = listingPreferencesSchema.parse(request.body);
      const result = await pool.query(
        `
      INSERT INTO gallery_listing_preferences (user_id, preferences, updated_at)
      VALUES ($1, $2, now())
      ON CONFLICT (user_id)
      DO UPDATE SET
        preferences = excluded.preferences,
        updated_at = now()
      RETURNING preferences, updated_at AS "updatedAt"
      `,
        [request.currentUser.id, JSON.stringify(preferences)],
      );
      return {
        ok: true,
        preferences: listingPreferencesSchema.parse(result.rows[0].preferences),
        updatedAt: result.rows[0].updatedAt,
      };
    },
  );
  app.post(
    "/gallery/titles/generate",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      const body = generateTitleSchema.parse(request.body);
      const userId = request.currentUser.id;
      await assertRateLimit({
        key: `title-generation:${userId}`,
        limit: 30,
        windowMs: 6e4,
        code: "TITLE_GENERATION_RATE_LIMITED",
        message:
          "\u6807\u9898\u751F\u6210\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
      });
      const result = await pool.query(
        `
      SELECT
        source.id AS "sourceAssetId",
        source.sku AS "sourceSku",
        source.public_url AS "sourceUrl",
        source.thumb_url AS "sourceThumbUrl",
        source.generated_title AS "generatedTitle",
        source.generated_title_image_asset_id AS "generatedTitleImageAssetId",
        source.generated_title_prompt AS "generatedTitlePrompt",
        source.generated_title_updated_at AS "generatedTitleUpdatedAt",
        image.id AS "imageAssetId",
        image.public_url AS "imageUrl",
        image.thumb_url AS "imageThumbUrl"
      FROM gallery_assets source
      JOIN gallery_assets image ON image.id = $3 AND image.uploaded_by_user_id = $1 AND image.deleted_at IS NULL
      WHERE source.id = $2
        AND source.uploaded_by_user_id = $1
        AND source.deleted_at IS NULL
        AND (
          image.id = source.id
          OR EXISTS (
            SELECT 1
            FROM gallery_mockup_results mr
            WHERE mr.user_id = $1
              AND mr.source_asset_id = source.id
              AND mr.result_asset_id = image.id
          )
        )
      LIMIT 1
      `,
        [userId, body.sourceAssetId, body.imageAssetId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new AppError(
          404,
          "TITLE_IMAGE_NOT_FOUND",
          "\u6807\u9898\u53C2\u8003\u56FE\u4E0D\u5B58\u5728\uFF0C\u6216\u4E0D\u662F\u8BE5\u539F\u56FE\u751F\u6210\u7684\u5957\u56FE",
        );
      }
      const existingTitle =
        typeof row.generatedTitle === "string" ? row.generatedTitle.trim() : "";
      if (existingTitle) {
        return {
          ok: true,
          title: existingTitle,
          sourceAssetId: row.sourceAssetId,
          imageAssetId: row.generatedTitleImageAssetId ?? row.imageAssetId,
          cached: true,
          asset: {
            id: row.sourceAssetId,
            sku: row.sourceSku,
            generatedTitle: existingTitle,
            generatedTitleImageAssetId: row.generatedTitleImageAssetId,
            generatedTitlePrompt: row.generatedTitlePrompt,
            generatedTitleUpdatedAt: row.generatedTitleUpdatedAt,
          },
        };
      }
      const prompt = fillTitlePrompt(body.prompt, {
        sku: row.sourceSku,
        sourceUrl: row.sourceUrl,
        imageUrl: row.imageUrl,
      });
      const title = await runWithTitleGenerationLimit(userId, () =>
        generateTitleFromImage(
          prompt,
          [
            row.imageUrl,
            row.imageThumbUrl,
            row.sourceUrl,
            row.sourceThumbUrl,
          ].filter(
            (value) => typeof value === "string" && value.trim().length > 0,
          ),
        ),
      );
      const updatedAsset = await pool.query(
        `
      UPDATE gallery_assets
      SET generated_title = $3,
          generated_title_image_asset_id = $4,
          generated_title_prompt = $5,
          generated_title_updated_at = now()
      WHERE id = $1
        AND uploaded_by_user_id = $2
        AND deleted_at IS NULL
      RETURNING
        id,
        sku,
        generated_title AS "generatedTitle",
        generated_title_image_asset_id AS "generatedTitleImageAssetId",
        generated_title_prompt AS "generatedTitlePrompt",
        generated_title_updated_at AS "generatedTitleUpdatedAt"
      `,
        [row.sourceAssetId, userId, title, row.imageAssetId, body.prompt],
      );
      return {
        ok: true,
        title,
        sourceAssetId: row.sourceAssetId,
        imageAssetId: row.imageAssetId,
        asset: updatedAsset.rows[0] ?? null,
      };
    },
  );
  app.post(
    "/gallery/listing-batches",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      const body = createListingBatchSchema.parse(request.body);
      const userId = request.currentUser.id;
      const batch = await createListingBatch(userId, body);
      return { ok: true, batch };
    },
  );
  app.post(
    "/gallery/listing-occupancy/check",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      const body = listingOccupancyCheckSchema.parse(request.body);
      const userId = request.currentUser.id;
      const result = await pool.query(
        `
      WITH selected AS (
        SELECT DISTINCT input.source_asset_id, input.external_shop_id
        FROM jsonb_to_recordset($2::jsonb) AS input(source_asset_id uuid, external_shop_id text)
      ), resolved AS (
        SELECT selected.source_asset_id, selected.external_shop_id, asset.sku, shop.id AS shop_id
        FROM selected
        JOIN gallery_assets asset ON asset.id = selected.source_asset_id
          AND asset.uploaded_by_user_id = $1 AND asset.deleted_at IS NULL
        JOIN shops shop ON shop.user_id = $1 AND shop.external_shop_id = selected.external_shop_id
      )
      SELECT DISTINCT resolved.source_asset_id AS "sourceAssetId", resolved.external_shop_id AS "externalShopId"
      FROM resolved
      WHERE EXISTS (
        SELECT 1 FROM gallery_usage usage
        WHERE usage.user_id = $1 AND usage.shop_id = resolved.shop_id AND usage.sku = resolved.sku
      ) OR EXISTS (
        SELECT 1 FROM gallery_listing_batch_assets batch_asset
        WHERE batch_asset.user_id = $1 AND batch_asset.shop_id = resolved.shop_id
          AND batch_asset.source_sku = resolved.sku
      )
      `,
        [
          userId,
          JSON.stringify(
            body.items.map((item) => ({
              source_asset_id: item.sourceAssetId,
              external_shop_id: item.externalShopId,
            })),
          ),
        ],
      );
      return { ok: true, occupied: result.rows };
    },
  );
  app.get(
    "/gallery/listing-batches",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      const query = z
        .object({
          status: z.enum(["prepared", "uploaded", "failed"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
        })
        .parse(request.query);
      const values = [request.currentUser.id];
      const where = ["user_id = $1"];
      if (query.status) {
        values.push(query.status);
        where.push(`status = $${values.length}`);
      }
      if (query.status === "prepared") {
        where.push(`EXISTS (
        SELECT 1
        FROM gallery_listing_batch_assets pending_asset
        WHERE pending_asset.batch_id = gallery_listing_batches.id
          AND pending_asset.listing_completed_at IS NULL
      )`);
      }
      values.push(query.limit);
      const result = await pool.query(
        `SELECT id FROM gallery_listing_batches WHERE ${where.join(" AND ")} ORDER BY created_at ASC LIMIT $${values.length}`,
        values,
      );
      const batches = await Promise.all(
        result.rows.map((row) =>
          readListingBatch(request.currentUser.id, row.id, false),
        ),
      );
      return { ok: true, batches };
    },
  );
  app.get(
    "/gallery/listing-batches/:batchId",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      const params = z
        .object({ batchId: z.string().uuid() })
        .parse(request.params);
      const userId = request.currentUser.id;
      const batch = await readListingBatch(userId, params.batchId);
      return { ok: true, batch };
    },
  );
  app.delete(
    "/gallery/listing-uploads",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      const body = deleteListingUploadsSchema.parse(request.body ?? {});
      const userId = request.currentUser.id;
      const result = await deleteListingUploads(
        userId,
        body.batchIds,
        body.sourceAssetIds,
      );
      return { ok: true, ...result };
    },
  );
  app.post(
    "/gallery/listing-batches/:batchId/mark-uploaded",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      const params = z
        .object({ batchId: z.string().uuid() })
        .parse(request.params);
      const query = z
        .object({ compact: z.coerce.boolean().optional() })
        .parse(request.query ?? {});
      const body = markListingBatchUploadedSchema.parse(request.body ?? {});
      const userId = request.currentUser.id;
      const batch = await markListingBatchUploaded(
        userId,
        params.batchId,
        body,
        !query.compact,
      );
      return query.compact ? { ok: true } : { ok: true, batch };
    },
  );
  app.post(
    "/gallery/listing-batches/:batchId/progress",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      const params = z
        .object({ batchId: z.string().uuid() })
        .parse(request.params);
      const body = listingBatchProgressSchema.parse(request.body ?? {});
      const userId = request.currentUser.id;
      await updateListingBatchProgress(userId, params.batchId, body);
      return { ok: true };
    },
  );
  app.get(
    "/gallery/listing-stats/daily",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      const query = dailyListingStatsQuerySchema.parse(request.query);
      const stats = await listDailyListingStats(request.currentUser.id, query);
      return { ok: true, stats };
    },
  );
  app.get(
    "/gallery/listing-reconciliation",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      const query = dailyListingStatsQuerySchema.parse(request.query);
      const summary = await listListingReconciliation(
        request.currentUser.id,
        query,
      );
      return { ok: true, summary };
    },
  );
  app.post(
    "/legacy-listing/uploads/presign",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      await assertRateLimit({
        key: `legacy-listing:presign:${request.currentUser.id}`,
        limit: 240,
        windowMs: 6e4,
        code: "LEGACY_LISTING_UPLOAD_RATE_LIMITED",
        message:
          "\u672C\u5730\u4E0A\u67B6\u56FE\u7247\u4E0A\u4F20\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
      });
      const body = legacyListingPresignSchema.parse(request.body);
      const grantId = newId();
      const objectKey = buildLegacyListingUploadObjectKey(
        request.currentUser.id,
        { sku: body.sku, filename: body.filename, requestId: grantId },
      );
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const lockResult = await client.query(
          "SELECT id FROM users WHERE id = $1 FOR UPDATE",
          [request.currentUser.id],
        );
        if (!lockResult.rowCount) {
          throw new AppError(
            404,
            "USER_NOT_FOUND",
            "\u7528\u6237\u4E0D\u5B58\u5728",
          );
        }
        await assertGalleryStorageAvailable(
          request.currentUser.id,
          body.sizeBytes,
          client,
        );
        const { uploadUrl, expiresIn } = await createDirectUploadUrl(
          objectKey,
          body.contentType,
        );
        const expiresAt = new Date(Date.now() + expiresIn * 1e3);
        await client.query(
          `
      INSERT INTO legacy_listing_upload_grants (id, user_id, object_key, sku, source_filename, content_type, size_bytes, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
          [
            grantId,
            request.currentUser.id,
            objectKey,
            body.sku,
            body.filename,
            body.contentType,
            body.sizeBytes,
            expiresAt,
          ],
        );
        await client.query("COMMIT");
        return {
          ok: true,
          objectKey,
          uploadUrl,
          expiresIn,
          publicUrl: publicUrlForObjectKey(objectKey),
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => void 0);
        throw error;
      } finally {
        client.release();
      }
    },
  );
  app.post(
    "/legacy-listing/uploads/complete",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      const body = parseLegacyListingCompleteBody(request.body);
      const grantResult = await pool.query(
        `
      SELECT
        id,
        user_id AS "userId",
        sku,
        source_filename AS "sourceFilename",
        object_key AS "objectKey",
        content_type AS "contentType",
        size_bytes AS "sizeBytes",
        expires_at AS "expiresAt",
        completed_at AS "completedAt"
      FROM legacy_listing_upload_grants
      WHERE object_key = $1
      `,
        [body.objectKey],
      );
      const grant = legacyListingUploadGrantFromRow(grantResult.rows[0]);
      const grantValidation = validateLegacyListingUploadGrant(
        request.currentUser.id,
        grant,
      );
      if (!grantValidation.ok) {
        throw new AppError(
          grantValidation.status,
          grantValidation.code,
          "\u4E0A\u4F20\u6388\u6743\u4E0D\u5B58\u5728\u3001\u5DF2\u8FC7\u671F\u6216\u4E0D\u5C5E\u4E8E\u5F53\u524D\u7528\u6237",
        );
      }
      const record = legacyListingUploadCompleteRecord(
        request.currentUser.id,
        grant,
      );
      if (grantValidation.completed) {
        const existingResult = await pool.query(
          `
        SELECT
          user_id AS "userId",
          sku,
          source_filename AS "sourceFilename",
          object_key AS "objectKey",
          public_url AS "publicUrl",
          content_type AS "contentType",
          size_bytes AS "sizeBytes"
        FROM legacy_listing_uploads
        WHERE object_key = $1
        `,
          [grant.objectKey],
        );
        if (!legacyListingUploadRecordMatches(existingResult.rows[0], record)) {
          throw new AppError(
            409,
            "LEGACY_LISTING_UPLOAD_CONFIRMATION_CONFLICT",
            "\u4E0A\u4F20\u786E\u8BA4\u8BB0\u5F55\u4E0E\u6388\u6743\u4E0D\u4E00\u81F4",
          );
        }
        return { ok: true, publicUrl: record.publicUrl };
      }
      const metadataValidation = validateLegacyListingUploadObjectMetadata(
        grant,
        await readObjectMetadata(grant.objectKey),
      );
      if (!metadataValidation.ok) {
        throw new AppError(
          metadataValidation.status,
          metadataValidation.code,
          "\u4E0A\u4F20\u5BF9\u8C61\u4E0D\u5B58\u5728\u6216\u5143\u6570\u636E\u4E0E\u6388\u6743\u4E0D\u4E00\u81F4",
        );
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `
      INSERT INTO legacy_listing_uploads (id, user_id, sku, source_filename, object_key, public_url, content_type, size_bytes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (object_key) DO UPDATE SET
        sku = excluded.sku,
        source_filename = excluded.source_filename,
        public_url = excluded.public_url,
        content_type = excluded.content_type,
        size_bytes = excluded.size_bytes
      `,
          [
            newId(),
            record.userId,
            record.sku,
            record.sourceFilename,
            record.objectKey,
            record.publicUrl,
            record.contentType,
            record.sizeBytes,
          ],
        );
        await client.query(
          `UPDATE legacy_listing_upload_grants SET completed_at = COALESCE(completed_at, now()) WHERE id = $1`,
          [grant.id],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => void 0);
        throw error;
      } finally {
        client.release();
      }
      return { ok: true, publicUrl: record.publicUrl };
    },
  );
  app.post(
    "/gallery/assets/direct-upload/prepare",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      await assertRateLimit({
        key: `direct-upload:prepare:${request.currentUser.id}`,
        limit: 120,
        windowMs: 6e4,
        code: "DIRECT_UPLOAD_RATE_LIMITED",
        message:
          "\u76F4\u4F20\u51C6\u5907\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
      });
      const body = directUploadBatchSchema.parse(request.body);
      const rule = toGalleryAssetRuleMeta(
        await getEnabledProductImageRule(body.productImageRuleId),
      );
      const existingResult = await pool.query(
        `SELECT DISTINCT sha256 FROM gallery_assets WHERE uploaded_by_user_id = $1 AND product_image_rule_id = $2 AND deleted_at IS NULL AND sha256 = ANY($3::text[])`,
        [
          request.currentUser.id,
          body.productImageRuleId,
          body.items.map((item) => item.sha256),
        ],
      );
      const existingHashes = new Set(
        existingResult.rows.map((row) => row.sha256),
      );
      await assertGalleryStorageAvailable(
        request.currentUser.id,
        body.items
          .filter((item) => !existingHashes.has(item.sha256))
          .reduce((sum, item) => sum + item.sizeBytes, 0),
      );
      const items = [];
      const skipped = [];
      const errors = [];
      for (const item of body.items) {
        if (existingHashes.has(item.sha256)) {
          skipped.push({
            clientItemId: item.clientItemId,
            filename: item.filename,
            sha256: item.sha256,
          });
          continue;
        }
        try {
          const image = directUploadImageMeta(request.currentUser.id, item);
          assertImageMatchesRule(image, rule);
          const [original, thumbnail] = await Promise.all([
            createDirectUploadUrl(image.objectKey, image.contentType),
            createDirectUploadUrl(image.thumbObjectKey, "image/webp"),
          ]);
          items.push({
            clientItemId: item.clientItemId,
            objectKey: image.objectKey,
            publicUrl: image.publicUrl,
            thumbObjectKey: image.thumbObjectKey,
            thumbUrl: image.thumbUrl,
            originalUploadUrl: original.uploadUrl,
            thumbnailUploadUrl: thumbnail.uploadUrl,
            expiresIn: Math.min(original.expiresIn, thumbnail.expiresIn),
          });
        } catch (error) {
          errors.push({
            clientItemId: item.clientItemId,
            filename: item.filename,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { ok: errors.length === 0, items, skipped, errors };
    },
  );
  app.post(
    "/gallery/assets/direct-upload/complete",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      await assertRateLimit({
        key: `direct-upload:complete:${request.currentUser.id}`,
        limit: 120,
        windowMs: 6e4,
        code: "DIRECT_UPLOAD_RATE_LIMITED",
        message:
          "\u76F4\u4F20\u5B8C\u6210\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
      });
      const body = directUploadBatchSchema.parse(request.body);
      const rule = toGalleryAssetRuleMeta(
        await getEnabledProductImageRule(body.productImageRuleId),
      );
      const userId = request.currentUser.id;
      const existingResult = await pool.query(
        `
      SELECT
        id,
        sku,
        sha256,
        ratio::float AS ratio,
        ratio_family AS "ratioFamily",
        product_image_rule_id AS "productImageRuleId",
        product_type AS "productType",
        aspect_ratio AS "aspectRatio",
        width,
        height,
        public_url AS "publicUrl",
        thumb_url AS "thumbUrl",
        content_type AS "contentType",
        size_bytes AS "sizeBytes",
        source_filename AS "sourceFilename",
        created_at AS "createdAt",
        generated_title AS "generatedTitle",
        generated_title_image_asset_id AS "generatedTitleImageAssetId",
        generated_title_prompt AS "generatedTitlePrompt",
        generated_title_updated_at AS "generatedTitleUpdatedAt"
      FROM gallery_assets
      WHERE uploaded_by_user_id = $1
        AND product_image_rule_id = $2
        AND deleted_at IS NULL
        AND sha256 = ANY($3::text[])
      ORDER BY created_at DESC
      `,
        [
          userId,
          body.productImageRuleId,
          body.items.map((item) => item.sha256),
        ],
      );
      const existingAssetsByHash = new Map();
      for (const row of existingResult.rows) {
        if (!existingAssetsByHash.has(row.sha256)) {
          existingAssetsByHash.set(row.sha256, row);
        }
      }
      await assertGalleryStorageAvailable(
        userId,
        body.items
          .filter((item) => !existingAssetsByHash.has(item.sha256))
          .reduce((sum, item) => sum + item.sizeBytes, 0),
      );
      const assets = [];
      const errors = [];
      for (const item of body.items) {
        try {
          const existingAsset = existingAssetsByHash.get(item.sha256);
          if (existingAsset) {
            assets.push(existingAsset);
            continue;
          }
          const image = directUploadImageMeta(userId, item);
          assertImageMatchesRule(image, rule);
          const [originalExists, thumbnailExists] = await Promise.all([
            objectExists(image.objectKey),
            objectExists(image.thumbObjectKey),
          ]);
          if (!originalExists || !thumbnailExists) {
            throw new Error(
              !originalExists
                ? "OSS \u539F\u56FE\u4E0D\u5B58\u5728\uFF0C\u8BF7\u91CD\u65B0\u4E0A\u4F20"
                : "OSS \u7F29\u7565\u56FE\u4E0D\u5B58\u5728\uFF0C\u8BF7\u91CD\u65B0\u4E0A\u4F20",
            );
          }
          assets.push(await insertGalleryAsset(userId, image, rule));
        } catch (error) {
          errors.push({
            clientItemId: item.clientItemId,
            filename: item.filename,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return {
        ok: errors.length === 0,
        uploaded: assets.length,
        failed: errors.length,
        assets,
        errors,
      };
    },
  );
  app.post(
    "/gallery/assets/upload",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      assertLegacyUploadEnabled();
      await assertRateLimit({
        key: `legacy-upload:${request.currentUser.id}`,
        limit: 10,
        windowMs: 6e4,
        code: "LEGACY_UPLOAD_RATE_LIMITED",
        message:
          "\u65E7\u7248\u4E0A\u4F20\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u4F7F\u7528\u65B0\u7248\u76F4\u4F20\u6216\u7A0D\u540E\u91CD\u8BD5",
      });
      const file = await request.file();
      if (!file) {
        throw new AppError(
          400,
          "UPLOAD_FILE_REQUIRED",
          "\u8BF7\u9009\u62E9\u8981\u4E0A\u4F20\u7684\u56FE\u7247",
        );
      }
      const buffer = await file.toBuffer();
      const sku = readMultipartTextField(file.fields, "sku");
      const meta = uploadMetaSchema.parse({
        productImageRuleId: readMultipartTextField(
          file.fields,
          "productImageRuleId",
        ),
      });
      const rule = await getEnabledProductImageRule(meta.productImageRuleId);
      const image = await prepareImage({
        buffer,
        filename: file.filename,
        mimetype: file.mimetype,
        sku,
      });
      const assetRule = toGalleryAssetRuleMeta(rule);
      assertImageMatchesRule(image, assetRule);
      await assertGalleryStorageAvailable(
        request.currentUser.id,
        image.sizeBytes,
      );
      await uploadPreparedImage(image);
      const asset = await insertGalleryAsset(
        request.currentUser.id,
        image,
        assetRule,
      );
      return { ok: true, asset };
    },
  );
  app.post(
    "/gallery/assets/batch-upload",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      assertLegacyUploadEnabled();
      await assertRateLimit({
        key: `legacy-batch-upload:${request.currentUser.id}`,
        limit: 6,
        windowMs: 6e4,
        code: "LEGACY_UPLOAD_RATE_LIMITED",
        message:
          "\u65E7\u7248\u6279\u91CF\u4E0A\u4F20\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u4F7F\u7528\u65B0\u7248\u76F4\u4F20\u6216\u7A0D\u540E\u91CD\u8BD5",
      });
      const files = request.files();
      const uploadFiles = [];
      const errors = [];
      let productImageRuleId = "";
      let totalFiles = 0;
      let totalBytes = 0;
      for await (const file of files) {
        if (file.type !== "file") {
          continue;
        }
        productImageRuleId ||= String(
          multipartFieldValue(file.fields.productImageRuleId) || "",
        );
        totalFiles += 1;
        if (totalFiles > MAX_BATCH_UPLOAD_FILES) {
          errors.push({
            filename: file.filename,
            message: `\u5355\u6B21\u6700\u591A\u4E0A\u4F20 ${MAX_BATCH_UPLOAD_FILES} \u5F20\u56FE\u7247\uFF0C\u8BF7\u5206\u6279\u4E0A\u4F20`,
          });
          continue;
        }
        try {
          const buffer = await file.toBuffer();
          totalBytes += buffer.length;
          if (totalBytes > MAX_BATCH_UPLOAD_BYTES) {
            errors.push({
              filename: file.filename,
              message: `\u672C\u6279\u56FE\u7247\u603B\u4F53\u79EF\u8FC7\u5927\uFF0C\u8BF7\u7F29\u5C0F\u5206\u6279\u540E\u91CD\u8BD5\uFF08\u5EFA\u8BAE\u6BCF\u6279\u4E0D\u8D85\u8FC7 ${Math.floor(MAX_BATCH_UPLOAD_BYTES / 1024 / 1024)} MB\uFF09`,
            });
            continue;
          }
          uploadFiles.push({
            buffer,
            filename: file.filename,
            mimetype: file.mimetype,
          });
        } catch (error) {
          errors.push({
            filename: file.filename,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (totalFiles === 0) {
        throw new AppError(
          400,
          "UPLOAD_FILE_REQUIRED",
          "\u8BF7\u9009\u62E9\u8981\u4E0A\u4F20\u7684\u56FE\u7247",
        );
      }
      const meta = uploadMetaSchema.parse({ productImageRuleId });
      const rule = await getEnabledProductImageRule(meta.productImageRuleId);
      await assertGalleryStorageAvailable(
        request.currentUser.id,
        uploadFiles.reduce((sum, item) => sum + item.buffer.length, 0),
      );
      const processed = await processBatchUploadFiles(
        request.currentUser.id,
        uploadFiles,
        toGalleryAssetRuleMeta(rule),
      );
      errors.push(...processed.errors);
      return {
        ok: errors.length === 0,
        uploaded: processed.assets.length,
        failed: errors.length,
        assets: processed.assets,
        errors,
      };
    },
  );
  app.post(
    "/gallery/assets/batch-upload-task",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      assertLegacyUploadEnabled();
      await assertRateLimit({
        key: `legacy-upload-task:${request.currentUser.id}`,
        limit: 6,
        windowMs: 6e4,
        code: "LEGACY_UPLOAD_RATE_LIMITED",
        message:
          "\u65E7\u7248\u4E0A\u4F20\u4EFB\u52A1\u521B\u5EFA\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u4F7F\u7528\u65B0\u7248\u76F4\u4F20\u6216\u7A0D\u540E\u91CD\u8BD5",
      });
      const task = await createGalleryUploadTask(
        request.currentUser.id,
        request.files(),
      );
      enqueueUploadTask(task.id);
      return { ok: true, task };
    },
  );
  app.get(
    "/gallery/upload-tasks/:taskId",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      const params = uploadTaskParamsSchema.parse(request.params);
      const task = await readGalleryUploadTask(
        request.currentUser.id,
        params.taskId,
      );
      if (!task) {
        throw new AppError(
          404,
          "UPLOAD_TASK_NOT_FOUND",
          "\u4E0A\u4F20\u4EFB\u52A1\u4E0D\u5B58\u5728\u6216\u5DF2\u88AB\u6E05\u7406",
        );
      }
      if (task.status === "queued" || task.status === "running") {
        enqueueUploadTask(task.id);
      }
      return { ok: true, task };
    },
  );
  app.post(
    "/gallery/assets/:assetId/use",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      const params = z
        .object({ assetId: z.string().uuid() })
        .parse(request.params);
      const body = useAssetSchema.parse(request.body);
      const userId = request.currentUser.id;
      const shop = await pool.query(
        "SELECT id FROM shops WHERE id = $1 AND user_id = $2",
        [body.shopId, userId],
      );
      if (!shop.rowCount) {
        throw new AppError(
          404,
          "SHOP_NOT_FOUND",
          "\u5E97\u94FA\u4E0D\u5B58\u5728\uFF0C\u8BF7\u5148\u540C\u6B65\u5E97\u94FA",
        );
      }
      const asset = await pool.query(
        "SELECT id, sku, sha256 FROM gallery_assets WHERE id = $1 AND uploaded_by_user_id = $2 AND deleted_at IS NULL",
        [params.assetId, userId],
      );
      if (!asset.rowCount) {
        throw new AppError(
          404,
          "ASSET_NOT_FOUND",
          "\u56FE\u7247\u4E0D\u5B58\u5728",
        );
      }
      const row = asset.rows[0];
      await pool.query(
        `
      INSERT INTO gallery_usage (id, user_id, shop_id, asset_id, sku, sha256, usage_type)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (user_id, shop_id, sku)
      DO UPDATE SET
        asset_id = excluded.asset_id,
        sha256 = excluded.sha256,
        usage_type = excluded.usage_type,
        used_at = now()
      `,
        [
          newId(),
          userId,
          body.shopId,
          row.id,
          row.sku,
          row.sha256,
          body.usageType,
        ],
      );
      return { ok: true, used: { sku: row.sku, shopId: body.shopId } };
    },
  );
  app.post(
    "/gallery/assets/:assetId/use-by-external-shop",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      const params = z
        .object({ assetId: z.string().uuid() })
        .parse(request.params);
      const body = useAssetByExternalShopSchema.parse(request.body);
      const userId = request.currentUser.id;
      const shop = await pool.query(
        "SELECT id FROM shops WHERE external_shop_id = $1 AND user_id = $2",
        [body.externalShopId, userId],
      );
      if (!shop.rowCount) {
        throw new AppError(
          404,
          "SHOP_NOT_SYNCED",
          "\u5E97\u94FA\u8FD8\u6CA1\u6709\u540C\u6B65\u5230\u4E91\u7AEF\uFF0C\u8BF7\u5148\u540C\u6B65\u5E97\u94FA",
        );
      }
      const asset = await pool.query(
        "SELECT id, sku, sha256 FROM gallery_assets WHERE id = $1 AND uploaded_by_user_id = $2 AND deleted_at IS NULL",
        [params.assetId, userId],
      );
      if (!asset.rowCount) {
        throw new AppError(
          404,
          "ASSET_NOT_FOUND",
          "\u56FE\u7247\u4E0D\u5B58\u5728",
        );
      }
      const assetRow = asset.rows[0];
      const shopId = shop.rows[0].id;
      await pool.query(
        `
      INSERT INTO gallery_usage (id, user_id, shop_id, asset_id, sku, sha256, usage_type)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (user_id, shop_id, sku)
      DO UPDATE SET
        asset_id = excluded.asset_id,
        sha256 = excluded.sha256,
        usage_type = excluded.usage_type,
        used_at = now()
      `,
        [
          newId(),
          userId,
          shopId,
          assetRow.id,
          assetRow.sku,
          assetRow.sha256,
          body.usageType,
        ],
      );
      return {
        ok: true,
        used: {
          sku: assetRow.sku,
          shopId,
          externalShopId: body.externalShopId,
        },
      };
    },
  );
  app.get(
    "/gallery/assets/:assetId/original",
    { preHandler: [requireAuth, requireMembership] },
    async (request, reply) => {
      const params = z
        .object({ assetId: z.string().uuid() })
        .parse(request.params);
      const result = await pool.query(
        `
      SELECT object_key, content_type, source_filename
      FROM gallery_assets
      WHERE id = $1
        AND uploaded_by_user_id = $2
        AND deleted_at IS NULL
      LIMIT 1
      `,
        [params.assetId, request.currentUser.id],
      );
      const row = result.rows[0];
      if (!row) {
        throw new AppError(
          404,
          "ASSET_NOT_FOUND",
          "\u56FE\u7247\u4E0D\u5B58\u5728\u6216\u4E0D\u5C5E\u4E8E\u5F53\u524D\u8D26\u53F7",
        );
      }
      const buffer = await readObjectBuffer(row.object_key);
      return reply
        .header("Cache-Control", "private, max-age=300")
        .header(
          "Content-Disposition",
          `inline; filename="${encodeURIComponent(row.source_filename)}"`,
        )
        .type(row.content_type || "application/octet-stream")
        .send(buffer);
    },
  );
  app.delete(
    "/gallery/assets/:assetId",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      const params = z
        .object({ assetId: z.string().uuid() })
        .parse(request.params);
      const result = await pool.query(
        `
      UPDATE gallery_assets
      SET deleted_at = COALESCE(deleted_at, now()),
          deleted_by_user_id = $2
      WHERE id = $1
        AND uploaded_by_user_id = $2
        AND deleted_at IS NULL
      RETURNING id, sku
      `,
        [params.assetId, request.currentUser.id],
      );
      if (!result.rowCount) {
        throw new AppError(
          404,
          "ASSET_NOT_FOUND",
          "\u56FE\u7247\u4E0D\u5B58\u5728\u6216\u5DF2\u5220\u9664",
        );
      }
      return { ok: true, asset: result.rows[0] };
    },
  );
  void resumePendingUploadTasks();
}
__name(galleryRoutes, "galleryRoutes");
__name2(galleryRoutes, "galleryRoutes");
async function insertGalleryAsset(userId, image, rule) {
  const result = await pool.query(
    `
    INSERT INTO gallery_assets (
      id,
      uploaded_by_user_id,
      sku,
      sha256,
      ratio,
      ratio_family,
      product_image_rule_id,
      product_type,
      aspect_ratio,
      width,
      height,
      object_key,
      public_url,
      thumb_object_key,
      thumb_url,
      content_type,
      size_bytes,
      source_filename
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
    ON CONFLICT (uploaded_by_user_id, object_key) WHERE uploaded_by_user_id IS NOT NULL
    DO UPDATE SET
      sku = excluded.sku,
      sha256 = excluded.sha256,
      ratio = excluded.ratio,
      ratio_family = excluded.ratio_family,
      product_image_rule_id = excluded.product_image_rule_id,
      product_type = excluded.product_type,
      aspect_ratio = excluded.aspect_ratio,
      width = excluded.width,
      height = excluded.height,
      public_url = excluded.public_url,
      thumb_object_key = excluded.thumb_object_key,
      thumb_url = excluded.thumb_url,
      content_type = excluded.content_type,
      size_bytes = excluded.size_bytes,
      source_filename = excluded.source_filename,
      deleted_at = NULL,
      deleted_by_user_id = NULL
    RETURNING
      id,
      sku,
      sha256,
      ratio::float AS ratio,
      ratio_family AS "ratioFamily",
      product_image_rule_id AS "productImageRuleId",
      product_type AS "productType",
      aspect_ratio AS "aspectRatio",
      width,
      height,
      public_url AS "publicUrl",
      thumb_url AS "thumbUrl",
      content_type AS "contentType",
      size_bytes AS "sizeBytes",
      source_filename AS "sourceFilename",
      created_at AS "createdAt",
      generated_title AS "generatedTitle",
      generated_title_image_asset_id AS "generatedTitleImageAssetId",
      generated_title_prompt AS "generatedTitlePrompt",
      generated_title_updated_at AS "generatedTitleUpdatedAt"
    `,
    [
      newId(),
      userId,
      image.sku,
      image.sha256,
      image.ratio,
      image.ratioFamily,
      rule?.productImageRuleId ?? null,
      rule?.productType ?? null,
      rule?.aspectRatio ?? null,
      image.width,
      image.height,
      image.objectKey,
      image.publicUrl,
      image.thumbObjectKey,
      image.thumbUrl,
      image.contentType,
      image.sizeBytes,
      image.sourceFilename,
    ],
  );
  return result.rows[0];
}
__name(insertGalleryAsset, "insertGalleryAsset");
__name2(insertGalleryAsset, "insertGalleryAsset");
async function assertGalleryStorageAvailable(
  userId,
  incomingBytes,
  queryable = pool,
) {
  if (incomingBytes <= 0) {
    return;
  }
  const usage = await readGalleryStorageUsage(userId, queryable);
  const quota = validateLegacyListingUploadQuota(usage, incomingBytes);
  if (!quota.ok) {
    throw new AppError(
      403,
      "GALLERY_STORAGE_LIMIT_EXCEEDED",
      `\u56FE\u5E93\u5BB9\u91CF\u4E0D\u8DB3\uFF1A\u5DF2\u4F7F\u7528 ${formatStorageBytes(usage.usedBytes)}\uFF0C\u672C\u6B21\u9700\u8981 ${formatStorageBytes(incomingBytes)}\uFF0C\u4E0A\u9650 ${formatStorageBytes(usage.limitBytes)}`,
    );
  }
}
__name(assertGalleryStorageAvailable, "assertGalleryStorageAvailable");
__name2(assertGalleryStorageAvailable, "assertGalleryStorageAvailable");
async function readGalleryStorageUsage(userId, queryable = pool) {
  const result = await queryable.query(
    `
    SELECT
      u.gallery_storage_limit_bytes,
      (COALESCE(gallery.used_bytes, 0) + COALESCE(legacy.used_bytes, 0) + COALESCE(grants.used_bytes, 0))::bigint AS used_bytes
    FROM users u
    LEFT JOIN (
      SELECT uploaded_by_user_id, COALESCE(sum(size_bytes), 0)::bigint AS used_bytes
      FROM gallery_assets a
      WHERE a.deleted_at IS NULL
        AND NOT EXISTS (
        SELECT 1
        FROM gallery_mockup_results mr
        WHERE mr.result_asset_id = a.id
      )
      GROUP BY uploaded_by_user_id
    ) gallery ON gallery.uploaded_by_user_id = u.id
    LEFT JOIN (
      SELECT user_id, COALESCE(sum(size_bytes), 0)::bigint AS used_bytes
      FROM legacy_listing_uploads
      GROUP BY user_id
    ) legacy ON legacy.user_id = u.id
    LEFT JOIN (
      SELECT user_id, COALESCE(sum(size_bytes), 0)::bigint AS used_bytes
      FROM legacy_listing_upload_grants
      WHERE completed_at IS NULL
        AND expires_at > now()
      GROUP BY user_id
    ) grants ON grants.user_id = u.id
    WHERE u.id = $1
    `,
    [userId],
  );
  const row = result.rows[0];
  return {
    limitBytes: Number(row?.gallery_storage_limit_bytes ?? 0),
    usedBytes: Number(row?.used_bytes ?? 0),
  };
}
__name(readGalleryStorageUsage, "readGalleryStorageUsage");
__name2(readGalleryStorageUsage, "readGalleryStorageUsage");
function formatStorageBytes(value) {
  const gb = value / 1024 / 1024 / 1024;
  return `${gb >= 1 ? gb.toFixed(2) : (value / 1024 / 1024).toFixed(1)} ${gb >= 1 ? "GB" : "MB"}`;
}
__name(formatStorageBytes, "formatStorageBytes");
__name2(formatStorageBytes, "formatStorageBytes");
function directUploadImageMeta(userId, item) {
  const sku = item.sku
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[\\/:*?"<>|#%{}]/g, "-")
    .slice(0, 120);
  if (!sku) {
    throw new AppError(
      400,
      "IMAGE_SKU_REQUIRED",
      "\u56FE\u7247\u8D27\u53F7\u4E0D\u80FD\u4E3A\u7A7A",
    );
  }
  const ratio = item.width / item.height;
  const ratioFamily =
    ratio >= 1.6
      ? "wide"
      : ratio > 1.1
        ? "landscape"
        : ratio >= 0.9
          ? "square"
          : "portrait";
  const extension =
    item.contentType === "image/png"
      ? "png"
      : item.contentType === "image/webp"
        ? "webp"
        : "jpg";
  const objectKey = `gallery/${userId}/${ratioFamily}/${sku}/${item.sha256.slice(0, 16)}.${extension}`;
  const thumbObjectKey = thumbnailObjectKeyForOriginal(objectKey);
  return {
    buffer: Buffer.alloc(0),
    sha256: item.sha256,
    width: item.width,
    height: item.height,
    ratio,
    ratioFamily,
    objectKey,
    publicUrl: publicUrlForObjectKey(objectKey),
    thumbBuffer: Buffer.alloc(0),
    thumbObjectKey,
    thumbUrl: publicUrlForObjectKey(thumbObjectKey),
    contentType: item.contentType,
    sizeBytes: item.sizeBytes,
    sku,
    sourceFilename: item.filename,
  };
}
__name(directUploadImageMeta, "directUploadImageMeta");
__name2(directUploadImageMeta, "directUploadImageMeta");
async function processBatchUploadFiles(userId, files, rule) {
  const assets = [];
  const errors = [];
  let nextIndex = 0;
  const workerCount = Math.min(MAX_BATCH_UPLOAD_CONCURRENCY, files.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < files.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        const file = files[currentIndex];
        try {
          const image = await prepareImage({
            buffer: file.buffer,
            filename: file.filename,
            mimetype: file.mimetype,
          });
          assertImageMatchesRule(image, rule);
          await assertGalleryStorageAvailable(userId, image.sizeBytes);
          await uploadPreparedImage(image);
          assets.push(await insertGalleryAsset(userId, image, rule));
        } catch (error) {
          errors.push({
            filename: file.filename,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }),
  );
  return { assets, errors };
}
__name(processBatchUploadFiles, "processBatchUploadFiles");
__name2(processBatchUploadFiles, "processBatchUploadFiles");
function assertImageMatchesRule(image, rule) {
  if (
    !imageMatchesAspectRatio(
      image.width,
      image.height,
      rule.ratioWidth,
      rule.ratioHeight,
    )
  ) {
    throw new AppError(
      400,
      "IMAGE_ASPECT_RATIO_MISMATCH",
      `${image.sourceFilename} \u7684\u5B9E\u9645\u5C3A\u5BF8\u4E3A ${image.width}x${image.height}\uFF0C\u4E0D\u7B26\u5408 ${rule.productType} \u8981\u6C42\u7684 ${rule.aspectRatio} \u6BD4\u4F8B`,
    );
  }
}
__name(assertImageMatchesRule, "assertImageMatchesRule");
__name2(assertImageMatchesRule, "assertImageMatchesRule");
function toGalleryAssetRuleMeta(rule) {
  return {
    productImageRuleId: rule.id,
    productType: rule.productType,
    aspectRatio: rule.aspectRatio,
    ratioWidth: rule.ratioWidth,
    ratioHeight: rule.ratioHeight,
  };
}
__name(toGalleryAssetRuleMeta, "toGalleryAssetRuleMeta");
__name2(toGalleryAssetRuleMeta, "toGalleryAssetRuleMeta");
function assertLegacyUploadEnabled() {
  if (!config.LEGACY_UPLOAD_ENABLED) {
    throw new AppError(
      410,
      "LEGACY_UPLOAD_DISABLED",
      "\u65E7\u7248\u4E0A\u4F20\u63A5\u53E3\u5DF2\u5173\u95ED\uFF0C\u8BF7\u5347\u7EA7\u5BA2\u6237\u7AEF\u5E76\u4F7F\u7528\u5BF9\u8C61\u5B58\u50A8\u76F4\u4F20",
    );
  }
}
__name(assertLegacyUploadEnabled, "assertLegacyUploadEnabled");
__name2(assertLegacyUploadEnabled, "assertLegacyUploadEnabled");
async function createGalleryUploadTask(userId, files) {
  const taskId = newId();
  const taskDir = path.join(UPLOAD_TASK_TEMP_ROOT, taskId);
  const items = [];
  let totalFiles = 0;
  let totalBytes = 0;
  let productImageRuleId = "";
  await fs.mkdir(taskDir, { recursive: true });
  for await (const file of files) {
    if (file.type !== "file") {
      continue;
    }
    productImageRuleId ||= String(
      multipartFieldValue(file.fields.productImageRuleId) || "",
    );
    totalFiles += 1;
    const itemId = newId();
    const filename = file.filename || `image-${totalFiles}`;
    const contentType = file.mimetype || "application/octet-stream";
    if (totalFiles > MAX_BATCH_UPLOAD_FILES) {
      items.push({
        id: itemId,
        filename,
        contentType,
        sizeBytes: 0,
        tempPath: null,
        status: "failed",
        errorMessage: `\u5355\u6B21\u6700\u591A\u4E0A\u4F20 ${MAX_BATCH_UPLOAD_FILES} \u5F20\u56FE\u7247\uFF0C\u8BF7\u5206\u6279\u4E0A\u4F20`,
      });
      continue;
    }
    try {
      const buffer = await file.toBuffer();
      totalBytes += buffer.length;
      if (totalBytes > MAX_BATCH_UPLOAD_BYTES) {
        items.push({
          id: itemId,
          filename,
          contentType,
          sizeBytes: buffer.length,
          tempPath: null,
          status: "failed",
          errorMessage: `\u672C\u6279\u56FE\u7247\u603B\u4F53\u79EF\u8FC7\u5927\uFF0C\u8BF7\u7F29\u5C0F\u5206\u6279\u540E\u91CD\u8BD5\uFF08\u5EFA\u8BAE\u6BCF\u6279\u4E0D\u8D85\u8FC7 ${Math.floor(MAX_BATCH_UPLOAD_BYTES / 1024 / 1024)} MB\uFF09`,
        });
        continue;
      }
      const tempPath = path.join(
        taskDir,
        `${itemId}-${safeTempFilename(filename)}`,
      );
      await fs.writeFile(tempPath, buffer);
      items.push({
        id: itemId,
        filename,
        contentType,
        sizeBytes: buffer.length,
        tempPath,
        status: "queued",
      });
    } catch (error) {
      items.push({
        id: itemId,
        filename,
        contentType,
        sizeBytes: 0,
        tempPath: null,
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (totalFiles === 0) {
    await removeDirectoryQuietly(taskDir);
    throw new AppError(
      400,
      "UPLOAD_FILE_REQUIRED",
      "\u8BF7\u9009\u62E9\u8981\u4E0A\u4F20\u7684\u56FE\u7247",
    );
  }
  const meta = uploadMetaSchema.parse({ productImageRuleId });
  const rule = await getEnabledProductImageRule(meta.productImageRuleId);
  const assetRule = toGalleryAssetRuleMeta(rule);
  await assertGalleryStorageAvailable(
    userId,
    items
      .filter((item) => item.status === "queued")
      .reduce((sum, item) => sum + item.sizeBytes, 0),
  );
  const queuedCount = items.filter((item) => item.status === "queued").length;
  const failedCount = items.length - queuedCount;
  const initialStatus = queuedCount > 0 ? "queued" : "failed";
  const initialMessage =
    queuedCount > 0
      ? `\u5DF2\u63A5\u6536 ${queuedCount} \u5F20\u56FE\u7247\uFF0C\u7B49\u5F85\u670D\u52A1\u5668\u5904\u7406`
      : "\u672C\u6279\u56FE\u7247\u6CA1\u6709\u53EF\u5904\u7406\u6587\u4EF6\uFF0C\u8BF7\u67E5\u770B\u5931\u8D25\u539F\u56E0";
  await pool.query(
    `
    INSERT INTO gallery_upload_tasks (
      id,
      user_id,
      status,
      total_files,
      total_bytes,
      uploaded,
      failed,
      processed,
      message,
      product_image_rule_id,
      product_type,
      aspect_ratio
    )
    VALUES ($1, $2, $3, $4, $5, 0, $6, $6, $7, $8, $9, $10)
    `,
    [
      taskId,
      userId,
      initialStatus,
      totalFiles,
      totalBytes,
      failedCount,
      initialMessage,
      assetRule.productImageRuleId,
      assetRule.productType,
      assetRule.aspectRatio,
    ],
  );
  for (const item of items) {
    await pool.query(
      `
      INSERT INTO gallery_upload_task_items (
        id,
        task_id,
        user_id,
        filename,
        content_type,
        size_bytes,
        temp_path,
        status,
        error_message,
        finished_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $8 = 'failed' THEN now() ELSE NULL END)
      `,
      [
        item.id,
        taskId,
        userId,
        item.filename,
        item.contentType,
        item.sizeBytes,
        item.tempPath,
        item.status,
        item.errorMessage ?? null,
      ],
    );
  }
  if (queuedCount === 0) {
    await refreshUploadTaskProgress(taskId);
    await removeDirectoryQuietly(taskDir);
  }
  const task = await readGalleryUploadTask(userId, taskId);
  if (!task) {
    throw new AppError(
      500,
      "UPLOAD_TASK_CREATE_FAILED",
      "\u4E0A\u4F20\u4EFB\u52A1\u521B\u5EFA\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5",
    );
  }
  return task;
}
__name(createGalleryUploadTask, "createGalleryUploadTask");
__name2(createGalleryUploadTask, "createGalleryUploadTask");
function enqueueUploadTask(taskId) {
  if (activeUploadTasks.has(taskId) || uploadTaskQueue.includes(taskId)) {
    return;
  }
  uploadTaskQueue.push(taskId);
  drainUploadTaskQueue();
}
__name(enqueueUploadTask, "enqueueUploadTask");
__name2(enqueueUploadTask, "enqueueUploadTask");
function drainUploadTaskQueue() {
  while (
    activeUploadTasks.size < MAX_ACTIVE_UPLOAD_TASKS &&
    uploadTaskQueue.length > 0
  ) {
    const taskId = uploadTaskQueue.shift();
    activeUploadTasks.add(taskId);
    setTimeout(() => {
      void processGalleryUploadTask(taskId)
        .catch((error) => markUploadTaskCrashed(taskId, error))
        .finally(() => {
          activeUploadTasks.delete(taskId);
          drainUploadTaskQueue();
        });
    }, 0);
  }
}
__name(drainUploadTaskQueue, "drainUploadTaskQueue");
__name2(drainUploadTaskQueue, "drainUploadTaskQueue");
async function processGalleryUploadTask(taskId) {
  const taskResult = await pool.query(
    `
    SELECT
      t.id,
      t.user_id,
      r.id AS product_image_rule_id,
      r.product_type,
      r.aspect_ratio,
      r.ratio_width,
      r.ratio_height
    FROM gallery_upload_tasks t
    JOIN product_image_rules r ON r.id = t.product_image_rule_id AND r.enabled = TRUE
    WHERE t.id = $1
      AND t.status IN ('queued', 'running')
    LIMIT 1
    `,
    [taskId],
  );
  const task = taskResult.rows[0];
  if (!task) {
    return;
  }
  await pool.query(
    `
    UPDATE gallery_upload_tasks
    SET status = 'running',
        started_at = COALESCE(started_at, now()),
        updated_at = now(),
        message = '\u670D\u52A1\u5668\u6B63\u5728\u5904\u7406\u56FE\u7247'
    WHERE id = $1
    `,
    [taskId],
  );
  await pool.query(
    `
    UPDATE gallery_upload_task_items
    SET status = 'queued',
        updated_at = now()
    WHERE task_id = $1
      AND status = 'running'
    `,
    [taskId],
  );
  const itemResult = await pool.query(
    `
    SELECT id, filename, content_type, temp_path
    FROM gallery_upload_task_items
    WHERE task_id = $1
      AND status = 'queued'
    ORDER BY created_at ASC
    `,
    [taskId],
  );
  const items = itemResult.rows;
  let nextIndex = 0;
  const workerCount = Math.min(MAX_BATCH_UPLOAD_CONCURRENCY, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        const item = items[currentIndex];
        await processGalleryUploadTaskItem(task.user_id, taskId, item, {
          productImageRuleId: task.product_image_rule_id,
          productType: task.product_type,
          aspectRatio: task.aspect_ratio,
          ratioWidth: Number(task.ratio_width),
          ratioHeight: Number(task.ratio_height),
        });
      }
    }),
  );
  await refreshUploadTaskProgress(taskId);
  await cleanupUploadTaskTempFiles(taskId);
}
__name(processGalleryUploadTask, "processGalleryUploadTask");
__name2(processGalleryUploadTask, "processGalleryUploadTask");
async function processGalleryUploadTaskItem(userId, taskId, item, rule) {
  await pool.query(
    `
    UPDATE gallery_upload_task_items
    SET status = 'running',
        started_at = COALESCE(started_at, now()),
        updated_at = now()
    WHERE id = $1
      AND status = 'queued'
    `,
    [item.id],
  );
  try {
    if (!item.temp_path) {
      throw new Error(
        "\u4E34\u65F6\u6587\u4EF6\u4E0D\u5B58\u5728\uFF0C\u8BF7\u91CD\u65B0\u4E0A\u4F20\u8BE5\u56FE\u7247",
      );
    }
    const buffer = await fs.readFile(item.temp_path);
    const image = await prepareImage({
      buffer,
      filename: item.filename,
      mimetype: item.content_type,
    });
    assertImageMatchesRule(image, rule);
    await assertGalleryStorageAvailable(userId, image.sizeBytes);
    await uploadPreparedImage(image);
    const asset = await insertGalleryAsset(userId, image, rule);
    await pool.query(
      `
      UPDATE gallery_upload_task_items
      SET status = 'succeeded',
          asset_id = $2,
          error_message = NULL,
          finished_at = now(),
          updated_at = now()
      WHERE id = $1
      `,
      [item.id, asset.id],
    );
    await fs.unlink(item.temp_path).catch(() => void 0);
  } catch (error) {
    await pool.query(
      `
      UPDATE gallery_upload_task_items
      SET status = 'failed',
          error_message = $2,
          finished_at = now(),
          updated_at = now()
      WHERE id = $1
      `,
      [item.id, error instanceof Error ? error.message : String(error)],
    );
  } finally {
    await refreshUploadTaskProgress(taskId);
  }
}
__name(processGalleryUploadTaskItem, "processGalleryUploadTaskItem");
__name2(processGalleryUploadTaskItem, "processGalleryUploadTaskItem");
async function refreshUploadTaskProgress(taskId) {
  const statsResult = await pool.query(
    `
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'succeeded')::int AS uploaded,
      COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
      COUNT(*) FILTER (WHERE status IN ('succeeded', 'failed'))::int AS processed
    FROM gallery_upload_task_items
    WHERE task_id = $1
    `,
    [taskId],
  );
  const stats = statsResult.rows[0];
  const done = stats.processed >= stats.total;
  const status = done
    ? stats.uploaded > 0 && stats.failed === 0
      ? "succeeded"
      : stats.uploaded > 0
        ? "partial"
        : "failed"
    : "running";
  const message = done
    ? stats.failed > 0
      ? `\u4E0A\u4F20\u5904\u7406\u5B8C\u6210\uFF1A\u6210\u529F ${stats.uploaded} \u5F20\uFF0C\u5931\u8D25 ${stats.failed} \u5F20`
      : `\u4E0A\u4F20\u5904\u7406\u5B8C\u6210\uFF1A\u6210\u529F ${stats.uploaded} \u5F20`
    : `\u670D\u52A1\u5668\u5904\u7406\u4E2D\uFF1A\u5DF2\u5B8C\u6210 ${stats.processed}/${stats.total} \u5F20`;
  await pool.query(
    `
    UPDATE gallery_upload_tasks
    SET status = $2,
        uploaded = $3,
        failed = $4,
        processed = $5,
        message = $6,
        finished_at = CASE WHEN $7 THEN COALESCE(finished_at, now()) ELSE finished_at END,
        updated_at = now()
    WHERE id = $1
    `,
    [
      taskId,
      status,
      stats.uploaded,
      stats.failed,
      stats.processed,
      message,
      done,
    ],
  );
}
__name(refreshUploadTaskProgress, "refreshUploadTaskProgress");
__name2(refreshUploadTaskProgress, "refreshUploadTaskProgress");
async function markUploadTaskCrashed(taskId, error) {
  const message = error instanceof Error ? error.message : String(error);
  await pool.query(
    `
    UPDATE gallery_upload_task_items
    SET status = 'failed',
        error_message = $2,
        finished_at = now(),
        updated_at = now()
    WHERE task_id = $1
      AND status IN ('queued', 'running')
    `,
    [
      taskId,
      `\u670D\u52A1\u5668\u5904\u7406\u4EFB\u52A1\u5F02\u5E38\uFF1A${message}`,
    ],
  );
  await refreshUploadTaskProgress(taskId).catch(() => void 0);
}
__name(markUploadTaskCrashed, "markUploadTaskCrashed");
__name2(markUploadTaskCrashed, "markUploadTaskCrashed");
async function readGalleryUploadTask(userId, taskId) {
  const taskResult = await pool.query(
    `
    SELECT
      id,
      status,
      total_files,
      total_bytes,
      uploaded,
      failed,
      processed,
      message,
      created_at,
      started_at,
      finished_at,
      updated_at
    FROM gallery_upload_tasks
    WHERE id = $1
      AND user_id = $2
    LIMIT 1
    `,
    [taskId, userId],
  );
  const task = taskResult.rows[0];
  if (!task) {
    return null;
  }
  const errorsResult = await pool.query(
    `
    SELECT filename, error_message
    FROM gallery_upload_task_items
    WHERE task_id = $1
      AND user_id = $2
      AND status = 'failed'
    ORDER BY finished_at DESC NULLS LAST, created_at DESC
    LIMIT 50
    `,
    [taskId, userId],
  );
  const assetsResult = await pool.query(
    `
    SELECT
      a.id,
      a.sku,
      a.sha256,
      a.ratio::float AS "ratio",
      a.ratio_family AS "ratioFamily",
      a.width,
      a.height,
      a.public_url AS "publicUrl",
      a.thumb_url AS "thumbUrl",
      a.content_type AS "contentType",
      a.size_bytes AS "sizeBytes",
      a.source_filename AS "sourceFilename",
      a.created_at AS "createdAt",
      a.generated_title AS "generatedTitle",
      a.generated_title_image_asset_id AS "generatedTitleImageAssetId",
      a.generated_title_prompt AS "generatedTitlePrompt",
      a.generated_title_updated_at AS "generatedTitleUpdatedAt"
    FROM gallery_upload_task_items i
    JOIN gallery_assets a ON a.id = i.asset_id
    WHERE i.task_id = $1
      AND i.user_id = $2
      AND i.status = 'succeeded'
    ORDER BY i.finished_at ASC NULLS LAST, i.created_at ASC
    `,
    [taskId, userId],
  );
  return {
    id: task.id,
    status: task.status,
    totalFiles: task.total_files,
    totalBytes: Number(task.total_bytes),
    uploaded: task.uploaded,
    failed: task.failed,
    processed: task.processed,
    message: task.message,
    createdAt: task.created_at.toISOString(),
    startedAt: task.started_at?.toISOString() ?? null,
    finishedAt: task.finished_at?.toISOString() ?? null,
    updatedAt: task.updated_at.toISOString(),
    assets: assetsResult.rows,
    errors: errorsResult.rows.map((row) => ({
      filename: row.filename,
      message: row.error_message || "\u4E0A\u4F20\u5931\u8D25",
    })),
  };
}
__name(readGalleryUploadTask, "readGalleryUploadTask");
__name2(readGalleryUploadTask, "readGalleryUploadTask");
async function resumePendingUploadTasks() {
  try {
    const result = await pool.query(`
      SELECT id
      FROM gallery_upload_tasks
      WHERE status IN ('queued', 'running')
      ORDER BY created_at ASC
      LIMIT 50
      `);
    for (const row of result.rows) {
      enqueueUploadTask(row.id);
    }
  } catch (error) {
    console.error("[gallery-upload-task] resume failed", error);
  }
}
__name(resumePendingUploadTasks, "resumePendingUploadTasks");
__name2(resumePendingUploadTasks, "resumePendingUploadTasks");
async function cleanupUploadTaskTempFiles(taskId) {
  const taskDir = path.join(UPLOAD_TASK_TEMP_ROOT, taskId);
  await removeDirectoryQuietly(taskDir);
}
__name(cleanupUploadTaskTempFiles, "cleanupUploadTaskTempFiles");
__name2(cleanupUploadTaskTempFiles, "cleanupUploadTaskTempFiles");
async function removeDirectoryQuietly(target) {
  await fs.rm(target, { recursive: true, force: true }).catch(() => void 0);
}
__name(removeDirectoryQuietly, "removeDirectoryQuietly");
__name2(removeDirectoryQuietly, "removeDirectoryQuietly");
function safeTempFilename(filename) {
  const parsed = path.parse(filename);
  const base = parsed.name.replace(/[^\w.-]+/g, "_").slice(0, 80) || "image";
  const ext = parsed.ext.replace(/[^\w.]+/g, "").slice(0, 12);
  return `${base}${ext}`;
}
__name(safeTempFilename, "safeTempFilename");
__name2(safeTempFilename, "safeTempFilename");
function ratioFamilyForAspectRatio(aspectRatio) {
  const [width = 1, height = 1] = aspectRatio
    .split(":")
    .map((value) => Number(value));
  const ratio = width / height;
  if (Math.abs(ratio - 1) < 0.01) return "square";
  if (Math.abs(ratio - 16 / 9) < 0.01) return "wide";
  if (ratio > 1) return "landscape";
  return "portrait";
}
__name(ratioFamilyForAspectRatio, "ratioFamilyForAspectRatio");
__name2(ratioFamilyForAspectRatio, "ratioFamilyForAspectRatio");
async function createListingBatch(userId, body) {
  const productRule = await getEnabledProductImageRule(body.productImageRuleId);
  const batchRatioFamily =
    body.ratioFamily ?? ratioFamilyForAspectRatio(productRule.aspectRatio);
  const client = await pool.connect();
  let transactionStarted = false;
  const onClientError = __name2((error) => {
    console.error("[gallery-listing-batch] database client error", error);
  }, "onClientError");
  client.on("error", onClientError);
  try {
    const externalShopIds = [
      ...new Set(body.shopTargets.map((target) => target.externalShopId)),
    ];
    if (externalShopIds.length !== body.shopTargets.length) {
      throw new AppError(
        400,
        "DUPLICATE_SHOP_TARGET",
        "\u540C\u4E00\u4E2A\u6279\u6B21\u91CC\u5E97\u94FA\u4E0D\u80FD\u91CD\u590D\u9009\u62E9",
      );
    }
    const shopsResult = await client.query(
      `
      SELECT id, external_shop_id, name
      FROM shops
      WHERE user_id = $1 AND external_shop_id = ANY($2::text[])
      `,
      [userId, externalShopIds],
    );
    const shopsByExternalId = new Map();
    for (const row of shopsResult.rows) {
      shopsByExternalId.set(String(row.external_shop_id), {
        id: String(row.id),
        externalShopId: String(row.external_shop_id),
        name: String(row.name),
      });
    }
    const missingShopIds = externalShopIds.filter(
      (externalShopId) => !shopsByExternalId.has(externalShopId),
    );
    if (missingShopIds.length > 0) {
      throw new AppError(
        404,
        "SHOP_NOT_SYNCED",
        `\u6709 ${missingShopIds.length} \u4E2A\u5E97\u94FA\u8FD8\u6CA1\u6709\u540C\u6B65\u5230\u4E91\u7AEF\uFF0C\u8BF7\u5148\u540C\u6B65\u5E97\u94FA`,
      );
    }
    const targetByExternalId = new Map();
    for (const target of body.shopTargets) {
      targetByExternalId.set(target.externalShopId, target);
    }
    const sourceAssetIds = [
      ...new Set(body.assets.map((asset) => asset.sourceAssetId)),
    ];
    const assetShopKeys = body.assets.map(
      (asset) => `${asset.sourceAssetId}:${asset.externalShopId}`,
    );
    if (new Set(assetShopKeys).size !== assetShopKeys.length) {
      throw new AppError(
        400,
        "DUPLICATE_ASSET_SELECTION",
        "\u540C\u4E00\u5F20\u56FE\u7247\u4E0D\u80FD\u5728\u540C\u4E00\u4E2A\u5E97\u94FA\u4EFB\u52A1\u91CC\u91CD\u590D\u9009\u62E9",
      );
    }
    const sourceResult = await client.query(
      `
      SELECT id, sku, sha256, ratio_family, product_image_rule_id, product_type, aspect_ratio, public_url, thumb_url
      FROM gallery_assets
      WHERE uploaded_by_user_id = $1
        AND id = ANY($2::uuid[])
        AND deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM gallery_mockup_results mr
          WHERE mr.user_id = $1 AND mr.result_asset_id = gallery_assets.id
        )
      `,
      [userId, sourceAssetIds],
    );
    const sourceById = new Map();
    for (const row of sourceResult.rows) {
      sourceById.set(String(row.id), row);
    }
    const missingAssetIds = sourceAssetIds.filter(
      (assetId) => !sourceById.has(assetId),
    );
    if (missingAssetIds.length > 0) {
      throw new AppError(
        404,
        "ASSET_NOT_FOUND",
        `\u6709 ${missingAssetIds.length} \u5F20\u539F\u56FE\u4E0D\u5B58\u5728\u6216\u4E0D\u662F\u53EF\u4E0A\u67B6\u539F\u56FE`,
      );
    }
    const wrongRuleCount = sourceResult.rows.filter(
      (row) => String(row.product_image_rule_id ?? "") !== productRule.id,
    ).length;
    if (wrongRuleCount > 0) {
      throw new AppError(
        400,
        "PRODUCT_IMAGE_RULE_MISMATCH",
        `? ${wrongRuleCount} ????????????????????`,
      );
    }
    const imageAssetIds = [
      ...new Set(body.assets.flatMap((asset) => asset.imageAssetIds)),
    ];
    const imageResult = await client.query(
      `
      SELECT id, object_key, public_url
      FROM gallery_assets
      WHERE uploaded_by_user_id = $1
        AND id = ANY($2::uuid[])
        AND deleted_at IS NULL
      `,
      [userId, imageAssetIds],
    );
    const imageById = new Map(
      imageResult.rows.map((row) => [
        String(row.id),
        {
          objectKey: String(row.object_key),
          publicUrl: String(row.public_url),
        },
      ]),
    );
    const missingImageIds = imageAssetIds.filter(
      (assetId) => !imageById.has(assetId),
    );
    if (missingImageIds.length > 0) {
      throw new AppError(
        404,
        "LISTING_IMAGE_NOT_FOUND",
        `\u6709 ${missingImageIds.length} \u5F20\u5957\u56FE\u4E0D\u5B58\u5728`,
      );
    }
    const imageUrlById = new Map();
    const imagePrepareConcurrency = 4;
    for (
      let index = 0;
      index < imageAssetIds.length;
      index += imagePrepareConcurrency
    ) {
      const imageAssetIdBatch = imageAssetIds.slice(
        index,
        index + imagePrepareConcurrency,
      );
      const preparedUrls = await Promise.all(
        imageAssetIdBatch.map(async (imageAssetId) => {
          const image = imageById.get(imageAssetId);
          return [
            imageAssetId,
            await ensureOzonListingImageUrl(image.objectKey, image.publicUrl),
          ];
        }),
      );
      preparedUrls.forEach(([imageAssetId, url]) =>
        imageUrlById.set(imageAssetId, url),
      );
    }
    const relationResult = await client.query(
      `
      SELECT source_asset_id, result_asset_id
      FROM gallery_mockup_results
      WHERE user_id = $1
        AND source_asset_id = ANY($2::uuid[])
        AND result_asset_id = ANY($3::uuid[])
      `,
      [userId, sourceAssetIds, imageAssetIds],
    );
    const relationKeys = new Set(
      relationResult.rows.map(
        (row) => `${row.source_asset_id}:${row.result_asset_id}`,
      ),
    );
    for (const selection of body.assets) {
      for (const imageAssetId of selection.imageAssetIds) {
        if (imageAssetId === selection.sourceAssetId) {
          continue;
        }
        if (!relationKeys.has(`${selection.sourceAssetId}:${imageAssetId}`)) {
          throw new AppError(
            400,
            "LISTING_IMAGE_SOURCE_MISMATCH",
            "\u5957\u56FE\u5FC5\u987B\u6765\u81EA\u540C\u4E00\u5F20\u539F\u56FE\u751F\u6210\u7684\u7ED3\u679C",
          );
        }
      }
      if (!targetByExternalId.has(selection.externalShopId)) {
        throw new AppError(
          400,
          "ASSET_SHOP_TARGET_MISSING",
          "\u56FE\u7247\u9009\u62E9\u7684\u5E97\u94FA\u4E0D\u5728\u672C\u6B21\u5E97\u94FA\u4EFB\u52A1\u91CC",
        );
      }
    }
    const batchId = newId();
    const configSnapshotByExternalShopId = new Map();
    for (const target of body.shopTargets) {
      const shop = shopsByExternalId.get(target.externalShopId);
      configSnapshotByExternalShopId.set(
        target.externalShopId,
        normalizeListingConfigSnapshot(target, shop),
      );
    }
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
    await assertManualAssetsAvailableForListing(
      client,
      userId,
      sourceAssetIds,
      body.autoListingRunId,
    );
    await client.query("SET LOCAL statement_timeout = '60s'");
    const occupiedInputs = body.assets.map((selection) => {
      const shop = shopsByExternalId.get(selection.externalShopId);
      const source = sourceById.get(selection.sourceAssetId);
      return { shop_id: shop.id, sku: String(source.sku) };
    });
    await assertDailyListingQuota(
      client,
      userId,
      body.assets,
      shopsByExternalId,
      targetByExternalId,
    );
    const occupiedResult = await client.query(
      `
      SELECT occupied.sku, occupied.shop_id AS "shopId", occupied.source
      FROM jsonb_to_recordset($2::jsonb) AS selected(shop_id uuid, sku text)
      JOIN LATERAL (
        SELECT u.sku, u.shop_id, 'usage' AS source
        FROM gallery_usage u
        WHERE u.user_id = $1
          AND u.shop_id = selected.shop_id
          AND u.sku = selected.sku
        UNION ALL
        SELECT lba.source_sku AS sku, lba.shop_id, 'batch' AS source
        FROM gallery_listing_batch_assets lba
        WHERE lba.user_id = $1
          AND lba.shop_id = selected.shop_id
          AND lba.source_sku = selected.sku
      ) occupied ON TRUE
      `,
      [userId, JSON.stringify(occupiedInputs)],
    );
    if (occupiedResult.rows.length > 0) {
      const labels = occupiedResult.rows.map((row) => {
        const shop = [...shopsByExternalId.values()].find(
          (item) => item.id === String(row.shopId),
        );
        return `${row.sku}${shop ? ` / ${shop.name}` : ""}`;
      });
      throw new AppError(
        409,
        "ASSET_ALREADY_SELECTED",
        `\u4EE5\u4E0B\u56FE\u7247\u5DF2\u7ECF\u5728\u5BF9\u5E94\u5E97\u94FA\u88AB\u9009\u62E9\u6216\u4E0A\u4F20\uFF0C\u4E0D\u80FD\u91CD\u590D\u4F7F\u7528\uFF1A${[...new Set(labels)].slice(0, 8).join("\u3001")}`,
      );
    }
    if (false) {
      const skus = [
        ...new Set(occupiedResult.rows.map((row) => String(row.sku))),
      ];
      throw new AppError(
        409,
        "ASSET_ALREADY_SELECTED",
        `\u4EE5\u4E0B\u56FE\u7247\u5DF2\u7ECF\u88AB\u9009\u62E9\u6216\u4E0A\u4F20\uFF0C\u4E0D\u80FD\u91CD\u590D\u4F7F\u7528\uFF1A${skus.slice(0, 8).join("\u3001")}`,
      );
    }
    const batchResult = await client.query(
      `
      INSERT INTO gallery_listing_batches (
        id,
        user_id,
        ratio_family,
        product_image_rule_id,
        product_type,
        aspect_ratio,
        mockup_template_id,
        mockup_template_name,
        title_prompt_template_id,
        title_prompt_template_name,
        title_prompt,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
      RETURNING
        id,
        status,
        ratio_family AS "ratioFamily",
        product_image_rule_id AS "productImageRuleId",
        product_type AS "productType",
        aspect_ratio AS "aspectRatio",
        mockup_template_id AS "mockupTemplateId",
        mockup_template_name AS "mockupTemplateName",
        title_prompt_template_id AS "titlePromptTemplateId",
        title_prompt_template_name AS "titlePromptTemplateName",
        title_prompt AS "titlePrompt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      `,
      [
        batchId,
        userId,
        batchRatioFamily,
        productRule.id,
        productRule.productType,
        productRule.aspectRatio,
        body.mockupTemplateId,
        body.mockupTemplateName,
        body.titlePromptTemplateId ?? null,
        body.titlePromptTemplateName || null,
        body.titlePrompt || null,
      ],
    );
    for (const target of body.shopTargets) {
      const shop = shopsByExternalId.get(target.externalShopId);
      const productTemplateId = await upsertShopProductTemplate(
        client,
        userId,
        shop.id,
        target,
      );
      await client.query(
        `
        INSERT INTO gallery_listing_batch_shops (
          id,
          batch_id,
          user_id,
          shop_id,
          external_shop_id,
          shop_name,
          product_template_id,
          product_template_name,
          config_snapshot,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now())
        `,
        [
          newId(),
          batchId,
          userId,
          shop.id,
          shop.externalShopId,
          shop.name,
          productTemplateId || target.externalTemplateId || target.name,
          target.name,
          JSON.stringify(
            configSnapshotByExternalShopId.get(target.externalShopId) ?? {},
          ),
        ],
      );
    }
    for (const selection of body.assets) {
      const source = sourceById.get(selection.sourceAssetId);
      const target = targetByExternalId.get(selection.externalShopId);
      const shop = shopsByExternalId.get(selection.externalShopId);
      const imageUrls = selection.imageAssetIds.map((assetId) =>
        imageUrlById.get(assetId),
      );
      await client.query(
        `
        INSERT INTO gallery_listing_batch_assets (
          id,
          batch_id,
          user_id,
          shop_id,
          external_shop_id,
          shop_name,
          product_template_id,
          product_template_name,
          source_asset_id,
          source_sku,
          source_sha256,
          image_asset_ids,
          image_urls,
          title,
          title_generated_at,
          config_snapshot,
          stage_progress,
          listing_progress,
          listing_stage,
          listing_stage_message,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::uuid[], $13::text[], $14, $15, $16::jsonb, $17::jsonb, $18, $19, $20, now())
        `,
        [
          newId(),
          batchId,
          userId,
          shop.id,
          shop.externalShopId,
          shop.name,
          target.id || target.externalTemplateId || target.name,
          target.name,
          source.id,
          source.sku,
          source.sha256,
          selection.imageAssetIds,
          imageUrls,
          selection.title || null,
          selection.title ? new Date() : null,
          JSON.stringify(
            configSnapshotByExternalShopId.get(selection.externalShopId) ?? {},
          ),
          JSON.stringify(
            initialListingStageProgress(selection.title, imageUrls.length),
          ),
          selection.title ? 35 : 20,
          selection.title ? "ready" : "title",
          selection.title
            ? "\u5DF2\u5B8C\u6210\u5957\u56FE\u548C\u6807\u9898\uFF0C\u7B49\u5F85\u63D0\u4EA4\u5230 Ozon"
            : "\u5DF2\u5B8C\u6210\u5957\u56FE\uFF0C\u7B49\u5F85\u751F\u6210\u6807\u9898",
        ],
      );
      if (selection.title) {
        await client.query(
          `
          UPDATE gallery_assets
          SET generated_title = $3,
              generated_title_updated_at = now()
          WHERE id = $1
            AND uploaded_by_user_id = $2
            AND deleted_at IS NULL
          `,
          [selection.sourceAssetId, userId, selection.title],
        );
      }
    }
    await client.query("COMMIT");
    transactionStarted = false;
    return {
      ...batchResult.rows[0],
      imageSets: body.assets.map((selection) => {
        const source = sourceById.get(selection.sourceAssetId);
        const target = targetByExternalId.get(selection.externalShopId);
        const shop = shopsByExternalId.get(selection.externalShopId);
        return {
          externalShopId: shop.externalShopId,
          shopName: shop.name,
          productTemplateName: target.name,
          sourceAssetId: selection.sourceAssetId,
          sourceSku: String(source.sku),
          sourceUrl: String(source.public_url),
          sourceThumbUrl: source.thumb_url ? String(source.thumb_url) : null,
          imageAssetIds: selection.imageAssetIds,
          imageUrls: selection.imageAssetIds.map((assetId) =>
            imageUrlById.get(assetId),
          ),
          title: selection.title || null,
          configSnapshot:
            configSnapshotByExternalShopId.get(selection.externalShopId) ??
            null,
          stageProgress: initialListingStageProgress(
            selection.title,
            selection.imageAssetIds.length,
          ),
          progress: selection.title ? 35 : 20,
          stage: selection.title ? "ready" : "title",
          stageMessage: selection.title
            ? "\u5DF2\u5B8C\u6210\u5957\u56FE\u548C\u6807\u9898\uFF0C\u7B49\u5F85\u63D0\u4EA4\u5230 Ozon"
            : "\u5DF2\u5B8C\u6210\u5957\u56FE\uFF0C\u7B49\u5F85\u751F\u6210\u6807\u9898",
        };
      }),
      shopTargets: body.shopTargets.map((target) => {
        const shop = shopsByExternalId.get(target.externalShopId);
        return {
          externalShopId: shop.externalShopId,
          shopName: shop.name,
          productTemplateId:
            target.id || target.externalTemplateId || target.name,
          productTemplateName: target.name,
          status: "prepared",
          uploadedAt: null,
          error: null,
          configSnapshot:
            configSnapshotByExternalShopId.get(target.externalShopId) ?? null,
        };
      }),
    };
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => void 0);
    }
    throw error;
  } finally {
    client.off("error", onClientError);
    client.release();
  }
}
__name(createListingBatch, "createListingBatch");
__name2(createListingBatch, "createListingBatch");
async function deleteListingUploads(userId, batchIds, requestedSourceAssetIds) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ownedBatches =
      batchIds.length === 0
        ? []
        : (
            await client.query(
              `SELECT id FROM gallery_listing_batches WHERE user_id = $1 AND id = ANY($2::uuid[]) FOR UPDATE`,
              [userId, batchIds],
            )
          ).rows.map((row) => row.id);
    if (ownedBatches.length !== batchIds.length) {
      throw new AppError(
        404,
        "LISTING_UPLOAD_NOT_FOUND",
        "\u90E8\u5206\u4E0A\u4F20\u4EFB\u52A1\u4E0D\u5B58\u5728\u6216\u4E0D\u5C5E\u4E8E\u5F53\u524D\u8D26\u53F7",
      );
    }
    const batchSources =
      ownedBatches.length === 0
        ? []
        : (
            await client.query(
              `SELECT DISTINCT source_asset_id AS "sourceAssetId" FROM gallery_listing_batch_assets WHERE user_id = $1 AND batch_id = ANY($2::uuid[])`,
              [userId, ownedBatches],
            )
          ).rows.map((row) => row.sourceAssetId);
    const sourceAssetIds = [
      ...new Set([...requestedSourceAssetIds, ...batchSources]),
    ];
    if (ownedBatches.length > 0) {
      await client.query(
        `DELETE FROM gallery_listing_batches WHERE user_id = $1 AND id = ANY($2::uuid[])`,
        [userId, ownedBatches],
      );
    }
    let deletedMockupAssets = 0;
    if (sourceAssetIds.length > 0) {
      const removable = await client.query(
        `SELECT DISTINCT mr.result_asset_id AS "resultAssetId"
         FROM gallery_mockup_results mr
         WHERE mr.user_id = $1
           AND mr.source_asset_id = ANY($2::uuid[])
           AND NOT EXISTS (
             SELECT 1 FROM gallery_listing_batch_assets remaining
             WHERE remaining.user_id = $1 AND mr.result_asset_id = ANY(remaining.image_asset_ids)
           )`,
        [userId, sourceAssetIds],
      );
      const resultAssetIds = removable.rows.map((row) => row.resultAssetId);
      if (resultAssetIds.length > 0) {
        const deleted = await client.query(
          `DELETE FROM gallery_assets WHERE uploaded_by_user_id = $1 AND id = ANY($2::uuid[])`,
          [userId, resultAssetIds],
        );
        deletedMockupAssets = deleted.rowCount ?? 0;
      }
    }
    await client.query("COMMIT");
    return {
      deletedBatches: ownedBatches.length,
      deletedMockupAssets,
      releasedSourceAssets: sourceAssetIds.length,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
__name(deleteListingUploads, "deleteListingUploads");
__name2(deleteListingUploads, "deleteListingUploads");
async function markListingBatchUploaded(
  userId,
  batchId,
  options = {},
  includeBatch = true,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const batchResult = await client.query(
      `
      SELECT id
      FROM gallery_listing_batches
      WHERE id = $1 AND user_id = $2
      FOR UPDATE
      `,
      [batchId, userId],
    );
    if (!batchResult.rowCount) {
      throw new AppError(
        404,
        "LISTING_BATCH_NOT_FOUND",
        "\u4E0A\u67B6\u6279\u6B21\u4E0D\u5B58\u5728",
      );
    }
    const externalShopIds = [
      ...new Set(
        (options.externalShopIds ?? [])
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
    const sourceAssetIds = [...new Set(options.sourceAssetIds ?? [])];
    const hasScopedResult =
      externalShopIds.length > 0 || sourceAssetIds.length > 0;
    const assetsQueryValues = [batchId, userId];
    const assetFilters = ["lba.batch_id = $1", "lba.user_id = $2"];
    if (externalShopIds.length > 0) {
      assetsQueryValues.push(externalShopIds);
      assetFilters.push(
        `lba.external_shop_id = ANY($${assetsQueryValues.length}::text[])`,
      );
    }
    if (sourceAssetIds.length > 0) {
      assetsQueryValues.push(sourceAssetIds);
      assetFilters.push(
        `lba.source_asset_id = ANY($${assetsQueryValues.length}::uuid[])`,
      );
    }
    const assetsResult = await client.query(
      `
      SELECT
        lba.user_id,
        lba.shop_id,
        lba.external_shop_id,
        lba.shop_name,
        lba.batch_id,
        lba.listing_product_id,
        lba.source_asset_id AS asset_id,
        lba.source_sku AS sku,
        lba.source_sha256 AS sha256
      FROM gallery_listing_batch_assets lba
      WHERE ${assetFilters.join(" AND ")}
      `,
      assetsQueryValues,
    );
    if (assetsResult.rowCount === 0) {
      throw new AppError(
        404,
        "LISTING_BATCH_ASSETS_NOT_FOUND",
        "\u6CA1\u6709\u627E\u5230\u53EF\u6807\u8BB0\u4E3A\u5DF2\u4E0A\u4F20\u7684\u56FE\u7247",
      );
    }
    const uploadedShopIds = [
      ...new Set(assetsResult.rows.map((row) => String(row.shop_id))),
    ];
    for (const row of assetsResult.rows) {
      const uploadedConflict = await client.query(
        `
        SELECT s.name
        FROM gallery_usage u
        JOIN shops s ON s.id = u.shop_id
        WHERE u.user_id = $1
          AND u.sku = $2
          AND u.usage_type = 'uploaded'
          AND u.shop_id <> $3
        LIMIT 1
        `,
        [row.user_id, row.sku, row.shop_id],
      );
      if (false) {
        throw new AppError(
          409,
          "ASSET_ALREADY_UPLOADED",
          `${row.sku} \u5DF2\u4E0A\u4F20\u5230 ${uploadedConflict.rows[0].name}\uFF0C\u4E0D\u80FD\u518D\u4E0A\u4F20\u5230\u5176\u4ED6\u5E97\u94FA`,
        );
      }
      await client.query(
        `
        INSERT INTO gallery_usage (id, user_id, shop_id, asset_id, sku, sha256, usage_type)
        VALUES ($1, $2, $3, $4, $5, $6, 'uploaded')
        ON CONFLICT (user_id, shop_id, sku)
        DO UPDATE SET
          asset_id = excluded.asset_id,
          sha256 = excluded.sha256,
          usage_type = 'uploaded',
          used_at = now()
        `,
        [newId(), row.user_id, row.shop_id, row.asset_id, row.sku, row.sha256],
      );
    }
    await recordShopListingEvents(client, assetsResult.rows);
    const progressUpdateValues = [...assetsQueryValues];
    await client.query(
      `
      UPDATE gallery_listing_batch_assets lba
      SET stage_progress = COALESCE(lba.stage_progress, '{}'::jsonb)
            || jsonb_build_object(
              'listing', jsonb_build_object('status', 'done', 'progress', 100, 'message', 'uploaded', 'updatedAt', now()),
              'workflow', jsonb_build_object(
                'status', 'done',
                'progress', 100,
                'message', 'completed',
                'updatedAt', now()
              )
            ),
          listing_progress = 100,
          listing_stage = 'workflow',
          listing_stage_message = 'completed',
          listing_completed_at = COALESCE(lba.listing_completed_at, now()),
          updated_at = now()
      WHERE ${assetFilters.join(" AND ")}
      `,
      progressUpdateValues,
    );
    await client.query(
      `
      UPDATE gallery_listing_batch_shops shops
      SET status = CASE WHEN EXISTS (
            SELECT 1 FROM gallery_listing_batch_assets pending
            WHERE pending.batch_id = shops.batch_id
              AND pending.shop_id = shops.shop_id
              AND pending.listing_completed_at IS NULL
          ) THEN 'prepared' ELSE 'uploaded' END,
          uploaded_at = CASE WHEN EXISTS (
            SELECT 1 FROM gallery_listing_batch_assets pending
            WHERE pending.batch_id = shops.batch_id
              AND pending.shop_id = shops.shop_id
              AND pending.listing_completed_at IS NULL
          ) THEN NULL ELSE COALESCE(shops.uploaded_at, now()) END,
          updated_at = now()
      WHERE shops.batch_id = $1 AND shops.user_id = $2
      `,
      [batchId, userId],
    );
    await client.query(
      `
      UPDATE gallery_listing_batches batches
      SET status = CASE WHEN EXISTS (
            SELECT 1 FROM gallery_listing_batch_assets pending
            WHERE pending.batch_id = batches.id
              AND pending.listing_completed_at IS NULL
          ) THEN 'prepared' ELSE 'uploaded' END,
          updated_at = now()
      WHERE batches.id = $1 AND batches.user_id = $2
      `,
      [batchId, userId],
    );
    await client.query("COMMIT");
    return includeBatch ? readListingBatch(userId, batchId) : null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
__name(markListingBatchUploaded, "markListingBatchUploaded");
__name2(markListingBatchUploaded, "markListingBatchUploaded");
async function updateListingBatchProgress(userId, batchId, body) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const batchResult = await client.query(
      `
      SELECT id
      FROM gallery_listing_batches
      WHERE id = $1 AND user_id = $2
      FOR UPDATE
      `,
      [batchId, userId],
    );
    if (!batchResult.rowCount) {
      throw new AppError(
        404,
        "LISTING_BATCH_NOT_FOUND",
        "\u4E0A\u67B6\u6279\u6B21\u4E0D\u5B58\u5728",
      );
    }
    for (const item of body.items) {
      const filters = ["batch_id = $1", "user_id = $2", "source_asset_id = $3"];
      const values = [batchId, userId, item.sourceAssetId];
      if (item.externalShopId) {
        values.push(item.externalShopId);
        filters.push(`external_shop_id = $${values.length}`);
      }
      const stagePatch = {
        [item.stage]: {
          status: item.status,
          progress: item.progress ?? item.overallProgress ?? 0,
          message: item.message ?? "",
          productId: item.productId ?? null,
          updatedAt: new Date().toISOString(),
        },
      };
      values.push(JSON.stringify(stagePatch));
      const stagePatchIndex = values.length;
      values.push(item.overallProgress ?? item.progress ?? null);
      const progressIndex = values.length;
      values.push(item.stage);
      const stageIndex = values.length;
      values.push(item.message ?? null);
      const messageIndex = values.length;
      values.push(item.productId ?? null);
      const productIdIndex = values.length;
      values.push(item.completed ?? false);
      const completedIndex = values.length;
      await client.query(
        `
        UPDATE gallery_listing_batch_assets
        SET stage_progress = COALESCE(stage_progress, '{}'::jsonb) || $${stagePatchIndex}::jsonb,
            listing_progress = COALESCE($${progressIndex}::int, listing_progress),
            listing_stage = $${stageIndex},
            listing_stage_message = COALESCE($${messageIndex}::text, listing_stage_message),
            listing_product_id = COALESCE($${productIdIndex}::bigint, listing_product_id),
            listing_completed_at = CASE WHEN $${completedIndex}::boolean THEN COALESCE(listing_completed_at, now()) ELSE listing_completed_at END,
            updated_at = now()
        WHERE ${filters.join(" AND ")}
        `,
        values,
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
__name(updateListingBatchProgress, "updateListingBatchProgress");
__name2(updateListingBatchProgress, "updateListingBatchProgress");
async function recordShopListingEvents(client, rows) {
  if (rows.length === 0) {
    return;
  }
  const eventRows = rows.map((row) => ({
    user_id: row.user_id,
    shop_id: row.shop_id,
    external_shop_id: row.external_shop_id,
    shop_name: row.shop_name,
    batch_id: row.batch_id ?? null,
    source_asset_id: row.asset_id,
    source_sku: row.sku,
    listing_product_id: row.listing_product_id ?? null,
  }));
  const inserted = await client.query(
    `
    INSERT INTO shop_listing_events (
      user_id,
      shop_id,
      external_shop_id,
      shop_name,
      batch_id,
      source_asset_id,
      source_sku,
      listing_product_id,
      listed_at,
      created_at,
      updated_at
    )
    SELECT
      item.user_id,
      item.shop_id,
      item.external_shop_id,
      item.shop_name,
      item.batch_id,
      item.source_asset_id,
      item.source_sku,
      item.listing_product_id,
      now(),
      now(),
      now()
    FROM jsonb_to_recordset($1::jsonb) AS item(
      user_id uuid,
      shop_id uuid,
      external_shop_id text,
      shop_name text,
      batch_id uuid,
      source_asset_id uuid,
      source_sku text,
      listing_product_id bigint
    )
    ON CONFLICT (user_id, shop_id, source_sku) DO NOTHING
    RETURNING
      user_id,
      shop_id,
      external_shop_id,
      shop_name,
      listed_at
    `,
    [JSON.stringify(eventRows)],
  );
  if (inserted.rowCount === 0) {
    return;
  }
  await client.query(
    `
    INSERT INTO shop_daily_listing_stats (
      user_id,
      shop_id,
      external_shop_id,
      shop_name,
      stat_date,
      listed_count,
      first_listed_at,
      last_listed_at,
      updated_at
    )
    SELECT
      user_id,
      shop_id,
      (array_agg(external_shop_id ORDER BY listed_at DESC))[1],
      (array_agg(shop_name ORDER BY listed_at DESC))[1],
      (listed_at AT TIME ZONE 'Asia/Shanghai')::date,
      count(*)::int,
      min(listed_at),
      max(listed_at),
      now()
    FROM jsonb_to_recordset($1::jsonb) AS item(
      user_id uuid,
      shop_id uuid,
      external_shop_id text,
      shop_name text,
      listed_at timestamptz
    )
    GROUP BY user_id, shop_id, (listed_at AT TIME ZONE 'Asia/Shanghai')::date
    ON CONFLICT (user_id, shop_id, stat_date)
    DO UPDATE SET
      external_shop_id = EXCLUDED.external_shop_id,
      shop_name = EXCLUDED.shop_name,
      listed_count = shop_daily_listing_stats.listed_count + EXCLUDED.listed_count,
      first_listed_at = LEAST(
        COALESCE(shop_daily_listing_stats.first_listed_at, EXCLUDED.first_listed_at),
        EXCLUDED.first_listed_at
      ),
      last_listed_at = GREATEST(
        COALESCE(shop_daily_listing_stats.last_listed_at, EXCLUDED.last_listed_at),
        EXCLUDED.last_listed_at
      ),
      updated_at = now()
    `,
    [JSON.stringify(inserted.rows)],
  );
}
__name(recordShopListingEvents, "recordShopListingEvents");
__name2(recordShopListingEvents, "recordShopListingEvents");
async function assertDailyListingQuota(
  client,
  userId,
  selections,
  shopsByExternalId,
  targetByExternalId,
) {
  const byExternalShopId = new Map();
  for (const selection of selections) {
    byExternalShopId.set(
      selection.externalShopId,
      (byExternalShopId.get(selection.externalShopId) ?? 0) + 1,
    );
  }
  const exceeded = [];
  for (const [externalShopId, selectedCount] of byExternalShopId) {
    const shop = shopsByExternalId.get(externalShopId);
    const target = targetByExternalId.get(externalShopId);
    if (!shop || !target) {
      continue;
    }
    await lockDailyListingQuota(client, userId, shop.id);
    const limit = normalizeDailyListingLimit(
      target.configSnapshot?.dailyListingLimit,
    );
    const reservedToday = await countTodayReservedListings(
      client,
      userId,
      shop.id,
    );
    const remaining = Math.max(0, limit - reservedToday);
    if (selectedCount > remaining) {
      exceeded.push(
        `${shop.name}\uFF1A\u4ECA\u65E5\u9650\u989D ${limit}\uFF0C\u5DF2\u5360\u7528 ${reservedToday}\uFF0C\u5269\u4F59 ${remaining}\uFF0C\u672C\u6B21\u9009\u62E9 ${selectedCount}`,
      );
    }
  }
  if (exceeded.length > 0) {
    throw new AppError(
      409,
      "DAILY_LISTING_LIMIT_EXCEEDED",
      `\u5E97\u94FA\u4ECA\u65E5\u4E0A\u67B6\u6570\u91CF\u8D85\u8FC7\u9650\u5236\uFF0C\u8BF7\u51CF\u5C11\u9009\u62E9\u6570\u91CF\u6216\u8C03\u6574\u5E97\u94FA\u9650\u989D\uFF1A${exceeded.join("\uFF1B")}`,
    );
  }
}
__name(assertDailyListingQuota, "assertDailyListingQuota");
__name2(assertDailyListingQuota, "assertDailyListingQuota");
async function lockDailyListingQuota(client, userId, shopId) {
  const result = await client.query(
    `
    SELECT pg_try_advisory_xact_lock(hashtextextended($1 || ':' || $2, 1701)) AS locked
    `,
    [userId, shopId],
  );
  if (!result.rows[0]?.locked) {
    throw new AppError(
      409,
      "SHOP_LISTING_BUSY",
      "\u8BE5\u5E97\u94FA\u5DF2\u6709\u4E0A\u67B6\u4EFB\u52A1\u6B63\u5728\u751F\u6210\u4E0A\u67B6\u5305\uFF0C\u8BF7\u7A0D\u540E\u81EA\u52A8\u91CD\u8BD5",
    );
  }
}
__name(lockDailyListingQuota, "lockDailyListingQuota");
__name2(lockDailyListingQuota, "lockDailyListingQuota");
async function countTodayReservedListings(client, userId, shopId) {
  const result = await client.query(
    `
    SELECT count(*)::int AS count
    FROM gallery_listing_batch_assets
    WHERE user_id = $1
      AND shop_id = $2
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_each(COALESCE(stage_progress, '{}'::jsonb)) AS stage(_, value)
        WHERE stage.value->>'status' = 'failed'
      )
      AND (
        (
          listing_completed_at IS NOT NULL
          AND (listing_completed_at AT TIME ZONE 'Asia/Shanghai')::date = (now() AT TIME ZONE 'Asia/Shanghai')::date
        )
        OR (
          listing_completed_at IS NULL
          AND (created_at AT TIME ZONE 'Asia/Shanghai')::date = (now() AT TIME ZONE 'Asia/Shanghai')::date
        )
      )
    `,
    [userId, shopId],
  );
  return Number(result.rows[0]?.count ?? 0);
}
__name(countTodayReservedListings, "countTodayReservedListings");
__name2(countTodayReservedListings, "countTodayReservedListings");
function normalizeDailyListingLimit(value) {
  const parsed = Number(value ?? DEFAULT_DAILY_LISTING_LIMIT);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_DAILY_LISTING_LIMIT;
}
__name(normalizeDailyListingLimit, "normalizeDailyListingLimit");
__name2(normalizeDailyListingLimit, "normalizeDailyListingLimit");
async function listDailyListingStats(userId, query) {
  const today = localDateString(new Date());
  const dateFrom = query.dateFrom ?? today;
  const dateTo = query.dateTo ?? dateFrom;
  const values = [userId, dateFrom, dateTo];
  const completedFilters = [
    "lba.user_id = $1",
    "lba.listing_completed_at IS NOT NULL",
    "(lba.listing_completed_at AT TIME ZONE 'Asia/Shanghai')::date >= $2::date",
    "(lba.listing_completed_at AT TIME ZONE 'Asia/Shanghai')::date <= $3::date",
  ];
  const reservedFilters = [
    "lba.user_id = $1",
    `NOT EXISTS (
      SELECT 1
      FROM jsonb_each(COALESCE(lba.stage_progress, '{}'::jsonb)) AS stage(_, value)
      WHERE stage.value->>'status' = 'failed'
    )`,
    `(
      (
        lba.listing_completed_at IS NOT NULL
        AND (lba.listing_completed_at AT TIME ZONE 'Asia/Shanghai')::date >= $2::date
        AND (lba.listing_completed_at AT TIME ZONE 'Asia/Shanghai')::date <= $3::date
      )
      OR (
        lba.listing_completed_at IS NULL
        AND (lba.created_at AT TIME ZONE 'Asia/Shanghai')::date >= $2::date
        AND (lba.created_at AT TIME ZONE 'Asia/Shanghai')::date <= $3::date
      )
    )`,
  ];
  if (query.externalShopId) {
    values.push(query.externalShopId);
    completedFilters.push(`lba.external_shop_id = $${values.length}`);
    reservedFilters.push(`lba.external_shop_id = $${values.length}`);
  }
  const result = await pool.query(
    `
    WITH completed AS (
      SELECT
        lba.user_id,
        lba.shop_id,
        (array_agg(lba.external_shop_id ORDER BY lba.listing_completed_at DESC))[1] AS "externalShopId",
        (array_agg(lba.shop_name ORDER BY lba.listing_completed_at DESC))[1] AS "shopName",
        (lba.listing_completed_at AT TIME ZONE 'Asia/Shanghai')::date::text AS "date",
        count(*)::int AS "listedCount",
        min(lba.listing_completed_at) AS "firstListedAt",
        max(lba.listing_completed_at) AS "lastListedAt"
      FROM gallery_listing_batch_assets lba
      WHERE ${completedFilters.join(" AND ")}
      GROUP BY
        lba.user_id,
        lba.shop_id,
        (lba.listing_completed_at AT TIME ZONE 'Asia/Shanghai')::date
    ),
    reserved AS (
      SELECT
        lba.user_id,
        lba.shop_id,
        (array_agg(lba.external_shop_id ORDER BY COALESCE(lba.listing_completed_at, lba.updated_at, lba.created_at) DESC))[1] AS "externalShopId",
        (array_agg(lba.shop_name ORDER BY COALESCE(lba.listing_completed_at, lba.updated_at, lba.created_at) DESC))[1] AS "shopName",
        (
          CASE
            WHEN lba.listing_completed_at IS NULL THEN (lba.created_at AT TIME ZONE 'Asia/Shanghai')::date
            ELSE (lba.listing_completed_at AT TIME ZONE 'Asia/Shanghai')::date
          END
        )::text AS "date",
        count(*)::int AS "reservedCount",
        count(*) FILTER (WHERE lba.listing_completed_at IS NULL)::int AS "pendingCount"
      FROM gallery_listing_batch_assets lba
      WHERE ${reservedFilters.join(" AND ")}
      GROUP BY
        lba.user_id,
        lba.shop_id,
        CASE
          WHEN lba.listing_completed_at IS NULL THEN (lba.created_at AT TIME ZONE 'Asia/Shanghai')::date
          ELSE (lba.listing_completed_at AT TIME ZONE 'Asia/Shanghai')::date
        END
    )
    SELECT
      COALESCE(c."externalShopId", r."externalShopId") AS "externalShopId",
      COALESCE(c."shopName", r."shopName") AS "shopName",
      COALESCE(c."date", r."date") AS "date",
      COALESCE(c."listedCount", 0)::int AS "listedCount",
      COALESCE(r."reservedCount", c."listedCount", 0)::int AS "reservedCount",
      COALESCE(r."pendingCount", 0)::int AS "pendingCount",
      c."firstListedAt",
      c."lastListedAt"
    FROM completed c
    FULL OUTER JOIN reserved r
      ON c.user_id = r.user_id
      AND c.shop_id = r.shop_id
      AND c."date" = r."date"
    ORDER BY "date" DESC, "reservedCount" DESC, "listedCount" DESC, "shopName" ASC
    `,
    values,
  );
  return result.rows;
}
__name(listDailyListingStats, "listDailyListingStats");
__name2(listDailyListingStats, "listDailyListingStats");
async function listListingReconciliation(userId, query) {
  const today = localDateString(new Date());
  const dateFrom = query.dateFrom ?? today;
  const dateTo = query.dateTo ?? dateFrom;
  const values = [userId, dateFrom, dateTo];
  const filters = [
    "lba.user_id = $1",
    `(
      (lba.created_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $2::date AND $3::date
      OR (
        lba.listing_completed_at IS NOT NULL
        AND (lba.listing_completed_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $2::date AND $3::date
      )
    )`,
  ];
  if (query.externalShopId) {
    values.push(query.externalShopId);
    filters.push(`lba.external_shop_id = $${values.length}`);
  }
  const result = await pool.query(
    `
    WITH scoped AS (
      SELECT
        lba.batch_id,
        lb.status AS batch_status,
        lb.mockup_template_name,
        lba.external_shop_id,
        lba.shop_name,
        lba.source_sku,
        lba.created_at,
        lba.updated_at,
        lba.title,
        lba.listing_completed_at,
        lba.listing_progress,
        lba.listing_stage,
        lba.listing_stage_message,
        COALESCE(lba.stage_progress, '{}'::jsonb) AS stage_progress,
        COALESCE(lba.stage_progress->'mockup'->>'status', '') AS mockup_status,
        COALESCE(lba.stage_progress->'title'->>'status', '') AS title_status,
        COALESCE(lba.stage_progress->'listing'->>'status', '') AS listing_status,
        COALESCE(lba.stage_progress->'workflow'->>'status', '') AS workflow_status,
        EXISTS (
          SELECT 1
          FROM jsonb_each(COALESCE(lba.stage_progress, '{}'::jsonb)) AS stage(_, value)
          WHERE stage.value->>'status' = 'failed'
        ) AS has_failed_stage
      FROM gallery_listing_batch_assets lba
      JOIN gallery_listing_batches lb ON lb.id = lba.batch_id
      WHERE ${filters.join(" AND ")}
    ),
    classified AS (
      SELECT
        *,
        (
          listing_completed_at IS NOT NULL
          OR workflow_status = 'done'
          OR batch_status = 'uploaded'
        ) AS is_completed,
        (
          listing_completed_at IS NULL
          AND workflow_status <> 'done'
          AND (has_failed_stage OR batch_status = 'failed' OR listing_stage = 'failed')
        ) AS is_failed,
        (
          listing_completed_at IS NULL
          AND workflow_status <> 'done'
          AND NOT (has_failed_stage OR batch_status = 'failed' OR listing_stage = 'failed')
          AND (listing_stage = 'mockup' OR mockup_status IN ('queued', 'running', 'waiting'))
        ) AS is_mockup_running,
        (
          listing_completed_at IS NULL
          AND workflow_status <> 'done'
          AND NOT (has_failed_stage OR batch_status = 'failed' OR listing_stage = 'failed')
          AND (listing_stage = 'title' OR title_status IN ('queued', 'running', 'waiting'))
        ) AS is_title_running,
        (
          listing_completed_at IS NULL
          AND workflow_status <> 'done'
          AND NOT (has_failed_stage OR batch_status = 'failed' OR listing_stage = 'failed')
          AND (
            listing_stage IN ('ready', 'listing', 'stock', 'barcode', 'action', 'workflow', 'submit')
            OR listing_status IN ('queued', 'running', 'waiting')
          )
        ) AS is_listing_running
      FROM scoped
    ),
    current_by_shop AS (
      SELECT DISTINCT ON (external_shop_id)
        external_shop_id,
        source_sku,
        listing_stage,
        listing_stage_message,
        updated_at
      FROM classified
      WHERE NOT is_completed AND NOT is_failed
      ORDER BY external_shop_id, updated_at DESC
    ),
    shop_rows AS (
      SELECT
        c.external_shop_id AS "externalShopId",
        (array_agg(c.shop_name ORDER BY c.updated_at DESC))[1] AS "shopName",
        count(*)::int AS total,
        count(*) FILTER (WHERE c.is_completed)::int AS "completedCount",
        count(*) FILTER (WHERE c.is_failed)::int AS "failedCount",
        count(*) FILTER (WHERE NOT c.is_completed AND NOT c.is_failed)::int AS "processingCount",
        count(*) FILTER (WHERE c.mockup_status = 'done' OR c.is_completed)::int AS "mockupDone",
        count(*) FILTER (WHERE c.is_mockup_running)::int AS "mockupRunning",
        count(*) FILTER (WHERE c.title_status = 'done' OR c.title IS NOT NULL OR c.is_completed)::int AS "titleDone",
        count(*) FILTER (WHERE c.is_title_running)::int AS "titleRunning",
        count(*) FILTER (WHERE c.is_completed)::int AS "listingDone",
        count(*) FILTER (WHERE c.is_listing_running)::int AS "listingRunning",
        round(avg(GREATEST(0, LEAST(100, c.listing_progress)))::numeric)::int AS progress,
        max(c.updated_at) AS "updatedAt"
      FROM classified c
      GROUP BY c.external_shop_id
    ),
    batch_rows AS (
      SELECT
        c.batch_id AS "batchId",
        (array_agg(c.batch_status ORDER BY c.updated_at DESC))[1] AS status,
        (array_agg(c.mockup_template_name ORDER BY c.updated_at DESC))[1] AS "mockupTemplateName",
        count(*)::int AS total,
        count(*) FILTER (WHERE c.is_completed)::int AS "completedCount",
        count(*) FILTER (WHERE c.is_failed)::int AS "failedCount",
        count(*) FILTER (WHERE NOT c.is_completed AND NOT c.is_failed)::int AS "processingCount",
        count(DISTINCT c.external_shop_id)::int AS "shopCount",
        min(c.created_at) AS "createdAt",
        max(c.updated_at) AS "updatedAt"
      FROM classified c
      GROUP BY c.batch_id
    )
    SELECT json_build_object(
      'dateFrom', $2::text,
      'dateTo', $3::text,
      'total', COALESCE((SELECT count(*)::int FROM classified), 0),
      'completedCount', COALESCE((SELECT count(*)::int FROM classified WHERE is_completed), 0),
      'failedCount', COALESCE((SELECT count(*)::int FROM classified WHERE is_failed), 0),
      'processingCount', COALESCE((SELECT count(*)::int FROM classified WHERE NOT is_completed AND NOT is_failed), 0),
      'mockupRunningCount', COALESCE((SELECT count(*)::int FROM classified WHERE is_mockup_running), 0),
      'titleRunningCount', COALESCE((SELECT count(*)::int FROM classified WHERE is_title_running), 0),
      'listingRunningCount', COALESCE((SELECT count(*)::int FROM classified WHERE is_listing_running), 0),
      'shops', COALESCE((
        SELECT json_agg(json_build_object(
          'externalShopId', s."externalShopId",
          'shopName', s."shopName",
          'total', s.total,
          'completedCount', s."completedCount",
          'failedCount', s."failedCount",
          'processingCount', s."processingCount",
          'mockupDone', s."mockupDone",
          'mockupRunning', s."mockupRunning",
          'titleDone', s."titleDone",
          'titleRunning', s."titleRunning",
          'listingDone', s."listingDone",
          'listingRunning', s."listingRunning",
          'progress', COALESCE(s.progress, 0),
          'currentSku', cb.source_sku,
          'currentStage', cb.listing_stage,
          'currentMessage', cb.listing_stage_message,
          'updatedAt', s."updatedAt"
        ) ORDER BY s."processingCount" DESC, s."completedCount" DESC, s."shopName" ASC)
        FROM shop_rows s
        LEFT JOIN current_by_shop cb ON cb.external_shop_id = s."externalShopId"
      ), '[]'::json),
      'batches', COALESCE((
        SELECT json_agg(json_build_object(
          'batchId', b."batchId",
          'status', b.status,
          'mockupTemplateName', b."mockupTemplateName",
          'total', b.total,
          'completedCount', b."completedCount",
          'failedCount', b."failedCount",
          'processingCount', b."processingCount",
          'shopCount', b."shopCount",
          'createdAt', b."createdAt",
          'updatedAt', b."updatedAt"
        ) ORDER BY b."updatedAt" DESC)
        FROM batch_rows b
      ), '[]'::json)
    ) AS summary
    `,
    values,
  );
  return (
    result.rows[0]?.summary ?? {
      dateFrom,
      dateTo,
      total: 0,
      completedCount: 0,
      failedCount: 0,
      processingCount: 0,
      mockupRunningCount: 0,
      titleRunningCount: 0,
      listingRunningCount: 0,
      shops: [],
      batches: [],
    }
  );
}
__name(listListingReconciliation, "listListingReconciliation");
__name2(listListingReconciliation, "listListingReconciliation");
function localDateString(date) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(date);
}
__name(localDateString, "localDateString");
__name2(localDateString, "localDateString");
async function repairListingBatchImageUrls(userId, batchId) {
  const rows = await pool.query(
    `
    SELECT
      lba.id,
      lba.image_asset_ids,
      lba.image_urls,
      COALESCE(json_agg(json_build_object(
        'id', a.id,
        'objectKey', a.object_key,
        'publicUrl', a.public_url
      ) ORDER BY asset_order.ord) FILTER (WHERE a.id IS NOT NULL), '[]'::json) AS images
    FROM gallery_listing_batch_assets lba
    LEFT JOIN LATERAL unnest(lba.image_asset_ids) WITH ORDINALITY AS asset_order(asset_id, ord) ON TRUE
    LEFT JOIN gallery_assets a
      ON a.id = asset_order.asset_id
      AND a.uploaded_by_user_id = $1
      AND a.deleted_at IS NULL
    WHERE lba.user_id = $1
      AND lba.batch_id = $2
    GROUP BY lba.id, lba.image_asset_ids, lba.image_urls
    `,
    [userId, batchId],
  );
  for (const row of rows.rows) {
    const images = Array.isArray(row.images) ? row.images : [];
    if (images.length === 0) {
      continue;
    }
    const repairedUrls = [];
    for (const image of images) {
      const objectKey =
        typeof image.objectKey === "string" ? image.objectKey : "";
      const publicUrl =
        typeof image.publicUrl === "string" ? image.publicUrl : "";
      if (!objectKey || !publicUrl) {
        continue;
      }
      repairedUrls.push(await ensureOzonListingImageUrl(objectKey, publicUrl));
    }
    if (
      repairedUrls.length === 0 ||
      arraysEqual(repairedUrls, row.image_urls ?? [])
    ) {
      continue;
    }
    await pool.query(
      `
      UPDATE gallery_listing_batch_assets
      SET image_urls = $3::text[], updated_at = now()
      WHERE id = $1 AND user_id = $2
      `,
      [row.id, userId, repairedUrls],
    );
  }
}
__name(repairListingBatchImageUrls, "repairListingBatchImageUrls");
__name2(repairListingBatchImageUrls, "repairListingBatchImageUrls");
async function listListingImageRepairItems(userId, query) {
  const values = [userId];
  const filters = [
    "lba.user_id = $1",
    "(b.status = 'uploaded' OR bs.status = 'uploaded' OR lba.listing_product_id IS NOT NULL OR lba.listing_completed_at IS NOT NULL)",
  ];
  if (query.externalShopId) {
    values.push(query.externalShopId);
    filters.push(`lba.external_shop_id = $${values.length}`);
  }
  if (query.keyword) {
    values.push(`%${query.keyword}%`);
    filters.push(`lba.source_sku ILIKE $${values.length}`);
  }
  const whereSql = filters.join(" AND ");
  const countResult = await pool.query(
    `
    SELECT count(*)::int AS total
    FROM gallery_listing_batch_assets lba
    JOIN gallery_listing_batches b ON b.id = lba.batch_id
    LEFT JOIN gallery_listing_batch_shops bs
      ON bs.batch_id = lba.batch_id
      AND bs.shop_id = lba.shop_id
    WHERE ${whereSql}
    `,
    values,
  );
  const listValues = [...values, query.limit, query.offset];
  const limitIndex = listValues.length - 1;
  const offsetIndex = listValues.length;
  const rows = await pool.query(
    `
    SELECT
      lba.id,
      lba.batch_id AS "batchId",
      lba.external_shop_id AS "externalShopId",
      lba.shop_name AS "shopName",
      lba.source_asset_id AS "sourceAssetId",
      lba.source_sku AS "sourceSku",
      lba.image_asset_ids AS "imageAssetIds",
      lba.image_urls AS "imageUrls",
      COALESCE(bs.uploaded_at, b.updated_at) AS "uploadedAt",
      lba.updated_at AS "updatedAt",
      COALESCE(json_agg(json_build_object(
        'id', a.id,
        'objectKey', a.object_key,
        'publicUrl', a.public_url
      ) ORDER BY asset_order.ord) FILTER (WHERE a.id IS NOT NULL), '[]'::json) AS images
    FROM gallery_listing_batch_assets lba
    JOIN gallery_listing_batches b ON b.id = lba.batch_id
    LEFT JOIN gallery_listing_batch_shops bs
      ON bs.batch_id = lba.batch_id
      AND bs.shop_id = lba.shop_id
    LEFT JOIN LATERAL unnest(lba.image_asset_ids) WITH ORDINALITY AS asset_order(asset_id, ord) ON TRUE
    LEFT JOIN gallery_assets a
      ON a.id = asset_order.asset_id
      AND a.uploaded_by_user_id = $1
      AND a.deleted_at IS NULL
    WHERE ${whereSql}
    GROUP BY lba.id, b.id, bs.uploaded_at
    ORDER BY COALESCE(bs.uploaded_at, b.updated_at, lba.updated_at) DESC, lba.updated_at DESC
    LIMIT $${limitIndex}
    OFFSET $${offsetIndex}
    `,
    listValues,
  );
  const items = [];
  for (const row of rows.rows) {
    const images = Array.isArray(row.images) ? row.images : [];
    const repairedUrls = [];
    for (const image of images) {
      const objectKey =
        typeof image.objectKey === "string" ? image.objectKey : "";
      const publicUrl =
        typeof image.publicUrl === "string" ? image.publicUrl : "";
      if (!objectKey || !publicUrl) {
        continue;
      }
      repairedUrls.push(await ensureOzonListingImageUrl(objectKey, publicUrl));
    }
    const imageUrls =
      repairedUrls.length > 0 ? repairedUrls : (row.imageUrls ?? []);
    if (
      repairedUrls.length > 0 &&
      !arraysEqual(repairedUrls, row.imageUrls ?? [])
    ) {
      await pool.query(
        `
        UPDATE gallery_listing_batch_assets
        SET image_urls = $3::text[], updated_at = now()
        WHERE id = $1 AND user_id = $2
        `,
        [row.id, userId, repairedUrls],
      );
    }
    items.push({
      batchId: row.batchId,
      externalShopId: row.externalShopId,
      shopName: row.shopName,
      sourceAssetId: row.sourceAssetId,
      sourceSku: row.sourceSku,
      imageAssetIds: row.imageAssetIds ?? [],
      imageUrls,
      uploadedAt: row.uploadedAt ?? null,
      updatedAt: row.updatedAt ?? null,
    });
  }
  return {
    items,
    total: countResult.rows[0]?.total ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}
__name(listListingImageRepairItems, "listListingImageRepairItems");
__name2(listListingImageRepairItems, "listListingImageRepairItems");
async function resolveOzonListingImageUrls(userId, imageAssetIds) {
  const result = await pool.query(
    `
    SELECT
      asset_order.asset_id AS "assetId",
      asset_order.ord,
      a.object_key AS "objectKey",
      a.public_url AS "publicUrl"
    FROM unnest($2::uuid[]) WITH ORDINALITY AS asset_order(asset_id, ord)
    LEFT JOIN gallery_assets a
      ON a.id = asset_order.asset_id
      AND a.uploaded_by_user_id = $1
      AND a.deleted_at IS NULL
    ORDER BY asset_order.ord
    `,
    [userId, imageAssetIds],
  );
  const rows = result.rows;
  if (
    rows.length !== imageAssetIds.length ||
    rows.some((row) => !row.objectKey || !row.publicUrl)
  ) {
    throw new AppError(
      404,
      "LISTING_IMAGE_ASSET_NOT_FOUND",
      "One or more generated mockup assets were not found",
    );
  }
  const imageUrls = [];
  for (const row of rows) {
    imageUrls.push(
      await ensureOzonListingImageUrl(row.objectKey, row.publicUrl),
    );
  }
  return imageUrls;
}
__name(resolveOzonListingImageUrls, "resolveOzonListingImageUrls");
__name2(resolveOzonListingImageUrls, "resolveOzonListingImageUrls");
async function updateListingRepairImageRecord(userId, item, imageUrls) {
  const filters = ["user_id = $1", "external_shop_id = $2", "source_sku = $3"];
  const values = [
    userId,
    item.externalShopId,
    item.sourceSku,
    item.imageAssetIds,
    imageUrls,
  ];
  if (item.batchId) {
    values.push(item.batchId);
    filters.push(`batch_id = $${values.length}`);
  }
  if (item.sourceAssetId) {
    values.push(item.sourceAssetId);
    filters.push(`source_asset_id = $${values.length}`);
  }
  const result = await pool.query(
    `
    UPDATE gallery_listing_batch_assets
    SET image_asset_ids = $4::uuid[],
        image_urls = $5::text[],
        stage_progress = jsonb_set(
          COALESCE(stage_progress, '{}'::jsonb),
          '{mockup}',
          jsonb_build_object('status', 'done', 'progress', 100, 'done', cardinality($4::uuid[]), 'total', cardinality($4::uuid[])),
          true
        ),
        updated_at = now()
    WHERE ${filters.join(" AND ")}
    RETURNING
      batch_id AS "batchId",
      external_shop_id AS "externalShopId",
      shop_name AS "shopName",
      source_asset_id AS "sourceAssetId",
      source_sku AS "sourceSku",
      image_asset_ids AS "imageAssetIds",
      image_urls AS "imageUrls",
      updated_at AS "updatedAt"
    `,
    values,
  );
  const updated = result.rows[0];
  if (!updated) {
    return null;
  }
  await pool.query(
    "UPDATE gallery_listing_batches SET updated_at = now() WHERE id = $1 AND user_id = $2",
    [updated.batchId, userId],
  );
  return { ...updated, uploadedAt: null };
}
__name(updateListingRepairImageRecord, "updateListingRepairImageRecord");
__name2(updateListingRepairImageRecord, "updateListingRepairImageRecord");
async function ensureOzonListingImageUrl(objectKey, fallbackUrl) {
  const ozonObjectKey = ozonListingObjectKeyForOriginal(objectKey);
  try {
    if (!(await objectExists(ozonObjectKey))) {
      const buffer = await readObjectBuffer(objectKey);
      const prepared = await sharp(buffer)
        .rotate()
        .resize({
          width: OZON_IMAGE_MAX_WIDTH,
          height: OZON_IMAGE_MAX_HEIGHT,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({
          quality: OZON_IMAGE_QUALITY,
          mozjpeg: true,
          progressive: false,
        })
        .toBuffer();
      await uploadObject(ozonObjectKey, prepared, "image/jpeg");
    }
    return publicUrlForObjectKey(ozonObjectKey);
  } catch (error) {
    console.warn(
      { objectKey, error },
      "prepare ozon listing image failed, using original gallery url",
    );
    return fallbackUrl;
  }
}
__name(ensureOzonListingImageUrl, "ensureOzonListingImageUrl");
__name2(ensureOzonListingImageUrl, "ensureOzonListingImageUrl");
function ozonListingObjectKeyForOriginal(objectKey) {
  const normalized = objectKey.replace(/\\/g, "/").replace(/^\/+/, "");
  const withoutGalleryPrefix = normalized.replace(/^gallery\//, "");
  const withoutExtension = withoutGalleryPrefix.replace(/\.[^.]+$/, "");
  return `gallery-ozon-q50/${withoutExtension}.jpg`;
}
__name(ozonListingObjectKeyForOriginal, "ozonListingObjectKeyForOriginal");
__name2(ozonListingObjectKeyForOriginal, "ozonListingObjectKeyForOriginal");
function arraysEqual(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
__name(arraysEqual, "arraysEqual");
__name2(arraysEqual, "arraysEqual");
async function readListingBatch(userId, batchId, repairImages = false) {
  if (repairImages) {
    await repairListingBatchImageUrls(userId, batchId);
  }
  const result = await pool.query(
    `
    SELECT
      b.id,
      b.status,
      b.ratio_family AS "ratioFamily",
      b.product_image_rule_id AS "productImageRuleId",
      b.product_type AS "productType",
      b.aspect_ratio AS "aspectRatio",
      b.mockup_template_id AS "mockupTemplateId",
      b.mockup_template_name AS "mockupTemplateName",
      b.title_prompt_template_id AS "titlePromptTemplateId",
      b.title_prompt_template_name AS "titlePromptTemplateName",
      b.title_prompt AS "titlePrompt",
      b.created_at AS "createdAt",
      b.updated_at AS "updatedAt",
      COALESCE(a.image_sets, '[]'::json) AS "imageSets",
      COALESCE(s.shop_targets, '[]'::json) AS "shopTargets"
    FROM gallery_listing_batches b
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object(
        'externalShopId', lba.external_shop_id,
        'shopName', lba.shop_name,
        'productTemplateName', lba.product_template_name,
        'sourceAssetId', lba.source_asset_id,
        'sourceSku', lba.source_sku,
        'sourceUrl', ga.public_url,
        'sourceThumbUrl', ga.thumb_url,
        'imageAssetIds', lba.image_asset_ids,
        'imageUrls', lba.image_urls,
        'title', lba.title,
        'configSnapshot', lba.config_snapshot,
        'stageProgress', lba.stage_progress,
        'progress', lba.listing_progress,
        'stage', lba.listing_stage,
        'stageMessage', lba.listing_stage_message,
        'productId', lba.listing_product_id,
        'completedAt', lba.listing_completed_at
      ) ORDER BY lba.created_at ASC) AS image_sets
      FROM gallery_listing_batch_assets lba
      JOIN gallery_assets ga ON ga.id = lba.source_asset_id
      WHERE lba.batch_id = b.id
    ) a ON TRUE
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object(
        'externalShopId', lbs.external_shop_id,
        'shopName', lbs.shop_name,
        'productTemplateId', lbs.product_template_id,
        'productTemplateName', lbs.product_template_name,
        'status', lbs.status,
        'uploadedAt', lbs.uploaded_at,
        'error', lbs.error,
        'configSnapshot', lbs.config_snapshot
      ) ORDER BY lbs.created_at ASC) AS shop_targets
      FROM gallery_listing_batch_shops lbs
      WHERE lbs.batch_id = b.id
    ) s ON TRUE
    WHERE b.id = $1 AND b.user_id = $2
    LIMIT 1
    `,
    [batchId, userId],
  );
  if (!result.rowCount) {
    throw new AppError(
      404,
      "LISTING_BATCH_NOT_FOUND",
      "\u4E0A\u67B6\u6279\u6B21\u4E0D\u5B58\u5728",
    );
  }
  return result.rows[0];
}
__name(readListingBatch, "readListingBatch");
__name2(readListingBatch, "readListingBatch");
function normalizeListingConfigSnapshot(target, shop) {
  const snapshot = target.configSnapshot ?? {
    externalShopId: target.externalShopId,
    shopName: shop.name,
    productTemplateId: target.id || target.externalTemplateId || target.name,
    productTemplateName: target.name,
  };
  return {
    ...snapshot,
    externalShopId: target.externalShopId,
    shopName: snapshot.shopName || shop.name,
    localShopId: snapshot.localShopId || shop.externalShopId,
    productTemplateId:
      target.id ||
      target.externalTemplateId ||
      snapshot.productTemplateId ||
      target.name,
    productTemplateName: target.name || snapshot.productTemplateName,
    templateVideoLinks: snapshot.templateVideoLinks ?? [],
    uploadTemplateVideo: snapshot.uploadTemplateVideo ?? false,
    autoGenerateBarcode: snapshot.autoGenerateBarcode ?? false,
    autoUpdateStock: snapshot.autoUpdateStock ?? false,
    autoAddToAction: snapshot.autoAddToAction ?? false,
    autoStock: snapshot.autoStock ?? 50,
    autoActionStock: snapshot.autoActionStock ?? 50,
    postListingDelayMinutes: snapshot.postListingDelayMinutes ?? 0,
    actionDelayMinutes: snapshot.actionDelayMinutes ?? 0,
    actionRetryCount: snapshot.actionRetryCount ?? 72,
    actionRetryIntervalMinutes: snapshot.actionRetryIntervalMinutes ?? 10,
    dailyListingLimit: normalizeDailyListingLimit(snapshot.dailyListingLimit),
  };
}
__name(normalizeListingConfigSnapshot, "normalizeListingConfigSnapshot");
__name2(normalizeListingConfigSnapshot, "normalizeListingConfigSnapshot");
function initialListingStageProgress(title, imageCount) {
  return {
    mockup: {
      status: imageCount > 0 ? "done" : "queued",
      progress: imageCount > 0 ? 100 : 0,
      done: imageCount,
      total: imageCount,
    },
    title: {
      status: title?.trim() ? "done" : "queued",
      progress: title?.trim() ? 100 : 0,
    },
    listing: { status: "queued", progress: 0 },
  };
}
__name(initialListingStageProgress, "initialListingStageProgress");
__name2(initialListingStageProgress, "initialListingStageProgress");
async function upsertShopProductTemplate(client, userId, shopId, target) {
  if (target.id && isUuid(target.id)) {
    const existing = await client.query(
      `
      SELECT id
      FROM shop_product_templates
      WHERE id = $1 AND user_id = $2
      LIMIT 1
      `,
      [target.id, userId],
    );
    if (existing.rowCount) {
      return String(existing.rows[0].id);
    }
  }
  if (target.shared) {
    const result2 = await client.query(
      `
      INSERT INTO shop_product_templates (
        id,
        user_id,
        shop_id,
        name,
        external_template_id,
        category_label,
        payload
      )
      VALUES ($1, $2, NULL, $3, $4, $5, $6)
      ON CONFLICT (user_id, name) WHERE shop_id IS NULL
      DO UPDATE SET
        external_template_id = excluded.external_template_id,
        category_label = excluded.category_label,
        payload = excluded.payload,
        updated_at = now()
      RETURNING id
      `,
      [
        target.id && isUuid(target.id) ? target.id : newId(),
        userId,
        target.name,
        target.externalTemplateId || null,
        target.categoryLabel || null,
        target.payload === void 0 ? null : JSON.stringify(target.payload),
      ],
    );
    return String(result2.rows[0].id);
  }
  const result = await client.query(
    `
    INSERT INTO shop_product_templates (
      id,
      user_id,
      shop_id,
      name,
      external_template_id,
      category_label,
      payload
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (user_id, shop_id, name)
    DO UPDATE SET
      external_template_id = excluded.external_template_id,
      category_label = excluded.category_label,
      payload = excluded.payload,
      updated_at = now()
    RETURNING id
    `,
    [
      target.id && isUuid(target.id) ? target.id : newId(),
      userId,
      shopId,
      target.name,
      target.externalTemplateId || null,
      target.categoryLabel || null,
      target.payload === void 0 ? null : JSON.stringify(target.payload),
    ],
  );
  return String(result.rows[0].id);
}
__name(upsertShopProductTemplate, "upsertShopProductTemplate");
__name2(upsertShopProductTemplate, "upsertShopProductTemplate");
async function findUserShopByExternalId(userId, externalShopId) {
  const result = await pool.query(
    `
    SELECT id, external_shop_id, name
    FROM shops
    WHERE user_id = $1 AND external_shop_id = $2
    LIMIT 1
    `,
    [userId, externalShopId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError(
      404,
      "SHOP_NOT_SYNCED",
      "\u5E97\u94FA\u8FD8\u6CA1\u6709\u540C\u6B65\u5230\u4E91\u7AEF\uFF0C\u8BF7\u5148\u540C\u6B65\u5E97\u94FA",
    );
  }
  return {
    id: String(row.id),
    externalShopId: String(row.external_shop_id),
    name: String(row.name),
  };
}
__name(findUserShopByExternalId, "findUserShopByExternalId");
__name2(findUserShopByExternalId, "findUserShopByExternalId");
async function runWithTitleGenerationLimit(userId, task) {
  await acquireTitleGenerationSlot(userId);
  try {
    return await task();
  } finally {
    releaseTitleGenerationSlot(userId);
  }
}
__name(runWithTitleGenerationLimit, "runWithTitleGenerationLimit");
__name2(runWithTitleGenerationLimit, "runWithTitleGenerationLimit");
function acquireTitleGenerationSlot(userId) {
  if (tryAcquireTitleGenerationSlot(userId)) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let item;
    const timeout = setTimeout(() => {
      const index = titleGenerationQueue.indexOf(item);
      if (index >= 0) {
        titleGenerationQueue.splice(index, 1);
      }
      reject(
        new AppError(
          503,
          "TITLE_GENERATION_QUEUE_TIMEOUT",
          "\u6807\u9898\u751F\u6210\u6392\u961F\u8D85\u65F6\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
        ),
      );
    }, TITLE_GENERATION_QUEUE_TIMEOUT_MS);
    item = { userId, timeout, resolve, reject };
    titleGenerationQueue.push(item);
    drainTitleGenerationQueue();
  });
}
__name(acquireTitleGenerationSlot, "acquireTitleGenerationSlot");
__name2(acquireTitleGenerationSlot, "acquireTitleGenerationSlot");
function tryAcquireTitleGenerationSlot(userId) {
  if (!canAcquireTitleGenerationSlot(userId)) {
    return false;
  }
  activeTitleGenerationCount += 1;
  activeTitleGenerationByUser.set(
    userId,
    (activeTitleGenerationByUser.get(userId) ?? 0) + 1,
  );
  return true;
}
__name(tryAcquireTitleGenerationSlot, "tryAcquireTitleGenerationSlot");
__name2(tryAcquireTitleGenerationSlot, "tryAcquireTitleGenerationSlot");
function canAcquireTitleGenerationSlot(userId) {
  return (
    activeTitleGenerationCount < TITLE_GENERATION_GLOBAL_CONCURRENCY &&
    (activeTitleGenerationByUser.get(userId) ?? 0) <
      TITLE_GENERATION_USER_CONCURRENCY
  );
}
__name(canAcquireTitleGenerationSlot, "canAcquireTitleGenerationSlot");
__name2(canAcquireTitleGenerationSlot, "canAcquireTitleGenerationSlot");
function releaseTitleGenerationSlot(userId) {
  activeTitleGenerationCount = Math.max(0, activeTitleGenerationCount - 1);
  const userActiveCount = Math.max(
    0,
    (activeTitleGenerationByUser.get(userId) ?? 0) - 1,
  );
  if (userActiveCount === 0) {
    activeTitleGenerationByUser.delete(userId);
  } else {
    activeTitleGenerationByUser.set(userId, userActiveCount);
  }
  drainTitleGenerationQueue();
}
__name(releaseTitleGenerationSlot, "releaseTitleGenerationSlot");
__name2(releaseTitleGenerationSlot, "releaseTitleGenerationSlot");
function drainTitleGenerationQueue() {
  while (titleGenerationQueue.length > 0) {
    const index = titleGenerationQueue.findIndex((item2) =>
      canAcquireTitleGenerationSlot(item2.userId),
    );
    if (index < 0) {
      return;
    }
    const [item] = titleGenerationQueue.splice(index, 1);
    clearTimeout(item.timeout);
    tryAcquireTitleGenerationSlot(item.userId);
    item.resolve();
  }
}
__name(drainTitleGenerationQueue, "drainTitleGenerationQueue");
__name2(drainTitleGenerationQueue, "drainTitleGenerationQueue");
function fillTitlePrompt(prompt, input) {
  return prompt
    .replaceAll("{sku}", input.sku)
    .replaceAll("{source_url}", input.sourceUrl)
    .replaceAll("{image_url}", input.imageUrl);
}
__name(fillTitlePrompt, "fillTitlePrompt");
__name2(fillTitlePrompt, "fillTitlePrompt");
async function generateTitleFromImage(prompt, candidateImageUrls) {
  const settings = await readAiSettings();
  if (!settings.textApiKey.trim() && !isLocalProvider(settings.textProvider)) {
    throw new AppError(
      400,
      "AI_KEY_MISSING",
      "\u6587\u6848 AI Key \u672A\u914D\u7F6E\uFF0C\u8BF7\u5148\u5728\u7BA1\u7406\u7AEF\u8BBE\u7F6E",
    );
  }
  const imageUrls = [
    ...new Set(candidateImageUrls.map((url) => url.trim()).filter(Boolean)),
  ];
  if (imageUrls.length === 0) {
    throw new AppError(
      400,
      "TITLE_IMAGE_NOT_FOUND",
      "\u6807\u9898\u53C2\u8003\u56FE\u5730\u5740\u4E3A\u7A7A\uFF0C\u8BF7\u91CD\u65B0\u751F\u6210\u5957\u56FE\u540E\u518D\u8BD5",
    );
  }
  const upstreamUrl = joinUrl(settings.textBaseUrl, "chat/completions");
  let firstError = null;
  let lastError = null;
  for (const imageUrl of imageUrls) {
    try {
      return await requestGeneratedTitle(
        settings,
        upstreamUrl,
        prompt,
        imageUrl,
      );
    } catch (error) {
      const appError = normalizeAppError(
        error,
        "\u6807\u9898\u751F\u6210\u5931\u8D25",
      );
      firstError ??= appError;
      lastError = appError;
      if (!shouldRetryTitleWithInlineImage(appError)) {
        throw appError;
      }
    }
    try {
      const inlineImageUrl = await downloadTitleImageAsDataUrl(imageUrl);
      return await requestGeneratedTitle(
        settings,
        upstreamUrl,
        prompt,
        inlineImageUrl,
      );
    } catch (error) {
      lastError = normalizeAppError(
        error,
        "\u6807\u9898\u751F\u6210\u5931\u8D25",
      );
      if (!shouldTryNextTitleImage(lastError)) {
        throw buildTitleFallbackError(lastError, firstError);
      }
    }
  }
  throw buildTitleFallbackError(lastError, firstError);
}
__name(generateTitleFromImage, "generateTitleFromImage");
__name2(generateTitleFromImage, "generateTitleFromImage");
async function requestGeneratedTitle(settings, upstreamUrl, prompt, imageUrl) {
  const payload = {
    model: settings.textModel,
    messages: [
      {
        role: "system",
        content:
          "\u4F60\u662F Ozon \u7535\u5546\u5546\u54C1\u6807\u9898\u52A9\u624B\u3002\u53EA\u8F93\u51FA JSON\uFF0C\u4E0D\u8981\u8F93\u51FA JSON \u4EE5\u5916\u7684\u5185\u5BB9\u3002",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `${prompt}

\u8BF7\u6839\u636E\u968F\u9644\u5546\u54C1\u56FE\u7247\u8FD4\u56DE JSON\uFF1A{"title":""}\u3002title \u5FC5\u987B\u9002\u5408\u76F4\u63A5\u4F5C\u4E3A Ozon \u5546\u54C1\u6807\u9898\u4F7F\u7528\u3002`,
          },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
    temperature: 0.4,
  };
  const response = await fetchAiUpstream(
    upstreamUrl,
    {
      method: "POST",
      headers: {
        ...(settings.textApiKey.trim()
          ? { Authorization: `Bearer ${settings.textApiKey.trim()}` }
          : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
    { label: "\u6587\u6848", timeoutMs: TITLE_GENERATION_UPSTREAM_TIMEOUT_MS },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new AppError(
      response.status,
      "AI_TITLE_FAILED",
      `\u6807\u9898\u751F\u6210\u5931\u8D25\uFF1A${text.slice(0, 500)}`,
    );
  }
  let content = "";
  try {
    const data = JSON.parse(text);
    const choices = data.choices;
    const first = Array.isArray(choices) ? choices[0] : void 0;
    const message = first?.message;
    content = typeof message?.content === "string" ? message.content : "";
  } catch {
    content = text;
  }
  const title = parseGeneratedTitle(content);
  if (!title) {
    throw new AppError(
      502,
      "AI_TITLE_EMPTY",
      "\u6807\u9898\u751F\u6210\u7ED3\u679C\u4E3A\u7A7A\uFF0C\u8BF7\u8C03\u6574\u63D0\u793A\u8BCD\u540E\u91CD\u8BD5",
    );
  }
  return title;
}
__name(requestGeneratedTitle, "requestGeneratedTitle");
__name2(requestGeneratedTitle, "requestGeneratedTitle");
async function downloadTitleImageAsDataUrl(imageUrl) {
  const response = await fetchWithTimeout(
    imageUrl,
    TITLE_IMAGE_DOWNLOAD_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new AppError(
      response.status,
      "TITLE_IMAGE_DOWNLOAD_FAILED",
      `\u6807\u9898\u53C2\u8003\u56FE\u4E0B\u8F7D\u5931\u8D25\uFF1AHTTP ${response.status}`,
    );
  }
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("image/")) {
    throw new AppError(
      502,
      "TITLE_IMAGE_INVALID_TYPE",
      "\u6807\u9898\u53C2\u8003\u56FE\u4E0D\u662F\u6709\u6548\u56FE\u7247\uFF0C\u8BF7\u91CD\u65B0\u751F\u6210\u5957\u56FE\u540E\u518D\u8BD5",
    );
  }
  const contentLength = Number(response.headers.get("content-length") || "0");
  if (contentLength > TITLE_IMAGE_MAX_DOWNLOAD_BYTES) {
    throw new AppError(
      413,
      "TITLE_IMAGE_TOO_LARGE",
      "\u6807\u9898\u53C2\u8003\u56FE\u8FC7\u5927\uFF0C\u8BF7\u91CD\u65B0\u751F\u6210\u8F83\u5C0F\u7684\u5957\u56FE\u540E\u518D\u8BD5",
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > TITLE_IMAGE_MAX_DOWNLOAD_BYTES) {
    throw new AppError(
      413,
      "TITLE_IMAGE_TOO_LARGE",
      "\u6807\u9898\u53C2\u8003\u56FE\u8FC7\u5927\uFF0C\u8BF7\u91CD\u65B0\u751F\u6210\u8F83\u5C0F\u7684\u5957\u56FE\u540E\u518D\u8BD5",
    );
  }
  const inlineBuffer = await sharp(buffer)
    .resize({
      width: TITLE_IMAGE_INLINE_MAX_WIDTH,
      height: TITLE_IMAGE_INLINE_MAX_HEIGHT,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  return `data:image/jpeg;base64,${inlineBuffer.toString("base64")}`;
}
__name(downloadTitleImageAsDataUrl, "downloadTitleImageAsDataUrl");
__name2(downloadTitleImageAsDataUrl, "downloadTitleImageAsDataUrl");
async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (error) {
    throw new AppError(
      504,
      "TITLE_IMAGE_DOWNLOAD_TIMEOUT",
      `\u6807\u9898\u53C2\u8003\u56FE\u4E0B\u8F7D\u8D85\u65F6\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\uFF1A${readUrlHost(url)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}
__name(fetchWithTimeout, "fetchWithTimeout");
__name2(fetchWithTimeout, "fetchWithTimeout");
function shouldRetryTitleWithInlineImage(error) {
  const text = `${error.code} ${error.message}`.toLowerCase();
  return (
    error.statusCode === 504 ||
    text.includes("download") ||
    text.includes("timeout") ||
    text.includes("provided url") ||
    text.includes("publicly accessible") ||
    text.includes("invalid_request_error")
  );
}
__name(shouldRetryTitleWithInlineImage, "shouldRetryTitleWithInlineImage");
__name2(shouldRetryTitleWithInlineImage, "shouldRetryTitleWithInlineImage");
function shouldTryNextTitleImage(error) {
  return (
    error.statusCode >= 500 ||
    error.code === "TITLE_IMAGE_DOWNLOAD_TIMEOUT" ||
    error.code === "TITLE_IMAGE_DOWNLOAD_FAILED" ||
    shouldRetryTitleWithInlineImage(error)
  );
}
__name(shouldTryNextTitleImage, "shouldTryNextTitleImage");
__name2(shouldTryNextTitleImage, "shouldTryNextTitleImage");
function buildTitleFallbackError(lastError, firstError) {
  const error = lastError ?? firstError;
  if (!error) {
    return new AppError(
      502,
      "AI_TITLE_FAILED",
      "\u6807\u9898\u751F\u6210\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
    );
  }
  if (
    shouldRetryTitleWithInlineImage(error) ||
    shouldTryNextTitleImage(error)
  ) {
    return new AppError(
      504,
      "AI_TITLE_IMAGE_TIMEOUT",
      "\u6807\u9898\u751F\u6210\u8D85\u65F6\uFF1AAI \u670D\u52A1\u65E0\u6CD5\u53CA\u65F6\u8BFB\u53D6\u56FE\u7247\uFF0C\u7CFB\u7EDF\u5DF2\u5C1D\u8BD5\u4F7F\u7528\u538B\u7F29\u56FE\u7247\u515C\u5E95\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u8BE5\u5546\u54C1",
    );
  }
  return error;
}
__name(buildTitleFallbackError, "buildTitleFallbackError");
__name2(buildTitleFallbackError, "buildTitleFallbackError");
function normalizeAppError(error, fallbackMessage) {
  if (error instanceof AppError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new AppError(
    500,
    "AI_TITLE_FAILED",
    `${fallbackMessage}\uFF1A${message}`,
  );
}
__name(normalizeAppError, "normalizeAppError");
__name2(normalizeAppError, "normalizeAppError");
function readUrlHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
__name(readUrlHost, "readUrlHost");
__name2(readUrlHost, "readUrlHost");
function parseGeneratedTitle(text) {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    const data = JSON.parse(cleaned);
    if (typeof data.title === "string") {
      return normalizeTitle(data.title);
    }
  } catch {}
  return normalizeTitle(cleaned);
}
__name(parseGeneratedTitle, "parseGeneratedTitle");
__name2(parseGeneratedTitle, "parseGeneratedTitle");
function normalizeTitle(value) {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .slice(0, 300);
}
__name(normalizeTitle, "normalizeTitle");
__name2(normalizeTitle, "normalizeTitle");
function isLocalProvider(provider) {
  return provider.trim().toLowerCase() === "ollama";
}
__name(isLocalProvider, "isLocalProvider");
__name2(isLocalProvider, "isLocalProvider");
function joinUrl(baseUrl, path2) {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const cleanPath = path2.trim().replace(/^\/+/, "");
  if (!base || cleanPath.includes("..")) {
    throw new AppError(
      400,
      "AI_PATH_INVALID",
      "AI \u63A5\u53E3\u5730\u5740\u4E0D\u6B63\u786E",
    );
  }
  return `${base}/${cleanPath}`;
}
__name(joinUrl, "joinUrl");
__name2(joinUrl, "joinUrl");
function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}
__name(isUuid, "isUuid");
__name2(isUuid, "isUuid");
function readMultipartTextField(fields, name) {
  const field = fields[name];
  return typeof field?.value === "string" ? field.value : void 0;
}
__name(readMultipartTextField, "readMultipartTextField");
__name2(readMultipartTextField, "readMultipartTextField");
function multipartFieldValue(field) {
  if (!field || Array.isArray(field) || typeof field !== "object") {
    return void 0;
  }
  const value = field.value;
  return typeof value === "string" ? value : void 0;
}
__name(multipartFieldValue, "multipartFieldValue");
__name2(multipartFieldValue, "multipartFieldValue");
export {
  buildLegacyListingUploadObjectKey,
  galleryRoutes,
  insertGalleryAsset,
  legacyListingStorageUsageTotals,
  legacyListingUploadCompleteRecord,
  parseLegacyListingCompleteBody,
  validateLegacyListingUploadGrant,
  validateLegacyListingUploadObjectMetadata,
  validateLegacyListingUploadQuota,
};
