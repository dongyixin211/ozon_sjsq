/**
 * server.ts — 启动入口
 *
 * 职责: 调用 buildApp() → listen → 注册优雅关闭。
 * 这是模块化架构的新入口。旧 index.ts 保持不变、两套并行。
 *
 * 启动方式: node --loader ts-node/esm server/src/server.ts
 */
import { buildApp } from "./app.js";
import { config } from "./core/config.js";
import { registerGracefulShutdown } from "./core/shutdown/graceful.js";
import { logger } from "./core/logging/logger.js";

async function main() {
  const app = await buildApp();

  // 注册优雅关闭
  registerGracefulShutdown(app, 15_000);

  // 启动监听
  try {
    await app.listen({ host: "0.0.0.0", port: config.PORT });
    logger.info(
      { port: config.PORT, env: config.NODE_ENV },
      "Server started — modular architecture",
    );
  } catch (err) {
    logger.error({ err }, "Failed to start server");
    process.exit(1);
  }
}

main();
