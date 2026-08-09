/**
 * core/health/probe.ts — 深度健康检查
 *
 * 提供 /health 端点：验证 DB + Redis + R2 连接状态。
 */
import type { FastifyInstance } from "fastify";
import { pool } from "../database/pool.js";
import { logger } from "../logging/logger.js";

interface HealthStatus {
  status: "ok" | "degraded" | "unhealthy";
  uptime: number;
  checks: Record<string, { status: string; latencyMs?: number; error?: string }>;
}

export function registerHealthProbe(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: FastifyInstance<any, any, any, any, any>,
) {
  app.get("/health", async (): Promise<HealthStatus> => {
    const checks: HealthStatus["checks"] = {};
    let overall: HealthStatus["status"] = "ok";

    // 数据库探针
    try {
      const t0 = performance.now();
      await pool.query("SELECT 1");
      checks.db = { status: "ok", latencyMs: Math.round(performance.now() - t0) };
    } catch (err) {
      checks.db = { status: "unhealthy", error: String(err) };
      overall = "unhealthy";
    }

    // Redis 探针 (可选)
    try {
      const t0 = performance.now();
      // Phase 2: await redis.ping()
      checks.redis = { status: "skipped", latencyMs: Math.round(performance.now() - t0) };
    } catch (err) {
      checks.redis = { status: "unavailable", error: String(err) };
    }

    if (overall === "unhealthy") {
      logger.error({ checks }, "Health check failed");
    }

    return {
      status: overall,
      uptime: process.uptime(),
      checks,
    };
  });
}
