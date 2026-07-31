import { AppError } from "./errors.js";
import { fetchAiUpstream } from "./ai-http.js";

export type AiModelKind = "image" | "text";

export interface AiModelDiscoveryInput {
  provider: string;
  baseUrl: string;
  apiKey: string;
  kind: AiModelKind;
}

export async function discoverAiModels(input: AiModelDiscoveryInput): Promise<string[]> {
  const provider = input.provider.trim().toLowerCase();
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new AppError(400, "AI_BASE_URL_MISSING", "请先填写 AI 接口地址。");
  }
  const url = provider === "ollama" && !baseUrl.endsWith("/v1")
    ? joinUrl(baseUrl, "api/tags")
    : joinUrl(baseUrl, "models");
  const headers: Record<string, string> = {};
  if (input.apiKey.trim()) {
    headers.Authorization = `Bearer ${input.apiKey.trim()}`;
  }
  const response = await fetchAiUpstream(url, { method: "GET", headers }, { label: input.kind === "image" ? "图片" : "文案", timeoutMs: 20_000 });
  const text = await response.text();
  if (!response.ok) {
    throw new AppError(response.status, "AI_MODELS_FAILED", `模型列表接口 HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AppError(502, "AI_MODELS_INVALID_JSON", "模型列表接口返回的不是合法 JSON。");
  }
  const models = parseModelsResponse(data);
  if (models.length === 0) {
    throw new AppError(502, "AI_MODELS_EMPTY", "模型列表为空或格式不支持。");
  }
  return prioritizeModels(models, input.kind);
}

function parseModelsResponse(data: unknown) {
  const models: string[] = [];
  if (!isRecord(data)) {
    return models;
  }
  const dataItems = Array.isArray(data.data) ? data.data : undefined;
  const modelItems = Array.isArray(data.models) ? data.models : undefined;
  for (const item of dataItems ?? modelItems ?? []) {
    const id = typeof item === "string"
      ? item.trim()
      : isRecord(item)
        ? String(item.id ?? item.name ?? "").trim()
        : "";
    if (id) {
      models.push(id);
    }
  }
  return Array.from(new Set(models)).sort((left, right) => left.localeCompare(right));
}

function prioritizeModels(models: string[], kind: AiModelKind) {
  const imageHints = /image|img|vision|gpt-image|dall|flux|sd|stable/i;
  const textUnsuitable = /embedding|rerank|tts|whisper|audio|image|img|dall|flux|sd|stable/i;
  return [...models].sort((left, right) => {
    const leftScore = modelScore(left, kind, imageHints, textUnsuitable);
    const rightScore = modelScore(right, kind, imageHints, textUnsuitable);
    return rightScore - leftScore || left.localeCompare(right);
  });
}

function modelScore(model: string, kind: AiModelKind, imageHints: RegExp, textUnsuitable: RegExp) {
  if (kind === "image") {
    return imageHints.test(model) ? 2 : 0;
  }
  if (textUnsuitable.test(model)) {
    return -2;
  }
  return /gpt|qwen|deepseek|claude|gemini|llama|chat/i.test(model) ? 2 : 0;
}

function joinUrl(baseUrl: string, path: string) {
  const cleanPath = path.trim().replace(/^\/+/, "");
  if (cleanPath.includes("..")) {
    throw new AppError(400, "AI_MODELS_PATH_INVALID", "模型列表路径不合法。");
  }
  return `${baseUrl}/${cleanPath}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
