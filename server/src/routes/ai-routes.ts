import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireMembership } from "../auth.js";
import { fetchAiUpstream } from "../ai-http.js";
import { readAiSettings, toPublicAiSettings } from "../ai-settings.js";
import { AppError } from "../errors.js";

const proxySchema = z.object({
  kind: z.enum(["image", "text"]),
  path: z.string().min(1).max(120),
  method: z.enum(["GET", "POST"]).default("POST"),
  body: z.unknown().optional(),
});

export async function aiRoutes(app: FastifyInstance) {
  app.get("/ai/settings", { preHandler: [requireAuth, requireMembership] }, async () => {
    const settings = await readAiSettings();
    return {
      ok: true,
      settings: toPublicAiSettings(settings),
    };
  });

  app.post("/ai/proxy", { preHandler: [requireAuth, requireMembership] }, async (request, reply) => {
    const body = proxySchema.parse(request.body);
    const settings = await readAiSettings();
    const target = body.kind === "image"
      ? {
          provider: settings.imageProvider,
          baseUrl: settings.imageBaseUrl,
          apiKey: settings.imageApiKey,
          label: "图片",
        }
      : {
          provider: settings.textProvider,
          baseUrl: settings.textBaseUrl,
          apiKey: settings.textApiKey,
          label: "文案",
        };

    if (!target.apiKey.trim() && !isLocalProvider(target.provider)) {
      throw new AppError(400, "AI_KEY_MISSING", `${target.label} AI Key 未配置，请先在管理端设置`);
    }

    const url = joinUrl(target.baseUrl, body.path);
    const headers: Record<string, string> = {};
    if (target.apiKey.trim()) {
      headers.Authorization = `Bearer ${target.apiKey.trim()}`;
    }
    const requestInit = buildUpstreamRequest(body.method, headers, body.path, body.body);

    const upstream = await fetchAiUpstream(url, {
      method: requestInit.method,
      headers: requestInit.headers,
      body: requestInit.body,
    }, { label: target.label, timeoutMs: 45_000 });
    const text = await upstream.text();
    const contentType = upstream.headers.get("content-type") || "application/json; charset=utf-8";
    return reply
      .status(upstream.status)
      .type(contentType)
      .send(text);
  });
}

function buildUpstreamRequest(
  method: "GET" | "POST",
  headers: Record<string, string>,
  path: string,
  body: unknown,
): { method: "GET" | "POST"; headers: Record<string, string>; body?: BodyInit } {
  if (method === "GET") {
    return { method, headers };
  }
  if (path.replace(/^\/+/, "") === "images/edits" && isRecord(body)) {
    const form = new FormData();
    for (const key of ["model", "prompt", "size"]) {
      const value = body[key];
      if (typeof value === "string") {
        form.append(key, value);
      }
    }
    const image = body.image;
    if (typeof image !== "string") {
      throw new AppError(400, "AI_IMAGE_REQUIRED", "图片编辑缺少参考图片");
    }
    const { bytes, mimeType } = parseDataUrl(image);
    form.append("image", new Blob([new Uint8Array(bytes)], { type: mimeType }), "reference.jpg");
    return { method, headers, body: form };
  }
  return {
    method,
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  };
}

function parseDataUrl(value: string) {
  const match = value.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) {
    throw new AppError(400, "AI_IMAGE_DATA_INVALID", "图片数据格式不正确");
  }
  return {
    mimeType: match[1],
    bytes: Buffer.from(match[2], "base64"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLocalProvider(provider: string) {
  return provider.trim().toLowerCase() === "ollama";
}

function joinUrl(baseUrl: string, path: string) {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const cleanPath = path.trim().replace(/^\/+/, "");
  if (cleanPath.includes("..")) {
    throw new AppError(400, "AI_PROXY_PATH_INVALID", "AI 代理路径不合法");
  }
  return `${base}/${cleanPath}`;
}
