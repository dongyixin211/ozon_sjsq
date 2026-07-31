use crate::core::secrets;
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const CACHE_KEY_ID: &str = "local:cloud_cache_db_key:v1";

pub struct CloudCache {
    conn: Connection,
    encryption_key: [u8; 32],
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncStatus {
    pub account_id: String,
    pub scope: String,
    pub completed: bool,
    pub syncing: bool,
    pub cursor: i64,
    pub last_success_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CloudOutboxItem {
    pub id: String,
    pub account_id: String,
    pub base_url: String,
    pub auth_token: String,
    pub method: String,
    pub path: String,
    pub payload: Option<Value>,
}

impl CloudCache {
    pub fn open(app: &AppHandle) -> Result<Self> {
        let dir = app.path().app_data_dir().context("无法定位应用数据目录")?;
        fs::create_dir_all(&dir).context("无法创建应用数据目录")?;
        let path = dir.join("cloud-cache.sqlite3");
        let encryption_key = cache_key()?;
        let conn = Connection::open(path).context("无法打开本地加密云缓存")?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS cloud_http_cache (
              account_id TEXT NOT NULL,
              cache_key TEXT NOT NULL,
              response_json TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              PRIMARY KEY (account_id, cache_key)
            );
            CREATE TABLE IF NOT EXISTS cloud_gallery_assets (
              account_id TEXT NOT NULL,
              scope TEXT NOT NULL,
              asset_id TEXT NOT NULL,
              sku TEXT NOT NULL,
              ratio_family TEXT,
              product_image_rule_id TEXT,
              listing_status TEXT,
              created_at TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              PRIMARY KEY (account_id, scope, asset_id)
            );
            CREATE INDEX IF NOT EXISTS cloud_gallery_assets_query_idx
              ON cloud_gallery_assets (account_id, scope, created_at DESC);
            CREATE INDEX IF NOT EXISTS cloud_gallery_assets_sku_idx
              ON cloud_gallery_assets (account_id, scope, sku);
            CREATE TABLE IF NOT EXISTS cloud_sync_state (
              account_id TEXT NOT NULL,
              scope TEXT NOT NULL,
              cursor INTEGER NOT NULL DEFAULT 0,
              completed INTEGER NOT NULL DEFAULT 0,
              syncing INTEGER NOT NULL DEFAULT 0,
              last_success_at TEXT,
              last_error TEXT,
              PRIMARY KEY (account_id, scope)
            );
            CREATE TABLE IF NOT EXISTS cloud_sync_outbox (
              id TEXT PRIMARY KEY,
              account_id TEXT NOT NULL,
              operation_key TEXT NOT NULL,
              entity_type TEXT NOT NULL,
              entity_id TEXT,
              method TEXT NOT NULL,
              path TEXT NOT NULL,
              base_url TEXT NOT NULL DEFAULT '',
              auth_token TEXT NOT NULL DEFAULT '',
              payload_json TEXT,
              created_at TEXT NOT NULL,
              not_before TEXT NOT NULL,
              attempt_count INTEGER NOT NULL DEFAULT 0,
              last_error TEXT,
              status TEXT NOT NULL DEFAULT 'pending',
              UNIQUE (account_id, operation_key)
            );
            CREATE INDEX IF NOT EXISTS cloud_sync_outbox_due_idx
              ON cloud_sync_outbox (status, not_before, created_at);
            CREATE TABLE IF NOT EXISTS cloud_account_state (
              account_id TEXT PRIMARY KEY,
              last_online_at TEXT,
              last_activity_at TEXT
            );
            "#,
        )?;
        ensure_column(
            &conn,
            "cloud_sync_outbox",
            "base_url",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column(
            &conn,
            "cloud_sync_outbox",
            "auth_token",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        Ok(Self {
            conn,
            encryption_key,
        })
    }

    pub fn get_http(&self, account_id: &str, cache_key: &str) -> Result<Option<Value>> {
        let raw = self.conn.query_row(
            "SELECT response_json FROM cloud_http_cache WHERE account_id = ?1 AND cache_key = ?2",
            params![account_id, cache_key],
            |row| row.get::<_, String>(0),
        ).optional()?;
        raw.map(|value| decrypt_json(&self.encryption_key, &value).context("本地云缓存格式不正确"))
            .transpose()
    }

    pub fn get_http_fresh(
        &self,
        account_id: &str,
        cache_key: &str,
        max_age_seconds: i64,
    ) -> Result<Option<Value>> {
        let row = self.conn.query_row(
            "SELECT response_json, updated_at FROM cloud_http_cache WHERE account_id = ?1 AND cache_key = ?2",
            params![account_id, cache_key],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ).optional()?;
        let Some((raw, updated_at)) = row else {
            return Ok(None);
        };
        let updated_at = DateTime::parse_from_rfc3339(&updated_at)?.with_timezone(&Utc);
        if Utc::now().signed_duration_since(updated_at).num_seconds() > max_age_seconds {
            return Ok(None);
        }
        Ok(Some(decrypt_json(&self.encryption_key, &raw)?))
    }

    pub fn put_http(&self, account_id: &str, cache_key: &str, value: &Value) -> Result<()> {
        self.conn.execute(
            r#"
            INSERT INTO cloud_http_cache (account_id, cache_key, response_json, updated_at)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT (account_id, cache_key) DO UPDATE SET
              response_json = excluded.response_json,
              updated_at = excluded.updated_at
            "#,
            params![
                account_id,
                cache_key,
                encrypt_json(&self.encryption_key, value)?,
                Utc::now().to_rfc3339()
            ],
        )?;
        Ok(())
    }

    pub fn replace_gallery_scope(
        &mut self,
        account_id: &str,
        scope: &str,
        assets: &[Value],
    ) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "DELETE FROM cloud_gallery_assets WHERE account_id = ?1 AND scope = ?2",
            params![account_id, scope],
        )?;
        for asset in assets {
            upsert_gallery_asset(&tx, &self.encryption_key, account_id, scope, asset)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn upsert_gallery_response(
        &mut self,
        account_id: &str,
        scope: &str,
        value: &Value,
    ) -> Result<()> {
        let Some(assets) = value.get("assets").and_then(Value::as_array) else {
            return Ok(());
        };
        let tx = self.conn.transaction()?;
        for asset in assets {
            upsert_gallery_asset(&tx, &self.encryption_key, account_id, scope, asset)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn query_gallery(&self, account_id: &str, scope: &str, query: &Value) -> Result<Value> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT payload_json
            FROM cloud_gallery_assets
            WHERE account_id = ?1 AND scope = ?2
            ORDER BY created_at DESC, asset_id DESC
            "#,
        )?;
        let rows = stmt.query_map(params![account_id, scope], |row| row.get::<_, String>(0))?;
        let excluded = query
            .get("excludeAssetIds")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<HashSet<_>>()
            })
            .unwrap_or_default();
        let keyword = query
            .get("keyword")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        let ratio_family = query
            .get("ratioFamily")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        let rule_id = query
            .get("productImageRuleId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        let listing_status = query.get("listingStatus").and_then(Value::as_str);
        let external_shop_id = query
            .get("externalShopId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        let mockup_template_id = query
            .get("mockupTemplateId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        let mockup_status = query
            .get("mockupStatus")
            .and_then(Value::as_str)
            .unwrap_or("all");
        let mut assets = Vec::new();
        for raw in rows {
            let asset = decrypt_json(&self.encryption_key, &raw?)?;
            let asset_id = asset.get("id").and_then(Value::as_str).unwrap_or_default();
            if excluded.contains(asset_id) {
                continue;
            }
            let sku = asset.get("sku").and_then(Value::as_str).unwrap_or_default();
            if !keyword.is_empty() && !sku.to_lowercase().contains(&keyword) {
                continue;
            }
            if ratio_family.is_some_and(|expected| {
                asset.get("ratioFamily").and_then(Value::as_str) != Some(expected)
            }) {
                continue;
            }
            if rule_id.is_some_and(|expected| {
                asset.get("productImageRuleId").and_then(Value::as_str) != Some(expected)
            }) {
                continue;
            }
            if !matches_listing_status(&asset, listing_status, external_shop_id) {
                continue;
            }
            let mockup_results = asset.get("mockupResults").and_then(Value::as_array);
            let has_mockup = mockup_results.is_some_and(|items| {
                items.iter().any(|item| {
                    mockup_template_id.is_none_or(|expected| {
                        item.get("templateId").and_then(Value::as_str) == Some(expected)
                    })
                })
            });
            if (mockup_status == "rendered" && !has_mockup)
                || (mockup_status == "not_rendered" && has_mockup)
            {
                continue;
            }
            assets.push(asset);
        }
        let total = assets.len();
        let offset = query.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
        let limit = query
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(100)
            .clamp(1, 500) as usize;
        let page = assets
            .into_iter()
            .skip(offset)
            .take(limit)
            .collect::<Vec<_>>();
        Ok(json!({
            "ok": true,
            "assets": page,
            "total": total,
            "limit": limit,
            "offset": offset,
            "local": true
        }))
    }

    pub fn set_syncing(&self, account_id: &str, scope: &str, syncing: bool) -> Result<()> {
        self.conn.execute(
            r#"
            INSERT INTO cloud_sync_state (account_id, scope, syncing)
            VALUES (?1, ?2, ?3)
            ON CONFLICT (account_id, scope) DO UPDATE SET syncing = excluded.syncing
            "#,
            params![account_id, scope, i64::from(syncing)],
        )?;
        Ok(())
    }

    pub fn finish_sync(&self, account_id: &str, scope: &str, cursor: i64) -> Result<()> {
        self.conn.execute(
            r#"
            INSERT INTO cloud_sync_state (account_id, scope, cursor, completed, syncing, last_success_at, last_error)
            VALUES (?1, ?2, ?3, 1, 0, ?4, NULL)
            ON CONFLICT (account_id, scope) DO UPDATE SET
              cursor = excluded.cursor,
              completed = 1,
              syncing = 0,
              last_success_at = excluded.last_success_at,
              last_error = NULL
            "#,
            params![account_id, scope, cursor, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn fail_sync(&self, account_id: &str, scope: &str, error: &str) -> Result<()> {
        self.conn.execute(
            r#"
            INSERT INTO cloud_sync_state (account_id, scope, syncing, last_error)
            VALUES (?1, ?2, 0, ?3)
            ON CONFLICT (account_id, scope) DO UPDATE SET syncing = 0, last_error = excluded.last_error
            "#,
            params![account_id, scope, error],
        )?;
        Ok(())
    }

    pub fn sync_status(&self, account_id: &str, scope: &str) -> Result<CloudSyncStatus> {
        let row = self
            .conn
            .query_row(
                r#"
            SELECT cursor, completed, syncing, last_success_at, last_error
            FROM cloud_sync_state WHERE account_id = ?1 AND scope = ?2
            "#,
                params![account_id, scope],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?;
        let (cursor, completed, syncing, last_success_at, last_error) =
            row.unwrap_or((0, 0, 0, None, None));
        Ok(CloudSyncStatus {
            account_id: account_id.to_string(),
            scope: scope.to_string(),
            completed: completed != 0,
            syncing: syncing != 0,
            cursor,
            last_success_at,
            last_error,
        })
    }

    pub fn enqueue(
        &self,
        account_id: &str,
        operation_key: &str,
        entity_type: &str,
        entity_id: Option<&str>,
        method: &str,
        path: &str,
        base_url: &str,
        auth_token: &str,
        payload: Option<&Value>,
        not_before: &str,
    ) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        self.conn.execute(
            r#"
            INSERT INTO cloud_sync_outbox (
              id, account_id, operation_key, entity_type, entity_id, method, path,
              base_url, auth_token, payload_json, created_at, not_before, status
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'pending')
            ON CONFLICT (account_id, operation_key) DO UPDATE SET
              entity_type = excluded.entity_type,
              entity_id = excluded.entity_id,
              method = excluded.method,
              path = excluded.path,
              base_url = excluded.base_url,
              auth_token = excluded.auth_token,
              payload_json = excluded.payload_json,
              not_before = excluded.not_before,
              status = 'pending',
              last_error = NULL
            "#,
            params![
                id,
                account_id,
                operation_key,
                entity_type,
                entity_id,
                method,
                path,
                base_url,
                encrypt_text(&self.encryption_key, auth_token)?,
                payload
                    .map(|value| encrypt_json(&self.encryption_key, value))
                    .transpose()?,
                Utc::now().to_rfc3339(),
                not_before,
            ],
        )?;
        self.conn.execute(
            r#"
            INSERT INTO cloud_account_state (account_id, last_activity_at)
            VALUES (?1, ?2)
            ON CONFLICT (account_id) DO UPDATE SET last_activity_at = excluded.last_activity_at
            "#,
            params![account_id, Utc::now().to_rfc3339()],
        )?;
        Ok(id)
    }

    pub fn record_online(&self, account_id: &str) -> Result<()> {
        if account_id.is_empty() {
            return Ok(());
        }
        self.conn.execute(
            r#"
            INSERT INTO cloud_account_state (account_id, last_online_at)
            VALUES (?1, ?2)
            ON CONFLICT (account_id) DO UPDATE SET last_online_at = excluded.last_online_at
            "#,
            params![account_id, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn can_write(&self, account_id: &str, max_offline_seconds: i64) -> Result<bool> {
        let value = self
            .conn
            .query_row(
                "SELECT last_online_at FROM cloud_account_state WHERE account_id = ?1",
                params![account_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        let Some(value) = value else {
            return Ok(false);
        };
        let online_at = DateTime::parse_from_rfc3339(&value)?.with_timezone(&Utc);
        Ok(Utc::now().signed_duration_since(online_at).num_seconds() <= max_offline_seconds)
    }

    pub fn due_outbox(&self, limit: usize) -> Result<Vec<CloudOutboxItem>> {
        let idle_before = (Utc::now() - chrono::Duration::minutes(2)).to_rfc3339();
        let now = Utc::now().to_rfc3339();
        let mut stmt = self.conn.prepare(
            r#"
            SELECT o.id, o.account_id, o.base_url, o.auth_token, o.method, o.path, o.payload_json
            FROM cloud_sync_outbox o
            JOIN cloud_account_state a ON a.account_id = o.account_id
            WHERE o.status = 'pending' AND o.not_before <= ?1
              AND COALESCE(a.last_activity_at, o.created_at) <= ?2
            ORDER BY o.created_at
            LIMIT ?3
            "#,
        )?;
        let rows = stmt.query_map(params![now, idle_before, limit as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        })?;
        let mut items = Vec::new();
        for row in rows {
            let (id, account_id, base_url, auth_token, method, path, payload) = row?;
            items.push(CloudOutboxItem {
                id,
                account_id,
                base_url,
                auth_token: decrypt_text(&self.encryption_key, &auth_token)?,
                method,
                path,
                payload: payload
                    .map(|value| decrypt_json(&self.encryption_key, &value))
                    .transpose()?,
            });
        }
        Ok(items)
    }

    pub fn complete_outbox(&self, id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM cloud_sync_outbox WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn fail_outbox(&self, id: &str, error: &str) -> Result<()> {
        self.conn.execute(
            r#"
            UPDATE cloud_sync_outbox
            SET attempt_count = attempt_count + 1,
                last_error = ?2,
                not_before = ?3
            WHERE id = ?1
            "#,
            params![
                id,
                error,
                (Utc::now() + chrono::Duration::minutes(10)).to_rfc3339()
            ],
        )?;
        Ok(())
    }
}

fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) -> Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if !columns.iter().any(|value| value == column) {
        conn.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition}"
        ))?;
    }
    Ok(())
}

fn upsert_gallery_asset(
    conn: &Connection,
    encryption_key: &[u8; 32],
    account_id: &str,
    scope: &str,
    asset: &Value,
) -> Result<()> {
    let asset_id = asset.get("id").and_then(Value::as_str).unwrap_or_default();
    if asset_id.is_empty() {
        return Ok(());
    }
    let listing_status = asset
        .get("listingStatus")
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str);
    conn.execute(
        r#"
        INSERT INTO cloud_gallery_assets (
          account_id, scope, asset_id, sku, ratio_family, product_image_rule_id,
          listing_status, created_at, payload_json, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT (account_id, scope, asset_id) DO UPDATE SET
          sku = excluded.sku,
          ratio_family = excluded.ratio_family,
          product_image_rule_id = excluded.product_image_rule_id,
          listing_status = excluded.listing_status,
          created_at = excluded.created_at,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
        "#,
        params![
            account_id,
            scope,
            asset_id,
            asset.get("sku").and_then(Value::as_str).unwrap_or_default(),
            asset.get("ratioFamily").and_then(Value::as_str),
            asset.get("productImageRuleId").and_then(Value::as_str),
            listing_status,
            asset
                .get("createdAt")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            encrypt_json(encryption_key, asset)?,
            Utc::now().to_rfc3339(),
        ],
    )?;
    Ok(())
}

fn matches_listing_status(
    asset: &Value,
    expected: Option<&str>,
    external_shop_id: Option<&str>,
) -> bool {
    let status = asset.get("listingStatus");
    match expected {
        Some("pending") => status.map_or(true, Value::is_null),
        Some("uploaded") => status
            .and_then(|value| value.get("status"))
            .and_then(Value::as_str)
            .is_some_and(|value| value == "uploaded"),
        Some("processing") => status.is_some_and(|value| {
            let state = value
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if state == "uploaded" {
                return false;
            }
            external_shop_id.map_or(true, |shop_id| {
                value
                    .get("shops")
                    .and_then(Value::as_array)
                    .is_some_and(|shops| {
                        shops.iter().any(|shop| {
                            shop.get("externalShopId").and_then(Value::as_str) == Some(shop_id)
                        })
                    })
            })
        }),
        _ => true,
    }
}

fn cache_key() -> Result<[u8; 32]> {
    match secrets::get_secret(CACHE_KEY_ID) {
        Ok(value) if value.len() >= 32 => Ok(derive_key(&value)),
        _ => {
            let value = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
            secrets::set_secret(CACHE_KEY_ID, &value)?;
            Ok(derive_key(&value))
        }
    }
}

fn derive_key(value: &str) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(value.as_bytes()).into()
}

fn encrypt_json(key: &[u8; 32], value: &Value) -> Result<String> {
    encrypt_bytes(key, &serde_json::to_vec(value)?)
}

fn encrypt_text(key: &[u8; 32], value: &str) -> Result<String> {
    encrypt_bytes(key, value.as_bytes())
}

fn encrypt_bytes(key: &[u8; 32], plaintext: &[u8]) -> Result<String> {
    let cipher = Aes256Gcm::new_from_slice(key).context("无法初始化本地缓存加密")?;
    let nonce_uuid = Uuid::new_v4();
    let nonce_bytes = &nonce_uuid.as_bytes()[..12];
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(nonce_bytes), plaintext)
        .map_err(|_| anyhow::anyhow!("无法加密本地缓存"))?;
    let mut payload = Vec::with_capacity(12 + ciphertext.len());
    payload.extend_from_slice(nonce_bytes);
    payload.extend_from_slice(&ciphertext);
    Ok(format!("enc:v1:{}", BASE64.encode(payload)))
}

fn decrypt_json(key: &[u8; 32], value: &str) -> Result<Value> {
    let plaintext = decrypt_bytes(key, value)?;
    serde_json::from_slice(&plaintext).context("本地缓存内容无效")
}

fn decrypt_text(key: &[u8; 32], value: &str) -> Result<String> {
    String::from_utf8(decrypt_bytes(key, value)?).context("本地缓存文本无效")
}

fn decrypt_bytes(key: &[u8; 32], value: &str) -> Result<Vec<u8>> {
    let Some(encoded) = value.strip_prefix("enc:v1:") else {
        return Ok(value.as_bytes().to_vec());
    };
    let payload = BASE64.decode(encoded).context("本地缓存密文无效")?;
    if payload.len() <= 12 {
        return Err(anyhow::anyhow!("本地缓存密文长度无效"));
    }
    let cipher = Aes256Gcm::new_from_slice(key).context("无法初始化本地缓存解密")?;
    cipher
        .decrypt(Nonce::from_slice(&payload[..12]), &payload[12..])
        .map_err(|_| anyhow::anyhow!("无法解密本地缓存"))
}
