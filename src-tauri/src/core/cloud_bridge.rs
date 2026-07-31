use crate::{core::cloud_cache::CloudSyncStatus, AppState};
use anyhow::{anyhow, Context, Result};
use chrono::{Duration, Utc};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudBridgeRequest {
    pub base_url: String,
    pub path: String,
    #[serde(default = "default_method")]
    pub method: String,
    #[serde(default)]
    pub body: Option<Value>,
    #[serde(default)]
    pub auth_token: Option<String>,
    #[serde(default)]
    pub account_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudBridgeResponse {
    pub ok: bool,
    pub status: u16,
    pub data: Value,
    pub from_cache: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartCloudSyncRequest {
    pub base_url: String,
    pub auth_token: String,
    pub account_id: String,
}

pub async fn request(
    app: AppHandle,
    input: CloudBridgeRequest,
) -> Result<CloudBridgeResponse, String> {
    request_inner(&app, &input)
        .await
        .map_err(|error| error.to_string())
}

pub fn start_gallery_sync(app: AppHandle, input: StartCloudSyncRequest) -> Result<Value, String> {
    if input.account_id.trim().is_empty() || input.auth_token.trim().is_empty() {
        return Err("云同步缺少账号或登录凭证".to_string());
    }
    let state = app.state::<AppState>();
    {
        let cache = state
            .cloud_cache
            .lock()
            .map_err(|_| "本地云缓存被占用".to_string())?;
        let status = cache
            .sync_status(&input.account_id, "gallery")
            .map_err(|error| error.to_string())?;
        if status.syncing {
            return Ok(json!({ "ok": true, "started": false, "status": status }));
        }
        cache
            .set_syncing(&input.account_id, "gallery", true)
            .map_err(|error| error.to_string())?;
        cache
            .set_syncing(&input.account_id, "featured", true)
            .map_err(|error| error.to_string())?;
    }
    let task_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = sync_gallery(&task_app, &input).await;
        let state = task_app.state::<AppState>();
        if let Ok(mut cache) = state.cloud_cache.lock() {
            match result {
                Ok(Some((gallery, featured, cursor))) => {
                    let gallery_result = cache
                        .replace_gallery_scope(&input.account_id, "gallery", &gallery)
                        .and_then(|_| cache.finish_sync(&input.account_id, "gallery", cursor));
                    let featured_result = cache
                        .replace_gallery_scope(&input.account_id, "featured", &featured)
                        .and_then(|_| cache.finish_sync(&input.account_id, "featured", cursor));
                    if let Err(error) = gallery_result {
                        let _ = cache.fail_sync(&input.account_id, "gallery", &error.to_string());
                    }
                    if let Err(error) = featured_result {
                        let _ = cache.fail_sync(&input.account_id, "featured", &error.to_string());
                    }
                    let _ = cache.record_online(&input.account_id);
                }
                Ok(None) => {
                    let _ = cache.set_syncing(&input.account_id, "gallery", false);
                    let _ = cache.set_syncing(&input.account_id, "featured", false);
                    let _ = cache.record_online(&input.account_id);
                }
                Err(error) => {
                    let message = error.to_string();
                    let _ = cache.fail_sync(&input.account_id, "gallery", &message);
                    let _ = cache.fail_sync(&input.account_id, "featured", &message);
                }
            }
        };
    });
    Ok(json!({ "ok": true, "started": true }))
}

pub fn sync_status(app: AppHandle, account_id: String) -> Result<Vec<CloudSyncStatus>, String> {
    let state = app.state::<AppState>();
    let cache = state
        .cloud_cache
        .lock()
        .map_err(|_| "本地云缓存被占用".to_string())?;
    Ok(vec![
        cache
            .sync_status(&account_id, "gallery")
            .map_err(|error| error.to_string())?,
        cache
            .sync_status(&account_id, "featured")
            .map_err(|error| error.to_string())?,
    ])
}

pub fn start_outbox_worker(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let jitter = u64::from(Uuid::new_v4().as_bytes()[0]) * 180 / 255;
            tokio::time::sleep(std::time::Duration::from_secs(600 + jitter)).await;
            let items = {
                let state = app.state::<AppState>();
                state
                    .cloud_cache
                    .lock()
                    .ok()
                    .and_then(|cache| cache.due_outbox(50).ok())
                    .unwrap_or_default()
            };
            for item in items {
                let request = CloudBridgeRequest {
                    base_url: item.base_url.clone(),
                    path: item.path.clone(),
                    method: item.method.clone(),
                    body: item.payload.clone(),
                    auth_token: Some(item.auth_token.clone()),
                    account_id: item.account_id.clone(),
                };
                let result = send_request(&request).await;
                let state = app.state::<AppState>();
                if let Ok(cache) = state.cloud_cache.lock() {
                    match result {
                        Ok((status, _)) if (200..300).contains(&status) => {
                            let _ = cache.complete_outbox(&item.id);
                            let _ = cache.record_online(&item.account_id);
                        }
                        Ok((status, data)) => {
                            let message = data
                                .get("message")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                                .unwrap_or_else(|| format!("HTTP {status}"));
                            let _ = cache.fail_outbox(&item.id, &message);
                        }
                        Err(error) => {
                            let _ = cache.fail_outbox(&item.id, &error.to_string());
                        }
                    }
                };
            }
        }
    });
}

async fn request_inner(app: &AppHandle, input: &CloudBridgeRequest) -> Result<CloudBridgeResponse> {
    let _method = Method::from_bytes(input.method.as_bytes()).context("云请求方法不正确")?;
    let cache_key = request_cache_key(input);
    let scope = if input.path.starts_with("/gallery/featured-assets") {
        "featured"
    } else {
        "gallery"
    };
    let gallery_query = input.path.starts_with("/gallery/assets")
        || input.path.starts_with("/gallery/featured-assets");
    if gallery_query && !input.account_id.is_empty() {
        let state = app.state::<AppState>();
        let cache = state
            .cloud_cache
            .lock()
            .map_err(|_| anyhow!("本地云缓存被占用"))?;
        let status = cache.sync_status(&input.account_id, scope)?;
        if status.completed {
            let query = query_value(input)?;
            let data = cache.query_gallery(&input.account_id, scope, &query)?;
            return Ok(CloudBridgeResponse {
                ok: true,
                status: 200,
                data,
                from_cache: true,
            });
        }
    }
    if is_deferred_write(input) && !input.account_id.is_empty() {
        return enqueue_deferred_write(app, input);
    }
    if is_cacheable_read(input) && !input.account_id.is_empty() {
        let state = app.state::<AppState>();
        if let Some(data) = state.cloud_cache.lock().ok().and_then(|cache| {
            cache
                .get_http_fresh(&input.account_id, &cache_key, 600)
                .ok()
                .flatten()
        }) {
            return Ok(CloudBridgeResponse {
                ok: true,
                status: 200,
                data,
                from_cache: true,
            });
        }
    }
    let cached = if is_cacheable_read(input) && !input.account_id.is_empty() {
        let state = app.state::<AppState>();
        state
            .cloud_cache
            .lock()
            .ok()
            .and_then(|cache| cache.get_http(&input.account_id, &cache_key).ok().flatten())
    } else {
        None
    };
    match send_request(input).await {
        Ok((status, data)) => {
            if status >= 200 && status < 300 && !input.account_id.is_empty() {
                let state = app.state::<AppState>();
                if let Ok(mut cache) = state.cloud_cache.lock() {
                    if is_cacheable_read(input) {
                        let _ = cache.put_http(&input.account_id, &cache_key, &data);
                    }
                    if gallery_query {
                        let _ = cache.upsert_gallery_response(&input.account_id, scope, &data);
                    }
                    let _ = cache.record_online(&input.account_id);
                };
            }
            Ok(CloudBridgeResponse {
                ok: status >= 200 && status < 300,
                status,
                data,
                from_cache: false,
            })
        }
        Err(error) => {
            if let Some(data) = cached {
                return Ok(CloudBridgeResponse {
                    ok: true,
                    status: 200,
                    data,
                    from_cache: true,
                });
            }
            Err(error)
        }
    }
}

fn enqueue_deferred_write(
    app: &AppHandle,
    input: &CloudBridgeRequest,
) -> Result<CloudBridgeResponse> {
    let token = input.auth_token.as_deref().unwrap_or_default();
    if token.is_empty() {
        return Err(anyhow!("本地同步队列缺少登录凭证"));
    }
    let state = app.state::<AppState>();
    let cache = state
        .cloud_cache
        .lock()
        .map_err(|_| anyhow!("本地云缓存被占用"))?;
    if !cache.can_write(&input.account_id, 6 * 60 * 60)? {
        return Err(anyhow!(
            "云服务已离线超过 6 小时，当前仅允许读取，请联网后再修改"
        ));
    }
    let entity_id = input
        .body
        .as_ref()
        .and_then(|body| body.get("externalShopId"))
        .and_then(Value::as_str);
    let operation_key = entity_id
        .map(|id| format!("{}:{id}", input.path))
        .unwrap_or_else(|| input.path.clone());
    cache.enqueue(
        &input.account_id,
        &operation_key,
        deferred_entity_type(&input.path),
        entity_id,
        &input.method,
        &input.path,
        &input.base_url,
        token,
        input.body.as_ref(),
        &(Utc::now() + Duration::minutes(2)).to_rfc3339(),
    )?;
    update_optimistic_read_cache(&cache, input)?;
    Ok(CloudBridgeResponse {
        ok: true,
        status: 202,
        data: deferred_response(input),
        from_cache: true,
    })
}

fn update_optimistic_read_cache(
    cache: &crate::core::cloud_cache::CloudCache,
    input: &CloudBridgeRequest,
) -> Result<()> {
    match input.path.as_str() {
        "/shops/upsert" => {
            let read_request = CloudBridgeRequest {
                base_url: input.base_url.clone(),
                path: "/shops".to_string(),
                method: "GET".to_string(),
                body: None,
                auth_token: input.auth_token.clone(),
                account_id: input.account_id.clone(),
            };
            let cache_key = request_cache_key(&read_request);
            let mut data = cache
                .get_http(&input.account_id, &cache_key)?
                .unwrap_or_else(|| json!({ "ok": true, "shops": [] }));
            let shop = input.body.clone().unwrap_or_else(|| json!({}));
            let external_shop_id = shop
                .get("externalShopId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let shops = data.get_mut("shops").and_then(Value::as_array_mut);
            if let Some(shops) = shops {
                shops.retain(|item| {
                    item.get("externalShopId").and_then(Value::as_str) != Some(external_shop_id)
                });
                shops.push(shop);
            } else {
                data["shops"] = json!([shop]);
            }
            cache.put_http(&input.account_id, &cache_key, &data)?;
        }
        "/gallery/listing-preferences" => {
            let read_request = CloudBridgeRequest {
                base_url: input.base_url.clone(),
                path: "/gallery/listing-preferences".to_string(),
                method: "GET".to_string(),
                body: None,
                auth_token: input.auth_token.clone(),
                account_id: input.account_id.clone(),
            };
            let cache_key = request_cache_key(&read_request);
            cache.put_http(
                &input.account_id,
                &cache_key,
                &json!({
                    "ok": true,
                    "preferences": input.body.clone().unwrap_or_else(|| json!({})),
                    "updatedAt": Utc::now().to_rfc3339()
                }),
            )?;
        }
        _ => {}
    }
    Ok(())
}

fn is_deferred_write(input: &CloudBridgeRequest) -> bool {
    if input.method.eq_ignore_ascii_case("GET") {
        return false;
    }
    matches!(
        input.path.as_str(),
        "/shops/upsert"
            | "/gallery/listing-preferences"
            | "/gallery/sales-signals/sync"
            | "/orders/sync"
            | "/tasks/history/sync"
    )
}

fn deferred_entity_type(path: &str) -> &'static str {
    match path {
        "/shops/upsert" => "shop",
        "/gallery/listing-preferences" => "listing_preferences",
        "/gallery/sales-signals/sync" => "sales_signals",
        "/orders/sync" => "orders",
        "/tasks/history/sync" => "task_history",
        _ => "cloud_write",
    }
}

fn deferred_response(input: &CloudBridgeRequest) -> Value {
    let body = input.body.clone().unwrap_or_else(|| json!({}));
    match input.path.as_str() {
        "/shops/upsert" => json!({ "ok": true, "queued": true, "shop": body }),
        "/gallery/listing-preferences" => json!({
            "ok": true,
            "queued": true,
            "preferences": body,
            "updatedAt": Utc::now().to_rfc3339()
        }),
        "/gallery/sales-signals/sync" => json!({
            "ok": true,
            "queued": true,
            "synced": body.get("signals").and_then(Value::as_array).map_or(0, Vec::len),
            "featuredUpdated": 0
        }),
        "/orders/sync" => json!({
            "ok": true,
            "queued": true,
            "synced": body.get("orders").and_then(Value::as_array).map_or(0, Vec::len)
        }),
        "/tasks/history/sync" => json!({
            "ok": true,
            "queued": true,
            "jobsSynced": body.get("jobs").and_then(Value::as_array).map_or(0, Vec::len),
            "logsSynced": body.get("logs").and_then(Value::as_array).map_or(0, Vec::len)
        }),
        _ => json!({ "ok": true, "queued": true }),
    }
}

async fn sync_gallery(
    app: &AppHandle,
    input: &StartCloudSyncRequest,
) -> Result<Option<(Vec<Value>, Vec<Value>, i64)>> {
    let remote_version = fetch_sync_version(&input.base_url, &input.auth_token).await?;
    let state = app.state::<AppState>();
    let local_status = state
        .cloud_cache
        .lock()
        .map_err(|_| anyhow!("本地云缓存被占用"))?
        .sync_status(&input.account_id, "gallery")?;
    if local_status.completed && local_status.cursor == remote_version {
        return Ok(None);
    }
    let mut gallery_by_id = BTreeMap::new();
    for status in ["pending", "processing", "uploaded"] {
        for asset in fetch_all_assets(
            &input.base_url,
            &input.auth_token,
            "/gallery/assets",
            Some(status),
        )
        .await?
        {
            if let Some(id) = asset.get("id").and_then(Value::as_str) {
                gallery_by_id.insert(id.to_string(), asset);
            }
        }
    }
    let featured = fetch_all_assets(
        &input.base_url,
        &input.auth_token,
        "/gallery/featured-assets",
        None,
    )
    .await?;
    Ok(Some((
        gallery_by_id.into_values().collect(),
        featured,
        remote_version,
    )))
}

async fn fetch_sync_version(base_url: &str, token: &str) -> Result<i64> {
    let url = format!("{}/gallery/sync-version", base_url.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .get(url)
        .bearer_auth(token)
        .send()
        .await?;
    let status = response.status();
    let data = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        let message = data
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("无法读取图库同步版本")
            .to_string();
        return Err(anyhow!(message));
    }
    Ok(data.get("version").and_then(Value::as_i64).unwrap_or(0))
}

async fn fetch_all_assets(
    base_url: &str,
    token: &str,
    path: &str,
    listing_status: Option<&str>,
) -> Result<Vec<Value>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()?;
    let mut offset = 0usize;
    let limit = if path == "/gallery/featured-assets" {
        100usize
    } else {
        500usize
    };
    let mut assets = Vec::new();
    loop {
        let mut url = format!(
            "{}{}?limit={limit}&offset={offset}&includeTotal=false",
            base_url.trim_end_matches('/'),
            path
        );
        if let Some(status) = listing_status {
            url.push_str("&listingStatus=");
            url.push_str(status);
        }
        let response = client.get(url).bearer_auth(token).send().await?;
        let status = response.status();
        let data = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
        if !status.is_success() {
            let message = data
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("图库同步失败")
                .to_string();
            return Err(anyhow!(message));
        }
        let page = data
            .get("assets")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let count = page.len();
        assets.extend(page);
        if count < limit {
            break;
        }
        offset += count;
    }
    Ok(assets)
}

async fn send_request(input: &CloudBridgeRequest) -> Result<(u16, Value)> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(360))
        .build()?;
    let url = format!("{}{}", input.base_url.trim_end_matches('/'), input.path);
    let mut request = client.request(Method::from_bytes(input.method.as_bytes())?, url);
    if let Some(token) = input
        .auth_token
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        request = request.bearer_auth(token);
    }
    if let Some(body) = &input.body {
        request = request.json(body);
    }
    let response = request.send().await?;
    let status = response.status().as_u16();
    let data = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
    Ok((status, data))
}

fn request_cache_key(input: &CloudBridgeRequest) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.method.as_bytes());
    hasher.update(b"|");
    hasher.update(input.path.as_bytes());
    hasher.update(b"|");
    if let Some(body) = &input.body {
        hasher.update(serde_json::to_vec(body).unwrap_or_default());
    }
    format!("{:x}", hasher.finalize())
}

fn query_value(input: &CloudBridgeRequest) -> Result<Value> {
    if input.method.eq_ignore_ascii_case("POST") {
        return Ok(input.body.clone().unwrap_or_else(|| json!({})));
    }
    let url = url::Url::parse(&format!("http://localhost{}", input.path))?;
    let mut map = serde_json::Map::new();
    for (key, value) in url.query_pairs() {
        let value = match key.as_ref() {
            "limit" | "offset" => value
                .parse::<u64>()
                .map(Value::from)
                .unwrap_or_else(|_| Value::String(value.to_string())),
            "includeTotal" | "hideUsed" => Value::Bool(value == "true"),
            _ => Value::String(value.to_string()),
        };
        map.insert(key.to_string(), value);
    }
    Ok(Value::Object(map))
}

fn is_cacheable_read(input: &CloudBridgeRequest) -> bool {
    input.method.eq_ignore_ascii_case("GET")
        && !input.path.starts_with("/health")
        && !input.path.starts_with("/me")
        && !input.path.starts_with("/admin")
}

fn default_method() -> String {
    "GET".to_string()
}
