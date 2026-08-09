/**
 * feature-middleware.ts — requireFeature 路由中间件
 *
 * 用法：
 *   app.get("/api/v1/gallery/upload",
 *     { preHandler: [requireAuth, requireFeature("gallery.upload")] },
 *     handler
 *   );
 *
 * 权限校验顺序：
 *   1. admin 直接放行
 *   2. 角色默认权限（feature_flags.default_roles）
 *   3. 个人授权（user_feature_access 表）
 */

import type { FastifyRequest } from "fastify";
import { AppError } from "./errors.js";
import { hasFeatureAccess } from "./feature-service.js";

export function requireFeature(featureKey: string) {
  return async (request: FastifyRequest) => {
    const user = request.currentUser;
    if (!user) {
      throw new AppError(401, "AUTH_REQUIRED", "请先登录");
    }

    const allowed = await hasFeatureAccess(user.id, user.roles, featureKey);
    if (!allowed) {
      throw new AppError(403, "FEATURE_FORBIDDEN", "您暂无权限使用此功能");
    }
  };
}
