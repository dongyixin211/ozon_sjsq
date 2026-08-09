/**
 * modules/admin/index.ts — 管理后台模块
 *
 * 范围: 管理后台全部接口 (用户管理、功能开关、系统设置、操作日志)
 * 当前: admin-routes.ts 透传。Phase 2 拆分 controllers/services/repositories 三层。
 */
export const ADMIN_MODULE = "admin" as const;

/**
 * 重新导出管理后台核心能力
 * Phase 2: 改为 import adminRoutes from "./routes.js"
 */
export { adminRoutes } from "../../routes/admin-routes.js";
