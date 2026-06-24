use crate::core::models::{AppSettings, Shop, ShopDraft, TemplateDraft, TemplateSummary};
use crate::core::secrets;
use anyhow::{Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

pub struct Database {
    conn: Connection,
}

impl Database {
    pub fn open(app: &AppHandle) -> Result<Self> {
        let dir = app.path().app_data_dir().context("无法定位应用数据目录")?;
        fs::create_dir_all(&dir).context("无法创建应用数据目录")?;
        let path = dir.join("ozon-sjsq.sqlite3");
        let conn = Connection::open(path).context("无法打开 SQLite 数据库")?;
        let db = Self { conn };
        db.migrate()?;
        Ok(db)
    }

    #[allow(dead_code)]
    pub fn open_at(path: PathBuf) -> Result<Self> {
        let conn = Connection::open(path).context("无法打开 SQLite 数据库")?;
        let db = Self { conn };
        db.migrate()?;
        Ok(db)
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
        ] {
            let check: bool = self
                .conn
                .prepare("SELECT COUNT(*) FROM pragma_table_info('shops') WHERE name = ?1 LIMIT 1")
                .and_then(|mut stmt| stmt.query_row(params![col], |row| row.get::<_, i64>(0)))
                .map(|count| count > 0)
                .unwrap_or(false);
            if !check {
                let column_type = if col == "follow_warehouse_id" {
                    "INTEGER"
                } else {
                    "TEXT"
                };
                let _ = self.conn.execute_batch(&format!(
                    "ALTER TABLE shops ADD COLUMN {} {};",
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
                   enabled, created_at, updated_at
            FROM shops
            ORDER BY enabled DESC, updated_at DESC
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

        self.conn.execute(
            r#"
            INSERT INTO shops (
              id, name, client_id, api_key_ref, oss_access_key_id, oss_secret_ref,
              oss_bucket, oss_endpoint, oss_public_domain, watermark_path, shop_role,
              follows_shop_id, follow_warehouse_id, api_key_plain, oss_secret_plain,
              enabled, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
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
                &now
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
}
