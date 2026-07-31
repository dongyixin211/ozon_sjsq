import { z } from "zod";
import { pool } from "./db.js";
import { AppError } from "./errors.js";
import { newId } from "./security.js";

export type ProductImageRule = {
  id: string;
  productType: string;
  aspectRatio: string;
  ratioWidth: number;
  ratioHeight: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export const productImageRuleSchema = z.object({
  id: z.string().uuid().optional(),
  productType: z.string().trim().min(1).max(120),
  aspectRatio: z.string().trim().regex(/^[1-9][0-9]{0,3}\s*[:：]\s*[1-9][0-9]{0,3}$/),
  enabled: z.boolean().optional().default(true),
});

export function normalizeAspectRatio(value: string) {
  const match = value.trim().match(/^([1-9][0-9]{0,3})\s*[:：]\s*([1-9][0-9]{0,3})$/);
  if (!match) {
    throw new AppError(400, "ASPECT_RATIO_INVALID", "图片比例必须是 2:3、3:4 这样的宽:高格式");
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  const divisor = gcd(width, height);
  return {
    aspectRatio: `${width / divisor}:${height / divisor}`,
    ratioWidth: width / divisor,
    ratioHeight: height / divisor,
  };
}

export function parseAspectRatio(value?: string | null) {
  const match = String(value ?? "").match(/([1-9][0-9]{0,3})\s*[:：]\s*([1-9][0-9]{0,3})/);
  if (!match) return null;
  return normalizeAspectRatio(`${match[1]}:${match[2]}`);
}

export function imageMatchesAspectRatio(width: number, height: number, ratioWidth: number, ratioHeight: number) {
  return width * ratioHeight === height * ratioWidth;
}

export async function listProductImageRules(includeDisabled = false) {
  const result = await pool.query(
    `
    SELECT id, product_type, aspect_ratio, ratio_width, ratio_height, enabled, created_at, updated_at
    FROM product_image_rules
    ${includeDisabled ? "WHERE deleted_at IS NULL" : "WHERE enabled = TRUE AND deleted_at IS NULL"}
    ORDER BY enabled DESC, product_type ASC, ratio_width ASC, ratio_height ASC
    `,
  );
  return result.rows.map(toRule);
}

export async function upsertProductImageRule(input: z.infer<typeof productImageRuleSchema>) {
  const ratio = normalizeAspectRatio(input.aspectRatio);
  const result = await pool.query(
    `
    INSERT INTO product_image_rules (id, product_type, aspect_ratio, ratio_width, ratio_height, enabled, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, now())
    ON CONFLICT (lower(product_type), aspect_ratio) DO UPDATE
    SET product_type = EXCLUDED.product_type,
        ratio_width = EXCLUDED.ratio_width,
        ratio_height = EXCLUDED.ratio_height,
        enabled = EXCLUDED.enabled,
        deleted_at = NULL,
        deleted_by = NULL,
        updated_at = now()
    RETURNING id, product_type, aspect_ratio, ratio_width, ratio_height, enabled, created_at, updated_at
    `,
    [input.id ?? newId(), input.productType.trim(), ratio.aspectRatio, ratio.ratioWidth, ratio.ratioHeight, input.enabled ?? true],
  );
  return toRule(result.rows[0]);
}

export async function setProductImageRuleEnabled(ruleId: string, enabled: boolean) {
  const result = await pool.query(
    `
    UPDATE product_image_rules
    SET enabled = $2, updated_at = now()
    WHERE id = $1 AND deleted_at IS NULL
    RETURNING id, product_type, aspect_ratio, ratio_width, ratio_height, enabled, created_at, updated_at
    `,
    [ruleId, enabled],
  );
  if (!result.rowCount) {
    throw new AppError(404, "PRODUCT_IMAGE_RULE_NOT_FOUND", "商品图片比例规则不存在");
  }
  return toRule(result.rows[0]);
}

export async function getEnabledProductImageRule(ruleId: string) {
  const result = await pool.query(
    `
    SELECT id, product_type, aspect_ratio, ratio_width, ratio_height, enabled, created_at, updated_at
    FROM product_image_rules
    WHERE id = $1 AND enabled = TRUE AND deleted_at IS NULL
    LIMIT 1
    `,
    [ruleId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError(400, "PRODUCT_IMAGE_RULE_REQUIRED", "请选择后台已维护并启用的商品类型和图片比例");
  }
  return toRule(row);
}

function toRule(row: Record<string, unknown>): ProductImageRule {
  return {
    id: String(row.id),
    productType: String(row.product_type),
    aspectRatio: String(row.aspect_ratio),
    ratioWidth: Number(row.ratio_width),
    ratioHeight: Number(row.ratio_height),
    enabled: Boolean(row.enabled),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function gcd(a: number, b: number): number {
  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return Math.abs(a) || 1;
}
