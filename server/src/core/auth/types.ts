/**
 * core/auth/types.ts — 认证相关类型定义
 *
 * 所有模块引用此文件获取 CurrentUser 类型，而非直接 import auth.ts。
 */

// 从 auth.ts 透传 — 避免 FastifyRequest 的 currentUser 重复声明
export type { CurrentUser } from "../../auth.js";

/** 扩展 Request 类型，标记已认证的请求 */
import type { FastifyRequest } from "fastify";
import type { CurrentUser } from "../../auth.js";

export type AuthenticatedRequest = FastifyRequest & {
  currentUser: CurrentUser;
};
