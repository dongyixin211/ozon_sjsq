import "dotenv/config";
import { pool, withTransaction } from "../src/db.js";
import { deleteObject } from "../src/storage.js";
import {
  LEGACY_LISTING_UPLOAD_RETENTION_DAYS,
  isEligibleLegacyListingUpload,
  isLegacyListingObjectKey,
  summarizeLegacyListingCleanup,
  type LegacyListingCleanupCandidate,
} from "../src/legacy-listing-upload-cleanup.js";
import { newId } from "../src/security.js";

const retentionDays = positiveInt(process.env.LEGACY_LISTING_UPLOAD_RETENTION_DAYS, LEGACY_LISTING_UPLOAD_RETENTION_DAYS);
const batchSize = positiveInt(process.env.LEGACY_LISTING_UPLOAD_CLEANUP_BATCH_SIZE, 200);
const deleteRequested = process.argv.includes("--delete") || process.env.LEGACY_LISTING_UPLOAD_CLEANUP_DELETE === "true";
const statusOnly = process.argv.includes("--status");
const now = new Date();

type UploadRow = LegacyListingCleanupCandidate;
type GrantRow = { userId: string; objectKey: string; sizeBytes: number; expiresAt: Date };

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function formatBytes(value: number) {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

async function loadCandidates() {
  const result = await pool.query<UploadRow>(
    `SELECT l.user_id AS "userId", l.object_key AS "objectKey", l.size_bytes AS "sizeBytes", l.created_at AS "createdAt",
            EXISTS (
              SELECT 1 FROM legacy_listing_upload_grants g
              WHERE g.user_id = l.user_id AND g.object_key = l.object_key
                AND g.completed_at IS NULL AND g.expires_at > now()
            ) AS "hasActiveGrant"
       FROM legacy_listing_uploads l
      WHERE l.created_at < now() - ($1::int * interval '1 day')
      ORDER BY l.created_at ASC
      LIMIT $2`,
    [retentionDays, batchSize],
  );
  return result.rows.map((row) => ({
    ...row,
    sizeBytes: Number(row.sizeBytes),
    createdAt: new Date(row.createdAt),
    hasActiveGrant: Boolean(row.hasActiveGrant),
  }));
}

async function loadExpiredGrants() {
  const result = await pool.query<GrantRow>(
    `SELECT user_id AS "userId", object_key AS "objectKey", size_bytes AS "sizeBytes", expires_at AS "expiresAt"
       FROM legacy_listing_upload_grants
      WHERE completed_at IS NULL AND expires_at <= now()
      ORDER BY expires_at ASC
      LIMIT $1`,
    [batchSize],
  );
  return result.rows.map((row) => ({ ...row, sizeBytes: Number(row.sizeBytes), expiresAt: new Date(row.expiresAt) }));
}

async function audit(input: { userId: string; objectKey: string; sizeBytes: number; action: string; status: string; errorMessage?: string }) {
  await pool.query(
    `INSERT INTO legacy_listing_upload_cleanup_audit (id, user_id, object_key, size_bytes, action, status, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [newId(), input.userId, input.objectKey, input.sizeBytes, input.action, input.status, input.errorMessage ?? null],
  );
}

async function deleteCompleted(rows: UploadRow[]) {
  let deletedBytes = 0;
  let deletedRows = 0;
  for (const row of rows) {
    if (!isLegacyListingObjectKey(row.objectKey, row.userId) || !isEligibleLegacyListingUpload(row, now, retentionDays)) {
      await audit({ ...row, action: "record_delete", status: "skipped", errorMessage: "保留期或活动授权保护" });
      continue;
    }
    try {
      await deleteObject(row.objectKey);
      const removed = await withTransaction(async (client) => {
        const result = await client.query(
          `DELETE FROM legacy_listing_uploads l
            WHERE l.user_id = $1 AND l.object_key = $2
              AND NOT EXISTS (
                SELECT 1 FROM legacy_listing_upload_grants g
                 WHERE g.user_id = l.user_id AND g.object_key = l.object_key
                   AND g.completed_at IS NULL AND g.expires_at > now()
              )
            RETURNING size_bytes`,
          [row.userId, row.objectKey],
        );
        if (result.rowCount !== 1) return false;
        await client.query(
          `INSERT INTO legacy_listing_upload_cleanup_audit (id, user_id, object_key, size_bytes, action, status)
           VALUES ($1, $2, $3, $4, 'record_delete', 'deleted')`,
          [newId(), row.userId, row.objectKey, row.sizeBytes],
        );
        return true;
      });
      if (removed) {
        deletedRows += 1;
        deletedBytes += row.sizeBytes;
      }
    } catch (error) {
      await audit({ ...row, action: "object_delete", status: "failed", errorMessage: error instanceof Error ? error.message : String(error) });
    }
  }
  return { deletedRows, deletedBytes };
}

async function deleteExpiredGrants(rows: GrantRow[]) {
  let deletedRows = 0;
  for (const row of rows) {
    if (!isLegacyListingObjectKey(row.objectKey, row.userId)) {
      await audit({ ...row, action: "grant_delete", status: "skipped", errorMessage: "对象路径不属于用户" });
      continue;
    }
    try {
      await deleteObject(row.objectKey);
      const result = await pool.query(
        `DELETE FROM legacy_listing_upload_grants
          WHERE user_id = $1 AND object_key = $2 AND completed_at IS NULL AND expires_at <= now()` ,
        [row.userId, row.objectKey],
      );
      if (result.rowCount === 1) {
        deletedRows += 1;
        await audit({ ...row, action: "grant_delete", status: "deleted" });
      }
    } catch (error) {
      await audit({ ...row, action: "grant_delete", status: "failed", errorMessage: error instanceof Error ? error.message : String(error) });
    }
  }
  return { deletedRows };
}

try {
  const [candidates, expiredGrants] = await Promise.all([loadCandidates(), loadExpiredGrants()]);
  const summary = summarizeLegacyListingCleanup(candidates, now, retentionDays);
  const output: Record<string, unknown> = {
    ok: true,
    mode: deleteRequested ? "delete" : statusOnly ? "status" : "dry_run",
    retentionDays,
    candidates: candidates.length,
    eligible: summary.eligible.length,
    protected: summary.protectedCount,
    reclaimableBytes: summary.eligibleBytes,
    reclaimable: formatBytes(summary.eligibleBytes),
    expiredGrantCandidates: expiredGrants.length,
  };
  if (deleteRequested) {
    const completed = await deleteCompleted(candidates);
    const grants = await deleteExpiredGrants(expiredGrants);
    output.deletedRows = completed.deletedRows;
    output.deletedBytes = completed.deletedBytes;
    output.deleted = formatBytes(completed.deletedBytes);
    output.deletedExpiredGrants = grants.deletedRows;
  } else {
    for (const row of summary.eligible) await audit({ ...row, action: "record_delete", status: "dry_run" });
  }
  console.log(JSON.stringify(output, null, 2));
} finally {
  await pool.end();
}
