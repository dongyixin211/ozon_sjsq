import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirCandidates = [
  path.resolve(__dirname, "../migrations"),
  path.resolve(__dirname, "../../migrations"),
];

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("缺少 DATABASE_URL");
}

const pool = new pg.Pool({ connectionString: databaseUrl });

try {
  const migrationsDir = await findMigrationsDir();
  const files = (await fs.readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
    await pool.query(sql);
    console.log(`已执行迁移：${file}`);
  }
} finally {
  await pool.end();
}

async function findMigrationsDir() {
  for (const candidate of migrationsDirCandidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        return candidate;
      }
    } catch {
      // Try the next location.
    }
  }
  throw new Error(`未找到数据库迁移目录：${migrationsDirCandidates.join(", ")}`);
}
