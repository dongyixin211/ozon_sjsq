import 'dotenv/config';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
async function q(label, sql) {
  const result = await pool.query(sql);
  console.log(`\n${label}`);
  console.log(JSON.stringify(result.rows, null, 2));
}
await q('gallery asset totals by user', `
  SELECT uploaded_by_user_id AS user_id, count(*)::int AS assets
  FROM gallery_assets
  WHERE deleted_at IS NULL
  GROUP BY uploaded_by_user_id
  ORDER BY assets DESC
  LIMIT 20
`);
await q('processing source assets by user exact frontend EXISTS', `
  SELECT a.uploaded_by_user_id AS user_id, count(*)::int AS processing_assets
  FROM gallery_assets a
  WHERE a.deleted_at IS NULL
    AND a.sku !~ '-fangjin-[0-9]+$'
    AND NOT EXISTS (SELECT 1 FROM gallery_mockup_results mr WHERE mr.user_id = a.uploaded_by_user_id AND mr.result_asset_id = a.id)
    AND EXISTS (
      SELECT 1
      FROM gallery_listing_batch_assets lba
      JOIN gallery_listing_batches lb ON lb.id = lba.batch_id
      LEFT JOIN gallery_listing_batch_shops lbs ON lbs.batch_id = lba.batch_id AND lbs.shop_id = lba.shop_id
      WHERE lba.user_id = a.uploaded_by_user_id
        AND lba.source_asset_id = a.id
        AND NOT (lb.status = 'uploaded' OR lbs.status = 'uploaded' OR lba.listing_completed_at IS NOT NULL)
    )
  GROUP BY a.uploaded_by_user_id
  ORDER BY processing_assets DESC
  LIMIT 20
`);
await q('unfinished lba by user exact', `
  SELECT lba.user_id, count(*)::int AS unfinished_rows,
    count(DISTINCT lba.source_asset_id)::int AS distinct_source_assets,
    min(lba.created_at) AS first_created,
    max(lba.created_at) AS last_created
  FROM gallery_listing_batch_assets lba
  JOIN gallery_listing_batches lb ON lb.id = lba.batch_id
  LEFT JOIN gallery_listing_batch_shops lbs ON lbs.batch_id = lba.batch_id AND lbs.shop_id = lba.shop_id
  WHERE lba.listing_completed_at IS NULL
    AND NOT (lb.status = 'uploaded' OR lbs.status = 'uploaded')
  GROUP BY lba.user_id
  ORDER BY unfinished_rows DESC
  LIMIT 20
`);
await q('numbers matching 15380 or 16445 candidates', `
  WITH user_asset_counts AS (
    SELECT uploaded_by_user_id AS user_id, count(*)::int AS assets
    FROM gallery_assets
    WHERE deleted_at IS NULL
    GROUP BY uploaded_by_user_id
  ), pending_counts AS (
    SELECT a.uploaded_by_user_id AS user_id, count(*)::int AS pending_assets
    FROM gallery_assets a
    WHERE a.deleted_at IS NULL
      AND a.sku !~ '-fangjin-[0-9]+$'
      AND NOT EXISTS (SELECT 1 FROM gallery_mockup_results mr WHERE mr.user_id = a.uploaded_by_user_id AND mr.result_asset_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM gallery_usage u WHERE u.user_id = a.uploaded_by_user_id AND u.sku = a.sku AND u.usage_type = 'uploaded')
      AND NOT EXISTS (SELECT 1 FROM gallery_listing_batch_assets lba WHERE lba.user_id = a.uploaded_by_user_id AND lba.source_asset_id = a.id)
    GROUP BY a.uploaded_by_user_id
  )
  SELECT u.id, u.phone, COALESCE(a.assets,0) AS assets, COALESCE(p.pending_assets,0) AS pending_assets
  FROM users u
  LEFT JOIN user_asset_counts a ON a.user_id = u.id
  LEFT JOIN pending_counts p ON p.user_id = u.id
  WHERE COALESCE(a.assets,0) IN (15380,16445) OR COALESCE(p.pending_assets,0) IN (15380,16445)
  ORDER BY assets DESC
`);
await pool.end();
