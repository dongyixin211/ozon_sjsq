import "dotenv/config";
import bcrypt from "bcryptjs";
import { pool } from "../src/db.js";

const phone = process.env.ADMIN_BOOTSTRAP_PHONE?.trim();
const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;

if (!phone || !password) {
  throw new Error("ADMIN_BOOTSTRAP_PHONE and ADMIN_BOOTSTRAP_PASSWORD are required");
}
if (password.length < 8) {
  throw new Error("ADMIN_BOOTSTRAP_PASSWORD must be at least 8 characters");
}

const passwordHash = await bcrypt.hash(password, 12);
try {
  const user = await pool.query("SELECT id FROM users WHERE phone = $1 LIMIT 1", [phone]);
  await pool.query(
    "INSERT INTO admin_accounts (phone, user_id, password_hash) VALUES ($1, $2, $3) ON CONFLICT (phone) DO UPDATE SET user_id = EXCLUDED.user_id, password_hash = EXCLUDED.password_hash, is_active = TRUE, updated_at = now()",
    [phone, user.rows[0]?.id ?? null, passwordHash],
  );
  if (user.rows[0]?.id) {
    await pool.query("UPDATE users SET role = 'admin', updated_at = now() WHERE id = $1", [user.rows[0].id]);
  }
  console.log("Administrator account initialized for " + phone);
} finally {
  await pool.end();
}
