# Order Download Folder Name Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every order download directory use `店铺名称+货号+订单编号`.

**Architecture:** Keep naming in the Rust backend so every UI entry receives identical behavior. Resolve shop and offer metadata before directory creation, then use one tested pure helper for formatting and sanitization.

**Tech Stack:** Rust, Tauri, SQLite, Tokio, Vitest, TypeScript.

## Global Constraints

- Use literal `+` separators and `、` between deduplicated offer IDs.
- Preserve the current order/posting identifier as the third component.
- Use `未知货号` when no offer ID is available.
- Do not change downloaded filenames or unrelated order behavior.

---

### Task 1: Test Folder Name Formatting

**Files:**
- Modify: `src-tauri/src/core/order_docs.rs`
- Test: `src-tauri/src/core/order_docs.rs`

**Interfaces:**
- Produces: `order_download_folder_name(shop_name: &str, offer_ids: &[String], order_number: &str) -> String`

- [ ] Write tests for a single offer, duplicate/multiple offers, illegal characters, and missing offers.
- [ ] Run `cargo test order_download_folder_name --manifest-path src-tauri/Cargo.toml` and confirm RED.
- [ ] Implement the minimal helper using the existing sanitizer.
- [ ] Run the focused test and confirm GREEN.

### Task 2: Apply Naming to Download Paths

**Files:**
- Modify: `src-tauri/src/core/order_docs.rs`

**Interfaces:**
- Consumes: `order_download_folder_name(...)`
- Produces: Identical directory naming for full jobs and direct logistics-label downloads.

- [ ] Resolve postings and offers before full-job directory creation.
- [ ] Load the configured shop name once per full download job.
- [ ] Load shop and saved posting metadata for direct label downloads.
- [ ] Run `cargo test core::order_docs --manifest-path src-tauri/Cargo.toml`.

### Task 3: Verify Project Compatibility

**Files:**
- Verify: `src/features/orders/OrdersPage.test.tsx`
- Verify: `src/features/ozon/OzonPage.test.tsx`

- [ ] Run focused frontend order tests.
- [ ] Run all Rust tests.
- [ ] Run `npm run build`.
- [ ] Review changes against the approved requirements.
