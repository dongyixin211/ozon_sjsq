# Web Shop Management Fixed Bars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the web shop-management controls compact and sticky without affecting desktop behavior.

**Architecture:** Add a web-only shell class in `App`, then use narrowly scoped Ozon component classes and CSS overrides. Keep all existing state transitions and event handlers intact.

**Tech Stack:** React 18, TypeScript, CSS, Vitest.

## Global Constraints

- Web frontend only; desktop data processing remains unchanged.
- Preserve one-line compact bars and active menu state.
- Do not modify APIs or task behavior.

---

### Task 1: Add web-only navigation markup and regression coverage

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/features/ozon/OzonPage.tsx`
- Test: `src/features/ozon/OzonPage.test.tsx`

- [ ] Add `web-app-shell` only to the non-Tauri application shell.
- [ ] Mark the shop-management control strip and function navigation with semantic layout classes.
- [ ] Remove task-card descriptions from the rendered navigation and keep each button label and click handler unchanged.
- [ ] Add a test that opens the shop center and verifies the function navigation has the compact-menu class, only exposes feature names, and still changes tabs.

### Task 2: Add scoped compact sticky layouts

**Files:**
- Modify: `src/styles.css`

- [ ] Add `.web-app-shell` scoped overrides that combine the management controls into a sticky, single-line, horizontally scrollable bar.
- [ ] Add `.web-app-shell` scoped overrides that render task navigation as a sticky name-only horizontal menu below the shop header.
- [ ] Preserve selected-tab styling and avoid any selector that applies to the Tauri desktop shell.

### Task 3: Validate the web change

**Files:**
- Test: `src/features/ozon/OzonPage.test.tsx`

- [ ] Run the focused Ozon test file.
- [ ] Run `npm run build:web`.
- [ ] Review the diff to ensure no unrelated worktree changes are included.