export interface ActionProductPayloadInput {
  productId?: number;
  offerId?: string;
  name?: string;
  price?: string;
  actionPrice?: string;
  discount?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

export function extractNextLastId(value: unknown): string {
  if (!isRecord(value)) return "";
  const result = isRecord(value.result) ? value.result : value;
  return scalarText(result.last_id ?? result.lastId) ?? "";
}

export function moneyNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s/g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function discountPercent(basePrice: string | undefined, actionPrice: string): number | undefined {
  const base = moneyNumber(basePrice);
  const action = moneyNumber(actionPrice);
  if (!base || !action || action >= base) return undefined;
  return Math.max(1, Math.min(99, Math.round(((base - action) / base) * 100)));
}

export function buildActionProductPayload(
  product: ActionProductPayloadInput,
  actionPrice: string,
  actionStock: number,
) {
  if (!product.productId) {
    throw new Error(`${product.offerId || product.name || "商品"} 缺少商品 ID，无法参加活动`);
  }
  const price = actionPrice.trim() || product.actionPrice || product.price;
  if (!price) {
    throw new Error(`${product.offerId || product.productId} 缺少活动价，请填写活动价`);
  }
  const payload: Record<string, unknown> = {
    product_id: product.productId,
    action_price: price,
    stock: actionStock,
  };
  const discount = product.discount ?? discountPercent(product.price, price);
  if (discount !== undefined) {
    payload.discount = discount;
  }
  return payload;
}
