# Task 1 Brief: Server Legacy Upload API

Plan file: docs/superpowers/plans/2026-07-31-legacy-local-upload-presigned-url.md
Spec file: docs/superpowers/specs/2026-07-31-legacy-local-upload-presigned-url-design.md

Implement Task 1 only.

## Files
- Create: server/migrations/033_legacy_listing_uploads.sql
- Modify: server/src/routes/gallery-routes.ts
- Test: server/src/routes/legacy-listing-upload-routes.test.ts

## Requirements
- Add a table for confirmed old Excel listing uploads.
- Add helper `buildLegacyListingUploadObjectKey(userId, input)` exported from gallery-routes or a small helper module.
- Add helper `legacyListingUploadCompleteRecord(userId, body)` exported for tests.
- Add `POST /legacy-listing/uploads/presign` with auth + membership, rate limit, storage capacity check, server-owned object key, `createDirectUploadUrl`, and public URL response.
- Add `POST /legacy-listing/uploads/complete` with auth + membership, ownership check for `legacy-listing/${userId}/`, `objectExists`, DB upsert, and `{ ok: true, publicUrl }` response.
- Do not expose OSS long-term secrets.
- Keep changes focused; do not alter cloud gallery automatic listing behavior.

## Suggested tests
Use node:test in server/src/routes/legacy-listing-upload-routes.test.ts:
- Object key sanitizes SKU and filename traversal.
- Complete payload maps to insert record.

## Verification
Run focused test:
`cd server; npm test -- src/routes/legacy-listing-upload-routes.test.ts`

If possible, also run:
`cd server; npm run check`

Write report to docs/superpowers/sdd/2026-07-31-legacy-local-upload-presigned-url/task-1-report.md
