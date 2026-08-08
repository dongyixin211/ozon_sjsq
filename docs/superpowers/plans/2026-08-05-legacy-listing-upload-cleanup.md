# Legacy Listing Upload Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely reclaim legacy batch-listing upload storage after a seven-day retention period.

**Architecture:** Add an auditable cleanup table and a standalone server script. The script defaults to dry-run, deletes only completed records older than seven days with no active grant, verifies the server-owned object prefix, deletes the OSS object first, then removes the database record.

**Tech Stack:** TypeScript, PostgreSQL, AWS SDK S3-compatible storage, Node test runner.

## Global Constraints

- Keep membership and storage quota enforcement intact.
- Do not delete ordinary gallery assets or active upload grants.
- Keep all uploads on direct OSS transfer.
- Do not reintroduce the cancelled V2 architecture.

---

### Task 1: Add cleanup audit storage

**Files:**
- Create: `server/migrations/038_legacy_listing_upload_cleanup.sql`
- Test: `server/src/scripts/legacy-listing-upload-cleanup.test.ts`

- [ ] Add an idempotent audit table keyed by object key and cleanup attempt.
- [ ] Add tests for seven-day eligibility and active-grant protection.
- [ ] Run the focused test and confirm the new helper is initially absent.

### Task 2: Add safe object deletion

**Files:**
- Modify: `server/src/storage.ts`
- Test: `server/src/storage.test.ts` or the existing storage test location

- [ ] Export `deleteObject(objectKey: string)` with local and S3-compatible behavior.
- [ ] Reject object keys outside the legacy listing prefix before deleting.
- [ ] Run storage-focused tests.

### Task 3: Implement the cleanup script

**Files:**
- Create: `server/scripts/cleanup-legacy-listing-uploads.ts`
- Modify: `server/package.json`
- Test: `server/src/scripts/legacy-listing-upload-cleanup.test.ts`

- [ ] Add pure eligibility and key-safety helpers.
- [ ] Add dry-run status output with rows, bytes, and protected counts.
- [ ] Add `--delete` mode with bounded batches and per-object audit results.
- [ ] Delete OSS first, then database rows only after success.
- [ ] Remove expired incomplete grant rows without deleting completed objects.
- [ ] Run focused tests, type check, and full server tests.

### Task 4: Verify production readiness

**Files:**
- Modify: `docs/cloud-gallery-usage.md`
- Modify: `docs/ozon-operation-guide.md`

- [ ] Document the seven-day retention and dry-run/delete commands.
- [ ] Build the server and run the status command against production.
- [ ] Run the delete command only after status output is reviewed.
- [ ] Confirm health endpoint and quota fields after restart.
