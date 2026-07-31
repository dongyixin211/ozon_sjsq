import "dotenv/config";
import { planRules, type PlanCode } from "../src/config.js";
import { pool } from "../src/db.js";
import { makeLicenseKey, newId, sha256Hex } from "../src/security.js";

const planArg = process.argv[2] as PlanCode | undefined;
const countArg = Number(process.argv[3] || "1");

if (!planArg || !(planArg in planRules)) {
  console.error("用法：npm run keys:create -- monthly 10");
  console.error("套餐：monthly（月卡99）、quarterly（季卡249）、yearly（年卡899）");
  process.exit(1);
}

if (!Number.isInteger(countArg) || countArg < 1 || countArg > 500) {
  console.error("数量必须是 1 到 500 的整数");
  process.exit(1);
}

const rule = planRules[planArg];
const keys: string[] = [];

try {
  for (let index = 0; index < countArg; index += 1) {
    const key = makeLicenseKey();
    await pool.query(
      `
      INSERT INTO authorization_keys (id, key_hash, key_prefix, key_plain, plan, days, price_cents)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [newId(), sha256Hex(key), key.slice(0, 12), key, planArg, rule.days, rule.priceCents],
    );
    keys.push(key);
  }

  console.log(`已生成 ${keys.length} 个${rule.label}授权密钥：`);
  for (const key of keys) {
    console.log(key);
  }
  console.log("注意：后台列表仅对未使用授权码提供复制，兑换后会自动隐藏完整内容。");
} finally {
  await pool.end();
}
