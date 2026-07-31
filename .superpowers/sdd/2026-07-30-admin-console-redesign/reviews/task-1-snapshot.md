# Task 1 review snapshot

## Brief
# Task 1 — Establish Admin Lifecycle Schema and Shared Page Contract

Plan: docs/superpowers/plans/2026-07-30-admin-console-redesign.md

Ownership:
- server/migrations/032_admin_console_lifecycle.sql
- server/src/admin-pagination.ts
- server/src/admin-pagination.test.ts
- server/src/routes/admin-routes.ts (only imports and query schema defaults)

Constraints:
- No dependencies.
- Admin list default is limit=10 and exposes deletionState active/deleted/all.
- All future deletes must be logical; do not add physical deletes.
- Do not edit frontend or unrelated resources.
- Follow TDD: add a test, run it and observe failure, implement minimum code, rerun focused test and server typecheck.
- You are not alone in the codebase. Do not revert other agents' changes and adapt to concurrent edits.

Deliverable report:
- Write a concise report to .superpowers/sdd/2026-07-30-admin-console-redesign/reports/task-1.md.
- Include changed paths, exact commands/output summary, and any concerns.


## Implementer report
# Task 1 Report

## Changed paths

- `server/migrations/032_admin_console_lifecycle.sql`
- `server/src/admin-pagination.ts`
- `server/src/admin-pagination.test.ts`
- `server/src/routes/admin-routes.ts` 鈥?imports and paginated query-schema defaults only

## Verification

- `npm --prefix server test -- admin-pagination.test.ts` before implementation: failed as expected with `ERR_MODULE_NOT_FOUND` for `server/src/admin-pagination.js`; 25 existing tests passed and the new test failed.
- `npm --prefix server test -- admin-pagination.test.ts` after implementation: passed, 27 tests passed, 0 failed.
- `npm --prefix server run check`: passed; TypeScript emitted no errors.

## Implementation

- Added the shared `adminListQuerySchema` with `limit=10`, `offset=0`, and `deletionState=active` defaults.
- Added `AdminDeletionState` and `adminDeletionClause()` for active, deleted, and all records.
- Updated the four existing paginated admin query schemas to extend the shared schema and removed the old `default(20)` schema.
- Added lifecycle columns, featured-gallery metadata, source validation, and partial active-list indexes. The existing license-key table is named `authorization_keys`.

## Self-review

- No `paginationSchema` or `default(20)` remains in `admin-routes.ts`.
- The migration does not add duplicate lifecycle columns to `gallery_assets`.
- The migration contains no physical delete statements.
- The route file changes remain limited to the import and query-schema section.

## Concerns

- Existing physical-delete handlers in `admin-routes.ts` remain unchanged because this task鈥檚 ownership limits route edits to imports/query schemas; later lifecycle tasks must convert them to logical deletes.
- The migration was not applied to a database in this task; validation covered the TypeScript contract and focused tests only.


## server/src/admin-pagination.ts
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


## server/src/admin-pagination.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { adminListQuerySchema, adminDeletionClause } from "./admin-pagination.js";

test("admin lists default to ten active records", () => {
  assert.deepEqual(adminListQuerySchema.parse({}), { limit: 10, offset: 0, deletionState: "active" });
  assert.equal(adminDeletionClause("a", "active"), "a.deleted_at IS NULL");
});

test("admin lists can request deleted and all records", () => {
  assert.equal(adminDeletionClause("a", "deleted"), "a.deleted_at IS NOT NULL");
  assert.equal(adminDeletionClause("a", "all"), "TRUE");
});


## server/migrations/032_admin_console_lifecycle.sql
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by TEXT;

ALTER TABLE authorization_keys
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by TEXT;

ALTER TABLE order_postings
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by TEXT;

ALTER TABLE featured_gallery_assets
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by TEXT,
  ADD COLUMN IF NOT EXISTS admin_note TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'automatic';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'featured_gallery_assets_source_check'
      AND conrelid = 'featured_gallery_assets'::regclass
  ) THEN
    ALTER TABLE featured_gallery_assets
      ADD CONSTRAINT featured_gallery_assets_source_check
      CHECK (source IN ('automatic', 'manual'));
  END IF;
END
$$;

ALTER TABLE product_image_rules
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by TEXT;

ALTER TABLE mockup_templates
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by TEXT;

CREATE INDEX IF NOT EXISTS users_active_created_at_desc_idx
  ON users (created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS authorization_keys_active_created_at_desc_idx
  ON authorization_keys (created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS order_postings_active_in_process_at_desc_idx
  ON order_postings (in_process_at DESC NULLS LAST, synced_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS featured_gallery_assets_active_status_score_idx
  ON featured_gallery_assets (status, score DESC, last_ordered_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS product_image_rules_active_updated_at_desc_idx
  ON product_image_rules (updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS mockup_templates_active_updated_at_desc_idx
  ON mockup_templates (updated_at DESC)
  WHERE deleted_at IS NULL;


## Relevant admin-routes imports and schemas
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { planRules, type PlanCode } from "../config.js";
import { requireAdminToken } from "../auth.js";
import { readAiSettings, toPublicAiSettings } from "../ai-settings.js";
import { discoverAiModels } from "../ai-model-service.js";
import { pool, withTransaction } from "../db.js";
import { AppError } from "../errors.js";
import { adminListQuerySchema } from "../admin-pagination.js";
import {
  listAdminMockupTemplates,
  runMockupTemplatePreviewTest,
  saveConvertedMockupTemplateFiles,
  saveMockupTemplatePsd,
  setMockupTemplateStatus,
  upsertAdminMockupTemplate,
  type MockupTemplateStatus,
} from "../mockup-template-service.js";
import {
  listProductImageRules,
  productImageRuleSchema,
  setProductImageRuleEnabled,
  upsertProductImageRule,
} from "../product-image-rules.js";
import { newId, makeLicenseKey, sha256Hex } from "../security.js";

const createKeysSchema = z.object({
  plan: z.enum(["monthly", "quarterly", "yearly"]),
  count: z.number().int().min(1).max(200).default(1),
});

const usersQuerySchema = adminListQuerySchema.extend({
  keyword: z.string().trim().max(120).optional().default(""),
  membership: z.enum(["all", "active", "expired", "none"]).default("all"),
});

const userStorageLimitSchema = z.object({
  limitGb: z.coerce.number().min(0).max(1024),
});

const licenseKeysQuerySchema = adminListQuerySchema.extend({
  status: z.enum(["all", "unused", "redeemed", "disabled"]).default("all"),
  plan: z.enum(["all", "monthly", "quarterly", "yearly"]).default("all"),
  keyword: z.string().trim().max(80).optional().default(""),
});

const galleryAssetsQuerySchema = adminListQuerySchema.extend({
  ratioFamily: z.enum(["all", "portrait", "square", "landscape", "wide"]).default("all"),
  keyword: z.string().trim().max(120).optional().default(""),
  userId: z.string().uuid().optional(),
  mockupStatus: z.enum(["all", "with", "without"]).default("all"),
  orderedStatus: z.enum(["all", "ordered", "not_ordered"]).default("all"),
});

const overviewQuerySchema = z.object({
  period: z.enum(["7d", "30d", "1y", "all"]).default("7d"),
});

const adminDateStringSchema = z.union([
  z.literal(""),
  z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
]);

const adminOrdersQuerySchema = adminListQuerySchema.extend({
  period: z.enum(["today", "7d", "30d", "1y", "all"]).default("today"),
  dateFrom: adminDateStringSchema.optional().default(""),
  dateTo: adminDateStringSchema.optional().default(""),
  userId: z.string().uuid().optional(),
  externalShopId: z.string().trim().max(120).optional().default(""),
  category: z.string().trim().max(120).optional().default(""),
  status: z.string().trim().max(80).optional().default(""),
  keyword: z.string().trim().max(160).optional().default(""),
});

const mockupTemplateSchema = z.object({
  id: z.string().trim().min(2).max(80),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(""),
  productType: z.string().trim().max(120).default(""),
  sourceAspectRatio: z.string().trim().max(80).default(""),
});

const mockupStatusSchema = z.object({
  status: z.enum(["draft", "published", "disabled"]),
});

const productImageRuleStatusSchema = z.object({
  enabled: z.boolean(),
});

const aiSettingsSchema = z.object({
  imageProvider: z.string().min(1).max(80),
  imageBaseUrl: z.string().url(),
  imageModel: z.string().min(1).max(120),
  imageApiKey: z.string().optional(),
  textProvider: z.string().min(1).max(80),
  textBaseUrl: z.string().url(),
  textModel: z.string().min(1).max(120),
  textApiKey: z.string().optional(),
  imagePromptTemplate: z.string().max(8000).default(""),

