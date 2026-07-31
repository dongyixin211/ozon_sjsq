import { AppError } from "./errors.js";

const defaultAiTimeoutMs = 30_000;

export async function fetchAiUpstream(
  url: string,
  init: RequestInit,
  options: { label: string; timeoutMs?: number },
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? defaultAiTimeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    throw toAiConnectionError(error, options.label, url);
  } finally {
    clearTimeout(timeout);
  }
}

export function toAiConnectionError(error: unknown, label: string, url: string) {
  const host = readHost(url);
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && isRecord(error.cause)
    ? String(error.cause.code ?? error.cause.message ?? "")
    : "";
  const lower = `${message} ${cause}`.toLowerCase();
  if (lower.includes("abort") || lower.includes("timeout")) {
    return new AppError(504, "AI_UPSTREAM_TIMEOUT", `${label} AI 接口连接超时：${host}。请检查接口地址、供应商线路或稍后重试。`);
  }
  return new AppError(502, "AI_UPSTREAM_UNREACHABLE", `${label} AI 接口连接失败：${host}。请检查接口地址、供应商线路或网络连通性。`);
}

function readHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
