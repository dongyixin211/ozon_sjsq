// @ts-nocheck
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import Fastify from "fastify";
import fs from "node:fs/promises";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { requestPerformanceStorage } from "./db.js";
import { sendError } from "./errors.js";
import {
  objectKeyFromUploadsRequestUrl,
  recordLocalUploadAccess,
} from "./local-upload-access.js";
import { getMockupTemplateRoot } from "./mockup-template-service.js";
import { adminRoutes } from "./routes/admin-routes.js";
import { aiRoutes } from "./routes/ai-routes.js";
import { authRoutes } from "./routes/auth-routes.js";
import { galleryRoutes } from "./routes/gallery-routes.js";
import { mockupRoutes } from "./routes/mockup-routes.js";
import { orderRoutes } from "./routes/order-routes.js";
import { productCatalogRoutes } from "./routes/product-catalog-routes.js";
import { shopRoutes } from "./routes/shop-routes.js";
import { taskRoutes } from "./routes/task-routes.js";
const app = Fastify({
  logger: true,
});
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();
const requestPerformance = new WeakMap();
app.addHook("onRequest", async (request) => {
  const metrics = { dbMs: 0, dbQueries: 0 };
  requestPerformance.set(request, { startedAt: performance.now(), metrics });
  requestPerformanceStorage.enterWith(metrics);
});
app.addHook("onResponse", async (request, reply) => {
  const state = requestPerformance.get(request);
  if (!state) return;
  const durationMs = performance.now() - state.startedAt;
  if (durationMs < 500) return;
  const requestSize =
    JSON.stringify({
      query: request.query,
      params: request.params,
      body: request.body,
    })?.length ?? 0;
  request.log.warn(
    {
      route: request.routeOptions.url,
      method: request.method,
      statusCode: reply.statusCode,
      durationMs: Math.round(durationMs),
      requestSize,
      dbMs: Math.round(state.metrics.dbMs),
      dbQueries: state.metrics.dbQueries,
      heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      eventLoopP95Ms: Math.round(eventLoopDelay.percentile(95) / 1e6),
    },
    "slow request",
  );
});
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.setErrorHandler((error, _request, reply) => {
  if (
    error instanceof Error &&
    error.message.toLowerCase().includes("request file too large")
  ) {
    return reply.status(413).send({
      ok: false,
      code: "UPLOAD_TOO_LARGE",
      message: `图片文件过大，请上传不超过 ${config.MAX_UPLOAD_MB} MB 的图片`,
    });
  }
  if (isValidationError(error)) {
    const details = formatValidationIssues(error.issues);
    return reply.status(400).send({
      ok: false,
      code: "VALIDATION_ERROR",
      message: details ? `请求参数不正确：${details}` : "请求参数不正确",
      issues: error.issues,
    });
  }
  return sendError(reply, error);
});
function isValidationError(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    "issues" in error &&
    Array.isArray(error.issues)
  );
}
function formatValidationIssues(issues) {
  const details = issues.slice(0, 3).map(formatValidationIssue).filter(Boolean);
  const more =
    issues.length > details.length
      ? `；还有 ${issues.length - details.length} 个参数问题`
      : "";
  return `${details.join("；")}${more}`;
}
function formatValidationIssue(issue) {
  const field = validationFieldLabel(issue.path ?? []);
  const reason = validationIssueReason(issue);
  return `${field}${reason}`;
}
function validationIssueReason(issue) {
  if (issue.code === "invalid_string" && issue.validation === "uuid") {
    return "格式不正确，需要是系统生成的 ID";
  }
  if (issue.code === "invalid_string" && issue.validation === "regex") {
    return "格式不正确";
  }
  if (issue.code === "too_small") {
    return issue.minimum && issue.minimum > 1
      ? `至少需要 ${issue.minimum} 项`
      : "不能为空";
  }
  if (issue.code === "too_big") {
    return issue.maximum
      ? `不能超过 ${issue.maximum} 个字符或项目`
      : "超过允许长度";
  }
  if (issue.code === "invalid_enum_value") {
    return "不是可选值";
  }
  if (issue.code === "invalid_type") {
    return "类型不正确";
  }
  return issue.message ? `：${issue.message}` : "不正确";
}
function validationFieldLabel(path) {
  const text = formatIssuePath(path);
  const keys = path.filter((item) => typeof item === "string");
  const last = keys[keys.length - 1] ?? text;
  const parent = keys[0] ?? "";
  const common = {
    ratioFamily: "图片比例",
    mockupTemplateId: "样机 ID",
    mockupTemplateName: "样机名称",
    titlePromptTemplateId: "标题提示词模板 ID",
    titlePromptTemplateName: "标题提示词模板名称",
    titlePrompt: "标题提示词",
    shopTargets: "上架店铺",
    assets: "上架图片",
  };
  const shop = {
    externalShopId: "店铺 ID",
    id: "商品模板 ID",
    name: "商品模板名称",
    externalTemplateId: "外部商品模板 ID",
    categoryLabel: "类目说明",
  };
  const asset = {
    sourceAssetId: "原图 ID",
    externalShopId: "图片分配店铺",
    imageAssetIds: "套图 ID",
    title: "商品标题",
  };
  const label =
    parent === "shopTargets"
      ? shop[last]
      : parent === "assets"
        ? asset[last]
        : common[last];
  return text ? `${label ?? text}(${text})` : (label ?? "请求参数");
}
function formatIssuePath(path) {
  return path.reduce((text, item) => {
    if (typeof item === "number") {
      return `${text}[${item + 1}]`;
    }
    return text ? `${text}.${item}` : item;
  }, "");
}
await app.register(cors, {
  origin: resolveCorsOrigin(),
});
await app.register(multipart, {
  limits: {
    fileSize:
      Math.max(config.MAX_UPLOAD_MB, config.MAX_PSD_UPLOAD_MB) * 1024 * 1024,
    files: 100,
  },
});
app.addHook("onResponse", async (request, reply) => {
  if (
    reply.statusCode >= 400 ||
    (request.method !== "GET" && request.method !== "HEAD")
  ) {
    return;
  }
  const objectKey = objectKeyFromUploadsRequestUrl(request.url);
  if (!objectKey) {
    return;
  }
  void recordLocalUploadAccess({
    objectKey,
    source: "static_uploads",
  });
});
const localUploadsRoot = path.resolve(config.STORAGE_LOCAL_DIR);
if (await pathExists(localUploadsRoot)) {
  await app.register(staticFiles, {
    root: localUploadsRoot,
    prefix: "/uploads/",
    maxAge: "365 days",
    immutable: true,
  });
}
const webAppRoot = path.join(__dirname, "public/app");
const hasWebApp = await pathExists(webAppRoot);
if (hasWebApp) {
  await app.register(staticFiles, {
    root: webAppRoot,
    prefix: "/app/",
    decorateReply: false,
    maxAge: "365 days",
    immutable: true,
    setHeaders: (res) => {
      if (res.filename.endsWith("index.html")) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      }
    },
  });
}
const configuredMockupTemplatesRoot = getMockupTemplateRoot();
await fs.mkdir(configuredMockupTemplatesRoot, { recursive: true });
if (await pathExists(configuredMockupTemplatesRoot)) {
  await app.register(staticFiles, {
    root: configuredMockupTemplatesRoot,
    prefix: "/mockup-template-assets/",
    decorateReply: false,
    maxAge: "365 days",
    immutable: true,
  });
}
app.get("/health", async () => ({
  ok: true,
  service: "ozon-sjsq-cloud",
  time: new Date().toISOString(),
}));
app.get("/updates/latest.json", async (_request, reply) => {
  const latestPath = path.join(__dirname, "public/updates/latest.json");
  try {
    const raw = await fs.readFile(latestPath, "utf8");
    return reply
      .header("Cache-Control", "no-cache, no-store, must-revalidate")
      .type("application/json")
      .send(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return reply.status(204).send();
    }
    throw error;
  }
});
app.get("/", async (_request, reply) => {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ozon SJSQ 云服务</title>
  <style>
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #1f2937;
      background: #f6f7f9;
    }
    main {
      max-width: 760px;
      margin: 0 auto;
      padding: 72px 24px;
    }
    h1 {
      margin: 0 0 12px;
      font-size: 32px;
      line-height: 1.2;
    }
    p {
      margin: 0 0 24px;
      color: #4b5563;
      line-height: 1.7;
    }
    .panel {
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 24px;
      box-shadow: 0 10px 30px rgba(15, 23, 42, 0.06);
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-radius: 999px;
      background: #ecfdf5;
      color: #047857;
      font-size: 14px;
      margin-bottom: 20px;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #10b981;
    }
    a {
      display: inline-block;
      margin-right: 12px;
      color: #2563eb;
      text-decoration: none;
      font-weight: 600;
    }
    a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <main>
    <div class="panel">
      <div class="status"><span class="dot"></span>云服务运行正常</div>
      <h1>Ozon SJSQ 云服务</h1>
      <p>这里是软件的云端 API 地址。用户可进入网页版工作台完成登录、会员授权和云图库操作；客户端作为本地助手处理 Excel、图片目录和 Ozon 本地任务。</p>
      <a href="/app/">进入用户工作台</a>
      <a href="/admin">进入管理员后台</a>
      <a href="/health">查看健康检查</a>
    </div>
  </main>
</body>
</html>`;
  return reply.type("text/html; charset=utf-8").send(html);
});
app.get("/app", async (_request, reply) => reply.redirect("/app/"));
if (!hasWebApp) {
  app.get("/app/", async (_request, reply) => {
    const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>用户工作台未构建</title>
</head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f6f7f9;color:#1f2937;margin:0;">
  <main style="max-width:720px;margin:80px auto;padding:24px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;">
    <h1 style="margin-top:0;">用户工作台还没有构建</h1>
    <p style="line-height:1.7;color:#4b5563;">请先在项目根目录运行 <code>npm run build:web</code>，再构建并部署云后端。</p>
    <a href="/" style="color:#2563eb;font-weight:600;">返回云服务状态页</a>
  </main>
</body>
</html>`;
    return reply.type("text/html; charset=utf-8").send(html);
  });
}
app.get("/admin", async (_request, reply) => {
  const html = await fs.readFile(
    path.join(__dirname, "public/admin.html"),
    "utf8",
  );
  return reply.type("text/html; charset=utf-8").send(html);
});
app.get("/admin/ui/*", async (_request, reply) => {
  const html = await fs.readFile(
    path.join(__dirname, "public/admin.html"),
    "utf8",
  );
  return reply.type("text/html; charset=utf-8").send(html);
});
await app.register(authRoutes);
await app.register(adminRoutes);
await app.register(aiRoutes);
await app.register(shopRoutes);
await app.register(galleryRoutes);
await app.register(mockupRoutes);
await app.register(orderRoutes);
await app.register(productCatalogRoutes);
await app.register(taskRoutes);
await app.listen({
  host: "0.0.0.0",
  port: config.PORT,
});
async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
function resolveCorsOrigin() {
  const trustedClientOrigins = [
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
    "http://localhost:1420",
    "http://127.0.0.1:1420",
  ];
  const configured = config.CORS_ORIGINS.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (configured.includes("*")) {
    return true;
  }
  if (configured.length === 0 && config.NODE_ENV !== "production") {
    return true;
  }
  if (configured.length === 0) {
    return [
      new URL(config.PUBLIC_API_BASE_URL).origin,
      ...trustedClientOrigins,
    ];
  }
  return [...new Set([...configured, ...trustedClientOrigins])];
}
