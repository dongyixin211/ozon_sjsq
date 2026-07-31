import { AppError } from "./errors.js";

type Bucket = {
  windowStartedAt: number;
  count: number;
};

export type RateLimitInput = {
  key: string;
  limit: number;
  windowMs: number;
  code: string;
  message: string;
};

export type RedisEvalClient = {
  eval(script: string, keys: number, ...args: string[]): Promise<unknown>;
};

export type RateLimitStore = {
  increment(key: string, windowMs: number): Promise<number>;
};

const fixedWindowLua = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
return count
`;

const buckets = new Map<string, Bucket>();
let lastSweepAt = Date.now();
let sharedRateLimitStore: RateLimitStore | undefined;

export function createRedisRateLimitStore(client: RedisEvalClient): RateLimitStore {
  return {
    async increment(key, windowMs) {
      const result = await client.eval(fixedWindowLua, 1, key, String(windowMs));
      const count = Number(result);
      if (!Number.isInteger(count) || count < 1) {
        throw new Error("Redis rate-limit script returned an invalid counter value");
      }
      return count;
    },
  };
}

export function configureRateLimitStore(store: RateLimitStore | undefined) {
  sharedRateLimitStore = store;
}

export function setRateLimitStoreForTest(store?: RateLimitStore) {
  sharedRateLimitStore = store;
}

export async function assertRateLimit(input: RateLimitInput) {
  const count = await incrementRateLimit(input);
  if (count > input.limit) {
    throw new AppError(429, input.code, input.message);
  }
}

async function incrementRateLimit(input: RateLimitInput) {
  if (!sharedRateLimitStore) {
    return incrementInMemoryRateLimit(input.key, input.windowMs);
  }
  try {
    return await sharedRateLimitStore.increment(input.key, input.windowMs);
  } catch (error) {
    console.error("[rate-limit] shared store unavailable", error);
    throw new AppError(
      503,
      "RATE_LIMIT_STORE_UNAVAILABLE",
      "Rate-limit service is temporarily unavailable",
    );
  }
}


function incrementInMemoryRateLimit(key: string, windowMs: number) {
  sweepExpiredBuckets(windowMs);
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStartedAt >= windowMs) {
    buckets.set(key, { windowStartedAt: now, count: 1 });
    return 1;
  }
  bucket.count += 1;
  return bucket.count;
}

function sweepExpiredBuckets(windowMs: number) {
  const now = Date.now();
  if (now - lastSweepAt < 60_000) {
    return;
  }
  lastSweepAt = now;
  const maxAge = Math.max(windowMs, 60_000);
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStartedAt > maxAge) {
      buckets.delete(key);
    }
  }
}
