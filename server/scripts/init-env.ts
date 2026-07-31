import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const envPath = path.resolve(".env");

if (fs.existsSync(envPath) && !process.argv.includes("--force")) {
  console.error(".env 已存在。如需覆盖，请执行：npm run env:init -- --force");
  process.exit(1);
}

const jwtSecret = crypto.randomBytes(48).toString("base64url");
const adminToken = `admin_${crypto.randomBytes(24).toString("base64url")}`;

const content = `NODE_ENV=production
PORT=8787
PUBLIC_API_BASE_URL=https://api.example.com

JWT_SECRET=${jwtSecret}
ADMIN_TOKEN=${adminToken}

DATABASE_URL=postgresql://ozon_sjsq:change_this_password@127.0.0.1:5432/ozon_sjsq_cloud

STORAGE_PROVIDER=local
STORAGE_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
STORAGE_REGION=auto
STORAGE_ACCESS_KEY_ID=
STORAGE_SECRET_ACCESS_KEY=
STORAGE_BUCKET=ozon-sjsq-gallery
STORAGE_PUBLIC_BASE_URL=https://api.example.com/uploads
STORAGE_LOCAL_DIR=/opt/ozon-sjsq-cloud/uploads
STORAGE_FORCE_PATH_STYLE=

MAX_UPLOAD_MB=15
`;

fs.writeFileSync(envPath, content, "utf8");

console.log("已生成 server/.env");
console.log("请继续填写 DATABASE_URL、R2 密钥、PUBLIC_API_BASE_URL、STORAGE_PUBLIC_BASE_URL。");
console.log(`管理员口令 ADMIN_TOKEN：${adminToken}`);
