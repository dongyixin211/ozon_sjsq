import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readSource(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

test("admin console exposes password login and a dedicated bearer-token guard", () => {
  const routes = readSource("./routes/admin-routes.ts");
  const auth = readSource("./auth.ts");
  const security = readSource("./security.ts");

  assert.match(routes, /app\.post\("\/admin\/auth\/login"/);
  assert.match(auth, /export async function requireAdminSession/);
  assert.match(security, /export function createAdminToken/);
});

test("admin business routes no longer depend on ADMIN_TOKEN", () => {
  const routes = readSource("./routes/admin-routes.ts");
  const adminHtml = readSource("./public/admin.html");

  assert.doesNotMatch(routes, /requireAdminToken/);
  assert.doesNotMatch(adminHtml, /x-admin-token/);
  assert.doesNotMatch(adminHtml, /ADMIN_TOKEN/);
});


test("admin console contains collapsed navigation and RBAC management pages", () => {
  const adminHtml = readSource("./public/admin.html");

  assert.match(adminHtml, /data-nav-group/);
  assert.match(adminHtml, /toggleNavGroup/);
  assert.match(adminHtml, /data-page-link="roles"/);
  assert.match(adminHtml, /data-page-link="features"/);
  assert.match(adminHtml, /data-page-link="auditLogs"/);
  assert.match(adminHtml, /\/admin\/features/);
  assert.match(adminHtml, /\/admin\/audit-logs/);
});


test("multi-role administration stores role sets and audits with the admin session", () => {
  const routes = readSource("./routes/admin-routes.ts");
  const features = readSource("./feature-service.ts");
  const migration = readSource("../migrations/040_user_roles.sql");
  const adminHtml = readSource("./public/admin.html");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS user_roles/);
  assert.match(routes, /roles: z\.array\(z\.enum\(\["member", "beta", "admin"\]\)\)/);
  assert.match(routes, /request\.currentAdmin\?\.userId \?\? null/);
  assert.match(features, /roles: string\[\]/);
  assert.match(adminHtml, /data-role-checkbox/);
  assert.match(adminHtml, /\/admin\/auth\/session/);
});


test("role and feature controls use compact Chinese role chips", () => {
  const adminHtml = readSource("./public/admin.html");

  assert.match(adminHtml, /role-chip-group/);
  assert.match(adminHtml, /data-role-chip/);
  assert.match(adminHtml, /feature\.label/);
  assert.match(adminHtml, /feature\.module/);
  assert.match(adminHtml, /renderRoleBadges\(user\.roles/);
});

test("admin page initializes navigation metadata before rendering the current page", () => {
  const adminHtml = readSource("./public/admin.html");
  const pageGroupIndex = adminHtml.indexOf("const pageGroup =");
  const initialShowPageIndex = adminHtml.indexOf("showPage(routePage(), { skipLoad: true });");

  assert.ok(pageGroupIndex >= 0, "pageGroup metadata must exist");
  assert.ok(initialShowPageIndex >= 0, "initial page render must exist");
  assert.ok(pageGroupIndex < initialShowPageIndex, "navigation metadata must initialize before showPage runs");
});
test("role page replaces the loading message after its data request completes", () => {
  const adminHtml = readSource("./public/admin.html");

  assert.match(adminHtml, /if \(!options\.silent\) setMessage\("用户角色已刷新"\);/);
});
test("admin user list returns the complete role set", () => {
  const routes = readSource("./routes/admin-routes.ts");

  assert.match(routes, /json_agg\(ur\.role/);
  assert.match(routes, /fu\.roles/);
});
