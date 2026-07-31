# Selected Order Logistics PDF Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep all existing selected-order Ozon document downloads while adding exactly one matched logistics PDF per selected posting without ever sending a logistics URL to Ozon.

**Architecture:** Build the selected posting list from the loaded order rows rather than trusting arbitrary selected-state values, then zip that ordered list with the entered logistics URLs. Add a backend validation boundary that rejects HTTP/HTTPS values in `order_numbers` before any Ozon client request.

**Tech Stack:** React 18, TypeScript, Vitest, Rust, Tauri, Cargo tests

## Global Constraints

- Preserve all existing Ozon barcode, picking-list, label, and optional material downloads.
- Save each matched logistics PDF as `logistics-label.pdf` in the existing posting directory.
- Require equal selected-posting and logistics-link counts and reject duplicate links.
- Do not add configuration or unrelated refactors.

---

### Task 1: Selected Posting Mapping

**Files:**
- Modify: `src/features/ozon/orderUtils.ts`
- Test: `src/features/ozon/orderUtils.test.ts`
- Modify: `src/features/ozon/OzonPage.tsx`

**Interfaces:**
- Consumes: loaded `OrderPostingRow[]` and selected posting-number strings.
- Produces: `selectedPostingNumbersInRowOrder(rows, selectedPostingNumbers): string[]`.

- [ ] **Step 1: Write the failing utility test**

Add a test proving that loaded posting rows determine the output and an accidentally selected logistics URL is excluded.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- src/features/ozon/orderUtils.test.ts`
Expected: FAIL because `selectedPostingNumbersInRowOrder` is not exported.

- [ ] **Step 3: Implement the minimal row-order selector**

Filter loaded rows by the selected set, trim posting numbers, and remove empty/duplicate values while preserving table order.

- [ ] **Step 4: Use the selector in “下载勾选”**

Validate and submit the derived posting numbers, then pair them with logistics links through the existing `orderDocumentsRequest` mapping.

- [ ] **Step 5: Run the focused TypeScript test**

Run: `npm test -- src/features/ozon/orderUtils.test.ts`
Expected: PASS.

### Task 2: Backend Ozon Query Guard

**Files:**
- Modify: `src-tauri/src/core/order_docs.rs`
- Test: `src-tauri/src/core/order_docs.rs`

**Interfaces:**
- Consumes: `OrderDocumentsRequest.order_numbers`.
- Produces: validation failure before `seller_web_client` or `resolve_postings` when an order reference is an HTTP/HTTPS URL.

- [ ] **Step 1: Write the failing Rust regression test**

Add a request whose order number is a logistics PDF URL and assert validation returns the URL-specific error.

- [ ] **Step 2: Run the focused Rust test and verify RED**

Run: `cargo test order_docs::tests::rejects_logistics_url_as_order_number --manifest-path src-tauri/Cargo.toml`
Expected: FAIL because URL order references are currently accepted.

- [ ] **Step 3: Implement minimal validation**

After cleaning order numbers, reject values parsed as HTTP/HTTPS URLs before constructing the Ozon seller-web client.

- [ ] **Step 4: Run focused Rust tests**

Run: `cargo test order_docs::tests --manifest-path src-tauri/Cargo.toml`
Expected: PASS.

### Task 3: Final Verification

**Files:**
- Verify only; no planned production changes.

- [ ] **Step 1: Run Ozon frontend tests**

Run: `npm test -- src/features/ozon/orderUtils.test.ts src/features/ozon/OzonPage.test.tsx`
Expected: PASS.

- [ ] **Step 2: Run TypeScript build**

Run: `npm run build`
Expected: exit code 0.

- [ ] **Step 3: Run Rust order-document tests**

Run: `cargo test order_docs::tests --manifest-path src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 4: Inspect the final diff**

Confirm every changed production line maps to selected-posting construction or URL rejection. Git commands are unavailable in the current environment, so use direct file inspection rather than commits.
