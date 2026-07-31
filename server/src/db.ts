import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "./config.js";

export type RequestPerformanceMetrics = {
  dbMs: number;
  dbQueries: number;
};

export const requestPerformanceStorage = new AsyncLocalStorage<RequestPerformanceMetrics>();

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: config.DB_POOL_MAX,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});

const originalPoolQuery = pool.query.bind(pool) as (...args: any[]) => any;
pool.query = ((...args: any[]) => {
  const startedAt = performance.now();
  const result = originalPoolQuery(...args);
  if (result && typeof result.then === "function") {
    return result.finally(() => {
      const metrics = requestPerformanceStorage.getStore();
      if (metrics) {
        metrics.dbMs += performance.now() - startedAt;
        metrics.dbQueries += 1;
      }
    });
  }
  return result;
}) as typeof pool.query;

pool.on("error", (error) => {
  console.error("[db] idle client error", error);
});

export async function withClient<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}
