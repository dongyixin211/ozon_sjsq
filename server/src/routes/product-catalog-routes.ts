import type { FastifyInstance } from "fastify";
import path from "node:path";
import { z } from "zod";
import { requireAuth, requireMembership } from "../auth.js";
import { pool, withTransaction } from "../db.js";
import { AppError } from "../errors.js";
import { sha256Hex } from "../security.js";
import { createDirectUploadUrl, objectExists, publicUrlForObjectKey } from "../storage.js";

const source = "taojinchuhai";

const listQuerySchema = z.object({
  keyword: z.string().trim().max(100).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  sourceActive: z.enum(["true", "false", "all"]).default("true"),
  pageNo: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
});

const assetSchema = z.object({
  sourceUrl: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  objectKey: z.string().min(1).max(500),
  publicUrl: z.string().url(),
  contentType: z.string().min(1).max(200),
  sizeBytes: z.number().int().nonnegative(),
  sourceFilename: z.string().max(500).optional(),
});

const productSchema = z.object({
  sourceProductId: z.number().int().positive(),
  summary: z.record(z.unknown()),
  detail: z.record(z.unknown()),
  mediaUrls: z.array(z.string().url()).max(1000),
});

const commitSchema = z.object({
  syncId: z.string().uuid(),
  categories: z.array(z.unknown()).max(5000),
  products: z.array(productSchema).max(5000),
  assets: z.array(assetSchema).max(100000),
});

export async function productCatalogRoutes(app: FastifyInstance) {
  app.get("/product-catalog/status", { preHandler: [requireAuth, requireMembership] }, async () => {
    return { ok: true, status: await readStatus() };
  });

  app.get("/product-catalog/categories", { preHandler: [requireAuth, requireMembership] }, async () => {
    const result = await pool.query(
      "SELECT categories_json FROM product_catalog_sync_state WHERE source = $1",
      [source],
    );
    return { ok: true, categories: result.rows[0]?.categories_json ?? [] };
  });

  app.get("/product-catalog/products", { preHandler: [requireAuth, requireMembership] }, async (request) => {
    const query = listQuerySchema.parse(request.query);
    const values: unknown[] = [];
    const where = ["source = 'taojinchuhai'"];
    if (query.keyword) {
      values.push(`%${query.keyword}%`);
      where.push(`title ILIKE $${values.length}`);
    }
    if (query.categoryId) {
      values.push(query.categoryId);
      where.push(`category_id = $${values.length}`);
    }
    if (query.sourceActive !== "all") {
      values.push(query.sourceActive === "true");
      where.push(`source_active = $${values.length}`);
    }
    values.push(query.pageSize, (query.pageNo - 1) * query.pageSize);
    const limitIndex = values.length - 1;
    const offsetIndex = values.length;
    const [items, total] = await Promise.all([
      pool.query(
        `SELECT id, source_product_id AS "sourceProductId", title, category_id AS "categoryId",
                category_name AS "categoryName", price_min::float AS "priceMin",
                price_max::float AS "priceMax", weight_min::float AS "weightMin",
                weight_max::float AS "weightMax", delivery_time_text AS "deliveryTimeText",
                cover_url AS "coverUrl", source_active AS "sourceActive", updated_at AS "updatedAt"
         FROM product_catalog_products WHERE ${where.join(" AND ")}
         ORDER BY source_active DESC, updated_at DESC, source_product_id DESC
         LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
        values,
      ),
      pool.query(`SELECT count(*)::int AS total FROM product_catalog_products WHERE ${where.join(" AND ")}`, values.slice(0, -2)),
    ]);
    return { ok: true, products: items.rows, total: total.rows[0]?.total ?? 0, pageNo: query.pageNo, pageSize: query.pageSize };
  });

  app.get("/product-catalog/products/:id", { preHandler: [requireAuth, requireMembership] }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await pool.query(
      `SELECT p.id, p.source_product_id AS "sourceProductId", p.title,
              p.source_active AS "sourceActive", p.detail_json AS detail,
              p.updated_at AS "updatedAt",
              COALESCE(jsonb_object_agg(a.source_url, a.public_url) FILTER (WHERE a.id IS NOT NULL), '{}'::jsonb) AS "assetMap"
       FROM product_catalog_products p
       LEFT JOIN product_catalog_product_assets pa ON pa.product_id = p.id
       LEFT JOIN product_catalog_assets a ON a.id = pa.asset_id
       WHERE p.id = $1
       GROUP BY p.id`,
      [params.id],
    );
    if (!result.rows[0]) throw new AppError(404, "PRODUCT_NOT_FOUND", "商品不存在");
    return { ok: true, product: result.rows[0] };
  });

  app.post("/product-catalog/sync/claim", { preHandler: [requireAuth, requireMembership] }, async (request) => {
    const body = z.object({ force: z.boolean().default(false) }).parse(request.body ?? {});
    return withTransaction(async (client) => {
      await client.query(
        `INSERT INTO product_catalog_sync_state (source) VALUES ($1) ON CONFLICT (source) DO NOTHING`,
        [source],
      );
      const current = await client.query(
        `SELECT syncing, started_at, last_success_at FROM product_catalog_sync_state WHERE source = $1 FOR UPDATE`,
        [source],
      );
      const row = current.rows[0];
      const running = row.syncing && row.started_at && Date.now() - new Date(row.started_at).getTime() < 30 * 60_000;
      const fresh = row.last_success_at && Date.now() - new Date(row.last_success_at).getTime() < 12 * 60 * 60_000;
      if (running || (!body.force && fresh)) {
        return { ok: true, shouldSync: false, reason: running ? "running" : "fresh", status: await readStatus(client) };
      }
      const syncIdResult = await client.query("SELECT gen_random_uuid() AS id");
      const syncId = syncIdResult.rows[0].id as string;
      await client.query(
        `UPDATE product_catalog_sync_state SET syncing = true, sync_id = $2, started_at = now(), last_error = NULL, updated_at = now() WHERE source = $1`,
        [source, syncId],
      );
      return { ok: true, shouldSync: true, syncId };
    });
  });

  app.post("/product-catalog/assets/prepare", { preHandler: [requireAuth, requireMembership] }, async (request) => {
    const body = z.object({ sourceUrl: z.string().url(), sha256: z.string().regex(/^[a-f0-9]{64}$/i), filename: z.string().max(500), contentType: z.string().max(200), sizeBytes: z.number().int().nonnegative() }).parse(request.body);
    const ext = extensionFor(body.filename, body.contentType);
    const objectKey = `product-catalog/${body.sha256.slice(0, 2)}/${body.sha256}.${ext}`;
    const publicUrl = publicUrlForObjectKey(objectKey);
    const exists = await objectExists(objectKey);
    const upload = exists ? null : await createDirectUploadUrl(objectKey, body.contentType || "application/octet-stream");
    return { ok: true, exists, objectKey, publicUrl, uploadUrl: upload?.uploadUrl ?? null };
  });

  app.post("/product-catalog/sync/commit", { bodyLimit: 25 * 1024 * 1024, preHandler: [requireAuth, requireMembership] }, async (request) => {
    const body = commitSchema.parse(request.body);
    await withTransaction(async (client) => {
      const lock = await client.query("SELECT sync_id FROM product_catalog_sync_state WHERE source = $1 FOR UPDATE", [source]);
      if (lock.rows[0]?.sync_id !== body.syncId) throw new AppError(409, "SYNC_REPLACED", "同步任务已被替换");
      const assetsByUrl = new Map<string, string>();
      for (const asset of body.assets) {
        const result = await client.query(
          `INSERT INTO product_catalog_assets (source_url, sha256, object_key, public_url, content_type, size_bytes, source_filename, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,now())
           ON CONFLICT (source_url) DO UPDATE SET sha256=excluded.sha256, object_key=excluded.object_key,
             public_url=excluded.public_url, content_type=excluded.content_type, size_bytes=excluded.size_bytes,
             source_filename=excluded.source_filename, updated_at=now()
           RETURNING id`,
          [asset.sourceUrl, asset.sha256, asset.objectKey, asset.publicUrl, asset.contentType, asset.sizeBytes, asset.sourceFilename ?? null],
        );
        assetsByUrl.set(asset.sourceUrl, result.rows[0].id);
      }
      const seenIds: number[] = [];
      for (const product of body.products) {
        const summary = product.summary;
        const detail = product.detail;
        const contentHash = sha256Hex(JSON.stringify(detail));
        const coverSourceUrl = stringValue(summary.coverImageUrl);
        const coverUrl = coverSourceUrl ? body.assets.find((item) => item.sourceUrl === coverSourceUrl)?.publicUrl ?? coverSourceUrl : null;
        const result = await client.query(
          `INSERT INTO product_catalog_products (source, source_product_id, title, category_id, category_name,
             price_min, price_max, weight_min, weight_max, delivery_time_text, cover_source_url, cover_url,
             content_hash, detail_json, source_active, source_last_seen_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,now(),now())
           ON CONFLICT (source, source_product_id) DO UPDATE SET title=excluded.title, category_id=excluded.category_id,
             category_name=excluded.category_name, price_min=excluded.price_min, price_max=excluded.price_max,
             weight_min=excluded.weight_min, weight_max=excluded.weight_max, delivery_time_text=excluded.delivery_time_text,
             cover_source_url=excluded.cover_source_url, cover_url=excluded.cover_url, content_hash=excluded.content_hash,
             detail_json=excluded.detail_json, source_active=true, source_last_seen_at=now(), updated_at=CASE
               WHEN product_catalog_products.content_hash <> excluded.content_hash THEN now() ELSE product_catalog_products.updated_at END
           RETURNING id`,
          [source, product.sourceProductId, stringValue(summary.goodsTitle) || `商品 ${product.sourceProductId}`,
            numberValue(summary.categoryId), stringValue(summary.categoryName), numberValue(summary.priceMin), numberValue(summary.priceMax),
            numberValue(summary.weightMin), numberValue(summary.weightMax), stringValue(summary.deliveryTimeText), coverSourceUrl, coverUrl,
            contentHash, JSON.stringify(detail)],
        );
        const productId = result.rows[0].id as string;
        seenIds.push(product.sourceProductId);
        await client.query(
          `INSERT INTO product_catalog_versions (product_id, content_hash, snapshot_json)
           VALUES ($1,$2,$3) ON CONFLICT (product_id, content_hash) DO NOTHING`,
          [productId, contentHash, JSON.stringify(detail)],
        );
        await client.query("DELETE FROM product_catalog_product_assets WHERE product_id = $1", [productId]);
        for (const mediaUrl of new Set(product.mediaUrls)) {
          const assetId = assetsByUrl.get(mediaUrl);
          if (assetId) await client.query(
            `INSERT INTO product_catalog_product_assets (product_id, asset_id, source_url) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
            [productId, assetId, mediaUrl],
          );
        }
      }
      await client.query(
        `UPDATE product_catalog_products SET source_active = false, updated_at = now()
         WHERE source = $1 AND NOT (source_product_id = ANY($2::bigint[])) AND source_active = true`,
        [source, seenIds],
      );
      await client.query(
        `UPDATE product_catalog_sync_state SET syncing=false, sync_id=NULL, last_success_at=now(), last_error=NULL,
          categories_json=$2, product_count=$3, asset_count=$4, updated_at=now() WHERE source=$1`,
        [source, JSON.stringify(body.categories), body.products.length, body.assets.length],
      );
    });
    return { ok: true, status: await readStatus() };
  });

  app.post("/product-catalog/sync/fail", { preHandler: [requireAuth, requireMembership] }, async (request) => {
    const body = z.object({ syncId: z.string().uuid(), message: z.string().max(2000) }).parse(request.body);
    await pool.query(
      `UPDATE product_catalog_sync_state SET syncing=false, sync_id=NULL, last_error=$3, updated_at=now()
       WHERE source=$1 AND sync_id=$2`,
      [source, body.syncId, body.message],
    );
    return { ok: true };
  });
}

async function readStatus(client: Pick<typeof pool, "query"> = pool) {
  const result = await client.query(
    `SELECT syncing, started_at AS "startedAt", last_success_at AS "lastSuccessAt", last_error AS "lastError",
            product_count AS "productCount", asset_count AS "assetCount", updated_at AS "updatedAt"
     FROM product_catalog_sync_state WHERE source = $1`,
    [source],
  );
  return result.rows[0] ?? { syncing: false, lastSuccessAt: null, lastError: null, productCount: 0, assetCount: 0 };
}

function extensionFor(filename: string, contentType: string) {
  const ext = path.extname(filename).replace(/^\./, "").toLowerCase();
  if (/^[a-z0-9]{1,8}$/.test(ext)) return ext;
  const byType: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "application/zip": "zip", "application/pdf": "pdf" };
  return byType[contentType.toLowerCase()] ?? "bin";
}

function stringValue(value: unknown) { return typeof value === "string" ? value : null; }
function numberValue(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
