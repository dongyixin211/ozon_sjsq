/**
 * core/shutdown/graceful.ts — 优雅关闭
 *
 * 监听 SIGTERM/SIGINT，drain 在途请求后关闭连接池和 Redis。
 */
import type { FastifyInstance } from "fastify";
import { pool } from "../database/pool.js";
import { logger } from "../logging/logger.js";

export function registerGracefulShutdown(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: FastifyInstance<any, any, any, any, any>,
  shutdownTimeoutMs = 10_000,
) {
  let shuttingDown = false;

  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.warn({ signal, timeoutMs: shutdownTimeoutMs }, "Graceful shutdown initiated");

    try {
      // 停止接收新请求，等待在途请求完成
      await app.close();
      logger.info("Fastify server closed");

      // 关闭数据库连接池
      await pool.end();
      logger.info("Database pool closed");

      // Phase 2: 关闭 Redis 连接
      // await redis.quit();

      logger.info("Graceful shutdown complete");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "Graceful shutdown error");
      process.exit(1);
    }
  }

  // 超时强制退出
  const forceExitTimer = setTimeout(() => {
    logger.error("Graceful shutdown timed out — force exit");
    process.exit(1);
  }, shutdownTimeoutMs + 2_000);
  forceExitTimer.unref();

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
