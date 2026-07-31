# Task 7 Brief: Data Contract and Consistency Audit

Execute Task 7 from the master plan after correctness tasks are accepted.

Primary ownership:
- Create `docs/testing/2026-07-27-data-consistency-audit.md`.
- Modify shared types, API clients, Rust models/database, or server routes only when a reproducible test or compile-time mismatch proves a defect.

Required audit matrix:
- Order: shopId, postingNumber, orderNumber, orderId, trackingNumber, logistics URL, status, downloadedAt/output path.
- Template: cloud product template ID/name/shared shop, local Ozon template ID, listing preference round trip.
- Image/listing: source asset, mockup asset, preparation task, listing batch, upload task, quota reservation, listing status.
- Task: stable job ID, legal status transitions, cancellation, success/failed/skipped totals, local/cloud history sync.
- Pagination/filter: request fields, total count, result scope, date/status/keyword/shop filters.
- Database: migrations 001-028, unique constraints, foreign keys, transaction/idempotency behavior, required indexes.

Rules:
- Mark each invariant PASS, FIXED, BLOCKED, or NOT EXECUTED with evidence.
- No speculative refactors or naming cleanup.
- No destructive production migrations or external writes.
- Add focused tests only for proven mismatches.
- Preserve other workers' changes.
- Git is unavailable; do not commit.

Return changed files, audit findings by severity, tests run, and external/environment blockers.
