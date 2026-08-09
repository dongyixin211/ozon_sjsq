/**
 * core/rate-limit/middleware.ts — 限流中间件
 *
 * 当前透传已有实现，后续迁移至此。
 */
export {
  assertRateLimit,
  configureRateLimitStore,
  createRedisRateLimitStore,
  setRateLimitStoreForTest,
} from "../../rate-limit.js";
