/**
 * infrastructure/http/client.ts — 带超时/重试的 HTTP 客户端
 *
 * Phase 2: 封装 fetch/undici，统一超时和错误处理。
 * Phase 1: 占位。
 */

export interface HttpClientOptions {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
}

/** Phase 2: 创建 HttpClient 实例 */
export function createHttpClient(baseUrl: string, _options?: HttpClientOptions) {
  // TODO: 封装 fetch 或 undici，加上超时和重试
  throw new Error("HTTP client not yet implemented — Phase 2");
}
