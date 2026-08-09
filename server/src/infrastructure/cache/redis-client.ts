/**
 * infrastructure/cache/redis-client.ts — Redis 连接管理
 *
 * Phase 2: 集成 ioredis 连接池，支持缓存/限流/任务队列。
 * Phase 1: 占位 — 当前使用内存实现。
 */

/** Redis 连接状态 */
export interface RedisClient {
  isReady: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
}

/** Phase 2: 创建真实 Redis 连接 */
export async function createRedisClient(): Promise<RedisClient> {
  // TODO: import Redis from "ioredis"
  throw new Error("Redis client not yet implemented — Phase 2");
}
