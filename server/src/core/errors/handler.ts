/**
 * core/errors/handler.ts — Fastify 全局错误处理插件
 *
 * 统一格式化错误响应，区分：文件过大 / AppError / Zod 验证 / 数据库瞬态 / 未知错误。
 */
import type { FastifyInstance, FastifyError } from "fastify";
import { AppError, sendError } from "../../errors.js";

export interface ErrorHandlerOptions {
  /** 上传文件大小上限 (MB)，用于文件过大检测 */
  uploadSizeLimitMb?: number;
}

export function registerErrorHandler(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: FastifyInstance<any, any, any, any, any>,
  options: ErrorHandlerOptions = {},
) {
  const { uploadSizeLimitMb = 15 } = options;

  app.setErrorHandler((error, _request, reply) => {
    // 文件过大（Fastify multipart 限制）
    if (
      error instanceof Error &&
      error.message.toLowerCase().includes("request file too large")
    ) {
      return reply.status(413).send({
        ok: false,
        code: "UPLOAD_TOO_LARGE",
        message: `图片文件过大，请上传不超过 ${uploadSizeLimitMb} MB 的图片`,
      });
    }

    // 已经是 AppError 实例，直接格式化
    if (error instanceof AppError) {
      return sendError(reply, error);
    }

    // Fastify 验证错误 (Zod schema 失败)
    if (error.validation) {
      return reply.status(400).send({
        ok: false,
        code: "VALIDATION_ERROR",
        message: error.message,
        details: error.validation,
      });
    }

    // 其他错误走 sendError 的通用处理（含数据库瞬态检测）
    return sendError(reply, error);
  });
}
