import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { config } from "./config.js";
import { pool } from "./db.js";
import { AppError } from "./errors.js";
import { getMockupTemplateInfo, invalidateMockupTemplateCache, renderMockupsWithTemplate } from "./mockup-renderer.js";
import { newId, sha256Hex } from "./security.js";
import { publicUrlForObjectKey, uploadObject } from "./storage.js";

export type MockupTemplateStatus = "draft" | "published" | "disabled";

type MockupTemplateRow = {
  id: string;
  name: string;
  description: string;
  product_type: string;
  source_aspect_ratio: string;
  status: MockupTemplateStatus;
  source_type: "system" | "custom";
  template_dir: string;
  source_psd_filename: string | null;
  source_psd_path: string | null;
  source_psd_size_bytes: string | number | null;
  preview_url: string | null;
  test_preview_url: string | null;
  last_test_status: "pending" | "succeeded" | "failed";
  last_test_message: string;
  last_test_at: string | null;
  scene_count: number;
  output_width: number;
  output_height: number;
  created_at: string;
  updated_at: string;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bundledTemplateRoot = path.join(__dirname, "mockup-templates");
const writableTemplateRoot = config.MOCKUP_TEMPLATE_ROOT
  ? path.resolve(config.MOCKUP_TEMPLATE_ROOT)
  : bundledTemplateRoot;

export function getMockupTemplateRoot() {
  return writableTemplateRoot;
}

export async function ensureSystemMockupTemplates() {
  await fs.mkdir(writableTemplateRoot, { recursive: true });
  await syncTemplateFromDisk("fangjin", {
    status: "published",
    sourceType: "system",
    fallbackName: "方巾样机",
    fallbackDescription: "适合 1:1 方形平面图，生成头巾、方巾、丝巾类商品效果图。",
  });
  await syncTemplateFromDisk("ganfamao", {
    status: "published",
    sourceType: "system",
    fallbackName: "干发帽样机",
    fallbackDescription: "适合 1:1 方形平面图，生成干发帽、浴帽类商品效果图。",
  });
  await syncTemplateFromDisk("zhuobu", {
    status: "published",
    sourceType: "system",
    fallbackName: "桌布样机",
    fallbackDescription: "适合 3:2 平面图，生成桌布室内、户外、尺寸和细节场景效果图。",
  });
  await syncTemplateFromDisk("huazhuangbao", {
    status: "published",
    sourceType: "system",
    fallbackName: "化妆包样机",
    fallbackDescription: "适合 1:1 方形平面图，生成化妆包多角度套图效果图。",
  });
  await syncTemplateFromDisk("shukoudai", {
    status: "published",
    sourceType: "system",
    fallbackName: "\u675f\u53e3\u888b\u6837\u673a",
    fallbackDescription: "\u9002\u5408 3:4 \u7ad6\u56fe\u5e73\u9762\u56fe\uff0c\u751f\u6210\u675f\u53e3\u888b\u591a\u573a\u666f\u5546\u54c1\u6548\u679c\u56fe\u3002",
  });
}

export async function listAdminMockupTemplates() {
  await ensureSystemMockupTemplates();
  const result = await pool.query(`
    SELECT *
    FROM mockup_templates
    WHERE deleted_at IS NULL
    ORDER BY
      CASE status WHEN 'published' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
      updated_at DESC
  `);
  return result.rows.map(toAdminTemplate);
}

export async function listPublishedMockupTemplates() {
  await ensureSystemMockupTemplates();
  const result = await pool.query(`
    SELECT *
    FROM mockup_templates
    WHERE status = 'published' AND deleted_at IS NULL
    ORDER BY source_type DESC, updated_at DESC
  `);
  return result.rows.map(toPublicTemplate);
}

export async function findPublishedMockupTemplate(templateId: string) {
  await ensureSystemMockupTemplates();
  const result = await pool.query(
    `
    SELECT *
    FROM mockup_templates
    WHERE id = $1 AND status = 'published' AND deleted_at IS NULL
    LIMIT 1
    `,
    [templateId],
  );
  const row = result.rows[0] as MockupTemplateRow | undefined;
  return row ? toRenderableTemplate(row) : null;
}

export async function getPublishedMockupTemplatePackage(templateId: string) {
  await ensureSystemMockupTemplates();
  const result = await pool.query(
    `
    SELECT *
    FROM mockup_templates
    WHERE id = $1 AND status = 'published' AND deleted_at IS NULL
    LIMIT 1
    `,
    [normalizeTemplateId(templateId)],
  );
  const row = result.rows[0] as MockupTemplateRow | undefined;
  if (!row) {
    throw new AppError(404, "MOCKUP_TEMPLATE_NOT_FOUND", "样机不存在或暂未启用");
  }

  const templateDir = normalizeTemplateDir(row.template_dir);
  const templateRoot = path.join(writableTemplateRoot, templateDir);
  const raw = await fs.readFile(path.join(templateRoot, "template.json"), "utf8");
  const templateJson = JSON.parse(raw) as {
    previewPath?: string;
    scenes?: Array<{
      index?: number;
      layers?: Array<{
        file?: string;
        mask?: string;
        clipMask?: string;
        uvMapX?: string;
        uvMapY?: string;
      }>;
    }>;
  };
  const assetPaths = new Set<string>();
  if (templateJson.previewPath && !/^https?:\/\//i.test(templateJson.previewPath)) {
    assetPaths.add(normalizeTemplateUploadPath(templateJson.previewPath.replace(/^\/?mockup-template-assets\/[^/]+\//, "")));
  }
  for (const scene of templateJson.scenes ?? []) {
    for (const layer of scene.layers ?? []) {
      for (const file of [layer.file, layer.mask, layer.clipMask, layer.uvMapX, layer.uvMapY]) {
        if (!file) continue;
        const normalized = normalizeTemplateUploadPath(file);
        const fullPath = path.join(templateRoot, normalized);
        if (!fullPath.startsWith(templateRoot) || !await pathExists(fullPath)) {
          throw new AppError(500, "MOCKUP_TEMPLATE_ASSET_MISSING", `样机模板资源不存在：${file}`);
        }
        assetPaths.add(normalized);
      }
    }
  }

  const assetUrls: Record<string, string> = {};
  for (const assetPath of assetPaths) {
    assetUrls[assetPath] = `/mockup-template-assets/${encodeURIComponent(templateDir)}/${assetPath.split("/").map(encodeURIComponent).join("/")}`;
  }

  return {
    ...toPublicTemplate(row),
    templateDir,
    templateJson,
    assetUrls,
    version: sha256Hex(JSON.stringify(templateJson)),
  };
}

export async function upsertAdminMockupTemplate(input: {
  id: string;
  name: string;
  description: string;
  productType: string;
  sourceAspectRatio: string;
}) {
  const id = normalizeTemplateId(input.id);
  const templateDir = id;
  await fs.mkdir(path.join(writableTemplateRoot, templateDir), { recursive: true });
  const result = await pool.query(
    `
    INSERT INTO mockup_templates (
      id,
      name,
      description,
      product_type,
      source_aspect_ratio,
      status,
      source_type,
      template_dir,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, 'draft', 'custom', $6, now())
    ON CONFLICT (id) DO UPDATE
    SET name = EXCLUDED.name,
        description = EXCLUDED.description,
        product_type = EXCLUDED.product_type,
        source_aspect_ratio = EXCLUDED.source_aspect_ratio,
        updated_at = now()
    RETURNING *
    `,
    [
      id,
      input.name.trim(),
      input.description.trim(),
      input.productType.trim(),
      input.sourceAspectRatio.trim(),
      templateDir,
    ],
  );
  return toAdminTemplate(result.rows[0]);
}

export async function saveMockupTemplatePsd(input: {
  templateId: string;
  filename: string;
  buffer: Buffer;
}) {
  if (!/\.psd$/i.test(input.filename)) {
    throw new AppError(400, "MOCKUP_PSD_REQUIRED", "请上传 PSD 样机文件");
  }
  const row = await getAdminTemplateRow(input.templateId);
  const maxBytes = config.MAX_PSD_UPLOAD_MB * 1024 * 1024;
  if (input.buffer.length > maxBytes) {
    throw new AppError(413, "PSD_UPLOAD_TOO_LARGE", `PSD 文件过大，请上传不超过 ${config.MAX_PSD_UPLOAD_MB} MB 的文件`);
  }

  const templateDir = normalizeTemplateDir(row.template_dir);
  const sourceDir = path.join(writableTemplateRoot, templateDir, "source");
  await fs.mkdir(sourceDir, { recursive: true });
  const sourceFilename = sanitizeFilename(input.filename);
  const sourcePath = path.join(sourceDir, sourceFilename);
  await fs.writeFile(sourcePath, input.buffer);

  const result = await pool.query(
    `
    UPDATE mockup_templates
    SET source_psd_filename = $2,
        source_psd_path = $3,
        source_psd_size_bytes = $4,
        last_test_status = 'pending',
        last_test_message = 'PSD 已上传，等待生成测试预览。',
        last_test_at = NULL,
        updated_at = now()
    WHERE id = $1
    RETURNING *
    `,
    [row.id, sourceFilename, sourcePath, input.buffer.length],
  );
  return toAdminTemplate(result.rows[0]);
}

export async function saveConvertedMockupTemplateFiles(input: {
  templateId: string;
  files: Array<{
    relativePath: string;
    buffer: Buffer;
  }>;
}) {
  const row = await getAdminTemplateRow(input.templateId);
  const templateDir = normalizeTemplateDir(row.template_dir);
  const targetDir = path.join(writableTemplateRoot, templateDir);
  const backupDir = `${targetDir}.__backup_${Date.now()}`;

  if (!input.files.length) {
    throw new AppError(400, "MOCKUP_TEMPLATE_FILES_REQUIRED", "请上传转换后的样机模板文件夹");
  }

  const normalizedFiles = input.files.map((file) => ({
    relativePath: normalizeTemplateUploadPath(file.relativePath),
    buffer: file.buffer,
  }));
  if (!normalizedFiles.some((file) => file.relativePath === "template.json")) {
    throw new AppError(400, "MOCKUP_TEMPLATE_JSON_REQUIRED", "模板文件夹必须包含 template.json");
  }

  const hadExistingTemplateDir = await pathExists(targetDir);
  if (hadExistingTemplateDir) {
    await fs.rm(backupDir, { recursive: true, force: true });
    await fs.rename(targetDir, backupDir);
  }
  await fs.mkdir(targetDir, { recursive: true });

  try {
    for (const file of normalizedFiles) {
      const targetPath = path.join(targetDir, file.relativePath);
      if (!targetPath.startsWith(targetDir)) {
        throw new AppError(400, "MOCKUP_TEMPLATE_PATH_INVALID", "模板文件路径不正确");
      }
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, file.buffer);
    }
    const backupSourceDir = path.join(backupDir, "source");
    if (await pathExists(backupSourceDir)) {
      await fs.cp(backupSourceDir, path.join(targetDir, "source"), { recursive: true });
    }

    invalidateMockupTemplateCache(templateDir);
    const info = await getMockupTemplateInfo(templateDir);
    await assertTemplateAssetsExist(templateDir);

    const result = await pool.query(
      `
      UPDATE mockup_templates
      SET name = COALESCE(NULLIF($2, ''), name),
          description = COALESCE(NULLIF($3, ''), description),
          product_type = COALESCE(NULLIF($4, ''), product_type),
          source_aspect_ratio = COALESCE(NULLIF($5, ''), source_aspect_ratio),
          preview_url = COALESCE(NULLIF($6, ''), preview_url),
          last_test_status = 'pending',
          last_test_message = $7,
          last_test_at = NULL,
          scene_count = $8,
          output_width = $9,
          output_height = $10,
          updated_at = now()
      WHERE id = $1
      RETURNING *
      `,
      [
        row.id,
        info.name || "",
        info.description || "",
        info.productType || "",
        info.sourceAspectRatio || "",
        info.previewUrl || "",
        `可渲染模板已上传，共 ${info.sceneCount} 个场景。请生成测试预览后再发布。`,
        info.sceneCount,
        info.outputWidth,
        info.outputHeight,
      ],
    );
    await fs.rm(backupDir, { recursive: true, force: true });
    return toAdminTemplate(result.rows[0]);
  } catch (error) {
    await fs.rm(targetDir, { recursive: true, force: true });
    if (hadExistingTemplateDir && await pathExists(backupDir)) {
      await fs.rename(backupDir, targetDir);
    } else {
      await fs.mkdir(targetDir, { recursive: true });
    }
    invalidateMockupTemplateCache(templateDir);
    if (error instanceof AppError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError(400, "MOCKUP_TEMPLATE_UPLOAD_FAILED", `模板文件夹上传失败：${message}`);
  }
}

export async function runMockupTemplatePreviewTest(templateId: string) {
  const row = await getAdminTemplateRow(templateId);
  const templateDir = normalizeTemplateDir(row.template_dir);
  const templatePath = path.join(writableTemplateRoot, templateDir, "template.json");
  if (!await pathExists(templatePath)) {
    await markTemplateTestFailed(row.id, "还没有可渲染模板。请先完成 PSD 转换，生成 template.json、layers 和 masks 后再测试。");
    throw new AppError(409, "MOCKUP_TEMPLATE_NOT_READY", "还没有可渲染模板，请先完成 PSD 转换");
  }

  try {
    const sourceBuffer = await createPreviewSource();
    const rendered = await renderMockupsWithTemplate({
      templateDir,
      sourceBuffer,
      sku: `preview-${row.id}`,
      sceneIndexes: [1],
    });
    const firstScene = rendered.scenes[0];
    if (!firstScene) {
      throw new Error("模板没有可渲染场景");
    }
    const objectKey = `mockup-template-previews/${row.id}/${sha256Hex(firstScene.buffer).slice(0, 16)}.${extensionFromContentType(firstScene.contentType)}`;
    await uploadObject(objectKey, firstScene.buffer, firstScene.contentType);
    const previewUrl = publicUrlForObjectKey(objectKey);
    const result = await pool.query(
      `
      UPDATE mockup_templates
      SET test_preview_object_key = $2,
          test_preview_url = $3,
          last_test_status = 'succeeded',
          last_test_message = $4,
          last_test_at = now(),
          scene_count = $5,
          output_width = $6,
          output_height = $7,
          updated_at = now()
      WHERE id = $1
      RETURNING *
      `,
      [
        row.id,
        objectKey,
        previewUrl,
        `测试预览生成成功，共 ${rendered.template.sceneCount} 个场景。`,
        rendered.template.sceneCount,
        rendered.template.outputWidth,
        rendered.template.outputHeight,
      ],
    );
    return toAdminTemplate(result.rows[0]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markTemplateTestFailed(row.id, message);
    throw new AppError(500, "MOCKUP_TEST_FAILED", `样机测试预览失败：${message}`);
  }
}

export async function setMockupTemplateStatus(templateId: string, status: MockupTemplateStatus) {
  const row = await getAdminTemplateRow(templateId);
  if (status === "published") {
    await assertTemplateCanPublish(row);
  }
  const result = await pool.query(
    `
    UPDATE mockup_templates
    SET status = $2,
        updated_at = now()
    WHERE id = $1
    RETURNING *
    `,
    [row.id, status],
  );
  return toAdminTemplate(result.rows[0]);
}

async function syncTemplateFromDisk(templateId: string, options: {
  status: MockupTemplateStatus;
  sourceType: "system" | "custom";
  fallbackName: string;
  fallbackDescription: string;
}) {
  const templateDir = normalizeTemplateDir(templateId);
  const templatePath = path.join(writableTemplateRoot, templateDir, "template.json");
  const bundledTemplatePath = path.join(bundledTemplateRoot, templateDir, "template.json");
  if (!await pathExists(templatePath) && await pathExists(bundledTemplatePath) && writableTemplateRoot !== bundledTemplateRoot) {
    await fs.cp(path.join(bundledTemplateRoot, templateDir), path.join(writableTemplateRoot, templateDir), { recursive: true });
  }
  if (!await pathExists(templatePath)) {
    return;
  }
  const info = await getMockupTemplateInfo(templateDir);
  await pool.query(
    `
    INSERT INTO mockup_templates (
      id,
      name,
      description,
      product_type,
      source_aspect_ratio,
      status,
      source_type,
      template_dir,
      last_test_status,
      last_test_message,
      scene_count,
      output_width,
      output_height,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'succeeded', '磁盘模板已同步。', $9, $10, $11, now())
    ON CONFLICT (id) DO UPDATE
    SET name = EXCLUDED.name,
        description = EXCLUDED.description,
        product_type = EXCLUDED.product_type,
        source_aspect_ratio = EXCLUDED.source_aspect_ratio,
        status = CASE
          WHEN mockup_templates.source_type = 'system' THEN mockup_templates.status
          ELSE EXCLUDED.status
        END,
        source_type = EXCLUDED.source_type,
        template_dir = EXCLUDED.template_dir,
        scene_count = EXCLUDED.scene_count,
        output_width = EXCLUDED.output_width,
        output_height = EXCLUDED.output_height,
        updated_at = now()
    `,
    [
      templateId,
      info.name || options.fallbackName,
      info.description || options.fallbackDescription,
      info.productType || "",
      info.sourceAspectRatio || "",
      options.status,
      options.sourceType,
      templateDir,
      info.sceneCount,
      info.outputWidth,
      info.outputHeight,
    ],
  );
  if (info.previewUrl) {
    await pool.query(
      "UPDATE mockup_templates SET preview_url = $2, updated_at = now() WHERE id = $1",
      [templateId, info.previewUrl],
    );
  }
}

async function getAdminTemplateRow(templateId: string) {
  const id = normalizeTemplateId(templateId);
  const result = await pool.query("SELECT * FROM mockup_templates WHERE id = $1 AND deleted_at IS NULL LIMIT 1", [id]);
  const row = result.rows[0] as MockupTemplateRow | undefined;
  if (!row) {
    throw new AppError(404, "MOCKUP_TEMPLATE_NOT_FOUND", "样机不存在");
  }
  return row;
}

async function assertTemplateCanPublish(row: MockupTemplateRow) {
  const templateDir = normalizeTemplateDir(row.template_dir);
  const templatePath = path.join(writableTemplateRoot, templateDir, "template.json");
  if (!await pathExists(templatePath)) {
    throw new AppError(409, "MOCKUP_TEMPLATE_NOT_READY", "还没有可渲染模板，不能发布");
  }
  await assertTemplateAssetsExist(templateDir);
  if (row.last_test_status !== "succeeded") {
    throw new AppError(409, "MOCKUP_TEMPLATE_TEST_REQUIRED", "请先生成测试预览并确认成功后再发布");
  }
}

async function assertTemplateAssetsExist(templateDir: string) {
  const normalizedTemplateDir = normalizeTemplateDir(templateDir);
  const templateRoot = path.join(writableTemplateRoot, normalizedTemplateDir);
  const templatePath = path.join(templateRoot, "template.json");
  const raw = await fs.readFile(templatePath, "utf8");
  const template = JSON.parse(raw) as {
    scenes?: Array<{
      layers?: Array<{
        file?: string;
        mask?: string;
        clipMask?: string;
      }>;
    }>;
  };
  if (!Array.isArray(template.scenes) || template.scenes.length === 0) {
    throw new AppError(400, "MOCKUP_TEMPLATE_SCENES_REQUIRED", "template.json 至少需要 1 个场景");
  }
  for (const scene of template.scenes) {
    for (const layer of scene.layers || []) {
      for (const file of [layer.file, layer.mask, layer.clipMask]) {
        if (!file) continue;
        const normalized = normalizeTemplateUploadPath(file);
        const fullPath = path.join(templateRoot, normalized);
        if (!fullPath.startsWith(templateRoot) || !await pathExists(fullPath)) {
          throw new AppError(400, "MOCKUP_TEMPLATE_ASSET_MISSING", `模板引用的资源不存在：${file}`);
        }
      }
    }
  }
}

async function markTemplateTestFailed(templateId: string, message: string) {
  await pool.query(
    `
    UPDATE mockup_templates
    SET last_test_status = 'failed',
        last_test_message = $2,
        last_test_at = now(),
        updated_at = now()
    WHERE id = $1
    `,
    [templateId, message.slice(0, 1000)],
  );
}

async function createPreviewSource() {
  return sharp({
    create: {
      width: 1024,
      height: 1024,
      channels: 4,
      background: { r: 238, g: 246, b: 255, alpha: 1 },
    },
  })
    .composite([
      {
        input: Buffer.from(`
          <svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
                <stop stop-color="#0A66E8"/>
                <stop offset="0.55" stop-color="#20B486"/>
                <stop offset="1" stop-color="#F2B84B"/>
              </linearGradient>
            </defs>
            <rect width="1024" height="1024" fill="url(#g)"/>
            <circle cx="264" cy="304" r="138" fill="rgba(255,255,255,0.38)"/>
            <circle cx="744" cy="696" r="180" fill="rgba(255,255,255,0.28)"/>
            <path d="M160 650 C 290 540, 415 748, 560 626 S 820 510, 890 646" fill="none" stroke="rgba(255,255,255,0.7)" stroke-width="42" stroke-linecap="round"/>
            <text x="512" y="514" text-anchor="middle" font-size="72" font-family="Arial, sans-serif" fill="#ffffff" font-weight="700">TEST</text>
          </svg>
        `),
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toBuffer();
}

function toPublicTemplate(row: MockupTemplateRow) {
  return {
    id: row.id,
    templateId: row.id,
    name: row.name,
    description: row.description,
    productType: row.product_type,
    sourceAspectRatio: row.source_aspect_ratio,
    status: row.source_type === "system" ? "system" : "custom",
    previewUrl: row.test_preview_url || row.preview_url || `/mockup-template-assets/${encodeURIComponent(row.template_dir)}/preview.png`,
    sceneCount: Number(row.scene_count || 0),
    outputWidth: Number(row.output_width || 0),
    outputHeight: Number(row.output_height || 0),
  };
}

function toAdminTemplate(row: MockupTemplateRow) {
  return {
    ...toPublicTemplate(row),
    adminStatus: row.status,
    sourceType: row.source_type,
    templateDir: row.template_dir,
    sourcePsdFilename: row.source_psd_filename,
    sourcePsdSizeBytes: Number(row.source_psd_size_bytes || 0),
    testPreviewUrl: row.test_preview_url,
    lastTestStatus: row.last_test_status,
    lastTestMessage: row.last_test_message,
    lastTestAt: row.last_test_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    canPublish: row.last_test_status === "succeeded" && Number(row.scene_count || 0) > 0,
  };
}

function toRenderableTemplate(row: MockupTemplateRow) {
  return {
    id: row.id,
    name: row.name,
    templateDir: row.template_dir,
  };
}

function normalizeTemplateId(value: string) {
  const id = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z0-9][a-z0-9_-]{1,79}$/.test(id)) {
    throw new AppError(400, "MOCKUP_TEMPLATE_ID_INVALID", "样机编号只能使用小写字母、数字、下划线和中横线，长度 2-80");
  }
  return id;
}

function normalizeTemplateDir(value: string) {
  const normalized = path.normalize(value).replace(/^(\.\.(\/|\\|$))+/, "");
  const fullPath = path.join(writableTemplateRoot, normalized);
  if (!fullPath.startsWith(writableTemplateRoot)) {
    throw new AppError(400, "MOCKUP_TEMPLATE_DIR_INVALID", "样机目录不正确");
  }
  return normalized;
}

function normalizeTemplateUploadPath(value: string) {
  const trimmed = value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = trimmed.split("/").filter(Boolean);
  const usefulParts = stripLeadingTemplateFolder(parts);
  const normalized = path.normalize(usefulParts.join("/"));
  if (!normalized || normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new AppError(400, "MOCKUP_TEMPLATE_PATH_INVALID", "模板文件路径不正确");
  }
  if (
    normalized !== "template.json"
    && !normalized.startsWith(`layers${path.sep}`)
    && !normalized.startsWith(`masks${path.sep}`)
    && !/^preview\.(png|jpe?g|webp)$/i.test(normalized)
  ) {
    throw new AppError(400, "MOCKUP_TEMPLATE_FILE_INVALID", `模板文件夹只支持 template.json、layers、masks 和 preview 图片：${value}`);
  }
  return normalized;
}

function stripLeadingTemplateFolder(parts: string[]) {
  if (parts.length >= 2 && !["template.json", "layers", "masks"].includes(parts[0]) && !/^preview\.(png|jpe?g|webp)$/i.test(parts[0])) {
    return parts.slice(1);
  }
  return parts;
}

function sanitizeFilename(value: string) {
  const ext = path.extname(value) || ".psd";
  const base = path.basename(value, ext).replace(/[\\/:*?"<>|#%{}]+/g, "-").trim() || newId();
  return `${base.slice(0, 120)}${ext.toLowerCase()}`;
}

function extensionFromContentType(contentType: string) {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  return "jpg";
}

async function pathExists(target: string) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
