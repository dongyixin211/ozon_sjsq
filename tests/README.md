# Test Plan

Run once Node and Rust toolchains are installed:

```bash
npm install
npm test
cd src-tauri && cargo test
```

Coverage targets:

- Rust unit tests for OSS object keys and Ozon import item payload generation.
- Frontend tests for navigation, forms, and task table rendering.
- Integration tests with mock Ozon/OSS servers for batch upload and inventory flows.
