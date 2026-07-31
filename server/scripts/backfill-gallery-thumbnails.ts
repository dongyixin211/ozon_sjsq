import fs from "node:fs/promises";
import path from "node:path";
import { pool } from "../src/db.js";
import { config } from "../src/config.js";
import {
  createThumbnailBuffer,
  publicUrlForObjectKey,
  thumbnailContentType,
  thumbnailObjectKeyForOriginal,
  uploadObject,
} from "../src/storage.js";

const batchSize = Number(process.env.THUMB_BATCH_SIZE || 100);
const maxItems = Number(process.env.THUMB_MAX_ITEMS || 0);

const result = await pool.query(
  `
  SELECT id, object_key, thumb_object_key
  FROM gallery_assets
  WHERE thumb_url IS NULL OR thumb_object_key IS NULL
  ORDER BY created_at DESC
  LIMIT $1
  `,
  [maxItems > 0 ? Math.min(maxItems, batchSize) : batchSize],
);

let updated = 0;
let failed = 0;

for (const row of result.rows) {
  try {
    const objectKey = String(row.object_key);
    const sourceBuffer = await readOriginalObject(objectKey);
    const thumbBuffer = await createThumbnailBuffer(sourceBuffer);
    const thumbObjectKey = row.thumb_object_key || thumbnailObjectKeyForOriginal(objectKey);
    const thumbUrl = publicUrlForObjectKey(thumbObjectKey);
    await uploadObject(thumbObjectKey, thumbBuffer, thumbnailContentType);
    await pool.query(
      `
      UPDATE gallery_assets
      SET thumb_object_key = $2,
          thumb_url = $3
      WHERE id = $1
      `,
      [row.id, thumbObjectKey, thumbUrl],
    );
    updated += 1;
    console.log(`已补缩略图 ${updated}/${result.rowCount}: ${objectKey}`);
  } catch (error) {
    failed += 1;
    console.error(`补缩略图失败：${row.object_key}`, error instanceof Error ? error.message : String(error));
  }
}

await pool.end();

console.log(`图库缩略图补齐完成：成功 ${updated}，失败 ${failed}。`);

async function readOriginalObject(objectKey: string) {
  if (config.STORAGE_PROVIDER.toLowerCase() !== "local") {
    throw new Error("当前补缩略图脚本只支持 STORAGE_PROVIDER=local；R2/B2 需要增加对象读取逻辑");
  }
  return fs.readFile(path.join(config.STORAGE_LOCAL_DIR, objectKey));
}
