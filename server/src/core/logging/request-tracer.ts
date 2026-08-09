/**
 * core/logging/request-tracer.ts — 请求关联 ID
 *
 * 为每个请求生成唯一 traceId，通过响应头返回，便于前后端日志串联。
 */
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

export function registerRequestTracer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: FastifyInstance<any, any, any, any, any>,
) {
  app.addHook("onRequest", async (request, reply) => {
    const traceId = (request.headers["x-trace-id"] as string) || randomUUID();
    reply.header("x-trace-id", traceId);
    (request as any).traceId = traceId;
  });
}
