import 'dotenv/config';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
async function q(label, sql) {
  const result = await pool.query(sql);
  console.log(`\n${label}`);
  console.log(JSON.stringify(result.rows, null, 2));
}
const processingWhere = `
  lba.listing_completed_at IS NULL
  AND NOT (lb.status = 'uploaded' OR lbs.status = 'uploaded')
`;
await q('processing by created date', `
  SELECT (lba.created_at AT TIME ZONE 'Asia/Shanghai')::date AS date, count(*)::int AS count
  FROM gallery_listing_batch_assets lba
  JOIN gallery_listing_batches lb ON lb.id = lba.batch_id
  LEFT JOIN gallery_listing_batch_shops lbs ON lbs.batch_id = lba.batch_id AND lbs.shop_id = lba.shop_id
  WHERE ${processingWhere}
  GROUP BY 1 ORDER BY 1 DESC LIMIT 20
`);
await q('processing by batch status', `
  SELECT lb.status, count(*)::int AS count, min(lba.created_at) AS first, max(lba.created_at) AS last
  FROM gallery_listing_batch_assets lba
  JOIN gallery_listing_batches lb ON lb.id = lba.batch_id
  LEFT JOIN gallery_listing_batch_shops lbs ON lbs.batch_id = lba.batch_id AND lbs.shop_id = lba.shop_id
  WHERE ${processingWhere}
  GROUP BY lb.status ORDER BY count DESC
`);
await q('processing by stage', `
  SELECT COALESCE(lba.listing_stage, '') AS stage, count(*)::int AS count
  FROM gallery_listing_batch_assets lba
  JOIN gallery_listing_batches lb ON lb.id = lba.batch_id
  LEFT JOIN gallery_listing_batch_shops lbs ON lbs.batch_id = lba.batch_id AND lbs.shop_id = lba.shop_id
  WHERE ${processingWhere}
  GROUP BY 1 ORDER BY count DESC LIMIT 20
`);
await q('recent batches', `
  SELECT lb.id, lb.status, lb.created_at, lb.updated_at, count(*)::int AS assets,
    count(*) FILTER (WHERE lba.listing_completed_at IS NULL)::int AS unfinished
  FROM gallery_listing_batches lb
  JOIN gallery_listing_batch_assets lba ON lba.batch_id = lb.id
  GROUP BY lb.id, lb.status, lb.created_at, lb.updated_at
  ORDER BY lb.created_at DESC LIMIT 10
`);
await pool.end();
