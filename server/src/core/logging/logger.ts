/**
 * core/logging/logger.ts — 结构化日志 (Pino)
 *
 * 所有模块使用此 logger，替代 console.log/error。
 * 支持 JSON 输出（生产环境）和 pretty 输出（开发环境）。
 */
import pino from "pino";
import { config } from "../config.js";

export const logger = pino({
  level: config.NODE_ENV === "production" ? "info" : "debug",
  transport:
    config.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } }
      : undefined,
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie", "password", "token", "secret"],
    censor: "[REDACTED]",
  },
  serializers: {
    req: (req) => ({
      method: req.method,
      url: req.url,
      remoteAddress: req.remoteAddress,
      userAgent: req.headers?.["user-agent"],
    }),
    res: (res) => ({ statusCode: res.statusCode }),
    err: pino.stdSerializers.err,
  },
});

/** 请求日志中间件 */
export { logger as default };
