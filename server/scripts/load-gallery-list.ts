import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

type Result = {
  status: number;
  durationMs: number;
  ok: boolean;
};

const baseUrl = (process.env.LOAD_BASE_URL || process.env.PUBLIC_API_BASE_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const token = process.env.LOAD_AUTH_TOKEN || "";
const concurrency = positiveInt(process.env.LOAD_CONCURRENCY, 20);
const requests = positiveInt(process.env.LOAD_REQUESTS, 200);
const limit = positiveInt(process.env.LOAD_GALLERY_LIMIT, 40);
const includeTotal = booleanEnv(process.env.LOAD_INCLUDE_TOTAL, false);
const pathName = process.env.LOAD_PATH || "/gallery/assets";

if (!token) {
  console.error("LOAD_AUTH_TOKEN is required. Use a normal user token; this script does not create data.");
  process.exit(1);
}

const results: Result[] = [];
let next = 0;

await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, async () => {
  while (next < requests) {
    const index = next;
    next += 1;
    results.push(await runOne(index));
  }
}));

results.sort((left, right) => left.durationMs - right.durationMs);
const failed = results.filter((item) => !item.ok);
const summary = {
  baseUrl,
  path: pathName,
  requests,
  concurrency,
  includeTotal,
  ok: results.length - failed.length,
  failed: failed.length,
  minMs: round(results[0]?.durationMs ?? 0),
  p50Ms: percentile(0.5),
  p90Ms: percentile(0.9),
  p95Ms: percentile(0.95),
  p99Ms: percentile(0.99),
  maxMs: round(results[results.length - 1]?.durationMs ?? 0),
  statusCounts: countStatuses(),
};

console.table(summary);
await writeReport(summary);

if (failed.length > 0) {
  process.exitCode = 1;
}

async function runOne(index: number): Promise<Result> {
  const offset = (index % 10) * limit;
  const query = new URLSearchParams({
    hideUsed: "false",
    limit: String(limit),
    offset: String(offset),
    includeTotal: String(includeTotal),
  });
  const started = performance.now();
  let status = 0;
  try {
    const response = await fetch(`${baseUrl}${pathName}?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    status = response.status;
    await response.arrayBuffer().catch(() => undefined);
    return { status, durationMs: performance.now() - started, ok: response.ok };
  } catch {
    return { status, durationMs: performance.now() - started, ok: false };
  }
}

function percentile(value: number) {
  if (results.length === 0) {
    return 0;
  }
  const index = Math.min(results.length - 1, Math.max(0, Math.ceil(results.length * value) - 1));
  return round(results[index].durationMs);
}

function countStatuses() {
  return results.reduce<Record<string, number>>((counts, item) => {
    const key = String(item.status);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

async function writeReport(summary: object) {
  const reportDir = path.resolve("reports");
  await fs.mkdir(reportDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportDir, `load-gallery-list-${timestamp}.json`);
  await fs.writeFile(reportPath, JSON.stringify({ createdAt: new Date().toISOString(), summary, results }, null, 2));
  console.log(`Report saved: ${reportPath}`);
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

function round(value: number) {
  return Math.round(value);
}
