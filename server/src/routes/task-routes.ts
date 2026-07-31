import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireMembership } from "../auth.js";
import { pool } from "../db.js";

const jobStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
const jobKindSchema = z.enum([
  "materials",
  "scene_local",
  "scene_ai",
  "auto_listing",
  "batch_upload",
  "listing_image_repair",
  "listed_update",
  "follow_sync",
  "follow_automation",
  "inventory",
  "barcode",
  "order_documents",
  "api_test",
]);

const taskHistoryJobSchema = z.object({
  id: z.string().min(1).max(120),
  kind: jobKindSchema,
  title: z.string().min(1).max(240),
  status: jobStatusSchema,
  progress: z.coerce.number().int().min(0).max(100),
  inputPath: z.string().max(2000).nullish(),
  outputPath: z.string().max(2000).nullish(),
  resultPath: z.string().max(2000).nullish(),
  resultExcelPath: z.string().max(2000).nullish(),
  successCount: z.coerce.number().int().min(0).nullish(),
  failedCount: z.coerce.number().int().min(0).nullish(),
  lastError: z.string().max(8000).nullish(),
  error: z.string().max(8000).nullish(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

const taskHistoryLogSchema = z.object({
  id: z.string().min(1).max(160),
  jobId: z.string().min(1).max(120),
  level: z.enum(["info", "warn", "error"]),
  message: z.string().min(1).max(16000),
  createdAt: z.coerce.date(),
});

const syncTaskHistorySchema = z.object({
  jobs: z.array(taskHistoryJobSchema).max(200),
  logs: z.array(taskHistoryLogSchema).max(2000),
});

export async function taskRoutes(app: FastifyInstance) {
  app.get("/tasks/history", { preHandler: [requireAuth, requireMembership] }, async (request) => {
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(request.query);
    const result = await pool.query(
      `
      SELECT
        id,
        kind,
        title,
        status,
        progress,
        input_path AS "inputPath",
        output_path AS "outputPath",
        result_path AS "resultPath",
        result_excel_path AS "resultExcelPath",
        success_count AS "successCount",
        failed_count AS "failedCount",
        last_error AS "lastError",
        error,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM task_history
      WHERE user_id = $1
      ORDER BY updated_at DESC
      LIMIT $2 OFFSET $3
      `,
      [request.currentUser!.id, query.limit, query.offset],
    );
    return { ok: true, jobs: result.rows, limit: query.limit, offset: query.offset };
  });

  app.get("/tasks/history/:jobId/logs", { preHandler: [requireAuth, requireMembership] }, async (request) => {
    const params = z.object({ jobId: z.string().min(1).max(120) }).parse(request.params);
    const result = await pool.query(
      `
      SELECT
        id,
        job_id AS "jobId",
        level,
        message,
        created_at AS "createdAt"
      FROM task_history_logs
      WHERE user_id = $1 AND job_id = $2
      ORDER BY created_at ASC
      `,
      [request.currentUser!.id, params.jobId],
    );
    return { ok: true, logs: result.rows };
  });

  app.post("/tasks/history/sync", { preHandler: [requireAuth, requireMembership] }, async (request) => {
    const body = syncTaskHistorySchema.parse(request.body);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const job of body.jobs) {
        await client.query(
          `
          INSERT INTO task_history (
            id,
            user_id,
            kind,
            title,
            status,
            progress,
            input_path,
            output_path,
            result_path,
            result_excel_path,
            success_count,
            failed_count,
            last_error,
            error,
            created_at,
            updated_at,
            synced_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now())
          ON CONFLICT (user_id, id)
          DO UPDATE SET
            kind = excluded.kind,
            title = excluded.title,
            status = excluded.status,
            progress = excluded.progress,
            input_path = excluded.input_path,
            output_path = excluded.output_path,
            result_path = excluded.result_path,
            result_excel_path = excluded.result_excel_path,
            success_count = excluded.success_count,
            failed_count = excluded.failed_count,
            last_error = excluded.last_error,
            error = excluded.error,
            created_at = LEAST(task_history.created_at, excluded.created_at),
            updated_at = GREATEST(task_history.updated_at, excluded.updated_at),
            synced_at = now()
          `,
          [
            job.id,
            request.currentUser!.id,
            job.kind,
            job.title,
            job.status,
            job.progress,
            job.inputPath ?? null,
            job.outputPath ?? null,
            job.resultPath ?? null,
            job.resultExcelPath ?? null,
            job.successCount ?? null,
            job.failedCount ?? null,
            job.lastError ?? null,
            job.error ?? null,
            job.createdAt,
            job.updatedAt,
          ],
        );
      }
      for (const log of body.logs) {
        await client.query(
          `
          INSERT INTO task_history_logs (id, user_id, job_id, level, message, created_at, synced_at)
          VALUES ($1, $2, $3, $4, $5, $6, now())
          ON CONFLICT (user_id, id)
          DO UPDATE SET
            job_id = excluded.job_id,
            level = excluded.level,
            message = excluded.message,
            created_at = excluded.created_at,
            synced_at = now()
          `,
          [log.id, request.currentUser!.id, log.jobId, log.level, log.message, log.createdAt],
        );
      }
      await client.query("COMMIT");
      return { ok: true, jobsSynced: body.jobs.length, logsSynced: body.logs.length };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}
