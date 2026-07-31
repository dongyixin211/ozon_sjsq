import "dotenv/config";
import { refreshFeaturedGallery } from "../src/featured-gallery.js";
import { pool } from "../src/db.js";

try {
  const updated = await refreshFeaturedGallery();
  console.log(`精品图库刷新完成，更新 ${updated} 条记录。`);
} finally {
  await pool.end();
}
