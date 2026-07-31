import assert from "node:assert/strict";
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

type HttpMethod = "GET" | "POST" | "HEAD";

interface StepResult {
  name: string;
  method: HttpMethod;
  path: string;
  status: number;
  durationMs: number;
  ok: boolean;
  note?: string;
}

const baseUrl = (process.env.PERF_BASE_URL || process.env.PUBLIC_API_BASE_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const adminToken = process.env.ADMIN_TOKEN || "";
const thresholdMs = Number(process.env.PERF_THRESHOLD_MS || 5000);
const suffix = Date.now().toString(36);
const phone = `perf${suffix}`;
const password = `Pass_${suffix}`;
const deviceFingerprint = `perf-device-${suffix}`;

const results: StepResult[] = [];
let userToken = "";
let licenseKey = "";
let shopExternalId = `perf-shop-${suffix}`;
let firstAssetId = "";
let firstAssetUrl = "";

await run("健康检查", "GET", "/health");
await run("首页 HTML", "GET", "/");
await run("用户工作台 HTML", "GET", "/app/");
await run("管理后台 HTML", "GET", "/admin");

if (adminToken) {
  await run("管理端概览", "GET", "/admin/overview", { headers: adminHeaders() });
  await run("管理端用户列表", "GET", "/admin/users?limit=20&offset=0&membership=all", { headers: adminHeaders() });
  await run("管理端授权码列表", "GET", "/admin/license-keys?limit=20&offset=0&status=all&plan=all", { headers: adminHeaders() });
  await run("管理端图库列表", "GET", "/admin/gallery-assets?limit=20&offset=0&ratioFamily=all", { headers: adminHeaders() });
  const keyData = await runJson("生成性能测试授权码", "POST", "/admin/license-keys", {
    headers: adminHeaders(),
    body: JSON.stringify({ plan: "monthly", count: 1 }),
  });
  licenseKey = keyData?.keys?.[0]?.key || "";
} else {
  console.warn("未提供 ADMIN_TOKEN，跳过管理端和完整会员流程。");
}

if (licenseKey) {
  const registerData = await runJson("注册并登录测试账号", "POST", "/auth/register", {
    body: JSON.stringify({
      phone,
      password,
      licenseKey,
      deviceFingerprint,
      deviceName: "性能巡检脚本",
    }),
  });
  userToken = registerData?.token || "";
  assert.ok(userToken, "注册接口未返回 token");

  await run("登录测试账号", "POST", "/auth/login", {
    body: JSON.stringify({ phone, password, deviceFingerprint, deviceName: "性能巡检脚本" }),
  });
  await run("当前用户信息", "GET", "/me", { headers: authHeaders() });
  await run("AI 设置读取", "GET", "/ai/settings", { headers: authHeaders() });
  await run("店铺列表", "GET", "/shops", { headers: authHeaders() });
  await run("店铺同步", "POST", "/shops/upsert", {
    headers: authHeaders(),
    body: JSON.stringify({
      externalShopId: shopExternalId,
      name: "性能巡检测试店铺",
      ozonClientId: "perf-client",
    }),
  });
  await runUpload();
  await run("图库列表 20", "GET", "/gallery/assets?hideUsed=true&limit=20&offset=0", { headers: authHeaders() });
  const assetsData = await runJson("图库列表 100", "GET", "/gallery/assets?hideUsed=false&limit=100&offset=0", { headers: authHeaders() });
  firstAssetId = assetsData?.assets?.[0]?.id || "";
  firstAssetUrl = assetsData?.assets?.[0]?.thumbUrl || assetsData?.assets?.[0]?.publicUrl || "";
  if (firstAssetId) {
    await run("标记图库使用", "POST", `/gallery/assets/${encodeURIComponent(firstAssetId)}/use-by-external-shop`, {
      headers: authHeaders(),
      body: JSON.stringify({ externalShopId: shopExternalId, usageType: "perf-scan" }),
    });
  }
  await run("同步精品图库出单信号", "POST", "/gallery/sales-signals/sync", {
    headers: authHeaders(),
    body: JSON.stringify({
      signals: [{
        externalShopId: shopExternalId,
        sku: `perf-${suffix}`,
        orderCount: 2,
        quantity: 2,
        lastOrderedAt: new Date().toISOString(),
        source: "perf-scan",
      }],
    }),
  });
  await run("精品图库列表", "GET", "/gallery/featured-assets?limit=20&offset=0", { headers: authHeaders() });
  await run("退出登录", "POST", "/auth/logout", { headers: authHeaders() });
}

if (firstAssetUrl) {
  const assetPath = firstAssetUrl.startsWith(baseUrl) ? firstAssetUrl.slice(baseUrl.length) : firstAssetUrl;
  if (assetPath.startsWith("/")) {
    await run("图库首图 HEAD", "HEAD", assetPath);
  }
}

await writeReport();

const slow = results.filter((item) => item.durationMs > thresholdMs);
const failed = results.filter((item) => !item.ok);
console.table(results.map((item) => ({
  name: item.name,
  method: item.method,
  status: item.status,
  ms: Math.round(item.durationMs),
  ok: item.ok,
})));

if (slow.length) {
  console.error(`发现 ${slow.length} 个接口超过 ${thresholdMs}ms：${slow.map((item) => `${item.name} ${Math.round(item.durationMs)}ms`).join("；")}`);
}
if (failed.length) {
  console.error(`发现 ${failed.length} 个接口失败：${failed.map((item) => `${item.name} HTTP ${item.status}`).join("；")}`);
}
if (slow.length || failed.length) {
  process.exitCode = 1;
}

async function runJson(name: string, method: HttpMethod, requestPath: string, options: RequestInit = {}) {
  const response = await timedFetch(name, method, requestPath, options);
  if (!response) return null;
  return response.json().catch(() => ({}));
}

async function run(name: string, method: HttpMethod, requestPath: string, options: RequestInit = {}) {
  const response = await timedFetch(name, method, requestPath, options);
  if (!response) return;
  if (method !== "HEAD") {
    await response.text().catch(() => "");
  }
}

async function timedFetch(name: string, method: HttpMethod, requestPath: string, options: RequestInit = {}) {
  const started = performance.now();
  let response: Response | null = null;
  let errorMessage = "";
  try {
    const headers: Record<string, string> = { ...(options.headers as Record<string, string> | undefined) };
    if (options.body) {
      headers["Content-Type"] = "application/json";
    }
    response = await fetch(`${baseUrl}${requestPath}`, {
      ...options,
      method,
      headers,
    });
    return response;
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    return null;
  } finally {
    const durationMs = performance.now() - started;
    results.push({
      name,
      method,
      path: requestPath.replace(/([?&](?:token|licenseKey|password)=)[^&]+/gi, "$1***"),
      status: response?.status ?? 0,
      durationMs,
      ok: Boolean(response?.ok),
      note: errorMessage || undefined,
    });
  }
}

async function runUpload() {
  if (!userToken) return;
  const form = new FormData();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/luzk7wAAAABJRU5ErkJggg==",
    "base64",
  );
  form.append("files", new Blob([new Uint8Array(png)], { type: "image/png" }), `perf-${suffix}.png`);
  const started = performance.now();
  let response: Response | null = null;
  try {
    response = await fetch(`${baseUrl}/gallery/assets/batch-upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}` },
      body: form,
    });
    await response.text().catch(() => "");
  } finally {
    results.push({
      name: "图库批量上传 1 张小图",
      method: "POST",
      path: "/gallery/assets/batch-upload",
      status: response?.status ?? 0,
      durationMs: performance.now() - started,
      ok: Boolean(response?.ok),
    });
  }
}

function adminHeaders() {
  return { "x-admin-token": adminToken };
}

function authHeaders() {
  return { Authorization: `Bearer ${userToken}` };
}

async function writeReport() {
  const reportDir = path.resolve("reports");
  await fs.mkdir(reportDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportDir, `perf-scan-${timestamp}.json`);
  await fs.writeFile(reportPath, JSON.stringify({
    baseUrl,
    thresholdMs,
    createdAt: new Date().toISOString(),
    results,
    slow: results.filter((item) => item.durationMs > thresholdMs),
    failed: results.filter((item) => !item.ok),
  }, null, 2));
  console.log(`性能巡检报告已保存：${reportPath}`);
}
