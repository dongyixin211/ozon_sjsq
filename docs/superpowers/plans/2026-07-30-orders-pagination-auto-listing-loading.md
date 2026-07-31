# Orders Pagination and Auto-Listing Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configurable ten-row order pagination and remove warehouse requests from the auto-listing page’s blocking startup path.

**Architecture:** Keep order pagination local to `OrdersPage` because the existing API already returns a bounded filtered result set. Split `AutoListingPlansPage` setup into a blocking core-resource phase and a non-blocking per-shop warehouse phase that updates state incrementally.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, vanilla CSS.

## Global Constraints

- Default order page size is exactly 10.
- Page-size options are exactly 10, 20, 50, and 100.
- Order selection and summary totals continue to cover all loaded filtered rows.
- Warehouse loading must not block the plan list or new-plan button.
- Do not add dependencies or change server APIs.

### Task 1: Order Pagination Behavior

**Files:** `src/features/orders/OrdersPage.tsx`, `src/features/orders/OrdersPage.test.tsx`, `src/styles.css`

- [ ] Write a failing test with twelve orders: ten visible initially, two after next, all after choosing 20.
- [ ] Run the focused OrdersPage test and verify it fails for missing pagination.
- [ ] Add persisted page-size restoration, page state, derived `pagedRows`, and pagination controls.
- [ ] Keep selection and totals based on all loaded rows.
- [ ] Run the focused OrdersPage test and verify it passes.

### Task 2: Non-Blocking Warehouse Loading

**Files:** `src/features/cloud/AutoListingPlansPage.tsx`, `src/features/cloud/AutoListingPlansPage.test.tsx`

- [ ] Write a failing test with an unresolved warehouse promise and verify the plan list should still render.
- [ ] Run the focused auto-listing test and verify it fails because loading remains blocked.
- [ ] Split core loading from background warehouse loading.
- [ ] Add a non-blocking warehouse-loading status and isolated failure handling.
- [ ] Run the focused auto-listing test and verify it passes.

### Task 3: Verification and Deployment

- [ ] Run both focused test files.
- [ ] Run `npm test`.
- [ ] Run `npm run build:web`.
- [ ] Run `npm run check` from `server`.
- [ ] Deploy with the standard Ozon SJSQ script and verify production assets and health.
- [ ] Commit if Git is available; otherwise report that commit creation was skipped.
