import type { FastifyReply } from "fastify";

const TRANSIENT_DATABASE_CODES = new Set([
  "57P03",
  "08000",
  "08003",
  "08006",
  "53300",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
]);

const TRANSIENT_DATABASE_MESSAGES = [
  "the database system is not yet accepting connections",
  "the database system is starting up",
  "database system is shutting down",
  "connection terminated unexpectedly",
  "terminating connection",
  "connection timeout",
  "timeout expired",
  "connect econnrefused",
  "sorry, too many clients already",
  "remaining connection slots are reserved",
];

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({
      ok: false,
      code: error.code,
      message: error.message,
    });
  }

  if (isTransientDatabaseError(error)) {
    return reply.status(503).send({
      ok: false,
      code: "DATABASE_NOT_READY",
      message: "数据库正在启动或临时繁忙，请稍后刷新重试。",
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  return reply.status(500).send({
    ok: false,
    code: "INTERNAL_ERROR",
    message: isSafePublicMessage(message) ? message : "服务器开小差了，请稍后重试；如果反复出现，请联系管理员查看日志。",
  });
}

export function isTransientDatabaseError(error: unknown): boolean {
  return inspectErrorChain(error, (item) => {
    const code = getErrorText(item, "code");
    if (code && TRANSIENT_DATABASE_CODES.has(code.toUpperCase())) {
      return true;
    }
    const message = getErrorText(item, "message").toLowerCase();
    return TRANSIENT_DATABASE_MESSAGES.some((pattern) => message.includes(pattern));
  });
}

function inspectErrorChain(error: unknown, predicate: (item: unknown) => boolean) {
  const seen = new Set<unknown>();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (predicate(current)) {
      return true;
    }
    if (typeof current !== "object") {
      return false;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function getErrorText(error: unknown, key: "code" | "message") {
  if (typeof error === "object" && error !== null && key in error) {
    const value = (error as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  }
  return "";
}

function isSafePublicMessage(message: string) {
  const text = message.toLowerCase();
  return !(
    text.includes("database")
    || text.includes("postgres")
    || text.includes("connection")
    || text.includes("password")
    || text.includes("secret")
    || text.includes("token")
    || text.includes("key")
  );
}
