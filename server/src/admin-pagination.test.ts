import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { adminListQuerySchema, adminDeletionClause } from "./admin-pagination.js";

test("admin lists default to ten active records", () => {
  assert.deepEqual(adminListQuerySchema.parse({}), { limit: 10, offset: 0, deletionState: "active" });
  assert.equal(adminDeletionClause("a", "active"), "a.deleted_at IS NULL");
});

test("admin lists can request deleted and all records", () => {
  assert.equal(adminDeletionClause("a", "deleted"), "a.deleted_at IS NOT NULL");
  assert.equal(adminDeletionClause("a", "all"), "TRUE");
});

test("admin account and license routes expose lifecycle contracts", () => {
  const routes = readFileSync(fileURLToPath(new URL("./routes/admin-routes.ts", import.meta.url)), "utf8");

  assert.match(routes, /app\.put\("\/admin\/users\/:userId"/);
  assert.match(routes, /app\.post\("\/admin\/users\/:userId\/restore"/);
  assert.match(routes, /app\.put\("\/admin\/license-keys\/:keyId"/);
  assert.match(routes, /app\.post\("\/admin\/license-keys\/:keyId\/restore"/);
  assert.match(routes, /adminDeletionClause\("u", query\.deletionState\)/);
  assert.match(routes, /adminDeletionClause\("k", query\.deletionState\)/);
  assert.ok((routes.match(/items: result\.rows/g) ?? []).length >= 2);
});

test("admin gallery routes separate source assets from featured management", () => {
  const adminRoutes = readFileSync(fileURLToPath(new URL("./routes/admin-routes.ts", import.meta.url)), "utf8");
  const galleryRoutes = readFileSync(fileURLToPath(new URL("./routes/gallery-routes.ts", import.meta.url)), "utf8");

  assert.match(adminRoutes, /source_check\.result_asset_id = a\.id/);
  assert.match(adminRoutes, /app\.get\("\/admin\/featured-gallery"/);
  assert.match(adminRoutes, /app\.get\("\/admin\/gallery-assets\/:assetId"/);
  assert.match(adminRoutes, /app\.post\("\/admin\/featured-gallery"/);
  assert.match(adminRoutes, /app\.post\("\/admin\/featured-gallery\/:featuredId\/restore"/);
  assert.match(galleryRoutes, /f\.deleted_at IS NULL/);
});
