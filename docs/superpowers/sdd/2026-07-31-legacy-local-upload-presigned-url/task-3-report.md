# Task 3 Report: Cloud Uploader In Rust Batch Flow

## Summary

- Added `CloudListingImageUploader` in `src-tauri/src/core/batch.rs` for the old Excel batch listing image path.
- Presign request sends `sku`, `filename`, `contentType`, and `sizeBytes`.
- Upload uses `PUT uploadUrl` with the matching `Content-Type` and exact file bytes.
- Complete request is strictly `{ objectKey }` and the returned server-derived `publicUrl` is used in the Ozon import item.
- Kept listed-update OSS behavior and retained `oss_client` / `AliyunOssClient` usage for listed updates.
- Added focused Rust tests for content type selection, cloud base URL/token validation, and strict complete payload shape.

## Notes

- Task 3 plan draft mentioned a presign `publicUrl` and extra complete payload fields, but the Task 3 brief says the current server contract derives `publicUrl` on complete and complete request is strictly `{ objectKey }`. Implementation follows the brief/current contract.
- `git` is not available on PATH or common Windows Git install paths in this environment, so scoped status could not be verified with `git status`.

## Verification Output

### RED: focused test before implementation

Command:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml cloud_upload_content_type_matches_filename_extension -- --nocapture
```

Output:

```text
   Compiling ozon-sjsq v0.3.14 (E:\tool\ozon_sjsq\src-tauri)
error[E0425]: cannot find function `cloud_upload_content_type` in this scope
    --> src\core\batch.rs:1203:20
     |
1203 |         assert_eq!(cloud_upload_content_type("photo.png"), "image/png");
     |                    ^^^^^^^^^^^^^^^^^^^^^^^^^ not found in this scope

error[E0425]: cannot find function `cloud_upload_content_type` in this scope
    --> src\core\batch.rs:1204:20
     |
1204 |         assert_eq!(cloud_upload_content_type("PHOTO.PNG"), "image/png");
     |                    ^^^^^^^^^^^^^^^^^^^^^^^^^ not found in this scope

error[E0425]: cannot find function `cloud_upload_content_type` in this scope
    --> src\core\batch.rs:1205:20
     |
1205 |         assert_eq!(cloud_upload_content_type("photo.jpg"), "image/jpeg");
     |                    ^^^^^^^^^^^^^^^^^^^^^^^^^ not found in this scope

error[E0425]: cannot find function `cloud_upload_content_type` in this scope
    --> src\core\batch.rs:1206:20
     |
1206 |         assert_eq!(cloud_upload_content_type("photo.jpeg"), "image/jpeg");
     |                    ^^^^^^^^^^^^^^^^^^^^^^^^^ not found in this scope

error[E0433]: cannot find type `CloudListingImageUploader` in this scope
    --> src\core\batch.rs:1211:17
     |
1211 |         assert!(CloudListingImageUploader::new("", "token").is_err());
     |                 ^^^^^^^^^^^^^^^^^^^^^^^^^ use of undeclared type `CloudListingImageUploader`

error[E0433]: cannot find type `CloudListingImageUploader` in this scope
    --> src\core\batch.rs:1212:17
     |
1212 |         assert!(CloudListingImageUploader::new("https://api.example.com", " ").is_err());
     |                 ^^^^^^^^^^^^^^^^^^^^^^^^^ use of undeclared type `CloudListingImageUploader`

error[E0425]: cannot find function `legacy_complete_payload` in this scope
    --> src\core\batch.rs:1218:13
     |
1218 |             legacy_complete_payload("legacy-listing/user/sku/image.png"),
     |             ^^^^^^^^^^^^^^^^^^^^^^^ not found in this scope

warning: function `read_progress` is never used
    --> src\core\local_mockup.rs:1953:8
     |
1953 | pub fn read_progress(cache_root: &Path, job_id: &str) -> Result<LocalMockupProgress> {
     |        ^^^^^^^^^^^^^
     |
     = note: `#[warn(dead_code)]` (part of `#[warn(unused)]`) on by default

Some errors have detailed explanations: E0425, E0433.
For more information about an error, try `rustc --explain E0425`.
error: could not compile `ozon-sjsq` (lib test) due to 7 previous errors
warning: build failed, waiting for other jobs to finish...
warning: `ozon-sjsq` (lib) generated 1 warning
```

### GREEN: focused Rust tests

Command:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml cloud_ -- --nocapture; cargo test --manifest-path src-tauri/Cargo.toml legacy_complete_payload_contains_only_object_key -- --nocapture
```

Output:

```text

running 4 tests
test core::batch::tests::cloud_upload_content_type_matches_filename_extension ... ok
test core::batch::tests::cloud_uploader_requires_base_url_and_token ... ok
test core::auto_listing_scheduler::tests::cloud_run_treats_null_assignments_as_empty ... ok
test core::gallery_upload::tests::cloud_account_key_reads_stable_jwt_subject ... ok

test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 103 filtered out; finished in 0.00s


running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s


running 1 test
test core::batch::tests::legacy_complete_payload_contains_only_object_key ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 106 filtered out; finished in 0.00s


running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Compiling ozon-sjsq v0.3.14 (E:\tool\ozon_sjsq\src-tauri)
warning: function `read_progress` is never used
    --> src\core\local_mockup.rs:1953:8
     |
1953 | pub fn read_progress(cache_root: &Path, job_id: &str) -> Result<LocalMockupProgress> {
     |        ^^^^^^^^^^^^^
     |
     = note: `#[warn(dead_code)]` (part of `#[warn(unused)]`) on by default

warning: `ozon-sjsq` (lib) generated 1 warning
warning: `ozon-sjsq` (lib test) generated 1 warning (1 duplicate)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 27.79s
     Running unittests src\lib.rs (src-tauri\target\debug\deps\ozon_sjsq_lib-18bf62e0cd05cea2.exe)
     Running unittests src\main.rs (src-tauri\target\debug\deps\ozon_sjsq-ad57a9d19afc55b6.exe)
warning: function `read_progress` is never used
    --> src\core\local_mockup.rs:1953:8
     |
1953 | pub fn read_progress(cache_root: &Path, job_id: &str) -> Result<LocalMockupProgress> {
     |        ^^^^^^^^^^^^^
     |
     = note: `#[warn(dead_code)]` (part of `#[warn(unused)]`) on by default

warning: `ozon-sjsq` (lib) generated 1 warning
warning: `ozon-sjsq` (lib test) generated 1 warning (1 duplicate)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 1.16s
     Running unittests src\lib.rs (src-tauri\target\debug\deps\ozon_sjsq_lib-18bf62e0cd05cea2.exe)
     Running unittests src\main.rs (src-tauri\target\debug\deps\ozon_sjsq-ad57a9d19afc55b6.exe)
```

### Required Rust check

Command:

```powershell
cargo check --manifest-path src-tauri/Cargo.toml
```

Output:

```text
    Checking ozon-sjsq v0.3.14 (E:\tool\ozon_sjsq\src-tauri)
warning: function `read_progress` is never used
    --> src\core\local_mockup.rs:1953:8
     |
1953 | pub fn read_progress(cache_root: &Path, job_id: &str) -> Result<LocalMockupProgress> {
     |        ^^^^^^^^^^^^^
     |
     = note: `#[warn(dead_code)]` (part of `#[warn(unused)]`) on by default

warning: `ozon-sjsq` (lib) generated 1 warning
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 9.13s
```

### Optional frontend build

Command:

```powershell
npm run build
```

Output:

```text

> ozon-sjsq@0.3.14 build
> node --max-old-space-size=768 ./node_modules/typescript/bin/tsc && node --max-old-space-size=768 ./node_modules/vite/bin/vite.js build

vite v5.4.21 building for production...
transforming...
✓ 1614 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                   0.41 kB │ gzip:   0.28 kB
dist/assets/index-CINSq_DV.css  108.67 kB │ gzip:  19.32 kB
dist/assets/index-D5ZpSxDz.js   561.78 kB │ gzip: 171.21 kB
✓ built in 5.13s
[plugin:vite:reporter] [plugin vite:reporter]
(!) E:/tool/ozon_sjsq/node_modules/@tauri-apps/api/core.js is dynamically imported by E:/tool/ozon_sjsq/src/lib/PathInput.tsx, E:/tool/ozon_sjsq/src/lib/PathInput.tsx but also statically imported by E:/tool/ozon_sjsq/node_modules/@tauri-apps/plugin-process/dist-js/index.js, E:/tool/ozon_sjsq/node_modules/@tauri-apps/plugin-updater/dist-js/index.js, E:/tool/ozon_sjsq/src/lib/api.ts, dynamic import will not move module into another chunk.

(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
- Use build.rollupOptions.output.manualChunks to improve chunking: https://rollupjs.org/configuration-options/#output-manualchunks
- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.
```

