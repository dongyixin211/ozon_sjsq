use crate::core::batch::RuntimeShopConfig;
use crate::core::business::{self, extract_task_id};
use crate::core::jobs::JobRegistry;
use crate::core::models::{
    AutoListingItem, AutoListingRequest, AutoListingShopConfig, ImportPreviewInput, JobStatus,
};
use crate::core::ozon::{extract_items, OzonSellerClient};
use anyhow::{Context, Result};
use futures_util::StreamExt;
use reqwest::{Client, Url};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::time::Instant;
use tokio::time::Duration;

const IMPORT_BATCH_SIZE: usize = 100;
const IMAGE_PREFLIGHT_TIMEOUT_SECONDS: u64 = 12;
const SHOP_BATCH_CONCURRENCY: usize = 12;

#[derive(Clone)]
struct ImportCandidate {
    item: AutoListingItem,
    payload: Value,
}

#[derive(Clone)]
struct SubmittedListing {
    item: AutoListingItem,
}

#[derive(Default)]
struct ShopBatchResult {
    submitted: usize,
    failed: usize,
    source_asset_ids: Vec<String>,
}

#[derive(Default)]
struct SubmitBatchResult {
    submitted: Vec<SubmittedListing>,
    failed: usize,
}

struct ShopBatchWork {
    shop_index: usize,
    shop_id: String,
    item_count: usize,
    runtime: RuntimeShopConfig,
    config: AutoListingShopConfig,
    items: Vec<AutoListingItem>,
}

struct ShopBatchOutcome {
    shop_id: String,
    shop_name: String,
    item_count: usize,
    result: Result<ShopBatchResult>,
}

#[derive(Default)]
struct ExistingOfferCheck {
    blocked: HashSet<String>,
    retryable_image_failures: Vec<String>,
}

#[derive(Clone)]
struct CloudListingSync {
    batch_id: String,
    base_url: String,
    auth_token: String,
    external_shop_id_by_shop_id: HashMap<String, String>,
}

#[derive(Clone, Default)]
struct CloudUploadedScope {
    external_shop_ids: Vec<String>,
    source_asset_ids: Vec<String>,
}

pub async fn run_auto_listing(
    jobs: JobRegistry,
    job_id: String,
    request: AutoListingRequest,
    shops: Vec<RuntimeShopConfig>,
    cache_root: PathBuf,
) {
    if let Err(error) = auto_listing_inner(&jobs, &job_id, request, shops, cache_root).await {
        jobs.log(&job_id, "error", &error.to_string());
        jobs.fail(&job_id, error.to_string());
    }
}

async fn auto_listing_inner(
    jobs: &JobRegistry,
    job_id: &str,
    request: AutoListingRequest,
    shops: Vec<RuntimeShopConfig>,
    cache_root: PathBuf,
) -> Result<()> {
    jobs.update(job_id, JobStatus::Running, 1, None);
    if request.items.is_empty() {
        anyhow::bail!("没有可自动上架的商品");
    }

    let cloud_listing_sync = cloud_listing_sync_from_request(&request);
    let expected_asset_counts =
        request
            .items
            .iter()
            .fold(HashMap::<String, usize>::new(), |mut counts, item| {
                *counts.entry(item.source_asset_id.clone()).or_default() += 1;
                counts
            });
    let mut successful_asset_counts = HashMap::<String, usize>::new();
    let total_items = request.items.len();
    let shop_by_id = shops
        .into_iter()
        .map(|runtime| (runtime.shop.id.clone(), runtime))
        .collect::<HashMap<_, _>>();
    let config_by_shop_id = request
        .shop_configs
        .into_iter()
        .map(|config| (config.shop_id.clone(), config))
        .collect::<HashMap<_, _>>();
    let mut items_by_shop_id: BTreeMap<String, Vec<AutoListingItem>> = BTreeMap::new();
    for item in request.items {
        items_by_shop_id
            .entry(item.shop_id.clone())
            .or_default()
            .push(item);
    }

    jobs.log(
        job_id,
        "info",
        &format!(
            "开始自动上架：{} 个商品，样机 {}。本任务只负责提交商品到 Ozon；库存、条码和活动由店铺自动运维任务单独处理。",
            total_items, request.mockup_template_name
        ),
    );
    if let Some(batch_id) = request
        .batch_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        jobs.log(job_id, "info", &format!("关联云图库上架包：{batch_id}"));
    }

    let total_shops = items_by_shop_id.len().max(1);
    let mut success_count = 0usize;
    let mut failed_count = 0usize;
    let mut cloud_upload_sync_attempted = false;
    let mut pending_cloud_uploaded_scopes = Vec::new();
    let mut shop_batch_works = Vec::new();
    for (shop_index, (shop_id, items)) in items_by_shop_id.into_iter().enumerate() {
        if jobs.is_cancelled(job_id) {
            jobs.log(job_id, "warn", "?????????");
            return Ok(());
        }
        let item_count = items.len();
        let Some(runtime) = shop_by_id.get(&shop_id) else {
            failed_count += item_count;
            jobs.log(
                job_id,
                "error",
                &format!("?? {shop_id} ??????????? {item_count} ???"),
            );
            continue;
        };
        let Some(config) = config_by_shop_id.get(&shop_id) else {
            failed_count += item_count;
            jobs.log(
                job_id,
                "error",
                &format!("?? {} ????????????? {item_count} ???", runtime.shop.name),
            );
            continue;
        };

        jobs.update(
            job_id,
            JobStatus::Running,
            progress_for_shop(shop_index, total_shops, 1),
            None,
        );
        shop_batch_works.push(ShopBatchWork {
            shop_index,
            shop_id,
            item_count,
            runtime: runtime.clone(),
            config: config.clone(),
            items,
        });
    }

    if shop_batch_works.len() > 1 {
        jobs.log(
            job_id,
            "info",
            &format!(
                "??????????????? {} ???????",
                SHOP_BATCH_CONCURRENCY.min(shop_batch_works.len())
            ),
        );
    }
    let jobs_for_stream = jobs.clone();
    let job_id_for_stream = job_id.to_string();
    let cloud_listing_sync_for_stream = cloud_listing_sync.clone();
    let mut outcomes = futures_util::stream::iter(shop_batch_works.into_iter().map(|work| {
        let jobs = jobs_for_stream.clone();
        let job_id = job_id_for_stream.clone();
        let cloud_listing_sync = cloud_listing_sync_for_stream.clone();
        async move {
            let shop_id = work.shop_id;
            let shop_name = work.runtime.shop.name.clone();
            let item_count = work.item_count;
            let result = process_shop_batch(
                &jobs,
                &job_id,
                &work.runtime,
                &work.config,
                work.items,
                work.shop_index,
                total_shops,
                cloud_listing_sync.as_ref(),
            )
            .await;
            ShopBatchOutcome {
                shop_id,
                shop_name,
                item_count,
                result,
            }
        }
    }))
    .buffer_unordered(SHOP_BATCH_CONCURRENCY.max(1));
    while let Some(outcome) = outcomes.next().await {
        if jobs.is_cancelled(job_id) {
            jobs.log(job_id, "warn", "?????????");
            return Ok(());
        }
        match outcome.result {
            Ok(result) => {
                success_count += result.submitted;
                failed_count += result.failed;
                if result.submitted > 0 {
                    cloud_upload_sync_attempted = true;
                    let scope = CloudUploadedScope {
                        external_shop_ids: cloud_external_shop_ids(
                            cloud_listing_sync.as_ref(),
                            &outcome.shop_id,
                        ),
                        source_asset_ids: result.source_asset_ids.clone(),
                    };
                    for asset_id in result.source_asset_ids {
                        *successful_asset_counts.entry(asset_id).or_default() += 1;
                    }
                    let marked = mark_cloud_listing_batch_uploaded(
                        jobs,
                        job_id,
                        cloud_listing_sync.as_ref(),
                        Some(scope.clone()),
                    )
                    .await;
                    if !marked {
                        pending_cloud_uploaded_scopes.push(scope);
                    }
                }
            }
            Err(error) => {
                failed_count += outcome.item_count;
                jobs.log(
                    job_id,
                    "error",
                    &format!("?? {} ?????????{error}", outcome.shop_name),
                );
            }
        }
    }

    if failed_count > 0 && success_count == 0 {
        anyhow::bail!("自动上架全部失败，请查看任务日志");
    }
    if !pending_cloud_uploaded_scopes.is_empty()
        && cloud_upload_sync_attempted
        && cloud_listing_sync.is_some()
        && success_count > 0
    {
        for scope in pending_cloud_uploaded_scopes {
            mark_cloud_listing_batch_uploaded(
                jobs,
                job_id,
                cloud_listing_sync.as_ref(),
                Some(scope),
            )
            .await;
        }
    }
    jobs.complete_with_result(job_id, None, success_count, failed_count);
    for (asset_id, expected_count) in expected_asset_counts {
        if successful_asset_counts.get(&asset_id).copied().unwrap_or(0) < expected_count {
            continue;
        }
        match crate::core::local_mockup::remove_source_asset_cache(&cache_root, &asset_id) {
            Ok(true) => jobs.log(
                job_id,
                "info",
                &format!("商品上架成功，已清理本地原图缓存：{asset_id}"),
            ),
            Ok(false) => {}
            Err(error) => jobs.log(job_id, "warn", &error.to_string()),
        }
    }
    Ok(())
}

fn cloud_listing_sync_from_request(request: &AutoListingRequest) -> Option<CloudListingSync> {
    let batch_id = request
        .batch_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();
    let auth_token = request
        .cloud_auth_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();
    let base_url = request
        .cloud_api_base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("https://api.dyxtoolai.cn")
        .trim_end_matches('/')
        .to_string();
    Some(CloudListingSync {
        batch_id,
        base_url,
        auth_token,
        external_shop_id_by_shop_id: request
            .cloud_external_shop_id_by_shop_id
            .clone()
            .unwrap_or_default(),
    })
}

async fn mark_cloud_listing_batch_uploaded(
    jobs: &JobRegistry,
    job_id: &str,
    sync: Option<&CloudListingSync>,
    scope: Option<CloudUploadedScope>,
) -> bool {
    let Some(sync) = sync else {
        jobs.log(
            job_id,
            "warn",
            "云图库已上传状态未同步：当前任务缺少会员登录令牌",
        );
        return false;
    };
    let url = format!(
        "{}/gallery/listing-batches/{}/mark-uploaded?compact=true",
        sync.base_url, sync.batch_id
    );
    let result: Result<()> = match Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .context("初始化云图库同步客户端失败")
    {
        Ok(client) => {
            let response = client
                .post(url)
                .bearer_auth(&sync.auth_token)
                .json(&json!({
                    "externalShopIds": scope
                        .as_ref()
                        .map(|item| item.external_shop_ids.clone())
                        .unwrap_or_default(),
                    "sourceAssetIds": scope
                        .as_ref()
                        .map(|item| item.source_asset_ids.clone())
                        .unwrap_or_default(),
                }))
                .send()
                .await
                .context("请求云图库同步接口失败");
            match response {
                Ok(response) if response.status().is_success() => Ok(()),
                Ok(response) => {
                    let status = response.status();
                    let text = response.text().await.unwrap_or_default();
                    Err(anyhow::anyhow!("云图库同步接口返回 {status}: {text}"))
                }
                Err(error) => Err(error),
            }
        }
        Err(error) => Err(error),
    };

    match result {
        Ok(()) => {
            jobs.log(
                job_id,
                "info",
                "已同步云图库上架包状态：相关图片进入已上传图片",
            );
            true
        }
        Err(error) => {
            jobs.log(
                job_id,
                "warn",
                &format!("云图库已上传状态同步失败：{error:#}"),
            );
            false
        }
    }
}

async fn update_cloud_listing_progress(
    jobs: &JobRegistry,
    job_id: &str,
    sync: Option<&CloudListingSync>,
    items: &[AutoListingItem],
    stage: &str,
    status: &str,
    progress: u8,
    message: Option<&str>,
    product_ids_by_sku: Option<&HashMap<String, i64>>,
    completed: bool,
) {
    let Some(sync) = sync else {
        return;
    };
    if items.is_empty() {
        return;
    }
    let url = format!(
        "{}/gallery/listing-batches/{}/progress",
        sync.base_url, sync.batch_id
    );
    let payload_items = items
        .iter()
        .map(|item| {
            let mut payload = json!({
                "sourceAssetId": item.source_asset_id,
                "stage": stage,
                "status": status,
                "progress": progress,
                "overallProgress": progress,
                "completed": completed,
            });
            if let Some(external_shop_id) = sync.external_shop_id_by_shop_id.get(&item.shop_id) {
                payload["externalShopId"] = json!(external_shop_id);
            }
            if let Some(message) = message {
                payload["message"] = json!(message);
            }
            if let Some(product_id) = product_ids_by_sku
                .and_then(|map| map.get(&item.source_sku))
                .copied()
                .filter(|product_id| *product_id > 0)
            {
                payload["productId"] = json!(product_id);
            }
            payload
        })
        .collect::<Vec<_>>();
    let result: Result<()> = async {
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .context("初始化云图库进度同步客户端失败")?;
        let response = client
            .post(url)
            .bearer_auth(&sync.auth_token)
            .json(&json!({ "items": payload_items }))
            .send()
            .await
            .context("请求云图库进度同步接口失败")?;
        if response.status().is_success() {
            Ok(())
        } else {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            Err(anyhow::anyhow!("云图库进度同步接口返回 {status}: {text}"))
        }
    }
    .await;
    if let Err(error) = result {
        jobs.log(job_id, "warn", &format!("云图库进度同步失败：{error:#}"));
    }
}

fn cloud_external_shop_ids(sync: Option<&CloudListingSync>, shop_id: &str) -> Vec<String> {
    sync.and_then(|item| item.external_shop_id_by_shop_id.get(shop_id))
        .map(|value| vec![value.clone()])
        .unwrap_or_default()
}

async fn process_shop_batch(
    jobs: &JobRegistry,
    job_id: &str,
    runtime: &RuntimeShopConfig,
    config: &AutoListingShopConfig,
    items: Vec<AutoListingItem>,
    shop_index: usize,
    total_shops: usize,
    cloud_listing_sync: Option<&CloudListingSync>,
) -> Result<ShopBatchResult> {
    let mut result = ShopBatchResult::default();
    let ozon = OzonSellerClient::new(runtime.shop.client_id.clone(), runtime.ozon_api_key.clone())?;

    jobs.log(
        job_id,
        "info",
        &format!("{} 开始处理：{} 个商品", runtime.shop.name, items.len()),
    );

    let mut valid_items = Vec::new();
    for item in items {
        match validate_item(config, &item) {
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
    update_cloud_listing_progress(
        jobs,
        job_id,
        cloud_listing_sync,
        &valid_items,
        "listing",
        "running",
        45,
        Some("submitting"),
        None,
        false,
    )
    .await;

    jobs.update(
        job_id,
        JobStatus::Running,
        progress_for_shop(shop_index, total_shops, 10),
        None,
    );
    let offer_ids = valid_items
        .iter()
        .map(|item| item.source_sku.clone())
        .collect::<Vec<_>>();
    let existing = existing_offer_check(&ozon, &offer_ids)
        .await
        .context("检查 Ozon 已有货号失败")?;
    if !existing.retryable_image_failures.is_empty() {
        jobs.log(
            job_id,
            "warn",
            &format!(
                "{} 有 {} 个货号在 Ozon 处于图片下载失败未创建状态，将直接使用云图库图片链接重新提交：{}",
                runtime.shop.name,
                existing.retryable_image_failures.len(),
                compact_list(existing.retryable_image_failures.clone(), 12)
            ),
        );
    }

    let mut candidates = Vec::new();
    let mut already_uploaded_items = Vec::new();
    for item in valid_items {
        if existing.blocked.contains(&item.source_sku) {
            jobs.log(
                job_id,
                "warn",
                &format!("{} Ozon 已存在相同货号，按已上传记录处理", item.source_sku),
            );
            result.submitted += 1;
            result.source_asset_ids.push(item.source_asset_id.clone());
            already_uploaded_items.push(item);
            continue;
        }
        match prepare_item_gallery_image_links(jobs, job_id, runtime, item).await {
            Ok(item) => candidates.push(build_import_candidate(config, item)),
            Err(error) => {
                result.failed += 1;
                jobs.log(
                    job_id,
                    "error",
                    &format!("云图库图片链接不可用，已跳过该商品：{error:#}"),
                );
            }
        }
    }
    update_cloud_listing_progress(
        jobs,
        job_id,
        cloud_listing_sync,
        &already_uploaded_items,
        "listing",
        "done",
        60,
        Some("uploaded"),
        None,
        false,
    )
    .await;
    if candidates.is_empty() {
        return Ok(result);
    }

    jobs.update(
        job_id,
        JobStatus::Running,
        progress_for_shop(shop_index, total_shops, 20),
        None,
    );
    let submit_result = submit_listing_batches(jobs, job_id, &ozon, runtime, &candidates).await;
    result.submitted += submit_result.submitted.len();
    result.failed += submit_result.failed;
    let submitted = submit_result.submitted;
    result.source_asset_ids.extend(
        submitted
            .iter()
            .map(|listing| listing.item.source_asset_id.clone()),
    );
    if submitted.is_empty() {
        return Ok(result);
    }
    let submitted_items = submitted
        .iter()
        .map(|listing| listing.item.clone())
        .collect::<Vec<_>>();
    update_cloud_listing_progress(
        jobs,
        job_id,
        cloud_listing_sync,
        &submitted_items,
        "listing",
        "done",
        60,
        Some("uploaded"),
        None,
        false,
    )
    .await;

    jobs.update(
        job_id,
        JobStatus::Running,
        progress_for_shop(shop_index, total_shops, 90),
        None,
    );
    jobs.log(
        job_id,
        "info",
        &format!(
            "{} ??????? Ozon???????????????????????????",
            runtime.shop.name
        ),
    );
    update_cloud_listing_progress(
        jobs,
        job_id,
        cloud_listing_sync,
        &submitted_items,
        "workflow",
        "done",
        100,
        Some("completed"),
        None,
        true,
    )
    .await;

    jobs.update(
        job_id,
        JobStatus::Running,
        progress_for_shop(shop_index, total_shops, 98),
        None,
    );
    Ok(result)
}

fn validate_item(config: &AutoListingShopConfig, item: &AutoListingItem) -> Result<()> {
    if item.source_sku.trim().is_empty() {
        anyhow::bail!("货号不能为空");
    }
    if item.title.trim().is_empty() {
        anyhow::bail!("标题不能为空");
    }
    if item.image_urls.is_empty() {
        anyhow::bail!("缺少套图图片 URL");
    }
    if config.template_product.is_none() {
        anyhow::bail!("店铺缺少 Ozon 商品模板，请先在店铺管理里保存商品模板 JSON");
    }
    Ok(())
}

fn build_import_candidate(
    config: &AutoListingShopConfig,
    item: AutoListingItem,
) -> ImportCandidate {
    let template_product = config.template_product.clone().unwrap_or_default();
    let description = item
        .description
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| business::extract_template_description(&template_product));
    let payload = business::build_import_item(ImportPreviewInput {
        template_product,
        offer_id: item.source_sku.clone(),
        title: item.title.clone(),
        product_color: item.product_color.clone().unwrap_or_default(),
        product_color_dictionary_values: Vec::new(),
        color_name: item.color_name.clone().unwrap_or_default(),
        description,
        image_urls: item.image_urls.clone(),
        video_links: if config.upload_template_video {
            clean_links(&config.template_video_links)
        } else {
            Vec::new()
        },
        rich_json: item
            .rich_json
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    });
    ImportCandidate { item, payload }
}

async fn prepare_item_gallery_image_links(
    jobs: &JobRegistry,
    job_id: &str,
    runtime: &RuntimeShopConfig,
    mut item: AutoListingItem,
) -> Result<AutoListingItem> {
    let image_urls = item
        .image_urls
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| {
            let url = Url::parse(value).with_context(|| {
                format!(
                    "{} 图片链接格式不正确：{}",
                    item.source_sku,
                    compact_url(value)
                )
            })?;
            match url.scheme() {
                "http" | "https" => Ok(value.to_string()),
                _ => anyhow::bail!(
                    "{} 图片链接必须是 http/https：{}",
                    item.source_sku,
                    compact_url(value)
                ),
            }
        })
        .collect::<Result<Vec<_>>>()?;
    if image_urls.is_empty() {
        anyhow::bail!("{} 没有可提交给 Ozon 的云图库图片链接", item.source_sku);
    }
    preflight_listing_images(jobs, job_id, &item.source_sku, &image_urls).await?;
    let mut hosts = image_urls
        .iter()
        .filter_map(|url| url_host(url))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    hosts.sort();
    jobs.log(
        job_id,
        "info",
        &format!(
            "{} 直接使用云图库图片链接提交 Ozon：{} 张，来源 {}",
            item.source_sku,
            image_urls.len(),
            if hosts.is_empty() {
                "未知域名".to_string()
            } else {
                hosts.join("、")
            }
        ),
    );
    if runtime
        .shop
        .oss_bucket
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        jobs.log(
            job_id,
            "info",
            &format!(
                "{} 已跳过店铺 OSS 转存，当前自动上架直接使用图库链接",
                runtime.shop.name
            ),
        );
    }
    item.image_urls = image_urls;
    Ok(item)
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
    let mut slow_or_large = Vec::new();
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
            slow_or_large.push(format!("第 {} 张 {}ms", index + 1, elapsed_ms));
        }
    }
    if slow_or_large.is_empty() {
        jobs.log(
            job_id,
            "info",
            &format!("{} 图片链接预检查通过：{} 张", source_sku, image_urls.len()),
        );
    } else {
        jobs.log(
            job_id,
            "warn",
            &format!(
                "{} 图片链接可下载但偏慢：{}。建议检查 CDN 缓存和源站带宽。",
                source_sku,
                slow_or_large.join("、")
            ),
        );
    }
    Ok(())
}

async fn existing_offer_check(
    ozon: &OzonSellerClient,
    offer_ids: &[String],
) -> Result<ExistingOfferCheck> {
    let mut existing = ExistingOfferCheck::default();
    for chunk in offer_ids.chunks(100) {
        let data = ozon.product_info(chunk.to_vec()).await?;
        for item in extract_items(&data) {
            if let Some(offer_id) = item_offer_id(&item) {
                if is_retryable_image_failure(&item) {
                    existing.retryable_image_failures.push(offer_id);
                } else {
                    existing.blocked.insert(offer_id);
                }
            }
        }
    }
    Ok(existing)
}

async fn submit_listing_batches(
    jobs: &JobRegistry,
    job_id: &str,
    ozon: &OzonSellerClient,
    runtime: &RuntimeShopConfig,
    candidates: &[ImportCandidate],
) -> SubmitBatchResult {
    let mut result = SubmitBatchResult::default();
    for (batch_index, chunk) in candidates.chunks(IMPORT_BATCH_SIZE).enumerate() {
        if jobs.is_cancelled(job_id) {
            jobs.log(job_id, "warn", "自动上架任务已取消");
            break;
        }
        let payloads = chunk
            .iter()
            .map(|candidate| candidate.payload.clone())
            .collect::<Vec<_>>();
        match ozon.import_products(payloads).await {
            Ok(response) => {
                let task_id = format_task_id(&response);
                jobs.log(
                    job_id,
                    "info",
                    &format!(
                        "{} 批量提交上架：第 {} 批 {} 个商品，task_id: {}，货号：{}",
                        runtime.shop.name,
                        batch_index + 1,
                        chunk.len(),
                        task_id,
                        compact_list(
                            chunk
                                .iter()
                                .map(|candidate| candidate.item.source_sku.clone()),
                            12
                        )
                    ),
                );
                result
                    .submitted
                    .extend(chunk.iter().map(|candidate| SubmittedListing {
                        item: candidate.item.clone(),
                    }));
            }
            Err(error) if chunk.len() > 1 => {
                jobs.log(
                    job_id,
                    "warn",
                    &format!(
                        "{} 第 {} 批批量提交失败，自动拆成单个商品重试：{error}",
                        runtime.shop.name,
                        batch_index + 1
                    ),
                );
                for candidate in chunk {
                    if jobs.is_cancelled(job_id) {
                        jobs.log(job_id, "warn", "自动上架任务已取消");
                        break;
                    }
                    match ozon.import_products(vec![candidate.payload.clone()]).await {
                        Ok(response) => {
                            jobs.log(
                                job_id,
                                "info",
                                &format!(
                                    "{} 单品补提交成功，task_id: {}",
                                    candidate.item.source_sku,
                                    format_task_id(&response)
                                ),
                            );
                            result.submitted.push(SubmittedListing {
                                item: candidate.item.clone(),
                            });
                        }
                        Err(error) => {
                            result.failed += 1;
                            jobs.log(
                                job_id,
                                "error",
                                &format!("{} 提交 Ozon 失败：{error}", candidate.item.source_sku),
                            );
                        }
                    }
                }
            }
            Err(error) => {
                result.failed += chunk.len();
                jobs.log(
                    job_id,
                    "error",
                    &format!(
                        "{} 提交 Ozon 失败：{}，货号：{}",
                        runtime.shop.name,
                        error,
                        compact_list(
                            chunk
                                .iter()
                                .map(|candidate| candidate.item.source_sku.clone()),
                            12
                        )
                    ),
                );
            }
        }
    }
    result
}

fn progress_for_shop(shop_index: usize, total_shops: usize, stage_percent: usize) -> u8 {
    let total = total_shops.max(1);
    let stage = stage_percent.min(100);
    let value = 5 + ((shop_index * 100 + stage) * 90) / (total * 100);
    value.clamp(1, 98) as u8
}

fn item_offer_id(item: &Value) -> Option<String> {
    item.get("offer_id")
        .or_else(|| item.get("offerId"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn is_retryable_image_failure(item: &Value) -> bool {
    let is_created = item
        .pointer("/statuses/is_created")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if is_created {
        return false;
    }
    let status_failed = item
        .pointer("/statuses/status_failed")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if status_failed.contains("pics") || status_failed.contains("image") {
        return true;
    }
    item.get("errors")
        .and_then(Value::as_array)
        .is_some_and(|errors| {
            errors.iter().any(|error| {
                let code = error
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                matches!(
                    code.as_str(),
                    "all_image_failed" | "pics_reading_timeout" | "primary_image_load_failed"
                )
            })
        })
}

fn url_host(value: &str) -> Option<String> {
    Url::parse(value)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
}

fn compact_url(value: &str) -> String {
    match Url::parse(value) {
        Ok(url) => {
            let host = url.host_str().unwrap_or("unknown");
            let path = url.path();
            let tail = path
                .rsplit('/')
                .find(|part| !part.is_empty())
                .unwrap_or_default();
            if tail.is_empty() {
                host.to_string()
            } else {
                format!("{host}/.../{tail}")
            }
        }
        Err(_) => value.chars().take(80).collect(),
    }
}

fn clean_links(values: &[String]) -> Vec<String> {
    values
        .iter()
        .map(|value| value.trim())
        .filter(|value| value.starts_with("http://") || value.starts_with("https://"))
        .map(str::to_string)
        .collect()
}

fn compact_list<I>(values: I, limit: usize) -> String
where
    I: IntoIterator<Item = String>,
{
    let mut values = values
        .into_iter()
        .filter(|value| !value.trim().is_empty())
        .collect::<Vec<_>>();
    let total = values.len();
    values.truncate(limit);
    let suffix = if total > limit {
        format!(" 等 {} 个", total)
    } else {
        String::new()
    };
    format!("{}{}", values.join("、"), suffix)
}

fn format_task_id(response: &Value) -> String {
    extract_task_id(response).unwrap_or_else(|| "[未返回]".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn treats_ozon_image_failure_as_retryable_existing_offer() {
        let item = json!({
            "offer_id": "SKU-1",
            "statuses": {
                "is_created": false,
                "status_failed": "pics_delivered"
            },
            "errors": [
                { "code": "all_image_failed" }
            ]
        });
        assert!(is_retryable_image_failure(&item));

        let created = json!({
            "offer_id": "SKU-2",
            "statuses": {
                "is_created": true,
                "status_failed": "pics_delivered"
            },
            "errors": [
                { "code": "all_image_failed" }
            ]
        });
        assert!(!is_retryable_image_failure(&created));
    }
}
