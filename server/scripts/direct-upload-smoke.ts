import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import sharp from "sharp";

type ProductImageRule = {
  id: string;
  productType: string;
  aspectRatio: string;
  ratioWidth: number;
  ratioHeight: number;
  enabled: boolean;
};

type PreparedImage = {
  clientItemId: string;
  filename: string;
  contentType: "image/png";
  sizeBytes: number;
  sha256: string;
  width: number;
  height: number;
  sku: string;
  original: Buffer;
  thumbnail: Buffer;
};

type PrepareResult = {
  ok: boolean;
  items: Array<{
    clientItemId: string;
    originalUploadUrl: string;
    thumbnailUploadUrl: string;
  }>;
  skipped: Array<{ clientItemId: string; filename: string; sha256: string }>;
  errors: Array<{ clientItemId: string; filename: string; message: string }>;
};

type CompleteResult = {
  ok: boolean;
  uploaded: number;
  failed: number;
  assets: Array<{ id: string; sku: string; publicUrl: string; thumbUrl?: string }>;
  errors: Array<{ filename: string; message: string }>;
};

type Result = {
  sku: string;
  ok: boolean;
  durationMs: number;
  assetId?: string;
  error?: string;
};

const baseUrl = (process.env.DIRECT_UPLOAD_BASE_URL || process.env.PUBLIC_API_BASE_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const authToken = normalizeToken(process.env.DIRECT_UPLOAD_AUTH_TOKEN || process.env.LOAD_AUTH_TOKEN || "");
const requestedRuleId = process.env.DIRECT_UPLOAD_PRODUCT_IMAGE_RULE_ID || "";
const count = positiveInt(process.env.DIRECT_UPLOAD_COUNT, 1);
const concurrency = positiveInt(process.env.DIRECT_UPLOAD_CONCURRENCY, 2);
const keepReport = booleanEnv(process.env.DIRECT_UPLOAD_WRITE_REPORT, true);

if (!authToken) {
  console.error("DIRECT_UPLOAD_AUTH_TOKEN is required. Use a normal user token; do not include production admin tokens.");
  process.exit(1);
}

const rule = await resolveProductImageRule();
const imageSize = resolveImageSize(rule);
const results: Result[] = [];
let next = 0;

await Promise.all(Array.from({ length: Math.min(concurrency, count) }, async () => {
  while (next < count) {
    const index = next;
    next += 1;
    results.push(await runOne(index));
  }
}));

const failed = results.filter((item) => !item.ok);
const durations = results.map((item) => item.durationMs).sort((left, right) => left - right);
  const summary = {
  baseUrl,
  count,
  concurrency,
  productImageRuleId: rule.id,
  productType: rule.productType,
  aspectRatio: rule.aspectRatio,
  imageWidth: imageSize.width,
  imageHeight: imageSize.height,
  ok: results.length - failed.length,
  failed: failed.length,
  minMs: round(durations[0] ?? 0),
  p50Ms: percentile(durations, 0.5),
  p90Ms: percentile(durations, 0.9),
  p95Ms: percentile(durations, 0.95),
  maxMs: round(durations[durations.length - 1] ?? 0),
};

console.table(summary);
if (failed.length > 0) {
  console.table(failed.map((item) => ({ sku: item.sku, error: item.error })));
}
if (keepReport) {
  await writeReport(summary, results);
}
if (failed.length > 0) {
  process.exitCode = 1;
}

async function runOne(index: number): Promise<Result> {
  const started = performance.now();
  const sku = `direct-smoke-${Date.now().toString(36)}-${index + 1}`;
  try {
    const image = await buildImage(sku, index);
    const prepare = await postJson<PrepareResult>("/gallery/assets/direct-upload/prepare", {
      productImageRuleId: rule.id,
      items: [requestItem(image)],
    });
    if (!prepare.ok && prepare.items.length === 0 && prepare.skipped.length === 0) {
      throw new Error(prepare.errors.map((item) => `${item.filename}: ${item.message}`).join("; ") || "direct upload prepare failed");
    }
    const prepared = prepare.items.find((item) => item.clientItemId === image.clientItemId);
    if (prepared) {
      await putObject(prepared.originalUploadUrl, image.original, image.contentType);
      await putObject(prepared.thumbnailUploadUrl, image.thumbnail, "image/webp");
    }
    const complete = await postJson<CompleteResult>("/gallery/assets/direct-upload/complete", {
      productImageRuleId: rule.id,
      items: [requestItem(image)],
    });
    if (!complete.ok || complete.assets.length === 0) {
      throw new Error(complete.errors.map((item) => `${item.filename}: ${item.message}`).join("; ") || "direct upload complete failed");
    }
    return {
      sku,
      ok: true,
      durationMs: performance.now() - started,
      assetId: complete.assets[0]?.id,
    };
  } catch (error) {
    return {
      sku,
      ok: false,
      durationMs: performance.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function resolveProductImageRule() {
  const data = await getJson<{ ok: boolean; rules: ProductImageRule[] }>("/gallery/product-image-rules");
  const enabledRules = data.rules.filter((item) => item.enabled);
  const rule = requestedRuleId
    ? enabledRules.find((item) => item.id === requestedRuleId)
    : enabledRules.find((item) => item.aspectRatio === "3:4") ?? enabledRules[0];
  if (!rule) {
    throw new Error(requestedRuleId ? `Product image rule not found: ${requestedRuleId}` : "No enabled product image rule found");
  }
  return rule;
}

async function buildImage(sku: string, index: number): Promise<PreparedImage> {
  const svg = `
    <svg width="${imageSize.width}" height="${imageSize.height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#f8fafc"/>
      <rect x="48" y="48" width="${imageSize.width - 96}" height="${imageSize.height - 96}" rx="24" fill="#2563eb"/>
      <text x="50%" y="48%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="64" fill="white">OZON</text>
      <text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="32" fill="white">${sku}</text>
      <text x="50%" y="64%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="24" fill="white">smoke ${index + 1}</text>
    </svg>
  `;
  const original = await sharp(Buffer.from(svg)).png().toBuffer();
  const metadata = await sharp(original).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("Failed to read generated image metadata");
  }
  const thumbnail = await sharp(original)
    .resize({ width: 360, height: 360, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 74, effort: 4 })
    .toBuffer();
  return {
    clientItemId: crypto.randomUUID(),
    filename: `${sku}.png`,
    contentType: "image/png",
    sizeBytes: original.length,
    sha256: crypto.createHash("sha256").update(original).digest("hex"),
    width: metadata.width,
    height: metadata.height,
    sku,
    original,
    thumbnail,
  };
}

function requestItem(image: PreparedImage) {
  return {
    clientItemId: image.clientItemId,
    filename: image.filename,
    contentType: image.contentType,
    sizeBytes: image.sizeBytes,
    sha256: image.sha256,
    width: image.width,
    height: image.height,
    sku: image.sku,
  };
}

async function getJson<T>(requestPath: string): Promise<T> {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  return readJsonResponse<T>(response, requestPath);
}

async function postJson<T>(requestPath: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return readJsonResponse<T>(response, requestPath);
}

async function readJsonResponse<T>(response: Response, requestPath: string): Promise<T> {
  const text = await response.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  if (!response.ok) {
    const message = typeof data === "object" && data && "message" in data ? String((data as { message?: unknown }).message) : "";
    throw new Error(`${requestPath} failed: HTTP ${response.status}${message ? ` ${message}` : ""}`);
  }
  return data as T;
}

async function putObject(url: string, buffer: Buffer, contentType: string) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: new Blob([new Uint8Array(buffer)], { type: contentType }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`object storage PUT failed: HTTP ${response.status}${text ? ` ${text.slice(0, 200)}` : ""}`);
  }
}

async function writeReport(summary: object, details: Result[]) {
  const reportDir = path.resolve("reports");
  await fs.mkdir(reportDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportDir, `direct-upload-smoke-${timestamp}.json`);
  await fs.writeFile(reportPath, JSON.stringify({ createdAt: new Date().toISOString(), summary, results: details }, null, 2));
  console.log(`Report saved: ${reportPath}`);
}

function normalizeToken(value: string) {
  return value.trim().replace(/^Bearer\s+/i, "");
}

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanEnv(value: string | undefined, fallback: boolean) {
  if (!value) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function resolveImageSize(selectedRule: ProductImageRule) {
  const envWidth = optionalPositiveInt(process.env.DIRECT_UPLOAD_WIDTH);
  const envHeight = optionalPositiveInt(process.env.DIRECT_UPLOAD_HEIGHT);
  if (envWidth && envHeight) {
    return { width: envWidth, height: envHeight };
  }
  if (envWidth) {
    return { width: envWidth, height: Math.round((envWidth * selectedRule.ratioHeight) / selectedRule.ratioWidth) };
  }
  if (envHeight) {
    return { width: Math.round((envHeight * selectedRule.ratioWidth) / selectedRule.ratioHeight), height: envHeight };
  }
  const baseWidth = 900;
  return {
    width: baseWidth,
    height: Math.round((baseWidth * selectedRule.ratioHeight) / selectedRule.ratioWidth),
  };
}

function optionalPositiveInt(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function percentile(values: number[], value: number) {
  if (values.length === 0) {
    return 0;
  }
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * value) - 1));
  return round(values[index]);
}

function round(value: number) {
  return Math.round(value);
}
