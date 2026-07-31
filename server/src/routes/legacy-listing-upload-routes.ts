import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireMembership } from "../auth.js";
import { pool } from "../db.js";
import { AppError } from "../errors.js";
import { newId } from "../security.js";
import { createDirectUploadUrl, publicUrlForObjectKey, readObjectMetadata } from "../storage.js";

const presignSchema = z.object({
  sku: z.string().trim().min(1).max(240),
  filename: z.string().trim().min(1).max(240),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  sizeBytes: z.coerce.number().int().positive().max(100 * 1024 * 1024),
});
const completeSchema = z.object({ objectKey: z.string().trim().min(1).max(600) }).strict();

function objectKey(userId: string, sku: string, filename: string, id: string) {
  const safeSku = sku.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^_+|_+$/g, "") || "sku";
  const ext = filename.toLowerCase().match(/\.(png|webp|jpe?g)$/)?.[0] ?? ".jpg";
  return `legacy-listing/${userId}/${safeSku}/${id}${ext}`;
}

export async function legacyListingUploadRoutes(app: FastifyInstance) {
  app.post("/legacy-listing/uploads/presign", { preHandler: [requireAuth, requireMembership] }, async (request) => {
    const body = presignSchema.parse(request.body);
    const userId = request.currentUser!.id;
    const id = newId();
    const key = objectKey(userId, body.sku, body.filename, id);
    const signed = await createDirectUploadUrl(key, body.contentType);
    await pool.query(
      `INSERT INTO legacy_listing_upload_grants (id, user_id, object_key, sku, source_filename, content_type, size_bytes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8::int * interval '1 second'))`,
      [id, userId, key, body.sku, body.filename, body.contentType, body.sizeBytes, signed.expiresIn],
    );
    return { ok: true, objectKey: key, uploadUrl: signed.uploadUrl, expiresIn: signed.expiresIn };
  });

  app.post("/legacy-listing/uploads/complete", { preHandler: [requireAuth, requireMembership] }, async (request) => {
    const { objectKey } = completeSchema.parse(request.body);
    const userId = request.currentUser!.id;
    const result = await pool.query(
      `SELECT id, sku, source_filename AS "sourceFilename", content_type AS "contentType", size_bytes AS "sizeBytes", expires_at AS "expiresAt", completed_at AS "completedAt"
       FROM legacy_listing_upload_grants WHERE user_id = $1 AND object_key = $2`, [userId, objectKey],
    );
    const grant = result.rows[0];
    if (!grant || (!grant.completedAt && new Date(grant.expiresAt).getTime() <= Date.now())) {
      throw new AppError(410, "LEGACY_LISTING_UPLOAD_GRANT_INVALID", "上传授权不存在或已过期，请重新上传");
    }
    const metadata = await readObjectMetadata(objectKey);
    if (!metadata || metadata.contentType.split(";", 1)[0].trim().toLowerCase() !== String(grant.contentType).toLowerCase() || metadata.sizeBytes !== Number(grant.sizeBytes)) {
      throw new AppError(409, "LEGACY_LISTING_OBJECT_METADATA_MISMATCH", "上传图片校验失败，请重新上传");
    }
    const publicUrl = publicUrlForObjectKey(objectKey);
    await pool.query(
      `INSERT INTO legacy_listing_uploads (id, user_id, sku, source_filename, object_key, public_url, content_type, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (object_key) DO UPDATE SET public_url = excluded.public_url`,
      [newId(), userId, grant.sku, grant.sourceFilename, objectKey, publicUrl, grant.contentType, grant.sizeBytes],
    );
    await pool.query("UPDATE legacy_listing_upload_grants SET completed_at = COALESCE(completed_at, now()) WHERE id = $1", [grant.id]);
    return { ok: true, publicUrl };
  });
}
