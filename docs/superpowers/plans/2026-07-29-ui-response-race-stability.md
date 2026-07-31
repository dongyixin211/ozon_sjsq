# UI Response Race And Assistant Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent transient local-assistant probe failures and stale asynchronous responses from replacing the user's current workspace data.

**Architecture:** Keep the last successfully loaded application snapshot while the local assistant reconnects. For replace-in-place lists, only the newest overlapping request may update rows, counters, selection, loading state, or messages.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, Tauri local HTTP assistant.

## Global Constraints

- Modify only behavior directly related to assistant connection stability and stale list-response races.
- Do not add dependencies or speculative configuration.
- Preserve existing visual design and API contracts.
- Write a failing regression test before production changes.

---

### Task 1: Preserve Loaded Workspace During Reconnect

**Files:**
- Modify: `src/workspace/WorkspaceModuleTabs.test.tsx`
- Modify: `src/App.tsx:52`

- [ ] Add a test that loads the workspace, then returns three failed assistant probes and verifies the dashboard remains visible.
- [ ] Run the focused test and verify it fails because the assistant gate replaces the workspace.
- [ ] Keep the loaded snapshot during transient disconnects; retain the gate for initial failure.
- [ ] Run focused tests and verify both behaviors.

### Task 2: Verify The Order Race Fix

**Files:**
- Verify: `src/features/orders/OrdersPage.tsx:124`
- Verify: `src/features/orders/OrdersPage.test.tsx:120`
- Verify: `src/features/orders/orderQueryUtils.ts:24`

- [ ] Run the existing request-order regression tests.
- [ ] Confirm the latest request owns rows, summaries, selection, loading, messages, and cloud sync.
- [ ] Leave the implementation unchanged unless a focused test exposes a gap.

### Task 3: Audit Other Replace-In-Place Lists

**Files:**
- Audit: `src/features/cloud/GalleryManager.tsx`
- Audit: `src/features/ozon/OzonPage.tsx`
- Test corresponding existing test files only for reproducible races.

- [ ] Map candidate loaders to triggers and state writes.
- [ ] Add deferred-promise tests for confirmed overlapping request families.
- [ ] Add minimal per-loader request generations only where tests fail.
- [ ] Run focused tests.

### Task 4: Regression Verification

- [ ] Run related frontend tests.
- [ ] Run the full frontend suite with `npm test`.
- [ ] Run `npm run build`.
- [ ] Report unrelated failures without modifying them.
