import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireMembership } from "../auth.js";
import { pool } from "../db.js";
import { newId } from "../security.js";

const upsertShopSchema = z.object({
  externalShopId: z.string().min(1).max(120),
  name: z.string().min(1).max(120),
  ozonClientId: z.string().max(120).optional(),
});

export async function shopRoutes(app: FastifyInstance) {
  app.get("/shops", { preHandler: [requireAuth, requireMembership] }, async (request) => {
    const result = await pool.query(
      `
      SELECT id, external_shop_id, name, ozon_client_id, created_at, updated_at
      FROM shops
      WHERE user_id = $1
      ORDER BY lower(name) ASC, external_shop_id ASC, created_at ASC
      `,
      [request.currentUser!.id],
    );
    return { ok: true, shops: result.rows };
  });

  app.post("/shops/upsert", { preHandler: [requireAuth, requireMembership] }, async (request) => {
    const body = upsertShopSchema.parse(request.body);
    const result = await pool.query(
      `
      INSERT INTO shops (id, user_id, external_shop_id, name, ozon_client_id)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id, external_shop_id)
      DO UPDATE SET
        name = excluded.name,
        ozon_client_id = excluded.ozon_client_id,
        updated_at = now()
      RETURNING id, external_shop_id, name, ozon_client_id, created_at, updated_at
      `,
      [newId(), request.currentUser!.id, body.externalShopId, body.name, body.ozonClientId ?? null],
    );
    return { ok: true, shop: result.rows[0] };
  });
}
