import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireMembership } from "../auth.js";
import { pool } from "../db.js";
import { newId } from "../security.js";

const orderProductSchema = z.object({
  productId: optionalNumber(),
  offerId: optionalString(160).default(""),
  name: optionalString(1000),
  quantity: z.coerce.number().int().min(0).max(1_000_000).default(1),
  price: optionalNumber(),
  currencyCode: optionalString(16),
  imageUrl: optionalString(2000),
});

const orderPostingSchema = z.object({
  shopId: z.string().trim().min(1).max(120),
  shopName: optionalString(200),
  postingKind: z.enum(["fbs", "fbo"]).nullish().transform((value) => value ?? undefined),
  postingNumber: z.string().trim().min(1).max(160),
  orderNumber: optionalString(160),
  orderId: optionalNumber(),
  status: optionalString(80),
  inProcessAt: optionalString(80),
  shipmentDate: optionalString(80),
  warehouseName: optionalString(300),
  trackingNumber: optionalString(300),
  productsCount: z.coerce.number().int().min(0).max(1_000_000).default(0),
  offerIds: z.array(z.string().trim().max(160)).default([]),
  products: z.array(orderProductSchema).optional(),
  imageUrl: optionalString(2000),
  salesAmount: optionalNumber(),
  currencyCode: optionalString(16),
  downloadedAt: optionalString(80),
  downloadOutputPath: optionalString(1000),
  rawJson: z.unknown().optional(),
});

const syncOrdersSchema = z.object({
  orders: z.array(orderPostingSchema).max(5000).default([]),
});

export async function orderRoutes(app: FastifyInstance) {
  app.post("/orders/sync", { preHandler: [requireAuth, requireMembership] }, async (request) => {
    const userId = request.currentUser!.id;
    const body = syncOrdersSchema.parse(request.body);
    if (body.orders.length === 0) {
      return { ok: true, synced: 0 };
    }

    const externalShopIds = [...new Set(body.orders.map((order) => order.shopId).filter(Boolean))];
    const shops = await pool.query(
      `
      SELECT id, external_shop_id, name
      FROM shops
      WHERE user_id = $1
        AND external_shop_id = ANY($2::text[])
      `,
      [userId, externalShopIds],
    );
    const shopByExternalId = new Map(shops.rows.map((row: { id: string; external_shop_id: string; name: string }) => [row.external_shop_id, row]));
    const offerIds = [...new Set(body.orders.flatMap((order) => normalizedOfferIds(order)))];
    const categoryBySku = await readCategoryBySku(userId, offerIds);

    let synced = 0;
    for (const order of body.orders) {
      const shop = shopByExternalId.get(order.shopId);
      const ids = normalizedOfferIds(order);
      const category = ids.map((sku) => categoryBySku.get(sku)).find(Boolean) ?? null;
      const products = normalizeProducts(order);
      await pool.query(
        `
        INSERT INTO order_postings (
          id,
          user_id,
          shop_id,
          external_shop_id,
          shop_name,
          posting_kind,
          posting_number,
          order_number,
          order_id,
          status,
          category,
          in_process_at,
          shipment_date,
          warehouse_name,
          tracking_number,
          products_count,
          offer_ids,
          products,
          image_url,
          sales_amount,
          currency_code,
          downloaded_at,
          download_output_path,
          raw_json,
          synced_at,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17::text[], $18::jsonb,
          $19, $20, $21, $22, $23, $24::jsonb, now(), now()
        )
        ON CONFLICT (user_id, external_shop_id, posting_number)
        DO UPDATE SET
          shop_id = COALESCE(EXCLUDED.shop_id, order_postings.shop_id),
          shop_name = COALESCE(NULLIF(EXCLUDED.shop_name, ''), order_postings.shop_name),
          posting_kind = COALESCE(EXCLUDED.posting_kind, order_postings.posting_kind),
          order_number = COALESCE(EXCLUDED.order_number, order_postings.order_number),
          order_id = COALESCE(EXCLUDED.order_id, order_postings.order_id),
          status = COALESCE(EXCLUDED.status, order_postings.status),
          category = COALESCE(EXCLUDED.category, order_postings.category),
          in_process_at = COALESCE(EXCLUDED.in_process_at, order_postings.in_process_at),
          shipment_date = COALESCE(EXCLUDED.shipment_date, order_postings.shipment_date),
          warehouse_name = COALESCE(EXCLUDED.warehouse_name, order_postings.warehouse_name),
          tracking_number = COALESCE(EXCLUDED.tracking_number, order_postings.tracking_number),
          products_count = GREATEST(EXCLUDED.products_count, order_postings.products_count),
          offer_ids = CASE WHEN array_length(EXCLUDED.offer_ids, 1) IS NULL THEN order_postings.offer_ids ELSE EXCLUDED.offer_ids END,
          products = CASE WHEN jsonb_array_length(EXCLUDED.products) = 0 THEN order_postings.products ELSE EXCLUDED.products END,
          image_url = COALESCE(EXCLUDED.image_url, order_postings.image_url),
          sales_amount = COALESCE(EXCLUDED.sales_amount, order_postings.sales_amount),
          currency_code = COALESCE(EXCLUDED.currency_code, order_postings.currency_code),
          downloaded_at = COALESCE(EXCLUDED.downloaded_at, order_postings.downloaded_at),
          download_output_path = COALESCE(EXCLUDED.download_output_path, order_postings.download_output_path),
          raw_json = COALESCE(EXCLUDED.raw_json, order_postings.raw_json),
          synced_at = now(),
          updated_at = now()
        `,
        [
          newId(),
          userId,
          shop?.id ?? null,
          order.shopId,
          order.shopName || shop?.name || order.shopId,
          order.postingKind ?? null,
          order.postingNumber,
          emptyToNull(order.orderNumber),
          order.orderId ?? null,
          emptyToNull(order.status),
          category,
          dateOrNull(order.inProcessAt),
          dateOrNull(order.shipmentDate),
          emptyToNull(order.warehouseName),
          emptyToNull(order.trackingNumber),
          order.productsCount || products.reduce((sum, product) => sum + Math.max(0, product.quantity || 0), 0),
          ids,
          JSON.stringify(products),
          emptyToNull(order.imageUrl || products.find((product) => product.imageUrl)?.imageUrl),
          order.salesAmount ?? null,
          emptyToNull(order.currencyCode || products.find((product) => product.currencyCode)?.currencyCode),
          dateOrNull(order.downloadedAt),
          emptyToNull(order.downloadOutputPath),
          order.rawJson === undefined ? null : JSON.stringify(order.rawJson),
        ],
      );
      synced += 1;
    }

    return { ok: true, synced };
  });
}

async function readCategoryBySku(userId: string, offerIds: string[]) {
  if (offerIds.length === 0) {
    return new Map<string, string>();
  }
  const result = await pool.query(
    `
    SELECT DISTINCT ON (sku)
      sku,
      product_type
    FROM gallery_assets
    WHERE uploaded_by_user_id = $1
      AND deleted_at IS NULL
      AND product_type IS NOT NULL
      AND sku = ANY($2::text[])
    ORDER BY sku, created_at DESC
    `,
    [userId, offerIds],
  );
  return new Map(result.rows.map((row: { sku: string; product_type: string }) => [row.sku, row.product_type]));
}

function normalizeProducts(order: z.infer<typeof orderPostingSchema>) {
  const products = order.products?.length
    ? order.products
    : order.offerIds.map((offerId) => ({
      offerId,
      quantity: 1,
      productId: undefined,
      name: undefined,
      price: undefined,
      currencyCode: undefined,
      imageUrl: undefined,
    }));
  return products
    .map((product) => ({
      productId: product.productId,
      offerId: product.offerId.trim(),
      name: product.name,
      quantity: product.quantity || 1,
      price: product.price,
      currencyCode: product.currencyCode,
      imageUrl: product.imageUrl,
    }))
    .filter((product) => product.offerId);
}

function normalizedOfferIds(order: z.infer<typeof orderPostingSchema>) {
  const ids = [
    ...order.offerIds,
    ...(order.products ?? []).map((product) => product.offerId),
  ];
  return [...new Set(ids.map((value) => value.trim()).filter(Boolean))];
}

function optionalString(maxLength: number) {
  return z.string().trim().max(maxLength).nullish().transform((value) => value ?? undefined);
}

function optionalNumber() {
  return z.preprocess((value) => value ?? undefined, z.coerce.number().optional());
}

function emptyToNull(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed || null;
}

function dateOrNull(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
