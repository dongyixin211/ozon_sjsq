use anyhow::{anyhow, Context, Result};
use reqwest::header::CONTENT_TYPE;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;
use url::Url;

const SOURCE_API: &str = "https://taojinchuhai.cn/api";
const MAX_ASSET_BYTES: usize = 200 * 1024 * 1024;
static SYNC_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartProductCatalogSyncRequest {
    pub base_url: String,
    pub auth_token: String,
    #[serde(default)]
    pub force: bool,
}

pub fn start(_app: AppHandle, input: StartProductCatalogSyncRequest) -> Result<Value, String> {
    if input.auth_token.trim().is_empty() {
        return Err("商品库同步缺少登录凭证".to_string());
    }
    if SYNC_RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(json!({ "ok": true, "started": false, "reason": "running" }));
    }
    tauri::async_runtime::spawn(async move {
        if let Err(error) = run_sync(&input).await {
            eprintln!("商品库同步失败：{error}");
        }
        SYNC_RUNNING.store(false, Ordering::SeqCst);
    });
    Ok(json!({ "ok": true, "started": true }))
}

async fn run_sync(input: &StartProductCatalogSyncRequest) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .user_agent("Ozon-SJSQ/0.3 product-catalog-sync")
        .build()?;
    let claim = cloud_json(
        &client,
        input,
        "POST",
        "/product-catalog/sync/claim",
        Some(json!({ "force": input.force })),
    )
    .await?;
    if claim.get("shouldSync").and_then(Value::as_bool) != Some(true) {
        return Ok(());
    }
    let sync_id = claim
        .get("syncId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("云端未返回商品库同步编号"))?
        .to_string();
    let result = run_claimed_sync(&client, input, &sync_id).await;
    if let Err(error) = &result {
        let _ = cloud_json(
            &client,
            input,
            "POST",
            "/product-catalog/sync/fail",
            Some(json!({ "syncId": sync_id, "message": error.to_string() })),
        )
        .await;
    }
    result
}

async fn run_claimed_sync(
    client: &reqwest::Client,
    input: &StartProductCatalogSyncRequest,
    sync_id: &str,
) -> Result<()> {
    let categories = source_json(client, "/merchant/selection/category/tree").await?;
    let page = source_json(
        client,
        "/merchant/selection/goods/page?pageNo=1&pageSize=100",
    )
    .await?;
    let records = page
        .get("records")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut products = Vec::with_capacity(records.len());
    let mut all_urls = BTreeSet::new();
    for summary in records {
        let source_product_id = summary
            .get("goodsId")
            .and_then(Value::as_i64)
            .ok_or_else(|| anyhow!("来源商品缺少 goodsId"))?;
        let detail = source_json(client, &format!("/goods/{source_product_id}/detail")).await?;
        let mut media_urls = BTreeSet::new();
        collect_media_urls(&detail, None, &mut media_urls);
        if let Some(cover) = summary.get("coverImageUrl").and_then(Value::as_str) {
            if is_http_url(cover) {
                media_urls.insert(cover.to_string());
            }
        }
        all_urls.extend(media_urls.iter().cloned());
        products.push(json!({
            "sourceProductId": source_product_id,
            "summary": summary,
            "detail": detail,
            "mediaUrls": media_urls,
        }));
    }

    let mut assets = Vec::with_capacity(all_urls.len());
    for source_url in all_urls {
        match mirror_asset(client, input, &source_url).await {
            Ok(asset) => assets.push(asset),
            Err(error) => eprintln!("商品库素材复制失败，已保留来源链接：{source_url}：{error}"),
        }
    }

    cloud_json(
        client,
        input,
        "POST",
        "/product-catalog/sync/commit",
        Some(json!({
            "syncId": sync_id,
            "categories": categories.as_array().cloned().unwrap_or_default(),
            "products": products,
            "assets": assets,
        })),
    )
    .await?;
    Ok(())
}

async fn mirror_asset(
    client: &reqwest::Client,
    input: &StartProductCatalogSyncRequest,
    source_url: &str,
) -> Result<Value> {
    let response = client.get(source_url).send().await?.error_for_status()?;
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .split(';')
        .next()
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = response.bytes().await?;
    if bytes.len() > MAX_ASSET_BYTES {
        return Err(anyhow!("文件超过 200 MB"));
    }
    let size_bytes = bytes.len();
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    let filename = source_filename(source_url);
    let prepared = cloud_json(
        client,
        input,
        "POST",
        "/product-catalog/assets/prepare",
        Some(json!({
            "sourceUrl": source_url,
            "sha256": sha256,
            "filename": filename,
            "contentType": content_type,
            "sizeBytes": size_bytes,
        })),
    )
    .await?;
    if let Some(upload_url) = prepared.get("uploadUrl").and_then(Value::as_str) {
        client
            .put(upload_url)
            .header(CONTENT_TYPE, &content_type)
            .body(bytes)
            .send()
            .await?
            .error_for_status()
            .context("上传商品库素材到自有 OSS 失败")?;
    }
    Ok(json!({
        "sourceUrl": source_url,
        "sha256": sha256,
        "objectKey": prepared.get("objectKey").and_then(Value::as_str).unwrap_or_default(),
        "publicUrl": prepared.get("publicUrl").and_then(Value::as_str).unwrap_or(source_url),
        "contentType": content_type,
        "sizeBytes": size_bytes,
        "sourceFilename": filename,
    }))
}

async fn source_json(client: &reqwest::Client, path: &str) -> Result<Value> {
    let response = client
        .get(format!("{}{}", SOURCE_API, path))
        .send()
        .await?
        .error_for_status()?;
    let value = response.json::<Value>().await?;
    if value.get("code").and_then(Value::as_i64) != Some(0) {
        return Err(anyhow!(
            "来源商品接口失败：{}",
            value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("未知错误")
        ));
    }
    Ok(value.get("data").cloned().unwrap_or(Value::Null))
}

async fn cloud_json(
    client: &reqwest::Client,
    input: &StartProductCatalogSyncRequest,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value> {
    let url = format!("{}{}", input.base_url.trim_end_matches('/'), path);
    let mut request = client
        .request(reqwest::Method::from_bytes(method.as_bytes())?, url)
        .bearer_auth(&input.auth_token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await?;
    let status = response.status();
    let value = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        return Err(anyhow!(
            "{}",
            value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("云端商品库请求失败")
        ));
    }
    Ok(value)
}

fn collect_media_urls(value: &Value, key: Option<&str>, urls: &mut BTreeSet<String>) {
    match value {
        Value::String(text) => {
            let key = key.unwrap_or_default().to_ascii_lowercase();
            if is_http_url(text)
                && (key.contains("url")
                    || key.contains("image")
                    || key.contains("preview")
                    || key.contains("download")
                    || key.contains("logo"))
            {
                urls.insert(text.to_string());
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_media_urls(item, key, urls);
            }
        }
        Value::Object(map) => {
            for (next_key, item) in map {
                collect_media_urls(item, Some(next_key), urls);
            }
        }
        _ => {}
    }
}

fn is_http_url(value: &str) -> bool {
    value.starts_with("https://") || value.starts_with("http://")
}

fn source_filename(source_url: &str) -> String {
    Url::parse(source_url)
        .ok()
        .and_then(|url| {
            url.path_segments()
                .and_then(|segments| segments.filter(|item| !item.is_empty()).next_back())
                .map(str::to_string)
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "asset.bin".to_string())
}
