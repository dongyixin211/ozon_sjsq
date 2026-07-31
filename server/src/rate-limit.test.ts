import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "./errors.js";
import { assertRateLimit, createRedisRateLimitStore, setRateLimitStoreForTest } from "./rate-limit.js";

test("uses one Redis fixed-window counter for every limiter call", async () => {
  const calls: Array<{ script: string; keys: number; key: string; windowMs: string }> = [];
  const store = createRedisRateLimitStore({
    async eval(script: string, keys: number, key: string, windowMs: string) {
      calls.push({ script, keys, key, windowMs });
      return 1;
    },
  });

  setRateLimitStoreForTest(store);
  try {
    await assertRateLimit({
      key: "title:user-1",
      limit: 2,
      windowMs: 60_000,
      code: "TITLE_RATE_LIMITED",
      message: "too many title requests",
    });
  } finally {
    setRateLimitStoreForTest();
  }

  assert.deepEqual(calls, [{
    script: calls[0]?.script ?? "",
    keys: 1,
    key: "title:user-1",
    windowMs: "60000",
  }]);
  assert.match(calls[0]!.script, /INCR/);
  assert.match(calls[0]!.script, /PEXPIRE/);
});

test("returns the existing 429 AppError when the shared counter exceeds its limit", async () => {
  const store = createRedisRateLimitStore({
    async eval() {
      return 3;
    },
  });

  setRateLimitStoreForTest(store);
  try {
    await assert.rejects(
      assertRateLimit({
        key: "mockup:user-1",
        limit: 2,
        windowMs: 60_000,
        code: "MOCKUP_RATE_LIMITED",
        message: "too many mockup requests",
      }),
      (error: unknown) => error instanceof AppError
        && error.statusCode === 429
        && error.code === "MOCKUP_RATE_LIMITED",
    );
  } finally {
    setRateLimitStoreForTest();
  }
});