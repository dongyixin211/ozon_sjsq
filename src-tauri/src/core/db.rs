use crate::core::models::{
    AppSettings, JobKind, JobLog, JobStatus, JobSummary, OrderPostingRow,
    OrderShippingLabelAssignment, Shop, ShopDraft, StoredOrderQuery, TemplateDraft,
    TemplateSummary,
};
use crate::core::secrets;
use anyhow::{Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

pub struct Database {
    conn: Connection,
    path: PathBuf,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AutoListingSchedulerRecord {
    pub account_id: String,
    pub plan_id: String,
    pub cloud_api_base_url: String,
    pub auth_secret_key: String,
    pub paused: bool,
    pub last_quota_date: Option<String>,
    pub cloud_run_id: Option<String>,
    pub local_job_id: Option<String>,
    pub stage: Option<String>,
    pub pending_progress: Value,
    pub last_error: Option<String>,
}

impl Database {
    pub fn open(app: &AppHandle) -> Result<Self> {
        let dir = app.path().app_data_dir().context("无法定位应用数据目录")?;
        fs::create_dir_all(&dir).context("无法创建应用数据目录")?;
        let path = dir.join("ozon-sjsq.sqlite3");
        let conn = Connection::open(&path).context("无法打开 SQLite 数据库")?;
        let db = Self { conn, path };
        db.migrate()?;
        Ok(db)
    }

    #[allow(dead_code)]
    pub fn open_at(path: PathBuf) -> Result<Self> {
        let conn = Connection::open(&path).context("无法打开 SQLite 数据库")?;
        let db = Self { conn, path };
        db.migrate()?;
        Ok(db)
    }

    pub fn path(&self) -> PathBuf {
        self.path.clone()
    }

    fn migrate(&self) -> Result<()> {
        self.conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS shops (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              client_id TEXT NOT NULL,
              api_key_ref TEXT NOT NULL,
              oss_access_key_id TEXT,
              oss_secret_ref TEXT,
              oss_bucket TEXT,
              oss_endpoint TEXT,
              oss_public_domain TEXT,
              watermark_path TEXT,
              shop_role TEXT,
              follows_shop_id TEXT,
              follow_warehouse_id INTEGER,
              maintenance_warehouse_id INTEGER,
              maintenance_stock INTEGER,
              maintenance_stock_enabled INTEGER NOT NULL DEFAULT 1,
              maintenance_barcode_enabled INTEGER NOT NULL DEFAULT 1,
              maintenance_action_enabled INTEGER NOT NULL DEFAULT 1,
              maintenance_interval_minutes INTEGER NOT NULL DEFAULT 5,
              maintenance_action_configs TEXT NOT NULL DEFAULT '[]',
              api_key_plain TEXT,
              oss_secret_plain TEXT,
              enabled INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL

            );
            CREATE TABLE IF NOT EXISTS auto_listing_scheduler_state (
              account_id TEXT NOT NULL,
              plan_id TEXT NOT NULL,
              cloud_api_base_url TEXT NOT NULL,
              auth_secret_key TEXT NOT NULL,
              paused INTEGER NOT NULL DEFAULT 0,
              last_quota_date TEXT,
              cloud_run_id TEXT,
              local_job_id TEXT,
              stage TEXT,
              pending_progress TEXT NOT NULL DEFAULT '[]',
              last_error TEXT,
              updated_at TEXT NOT NULL,
              PRIMARY KEY (account_id, plan_id)
            );
            CREATE TABLE IF NOT EXISTS templates (
              id TEXT PRIMARY KEY,
              kind TEXT NOT NULL,
              name TEXT NOT NULL,
              payload TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS jobs (
              id TEXT PRIMARY KEY,
              kind TEXT NOT NULL,
              title TEXT NOT NULL,
              status TEXT NOT NULL,
              progress INTEGER NOT NULL,
              input_path TEXT,
              output_path TEXT,
              result_path TEXT,
              result_excel_path TEXT,
              success_count INTEGER,
              failed_count INTEGER,
              last_error TEXT,
              error TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS job_logs (
              id TEXT PRIMARY KEY,
              job_id TEXT NOT NULL,
              level TEXT NOT NULL,
              message TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS job_logs_job_created_at_idx
              ON job_logs (job_id, created_at);
            CREATE TABLE IF NOT EXISTS gallery_upload_jobs (
              job_id TEXT PRIMARY KEY,
              cloud_api_base_url TEXT NOT NULL,
              cloud_auth_secret_key TEXT NOT NULL,
              product_image_rule_id TEXT,
              source_label TEXT,
              total_files INTEGER NOT NULL DEFAULT 0,
              total_bytes INTEGER NOT NULL DEFAULT 0,
              status TEXT NOT NULL DEFAULT 'queued',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS gallery_upload_items (
              id TEXT PRIMARY KEY,
              job_id TEXT NOT NULL,
              path TEXT NOT NULL,
              cache_path TEXT,
              filename TEXT NOT NULL,
              size_bytes INTEGER NOT NULL DEFAULT 0,
              status TEXT NOT NULL DEFAULT 'queued',
              server_task_id TEXT,
              error TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE(job_id, path)
            );
            CREATE INDEX IF NOT EXISTS gallery_upload_items_job_status_idx
              ON gallery_upload_items (job_id, status, id);
            CREATE TABLE IF NOT EXISTS gallery_upload_history (
              cloud_api_base_url TEXT NOT NULL,
              cloud_account_key TEXT NOT NULL,
              product_image_rule_id TEXT NOT NULL,
              sha256 TEXT NOT NULL,
              sku TEXT NOT NULL,
              source_filename TEXT NOT NULL,
              uploaded_at TEXT NOT NULL,
              PRIMARY KEY (cloud_api_base_url, cloud_account_key, product_image_rule_id, sha256)
            );
            CREATE INDEX IF NOT EXISTS gallery_upload_history_rule_idx
              ON gallery_upload_history (cloud_api_base_url, cloud_account_key, product_image_rule_id, uploaded_at DESC);
            CREATE TABLE IF NOT EXISTS order_postings (
              shop_id TEXT NOT NULL,
              posting_number TEXT NOT NULL,
              shop_name TEXT,
              order_number TEXT,
              order_id INTEGER,
              status TEXT,
              in_process_at TEXT,
              shipment_date TEXT,
              warehouse_name TEXT,
              tracking_number TEXT,
              products_count INTEGER NOT NULL DEFAULT 0,
              offer_ids_json TEXT NOT NULL DEFAULT '[]',
              products_json TEXT NOT NULL DEFAULT '[]',
              image_url TEXT,
              sales_amount REAL,
              currency_code TEXT,
              raw_json TEXT NOT NULL DEFAULT '{}',
              synced_at TEXT NOT NULL,
              downloaded_at TEXT,
              download_output_path TEXT,
              PRIMARY KEY (shop_id, posting_number)
            );
            CREATE INDEX IF NOT EXISTS order_postings_shop_status_idx
              ON order_postings (shop_id, status, in_process_at DESC);
            CREATE INDEX IF NOT EXISTS order_postings_synced_idx
              ON order_postings (synced_at DESC);
            CREATE TABLE IF NOT EXISTS order_shipping_labels (
              url TEXT PRIMARY KEY,
              shop_id TEXT NOT NULL,
              order_number TEXT NOT NULL,
              reserved_at TEXT NOT NULL,
              downloaded_at TEXT,
              output_path TEXT,
              UNIQUE(shop_id, order_number)
            );
            CREATE INDEX IF NOT EXISTS order_shipping_labels_order_idx
              ON order_shipping_labels (shop_id, order_number);
            "#,
        )?;

        // 兼容旧表：安全地添加新列
        for col in [
            "api_key_plain",
            "oss_secret_plain",
            "watermark_path",
            "shop_role",
            "follows_shop_id",
            "follow_warehouse_id",
            "maintenance_warehouse_id",
            "maintenance_stock",
            "maintenance_stock_enabled",
            "maintenance_barcode_enabled",
            "maintenance_action_enabled",
            "maintenance_interval_minutes",
            "maintenance_action_configs",
        ] {
            let check: bool = self
                .conn
                .prepare("SELECT COUNT(*) FROM pragma_table_info('shops') WHERE name = ?1 LIMIT 1")
                .and_then(|mut stmt| stmt.query_row(params![col], |row| row.get::<_, i64>(0)))
                .map(|count| count > 0)
                .unwrap_or(false);
            if !check {
                let column_type = match col {
                    "follow_warehouse_id" | "maintenance_warehouse_id" | "maintenance_stock" => {
                        "INTEGER"
                    }
                    "maintenance_stock_enabled" => "INTEGER NOT NULL DEFAULT 1",
                    "maintenance_barcode_enabled" => "INTEGER NOT NULL DEFAULT 1",
                    "maintenance_action_enabled" => "INTEGER NOT NULL DEFAULT 1",
                    "maintenance_interval_minutes" => "INTEGER NOT NULL DEFAULT 5",
                    "maintenance_action_configs" => "TEXT NOT NULL DEFAULT '[]'",
                    _ => "TEXT",
                };
                let _ = self.conn.execute_batch(&format!(
                    "ALTER TABLE shops ADD COLUMN {} {};",
                    col, column_type
                ));
            }
        }
        for (col, column_type) in [
            ("result_path", "TEXT"),
            ("result_excel_path", "TEXT"),
            ("success_count", "INTEGER"),
            ("failed_count", "INTEGER"),
            ("last_error", "TEXT"),
        ] {
            let check: bool = self
                .conn
                .prepare("SELECT COUNT(*) FROM pragma_table_info('jobs') WHERE name = ?1 LIMIT 1")
                .and_then(|mut stmt| stmt.query_row(params![col], |row| row.get::<_, i64>(0)))
                .map(|count| count > 0)
                .unwrap_or(false);
            if !check {
                let _ = self.conn.execute_batch(&format!(
                    "ALTER TABLE jobs ADD COLUMN {} {};",
                    col, column_type
                ));
            }
        }
        for (col, column_type) in [("product_image_rule_id", "TEXT")] {
            let check: bool = self
                .conn
                .prepare(
                    "SELECT COUNT(*) FROM pragma_table_info('gallery_upload_jobs') WHERE name = ?1 LIMIT 1",
                )
                .and_then(|mut stmt| stmt.query_row(params![col], |row| row.get::<_, i64>(0)))
                .map(|count| count > 0)
                .unwrap_or(false);
            if !check {
                let _ = self.conn.execute_batch(&format!(
                    "ALTER TABLE gallery_upload_jobs ADD COLUMN {} {};",
                    col, column_type
                ));
            }
        }
        for (col, column_type) in [("cache_path", "TEXT")] {
            let check: bool = self
                .conn
                .prepare(
                    "SELECT COUNT(*) FROM pragma_table_info('gallery_upload_items') WHERE name = ?1 LIMIT 1",
                )
                .and_then(|mut stmt| stmt.query_row(params![col], |row| row.get::<_, i64>(0)))
                .map(|count| count > 0)
                .unwrap_or(false);
            if !check {
                let _ = self.conn.execute_batch(&format!(
                    "ALTER TABLE gallery_upload_items ADD COLUMN {} {};",
                    col, column_type
                ));
            }
        }
        for (col, column_type) in [("downloaded_at", "TEXT"), ("download_output_path", "TEXT")] {
            let check: bool = self
                .conn
                .prepare("SELECT COUNT(*) FROM pragma_table_info('order_postings') WHERE name = ?1 LIMIT 1")
                .and_then(|mut stmt| stmt.query_row(params![col], |row| row.get::<_, i64>(0)))
                .map(|count| count > 0)
                .unwrap_or(false);
            if !check {
                let _ = self.conn.execute_batch(&format!(
                    "ALTER TABLE order_postings ADD COLUMN {} {};",
                    col, column_type
                ));
            }
        }
        Ok(())
    }

    pub fn list_shops(&self) -> Result<Vec<Shop>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT id, name, client_id, api_key_ref, oss_access_key_id, oss_secret_ref,
                   oss_bucket, oss_endpoint, oss_public_domain, watermark_path, shop_role,
                   follows_shop_id, follow_warehouse_id, api_key_plain, oss_secret_plain,
                   enabled, created_at, updated_at, maintenance_warehouse_id, maintenance_stock,
                   maintenance_stock_enabled, maintenance_barcode_enabled,
                   maintenance_action_enabled, maintenance_interval_minutes,
                   maintenance_action_configs
            FROM shops
            ORDER BY enabled DESC, lower(name) ASC, client_id ASC, created_at ASC
            "#,
        )?;
        let rows = stmt.query_map([], |row| {
            let id: String = row.get(0)?;
            Ok(Shop {
                ozon_seller_cookie_stored: secrets::get_secret(&secrets::ozon_seller_cookie_id(
                    &id,
                ))
                .is_ok(),
                id,
                name: row.get(1)?,
                client_id: row.get(2)?,
                api_key_stored: !row.get::<_, String>(3)?.is_empty(),
                oss_access_key_id: row.get(4)?,
                oss_access_key_stored: row.get::<_, Option<String>>(5)?.is_some(),
                oss_bucket: row.get(6)?,
                oss_endpoint: row.get(7)?,
                oss_public_domain: row.get(8)?,
                watermark_path: row.get(9)?,
                shop_role: row
                    .get::<_, Option<String>>(10)?
                    .or_else(|| Some("main".into())),
                follows_shop_id: row.get(11)?,
                follow_warehouse_id: row.get(12)?,
                api_key_plain: row.get(13)?,
                oss_secret_plain: row.get(14)?,
                enabled: row.get::<_, i64>(15)? == 1,
                created_at: row.get(16)?,
                updated_at: row.get(17)?,
                maintenance_warehouse_id: row.get(18)?,
                maintenance_stock: row.get(19)?,
                maintenance_stock_enabled: row.get::<_, i64>(20).unwrap_or(1) == 1,
                maintenance_barcode_enabled: row.get::<_, i64>(21).unwrap_or(1) == 1,
                maintenance_action_enabled: row.get::<_, i64>(22).unwrap_or(0) == 1,
                maintenance_interval_minutes: row.get(23)?,
                maintenance_action_configs: row
                    .get::<_, Option<String>>(24)?
                    .and_then(|text| serde_json::from_str(&text).ok())
                    .unwrap_or_default(),
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("无法读取店铺列表")
    }

    pub fn save_shop(&self, draft: ShopDraft) -> Result<Shop> {
        if draft.name.trim().is_empty() {
            anyhow::bail!("店铺名称不能为空");
        }
        if draft.client_id.trim().is_empty() {
            anyhow::bail!("Client-Id 不能为空");
        }

        let now = Utc::now().to_rfc3339();
        let id = draft.id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let api_ref = secrets::ozon_api_key_id(&id);
        let oss_ref = secrets::oss_secret_key_id(&id);

        let new_api_key = draft
            .api_key
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string);
        if let Some(ref key) = new_api_key {
            let _ = secrets::set_secret(&api_ref, key);
        }
        let new_oss = draft
            .oss_access_key_secret
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string);
        if let Some(ref secret) = new_oss {
            let _ = secrets::set_secret(&oss_ref, secret);
        }
        // 仅在提供了新值时更新明文列，否则保留旧值
        let api_key_plain: Option<String> = if new_api_key.is_some() {
            new_api_key.clone()
        } else {
            empty_to_none(
                self.conn
                    .query_row(
                        "SELECT api_key_plain FROM shops WHERE id = ?1",
                        params![&id],
                        |row| row.get(0),
                    )
                    .ok(),
            )
        };
        let oss_plain: Option<String> = if new_oss.is_some() {
            new_oss.clone()
        } else {
            empty_to_none(
                self.conn
                    .query_row(
                        "SELECT oss_secret_plain FROM shops WHERE id = ?1",
                        params![&id],
                        |row| row.get(0),
                    )
                    .ok(),
            )
        };

        let created_at: String = self
            .conn
            .query_row(
                "SELECT created_at FROM shops WHERE id = ?1",
                params![&id],
                |row| row.get(0),
            )
            .unwrap_or_else(|_| now.clone());
        let shop_role = draft
            .shop_role
            .as_deref()
            .map(str::trim)
            .filter(|value| *value == "follower")
            .unwrap_or("main")
            .to_string();
        let follows_shop_id = if shop_role == "follower" {
            empty_to_none(draft.follows_shop_id)
        } else {
            None
        };
        let follow_warehouse_id = if shop_role == "follower" {
            draft.follow_warehouse_id.filter(|value| *value > 0)
        } else {
            None
        };
        if follows_shop_id.as_deref() == Some(id.as_str()) {
            anyhow::bail!("跟卖店铺不能跟卖自己");
        }

        let maintenance_action_configs = serde_json::to_string(&draft.maintenance_action_configs)
            .unwrap_or_else(|_| "[]".into());

        self.conn.execute(
            r#"
            INSERT INTO shops (
              id, name, client_id, api_key_ref, oss_access_key_id, oss_secret_ref,
              oss_bucket, oss_endpoint, oss_public_domain, watermark_path, shop_role,
              follows_shop_id, follow_warehouse_id, api_key_plain, oss_secret_plain,
              enabled, created_at, updated_at, maintenance_warehouse_id, maintenance_stock,
              maintenance_stock_enabled, maintenance_barcode_enabled,
              maintenance_action_enabled, maintenance_interval_minutes,
              maintenance_action_configs
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              client_id = excluded.client_id,
              oss_access_key_id = excluded.oss_access_key_id,
              oss_bucket = excluded.oss_bucket,
              oss_endpoint = excluded.oss_endpoint,
              oss_public_domain = excluded.oss_public_domain,
              watermark_path = excluded.watermark_path,
              shop_role = excluded.shop_role,
              follows_shop_id = excluded.follows_shop_id,
              follow_warehouse_id = excluded.follow_warehouse_id,
              api_key_plain = excluded.api_key_plain,
              oss_secret_plain = excluded.oss_secret_plain,
              enabled = excluded.enabled,
              maintenance_warehouse_id = excluded.maintenance_warehouse_id,
              maintenance_stock = excluded.maintenance_stock,
              maintenance_stock_enabled = excluded.maintenance_stock_enabled,
              maintenance_barcode_enabled = excluded.maintenance_barcode_enabled,
              maintenance_action_enabled = excluded.maintenance_action_enabled,
              maintenance_interval_minutes = excluded.maintenance_interval_minutes,
              maintenance_action_configs = excluded.maintenance_action_configs,
              updated_at = excluded.updated_at
            "#,
            params![
                &id,
                draft.name.trim(),
                draft.client_id.trim(),
                &api_ref,
                empty_to_none(draft.oss_access_key_id),
                &oss_ref,
                empty_to_none(draft.oss_bucket),
                empty_to_none(draft.oss_endpoint),
                empty_to_none(draft.oss_public_domain),
                empty_to_none(draft.watermark_path),
                shop_role,
                follows_shop_id,
                follow_warehouse_id,
                api_key_plain,
                oss_plain,
                if draft.enabled { 1 } else { 0 },
                &created_at,
                &now,
                draft.maintenance_warehouse_id.filter(|value| *value > 0),
                draft.maintenance_stock.filter(|value| *value >= 0),
                if draft.maintenance_stock_enabled { 1 } else { 0 },
                if draft.maintenance_barcode_enabled { 1 } else { 0 },
                if draft.maintenance_action_enabled { 1 } else { 0 },
                draft
                    .maintenance_interval_minutes
                    .unwrap_or(5)
                    .clamp(1, 1440),
                maintenance_action_configs
            ],
        )?;

        self.get_shop(&id)
    }

    pub fn get_shop(&self, id: &str) -> Result<Shop> {
        self.list_shops()?
            .into_iter()
            .find(|shop| shop.id == id)
            .context("未找到店铺")
    }

    pub fn delete_shop(&self, id: &str) -> Result<()> {
        secrets::delete_secret(&secrets::ozon_api_key_id(id))?;
        secrets::delete_secret(&secrets::oss_secret_key_id(id))?;
        secrets::delete_secret(&secrets::ozon_seller_cookie_id(id))?;
        self.conn
            .execute("DELETE FROM order_postings WHERE shop_id = ?1", params![id])?;
        self.conn
            .execute("DELETE FROM shops WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn load_settings(&self) -> Result<AppSettings> {
        let value: Option<String> = self
            .conn
            .query_row("SELECT value FROM settings WHERE key = 'app'", [], |row| {
                row.get(0)
            })
            .ok();
        match value {
            Some(text) => serde_json::from_str(&text).context("设置 JSON 损坏"),
            None => Ok(AppSettings::default()),
        }
    }

    pub fn save_settings(&self, settings: AppSettings) -> Result<AppSettings> {
        let mut normalized = settings;
        normalized.max_workers = normalized.max_workers.clamp(1, 16);
        let value = serde_json::to_string(&normalized)?;
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES ('app', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![value],
        )?;
        Ok(normalized)
    }

    pub fn list_templates(&self, kind: &str) -> Result<Vec<TemplateSummary>> {
        let kind = kind.trim();
        let mut stmt = self.conn.prepare(
            r#"
            SELECT id, kind, name, payload, created_at, updated_at
            FROM templates
            WHERE kind = ?1
            ORDER BY updated_at DESC, name ASC
            "#,
        )?;
        let rows = stmt.query_map(params![kind], |row| {
            let payload_text: String = row.get(3)?;
            let payload = serde_json::from_str(&payload_text).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    3,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            Ok(TemplateSummary {
                id: row.get(0)?,
                kind: row.get(1)?,
                name: row.get(2)?,
                payload,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("无法读取模板列表")
    }

    pub fn save_template(&self, draft: TemplateDraft) -> Result<TemplateSummary> {
        let kind = draft.kind.trim();
        let name = draft.name.trim();
        if kind.is_empty() {
            anyhow::bail!("模板类型不能为空");
        }
        if name.is_empty() {
            anyhow::bail!("模板名称不能为空");
        }
        let payload = serde_json::to_string(&draft.payload).context("模板 JSON 无法序列化")?;
        let now = Utc::now().to_rfc3339();
        let id = draft.id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let created_at: String = self
            .conn
            .query_row(
                "SELECT created_at FROM templates WHERE id = ?1",
                params![&id],
                |row| row.get(0),
            )
            .unwrap_or_else(|_| now.clone());

        self.conn.execute(
            r#"
            INSERT INTO templates (id, kind, name, payload, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(id) DO UPDATE SET
              kind = excluded.kind,
              name = excluded.name,
              payload = excluded.payload,
              updated_at = excluded.updated_at
            "#,
            params![&id, kind, name, payload, &created_at, &now],
        )?;
        self.get_template(&id)
    }

    pub fn delete_template(&self, id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM templates WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn list_jobs(&self) -> Result<Vec<JobSummary>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT id, kind, title, status, progress, input_path, output_path, result_path,
                   result_excel_path, success_count, failed_count, last_error, error,
                   created_at, updated_at
            FROM jobs
            ORDER BY updated_at DESC
            LIMIT 500
            "#,
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(JobSummary {
                id: row.get(0)?,
                kind: parse_job_kind(row.get::<_, String>(1)?.as_str()),
                title: row.get(2)?,
                status: parse_job_status(row.get::<_, String>(3)?.as_str()),
                progress: row.get::<_, i64>(4)?.clamp(0, 100) as u8,
                input_path: row.get(5)?,
                output_path: row.get(6)?,
                result_path: row.get(7)?,
                result_excel_path: row.get(8)?,
                success_count: row
                    .get::<_, Option<i64>>(9)?
                    .and_then(|value| usize::try_from(value).ok()),
                failed_count: row
                    .get::<_, Option<i64>>(10)?
                    .and_then(|value| usize::try_from(value).ok()),
                last_error: row.get(11)?,
                error: row.get(12)?,
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("无法读取任务列表")
    }

    pub fn list_job_logs(&self, job_id: &str) -> Result<Vec<JobLog>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT id, job_id, level, message, created_at
            FROM job_logs
            WHERE job_id = ?1
            ORDER BY created_at ASC
            LIMIT 2000
            "#,
        )?;
        let rows = stmt.query_map(params![job_id], |row| {
            Ok(JobLog {
                id: row.get(0)?,
                job_id: row.get(1)?,
                level: row.get(2)?,
                message: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("无法读取任务日志")
    }

    pub fn save_job(&self, job: &JobSummary) -> Result<()> {
        self.conn.execute(
            r#"
            INSERT INTO jobs (
              id, kind, title, status, progress, input_path, output_path, result_path,
              result_excel_path, success_count, failed_count, last_error, error, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
            ON CONFLICT(id) DO UPDATE SET
              kind = excluded.kind,
              title = excluded.title,
              status = excluded.status,
              progress = excluded.progress,
              input_path = excluded.input_path,
              output_path = excluded.output_path,
              result_path = excluded.result_path,
              result_excel_path = excluded.result_excel_path,
              success_count = excluded.success_count,
              failed_count = excluded.failed_count,
              last_error = excluded.last_error,
              error = excluded.error,
              updated_at = excluded.updated_at
            "#,
            params![
                &job.id,
                job_kind_to_str(job.kind),
                &job.title,
                job_status_to_str(job.status),
                i64::from(job.progress),
                &job.input_path,
                &job.output_path,
                &job.result_path,
                &job.result_excel_path,
                job.success_count.and_then(|value| i64::try_from(value).ok()),
                job.failed_count.and_then(|value| i64::try_from(value).ok()),
                &job.last_error,
                &job.error,
                &job.created_at,
                &job.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn save_auto_listing_scheduler_state(
        &self,
        record: &AutoListingSchedulerRecord,
    ) -> Result<()> {
        self.conn.execute(
            r#"
            INSERT INTO auto_listing_scheduler_state (
              account_id, plan_id, cloud_api_base_url, auth_secret_key, paused,
              last_quota_date, cloud_run_id, local_job_id, stage, pending_progress,
              last_error, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            ON CONFLICT(account_id, plan_id) DO UPDATE SET
              cloud_api_base_url = excluded.cloud_api_base_url,
              auth_secret_key = excluded.auth_secret_key,
              paused = excluded.paused,
              last_quota_date = excluded.last_quota_date,
              cloud_run_id = excluded.cloud_run_id,
              local_job_id = excluded.local_job_id,
              stage = excluded.stage,
              pending_progress = excluded.pending_progress,
              last_error = excluded.last_error,
              updated_at = excluded.updated_at
            "#,
            params![
                &record.account_id,
                &record.plan_id,
                &record.cloud_api_base_url,
                &record.auth_secret_key,
                i64::from(record.paused),
                &record.last_quota_date,
                &record.cloud_run_id,
                &record.local_job_id,
                &record.stage,
                serde_json::to_string(&record.pending_progress)?,
                &record.last_error,
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn list_auto_listing_scheduler_states(&self) -> Result<Vec<AutoListingSchedulerRecord>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT account_id, plan_id, cloud_api_base_url, auth_secret_key, paused,
                   last_quota_date, cloud_run_id, local_job_id, stage, pending_progress,
                   last_error
            FROM auto_listing_scheduler_state
            ORDER BY account_id, plan_id
            "#,
        )?;
        let rows = stmt.query_map([], |row| {
            let pending_progress = row.get::<_, String>(9)?;
            Ok(AutoListingSchedulerRecord {
                account_id: row.get(0)?,
                plan_id: row.get(1)?,
                cloud_api_base_url: row.get(2)?,
                auth_secret_key: row.get(3)?,
                paused: row.get::<_, i64>(4)? != 0,
                last_quota_date: row.get(5)?,
                cloud_run_id: row.get(6)?,
                local_job_id: row.get(7)?,
                stage: row.get(8)?,
                pending_progress: serde_json::from_str(&pending_progress)
                    .unwrap_or(Value::Array(Vec::new())),
                last_error: row.get(10)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("无法读取自动上品调度状态")
    }

    pub fn save_job_log(&self, log: &JobLog) -> Result<()> {
        self.conn.execute(
            r#"
            INSERT INTO job_logs (id, job_id, level, message, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(id) DO NOTHING
            "#,
            params![
                &log.id,
                &log.job_id,
                &log.level,
                &log.message,
                &log.created_at
            ],
        )?;
        Ok(())
    }

    pub fn reserve_order_shipping_labels(
        &self,
        assignments: &[OrderShippingLabelAssignment],
    ) -> Result<()> {
        let transaction = self.conn.unchecked_transaction()?;
        let reserved_at = Utc::now().to_rfc3339();
        for assignment in assignments {
            let shop_id = assignment.shop_id.trim();
            let order_number = assignment.order_number.trim();
            let url = assignment.url.trim();
            if shop_id.is_empty() || order_number.is_empty() || url.is_empty() {
                anyhow::bail!("物流贴单分配缺少店铺、订单号或 PDF 地址");
            }
            let existing_by_url = transaction
                .query_row(
                    "SELECT shop_id, order_number FROM order_shipping_labels WHERE url = ?1",
                    [url],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?;
            if let Some((existing_shop_id, existing_order_number)) = existing_by_url {
                if existing_shop_id != shop_id || existing_order_number != order_number {
                    anyhow::bail!(
                        "物流贴单地址已被订单 {} 使用，不能重复分配：{}",
                        existing_order_number,
                        url
                    );
                }
                continue;
            }
            let existing_url = transaction
                .query_row(
                    "SELECT url FROM order_shipping_labels WHERE shop_id = ?1 AND order_number = ?2",
                    params![shop_id, order_number],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if let Some(existing_url) = existing_url {
                anyhow::bail!(
                    "订单 {} 已经分配了其他物流贴单，不能再次更换：{}",
                    order_number,
                    existing_url
                );
            }
            transaction.execute(
                "INSERT INTO order_shipping_labels (url, shop_id, order_number, reserved_at) VALUES (?1, ?2, ?3, ?4)",
                params![url, shop_id, order_number, reserved_at],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn mark_order_shipping_label_downloaded(
        &self,
        shop_id: &str,
        order_number: &str,
        output_path: &str,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE order_shipping_labels SET downloaded_at = ?1, output_path = ?2 WHERE shop_id = ?3 AND order_number = ?4",
            params![Utc::now().to_rfc3339(), output_path, shop_id, order_number],
        )?;
        Ok(())
    }

    pub fn save_order_postings(&self, rows: &[OrderPostingRow]) -> Result<()> {
        for row in rows {
            self.save_order_posting(row)?;
        }
        Ok(())
    }

    pub fn mark_order_postings_downloaded(
        &self,
        shop_id: &str,
        posting_numbers: &[String],
        output_path: &str,
    ) -> Result<()> {
        let downloaded_at = Utc::now().to_rfc3339();
        for posting_number in posting_numbers {
            self.conn.execute(
                "UPDATE order_postings SET downloaded_at = ?1, download_output_path = ?2 WHERE shop_id = ?3 AND posting_number = ?4",
                params![downloaded_at, output_path, shop_id, posting_number],
            )?;
        }
        Ok(())
    }

    pub fn save_order_posting(&self, row: &OrderPostingRow) -> Result<()> {
        let shop_id = row
            .shop_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("订单缺少店铺 ID，无法保存历史")?;
        let posting_number = row.posting_number.trim();
        if posting_number.is_empty() {
            anyhow::bail!("订单缺少货件编号，无法保存历史");
        }
        let synced_at = row
            .synced_at
            .clone()
            .unwrap_or_else(|| Utc::now().to_rfc3339());
        let offer_ids_json = serde_json::to_string(&row.offer_ids)?;
        let products_json = serde_json::to_string(&row.products.clone().unwrap_or_default())?;
        let raw_json = serde_json::to_string(&row.raw_json.clone().unwrap_or(Value::Null))?;
        self.conn.execute(
            r#"
            INSERT INTO order_postings (
              shop_id, posting_number, shop_name, order_number, order_id, status,
              in_process_at, shipment_date, warehouse_name, tracking_number,
              products_count, offer_ids_json, products_json, image_url, sales_amount,
              currency_code, raw_json, synced_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
            ON CONFLICT(shop_id, posting_number) DO UPDATE SET
              shop_name = excluded.shop_name,
              order_number = excluded.order_number,
              order_id = excluded.order_id,
              status = excluded.status,
              in_process_at = excluded.in_process_at,
              shipment_date = excluded.shipment_date,
              warehouse_name = excluded.warehouse_name,
              tracking_number = excluded.tracking_number,
              products_count = excluded.products_count,
              offer_ids_json = excluded.offer_ids_json,
              products_json = excluded.products_json,
              image_url = COALESCE(excluded.image_url, order_postings.image_url),
              sales_amount = excluded.sales_amount,
              currency_code = excluded.currency_code,
              raw_json = excluded.raw_json,
              synced_at = excluded.synced_at
            "#,
            params![
                shop_id,
                posting_number,
                &row.shop_name,
                &row.order_number,
                &row.order_id,
                &row.status,
                &row.in_process_at,
                &row.shipment_date,
                &row.warehouse_name,
                &row.tracking_number,
                row.products_count as i64,
                offer_ids_json,
                products_json,
                &row.image_url,
                &row.sales_amount,
                &row.currency_code,
                raw_json,
                synced_at,
            ],
        )?;
        Ok(())
    }

    pub fn list_saved_order_postings(
        &self,
        query: StoredOrderQuery,
    ) -> Result<Vec<OrderPostingRow>> {
        let limit = query.limit.unwrap_or(1000).clamp(1, 5000) as usize;
        let shop_ids = query
            .shop_ids
            .unwrap_or_default()
            .into_iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        let status = query.status.unwrap_or_default().trim().to_string();
        let keyword = query.keyword.unwrap_or_default().trim().to_lowercase();
        let mut stmt = self.conn.prepare(
            r#"
            SELECT shop_id, posting_number, shop_name, order_number, order_id, status,
                   in_process_at, shipment_date, warehouse_name, tracking_number,
                   products_count, offer_ids_json, products_json, image_url, sales_amount,
                   currency_code, raw_json, synced_at, downloaded_at, download_output_path
            FROM order_postings
            ORDER BY COALESCE(in_process_at, shipment_date, synced_at) DESC
            LIMIT 5000
            "#,
        )?;
        let rows = stmt.query_map([], order_posting_from_row)?;
        let shop_filter = if shop_ids.is_empty() {
            None
        } else {
            Some(
                shop_ids
                    .into_iter()
                    .collect::<std::collections::HashSet<_>>(),
            )
        };
        let mut result = Vec::new();
        for row in rows {
            let row = row?;
            if let Some(ref filter) = shop_filter {
                if !row.shop_id.as_ref().is_some_and(|id| filter.contains(id)) {
                    continue;
                }
            }
            if !status.is_empty() && row.status.as_deref() != Some(status.as_str()) {
                continue;
            }
            if !keyword.is_empty() && !order_row_matches_keyword(&row, &keyword) {
                continue;
            }
            result.push(row);
            if result.len() >= limit {
                break;
            }
        }
        Ok(result)
    }

    pub fn get_saved_order_posting(
        &self,
        shop_id: &str,
        posting_number: &str,
    ) -> Result<Option<OrderPostingRow>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT shop_id, posting_number, shop_name, order_number, order_id, status,
                   in_process_at, shipment_date, warehouse_name, tracking_number,
                   products_count, offer_ids_json, products_json, image_url, sales_amount,
                   currency_code, raw_json, synced_at
            FROM order_postings
            WHERE shop_id = ?1 AND posting_number = ?2
            LIMIT 1
            "#,
        )?;
        stmt.query_row(params![shop_id, posting_number], order_posting_from_row)
            .optional()
            .context("无法读取订单历史")
    }

    fn get_template(&self, id: &str) -> Result<TemplateSummary> {
        let (kind, name, payload_text, created_at, updated_at): (
            String,
            String,
            String,
            String,
            String,
        ) = self
            .conn
            .query_row(
                "SELECT kind, name, payload, created_at, updated_at FROM templates WHERE id = ?1",
                params![id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .context("未找到模板")?;
        Ok(TemplateSummary {
            id: id.to_string(),
            kind,
            name,
            payload: serde_json::from_str(&payload_text).context("模板 JSON 损坏")?,
            created_at,
            updated_at,
        })
    }

    pub fn shop_api_key(&self, shop_id: &str) -> Result<String> {
        let shop = self.get_shop(shop_id)?;
        // 优先从系统密钥库读取
        if let Ok(key) = secrets::get_secret(&secrets::ozon_api_key_id(&shop.id)) {
            return Ok(key);
        }
        // 后备：从 SQLite 明文读取
        if let Some(ref plain) = shop.api_key_plain {
            if !plain.is_empty() {
                return Ok(plain.clone());
            }
        }
        anyhow::bail!("未找到密钥")
    }

    pub fn shop_oss_secret(&self, shop_id: &str) -> Result<String> {
        let (_, secret) = self.shop_with_effective_oss(shop_id)?;
        Ok(secret)
    }

    pub fn shop_seller_cookie(&self, shop_id: &str) -> Result<String> {
        secrets::get_secret(&secrets::ozon_seller_cookie_id(shop_id))
    }

    pub fn save_shop_seller_cookie(&self, shop_id: &str, cookie: &str) -> Result<Shop> {
        self.get_shop(shop_id)?;
        secrets::set_secret(&secrets::ozon_seller_cookie_id(shop_id), cookie)?;
        self.get_shop(shop_id)
    }

    pub fn shop_with_effective_oss(&self, shop_id: &str) -> Result<(Shop, String)> {
        let mut shop = self.get_shop(shop_id)?;
        let oss_source = self.effective_oss_source(&shop)?;
        let secret = self.shop_oss_secret_direct(&oss_source.id)?;
        shop.oss_access_key_id = oss_source.oss_access_key_id;
        shop.oss_access_key_stored = true;
        shop.oss_bucket = oss_source.oss_bucket;
        shop.oss_endpoint = oss_source.oss_endpoint;
        shop.oss_public_domain = oss_source.oss_public_domain;
        Ok((shop, secret))
    }

    fn effective_oss_source(&self, shop: &Shop) -> Result<Shop> {
        if shop.shop_role.as_deref() == Some("follower") {
            let main_id = shop
                .follows_shop_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .context("跟卖店铺未选择主店，无法复用主店 OSS")?;
            let main = self.get_shop(main_id)?;
            if self.shop_has_complete_oss(&main) && self.shop_oss_secret_direct(&main.id).is_ok() {
                return Ok(main);
            }
            anyhow::bail!("主店 OSS 配置不完整，无法复用");
        }

        if self.shop_has_complete_oss(shop) && self.shop_oss_secret_direct(&shop.id).is_ok() {
            return Ok(shop.clone());
        }

        self.list_shops()?
            .into_iter()
            .find(|candidate| {
                candidate.enabled
                    && candidate.shop_role.as_deref() != Some("follower")
                    && self.shop_has_complete_oss(candidate)
                    && self.shop_oss_secret_direct(&candidate.id).is_ok()
            })
            .context("未找到可复用的主店 OSS 配置")
    }

    fn shop_has_complete_oss(&self, shop: &Shop) -> bool {
        !shop
            .oss_access_key_id
            .as_deref()
            .unwrap_or("")
            .trim()
            .is_empty()
            && !shop.oss_bucket.as_deref().unwrap_or("").trim().is_empty()
            && !shop.oss_endpoint.as_deref().unwrap_or("").trim().is_empty()
            && !shop
                .oss_public_domain
                .as_deref()
                .unwrap_or("")
                .trim()
                .is_empty()
    }

    fn shop_oss_secret_direct(&self, shop_id: &str) -> Result<String> {
        let shop = self.get_shop(shop_id)?;
        if let Ok(secret) = secrets::get_secret(&secrets::oss_secret_key_id(&shop.id)) {
            return Ok(secret);
        }
        if let Some(ref plain) = shop.oss_secret_plain {
            if !plain.is_empty() {
                return Ok(plain.clone());
            }
        }
        anyhow::bail!("未找到密钥")
    }
}

fn empty_to_none(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn order_posting_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<OrderPostingRow> {
    let offer_ids_json: String = row.get(11)?;
    let products_json: String = row.get(12)?;
    let raw_json: String = row.get(16)?;
    let offer_ids = serde_json::from_str(&offer_ids_json).unwrap_or_default();
    let products = serde_json::from_str(&products_json).unwrap_or_default();
    let raw_json: Option<Value> = serde_json::from_str(&raw_json).ok();
    let posting_kind = raw_json
        .as_ref()
        .and_then(|value| {
            value
                .get("posting_kind")
                .or_else(|| value.get("postingKind"))
                .and_then(Value::as_str)
        })
        .map(str::to_string);
    Ok(OrderPostingRow {
        shop_id: row.get(0)?,
        shop_name: row.get(2)?,
        posting_kind,
        posting_number: row.get(1)?,
        order_number: row.get(3)?,
        order_id: row.get(4)?,
        status: row.get(5)?,
        in_process_at: row.get(6)?,
        shipment_date: row.get(7)?,
        warehouse_name: row.get(8)?,
        tracking_number: row.get(9)?,
        products_count: row
            .get::<_, i64>(10)
            .map(|value| usize::try_from(value).unwrap_or_default())?,
        offer_ids,
        products: Some(products),
        image_url: row.get(13)?,
        sales_amount: row.get(14)?,
        currency_code: row.get(15)?,
        raw_json,
        synced_at: row.get(17)?,
        downloaded_at: row.get(18)?,
        download_output_path: row.get(19)?,
    })
}

fn order_row_matches_keyword(row: &OrderPostingRow, keyword: &str) -> bool {
    let mut values = vec![
        row.posting_number.to_lowercase(),
        row.shop_name.clone().unwrap_or_default().to_lowercase(),
        row.order_number.clone().unwrap_or_default().to_lowercase(),
        row.status.clone().unwrap_or_default().to_lowercase(),
        row.tracking_number
            .clone()
            .unwrap_or_default()
            .to_lowercase(),
    ];
    values.extend(row.offer_ids.iter().map(|value| value.to_lowercase()));
    values.extend(
        row.products
            .clone()
            .unwrap_or_default()
            .into_iter()
            .flat_map(|product| {
                [
                    product.offer_id.to_lowercase(),
                    product.name.unwrap_or_default().to_lowercase(),
                ]
            }),
    );
    values.iter().any(|value| value.contains(keyword))
}

fn parse_job_status(value: &str) -> JobStatus {
    match value {
        "queued" => JobStatus::Queued,
        "running" => JobStatus::Running,
        "succeeded" => JobStatus::Succeeded,
        "failed" => JobStatus::Failed,
        "cancelled" => JobStatus::Cancelled,
        _ => JobStatus::Failed,
    }
}

fn job_status_to_str(value: JobStatus) -> &'static str {
    match value {
        JobStatus::Queued => "queued",
        JobStatus::Running => "running",
        JobStatus::Succeeded => "succeeded",
        JobStatus::Failed => "failed",
        JobStatus::Cancelled => "cancelled",
    }
}

fn parse_job_kind(value: &str) -> JobKind {
    match value {
        "materials" => JobKind::Materials,
        "scene_local" => JobKind::SceneLocal,
        "scene_ai" => JobKind::SceneAi,
        "local_mockup" => JobKind::LocalMockup,
        "auto_listing" => JobKind::AutoListing,
        "gallery_upload" => JobKind::GalleryUpload,
        "batch_upload" => JobKind::BatchUpload,
        "listing_image_repair" => JobKind::ListingImageRepair,
        "listed_update" => JobKind::ListedUpdate,
        "follow_sync" => JobKind::FollowSync,
        "follow_automation" => JobKind::FollowAutomation,
        "listing_maintenance" => JobKind::ListingMaintenance,
        "inventory" => JobKind::Inventory,
        "barcode" => JobKind::Barcode,
        "order_documents" => JobKind::OrderDocuments,
        "api_test" => JobKind::ApiTest,
        _ => JobKind::ApiTest,
    }
}

fn job_kind_to_str(value: JobKind) -> &'static str {
    match value {
        JobKind::Materials => "materials",
        JobKind::SceneLocal => "scene_local",
        JobKind::SceneAi => "scene_ai",
        JobKind::LocalMockup => "local_mockup",
        JobKind::AutoListing => "auto_listing",
        JobKind::GalleryUpload => "gallery_upload",
        JobKind::BatchUpload => "batch_upload",
        JobKind::ListingImageRepair => "listing_image_repair",
        JobKind::ListedUpdate => "listed_update",
        JobKind::FollowSync => "follow_sync",
        JobKind::FollowAutomation => "follow_automation",
        JobKind::ListingMaintenance => "listing_maintenance",
        JobKind::Inventory => "inventory",
        JobKind::Barcode => "barcode",
        JobKind::OrderDocuments => "order_documents",
        JobKind::ApiTest => "api_test",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn template_crud_roundtrip() {
        let path = std::env::temp_dir().join(format!("ozon-sjsq-test-{}.sqlite3", Uuid::new_v4()));
        let db = Database::open_at(path.clone()).unwrap();
        let saved = db
            .save_template(TemplateDraft {
                id: None,
                kind: "product_import".into(),
                name: "围巾模板".into(),
                payload: json!({"currency_code": "RUB", "category_id": 1}),
            })
            .unwrap();
        assert_eq!(saved.name, "围巾模板");

        let rows = db.list_templates("product_import").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].payload["currency_code"], "RUB");

        db.delete_template(&saved.id).unwrap();
        assert!(db.list_templates("product_import").unwrap().is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn follower_reuses_main_shop_oss() {
        let path = std::env::temp_dir().join(format!("ozon-sjsq-test-{}.sqlite3", Uuid::new_v4()));
        let db = Database::open_at(path.clone()).unwrap();
        let main = db
            .save_shop(ShopDraft {
                id: None,
                name: "主店".into(),
                client_id: "main-client".into(),
                api_key: Some("main-api".into()),
                oss_access_key_id: Some("main-oss-key".into()),
                oss_access_key_secret: Some("main-oss-secret".into()),
                oss_bucket: Some("main-bucket".into()),
                oss_endpoint: Some("oss-cn.example.com".into()),
                oss_public_domain: Some("https://cdn.example.com".into()),
                watermark_path: None,
                shop_role: Some("main".into()),
                follows_shop_id: None,
                follow_warehouse_id: None,
                maintenance_warehouse_id: None,
                maintenance_stock: Some(50),
                maintenance_stock_enabled: true,
                maintenance_barcode_enabled: true,
                maintenance_action_enabled: false,
                maintenance_interval_minutes: Some(5),
                maintenance_action_configs: Vec::new(),
                enabled: true,
            })
            .unwrap();
        let follower = db
            .save_shop(ShopDraft {
                id: None,
                name: "跟卖店".into(),
                client_id: "follower-client".into(),
                api_key: Some("follower-api".into()),
                oss_access_key_id: None,
                oss_access_key_secret: None,
                oss_bucket: None,
                oss_endpoint: None,
                oss_public_domain: None,
                watermark_path: None,
                shop_role: Some("follower".into()),
                follows_shop_id: Some(main.id.clone()),
                follow_warehouse_id: Some(42),
                maintenance_warehouse_id: None,
                maintenance_stock: Some(50),
                maintenance_stock_enabled: true,
                maintenance_barcode_enabled: true,
                maintenance_action_enabled: false,
                maintenance_interval_minutes: Some(5),
                maintenance_action_configs: Vec::new(),
                enabled: true,
            })
            .unwrap();

        let (effective_shop, secret) = db.shop_with_effective_oss(&follower.id).unwrap();
        assert_eq!(effective_shop.client_id, "follower-client");
        assert_eq!(
            effective_shop.oss_access_key_id.as_deref(),
            Some("main-oss-key")
        );
        assert_eq!(effective_shop.oss_bucket.as_deref(), Some("main-bucket"));
        assert_eq!(effective_shop.follow_warehouse_id, Some(42));
        assert_eq!(secret, "main-oss-secret");
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn shipping_label_url_cannot_be_assigned_to_another_order() {
        let path = std::env::temp_dir().join(format!("ozon-sjsq-test-{}.sqlite3", Uuid::new_v4()));
        let db = Database::open_at(path.clone()).unwrap();
        let url = "https://example.test/label.pdf";
        db.reserve_order_shipping_labels(&[OrderShippingLabelAssignment {
            shop_id: "shop-a".into(),
            order_number: "order-1".into(),
            url: url.into(),
        }])
        .unwrap();

        let error = db
            .reserve_order_shipping_labels(&[OrderShippingLabelAssignment {
                shop_id: "shop-a".into(),
                order_number: "order-2".into(),
                url: url.into(),
            }])
            .unwrap_err();
        assert!(error.to_string().contains("不能重复分配"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn scheduler_checkpoint_roundtrip_preserves_recovery_progress() {
        let path = std::env::temp_dir().join(format!("ozon-sjsq-test-{}.sqlite3", Uuid::new_v4()));
        let db = Database::open_at(path.clone()).unwrap();
        db.save_auto_listing_scheduler_state(&AutoListingSchedulerRecord {
            account_id: "account-a".into(),
            plan_id: "plan-a".into(),
            cloud_api_base_url: "https://cloud.example".into(),
            auth_secret_key: "secret-ref".into(),
            paused: false,
            last_quota_date: Some("2026-07-28".into()),
            cloud_run_id: Some("run-a".into()),
            local_job_id: Some("job-a".into()),
            stage: Some("submitting".into()),
            pending_progress: json!([{"assignmentId":"assignment-a","status":"completed"}]),
            last_error: None,
        })
        .unwrap();

        let records = db.list_auto_listing_scheduler_states().unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].cloud_run_id.as_deref(), Some("run-a"));
        assert_eq!(records[0].local_job_id.as_deref(), Some("job-a"));
        assert_eq!(
            records[0].pending_progress[0]["assignmentId"],
            "assignment-a"
        );
        let _ = std::fs::remove_file(path);
    }
}
