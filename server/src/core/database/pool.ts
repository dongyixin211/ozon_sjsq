/**
 * core/database/pool.ts — 数据库连接池
 *
 * 当前从 server/src/db.ts 透传，后续 Kysely 集成在此文件内完成。
 */
export { pool, withClient, withTransaction, requestPerformanceStorage } from "../../db.js";
export type { RequestPerformanceMetrics } from "../../db.js";
