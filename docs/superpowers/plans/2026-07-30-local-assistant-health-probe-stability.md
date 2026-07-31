# Local Assistant Health Probe Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement these checked steps.

**Goal:** Prevent false local-assistant timeout messages while retaining offline detection.

**Architecture:** Share overlapping `/health` fetches in `localAssistant.ts`. In `App.tsx`, schedule the next probe only after the previous one settles, mark offline after three failures, and clear a connection error after recovery.

**Tech Stack:** React, TypeScript, Vitest, Testing Library.

## Constraints

- Browser-side changes only; no packages, Rust, port, protocol, or CORS changes.
- Normal timeout: `2_000` ms. Healthy delay: `10_000` ms. Failed delay: `2_000` ms. Disconnect threshold: `3`.

### Task 1: Coordinate Health Fetches

**Files:** Create `src/lib/localAssistant.test.ts`; modify `src/lib/localAssistant.ts`.

- [ ] Write a failing test that invokes `checkLocalAssistant()` twice before a deferred mocked fetch resolves and asserts one fetch call.
- [ ] Run `npm test -- src/lib/localAssistant.test.ts`; expect failure because the current code fetches twice.
- [ ] Add `let activeProbe: Promise<LocalAssistantStatus> | null = null;` and return the same `probeLocalAssistant(timeoutMs)` promise until `.finally()` resets it. Use `2_000` as the default; grace retries call the public shared function.
- [ ] Add a test proving a request after settlement creates a new fetch, then rerun the focused test; expect pass.

### Task 2: Stabilize Workspace Feedback

**Files:** Modify `src/App.tsx` and `src/workspace/WorkspaceModuleTabs.test.tsx`.

- [ ] With fake timers, write a failing UI test: startup connects, then two periodic failures occur; assert “本地助手已连接” remains and no timeout is rendered.
- [ ] Replace `setInterval` with one async probe that schedules its next `setTimeout` after completion. Reset failures on success. Only set disconnected status/message at failure three.
- [ ] Add a test for three failures followed by success: error appears only after failure three and disappears after recovery, without clearing unrelated messages.
- [ ] Run `npm test -- src/workspace/WorkspaceModuleTabs.test.tsx`; expect pass.

### Task 3: Verify

- [ ] Run `npm test`, `npm run build`, then `cargo fmt -- --check` and `cargo check` from `src-tauri`.
- [ ] Commit with `git` when available; this environment currently has no `git` executable.
