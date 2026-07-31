import { z } from "zod";

export type AdminDeletionState = "active" | "deleted" | "all";

export const adminListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
  offset: z.coerce.number().int().min(0).default(0),
  deletionState: z.enum(["active", "deleted", "all"]).default("active"),
});

export function adminDeletionClause(alias: string, state: AdminDeletionState) {
  if (state === "deleted") return `${alias}.deleted_at IS NOT NULL`;
  if (state === "all") return "TRUE";
  return `${alias}.deleted_at IS NULL`;
}
