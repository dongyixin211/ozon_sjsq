use crate::core::batch::RuntimeShopConfig;
use crate::core::jobs::JobRegistry;
use crate::core::models::{JobStatus, ListingImageRepairItem, ListingImageRepairRequest};
use crate::core::ozon::{extract_items, OzonSellerClient};
use anyhow::{Context, Result};
use reqwest::{Client, Url};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::Instant;
use tokio::time::{sleep, Duration};

const REPAIR_BATCH_SIZE: usize = 50;
const IMAGE_PREFLIGHT_TIMEOUT_SECONDS: u64 = 12;
const IMAGE_REPAIR_VERIFY_ATTEMPTS: usize = 6;
const IMAGE_REPAIR_VERIFY_DELAY_SECONDS: u64 = 10;

#[derive(Default)]
struct ShopRepairResult {
    submitted: usize,
    failed: usize,
}

#[derive(Clone)]
struct RepairCandidate {
    item: ListingImageRepairItem,
    product_id: i64,
}

#[derive(Default)]
struct VerifyBatchResult {
    succeeded: usize,
    failed: usize,
    pending: usize,
    pending_skus: Vec<String>,
}

enum PictureVerifyState {
    Succeeded,
    Pending(String),
}

pub async fn run_listing_image_repair(
    jobs: JobRegistry,
    job_id: String,
    request: ListingImageRepairRequest,
    shops: Vec<RuntimeShopConfig>,
) {
    if let Err(error) = listing_image_repair_inner(&jobs, &job_id, request, shops).await {
        jobs.log(&job_id, "error", &error.to_string());
        jobs.fail(&job_id, error.to_string());
    }
}

async fn listing_image_repair_inner(
    jobs: &JobRegistry,
    job_id: &str,
    request: ListingImageRepairRequest,
    shops: Vec<RuntimeShopConfig>,
) -> Result<()> {
    jobs.update(job_id, JobStatus::Running, 1, None);
    if request.items.is_empty() {
        anyhow::bail!("没有可修复图片链接的历史商品");
    }

    let total_items = request.items.len();
    let shop_by_id = shops
        .into_iter()
        .map(|runtime| (runtime.shop.id.clone(), runtime))
        .collect::<HashMap<_, _>>();
    let mut items_by_shop_id: BTreeMap<String, Vec<ListingImageRepairItem>> = BTreeMap::new();
    for item in request.items {
        items_by_shop_id
            .entry(item.external_shop_id.clone())
            .or_default()
            .push(item);
    }

    jobs.log(
        job_id,
        "info",
        &format!(
            "开始修复历史商品图片：{} 个商品，{} 个店铺。按店铺和货号查询 Ozon product_id 后，只更新商品图片，不改标题、价格、库存或活动。",
            total_items,
            items_by_shop_id.len()
        ),
    );
    let total_shops = items_by_shop_id.len().max(1);
    let mut success_count = 0usize;
    let mut failed_count = 0usize;
    for (shop_index, (shop_id, items)) in items_by_shop_id.into_iter().enumerate() {
        if jobs.is_cancelled(job_id) {
            jobs.log(job_id, "warn", "历史商品图片修复任务已取消");
            return Ok(());
        }
        let item_count = items.len();
        let Some(runtime) = shop_by_id.get(&shop_id) else {
            failed_count += item_count;
            jobs.log(
                job_id,
                "error",
                &format!(
                    "店铺 {} 没有找到本地配置或 Ozon API Key，已跳过 {} 个商品",
                    shop_id, item_count
                ),
            );
            continue;
        };

        jobs.update(
            job_id,
            JobStatus::Running,
            progress_for_shop(shop_index, total_shops, 5),
            None,
        );
        match repair_shop_images(jobs, job_id, runtime, items, shop_index, total_shops).await {
            Ok(result) => {
                success_count += result.submitted;
                failed_count += result.failed;
            }
            Err(error) => {
                failed_count += item_count;
                jobs.log(
                    job_id,
                    "error",
                    &format!("店铺 {} 历史图片修复失败：{error:#}", runtime.shop.name),
                );
            }
        }
    }

    if success_count == 0 && failed_count > 0 {
        anyhow::bail!("历史商品图片修复全部失败，请查看任务日志");
    }
    jobs.log(
        job_id,
        "info",
        &format!(
            "历史商品图片修复结束：Ozon 确认成功 {} 个，失败 {} 个。",
            success_count, failed_count
        ),
    );
    jobs.complete_with_result(job_id, None, success_count, failed_count);
    Ok(())
}

async fn repair_shop_images(
    jobs: &JobRegistry,
    job_id: &str,
    runtime: &RuntimeShopConfig,
    items: Vec<ListingImageRepairItem>,
    shop_index: usize,
    total_shops: usize,
) -> Result<ShopRepairResult> {
    let ozon = OzonSellerClient::new(runtime.shop.client_id.clone(), runtime.ozon_api_key.clone())?;
    jobs.log(
        job_id,
        "info",
        &format!(
            "{} 开始修复 {} 个历史商品图片",
            runtime.shop.name,
            items.len()
        ),
    );

    let mut result = ShopRepairResult::default();
    let mut valid_items = Vec::new();
    for mut item in items {
        match normalize_repair_item(&mut item) {
            Ok(()) => valid_items.push(item),
            Err(error) => {
                result.failed += 1;
                jobs.log(
                    job_id,
                    "error",
                    &format!("{} 参数校验失败：{error}", item.source_sku),
                );
            }
        }
    }
    if valid_items.is_empty() {
        return Ok(result);
    }

    jobs.update(
        job_id,
        JobStatus::Running,
        progress_for_shop(shop_index, total_shops, 20),
        None,
    );
    let mut candidates = Vec::new();
    let mut seen_skus = HashSet::new();
    for item in valid_items {
        if jobs.is_cancelled(job_id) {
            jobs.log(job_id, "warn", "历史商品图片修复任务已取消");
            return Ok(result);
        }
        if !seen_skus.insert(item.source_sku.clone()) {
            jobs.log(
                job_id,
                "warn",
                &format!(
                    "{} 在历史记录中重复出现，已保留最新记录，跳过旧记录，避免旧图片覆盖新图片",
                    item.source_sku
                ),
            );
            continue;
        }
        match build_repair_candidate(jobs, job_id, &ozon, item).await {
            Ok(candidate) => candidates.push(candidate),
            Err(error) => {
                result.failed += 1;
                jobs.log(job_id, "error", &format!("历史图片修复跳过：{error:#}"));
            }
        }
    }
    if candidates.is_empty() {
        return Ok(result);
    }

    jobs.update(
        job_id,
        JobStatus::Running,
        progress_for_shop(shop_index, total_shops, 45),
        None,
    );
    for (batch_index, chunk) in candidates.chunks(REPAIR_BATCH_SIZE).enumerate() {
        if jobs.is_cancelled(job_id) {
            jobs.log(job_id, "warn", "历史商品图片修复任务已取消");
            break;
        }
        let mut submitted = Vec::new();
        for candidate in chunk {
            if jobs.is_cancelled(job_id) {
                jobs.log(job_id, "warn", "历史商品图片修复任务已取消");
                break;
            }
            match ozon
                .import_product_pictures(candidate.product_id, candidate.item.image_urls.clone())
                .await
            {
                Ok(response) => {
                    submitted.push(candidate.clone());
                    let states = import_picture_states(&response);
                    let state_text = if states.is_empty() {
                        "Ozon 已接收，等待处理".to_string()
                    } else {
                        format!("Ozon 初始状态：{}", states.join("、"))
                    };
                    jobs.log(
                        job_id,
                        "info",
                        &format!(
                            "{} 已提交图片更新到 Ozon：product_id={}，{} 张图，{}",
                            candidate.item.source_sku,
                            candidate.product_id,
                            candidate.item.image_urls.len(),
                            state_text
                        ),
                    );
                }
                Err(error) => {
                    result.failed += 1;
                    jobs.log(
                        job_id,
                        "error",
                        &format!(
                            "{} 提交 Ozon 图片专用更新接口失败：{error}",
                            candidate.item.source_sku
                        ),
                    );
                }
            }
        }

        if !submitted.is_empty() {
            let verify = verify_submitted_images(jobs, job_id, &ozon, &submitted).await;
            result.submitted += verify.succeeded;
            result.failed += verify.failed;
            if verify.pending > 0 {
                result.failed += verify.pending;
                jobs.log(
                    job_id,
                    "warn",
                    &format!(
                        "{} 第 {} 批仍有 {} 个商品未在超时时间内确认图片更新，已按失败计入，请稍后重新修复或查看 Ozon 后台图片状态。货号：{}",
                        runtime.shop.name,
                        batch_index + 1,
                        verify.pending,
                        compact_list(
                            verify
                                .pending_skus
                                .into_iter(),
                            16
                        )
                    ),
                );
            }
        }
        let done = result.submitted + result.failed;
        let local_progress = 45 + ((done * 50) / candidates.len().max(1)).min(50);
        jobs.update(
            job_id,
            JobStatus::Running,
            progress_for_shop(shop_index, total_shops, local_progress),
            None,
        );
    }
    Ok(result)
}

async fn build_repair_candidate(
    jobs: &JobRegistry,
    job_id: &str,
    ozon: &OzonSellerClient,
    item: ListingImageRepairItem,
) -> Result<RepairCandidate> {
    preflight_listing_images(jobs, job_id, &item.source_sku, &item.image_urls).await?;
    let listed = load_listed_product(ozon, &item.source_sku).await?;
    let product_id = item_product_id(&listed).ok_or_else(|| {
        anyhow::anyhow!(
            "{} 在 Ozon 商品详情里没有 product_id，无法按图片专用接口更新",
            item.source_sku
        )
    })?;
    jobs.log(
        job_id,
        "info",
        &format!(
            "{} 已定位 Ozon 商品 product_id={}，准备更新 {} 张图片，来源 {}",
            item.source_sku,
            product_id,
            item.image_urls.len(),
            image_hosts(&item.image_urls)
        ),
    );
    Ok(RepairCandidate { item, product_id })
}

fn normalize_repair_item(item: &mut ListingImageRepairItem) -> Result<()> {
    item.external_shop_id = item.external_shop_id.trim().to_string();
    item.source_sku = item.source_sku.trim().to_string();
    item.image_urls = item
        .image_urls
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    item.image_urls.dedup();
    if item.external_shop_id.is_empty() {
        anyhow::bail!("店铺 ID 为空");
    }
    if item.source_sku.is_empty() {
        anyhow::bail!("货号为空");
    }
    if item.image_urls.is_empty() {
        anyhow::bail!("没有可提交给 Ozon 的图片链接");
    }
    if item.image_urls.len() > 15 {
        anyhow::bail!(
            "Ozon 商品普通图片最多 15 张，当前 {} 张。请先确认该货号历史套图是否异常",
            item.image_urls.len()
        );
    }
    for image_url in &item.image_urls {
        let url = Url::parse(image_url)
            .with_context(|| format!("图片链接格式不正确：{}", compact_url(image_url)))?;
        if !matches!(url.scheme(), "http" | "https") {
            anyhow::bail!("图片链接必须是 http/https：{}", compact_url(image_url));
        }
    }
    Ok(())
}

async fn load_listed_product(ozon: &OzonSellerClient, offer_id: &str) -> Result<Value> {
    let info = ozon.product_info(vec![offer_id.to_string()]).await?;
    let mut items = extract_items(&info);
    let mut product = items
        .pop()
        .ok_or_else(|| anyhow::anyhow!("Ozon 上没有找到货号：{offer_id}"))?;
    let attrs = ozon.product_attributes(vec![offer_id.to_string()]).await?;
    if let Some(attr) = extract_items(&attrs).into_iter().next() {
        merge_objects(&mut product, attr);
    }
    Ok(product)
}

async fn verify_submitted_images(
    jobs: &JobRegistry,
    job_id: &str,
    ozon: &OzonSellerClient,
    candidates: &[RepairCandidate],
) -> VerifyBatchResult {
    let mut pending = candidates
        .iter()
        .map(|candidate| (candidate.product_id, candidate.clone()))
        .collect::<HashMap<_, _>>();
    let mut result = VerifyBatchResult::default();

    for attempt in 1..=IMAGE_REPAIR_VERIFY_ATTEMPTS {
        if pending.is_empty() || jobs.is_cancelled(job_id) {
            break;
        }
        sleep(Duration::from_secs(IMAGE_REPAIR_VERIFY_DELAY_SECONDS)).await;
        let product_ids = pending.keys().copied().collect::<Vec<_>>();
        match ozon.product_pictures_info(product_ids).await {
            Ok(response) => {
                for item in extract_picture_info_items(&response) {
                    let Some(product_id) = item_product_id(&item) else {
                        continue;
                    };
                    let Some(candidate) = pending.get(&product_id) else {
                        continue;
                    };
                    match picture_verify_state(ozon, candidate, Some(&item)).await {
                        PictureVerifyState::Succeeded => {
                            let candidate = pending.remove(&product_id).expect("pending candidate");
                            result.succeeded += 1;
                            jobs.log(
                                job_id,
                                "info",
                                &format!(
                                    "{} Ozon 已确认图片更新成功：product_id={}，{} 张图",
                                    candidate.item.source_sku,
                                    candidate.product_id,
                                    candidate.item.image_urls.len()
                                ),
                            );
                        }
                        PictureVerifyState::Pending(reason) => {
                            if attempt == IMAGE_REPAIR_VERIFY_ATTEMPTS {
                                jobs.log(
                                    job_id,
                                    "warn",
                                    &format!(
                                        "{} Ozon 图片仍未确认成功：{}",
                                        candidate.item.source_sku, reason
                                    ),
                                );
                            }
                        }
                    }
                }
            }
            Err(error) => {
                jobs.log(
                    job_id,
                    "warn",
                    &format!("查询 Ozon 商品图片确认状态失败，第 {attempt} 次：{error}"),
                );
            }
        }
    }

    for candidate in pending.into_values() {
        result.pending += 1;
        result.pending_skus.push(candidate.item.source_sku);
    }
    result
}

async fn picture_verify_state(
    ozon: &OzonSellerClient,
    candidate: &RepairCandidate,
    info_item: Option<&Value>,
) -> PictureVerifyState {
    match ozon
        .product_picture_import_status(candidate.product_id)
        .await
    {
        Ok(response) => {
            let states = import_picture_states(&response);
            let loaded = import_picture_uploaded_urls(&response);
            if urls_match(&loaded, &candidate.item.image_urls)
                || (loaded.len() >= candidate.item.image_urls.len()
                    && states
                        .iter()
                        .all(|state| state.eq_ignore_ascii_case("uploaded")))
            {
                return PictureVerifyState::Succeeded;
            }
            if states
                .iter()
                .any(|state| state.eq_ignore_ascii_case("pending"))
            {
                return PictureVerifyState::Pending(
                    "Ozon 返回 pending，图片可能还在处理或下载失败，稍后会重试".to_string(),
                );
            }
            if !states.is_empty() {
                return PictureVerifyState::Pending(format!(
                    "Ozon 图片处理状态：{}",
                    states.join("、")
                ));
            }
        }
        Err(error) => {
            if info_item.is_none() {
                return PictureVerifyState::Pending(format!("查询单品图片状态失败：{error}"));
            }
        }
    }

    let urls = info_item.map(extract_info_picture_urls).unwrap_or_default();
    if urls_match(&urls, &candidate.item.image_urls) {
        PictureVerifyState::Succeeded
    } else if urls.is_empty() {
        PictureVerifyState::Pending("Ozon 暂未返回该商品图片".to_string())
    } else {
        PictureVerifyState::Pending(format!(
            "Ozon 当前返回 {} 张图，还未匹配新提交的 {} 张图",
            urls.len(),
            candidate.item.image_urls.len()
        ))
    }
}

fn extract_picture_info_items(response: &Value) -> Vec<Value> {
    if let Some(items) = response.get("items").and_then(Value::as_array) {
        return items.clone();
    }
    extract_items(response)
}

fn extract_info_picture_urls(item: &Value) -> Vec<String> {
    let mut urls = Vec::new();
    for key in ["primary_photo", "photo", "color_photo", "photo_360"] {
        push_string_or_array(item.get(key), &mut urls);
    }
    urls.retain(|url| url.starts_with("http://") || url.starts_with("https://"));
    urls.dedup();
    urls
}

fn import_picture_states(response: &Value) -> Vec<String> {
    let pictures = response
        .pointer("/result/pictures")
        .or_else(|| response.get("pictures"))
        .and_then(Value::as_array);
    pictures
        .into_iter()
        .flatten()
        .filter_map(|picture| picture.get("state").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<Vec<_>>()
}

fn import_picture_uploaded_urls(response: &Value) -> Vec<String> {
    let pictures = response
        .pointer("/result/pictures")
        .or_else(|| response.get("pictures"))
        .and_then(Value::as_array);
    let mut urls = pictures
        .into_iter()
        .flatten()
        .filter(|picture| {
            picture
                .get("state")
                .and_then(Value::as_str)
                .is_none_or(|state| state.eq_ignore_ascii_case("uploaded"))
        })
        .filter_map(|picture| picture.get("url").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<Vec<_>>();
    urls.dedup();
    urls
}

fn push_string_or_array(value: Option<&Value>, urls: &mut Vec<String>) {
    match value {
        Some(Value::String(text)) => urls.push(text.to_string()),
        Some(Value::Array(items)) => {
            for item in items {
                if let Some(text) = item.as_str() {
                    urls.push(text.to_string());
                }
            }
        }
        _ => {}
    }
}

fn urls_match(actual: &[String], expected: &[String]) -> bool {
    if actual.is_empty() || expected.is_empty() {
        return false;
    }
    let actual = actual
        .iter()
        .filter_map(|url| normalized_url_key(url))
        .collect::<HashSet<_>>();
    expected
        .iter()
        .filter_map(|url| normalized_url_key(url))
        .all(|url| actual.contains(&url))
}

fn normalized_url_key(value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    let path = url.path();
    Some(format!(
        "{}://{}{}",
        url.scheme().to_ascii_lowercase(),
        host,
        path
    ))
}

fn item_product_id(item: &Value) -> Option<i64> {
    item.get("product_id")
        .or_else(|| item.get("productId"))
        .or_else(|| item.get("id"))
        .and_then(value_as_i64)
}

fn value_as_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|text| text.parse::<i64>().ok()))
}

fn merge_objects(base: &mut Value, extra: Value) {
    if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            base.insert(key.clone(), value.clone());
        }
    }
}

async fn preflight_listing_images(
    jobs: &JobRegistry,
    job_id: &str,
    source_sku: &str,
    image_urls: &[String],
) -> Result<()> {
    let client = Client::builder()
        .timeout(Duration::from_secs(IMAGE_PREFLIGHT_TIMEOUT_SECONDS))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .context("初始化图片预检查客户端失败")?;
    let mut slow = Vec::new();
    for (index, image_url) in image_urls.iter().enumerate() {
        let started = Instant::now();
        let response = client
            .get(image_url)
            .header(reqwest::header::RANGE, "bytes=0-65535")
            .send()
            .await
            .with_context(|| {
                format!(
                    "{} 第 {} 张图片预检查连接失败：{}",
                    source_sku,
                    index + 1,
                    compact_url(image_url)
                )
            })?;
        let elapsed_ms = started.elapsed().as_millis();
        let status = response.status();
        if !status.is_success() {
            anyhow::bail!(
                "{} 第 {} 张图片预检查失败：HTTP {}，{}",
                source_sku,
                index + 1,
                status.as_u16(),
                compact_url(image_url)
            );
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !content_type.starts_with("image/") {
            anyhow::bail!(
                "{} 第 {} 张图片不是可下载图片：Content-Type={}，{}",
                source_sku,
                index + 1,
                if content_type.is_empty() {
                    "未知"
                } else {
                    &content_type
                },
                compact_url(image_url)
            );
        }
        let bytes = response.bytes().await.with_context(|| {
            format!(
                "{} 第 {} 张图片预检查读取失败：{}",
                source_sku,
                index + 1,
                compact_url(image_url)
            )
        })?;
        if bytes.is_empty() {
            anyhow::bail!(
                "{} 第 {} 张图片返回空内容：{}",
                source_sku,
                index + 1,
                compact_url(image_url)
            );
        }
        if elapsed_ms > 5_000 {
            slow.push(format!("第 {} 张 {}ms", index + 1, elapsed_ms));
        }
    }
    if slow.is_empty() {
        jobs.log(
            job_id,
            "info",
            &format!("{} 图片链接预检查通过：{} 张", source_sku, image_urls.len()),
        );
    } else {
        jobs.log(
            job_id,
            "warn",
            &format!("{} 图片可下载但偏慢：{}", source_sku, slow.join("；")),
        );
    }
    Ok(())
}

fn progress_for_shop(shop_index: usize, total_shops: usize, local_progress: usize) -> u8 {
    let base = (shop_index * 100) / total_shops.max(1);
    let span = 100 / total_shops.max(1);
    (base + (span * local_progress.min(100)) / 100).clamp(1, 99) as u8
}

fn image_hosts(image_urls: &[String]) -> String {
    let mut hosts = image_urls
        .iter()
        .filter_map(|url| Url::parse(url).ok())
        .filter_map(|url| url.host_str().map(str::to_string))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    hosts.sort();
    if hosts.is_empty() {
        "未知域名".into()
    } else {
        hosts.join("、")
    }
}

fn compact_url(value: &str) -> String {
    if value.chars().count() <= 120 {
        value.to_string()
    } else {
        format!("{}...", value.chars().take(117).collect::<String>())
    }
}

fn compact_list<I>(values: I, limit: usize) -> String
where
    I: IntoIterator<Item = String>,
{
    let values = values.into_iter().collect::<Vec<_>>();
    let mut shown = values.iter().take(limit).cloned().collect::<Vec<_>>();
    if values.len() > shown.len() {
        shown.push(format!("还有 {} 个", values.len() - shown.len()));
    }
    shown.join("、")
}
