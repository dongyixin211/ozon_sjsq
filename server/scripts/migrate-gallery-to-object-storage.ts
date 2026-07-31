import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { pool } from "../src/db.js";

type AssetRow = {
  id: string;
  object_key: string;
  public_url: string;
  thumb_object_key: string | null;
  thumb_url: string | null;
  content_type: string;
};

type MockupPreviewRow = {
  id: string;
  test_preview_object_key: string;
  test_preview_url: string | null;
};

type UploadJob = {
  objectKey: string;
  localPath: string;
  contentType: string;
};

const localRoot = requiredEnv("MIGRATE_STORAGE_LOCAL_DIR", process.env.STORAGE_LOCAL_DIR || "/opt/ozon-sjsq-cloud/uploads");
const targetProvider = (process.env.MIGRATE_STORAGE_PROVIDER || process.env.STORAGE_PROVIDER || "oss").toLowerCase();
const endpoint = requiredEnv("MIGRATE_STORAGE_ENDPOINT", process.env.MIGRATE_STORAGE_ENDPOINT || process.env.STORAGE_ENDPOINT);
const region = process.env.MIGRATE_STORAGE_REGION || process.env.STORAGE_REGION || "cn-beijing";
const accessKeyId = requiredEnv("MIGRATE_STORAGE_ACCESS_KEY_ID", process.env.MIGRATE_STORAGE_ACCESS_KEY_ID || process.env.STORAGE_ACCESS_KEY_ID);
const secretAccessKey = requiredEnv("MIGRATE_STORAGE_SECRET_ACCESS_KEY", process.env.MIGRATE_STORAGE_SECRET_ACCESS_KEY || process.env.STORAGE_SECRET_ACCESS_KEY);
const bucket = requiredEnv("MIGRATE_STORAGE_BUCKET", process.env.MIGRATE_STORAGE_BUCKET || process.env.STORAGE_BUCKET);
const publicBaseUrl = requiredEnv("MIGRATE_STORAGE_PUBLIC_BASE_URL", process.env.MIGRATE_STORAGE_PUBLIC_BASE_URL || process.env.STORAGE_PUBLIC_BASE_URL);
const oldPublicBaseUrl = (process.env.MIGRATE_STORAGE_OLD_PUBLIC_BASE_URL || process.env.STORAGE_PUBLIC_BASE_URL || "").replace(/\/$/, "");
const concurrency = positiveInt(process.env.MIGRATE_STORAGE_CONCURRENCY, 6);
const limit = nonNegativeInt(process.env.MIGRATE_STORAGE_LIMIT, 0);
const dryRun = booleanEnv(process.env.MIGRATE_STORAGE_DRY_RUN, true);
const updateDatabase = booleanEnv(process.env.MIGRATE_STORAGE_UPDATE_DB, false);
const skipExisting = booleanEnv(process.env.MIGRATE_STORAGE_SKIP_EXISTING, true);
const includeMockupPreviews = booleanEnv(process.env.MIGRATE_STORAGE_INCLUDE_MOCKUP_PREVIEWS, true);
const includeExtraDirs = booleanEnv(process.env.MIGRATE_STORAGE_INCLUDE_EXTRA_DIRS, limit <= 0);
const forcePathStyle = resolveForcePathStyle();

if (targetProvider === "local") {
  throw new Error("迁移目标不能是 local，请配置 OSS/R2/COS 等对象存储。");
}

const s3 = new S3Client({
  endpoint,
  region,
  credentials: {
    accessKeyId,
    secretAccessKey,
  },
  forcePathStyle,
});

let uploaded = 0;
let skipped = 0;
let missing = 0;
let failed = 0;
let dbUpdated = 0;

try {
  console.log(`迁移目标：${targetProvider} ${bucket}`);
  console.log(`Endpoint：${endpoint}`);
  console.log(`公开地址：${publicBaseUrl}`);
  console.log(`本地目录：${localRoot}`);
  console.log(`并发：${concurrency}，dry-run：${dryRun}，更新数据库：${updateDatabase}`);

  const assets = await loadAssetRows();
  const previews = includeMockupPreviews ? await loadMockupPreviewRows() : [];
  const jobs = await buildUploadJobs(assets, previews);
  console.log(`待检查对象：${jobs.length} 个，图库记录：${assets.length} 条，样机预览：${previews.length} 条`);

  await runPool(jobs, concurrency, processJob);

  if (updateDatabase && !dryRun) {
    dbUpdated += await updateGalleryUrls(assets);
    if (includeMockupPreviews) {
      dbUpdated += await updateMockupPreviewUrls(previews);
    }
    dbUpdated += await updateListingImageUrls();
  }

  console.log(`完成：上传 ${uploaded}，跳过 ${skipped}，本地缺失 ${missing}，失败 ${failed}，更新数据库 ${dbUpdated}`);
  if (dryRun) {
    console.log("当前是 dry-run，没有上传文件，也没有更新数据库。确认输出正常后设置 MIGRATE_STORAGE_DRY_RUN=false 再执行。");
  } else if (!updateDatabase) {
    console.log("文件已上传，但没有更新数据库。确认对象访问正常后设置 MIGRATE_STORAGE_UPDATE_DB=true 再执行数据库 URL 更新。");
  }
} finally {
  await pool.end();
}

if (failed > 0) {
  process.exit(1);
}

async function loadAssetRows() {
  const result = await pool.query<AssetRow>(
    `
    SELECT id, object_key, public_url, thumb_object_key, thumb_url, content_type
    FROM gallery_assets
    WHERE deleted_at IS NULL
    ORDER BY created_at ASC
    ${limit > 0 ? "LIMIT $1" : ""}
    `,
    limit > 0 ? [limit] : [],
  );
  return result.rows;
}

async function loadMockupPreviewRows() {
  const result = await pool.query<MockupPreviewRow>(
    `
    SELECT id, test_preview_object_key, test_preview_url
    FROM mockup_templates
    WHERE test_preview_object_key IS NOT NULL
      AND test_preview_object_key <> ''
    ORDER BY updated_at ASC
    `,
  );
  return result.rows;
}

async function buildUploadJobs(assets: AssetRow[], previews: MockupPreviewRow[]) {
  const byKey = new Map<string, UploadJob>();
  for (const asset of assets) {
    byKey.set(asset.object_key, {
      objectKey: asset.object_key,
      localPath: path.join(localRoot, asset.object_key),
      contentType: asset.content_type || contentTypeForKey(asset.object_key),
    });
    if (asset.thumb_object_key) {
      byKey.set(asset.thumb_object_key, {
        objectKey: asset.thumb_object_key,
        localPath: path.join(localRoot, asset.thumb_object_key),
        contentType: "image/webp",
      });
    }
  }
  for (const preview of previews) {
    byKey.set(preview.test_preview_object_key, {
      objectKey: preview.test_preview_object_key,
      localPath: path.join(localRoot, preview.test_preview_object_key),
      contentType: contentTypeForKey(preview.test_preview_object_key),
    });
  }
  if (includeExtraDirs) {
    for (const prefix of ["gallery-ozon", "mockup-template-previews"]) {
      for (const job of await collectDirectoryJobs(prefix)) {
        byKey.set(job.objectKey, job);
      }
    }
  }
  return [...byKey.values()];
}

async function collectDirectoryJobs(prefix: string) {
  const root = path.join(localRoot, prefix);
  const jobs: UploadJob[] = [];
  await walk(root);
  return jobs;

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const objectKey = path.relative(localRoot, fullPath).split(path.sep).join("/");
      jobs.push({
        objectKey,
        localPath: fullPath,
        contentType: contentTypeForKey(objectKey),
      });
    }
  }
}

async function processJob(job: UploadJob) {
  try {
    const stat = await fs.stat(job.localPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (!stat?.isFile()) {
      missing += 1;
      console.warn(`本地文件不存在，跳过：${job.objectKey}`);
      return;
    }

    if (dryRun) {
      skipped += 1;
      return;
    }

    if (skipExisting && await objectExists(job.objectKey)) {
      skipped += 1;
      return;
    }

    const body = await fs.readFile(job.localPath);
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: job.objectKey,
      Body: body,
      ContentType: job.contentType,
      CacheControl: "public, max-age=31536000, immutable",
    }));
    uploaded += 1;
    if (uploaded % 100 === 0) {
      console.log(`已上传 ${uploaded} 个对象...`);
    }
  } catch (error) {
    failed += 1;
    console.error(`上传失败：${job.objectKey}`, error instanceof Error ? error.message : String(error));
  }
}

async function objectExists(objectKey: string) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
    return true;
  } catch {
    return false;
  }
}

async function updateGalleryUrls(assets: AssetRow[]) {
  let updated = 0;
  for (const asset of assets) {
    const publicUrl = publicUrlForObjectKey(asset.object_key);
    const thumbUrl = asset.thumb_object_key ? publicUrlForObjectKey(asset.thumb_object_key) : asset.thumb_url;
    const result = await pool.query(
      `
      UPDATE gallery_assets
      SET public_url = $2,
          thumb_url = $3
      WHERE id = $1
        AND (public_url IS DISTINCT FROM $2 OR thumb_url IS DISTINCT FROM $3)
      `,
      [asset.id, publicUrl, thumbUrl],
    );
    updated += result.rowCount ?? 0;
  }
  return updated;
}

async function updateMockupPreviewUrls(previews: MockupPreviewRow[]) {
  let updated = 0;
  for (const preview of previews) {
    const previewUrl = publicUrlForObjectKey(preview.test_preview_object_key);
    const result = await pool.query(
      `
      UPDATE mockup_templates
      SET test_preview_url = $2,
          updated_at = now()
      WHERE id = $1
        AND test_preview_url IS DISTINCT FROM $2
      `,
      [preview.id, previewUrl],
    );
    updated += result.rowCount ?? 0;
  }
  return updated;
}

async function updateListingImageUrls() {
  if (!oldPublicBaseUrl || oldPublicBaseUrl === publicBaseUrl.replace(/\/$/, "")) {
    return 0;
  }
  const result = await pool.query(
    `
    UPDATE gallery_listing_batch_assets
    SET image_urls = (
      SELECT array_agg(
        CASE
          WHEN url LIKE $1 || '/%' THEN $2 || substring(url FROM length($1) + 1)
          ELSE url
        END
        ORDER BY ordinality
      )
      FROM unnest(image_urls) WITH ORDINALITY AS item(url, ordinality)
    ),
    updated_at = now()
    WHERE EXISTS (
      SELECT 1
      FROM unnest(image_urls) AS item(url)
      WHERE url LIKE $1 || '/%'
    )
    `,
    [oldPublicBaseUrl, publicBaseUrl.replace(/\/$/, "")],
  );
  return result.rowCount ?? 0;
}

function publicUrlForObjectKey(objectKey: string) {
  return `${publicBaseUrl.replace(/\/$/, "")}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
}

async function runPool<T>(items: T[], size: number, worker: (item: T) => Promise<void>) {
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, size) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(workers);
}

function contentTypeForKey(objectKey: string) {
  const ext = path.extname(objectKey).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}

function requiredEnv(name: string, value: string | undefined) {
  if (!value) {
    throw new Error(`缺少环境变量：${name}`);
  }
  return value;
}

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value || fallback);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function nonNegativeInt(value: string | undefined, fallback: number) {
  const parsed = Number(value || fallback);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function booleanEnv(value: string | undefined, fallback: boolean) {
  if (value === undefined || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function resolveForcePathStyle() {
  const explicit = (process.env.MIGRATE_STORAGE_FORCE_PATH_STYLE || process.env.STORAGE_FORCE_PATH_STYLE || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(explicit)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(explicit)) {
    return false;
  }
  if (targetProvider === "oss" || endpoint.toLowerCase().includes(".aliyuncs.com")) {
    return false;
  }
  return true;
}
