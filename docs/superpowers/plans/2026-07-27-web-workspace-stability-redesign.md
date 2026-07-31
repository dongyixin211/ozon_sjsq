# Web Workspace Stability, Redesign, and Full Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix order and template consistency defects, simplify the browser workspace into five primary modules without removing functionality, unify the visual system, and produce a full non-destructive project function and data-consistency audit.

**Architecture:** Keep the Tauri client as a lightweight local assistant and make all business-interface changes in the browser workspace rendered by `App.tsx`. Separate server data, query state, editable drafts, and persisted preferences; introduce pure helpers for order-query and listing-setup state so race conditions can be tested without external services. Preserve existing feature components and migrate navigation and layout incrementally rather than rewriting business logic.

**Tech Stack:** React 18, TypeScript 5.6, Vitest, Testing Library, Vite, Rust/Tauri 2, Fastify, PostgreSQL, Zod

## Global Constraints

- The Tauri client remains a lightweight local assistant and does not receive the complete browser workspace UI.
- No existing user-facing feature is deleted.
- Primary navigation is reduced to Home, Assets, Listing, Orders, and Tasks/Settings.
- External publishing, shipping, deletion, paid AI generation, and other irreversible actions are not executed against production services.
- Every behavioral fix follows RED-GREEN-REFACTOR and has a regression test that fails before implementation.
- Server data, list query state, edit drafts, and persisted preferences remain separate.
- Only the latest asynchronous request may write order or template state.
- Data-consistency invariants in `docs/superpowers/specs/2026-07-27-web-workspace-stability-redesign.md` are blocking acceptance criteria.
- Git is unavailable in the current environment; replace commit steps with verified checkpoints and do not fabricate commit claims.

---

### Task 1: Establish the Full-Project Baseline

**Files:**
- Create: `docs/testing/2026-07-27-baseline-audit.md`
- Inspect: `package.json`
- Inspect: `server/package.json`
- Inspect: `src-tauri/Cargo.toml`
- Inspect: all existing `*.test.ts` and `*.test.tsx` files

**Interfaces:**
- Consumes: existing build scripts, test suites, and project modules.
- Produces: a baseline report listing commands, pass/fail counts, known warnings, uncovered modules, and externally blocked checks.

- [ ] **Step 1: Inventory executable surfaces**

Record browser pages, Tauri commands, server route groups, database migrations, background jobs, and existing automated test files in `docs/testing/2026-07-27-baseline-audit.md`.

- [ ] **Step 2: Run the root frontend test baseline**

Run: `npm test`
Expected: Record exact test files, test count, failures, and warnings without changing code.

- [ ] **Step 3: Run browser-workspace builds**

Run: `npm run build`
Run: `npm run build:web`
Expected: Record exit codes and current Vite warnings.

- [ ] **Step 4: Run Rust baseline checks**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
Expected: Record exact pass/fail status. Do not format unrelated files during baseline capture.

- [ ] **Step 5: Run cloud-server static checks**

Run from `server`: `npm run check`
Run from `server`: `npm run build`
Expected: Record exact pass/fail status and missing-environment limitations.

- [ ] **Step 6: Mark baseline checkpoint**

Update the audit document with defects that predate this project phase, separating them from new regressions introduced later.

### Task 2: Correct Order Status Queries and Counts

**Files:**
- Create: `src/features/orders/orderQueryUtils.ts`
- Create: `src/features/orders/orderQueryUtils.test.ts`
- Modify: `src/features/orders/OrdersPage.tsx:90-310`
- Modify: `src/features/orders/OrdersPage.test.tsx`

**Interfaces:**
- Consumes: `StoredOrderQuery`, current status, shop IDs, keyword, limit, and request sequence numbers.
- Produces: `resolveStoredOrderQuery(input): StoredOrderQuery`, `isLatestOrderRequest(requestId, latestId): boolean`, and independent `summaryRows` state.

- [ ] **Step 1: Write the failing “all status” utility test**

Add a literal test asserting that an explicit empty status produces `status: undefined` in the API query and never falls back to the previous `awaiting_packaging` state.

- [ ] **Step 2: Run the focused utility test for RED**

Run: `npm test -- src/features/orders/orderQueryUtils.test.ts`
Expected: FAIL because `resolveStoredOrderQuery` does not exist.

- [ ] **Step 3: Implement the minimal query resolver**

Use property-presence semantics rather than nullish fallback so `status: ""` means “all statuses” while an omitted override means “use current status.”

- [ ] **Step 4: Write the failing component regression test**

Mock two responses: waiting-for-packaging followed by all orders. Click “等待备货,” then “全部,” and assert the second `api.listSavedOrderPostings` call omits `status` and renders the all-order fixture.

- [ ] **Step 5: Run the component test for RED**

Run: `npm test -- src/features/orders/OrdersPage.test.tsx`
Expected: FAIL because `applyStatusFilter` currently passes `undefined` and reloads the old status.

- [ ] **Step 6: Wire the query resolver into OrdersPage**

Make every load call pass a complete query object. Clear `selectedKeys` after a successful query and retain the current keyword, shop IDs, and limit.

- [ ] **Step 7: Write the failing stale-response test**

Resolve the “全部” request before the older “等待备货” request and assert the older response cannot overwrite the latest list.

- [ ] **Step 8: Add latest-request protection**

Use an incrementing request ID ref around saved-order loads. Only the latest request may update rows, summary rows, selection, or message.

- [ ] **Step 9: Separate list rows from summary rows**

Load unfiltered-by-status summary data for the same shop and keyword scope. Compute status counts from `summaryRows`, not the filtered list.

- [ ] **Step 10: Verify order tests**

Run: `npm test -- src/features/orders/orderQueryUtils.test.ts src/features/orders/OrdersPage.test.tsx`
Expected: PASS with regression coverage for all-status, counts, selection clearing, and stale responses.

### Task 3: Make Listing Template Initialization Deterministic

**Files:**
- Create: `src/features/cloud/listingSetupUtils.ts`
- Create: `src/features/cloud/listingSetupUtils.test.ts`
- Modify: `src/features/cloud/GalleryManager.tsx:312-787`
- Modify: `src/features/cloud/GalleryManager.test.tsx`

**Interfaces:**
- Consumes: cloud shops, local shops, cloud product templates, local Ozon templates, saved `CloudListingPreferences`, and current edit state.
- Produces: `buildInitialListingSetup(input): ListingSetupSnapshot`, `mergeListingShops(input): ShopListingConfig[]`, and an initialization phase of `loading | ready | error`.

- [ ] **Step 1: Write failing merge-order tests**

Cover both response orders: preferences before shops and shops before preferences. Assert identical final shop configs, product template IDs, template names, shared flags, and local template IDs.

- [ ] **Step 2: Run utility tests for RED**

Run: `npm test -- src/features/cloud/listingSetupUtils.test.ts`
Expected: FAIL because deterministic setup helpers do not exist.

- [ ] **Step 3: Implement minimal pure setup helpers**

Preserve saved configs by stable external shop ID, append missing active shops with defaults, and never drop a saved config solely because one asynchronous source has not loaded yet.

- [ ] **Step 4: Write the failing no-autosave-before-ready test**

Render `GalleryManager` with delayed shops/templates/preferences promises and assert `client.saveListingPreferences` is not called until all initialization inputs settle.

- [ ] **Step 5: Run GalleryManager test for RED**

Run: `npm test -- src/features/cloud/GalleryManager.test.tsx`
Expected: FAIL because current independent effects can create defaults and autosave before all sources settle.

- [ ] **Step 6: Introduce coordinated initialization**

Replace independent first-render setup writes with one coordinated initialization result. Set `listingPreferencesLoaded` and the new ready phase only after cloud templates, local templates, preferences, and initial shop sources have settled.

- [ ] **Step 7: Preserve unresolved saved selections visibly**

If a saved cloud or local template ID is absent after loading, keep the saved ID in the config and render a disabled “模板不可用” option plus a warning instead of silently clearing it.

- [ ] **Step 8: Save template and preference atomically at UI level**

After `saveProductTemplateForShop` succeeds, update the template collection and shop config, then save the resulting listing preferences using the updated config snapshot rather than waiting for a later stale-state effect.

- [ ] **Step 9: Group all available product templates**

Render shared templates, current-shop templates, and other available templates in explicit groups. Do not slice or truncate template arrays.

- [ ] **Step 10: Add refresh-and-restore regression test**

Save multiple shop configs, unmount, remount with saved preferences, and assert every product template and local Ozon template selection is restored without a second manual configuration.

- [ ] **Step 11: Verify listing setup tests**

Run: `npm test -- src/features/cloud/listingSetupUtils.test.ts src/features/cloud/GalleryManager.test.tsx`
Expected: PASS with both asynchronous response orders and refresh restoration covered.

### Task 4: Define the Five-Module Workspace Navigation

**Files:**
- Create: `src/workspace/navigation.ts`
- Create: `src/workspace/navigation.test.ts`
- Create: `src/workspace/WorkspaceModuleTabs.tsx`
- Create: `src/workspace/WorkspaceModuleTabs.test.tsx`
- Modify: `src/App.tsx:45-370`

**Interfaces:**
- Consumes: existing `PageKey` values and navigation callbacks.
- Produces: `WorkspaceModuleKey`, `workspaceModules`, `moduleForPage(page)`, and reusable module tabs that preserve existing page keys.

- [ ] **Step 1: Write the failing navigation mapping test**

Assert every existing `PageKey` belongs to exactly one of five modules and no existing feature page is omitted.

- [ ] **Step 2: Run navigation test for RED**

Run: `npm test -- src/workspace/navigation.test.ts`
Expected: FAIL because workspace module mapping does not exist.

- [ ] **Step 3: Implement the static module map**

Map pages to Home, Assets, Listing, Orders, and Tasks/Settings while retaining current page keys and component rendering.

- [ ] **Step 4: Write the failing module-tab behavior test**

Assert asset subpages and listing subpages render as internal tabs, keep the active page selected, and call the existing navigation callback.

- [ ] **Step 5: Implement WorkspaceModuleTabs**

Use buttons with accessible names and active state. Do not duplicate business content or state.

- [ ] **Step 6: Replace the dense sidebar hierarchy**

Render five primary modules in the sidebar. Render the active module’s child pages as tabs below the top bar. Keep task count, local-assistant status, refresh, and open-workspace actions.

- [ ] **Step 7: Verify all existing pages remain reachable**

Run navigation tests and add an App-level test or pure reachability assertion proving all current `PageKey` values appear in either a primary module or module tab.

- [ ] **Step 8: Verify navigation tests**

Run: `npm test -- src/workspace/navigation.test.ts src/workspace/WorkspaceModuleTabs.test.tsx`
Expected: PASS.

### Task 5: Introduce a Consistent Workspace Visual System

**Files:**
- Modify: `src/styles.css:1-220`
- Modify: `src/styles.css:2400-2600`
- Modify: `src/styles.css:3600-3980`
- Modify: `src/App.tsx:254-325`
- Modify: `src/features/dashboard/DashboardPage.tsx`
- Modify: `src/features/dashboard/DashboardPage.test.tsx`

**Interfaces:**
- Consumes: existing class names and layout components.
- Produces: shared CSS variables and consistent shell, navigation, page-header, card, metric, toolbar, tab, status, form, table, and responsive styles.

- [ ] **Step 1: Define visual acceptance assertions**

Extend component tests to assert semantic page headings, primary actions, and module navigation labels rather than exact CSS values.

- [ ] **Step 2: Add design tokens**

Define blue primary colors, pale blue-gray background, surface, border, text, muted text, success, warning, danger, radii, shadows, and spacing variables at the top of `styles.css`.

- [ ] **Step 3: Simplify the workspace shell**

Reduce sidebar visual noise, strengthen the active module, use a clean white top bar, and constrain main content to readable spacing without removing desktop data density.

- [ ] **Step 4: Standardize page primitives**

Normalize panels, metric cards, toolbars, filter blocks, tabs, tables, empty states, feedback banners, and dialogs. Reuse existing classes where possible rather than adding parallel systems.

- [ ] **Step 5: Keep the local assistant lightweight**

Only align `assistant-shell` colors, spacing, and status styles with the new tokens. Do not add browser business navigation to the Tauri view.

- [ ] **Step 6: Verify responsive rules**

Ensure the five-module navigation and internal tabs remain usable at widths around 1280, 1024, 900, and 390 pixels.

- [ ] **Step 7: Run dashboard and shell tests**

Run: `npm test -- src/features/dashboard/DashboardPage.test.tsx src/workspace/WorkspaceModuleTabs.test.tsx`
Expected: PASS.

### Task 6: Simplify Orders and Listing Page Composition

**Files:**
- Modify: `src/features/orders/OrdersPage.tsx:478-790`
- Modify: `src/features/orders/OrdersPage.test.tsx`
- Modify: `src/features/cloud/GalleryManager.tsx:3980-4550`
- Modify: `src/features/cloud/GalleryManager.test.tsx`
- Modify: `src/styles.css` only for classes used by these pages

**Interfaces:**
- Consumes: corrected order state and deterministic listing setup from Tasks 2 and 3.
- Produces: page headers with one primary action, metric summaries, collapsible secondary configuration, and clear workflow sections.

- [ ] **Step 1: Write page-structure tests**

Assert Orders exposes one primary sync action, status tabs, a compact advanced filter section, and selected-order actions. Assert Listing separates workflow summary, shop/template setup, and per-image operations.

- [ ] **Step 2: Run focused tests for RED**

Run: `npm test -- src/features/orders/OrdersPage.test.tsx src/features/cloud/GalleryManager.test.tsx`
Expected: FAIL on new structure expectations.

- [ ] **Step 3: Recompose OrdersPage**

Use a page header, independent status metrics, compact filter card, results table, and a contextual selected-items action bar. Move manual order input, cookies, and low-frequency download configuration into an expandable advanced section.

- [ ] **Step 4: Recompose GalleryManager listing setup**

Keep the current business functions but split the UI into workflow summary, image-rule/mockup selection, shop/template setup, and selected-image actions. Collapse low-frequency automation settings by default.

- [ ] **Step 5: Preserve keyboard and accessible behavior**

All tabs and buttons retain accessible names; Enter-to-search and dialog focus behavior continue to work.

- [ ] **Step 6: Verify focused page tests**

Run: `npm test -- src/features/orders/OrdersPage.test.tsx src/features/cloud/GalleryManager.test.tsx`
Expected: PASS.

### Task 7: Audit Data Contracts and Consistency Boundaries

**Files:**
- Modify: `packages/shared/src/types.ts` only if an actual mismatch is found
- Modify: `packages/shared/src/schemas.ts` only if an actual mismatch is found
- Inspect/modify as required: `src/lib/api.ts`
- Inspect/modify as required: `src/lib/cloudApi.ts`
- Inspect/modify as required: `src-tauri/src/core/models.rs`
- Inspect/modify as required: `src-tauri/src/core/db.rs`
- Inspect/modify as required: `server/src/routes/*.ts`
- Create: `docs/testing/2026-07-27-data-consistency-audit.md`

**Interfaces:**
- Consumes: browser requests, Tauri command models, cloud route schemas, database uniqueness/foreign-key rules, and migration definitions.
- Produces: an invariant checklist with evidence and minimal contract fixes where mismatches are reproducible.

- [ ] **Step 1: Build a field-mapping matrix**

Document order IDs, posting IDs, shop IDs, template IDs, asset IDs, task IDs, status values, pagination fields, and timestamp fields across browser, Tauri, shared types, server, and database.

- [ ] **Step 2: Check order and logistics separation**

Verify posting number, order number, tracking number, and logistics PDF URL never share a field or query parameter. Add tests only where a reproducible mismatch exists.

- [ ] **Step 3: Check template and preference round trips**

Compare `CloudListingPreferences`, server Zod schemas, JSON storage, and frontend restore helpers. Ensure save-then-read produces an equivalent normalized value.

- [ ] **Step 4: Check image and listing lifecycle IDs**

Trace source assets, mockup assets, listing batches, preparation tasks, upload jobs, and listing status writes. Record every allowed transition and duplicate-prevention mechanism.

- [ ] **Step 5: Check task state invariants**

Verify success, failure, skipped, progress, cancellation, and terminal-state updates in local and cloud task histories. Add focused Rust or frontend tests for any reproducible invalid transition.

- [ ] **Step 6: Check migrations and constraints statically**

Review migrations in numeric order for required tables, unique constraints, foreign keys, and indexes. Do not run destructive migrations against production. If a disposable database is available, run migrations there and record evidence.

- [ ] **Step 7: Apply only evidence-backed contract fixes**

Do not rename or refactor adjacent fields unless a test or audit finding proves inconsistency.

- [ ] **Step 8: Complete the consistency report**

Mark each invariant PASS, FIXED, BLOCKED, or NOT EXECUTED with file/command evidence.

### Task 8: Run the Full Automated Verification Matrix

**Files:**
- Modify: `docs/testing/2026-07-27-baseline-audit.md`
- Modify: `docs/testing/2026-07-27-data-consistency-audit.md`
- Create: `docs/testing/2026-07-27-final-function-audit.md`

**Interfaces:**
- Consumes: all implemented changes and project validation commands.
- Produces: final automated verification results and a comparison against the baseline.

- [ ] **Step 1: Run all frontend tests**

Run: `npm test`
Expected: zero failed tests. Record exact test-file and test counts.

- [ ] **Step 2: Build both frontend outputs**

Run: `npm run build`
Run: `npm run build:web`
Expected: exit code 0. Record non-blocking Vite warnings separately.

- [ ] **Step 3: Run complete Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: zero failed tests.

- [ ] **Step 4: Check Rust formatting**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
Expected: exit code 0 for touched code. If pre-existing unrelated formatting remains, document the exact location rather than formatting unrelated lines.

- [ ] **Step 5: Check and build the cloud server**

Run from `server`: `npm run check`
Run from `server`: `npm run build`
Expected: exit code 0.

- [ ] **Step 6: Compare final results to baseline**

No baseline failure may be silently omitted. Mark unrelated pre-existing failures separately and confirm no new failures.

### Task 9: Execute Non-Destructive Browser Smoke Tests

**Files:**
- Modify: `docs/testing/2026-07-27-final-function-audit.md`

**Interfaces:**
- Consumes: local development build, browser workspace, available authenticated test state, and the five-module navigation.
- Produces: a page-by-page smoke-test table with screenshots or visible-state evidence where useful.

- [ ] **Step 1: Start the local browser workspace**

Run: `npm run dev -- --host 127.0.0.1`
Expected: workspace available at `http://127.0.0.1:1420`.

- [ ] **Step 2: Verify navigation and responsive layout**

Use the in-app browser at desktop and narrow viewports. Confirm all five modules and every child feature page are reachable.

- [ ] **Step 3: Verify safe browser interactions**

Exercise filters, tabs, pagination, template selection, save-and-refresh with test/mocked data, dialogs, task details, empty states, loading states, and recoverable errors.

- [ ] **Step 4: Verify destructive boundaries stop before submission**

For publish, ship, delete, paid AI, and similar actions, verify validation and request construction without clicking the final irreversible confirmation.

- [ ] **Step 5: Record authentication and environment blockers**

If the local page requires credentials or external services unavailable in this environment, record the exact blocked action and cover the behavior through component or contract tests instead.

### Task 10: Final Requirements Review and Handoff

**Files:**
- Modify: `docs/testing/2026-07-27-final-function-audit.md`
- Review: `docs/superpowers/specs/2026-07-27-web-workspace-stability-redesign.md`
- Review: all files changed by Tasks 2-9

**Interfaces:**
- Consumes: specification, plan checkboxes, test evidence, and audit reports.
- Produces: a final requirements checklist and concise handoff summary.

- [ ] **Step 1: Re-read every success criterion**

Mark each criterion MET, BLOCKED, or NOT MET with evidence. Do not infer success from unrelated tests.

- [ ] **Step 2: Inspect changed files for scope discipline**

Confirm each production change maps to a verified defect, navigation requirement, visual-system requirement, or consistency invariant.

- [ ] **Step 3: Confirm no irreversible external operation ran**

List all external operations that were mocked, contract-tested, or stopped before final submission.

- [ ] **Step 4: Deliver final audit summary**

Report completed changes, exact verification commands and counts, remaining known issues, environment limitations, and recommended next production verification steps.
