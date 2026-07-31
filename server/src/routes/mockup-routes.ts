// @ts-nocheck
import { z } from "zod";
import { requireAuth, requireMembership } from "../auth.js";
import { config } from "../config.js";
import { pool } from "../db.js";
import { AppError } from "../errors.js";
import {
  findPublishedMockupTemplate,
  getPublishedMockupTemplatePackage,
  listPublishedMockupTemplates,
} from "../mockup-template-service.js";
import {
  renderFangjinMockups,
  renderMockupsWithTemplate,
} from "../mockup-renderer.js";
import {
  imageMatchesAspectRatio,
  parseAspectRatio,
} from "../product-image-rules.js";
import { assertRateLimit } from "../rate-limit.js";
import { newId } from "../security.js";
import {
  compressedMockupContentType,
  createCompressedMockupBuffer,
  prepareImage,
  readObjectBuffer,
  uploadPreparedImage,
} from "../storage.js";
import { insertGalleryAsset } from "./gallery-routes.js";
const renderMockupSchema = z.object({
  assetId: z.string().uuid(),
});
const renderMockupParamsSchema = z.object({
  templateId: z.string().trim().min(1).max(80),
});
const uploadLocalMockupParamsSchema = z.object({
  templateId: z.string().trim().min(1).max(80),
  assetId: z.string().uuid(),
});
const uploadLocalMockupMetaSchema = z.object({
  sceneIndex: z.coerce.number().int().min(1).max(200),
  filename: z.string().trim().min(1).max(240).optional(),
  clientRenderer: z.string().trim().max(80).optional(),
});
const mockupRequestConcurrency = config.CLOUD_MOCKUP_REQUEST_CONCURRENCY;
let activeMockupRequests = 0;
const mockupRequestQueue = [];
export async function mockupRoutes(app) {
  app.get(
    "/mockups/templates",
    { preHandler: [requireAuth, requireMembership] },
    async () => {
      const templates = await listPublishedMockupTemplates();
      return {
        ok: true,
        templates: templates.map((template) => ({
          ...template,
          previewUrl: resolvePublicUrl(template.previewUrl),
        })),
      };
    },
  );
  app.get(
    "/mockups/:templateId/package",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      const params = renderMockupParamsSchema.parse(request.params);
      const templatePackage = await getPublishedMockupTemplatePackage(
        params.templateId,
      );
      return {
        ok: true,
        template: {
          ...templatePackage,
          previewUrl: resolvePublicUrl(templatePackage.previewUrl),
          assetUrls: Object.fromEntries(
            Object.entries(templatePackage.assetUrls).map(([key, value]) => [
              key,
              resolvePublicUrl(value),
            ]),
          ),
        },
      };
    },
  );
  app.post(
    "/mockups/:templateId/render",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      assertCloudMockupRenderEnabled(request.currentUser.id);
      const params = renderMockupParamsSchema.parse(request.params);
      const body = renderMockupSchema.parse(request.body);
      const template = await findPublishedMockupTemplate(params.templateId);
      if (!template) {
        throw new AppError(
          404,
          "MOCKUP_TEMPLATE_NOT_FOUND",
          "样机不存在或暂未启用",
        );
      }
      const templatePackage = await getPublishedMockupTemplatePackage(
        params.templateId,
      );
      return renderMockupForAsset(
        request.currentUser.id,
        body.assetId,
        templatePackage.sourceAspectRatio,
        ({ sourceBuffer, sku }) =>
          renderMockupsWithTemplate({
            templateDir: template.templateDir,
            sourceBuffer,
            sku,
          }),
      );
    },
  );
  app.post(
    "/mockups/fangjin/render",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      assertCloudMockupRenderEnabled(request.currentUser.id);
      const body = renderMockupSchema.parse(request.body);
      const template = await findPublishedMockupTemplate("fangjin");
      if (!template) {
        throw new AppError(
          404,
          "MOCKUP_TEMPLATE_NOT_FOUND",
          "样机不存在或暂未启用",
        );
      }
      const templatePackage =
        await getPublishedMockupTemplatePackage("fangjin");
      return renderMockupForAsset(
        request.currentUser.id,
        body.assetId,
        templatePackage.sourceAspectRatio,
        renderFangjinMockups,
      );
    },
  );
  app.post(
    "/mockups/:templateId/assets/:assetId/local-result",
    { preHandler: [requireAuth, requireMembership] },
    async (request) => {
      const params = uploadLocalMockupParamsSchema.parse(request.params);
      const templatePackage = await getPublishedMockupTemplatePackage(
        params.templateId,
      );
      const file = await request.file();
      if (!file) {
        throw new AppError(
          400,
          "MOCKUP_RESULT_FILE_REQUIRED",
          "请上传客户端生成的套图",
        );
      }
      const sceneIndexes = new Set(
        (templatePackage.templateJson.scenes ?? [])
          .map((scene) => Number(scene.index))
          .filter((value) => Number.isInteger(value)),
      );
      const meta = uploadLocalMockupMetaSchema.parse({
        sceneIndex: readMultipartTextField(file.fields, "sceneIndex"),
        filename: readMultipartTextField(file.fields, "filename"),
        clientRenderer: readMultipartTextField(file.fields, "clientRenderer"),
      });
      if (!sceneIndexes.has(meta.sceneIndex)) {
        throw new AppError(
          400,
          "MOCKUP_SCENE_INVALID",
          "套图场景编号不属于当前样机",
        );
      }
      const sourceAsset = await findSourceAsset(
        request.currentUser.id,
        params.assetId,
      );
      assertSourceAssetMatchesTemplate(
        sourceAsset,
        templatePackage.sourceAspectRatio,
      );
      const buffer = await createCompressedMockupBuffer(await file.toBuffer());
      const filename =
        meta.filename ||
        `${sourceAsset.sku}-${templatePackage.id}-${String(meta.sceneIndex).padStart(2, "0")}.${extensionFromMime(file.mimetype)}`;
      const compressedFilename = replaceImageExtension(filename, "jpg");
      const image = await prepareImage({
        buffer,
        filename: compressedFilename,
        mimetype: compressedMockupContentType,
        sku: compressedFilename.replace(/\.[^.]+$/, ""),
      });
      await uploadPreparedImage(image);
      const asset = await insertGalleryAsset(request.currentUser.id, image, {
        productImageRuleId: sourceAsset.product_image_rule_id,
        productType: sourceAsset.product_type,
        aspectRatio: sourceAsset.aspect_ratio,
      });
      await upsertMockupResult({
        userId: request.currentUser.id,
        sourceAssetId: sourceAsset.id,
        resultAssetId: asset.id,
        templateId: templatePackage.id,
        templateName: templatePackage.name,
        sceneIndex: meta.sceneIndex,
      });
      return {
        ok: true,
        sourceAsset: {
          id: sourceAsset.id,
          sku: sourceAsset.sku,
          sourceFilename: sourceAsset.source_filename,
        },
        template: {
          id: templatePackage.id,
          name: templatePackage.name,
          description: templatePackage.description,
          productType: templatePackage.productType,
          sourceAspectRatio: templatePackage.sourceAspectRatio,
          status: templatePackage.status,
          previewUrl: resolvePublicUrl(templatePackage.previewUrl),
          sceneCount: templatePackage.sceneCount,
          outputWidth: templatePackage.outputWidth,
          outputHeight: templatePackage.outputHeight,
        },
        generated: 1,
        asset: {
          ...asset,
          templateId: templatePackage.id,
          templateName: templatePackage.name,
          sceneIndex: meta.sceneIndex,
        },
        renderer: meta.clientRenderer || "client",
      };
    },
  );
}
function resolvePublicUrl(value) {
  if (!value) {
    return undefined;
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  const normalizedPath = value.startsWith("/") ? value : `/${value}`;
  return `${config.PUBLIC_API_BASE_URL.replace(/\/+$/, "")}${normalizedPath}`;
}
async function renderMockupForAsset(
  userId,
  assetId,
  templateAspectRatio,
  render,
) {
  return runQueuedMockupRender(async () =>
    renderMockupForAssetInner(userId, assetId, templateAspectRatio, render),
  );
}
async function renderMockupForAssetInner(
  userId,
  assetId,
  templateAspectRatio,
  render,
) {
  const sourceAsset = await findSourceAsset(userId, assetId);
  assertSourceAssetMatchesTemplate(sourceAsset, templateAspectRatio);
  const sourceBuffer = await readObjectBuffer(sourceAsset.object_key);
  const rendered = await render({
    sourceBuffer,
    sku: sourceAsset.sku,
  });
  const assets = [];
  for (const scene of rendered.scenes) {
    const buffer = await createCompressedMockupBuffer(scene.buffer);
    const filename = replaceImageExtension(scene.filename, "jpg");
    const image = await prepareImage({
      buffer,
      filename,
      mimetype: compressedMockupContentType,
      sku: filename.replace(/\.[^.]+$/, ""),
    });
    await uploadPreparedImage(image);
    const asset = await insertGalleryAsset(userId, image, {
      productImageRuleId: sourceAsset.product_image_rule_id,
      productType: sourceAsset.product_type,
      aspectRatio: sourceAsset.aspect_ratio,
    });
    await upsertMockupResult({
      userId,
      sourceAssetId: sourceAsset.id,
      resultAssetId: asset.id,
      templateId: rendered.template.id,
      templateName: rendered.template.name,
      sceneIndex: scene.index,
    });
    assets.push({
      ...asset,
      templateId: rendered.template.id,
      templateName: rendered.template.name,
      sceneIndex: scene.index,
    });
  }
  return {
    ok: true,
    sourceAsset: {
      id: sourceAsset.id,
      sku: sourceAsset.sku,
      sourceFilename: sourceAsset.source_filename,
    },
    template: rendered.template,
    generated: assets.length,
    assets,
  };
}
async function findSourceAsset(userId, assetId) {
  const result = await pool.query(
    `
    SELECT id, sku, object_key, source_filename, aspect_ratio, product_image_rule_id, product_type, width, height
    FROM gallery_assets
    WHERE id = $1 AND uploaded_by_user_id = $2
      AND deleted_at IS NULL
    LIMIT 1
    `,
    [assetId, userId],
  );
  const sourceAsset = result.rows[0];
  if (!sourceAsset) {
    throw new AppError(404, "ASSET_NOT_FOUND", "图片不存在或不属于当前账号");
  }
  return sourceAsset;
}
function assertSourceAssetMatchesTemplate(sourceAsset, templateAspectRatio) {
  const required = parseAspectRatio(templateAspectRatio);
  if (!required) {
    return;
  }
  const assetRatio = parseAspectRatio(sourceAsset.aspect_ratio);
  const matchesStoredRatio = assetRatio?.aspectRatio === required.aspectRatio;
  const matchesDimensions = imageMatchesAspectRatio(
    sourceAsset.width,
    sourceAsset.height,
    required.ratioWidth,
    required.ratioHeight,
  );
  if (!matchesStoredRatio && !matchesDimensions) {
    throw new AppError(
      400,
      "MOCKUP_ASPECT_RATIO_MISMATCH",
      `${sourceAsset.sku} 的图片比例为 ${sourceAsset.aspect_ratio || `${sourceAsset.width}x${sourceAsset.height}`}，当前样机要求 ${required.aspectRatio}，请重新选择匹配比例的图片`,
    );
  }
}
async function upsertMockupResult(input) {
  await pool.query(
    `
    INSERT INTO gallery_mockup_results (
      id,
      user_id,
      source_asset_id,
      result_asset_id,
      template_id,
      template_name,
      scene_index,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, now())
    ON CONFLICT (user_id, source_asset_id, template_id, scene_index)
    DO UPDATE SET
      result_asset_id = excluded.result_asset_id,
      template_name = excluded.template_name,
      updated_at = now()
    `,
    [
      newId(),
      input.userId,
      input.sourceAssetId,
      input.resultAssetId,
      input.templateId,
      input.templateName,
      input.sceneIndex,
    ],
  );
}
async function runQueuedMockupRender(fn) {
  await acquireMockupSlot();
  try {
    return await fn();
  } finally {
    releaseMockupSlot();
  }
}
async function acquireMockupSlot() {
  if (activeMockupRequests < mockupRequestConcurrency) {
    activeMockupRequests += 1;
    return;
  }
  await new Promise((resolve) => {
    mockupRequestQueue.push(resolve);
  });
  activeMockupRequests += 1;
}
function releaseMockupSlot() {
  activeMockupRequests = Math.max(0, activeMockupRequests - 1);
  const next = mockupRequestQueue.shift();
  if (next) {
    next();
  }
}
function readMultipartTextField(fields, name) {
  const field = fields[name];
  return typeof field?.value === "string" ? field.value : undefined;
}
function extensionFromMime(mime) {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg";
}
function replaceImageExtension(filename, extension) {
  return `${filename.replace(/\.[^.]+$/, "")}.${extension}`;
}
function assertCloudMockupRenderEnabled(userId) {
  if (!config.CLOUD_MOCKUP_RENDER_ENABLED) {
    throw new AppError(
      503,
      "CLOUD_MOCKUP_RENDER_DISABLED",
      "云端样机渲染已关闭，请使用本地助手或浏览器本地生成",
    );
  }
  await assertRateLimit({
    key: `cloud-mockup:${userId}`,
    limit: 10,
    windowMs: 60_000,
    code: "CLOUD_MOCKUP_RATE_LIMITED",
    message: "云端样机渲染请求过于频繁，请稍后重试",
  });
}
