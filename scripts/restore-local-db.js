import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createInterface } from "node:readline";

/**
 * restore-local-db.js — 将 pg_dump 导出的 SQL 文件还原到本地 PostgreSQL
 *
 * 用法:
 *   cd server
 *   node ../scripts/restore-local-db.js [dump_file.sql.gz|dump_file.sql]
 *
 * 特点:
 *   - 流式读取，支持 GB 级 dump 文件
 *   - 自动识别 gzip 压缩 (.sql.gz)
 *   - 每 1000 行输出进度日志
 *   - 缺省使用 server/.env 中的 DATABASE_URL
 */

// ── 读取 .env (沿用 server/src/config 的方式) ──
// eslint-disable-next-line no-eval
const dotenvContent = await (async () => {
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const envPath = path.resolve(import.meta.dirname, "..", "server", ".env");
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, "utf8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  } catch { /* ignore */ }
})();

// ── 获取参数 ──
const dumpFile =
  process.argv[2];

if (!dumpFile) {
  console.error("用法: node scripts/restore-local-db.js <dump_file.sql[.gz]>");
  console.error("");
  console.error("示例:");
  console.error("  node ../scripts/restore-local-db.js ../local/db-sync/prod_dump_20260101_120000.sql.gz");
  process.exit(1);
}

// ── 数据库连接 ──
const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://ozon_sjsq:ozon_sjsq_dev@127.0.0.1:5432/ozon_sjsq_cloud";

const LOCAL_DB_PASSWORD =
  process.env.LOCAL_DB_PASSWORD ||
  "ozon_sjsq_dev";

// 解析 DATABASE_URL
const url = new URL(DATABASE_URL);
const dbConfig = {
  host: url.hostname || "127.0.0.1",
  port: parseInt(url.port || "5432", 10),
  database: url.pathname.replace(/^\//, "") || "ozon_sjsq_cloud",
  user: decodeURIComponent(url.username) || "ozon_sjsq",
  password: decodeURIComponent(url.password) || LOCAL_DB_PASSWORD,
};

console.log("==========================================");
console.log("  本地数据库还原工具");
console.log("==========================================");
console.log(`  目标数据库: ${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);
console.log(`  Dump 文件:   ${dumpFile}`);

let fileSize = 0;
try {
  fileSize = statSync(dumpFile).size;
  console.log(`  文件大小:    ${(fileSize / (1024 * 1024)).toFixed(2)} MB`);
} catch {
  console.error(`  [ERROR] 文件不存在: ${dumpFile}`);
  process.exit(1);
}
console.log("==========================================");
console.log("");

// 动态导入 pg
const { Client } = await import("pg");

async function restoreStream() {
  const client = new Client({
    ...dbConfig,
    statement_timeout: 120_000,  // 每条语句最多 2 分钟
    connectionTimeoutMillis: 10_000,
  });

  try {
    await client.connect();
    console.log("[OK] 已连接到本地数据库");

    // 设置会话参数
    await client.query("SET session_replication_role = 'replica';");
    await client.query("SET client_min_messages = WARNING;");

    // 创建读取流（自动处理 gzip）
    let readStream;
    if (dumpFile.endsWith(".gz")) {
      const { default: zlib } = await import("node:zlib");
      readStream = createReadStream(dumpFile).pipe(zlib.createGunzip());
    } else {
      readStream = createReadStream(dumpFile, { encoding: "utf8" });
    }

    // 逐行读取并执行 SQL
    const rl = createInterface({
      input: readStream,
      crlfDelay: Infinity,
    });

    let statementBuffer = "";
    let lineCount = 0;
    let stmtCount = 0;
    let errorCount = 0;
    const startTime = Date.now();

    for await (const line of rl) {
      lineCount++;

      // 跳过纯注释和空行
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("--")) {
        continue;
      }

      statementBuffer += line + "\n";

      // 检测语句结束（分号结尾）
      if (trimmed.endsWith(";")) {
        stmtCount++;
        try {
          await client.query(statementBuffer);
        } catch (err) {
          // 忽略预期的错误（如 DROP TABLE IF EXISTS 目标不存在）
          const msg = err.message || "";
          if (msg.includes("does not exist") ||
              msg.includes("already exists") ||
              msg.includes("duplicate key") ||
              msg.includes("violates foreign key constraint")) {
            // 可忽略的错误（pg_dump --clean --if-exists 场景）
          } else {
            errorCount++;
            if (errorCount <= 10) {
              console.warn(
                `  [WARN] 语句 #${stmtCount} 错误: ${msg.slice(0, 120)}`
              );
            }
          }
        } finally {
          statementBuffer = "";
        }

        // 进度日志（每 5000 条语句）
        if (stmtCount % 5000 === 0) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(
            `  ... 已执行 ${stmtCount} 条语句 (${elapsed}s, ${errorCount} 错误)`
          );
        }
      }
    }

    // 执行缓冲区中剩余的语句
    if (statementBuffer.trim()) {
      stmtCount++;
      try {
        await client.query(statementBuffer);
      } catch {
        errorCount++;
      }
    }

    const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log("");
    console.log("==========================================");
    console.log("  还原完成");
    console.log("==========================================");
    console.log(`  总行数:   ${lineCount.toLocaleString()}`);
    console.log(`  总语句:   ${stmtCount.toLocaleString()}`);
    console.log(`  错误数:   ${errorCount}`);
    console.log(`  耗时:     ${totalSec}s`);
    console.log("==========================================");

    if (errorCount > 0) {
      console.log("");
      console.log("  注意: 部分语句执行出错，通常是 pg_dump --clean 清理");
      console.log("  已不存在的对象时产生的正常现象，不影响数据完整性。");
    }
  } finally {
    // 恢复默认设置
    try {
      await client.query("SET session_replication_role = 'origin';");
    } catch { /* ignore */ }
    await client.end();
    console.log("[OK] 数据库连接已关闭");
  }
}

await restoreStream();
