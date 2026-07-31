import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { config } from "../src/config.js";
import { pool } from "../src/db.js";
import { normalizeLocalUploadObjectKey } from "../src/local-upload-access.js";

type LocalFileJob = {
  objectKey: string;
  localPath: string;
  sizeBytes: number;
  mtimeMs: number;
};

type AccessRow = {
  last_accessed_at: Date;
  access_count: string;
  last_source: string;
};

type AccessSummary = {
  totalTrackedObjects: number;
  lastAccessedAt: Date | null;
  recent1h: number;
  recent4h: number;
  recent24h: number;
  recentQuietWindow: number;
};

type ObjectHeadResult = {
  exists: boolean;
  sizeBytes?: number;
};

type ObjectInventory = Map<string, number | undefined>;

type SafetyReport = {
  trackingStartedAt: string;
  trackingAgeDays: number;
  minAccessQuietDays: number;
  fileMinAgeDays: number;
  totalTrackedObjects: number;
  lastAccessedAt: string | null;
  earliestSafeCleanupAt: string;
  recentAccess: {
    "1h": number;
    "4h": number;
    "24h": number;
    quietWindowDays: number;
    quietWindow: number;
  };
  trackingWindowReady: boolean;
  recentAccessQuiet: boolean;
  canConsiderCleanup: boolean;
  statusOnly: boolean;
  dryRun: boolean;
  deleteEnabled: boolean;
  deleteRequested: boolean;
  effectiveDelete: boolean;
  blockedReasons: string[];
};

const localRoot = path.resolve(process.env.CLEANUP_LOCAL_UPLOADS_ROOT || config.STORAGE_LOCAL_DIR);
const minAgeDays = nonNegativeInt(process.env.CLEANUP_LOCAL_UPLOADS_MIN_AGE_DAYS, 14);
const fileMinAgeDays = nonNegativeInt(process.env.CLEANUP_LOCAL_UPLOADS_FILE_MIN_AGE_DAYS, minAgeDays);
const limit = nonNegativeInt(process.env.CLEANUP_LOCAL_UPLOADS_LIMIT, 0);
const concurrency = positiveInt(process.env.CLEANUP_LOCAL_UPLOADS_CONCURRENCY, 4);
const statusOnly = hasFlag("--status") || booleanEnv(process.env.CLEANUP_LOCAL_UPLOADS_STATUS_ONLY, false);
const dryRun = booleanEnv(process.env.CLEANUP_LOCAL_UPLOADS_DRY_RUN, true);
const deleteEnabled = booleanEnv(process.env.CLEANUP_LOCAL_UPLOADS_DELETE, false);
const quiet = booleanEnv(process.env.CLEANUP_LOCAL_UPLOADS_QUIET, false);
const auditYoungFiles = statusOnly || booleanEnv(process.env.CLEANUP_LOCAL_UPLOADS_AUDIT_YOUNG_FILES, false);
const verifyBucket = booleanEnv(process.env.CLEANUP_LOCAL_UPLOADS_VERIFY_BUCKET, true);
const verifySize = booleanEnv(process.env.CLEANUP_LOCAL_UPLOADS_VERIFY_SIZE, true);
const verifyMode = resolveVerifyMode();
const storageMaxAttempts = positiveInt(process.env.CLEANUP_LOCAL_UPLOADS_STORAGE_MAX_ATTEMPTS, 1);
const progressEvery = nonNegativeInt(process.env.CLEANUP_LOCAL_UPLOADS_PROGRESS_EVERY, 1000);
const forcePathStyle = resolveForcePathStyle();
const storageProvider = config.STORAGE_PROVIDER.toLowerCase();

if (storageProvider === "local") {
  throw new Error("CLEANUP_LOCAL_UPLOADS requires object storage; STORAGE_PROVIDER=local is not supported.");
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
});

const now = Date.now();
const accessCutoffMs = now - minAgeDays * 24 * 60 * 60 * 1000;
const fileCutoffMs = now - fileMinAgeDays * 24 * 60 * 60 * 1000;
const deleteRequested = !statusOnly && !dryRun && deleteEnabled;
let effectiveDelete = false;

const stats = {
  scanned: 0,
  skippedTemp: 0,
  skippedInvalidKey: 0,
  skippedYoungFile: 0,
  processed: 0,
  ossExists: 0,
  ossMissing: 0,
  ossSizeMismatch: 0,
  ossHeadErrors: 0,
  recentAccess: 0,
  trackingWindowNotReady: 0,
  safetyHold: 0,
  candidates: 0,
  deleted: 0,
  failed: 0,
  candidateBytes: 0,
  deletedBytes: 0,
};

try {
  const trackingStartedAt = await loadTrackingStartedAt();
  const trackingAgeDays = (now - trackingStartedAt.getTime()) / 86_400_000;
  const trackingWindowReady = trackingStartedAt.getTime() <= accessCutoffMs;
  const accessSummary = await loadAccessSummary();
  const safetyReport = buildSafetyReport({
    accessSummary,
    trackingAgeDays,
    trackingStartedAt,
    trackingWindowReady,
  });
  effectiveDelete = safetyReport.effectiveDelete;

  log(`Local uploads cleanup`);
  log(`root=${localRoot}`);
  log(`bucket=${config.STORAGE_BUCKET}`);
  log(`minAccessQuietDays=${minAgeDays}`);
  log(`fileMinAgeDays=${fileMinAgeDays}`);
  log(`trackingStartedAt=${trackingStartedAt.toISOString()}`);
  log(`trackingAgeDays=${trackingAgeDays.toFixed(2)}`);
  log(`trackingWindowReady=${trackingWindowReady}`);
  log(`lastAccessedAt=${safetyReport.lastAccessedAt ?? "none"}`);
  log(`earliestSafeCleanupAt=${safetyReport.earliestSafeCleanupAt}`);
  log(`recentAccess1h=${accessSummary.recent1h}`);
  log(`recentAccess4h=${accessSummary.recent4h}`);
  log(`recentAccess24h=${accessSummary.recent24h}`);
  log(`recentAccessQuietWindow=${accessSummary.recentQuietWindow}`);
  log(`recentAccessQuiet=${safetyReport.recentAccessQuiet}`);
  log(`canConsiderCleanup=${safetyReport.canConsiderCleanup}`);
  log(`statusOnly=${statusOnly}`);
  log(`dryRun=${dryRun}`);
  log(`deleteEnabled=${deleteEnabled}`);
  log(`deleteRequested=${deleteRequested}`);
  log(`effectiveDelete=${effectiveDelete}`);
  log(`blockedReasons=${safetyReport.blockedReasons.length > 0 ? safetyReport.blockedReasons.join(",") : "none"}`);
  log(`auditYoungFiles=${auditYoungFiles}`);
  log(`verifyBucket=${verifyBucket}`);
  log(`verifySize=${verifySize}`);
  log(`verifyMode=${verifyMode}`);
  log(`storageMaxAttempts=${storageMaxAttempts}`);
  log(`progressEvery=${progressEvery || "off"}`);
  log(`limit=${limit || "unlimited"}`);
  log(`concurrency=${concurrency}`);

  if (verifyBucket) {
    await verifyStorageBucket();
  }

  const jobs = await collectLocalFiles(localRoot);
  log(`collected=${jobs.length}`);
  const objectInventory = verifyMode === "list" ? await loadObjectInventory(jobs) : null;

  await runPool(jobs, concurrency, async (job) => {
    await processJob(job, safetyReport, objectInventory);
  });

  printSummary(safetyReport);

  if (!trackingWindowReady) {
    log(`Safety hold: access tracking has not covered ${minAgeDays} full days yet.`);
  }
  if (!safetyReport.recentAccessQuiet) {
    log(`Safety hold: local upload origin was accessed within the last ${minAgeDays} days.`);
  }
  if (!effectiveDelete) {
    log("Dry run only. To delete, set CLEANUP_LOCAL_UPLOADS_DRY_RUN=false and CLEANUP_LOCAL_UPLOADS_DELETE=true.");
  }
} finally {
  await pool.end();
}

if (stats.failed > 0) {
  process.exit(1);
}

async function collectLocalFiles(root: string) {
  const rootReal = await fs.realpath(root);
  const jobs: LocalFileJob[] = [];
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
      const stat = await fs.stat(fullPath);
      jobs.push({
        objectKey,
        localPath: fullPath,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  }
}

async function processJob(job: LocalFileJob, safetyReport: SafetyReport, objectInventory: ObjectInventory | null) {
  try {
    const youngFile = job.mtimeMs > fileCutoffMs;
    if (youngFile) {
      stats.skippedYoungFile += 1;
      if (!auditYoungFiles) {
        return;
      }
    }

    const objectHead = objectInventory ? inventoryHeadObject(objectInventory, job.objectKey) : await headObject(job.objectKey);
    if (!objectHead.exists) {
      stats.ossMissing += 1;
      if (!quiet) {
        console.warn(`OSS missing, keep local: ${job.objectKey}`);
      }
      return;
    }
    stats.ossExists += 1;

    if (verifySize && typeof objectHead.sizeBytes === "number" && objectHead.sizeBytes !== job.sizeBytes) {
      stats.ossSizeMismatch += 1;
      if (!quiet) {
        console.warn(`OSS size mismatch, keep local: ${job.objectKey} local=${job.sizeBytes} oss=${objectHead.sizeBytes}`);
      }
      return;
    }

    if (youngFile) {
      return;
    }

    if (!safetyReport.trackingWindowReady) {
      stats.trackingWindowNotReady += 1;
      return;
    }

    if (!safetyReport.recentAccessQuiet) {
      stats.safetyHold += 1;
      return;
    }

    const recentAccess = await loadRecentAccess(job.objectKey);
    if (recentAccess && recentAccess.last_accessed_at.getTime() >= accessCutoffMs) {
      stats.recentAccess += 1;
      return;
    }

    stats.candidates += 1;
    stats.candidateBytes += job.sizeBytes;

    if (!effectiveDelete) {
      return;
    }

    await safeUnlink(job.localPath);
    await removeEmptyParents(path.dirname(job.localPath), localRoot);
    stats.deleted += 1;
    stats.deletedBytes += job.sizeBytes;
  } catch (error) {
    stats.failed += 1;
    console.error(`Failed: ${job.objectKey}`, error instanceof Error ? error.message : String(error));
  } finally {
    stats.processed += 1;
    if (!quiet && progressEvery > 0 && stats.processed % progressEvery === 0) {
      log(`progress processed=${stats.processed}, exists=${stats.ossExists}, missing=${stats.ossMissing}, recentAccess=${stats.recentAccess}, candidates=${stats.candidates}, failed=${stats.failed}`);
    }
  }
}

async function verifyStorageBucket() {
  try {
    await s3.send(new HeadBucketCommand({
      Bucket: config.STORAGE_BUCKET,
    }));
  } catch (error) {
    if (isBucketMissingError(error)) {
      throw new Error(`OSS bucket does not exist or endpoint is wrong: ${config.STORAGE_BUCKET}`);
    }
    if (isAccessDeniedError(error)) {
      log("OSS bucket head returned access denied; continue with per-object HeadObject checks.");
      return;
    }
    throw new Error(`OSS bucket verification failed: ${storageErrorText(error)}`);
  }
}

async function headObject(objectKey: string): Promise<ObjectHeadResult> {
  try {
    const response = await s3.send(new HeadObjectCommand({
      Bucket: config.STORAGE_BUCKET,
      Key: objectKey,
    }));
    return {
      exists: true,
      sizeBytes: response.ContentLength,
    };
  } catch (error) {
    if (isObjectMissingError(error)) {
      return { exists: false };
    }
    stats.ossHeadErrors += 1;
    throw new Error(`OSS HeadObject failed for ${objectKey}: ${storageErrorText(error)}`);
  }
}

function inventoryHeadObject(inventory: ObjectInventory, objectKey: string): ObjectHeadResult {
  if (!inventory.has(objectKey)) {
    return { exists: false };
  }
  return {
    exists: true,
    sizeBytes: inventory.get(objectKey),
  };
}

async function loadObjectInventory(jobs: LocalFileJob[]): Promise<ObjectInventory> {
  const inventory: ObjectInventory = new Map();
  const prefixes = objectListPrefixesForJobs(jobs);
  log(`inventoryPrefixes=${prefixes.map((prefix) => prefix || "<bucket>").join(",")}`);

  for (const prefix of prefixes) {
    let continuationToken: string | undefined;
    do {
      const response = await s3.send(new ListObjectsV2Command({
        Bucket: config.STORAGE_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));
      for (const object of response.Contents ?? []) {
        if (object.Key) {
          inventory.set(object.Key, object.Size);
        }
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  log(`inventoryObjects=${inventory.size}`);
  return inventory;
}

function objectListPrefixesForJobs(jobs: LocalFileJob[]) {
  const prefixes = new Set<string>();
  for (const job of jobs) {
    const slashIndex = job.objectKey.indexOf("/");
    prefixes.add(slashIndex >= 0 ? `${job.objectKey.slice(0, slashIndex)}/` : "");
  }
  return [...prefixes].sort();
}

async function loadRecentAccess(objectKey: string) {
  const result = await pool.query<AccessRow>(
    `
    SELECT last_accessed_at, access_count, last_source
    FROM local_upload_access_log
    WHERE object_key = $1
    `,
    [objectKey],
  );
  return result.rows[0] ?? null;
}

async function loadTrackingStartedAt() {
  const result = await pool.query<{ state_value: string }>(
    `
    SELECT state_value
    FROM local_upload_access_state
    WHERE state_key = 'access_tracking_started_at'
    `,
  );
  const value = result.rows[0]?.state_value;
  if (!value) {
    return new Date();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }
  return parsed;
}

async function loadAccessSummary(): Promise<AccessSummary> {
  const result = await pool.query<{
    total_tracked_objects: string;
    last_accessed_at: Date | null;
    recent_1h: string;
    recent_4h: string;
    recent_24h: string;
    recent_quiet_window: string;
  }>(
    `
    SELECT
      COUNT(*)::text AS total_tracked_objects,
      MAX(last_accessed_at) AS last_accessed_at,
      COUNT(*) FILTER (WHERE last_accessed_at >= $1)::text AS recent_1h,
      COUNT(*) FILTER (WHERE last_accessed_at >= $2)::text AS recent_4h,
      COUNT(*) FILTER (WHERE last_accessed_at >= $3)::text AS recent_24h,
      COUNT(*) FILTER (WHERE last_accessed_at >= $4)::text AS recent_quiet_window
    FROM local_upload_access_log
    `,
    [
      new Date(now - 60 * 60 * 1000),
      new Date(now - 4 * 60 * 60 * 1000),
      new Date(now - 24 * 60 * 60 * 1000),
      new Date(accessCutoffMs),
    ],
  );
  const row = result.rows[0];
  return {
    totalTrackedObjects: numberFromPg(row?.total_tracked_objects),
    lastAccessedAt: row?.last_accessed_at ?? null,
    recent1h: numberFromPg(row?.recent_1h),
    recent4h: numberFromPg(row?.recent_4h),
    recent24h: numberFromPg(row?.recent_24h),
    recentQuietWindow: numberFromPg(row?.recent_quiet_window),
  };
}

function buildSafetyReport(input: {
  accessSummary: AccessSummary;
  trackingAgeDays: number;
  trackingStartedAt: Date;
  trackingWindowReady: boolean;
}): SafetyReport {
  const recentAccessQuiet = input.accessSummary.recentQuietWindow === 0;
  const canConsiderCleanup = input.trackingWindowReady && recentAccessQuiet;
  const effectiveDeleteForReport = deleteRequested && canConsiderCleanup;
  const blockedReasons: string[] = [];

  if (!input.trackingWindowReady) {
    blockedReasons.push("tracking_window_not_ready");
  }
  if (!recentAccessQuiet) {
    blockedReasons.push("recent_origin_access");
  }
  if (statusOnly) {
    blockedReasons.push("status_only");
  }
  if (dryRun) {
    blockedReasons.push("dry_run_only");
  }
  if (!deleteEnabled) {
    blockedReasons.push("delete_not_enabled");
  }

  return {
    trackingStartedAt: input.trackingStartedAt.toISOString(),
    trackingAgeDays: Number(input.trackingAgeDays.toFixed(2)),
    minAccessQuietDays: minAgeDays,
    fileMinAgeDays,
    totalTrackedObjects: input.accessSummary.totalTrackedObjects,
    lastAccessedAt: input.accessSummary.lastAccessedAt?.toISOString() ?? null,
    earliestSafeCleanupAt: latestDate([
      addDays(input.trackingStartedAt, minAgeDays),
      input.accessSummary.lastAccessedAt ? addDays(input.accessSummary.lastAccessedAt, minAgeDays) : null,
    ]).toISOString(),
    recentAccess: {
      "1h": input.accessSummary.recent1h,
      "4h": input.accessSummary.recent4h,
      "24h": input.accessSummary.recent24h,
      quietWindowDays: minAgeDays,
      quietWindow: input.accessSummary.recentQuietWindow,
    },
    trackingWindowReady: input.trackingWindowReady,
    recentAccessQuiet,
    canConsiderCleanup,
    statusOnly,
    dryRun,
    deleteEnabled,
    deleteRequested,
    effectiveDelete: effectiveDeleteForReport,
    blockedReasons,
  };
}

async function safeUnlink(filePath: string) {
  const resolved = path.resolve(filePath);
  const root = path.resolve(localRoot);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Refusing to delete outside root: ${resolved}`);
  }
  await fs.unlink(resolved);
}

async function removeEmptyParents(dir: string, root: string) {
  const resolvedRoot = path.resolve(root);
  let current = path.resolve(dir);
  while (current !== resolvedRoot && current.startsWith(`${resolvedRoot}${path.sep}`)) {
    try {
      await fs.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
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

function hasFlag(flag: string) {
  return process.argv.slice(2).includes(flag);
}

function numberFromPg(value: string | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function addDays(value: Date, days: number) {
  return new Date(value.getTime() + days * 86_400_000);
}

function latestDate(values: Array<Date | null>) {
  return values.reduce<Date>((latest, value) => {
    if (!value) {
      return latest;
    }
    return value.getTime() > latest.getTime() ? value : latest;
  }, new Date(0));
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

function resolveVerifyMode(): "head" | "list" {
  const value = (process.env.CLEANUP_LOCAL_UPLOADS_VERIFY_MODE || "").trim().toLowerCase();
  if (value === "head" || value === "list") {
    return value;
  }
  return statusOnly ? "list" : "head";
}

function isObjectMissingError(error: unknown) {
  const code = storageErrorCode(error);
  const status = storageHttpStatus(error);
  if (isBucketMissingError(error)) {
    return false;
  }
  return status === 404 || ["NotFound", "NoSuchKey", "NoSuchObject"].includes(code);
}

function isBucketMissingError(error: unknown) {
  const code = storageErrorCode(error);
  return ["NoSuchBucket", "NoSuchBucketError"].includes(code);
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

function printSummary(safetyReport: SafetyReport) {
  console.log(JSON.stringify({
    safety: safetyReport,
    ...stats,
    candidateSize: formatBytes(stats.candidateBytes),
    deletedSize: formatBytes(stats.deletedBytes),
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
