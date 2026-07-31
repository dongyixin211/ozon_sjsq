# Admin Console Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a data-management-first `/admin` console with server-backed ten-row pagination, complete CRUD lifecycle management, source-first gallery views, and aggregated user-side featured-gallery administration.

**Architecture:** Keep `/admin` as a token-protected static application, but split its stylesheet and JavaScript into dedicated public assets served by Fastify. Extend the existing `admin-routes.ts` route module and focused resource services with a shared pagination/deletion-state contract. Add migrations for soft-delete metadata and administrator-managed fields; do not change desktop or customer-facing navigation.

**Tech Stack:** TypeScript, Fastify 4, Zod, PostgreSQL, Node test runner, vanilla HTML/CSS/JavaScript, existing `@fastify/static`.

## Global Constraints

- Preserve `/admin` and the existing `x-admin-token` authentication model.
- Every data-list request uses `limit=10` unless an explicit future product requirement changes it.
- Every administrator delete is logical; physical-delete endpoints must not be added.
- Mockup results are derived media: never return them as standalone Gallery Assets or Featured Gallery rows.
- Featured Gallery lists existing `featured_gallery_assets` records used by the user-facing gallery; do not derive feature eligibility in the admin UI from orders.
- Keep all user-facing routes and unrelated desktop/web code unchanged.
- Do not add dependencies and do not create a git commit unless the user explicitly requests one.

---

## File Structure

- `server/migrations/032_admin_console_lifecycle.sql` — soft-delete fields, admin notes/source fields, indexes, and safe backfill defaults.
- `server/src/admin-pagination.ts` — shared query schema and pure page/deletion helpers used by every admin list route.
- `server/src/admin-pagination.test.ts` — isolated tests for the default ten-row pagination and deletion-state clauses.
- `server/src/routes/admin-routes.ts` — extend existing routes with uniform envelopes and CRUD/restore operations.
- `server/src/featured-gallery.ts` — preserve lifecycle fields when the existing featured-gallery refresh updates automatic records.
- `server/src/routes/gallery-routes.ts` — exclude logically deleted featured records from the user-facing featured list.
- `server/src/index.ts` — serve static admin CSS/JS assets below `/admin/assets/`.
- `server/src/public/admin.html` — semantic shell, grouped navigation, page roots, dialogs, and asset references.
- `server/src/public/admin/admin.css` — design tokens, responsive shell, tables, drawers, dialogs, badges, and gallery thumbnail layout.
- `server/src/public/admin/admin.js` — routing, list controllers, pagination, CRUD drawers, request normalization, and UI feedback.
- `server/scripts/verify-admin-static.mjs` — checks the split static assets and required administrator interactions.

## Task 1: Establish Admin Lifecycle Schema and Shared Page Contract

**Files:**
- Create: `server/migrations/032_admin_console_lifecycle.sql`
- Create: `server/src/admin-pagination.ts`
- Create: `server/src/admin-pagination.test.ts`
- Modify: `server/src/routes/admin-routes.ts:24-72`

**Interfaces:**
- Produces `adminListQuerySchema`, `AdminDeletionState`, and `adminDeletionClause(alias, state)` for every later admin route.
- Produces `deleted_at`, `deleted_by`, and feature metadata used by all restore endpoints.

- [ ] **Step 1: Write the failing pagination test**

```ts
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
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm --prefix server test -- admin-pagination.test.ts`

Expected: fail because `admin-pagination.ts` does not exist.

- [ ] **Step 3: Add the minimal shared page helper**

```ts
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
```

- [ ] **Step 4: Add a forward-only migration**

Create `032_admin_console_lifecycle.sql` that adds `deleted_at TIMESTAMPTZ`, `deleted_by TEXT`, and partial active-list indexes to `users`, `license_keys`, `order_postings`, `featured_gallery_assets`, `product_image_rules`, and the mockup-template table actually used by `mockup-template-service.ts`. Add `admin_note TEXT NOT NULL DEFAULT ''` and `source TEXT NOT NULL DEFAULT 'automatic'` to `featured_gallery_assets`, with `source` constrained to `automatic` or `manual`. Do not add columns already present on `gallery_assets`; add indexes only with `IF NOT EXISTS`.

- [ ] **Step 5: Replace local pagination defaults in `admin-routes.ts`**

Import `adminListQuerySchema`, change each paginated query schema to extend it, and remove the previous `default(20)` pagination schema. Keep each page-specific filter in its existing query schema.

- [ ] **Step 6: Run focused validation**

Run: `npm --prefix server test -- admin-pagination.test.ts && npm --prefix server run check`

Expected: passing helper tests and TypeScript with no errors.

## Task 2: Normalize Existing Account and License Management APIs

**Files:**
- Modify: `server/src/routes/admin-routes.ts:383-672`
- Modify: `server/src/public/admin/admin.js`
- Test: `server/src/admin-pagination.test.ts`

**Interfaces:**
- Consumes `adminListQuerySchema` and soft-delete fields from Task 1.
- Produces `GET /admin/users` and `GET /admin/license-keys` envelopes with `items`, `total`, `limit`, and `offset`; supports PUT, logical DELETE, and restore.

- [ ] **Step 1: Add failing static-contract checks**

Extend the test with required endpoint/action strings:

```ts
const routes = readFileSync(resolve(root, "src/routes/admin-routes.ts"), "utf8");
assert.match(routes, /app\.put\("\/admin\/users\/:userId"/);
assert.match(routes, /app\.post\("\/admin\/users\/:userId\/restore"/);
assert.match(routes, /app\.put\("\/admin\/license-keys\/:keyId"/);
assert.match(routes, /app\.post\("\/admin\/license-keys\/:keyId\/restore"/);
```

- [ ] **Step 2: Run the check and verify it fails**

Run: `node --import tsx --test server/src/admin-pagination.test.ts`

Expected: fail because the PUT and restore routes do not exist.

- [ ] **Step 3: Implement user CRUD lifecycle routes**

Add Zod bodies for editable profile/membership fields and a `PUT /admin/users/:userId` handler. Apply `adminDeletionClause("u", query.deletionState)` in both count and list queries. Change delete to set `deleted_at = now(), deleted_by = 'admin'`; add restore to clear both fields. Return the common list envelope and retain `users` as a compatibility alias only until the new admin script is switched.

- [ ] **Step 4: Implement license-key CRUD lifecycle routes**

Add an editable license-key schema containing plan, expiry, and status; add `PUT /admin/license-keys/:keyId` and restore. Change delete to update lifecycle fields instead of deleting. Preserve batch generation and current binding rules.

- [ ] **Step 5: Update the new frontend controller contract**

Make account list controllers read `data.items ?? data.users ?? data.keys`, then render the shared ten-row pager. New and edit drawers must call POST/PUT, delete must call DELETE, and deleted-state rows must expose restore rather than delete.

- [ ] **Step 6: Run verification**

Run: `node --import tsx --test server/src/admin-pagination.test.ts && npm --prefix server run check`

Expected: endpoint checks and TypeScript pass.

## Task 3: Implement Source-First Gallery and Featured-Gallery Administration

**Files:**
- Modify: `server/src/routes/admin-routes.ts:673-930`
- Modify: `server/src/featured-gallery.ts`
- Modify: `server/src/routes/gallery-routes.ts:640-740`
- Modify: `server/src/public/admin/admin.js`
- Test: `server/src/admin-pagination.test.ts`

**Interfaces:**
- Consumes source/result relationships in `gallery_mockup_results` and featured records in `featured_gallery_assets`.
- Produces `GET /admin/gallery-assets`, `GET /admin/featured-gallery`, their detail routes, and CRUD/restore routes with ten-row page envelopes.

- [ ] **Step 1: Add source/mockup separation tests**

```ts
const adminRoutes = readFileSync(resolve(root, "src/routes/admin-routes.ts"), "utf8");
assert.match(adminRoutes, /source_check\.result_asset_id = a\.id/);
assert.match(adminRoutes, /app\.get\("\/admin\/featured-gallery"/);
assert.match(adminRoutes, /app\.get\("\/admin\/gallery-assets\/:assetId"/);
```

- [ ] **Step 2: Run the check and verify it fails**

Run: `node --import tsx --test server/src/admin-pagination.test.ts`

Expected: fail because featured and gallery detail routes do not exist.

- [ ] **Step 3: Expand gallery list filtering and detail payload**

Extend `galleryAssetsQuerySchema` with `shopId`, date range, and `deletionState`. Keep the existing `NOT EXISTS` result-asset guard. Add a detail route that returns one source asset plus ordered `mockups`, `shopUsage`, and `orderSummary` arrays. Include mockup thumbnails only through `gallery_mockup_results.source_asset_id`.

- [ ] **Step 4: Add gallery source CRUD and restore routes**

Add POST/PUT routes for editable source metadata and lifecycle DELETE/restore. Do not create or edit mockup result rows from Gallery Assets. Ensure deletion state is applied to count and list SQL before limit/offset.

- [ ] **Step 5: Add featured-gallery aggregation routes**

Add `GET /admin/featured-gallery` and `GET /admin/featured-gallery/:featuredId` querying `featured_gallery_assets` joined to active source assets. Include owner, source thumbnail, feature status, note, source type, mockup count, shop use, and order summary. Add POST that accepts an existing source `assetId`, PUT for status/note, logical DELETE, and restore.

- [ ] **Step 6: Preserve user-side featured visibility**

Update `refreshFeaturedGallery` so automatic refresh ignores logically deleted feature rows and does not overwrite an administrator-managed note. Update the customer `/gallery/featured-assets` query with `f.deleted_at IS NULL` so removed records stop appearing to users.

- [ ] **Step 7: Render gallery details in the admin client**

Render exactly one top-level table row per source asset. The details drawer renders the source preview first, then the related mockup thumbnails. Reuse this drawer layout for featured records and never add mockup results to page totals.

- [ ] **Step 8: Run verification**

Run: `node --import tsx --test server/src/admin-pagination.test.ts && npm --prefix server run check`

Expected: source/mockup contract checks and TypeScript pass.

## Task 4: Complete Orders, Rules, Templates, and AI-Configuration APIs

**Files:**
- Modify: `server/src/routes/admin-routes.ts:121-194, 292-382, 814-930`
- Modify: `server/src/product-image-rules.ts`
- Modify: `server/src/mockup-template-service.ts`
- Modify: `server/src/public/admin/admin.js`
- Test: `server/src/admin-pagination.test.ts`

**Interfaces:**
- Consumes the shared lifecycle schema and page envelope.
- Produces paginated CRUD/restore APIs for orders, image rules, templates, and AI model configurations.

- [ ] **Step 1: Add missing API contract assertions**

```ts
for (const resource of ["orders", "product-image-rules", "mockup-templates", "ai-model-configs"]) {
  assert.match(adminRoutes, new RegExp(`/admin/${resource}`.replace(/[/-]/g, "\\$&")));
}
```

- [ ] **Step 2: Run the check and verify it fails**

Run: `node --import tsx --test server/src/admin-pagination.test.ts`

Expected: fail because `ai-model-configs` and restore routes are absent.

- [ ] **Step 3: Add lifecycle-aware order management**

Extend the current orders query with `deletionState`; return `items` and ten-row defaults. Add POST/PUT for administrator-managed fields and DELETE/restore for lifecycle state. Keep externally synchronized identifiers and expose a `source` marker rather than overwriting their origin.

- [ ] **Step 4: Convert rules and templates from upsert-only UI to explicit CRUD**

Add paginated GET routes, PUT routes, lifecycle DELETE/restore routes, and active/deleted filters. Preserve existing enable and publish actions as explicit state updates, but make them available inside the common row-action pattern.

- [ ] **Step 5: Introduce persisted AI model configurations**

Use the Task 1 migration to add an `admin_ai_model_configs` table containing provider, base URL, model, kind, active flag, lifecycle fields, and timestamps. Add list/create/update/delete/restore routes. Continue using the singleton `ai_settings` record only for the effective current selection; the AI page lists configurable model entries with default ten-row pagination.

- [ ] **Step 6: Run verification**

Run: `node --import tsx --test server/src/admin-pagination.test.ts && npm --prefix server run check`

Expected: contract tests and TypeScript pass.

## Task 5: Split and Rebuild the Administrator Shell

**Files:**
- Modify: `server/src/index.ts:159-202, 329-337`
- Modify: `server/src/public/admin.html`
- Create: `server/src/public/admin/admin.css`
- Create: `server/src/public/admin/admin.js`
- Modify: `server/scripts/verify-admin-static.mjs`

**Interfaces:**
- Consumes all Task 2–4 admin endpoints.
- Produces `/admin/assets/admin.css` and `/admin/assets/admin.js`, the grouped navigation shell, reusable drawers/dialogs, and route-aware page loading.

- [ ] **Step 1: Write failing static asset checks**

```js
assert(html.includes('<link rel="stylesheet" href="/admin/assets/admin.css"'));
assert(html.includes('<script type="module" src="/admin/assets/admin.js"></script>'));
assert(adminJs.includes('const PAGE_SIZE = 10'));
assert(adminJs.includes('function renderPager'));
```

- [ ] **Step 2: Run static verification and verify it fails**

Run: `node server/scripts/verify-admin-static.mjs`

Expected: fail because the external admin assets and fixed page-size constant do not exist.

- [ ] **Step 3: Serve the new static asset directory**

Register `@fastify/static` with `root: path.join(__dirname, "public/admin")`, `prefix: "/admin/assets/"`, and `decorateReply: false`. Keep the existing `/admin` and `/admin/ui/*` HTML routes unchanged.

- [ ] **Step 4: Replace the HTML with semantic page structure**

Retain the token input and client-side route behavior. Add grouped navigation sections for Dashboard, Accounts and Entitlements, Content Assets, Business Data, and System Configuration. Add roots for `featured-gallery` and `recycle-bin`, plus shared drawer, confirmation-dialog, and toast containers.

- [ ] **Step 5: Implement the approved visual system in CSS**

Use a calm neutral surface, a grouped sidebar, one blue action color, tabular data figures, compact tables, and accessible focus/hover states. Include responsive breakpoints that turn the sidebar into a horizontally scrollable navigation region and drawers into full-width panels on narrow screens.

- [ ] **Step 6: Build reusable client primitives**

Implement `requestAdmin`, `createListState`, `renderPager`, `openDrawer`, `openConfirmDialog`, `showToast`, and `reloadAfterMutation`. `createListState` must start with `{ limit: PAGE_SIZE, offset: 0 }`; `reloadAfterMutation` must decrement offset by ten only when the refreshed result has no rows and offset is positive.

- [ ] **Step 7: Run static and server build validation**

Run: `node server/scripts/verify-admin-static.mjs && npm --prefix server run check`

Expected: static checks and TypeScript pass.

## Task 6: Implement Page Controllers and Recycle Bin

**Files:**
- Modify: `server/src/public/admin/admin.js`
- Modify: `server/src/public/admin/admin.css`
- Modify: `server/scripts/verify-admin-static.mjs`

**Interfaces:**
- Consumes all normalized `items/total/limit/offset` list routes.
- Produces complete page controllers for overview, accounts, licenses, gallery, featured gallery, orders, templates, rules, AI configurations, and recycle bin.

- [ ] **Step 1: Add controller-presence checks**

```js
for (const page of ["users", "licenses", "gallery", "featured-gallery", "orders", "mockups", "image-rules", "ai-model-configs", "recycle-bin"]) {
  assert(adminJs.includes(`load${page.split("-").map(part => part[0].toUpperCase() + part.slice(1)).join("")}`));
}
assert(adminJs.includes('data-deletion-state'));
assert(adminJs.includes('恢复'));
```

- [ ] **Step 2: Run the verification and verify it fails**

Run: `node server/scripts/verify-admin-static.mjs`

Expected: fail because the new controllers, deletion-state selector, and restore actions are absent.

- [ ] **Step 3: Implement account, license, order, rules, templates, and AI controllers**

For each page, provide a page-specific filter builder, ten-row list request, row actions, create/edit drawer fields, delete confirmation, and restore row action. Use the common lifecycle filter; do not duplicate pager calculations.

- [ ] **Step 4: Implement Gallery and Featured Gallery controllers**

Gallery rows must show source thumbnail, SKU/file name, owner, ratio, mockup count, shop/order summary, and actions. Featured rows must show source image, owner, status, note, and associated summary. Both detail drawers must place the source preview before related mockups.

- [ ] **Step 5: Implement the recycle-bin aggregation view**

Load the existing resource list endpoints with `deletionState=deleted`, display a data-type filter and consistent ten-row pager per selected type, and only expose view and restore. Do not add a permanent-delete action.

- [ ] **Step 6: Run static verification**

Run: `node server/scripts/verify-admin-static.mjs`

Expected: all controller and lifecycle interaction checks pass.

## Task 7: Verify Migrations, API Contracts, and Browser Behavior

**Files:**
- Modify: `server/scripts/verify-admin-static.mjs`
- Test: `server/src/admin-pagination.test.ts`
- Validate: `server/migrations/032_admin_console_lifecycle.sql`

**Interfaces:**
- Consumes the complete implementation.
- Produces repeatable verification evidence for the redesigned administrator console.

- [ ] **Step 1: Expand automated static checks for the accepted constraints**

Add checks that confirm grouped menu labels, `PAGE_SIZE = 10`, gallery source-first detail rendering, featured-gallery controller, deletion-state filtering, restore actions, and the absence of permanent-delete labels.

- [ ] **Step 2: Run focused automated validation**

Run:

```powershell
node --import tsx --test server/src/admin-pagination.test.ts
node server/scripts/verify-admin-static.mjs
npm --prefix server run check
```

Expected: all commands exit successfully.

- [ ] **Step 3: Apply migration against the development database**

Run: `npm --prefix server run migrate`

Expected: `032_admin_console_lifecycle.sql` completes idempotently after existing migrations.

- [ ] **Step 4: Run browser acceptance checks**

Start the server with a development `ADMIN_TOKEN`, open `/admin`, and verify every sidebar route. For each data-list page, confirm default ten-row request, filters, create, edit, logical delete, deleted-state search, and restore. On Gallery Assets and Featured Gallery, confirm a mockup appears only in a source record’s detail drawer and does not change the source-row count.

- [ ] **Step 5: Record any unrelated pre-existing failures without modifying them**

If a broad check fails outside these files, capture its command and first failure only; do not change unrelated code.

## Plan Self-Review

- **Spec coverage:** Task 1 establishes ten-row pagination and lifecycle storage. Task 2 covers Users and Memberships plus License Keys. Task 3 covers source-first Gallery Assets and existing user-side Featured Gallery records, including the rule that derived mockups never appear as independent rows. Task 4 covers Orders and Shops, Mockup Templates, Product Image Rules, and AI model configurations. Tasks 5–6 implement the approved visual shell, complete menu controllers, and Recycle Bin. Task 7 validates the full lifecycle.
- **Completeness scan:** Every implementation step names concrete files, tests, endpoint shapes, or client functions; no deferred work markers remain.
- **Type consistency:** All list pages consume `{ ok, items, total, limit, offset }`; all lifecycle routes use `DELETE /admin/<resource>/:id` and `POST /admin/<resource>/:id/restore`; all client lists begin with `limit = 10`.

