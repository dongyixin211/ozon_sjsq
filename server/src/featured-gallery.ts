import type pg from "pg";
import { pool } from "./db.js";

type Queryable = pg.Pool | pg.PoolClient;

export async function refreshFeaturedGallery(client: Queryable = pool) {
  const result = await client.query(`
    WITH sku_stats AS (
      SELECT
        sku,
        sum(order_count)::int AS order_count,
        sum(quantity)::int AS quantity,
        count(DISTINCT user_id)::int AS distinct_user_count,
        count(DISTINCT shop_id)::int AS distinct_shop_count,
        max(last_ordered_at) AS last_ordered_at
      FROM product_sales_signals
      WHERE sku IS NOT NULL AND btrim(sku) <> ''
      GROUP BY sku
    ),
    ranked_assets AS (
      SELECT
        a.id AS asset_id,
        a.sku,
        a.sha256,
        s.order_count,
        s.quantity,
        s.distinct_user_count,
        s.distinct_shop_count,
        s.last_ordered_at,
        (
          s.order_count * 10
          + s.quantity
          + s.distinct_user_count * 20
          + s.distinct_shop_count * 5
          + CASE WHEN a.thumb_url IS NOT NULL THEN 3 ELSE 0 END
          + CASE WHEN a.width >= 800 AND a.height >= 800 THEN 2 ELSE 0 END
        )::int AS score,
        row_number() OVER (
          PARTITION BY a.sku, a.sha256
          ORDER BY
            s.order_count DESC,
            s.quantity DESC,
            a.created_at DESC,
            a.id
        ) AS same_image_rank
      FROM gallery_assets a
      JOIN sku_stats s ON s.sku = a.sku
      WHERE a.uploaded_by_user_id IS NOT NULL
        AND a.deleted_at IS NULL
    ),
    upserted AS (
      INSERT INTO featured_gallery_assets (
        id,
        asset_id,
        sku,
        sha256,
        score,
        order_count,
        distinct_user_count,
        distinct_shop_count,
        last_ordered_at,
        status,
        reason,
        updated_at
      )
      SELECT
        asset_id,
        asset_id,
        sku,
        sha256,
        score,
        order_count,
        distinct_user_count,
        distinct_shop_count,
        last_ordered_at,
        'active',
        CASE
          WHEN distinct_user_count >= 2 THEN '多个用户出单货号匹配到图库图片'
          WHEN order_count >= 2 THEN '同一货号有多次出单并匹配到图库图片'
          ELSE '出单货号匹配到图库图片'
        END,
        now()
      FROM ranked_assets
      WHERE same_image_rank = 1
      ON CONFLICT (asset_id)
      DO UPDATE SET
        sku = excluded.sku,
        sha256 = excluded.sha256,
        score = excluded.score,
        order_count = excluded.order_count,
        distinct_user_count = excluded.distinct_user_count,
        distinct_shop_count = excluded.distinct_shop_count,
        last_ordered_at = excluded.last_ordered_at,
        status = excluded.status,
        reason = excluded.reason,
        updated_at = now()
      RETURNING asset_id
    ),
    hidden AS (
      UPDATE featured_gallery_assets f
      SET status = 'hidden',
          reason = '该图片当前没有匹配到有效出单货号',
          updated_at = now()
      WHERE NOT EXISTS (
        SELECT 1 FROM ranked_assets r WHERE r.asset_id = f.asset_id AND r.same_image_rank = 1
      )
      RETURNING id
    )
    SELECT
      (SELECT count(*)::int FROM upserted) + (SELECT count(*)::int FROM hidden) AS updated
  `);
  return Number(result.rows[0]?.updated ?? 0);
}
