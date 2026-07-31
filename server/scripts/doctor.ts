import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "../src/config.js";
import { pool } from "../src/db.js";

const checks: Array<{ name: string; run: () => Promise<void> }> = [
  {
    name: "PostgreSQL 连接",
    run: async () => {
      await pool.query("SELECT 1");
    },
  },
];

if (config.STORAGE_PROVIDER.toLowerCase() === "local") {
  checks.push({
    name: "本地图库目录",
    run: async () => {
      const root = path.resolve(config.STORAGE_LOCAL_DIR);
      await fs.mkdir(root, { recursive: true });
      const probe = path.join(root, ".write-test");
      await fs.writeFile(probe, "ok", "utf8");
      await fs.unlink(probe);
    },
  });
} else {
  checks.push({
    name: "对象存储 Bucket",
    run: async () => {
      const client = new S3Client({
        endpoint: config.STORAGE_ENDPOINT,
        region: config.STORAGE_REGION,
        credentials: {
          accessKeyId: config.STORAGE_ACCESS_KEY_ID,
          secretAccessKey: config.STORAGE_SECRET_ACCESS_KEY,
        },
        forcePathStyle: resolveForcePathStyle(),
      });
      const key = `__health/doctor-${Date.now()}.txt`;
      const body = Buffer.from("ok");
      try {
        await client.send(new PutObjectCommand({
          Bucket: config.STORAGE_BUCKET,
          Key: key,
          Body: body,
          ContentType: "text/plain",
          CacheControl: "no-store",
        }));
        await client.send(new HeadObjectCommand({ Bucket: config.STORAGE_BUCKET, Key: key }));
        const response = await client.send(new GetObjectCommand({ Bucket: config.STORAGE_BUCKET, Key: key }));
        const content = response.Body ? Buffer.from(await response.Body.transformToByteArray()) : Buffer.alloc(0);
        if (!content.equals(body)) {
          throw new Error("对象存储读回内容不一致");
        }
      } finally {
        await client.send(new DeleteObjectCommand({ Bucket: config.STORAGE_BUCKET, Key: key })).catch(() => undefined);
      }
    },
  });
}

let failed = false;

try {
  for (const check of checks) {
    try {
      await check.run();
      console.log(`通过：${check.name}`);
    } catch (error) {
      failed = true;
      console.error(`失败：${check.name}`);
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
} finally {
  await pool.end();
}

if (failed) {
  process.exit(1);
}

console.log("环境检查通过。");

function resolveForcePathStyle() {
  const explicit = config.STORAGE_FORCE_PATH_STYLE.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(explicit)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(explicit)) {
    return false;
  }
  const endpoint = config.STORAGE_ENDPOINT.toLowerCase();
  if (config.STORAGE_PROVIDER.toLowerCase() === "oss" || endpoint.includes(".aliyuncs.com")) {
    return false;
  }
  return true;
}
