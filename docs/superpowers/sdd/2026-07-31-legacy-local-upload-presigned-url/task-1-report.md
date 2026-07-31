# Task 1 Report: Server Legacy Upload API

## Implemented changes
- Added `server/migrations/033_legacy_listing_uploads.sql` with `legacy_listing_uploads` table and `(user_id, sku, created_at DESC)` index.
- Added `server/migrations/034_legacy_listing_upload_grants.sql` with expiring, server-side upload grants bound to user, object key, SKU, filename, content type, size bytes, expiration, and completion time.
- Added `buildLegacyListingUploadObjectKey(userId, input)` in `server/src/routes/gallery-routes.ts` to generate server-owned keys under `legacy-listing/{userId}/...`, sanitizing SKU and filename extension.
- Added pure helpers in `server/src/routes/gallery-routes.ts` for strict complete body parsing, quota decisions, grant validation, object metadata validation, and complete record mapping.
- Added `POST /legacy-listing/uploads/presign` with auth, membership, rate limit, user-row serialization, transaction-scoped capacity check, server-generated object key, `createDirectUploadUrl`, server-side grant persistence, and server-derived public URL response.
- Added `POST /legacy-listing/uploads/complete` with auth, membership, object-key grant lookup, wrong-user/missing/expired rejection, idempotent repeat handling for completed grants, `HeadObject` metadata validation, and DB confirmation using only grant/server-derived fields.
- Added `readObjectMetadata(objectKey)` in `server/src/storage.ts` as a safe `HeadObject`/local-stat wrapper returning content type and size.
- Updated `readGalleryStorageUsage` so quota usage includes gallery assets, confirmed legacy uploads, and active uncompleted unexpired legacy upload grants without double-counting completed grants.
- Added `server/src/routes/legacy-listing-upload-routes.test.ts` covering object-key sanitization, server-derived public URL mapping, grant/ownership/expiration decisions, completed-grant idempotency, metadata mismatch decisions, reserved-byte quota decisions, and strict complete body rejection.
- Did not change client/Rust files, cloud gallery automatic listing behavior, or expose OSS long-term secrets.

## Fix round 1 review items
- Complete no longer accepts or persists client-supplied `publicUrl`; complete body is object-key only and strict, and records derive `publicUrl` through `publicUrlForObjectKey(grant.objectKey)`.
- Presign persists an expiring grant in `legacy_listing_upload_grants`; complete queries that grant and rejects missing, expired, or wrong-user grants.
- Complete validates stored object size and content type against grant metadata via `readObjectMetadata` before writing confirmation.
- Confirmed legacy uploads are included in storage usage and object-key uniqueness prevents idempotent repeat completes from increasing quota usage.
- Complete upsert writes all mutable record fields from the grant/server-derived record, not from client payload.

## Fix round 2 review items
- Presign grant issuance now runs inside a DB transaction and serializes per user with `SELECT id FROM users WHERE id = $1 FOR UPDATE` before capacity calculation.
- Presign checks quota inside the same transaction and inserts the grant only after the locked capacity check; rollback leaves no inserted grant.
- Quota usage now includes active, uncompleted, unexpired legacy grants as reserved bytes and excludes completed grants so confirmed uploads are not double-counted.
- Added pure quota seam tests for reserved-byte accounting and strict complete body rejection. A DB-backed Fastify inject route test would require substantial auth/database setup in this test file, so the smallest route seam used here is `parseLegacyListingCompleteBody`, which is called by the real complete route.

## Tests run and output

### Task 1 initial TDD red run
Command: `cd server; npm test -- src/routes/legacy-listing-upload-routes.test.ts`
- Failed as expected because `gallery-routes.js` did not export `buildLegacyListingUploadObjectKey`.

### Fix round 1 TDD red run
Command: `cd server; npm test -- src/routes/legacy-listing-upload-routes.test.ts`
- Failed as expected because `validateLegacyListingUploadGrant` was not exported.

### Fix round 2 TDD red run
Command: `cd server; npm test -- src/routes/legacy-listing-upload-routes.test.ts`
- Failed as expected because `legacyListingStorageUsageTotals` was not exported.

### Focused test after fix round 2
Command: `cd server; npm test -- src/routes/legacy-listing-upload-routes.test.ts`
- Output summary:
  - `# tests 36`
  - `# pass 36`
  - `# fail 0`
  - exit code `0`

### TypeScript check after fix round 2
Command: `cd server; npm run check`
- Output:
  - `tsc -p tsconfig.json --noEmit`
  - exit code `0`

### Full server tests after fix round 2
Command: `cd server; npm test`
- Output summary:
  - `# tests 36`
  - `# pass 36`
  - `# fail 0`
  - exit code `0`

## Concerns
- `git` is not available in this PowerShell PATH, so I could not inspect repository diff/status with git commands.
- The focused npm test command in this package also runs existing `src/**/*.test.ts` tests because of the package script; all executed tests passed.