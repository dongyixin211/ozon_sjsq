# Task 3 Brief: Cloud Uploader In Rust Batch Flow

Plan file: docs/superpowers/plans/2026-07-31-legacy-local-upload-presigned-url.md
Spec file: docs/superpowers/specs/2026-07-31-legacy-local-upload-presigned-url-design.md

Implement Task 3 only after Task 2 has added `BatchUploadRequest.cloud_api_base_url` and `BatchUploadRequest.cloud_auth_token`.

## Files
- Modify: src-tauri/src/core/batch.rs
- Report: docs/superpowers/sdd/2026-07-31-legacy-local-upload-presigned-url/task-3-report.md

## Requirements
- Add a cloud-backed image uploader for old Excel batch listing.
- The uploader requests `POST {baseUrl}/legacy-listing/uploads/presign` with SKU, filename, content type, and byte size; uploads the exact bytes with `PUT uploadUrl` and matching `Content-Type`; then confirms with `POST {baseUrl}/legacy-listing/uploads/complete` using only `{ objectKey }`. The server derives the final public URL.
- It must return the confirmed public URL and use that URL in the existing Ozon import item.
- It must require non-empty cloud base URL and cloud auth token.
- Replace only the old `process_upload_row` image upload path. Preserve Ozon duplicate check, watermark creation, template/video/rich_json behavior, result row logic, and listed-update image logic.
- Do not remove `oss_client` if listed update still needs it.

## Verification
Run:
`cargo check --manifest-path src-tauri/Cargo.toml`

If feasible, also run:
`npm run build`

Write report to docs/superpowers/sdd/2026-07-31-legacy-local-upload-presigned-url/task-3-report.md

