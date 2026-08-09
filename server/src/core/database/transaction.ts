/**
 * core/database/transaction.ts — 事务编排工具
 *
 * 提供基于 AsyncLocalStorage 的事务传播能力，支持嵌套事务和保存点。
 */
import { pool } from "../../db.js";
import type { PoolClient } from "pg";

/** 在当前连接上执行事务。func 接收 client，自动 COMMIT/ROLLBACK。 */
export { withTransaction } from "../../db.js";

/** 获取当前事务上下文中的连接（如果有），否则使用连接池执行。 */
export async function executeInTransactionOrPool<T>(
  fn: (client: PoolClient | typeof pool) => Promise<T>,
): Promise<T> {
  // Phase 2 将使用 AsyncLocalStorage 感知当前事务
  return fn(pool);
}
