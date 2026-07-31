import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { config } from "../src/config.js";
import { normalizeLocalUploadObjectKey } from "../src/local-upload-access.js";

type UploadJob = {
  objectKey: string;
  localPath: string;
  sizeBytes: number;
  contentType: string;
};

const localRoot = path.resolve(process.env.SYNC_LOCAL_UPLOADS_ROOT || config.STORAGE_LOCAL_DIR);
const prefix = normalizePrefix(process.env.SYNC_LOCAL_UPLOADS_PREFIX || "");
const concurrency = positiveInt(process.env.SYNC_LOCAL_UPLOADS_CONCURRENCY, 6);
const limit = nonNegativeInt(process.env.SYNC_LOCAL_UPLOADS_LIMIT, 0);
const minFileBytes = nonNegativeInt(process.env.SYNC_LOCAL_UPLOADS_MIN_FILE_BYTES, 0);
const maxFileBytes = nonNegativeInt(process.env.SYNC_LOCAL_UPLOADS_MAX_FILE_BYTES, 0);
const sortMode = normalizeSortMode(process.env.SYNC_LOCAL_UPLOADS_SORT || "");
const dryRun = booleanEnv(process.env.SYNC_LOCAL_UPLOADS_DRY_RUN, true);
const skipExisting = booleanEnv(process.env.SYNC_LOCAL_UPLOADS_SKIP_EXISTING, true);
const quiet = booleanEnv(process.env.SYNC_LOCAL_UPLOADS_QUIET, false);
const verifyBucket = booleanEnv(process.env.SYNC_LOCAL_UPLOADS_VERIFY_BUCKET, true);
const progressEvery = nonNegativeInt(process.env.SYNC_LOCAL_UPLOADS_PROGRESS_EVERY, 100);
const storageMaxAttempts = positiveInt(process.env.SYNC_LOCAL_UPLOADS_STORAGE_MAX_ATTEMPTS, 1);
const storageRequestTimeoutMs = positiveInt(process.env.SYNC_LOCAL_UPLOADS_REQUEST_TIMEOUT_MS, 120_000);
const storageConnectionTimeoutMs = positiveInt(process.env.SYNC_LOCAL_UPLOADS_CONNECTION_TIMEOUT_MS, 10_000);
const failureReportPath = process.env.SYNC_LOCAL_UPLOADS_FAILURE_REPORT
  ? path.resolve(process.env.SYNC_LOCAL_UPLOADS_FAILURE_REPORT)
  : "";
const keysFilePath = process.env.SYNC_LOCAL_UPLOADS_KEYS_FILE
  ? path.resolve(process.env.SYNC_LOCAL_UPLOADS_KEYS_FILE)
  : "";
const failureReportInputPath = process.env.SYNC_LOCAL_UPLOADS_FAILURE_REPORT_INPUT
  ? path.resolve(process.env.SYNC_LOCAL_UPLOADS_FAILURE_REPORT_INPUT)
  : "";
const storageProvider = config.STORAGE_PROVIDER.toLowerCase();
const forcePathStyle = resolveForcePathStyle();

if (storageProvider === "local") {
  throw new Error("SYNC_LOCAL_UPLOADS requires object storage; STORAGE_PROVIDER=local is not supported.");
}

const s3 = new S3Client({
  endpoint: config.STORAGE_ENDPOINT,
  region: config.STORAGE_REGION,
  credentials: {
    accessKeyId: config.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: config.STORAGE_SECRET_ACCESS_KEY,
  },
  forcePathStyle,
  maxAttempts: storageMaxAttempts,
  requestHandler: new NodeHttpHandler({
    connectionTimeout: storageConnectionTimeoutMs,
    requestTimeout: storageRequestTimeoutMs,
    throwOnRequestTimeout: true,
  }),
});

const stats = {
  scanned: 0,
  collected: 0,
  skippedTemp: 0,
  skippedInvalidKey: 0,
  skippedByPrefix: 0,
  skippedBySize: 0,
  processed: 0,
  exists: 0,
  missing: 0,
  headErrors: 0,
  uploaded: 0,
  failed: 0,
  checkedBytes: 0,
  missingBytes: 0,
  uploadedBytes: 0,
};
const failedJobs: Array<{
  objectKey: string;
  localPath: string;
  sizeBytes: number;
  error: string;
}> = [];

try {
  log("Local uploads object-storage sync");
  log(`root=${localRoot}`);
  log(`bucket=${config.STORAGE_BUCKET}`);
  log(`prefix=${prefix || "all"}`);
  log(`dryRun=${dryRun}`);
  log(`skipExisting=${skipExisting}`);
  log(`verifyBucket=${verifyBucket}`);
  log(`storageMaxAttempts=${storageMaxAttempts}`);
  log(`requestTimeoutMs=${storageRequestTimeoutMs}`);
  log(`connectionTimeoutMs=${storageConnectionTimeoutMs}`);
  log(`progressEvery=${progressEvery || "off"}`);
  log(`failureReport=${failureReportPath || "off"}`);
  log(`keysFile=${keysFilePath || "off"}`);
  log(`failureReportInput=${failureReportInputPath || "off"}`);
  log(`minFileBytes=${minFileBytes}`);
  log(`maxFileBytes=${maxFileBytes || "unlimited"}`);
  log(`sort=${sortMode || "walk"}`);
  log(`limit=${limit || "unlimited"}`);
  log(`concurrency=${concurrency}`);

  if (verifyBucket) {
    await verifyStorageBucket();
  }

  const jobs = keysFilePath || failureReportInputPath
    ? await collectJobsFromKeyInputs(localRoot)
    : await collectLocalFiles(localRoot);
  sortJobs(jobs);
  stats.collected = jobs.length;
  log(`collected=${jobs.length}`);
  await runPool(jobs, concurrency, processJob);
  await writeFailureReport();
  printSummary();
  if (dryRun) {
    log("Dry run only. To upload missing objects, set SYNC_LOCAL_UPLOADS_DRY_RUN=false.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

if (stats.failed > 0) {
  process.exitCode = 1;
}

async function collectLocalFiles(root: string) {
  const rootReal = await fs.realpath(root);
  const jobs: UploadJob[] = [];
  await walk(rootReal);
  return jobs;

  async function walk(dir: string) {
    if (limit > 0 && jobs.length >= limit) {
      return;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
    for (const entry of entries) {
      if (limit > 0 && jobs.length >= limit) {
        return;
      }
      const fullPath = path.join(dir, entry.name);
      if (shouldSkipName(entry.name)) {
        stats.skippedTemp += 1;
        continue;
      }
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      stats.scanned += 1;
      const relativeKey = path.relative(rootReal, fullPath).split(path.sep).join("/");
      const objectKey = normalizeLocalUploadObjectKey(relativeKey);
      if (!objectKey) {
        stats.skippedInvalidKey += 1;
        continue;
      }
      if (prefix && !objectKey.startsWith(prefix)) {
        stats.skippedByPrefix += 1;
        continue;
      }
      const stat = await fs.stat(fullPath);
      if (stat.size < minFileBytes || (maxFileBytes > 0 && stat.size > maxFileBytes)) {
        stats.skippedBySize += 1;
        continue;
      }
      jobs.push({
        objectKey,
        localPath: fullPath,
        sizeBytes: stat.size,
        contentType: contentTypeForKey(objectKey),
      });
    }
  }
}

async function collectJobsFromKeyInputs(root: string) {
  const rootReal = await fs.realpath(root);
  const objectKeys = await loadInputObjectKeys();
  const jobs: UploadJob[] = [];
  for (const objectKey of objectKeys) {
    if (limit > 0 && jobs.length >= limit) {
      break;
    }
    stats.scanned += 1;
    if (prefix && !objectKey.startsWith(prefix)) {
      stats.skippedByPrefix += 1;
      continue;
    }
    const localPath = path.resolve(rootReal, ...objectKey.split("/"));
    if (localPath !== rootReal && !localPath.startsWith(`${rootReal}${path.sep}`)) {
      stats.skippedInvalidKey += 1;
      continue;
    }
    const stat = await fs.stat(localPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (!stat?.isFile()) {
      stats.skippedInvalidKey += 1;
      continue;
    }
    if (stat.size < minFileBytes || (maxFileBytes > 0 && stat.size > maxFileBytes)) {
      stats.skippedBySize += 1;
      continue;
    }
    jobs.push({
      objectKey,
      localPath,
      sizeBytes: stat.size,
      contentType: contentTypeForKey(objectKey),
    });
  }
  return jobs;
}

async function loadInputObjectKeys() {
  const keys = new Set<string>();
  if (keysFilePath) {
    const text = await fs.readFile(keysFilePath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      addInputObjectKey(keys, line);
    }
  }
  if (failureReportInputPath) {
    const report = JSON.parse(await fs.readFile(failureReportInputPath, "utf8")) as {
      failed?: Array<{ objectKey?: unknown }>;
    };
    for (const item of report.failed ?? []) {
      if (typeof item.objectKey === "string") {
        addInputObjectKey(keys, item.objectKey);
      }
    }
  }
  return Array.from(keys);
}

function addInputObjectKey(keys: Set<string>, value: string) {
  const objectKey = normalizeLocalUploadObjectKey(value.trim());
  if (objectKey) {
    keys.add(objectKey);
  }
}

async function processJob(job: UploadJob) {
  try {
    stats.checkedBytes += job.sizeBytes;
    if (skipExisting && await objectExists(job.objectKey)) {
      stats.exists += 1;
      return;
    }
    stats.missing += 1;
    stats.missingBytes += job.sizeBytes;
    if (dryRun) {
      return;
    }
    const body = await fs.readFile(job.localPath);
    await s3.send(new PutObjectCommand({
      Bucket: config.STORAGE_BUCKET,
      Key: job.objectKey,
      Body: body,
      ContentType: job.contentType,
      CacheControl: "public, max-age=31536000, immutable",
    }));
    stats.uploaded += 1;
    stats.uploadedBytes += job.sizeBytes;
    if (!quiet && stats.uploaded % 100 === 0) {
      console.log(`uploaded=${stats.uploaded}, key=${job.objectKey}`);
    }
  } catch (error) {
    stats.failed += 1;
    const message = error instanceof Error ? error.message : String(error);
    failedJobs.push({
      objectKey: job.objectKey,
      localPath: job.localPath,
      sizeBytes: job.sizeBytes,
      error: message,
    });
    console.error(`failed ${job.objectKey}: ${message}`);
  } finally {
    stats.processed += 1;
    if (!quiet && progressEvery > 0 && stats.processed % progressEvery === 0) {
      console.log(`progress processed=${stats.processed}, exists=${stats.exists}, missing=${stats.missing}, uploaded=${stats.uploaded}, failed=${stats.failed}, checked=${formatBytes(stats.checkedBytes)}, uploadedSize=${formatBytes(stats.uploadedBytes)}`);
    }
  }
}

async function writeFailureReport() {
  if (!failureReportPath || failedJobs.length === 0) {
    return;
  }
  await fs.mkdir(path.dirname(failureReportPath), { recursive: true });
  await fs.writeFile(failureReportPath, JSON.stringify({
    createdAt: new Date().toISOString(),
    root: localRoot,
    bucket: config.STORAGE_BUCKET,
    failed: failedJobs,
  }, null, 2), "utf8");
  log(`failureReportWritten=${failureReportPath}, failed=${failedJobs.length}`);
}

async function verifyStorageBucket() {
  try {
    await s3.send(new HeadBucketCommand({
      Bucket: config.STORAGE_BUCKET,
    }));
  } catch (error) {
    if (isAccessDeniedError(error)) {
      log("Storage bucket head returned access denied; continue with per-object checks.");
      return;
    }
    throw new Error(`Storage bucket verification failed: ${storageErrorText(error)}`);
  }
}

async function objectExists(objectKey: string) {
  try {
    await s3.send(new HeadObjectCommand({
      Bucket: config.STORAGE_BUCKET,
      Key: objectKey,
    }));
    return true;
  } catch (error) {
    if (isObjectMissingError(error)) {
      return false;
    }
    stats.headErrors += 1;
    throw new Error(`HeadObject failed: ${storageErrorText(error)}`);
  }
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

function sortJobs(jobs: UploadJob[]) {
  if (sortMode === "size_asc") {
    jobs.sort((left, right) => left.sizeBytes - right.sizeBytes || left.objectKey.localeCompare(right.objectKey));
    return;
  }
  if (sortMode === "size_desc") {
    jobs.sort((left, right) => right.sizeBytes - left.sizeBytes || left.objectKey.localeCompare(right.objectKey));
    return;
  }
  if (sortMode === "key") {
    jobs.sort((left, right) => left.objectKey.localeCompare(right.objectKey));
  }
}

function normalizeSortMode(value: string) {
  const normalized = value.trim().toLowerCase();
  if (["size_asc", "size_desc", "key"].includes(normalized)) {
    return normalized;
  }
  return "";
}

function contentTypeForKey(objectKey: string) {
  const ext = path.extname(objectKey).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}

function shouldSkipName(name: string) {
  const lower = name.toLowerCase();
  return (
    lower.startsWith(".")
    || lower.endsWith(".tmp")
    || lower.endsWith(".part")
    || lower.endsWith(".crdownload")
    || lower.endsWith("~")
  );
}

function normalizePrefix(value: string) {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  return normalized && !normalized.endsWith("/") ? `${normalized}/` : normalized;
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
  const explicit = config.STORAGE_FORCE_PATH_STYLE.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(explicit)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(explicit)) {
    return false;
  }
  const endpoint = config.STORAGE_ENDPOINT.toLowerCase();
  if (storageProvider === "oss" || endpoint.includes(".aliyuncs.com")) {
    return false;
  }
  return true;
}

function isObjectMissingError(error: unknown) {
  const code = storageErrorCode(error);
  const status = storageHttpStatus(error);
  return status === 404 || ["NotFound", "NoSuchKey", "NoSuchObject"].includes(code);
}

function isAccessDeniedError(error: unknown) {
  const code = storageErrorCode(error);
  const status = storageHttpStatus(error);
  return status === 403 || ["AccessDenied", "Forbidden"].includes(code);
}

function storageErrorCode(error: unknown) {
  if (!error || typeof error !== "object") {
    return "";
  }
  const source = error as { name?: unknown; Code?: unknown; code?: unknown };
  const value = source.Code ?? source.code ?? source.name;
  return typeof value === "string" ? value : "";
}

function storageHttpStatus(error: unknown) {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const metadata = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
  return typeof metadata?.httpStatusCode === "number" ? metadata.httpStatusCode : undefined;
}

function storageErrorText(error: unknown) {
  const code = storageErrorCode(error);
  const status = storageHttpStatus(error);
  const message = error instanceof Error ? error.message : String(error);
  return [
    status ? `status=${status}` : "",
    code ? `code=${code}` : "",
    message,
  ].filter(Boolean).join(" ");
}

function printSummary() {
  console.log(JSON.stringify({
    ...stats,
    checkedSize: formatBytes(stats.checkedBytes),
    missingSize: formatBytes(stats.missingBytes),
    uploadedSize: formatBytes(stats.uploadedBytes),
  }, null, 2));
}

function formatBytes(value: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function log(message: string) {
  if (!quiet) {
    console.log(message);
  }
}
