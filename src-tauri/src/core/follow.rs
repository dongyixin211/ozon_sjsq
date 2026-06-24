use crate::core::business;
use crate::core::jobs::JobRegistry;
use crate::core::media;
use crate::core::models::{
    AttributeDictionaryValue, FollowAutomationRequest, ImportPreviewInput, JobStatus, Shop,
};
use crate::core::oss::AliyunOssClient;
use crate::core::ozon::{extract_items, OzonSellerClient};
use anyhow::{Context, Result};
use reqwest::Client;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tokio::time::{sleep, Duration};

pub const DEFAULT_FOLLOW_PRICE_MULTIPLIER: f64 = 3.0;

#[derive(Clone)]
pub struct RuntimeOzonShop {
    pub shop: Shop,
    pub ozon_api_key: String,
    pub oss_secret: Option<String>,
}

#[derive(Clone)]
pub struct FollowSyncPair {
    pub main: RuntimeOzonShop,
    pub follower: RuntimeOzonShop,
}

struct FollowSyncLimits {
    max_created: Option<usize>,
    price_multiplier: f64,
}

impl Default for FollowSyncLimits {
    fn default() -> Self {
        Self {
            max_created: None,
            price_multiplier: DEFAULT_FOLLOW_PRICE_MULTIPLIER,
        }
    }
}

#[derive(Default)]
struct FollowSyncOutcome {
    created_count: usize,
    skipped_count: usize,
    failed_count: usize,
    limit_reached: bool,
}

pub async fn run_follow_sync(
    jobs: JobRegistry,
    job_id: String,
    pairs: Vec<FollowSyncPair>,
    price_multiplier: f64,
) {
    match follow_sync_inner(
        &jobs,
        &job_id,
        pairs,
        FollowSyncLimits {
            price_multiplier,
            ..FollowSyncLimits::default()
        },
    )
    .await
    {
        Ok(outcome) => {
            if jobs.is_cancelled(&job_id) {
                return;
            }
            jobs.log(
                &job_id,
                "info",
                &format!(
                    "跟卖同步完成：补齐 {} 个，跳过 {} 个，失败 {} 个",
                    outcome.created_count, outcome.skipped_count, outcome.failed_count
                ),
            );
            jobs.complete_with_result(&job_id, None, outcome.created_count, outcome.failed_count);
        }
        Err(error) => {
            jobs.log(&job_id, "error", &format!("{error:#}"));
            jobs.fail(&job_id, format!("{error:#}"));
        }
    }
}

pub async fn run_follow_automation(
    jobs: JobRegistry,
    job_id: String,
    pairs: Vec<FollowSyncPair>,
    request: FollowAutomationRequest,
) {
    if let Err(error) = follow_automation_inner(&jobs, &job_id, pairs, request).await {
        jobs.log(&job_id, "error", &format!("{error:#}"));
        jobs.fail(&job_id, format!("{error:#}"));
    }
}

async fn follow_sync_inner(
    jobs: &JobRegistry,
    job_id: &str,
    pairs: Vec<FollowSyncPair>,
    limits: FollowSyncLimits,
) -> Result<FollowSyncOutcome> {
    if pairs.is_empty() {
        anyhow::bail!("没有可同步的跟卖店铺");
    }
    jobs.update(job_id, JobStatus::Running, 1, None);

    let mut created_count = 0usize;
    let mut skipped_count = 0usize;
    let mut failed_count = 0usize;
    let mut limit_reached = false;
    jobs.log(
        job_id,
        "info",
        &format!(
            "本次跟卖售价按主店售价的 {} 倍计算",
            format_price(limits.price_multiplier)
        ),
    );

    'pairs: for pair in pairs {
        if jobs.is_cancelled(job_id) {
            jobs.log(job_id, "warn", "跟卖同步已取消");
            break;
        }
        jobs.log(
            job_id,
            "info",
            &format!(
                "同步主店 {} -> 跟卖店 {}",
                pair.main.shop.name, pair.follower.shop.name
            ),
        );
        let main_client =
            OzonSellerClient::new(pair.main.shop.client_id.clone(), pair.main.ozon_api_key)?;
        let follower_client = OzonSellerClient::new(
            pair.follower.shop.client_id.clone(),
            pair.follower.ozon_api_key.clone(),
        )?;
        let products = main_client
            .list_all_products()
            .await
            .with_context(|| format!("拉取主店 {} 商品失败", pair.main.shop.name))?;
        if products.is_empty() {
            jobs.log(
                job_id,
                "warn",
                &format!("主店 {} 没有商品", pair.main.shop.name),
            );
            continue;
        }

        for (index, product) in products.iter().enumerate() {
            if limits
                .max_created
                .is_some_and(|max_created| created_count >= max_created)
            {
                limit_reached = true;
                jobs.log(job_id, "info", "跟卖上架已达到本轮上限，停止上架同步。");
                break 'pairs;
            }
            if jobs.is_cancelled(job_id) {
                jobs.log(job_id, "warn", "跟卖同步已取消");
                break 'pairs;
            }
            let progress = (((index + 1) * 100) / products.len().max(1)).clamp(1, 99) as u8;
            jobs.update(job_id, JobStatus::Running, progress, None);

            if product.offer_id.trim().is_empty() {
                skipped_count += 1;
                continue;
            }
            match follower_product_exists(&follower_client, &product.offer_id).await {
                Ok(true) => {
                    skipped_count += 1;
                    continue;
                }
                Ok(false) => {}
                Err(error) => {
                    failed_count += 1;
                    jobs.log(
                        job_id,
                        "error",
                        &format!("{} 检查跟卖店是否存在失败：{error}", product.offer_id),
                    );
                    continue;
                }
            }

            match build_follow_import_item(
                jobs,
                job_id,
                &main_client,
                &pair.follower,
                product,
                limits.price_multiplier,
            )
            .await
            {
                Ok(item) => match follower_client.import_products(vec![item]).await {
                    Ok(response) => {
                        created_count += 1;
                        let task_id = business::extract_task_id(&response).unwrap_or_default();
                        jobs.log(
                            job_id,
                            "info",
                            &format!(
                                "{} 已提交到跟卖店 {}，task_id: {}",
                                product.offer_id,
                                pair.follower.shop.name,
                                if task_id.is_empty() {
                                    "[未返回]"
                                } else {
                                    &task_id
                                }
                            ),
                        );
                    }
                    Err(error) => {
                        failed_count += 1;
                        jobs.log(
                            job_id,
                            "error",
                            &format!("{} 提交跟卖店失败：{error}", product.offer_id),
                        );
                    }
                },
                Err(error) => {
                    failed_count += 1;
                    jobs.log(
                        job_id,
                        "error",
                        &format!("{} 构建跟卖商品失败：{error}", product.offer_id),
                    );
                }
            }
        }
    }

    Ok(FollowSyncOutcome {
        created_count,
        skipped_count,
        failed_count,
        limit_reached,
    })
}

async fn follow_automation_inner(
    jobs: &JobRegistry,
    job_id: &str,
    pairs: Vec<FollowSyncPair>,
    request: FollowAutomationRequest,
) -> Result<()> {
    if pairs.is_empty() {
        anyhow::bail!("没有可自动执行的跟卖店铺");
    }

    jobs.update(job_id, JobStatus::Running, 1, None);
    let interval_minutes = request.interval_minutes.clamp(1, 1440) as u64;
    let mut cycle = 1usize;
    let mut total_success = 0usize;
    let mut total_failed = 0usize;
    let mut total_follow_created = 0usize;
    let mut follow_sync_stopped = false;

    loop {
        if jobs.is_cancelled(job_id) {
            jobs.log(job_id, "warn", "跟卖自动化已取消");
            return Ok(());
        }

        jobs.log(job_id, "info", &format!("开始第 {cycle} 轮跟卖自动化"));
        let mut cycle_success = 0usize;
        let mut cycle_failed = 0usize;

        if request.auto_follow_sync && follow_sync_stopped {
            jobs.log(job_id, "info", "自动跟卖上架已达到上限，本轮跳过上架任务。");
        } else if request.auto_follow_sync {
            let remaining_follow_items = request
                .max_follow_items
                .filter(|value| *value > 0)
                .map(|max_items| max_items as usize)
                .map(|max_items| max_items.saturating_sub(total_follow_created));
            if remaining_follow_items == Some(0) {
                follow_sync_stopped = true;
                jobs.log(
                    job_id,
                    "info",
                    "自动跟卖上架已达到上限，后续只执行库存、条码和活动任务。",
                );
            } else {
                match follow_sync_inner(
                    jobs,
                    job_id,
                    pairs.clone(),
                    FollowSyncLimits {
                        max_created: remaining_follow_items,
                        price_multiplier: request.price_multiplier,
                    },
                )
                .await
                {
                    Ok(outcome) => {
                        cycle_success += outcome.created_count;
                        cycle_failed += outcome.failed_count;
                        total_follow_created += outcome.created_count;
                        if request
                            .max_follow_items
                            .filter(|value| *value > 0)
                            .is_some_and(|max_items| total_follow_created >= max_items as usize)
                        {
                            follow_sync_stopped = true;
                        }
                        let suffix = if outcome.limit_reached {
                            "，自动跟卖上架达到上限"
                        } else {
                            ""
                        };
                        jobs.log(
                            job_id,
                            "info",
                            &format!(
                                "本轮跟卖上架：补齐 {} 个，跳过 {} 个，失败 {} 个{}",
                                outcome.created_count,
                                outcome.skipped_count,
                                outcome.failed_count,
                                suffix
                            ),
                        );
                        if follow_sync_stopped {
                            jobs.log(
                                job_id,
                                "info",
                                "后续轮次将停止跟卖上架任务，库存、条码和活动任务继续执行。",
                            );
                        }
                    }
                    Err(error) => {
                        cycle_failed += 1;
                        jobs.log(job_id, "error", &format!("本轮跟卖上架失败：{error:#}"));
                    }
                }
            }
        }

        for pair in &pairs {
            if jobs.is_cancelled(job_id) {
                jobs.log(job_id, "warn", "跟卖自动化已取消");
                return Ok(());
            }

            let follower_client = OzonSellerClient::new(
                pair.follower.shop.client_id.clone(),
                pair.follower.ozon_api_key.clone(),
            )?;
            let follower_name = pair.follower.shop.name.clone();

            if request.auto_update_stock {
                match update_zero_stock_products(
                    jobs,
                    job_id,
                    &follower_client,
                    &pair.follower,
                    request.stock.unwrap_or(0),
                )
                .await
                {
                    Ok(count) => cycle_success += count,
                    Err(error) => {
                        cycle_failed += 1;
                        jobs.log(
                            job_id,
                            "error",
                            &format!("{follower_name} 自动补库存失败：{error:#}"),
                        );
                    }
                }
            }

            if request.auto_generate_barcode {
                match generate_missing_barcodes(jobs, job_id, &follower_client, &follower_name)
                    .await
                {
                    Ok(count) => cycle_success += count,
                    Err(error) => {
                        cycle_failed += 1;
                        jobs.log(
                            job_id,
                            "error",
                            &format!("{follower_name} 自动生成条形码失败：{error:#}"),
                        );
                    }
                }
            }

            if request.auto_add_to_action {
                match add_action_candidates(
                    jobs,
                    job_id,
                    &follower_client,
                    &follower_name,
                    request.action_id.context("未选择活动")?,
                    request.action_price.as_deref(),
                    request.action_stock.unwrap_or(0),
                )
                .await
                {
                    Ok(count) => cycle_success += count,
                    Err(error) => {
                        cycle_failed += 1;
                        jobs.log(
                            job_id,
                            "error",
                            &format!("{follower_name} 自动加入活动失败：{error:#}"),
                        );
                    }
                }
            }
        }

        total_success += cycle_success;
        total_failed += cycle_failed;
        jobs.update(job_id, JobStatus::Running, 95, None);
        jobs.log(
            job_id,
            "info",
            &format!(
                "第 {cycle} 轮完成：处理 {cycle_success} 个，失败 {cycle_failed} 个；累计处理 {total_success} 个，累计失败 {total_failed} 个"
            ),
        );
        jobs.log(
            job_id,
            "info",
            &format!("{interval_minutes} 分钟后执行下一轮；如需停止，请取消该任务。"),
        );

        wait_next_cycle(jobs, job_id, interval_minutes).await;
        cycle += 1;
    }
}

async fn update_zero_stock_products(
    jobs: &JobRegistry,
    job_id: &str,
    client: &OzonSellerClient,
    follower: &RuntimeOzonShop,
    stock_value: i64,
) -> Result<usize> {
    let warehouse_id = resolve_follow_warehouse_id(jobs, job_id, client, follower).await?;
    let products = client
        .list_all_products_by_visibility("EMPTY_STOCK", false)
        .await?;
    let stocks = products
        .iter()
        .filter_map(|product| {
            product.product_id.map(|product_id| {
                json!({
                    "product_id": product_id,
                    "stock": stock_value,
                    "warehouse_id": warehouse_id,
                })
            })
        })
        .collect::<Vec<_>>();
    if stocks.is_empty() {
        jobs.log(
            job_id,
            "info",
            &format!("{} 没有需要补库存的零库存商品", follower.shop.name),
        );
        return Ok(0);
    }

    for (index, chunk) in stocks.chunks(100).enumerate() {
        client.update_stocks(chunk.to_vec()).await?;
        jobs.log(
            job_id,
            "info",
            &format!(
                "{} 补库存批次 {}：{} 个商品，仓库 {}，库存 {}",
                follower.shop.name,
                index + 1,
                chunk.len(),
                warehouse_id,
                stock_value
            ),
        );
    }
    Ok(stocks.len())
}

async fn resolve_follow_warehouse_id(
    jobs: &JobRegistry,
    job_id: &str,
    client: &OzonSellerClient,
    follower: &RuntimeOzonShop,
) -> Result<i64> {
    if let Some(warehouse_id) = follower.shop.follow_warehouse_id {
        return Ok(warehouse_id);
    }
    let warehouses = client
        .list_warehouses()
        .await
        .with_context(|| format!("{} 自动读取仓库失败", follower.shop.name))?;
    match warehouses.as_slice() {
        [warehouse] => {
            jobs.log(
                job_id,
                "info",
                &format!(
                    "{} 未保存跟卖仓库，自动使用唯一仓库 {} ({})",
                    follower.shop.name, warehouse.name, warehouse.warehouse_id
                ),
            );
            Ok(warehouse.warehouse_id)
        }
        [] => anyhow::bail!("{} 未设置跟卖仓库，且 Ozon 未返回仓库", follower.shop.name),
        _ => anyhow::bail!(
            "{} 未设置跟卖仓库，且 Ozon 返回多个仓库，请在设置页填写唯一仓库 ID",
            follower.shop.name
        ),
    }
}

async fn generate_missing_barcodes(
    jobs: &JobRegistry,
    job_id: &str,
    client: &OzonSellerClient,
    follower_name: &str,
) -> Result<usize> {
    let products = client.list_all_products_by_visibility("ALL", true).await?;
    let product_ids = products
        .iter()
        .filter(|product| product.has_barcode != Some(true))
        .filter_map(|product| product.product_id)
        .collect::<Vec<_>>();
    if product_ids.is_empty() {
        jobs.log(job_id, "info", &format!("{follower_name} 没有无条形码商品"));
        return Ok(0);
    }

    for (index, chunk) in product_ids.chunks(100).enumerate() {
        client.generate_barcodes(chunk.to_vec()).await?;
        jobs.log(
            job_id,
            "info",
            &format!(
                "{follower_name} 生成条形码批次 {}：{} 个商品",
                index + 1,
                chunk.len()
            ),
        );
    }
    Ok(product_ids.len())
}

async fn add_action_candidates(
    jobs: &JobRegistry,
    job_id: &str,
    client: &OzonSellerClient,
    follower_name: &str,
    action_id: i64,
    action_price: Option<&str>,
    action_stock: i64,
) -> Result<usize> {
    let mut products = Vec::new();
    let mut last_id = String::new();

    loop {
        let data = client
            .action_candidates(action_id, 1000, last_id.clone())
            .await?;
        let batch = extract_items(&data);
        products.extend(batch);

        let next_last_id = extract_next_last_id(&data);
        if next_last_id.trim().is_empty() || next_last_id == last_id {
            break;
        }
        last_id = next_last_id;
    }

    let payloads = products
        .iter()
        .map(|product| build_action_product_payload(product, action_price, action_stock))
        .collect::<Result<Vec<_>>>()?;
    if payloads.is_empty() {
        jobs.log(
            job_id,
            "info",
            &format!("{follower_name} 没有可加入活动的商品"),
        );
        return Ok(0);
    }

    for (index, chunk) in payloads.chunks(100).enumerate() {
        client
            .activate_action_products(action_id, chunk.to_vec())
            .await?;
        jobs.log(
            job_id,
            "info",
            &format!(
                "{follower_name} 加入活动 {} 批次 {}：{} 个商品",
                action_id,
                index + 1,
                chunk.len()
            ),
        );
    }
    Ok(payloads.len())
}

async fn wait_next_cycle(jobs: &JobRegistry, job_id: &str, interval_minutes: u64) {
    let mut remaining = interval_minutes.saturating_mul(60);
    while remaining > 0 {
        if jobs.is_cancelled(job_id) {
            return;
        }
        let step = remaining.min(10);
        sleep(Duration::from_secs(step)).await;
        remaining -= step;
    }
}

async fn follower_product_exists(client: &OzonSellerClient, offer_id: &str) -> Result<bool> {
    let data = client.product_info(vec![offer_id.to_string()]).await?;
    Ok(!extract_items(&data).is_empty())
}

async fn build_follow_import_item(
    jobs: &JobRegistry,
    job_id: &str,
    client: &OzonSellerClient,
    follower: &RuntimeOzonShop,
    product: &crate::core::models::OzonProductRow,
    price_multiplier: f64,
) -> Result<Value> {
    let source = load_full_product(client, &product.offer_id).await?;
    let image_urls =
        upload_follow_images(jobs, job_id, follower, &product.offer_id, &source).await?;
    let source_price = product
        .price
        .clone()
        .or_else(|| scalar_text(source.get("price")));
    let price = multiply_price(
        source_price.as_deref().context("主店商品缺少售价")?,
        price_multiplier,
    )?;
    let source_old_price = product
        .old_price
        .clone()
        .or_else(|| scalar_text(source.get("old_price")));
    let old_price = source_old_price
        .as_deref()
        .map(|value| multiply_price(value, price_multiplier))
        .transpose()?;
    let currency_code = product.currency_code.clone().or_else(|| {
        source
            .get("currency_code")
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    let title = product_title(&product.offer_id, &source);
    let description = business::extract_template_description(&source);
    let mut item = business::build_import_item(ImportPreviewInput {
        template_product: source,
        offer_id: product.offer_id.clone(),
        title,
        product_color: String::new(),
        product_color_dictionary_values: Vec::<AttributeDictionaryValue>::new(),
        color_name: String::new(),
        description,
        image_urls,
        video_links: Vec::new(),
        rich_json: None,
    });
    if let Some(object) = item.as_object_mut() {
        object.insert("price".into(), json!(price));
        if let Some(old_price) = old_price {
            object.insert("old_price".into(), json!(old_price));
        } else {
            object.remove("old_price");
        }
        if let Some(currency_code) = currency_code.filter(|value| !value.trim().is_empty()) {
            object.insert("currency_code".into(), json!(currency_code));
        }
    }
    Ok(item)
}

async fn upload_follow_images(
    jobs: &JobRegistry,
    job_id: &str,
    follower: &RuntimeOzonShop,
    offer_id: &str,
    source: &Value,
) -> Result<Vec<String>> {
    let source_urls = business::extract_image_urls(source);
    if source_urls.is_empty() {
        anyhow::bail!("主店商品没有可复用图片 URL");
    }
    let Some(watermark_path) = shop_watermark_path(&follower.shop)? else {
        jobs.log(
            job_id,
            "info",
            &format!(
                "{} 未设置跟卖水印，直接复用主店 {} 张图片链接",
                follower.shop.name,
                source_urls.len()
            ),
        );
        return Ok(source_urls);
    };
    let oss = follower_oss_client(follower)?;
    let http = Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()?;
    let temp_root = std::env::temp_dir()
        .join("ozon-sjsq-follow-watermark")
        .join(job_id)
        .join(safe_path_part(&follower.shop.id))
        .join(safe_path_part(offer_id));
    tokio::fs::create_dir_all(&temp_root)
        .await
        .with_context(|| format!("创建跟卖水印临时目录失败: {}", temp_root.display()))?;

    let mut uploaded_urls = Vec::new();
    for (index, source_url) in source_urls.iter().enumerate() {
        let source_path = temp_root.join(format!("source-{}.img", index + 1));
        download_image(&http, source_url, &source_path).await?;
        let upload_path = temp_root.join(format!("watermarked-{}.png", index + 1));
        media::create_watermarked_upload_copy(&source_path, &watermark_path, &upload_path)?;
        let object_key = business::build_oss_object_key(
            &follower.shop.client_id,
            offer_id,
            &format!("follow-{}.png", index + 1),
        )?;
        jobs.log(
            job_id,
            "info",
            &format!("{offer_id} 跟卖店水印图上传 OSS: {object_key}"),
        );
        uploaded_urls.push(oss.upload_file(&upload_path, &object_key).await?);
    }
    Ok(uploaded_urls)
}

async fn download_image(http: &Client, url: &str, destination: &Path) -> Result<()> {
    let response = http
        .get(url)
        .send()
        .await
        .with_context(|| format!("下载主店图片失败: {url}"))?;
    if !response.status().is_success() {
        anyhow::bail!("下载主店图片 HTTP {}: {url}", response.status().as_u16());
    }
    let bytes = response
        .bytes()
        .await
        .with_context(|| format!("读取主店图片响应失败: {url}"))?;
    tokio::fs::write(destination, bytes)
        .await
        .with_context(|| format!("保存主店图片失败: {}", destination.display()))?;
    Ok(())
}

fn shop_watermark_path(shop: &Shop) -> Result<Option<PathBuf>> {
    let Some(path) = shop
        .watermark_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    else {
        return Ok(None);
    };
    if !path.is_file() {
        anyhow::bail!("{} 店铺水印图片不存在: {}", shop.name, path.display());
    }
    Ok(Some(path))
}

fn safe_path_part(value: &str) -> String {
    let cleaned = value
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => ch,
        })
        .collect::<String>();
    if cleaned.trim().is_empty() {
        "item".into()
    } else {
        cleaned
    }
}

fn follower_oss_client(follower: &RuntimeOzonShop) -> Result<AliyunOssClient> {
    AliyunOssClient::new(
        follower.shop.oss_access_key_id.clone().unwrap_or_default(),
        follower.oss_secret.clone().unwrap_or_default(),
        follower.shop.oss_bucket.clone().unwrap_or_default(),
        follower.shop.oss_endpoint.clone().unwrap_or_default(),
        follower.shop.oss_public_domain.clone().unwrap_or_default(),
    )
}

async fn load_full_product(client: &OzonSellerClient, offer_id: &str) -> Result<Value> {
    let info = client.product_info(vec![offer_id.to_string()]).await?;
    let mut items = extract_items(&info);
    let mut product = items
        .pop()
        .ok_or_else(|| anyhow::anyhow!("主店商品不存在"))?;

    let attrs = client
        .product_attributes(vec![offer_id.to_string()])
        .await?;
    if let Some(attr) = extract_items(&attrs).into_iter().next() {
        merge_objects(&mut product, attr);
    }

    if let Ok(description) = client.product_description(offer_id.to_string()).await {
        if let Some(item) = description
            .get("result")
            .cloned()
            .or_else(|| Some(description.clone()))
            .filter(Value::is_object)
        {
            merge_objects(&mut product, item);
        }
    }
    Ok(product)
}

fn merge_objects(base: &mut Value, extra: Value) {
    if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            base.insert(key.clone(), value.clone());
        }
    }
}

fn product_title(fallback: &str, product: &Value) -> String {
    product
        .get("name")
        .or_else(|| product.get("title"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn multiply_price(value: &str, multiplier: f64) -> Result<String> {
    let normalized = value.trim().replace(' ', "").replace(',', ".");
    let parsed = normalized
        .parse::<f64>()
        .with_context(|| format!("价格不是有效数字: {value}"))?;
    if parsed <= 0.0 {
        anyhow::bail!("价格必须大于 0: {value}");
    }
    Ok(format_price(parsed * multiplier))
}

fn format_price(value: f64) -> String {
    let rounded = format!("{value:.2}");
    rounded
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_string()
}

fn scalar_text(value: Option<&Value>) -> Option<String> {
    value.and_then(|value| {
        value
            .as_str()
            .map(str::to_string)
            .or_else(|| value.as_f64().map(|number| number.to_string()))
            .or_else(|| value.as_i64().map(|number| number.to_string()))
            .or_else(|| {
                value.as_object().and_then(|object| {
                    ["value", "amount", "price"]
                        .iter()
                        .find_map(|key| object.get(*key).and_then(|child| scalar_text(Some(child))))
                })
            })
    })
}

fn extract_next_last_id(data: &Value) -> String {
    data.pointer("/result/last_id")
        .or_else(|| data.get("last_id"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn build_action_product_payload(
    product: &Value,
    action_price: Option<&str>,
    action_stock: i64,
) -> Result<Value> {
    let product_id = value_as_i64(
        product
            .get("product_id")
            .or_else(|| product.get("productId"))
            .or_else(|| product.get("id")),
    )
    .context("活动商品缺少 product_id")?;
    let price = action_price
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            scalar_text(
                product
                    .get("action_price")
                    .or_else(|| product.get("actionPrice")),
            )
        })
        .or_else(|| scalar_text(product.get("price")))
        .or_else(|| scalar_text(product.pointer("/price/price")))
        .with_context(|| format!("商品 {product_id} 缺少活动价，请填写统一活动价"))?;

    let mut payload = json!({
        "product_id": product_id,
        "action_price": price,
        "stock": action_stock,
    });
    let discount = value_as_i64(product.get("discount"))
        .map(|value| value.clamp(1, 99))
        .or_else(|| {
            discount_percent(
                scalar_text(
                    product
                        .get("price")
                        .or_else(|| product.pointer("/price/price")),
                )
                .as_deref(),
                &price,
            )
        });
    if let (Some(discount), Some(object)) = (discount, payload.as_object_mut()) {
        object.insert("discount".into(), json!(discount));
    }
    Ok(payload)
}

fn value_as_i64(value: Option<&Value>) -> Option<i64> {
    value.and_then(|value| {
        value.as_i64().or_else(|| {
            value
                .as_str()
                .and_then(|text| text.trim().parse::<i64>().ok())
        })
    })
}

fn money_number(value: &str) -> Option<f64> {
    let normalized = value.trim().replace(' ', "").replace(',', ".");
    let parsed = normalized.parse::<f64>().ok()?;
    (parsed > 0.0).then_some(parsed)
}

fn discount_percent(base_price: Option<&str>, action_price: &str) -> Option<i64> {
    let base = money_number(base_price?)?;
    let action = money_number(action_price)?;
    if action >= base {
        return None;
    }
    Some((((base - action) / base) * 100.0).round().clamp(1.0, 99.0) as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multiplies_prices_by_three() {
        assert_eq!(
            multiply_price("10", DEFAULT_FOLLOW_PRICE_MULTIPLIER).unwrap(),
            "30"
        );
        assert_eq!(
            multiply_price("10.50", DEFAULT_FOLLOW_PRICE_MULTIPLIER).unwrap(),
            "31.5"
        );
        assert_eq!(
            multiply_price("10,25", DEFAULT_FOLLOW_PRICE_MULTIPLIER).unwrap(),
            "30.75"
        );
    }

    #[test]
    fn multiplies_prices_by_custom_multiplier() {
        assert_eq!(multiply_price("10", 2.0).unwrap(), "20");
        assert_eq!(multiply_price("10", 10.0).unwrap(), "100");
        assert_eq!(multiply_price("10.50", 2.5).unwrap(), "26.25");
    }

    #[test]
    fn empty_watermark_allows_direct_image_link_reuse() {
        let shop = test_shop(None);
        assert!(shop_watermark_path(&shop).unwrap().is_none());
    }

    fn test_shop(watermark_path: Option<String>) -> Shop {
        Shop {
            id: "shop-id".into(),
            name: "跟卖店".into(),
            client_id: "client-id".into(),
            api_key_stored: true,
            oss_access_key_id: None,
            oss_access_key_stored: false,
            oss_bucket: None,
            oss_endpoint: None,
            oss_public_domain: None,
            watermark_path,
            shop_role: Some("follower".into()),
            follows_shop_id: Some("main-id".into()),
            follow_warehouse_id: None,
            ozon_seller_cookie_stored: false,
            api_key_plain: None,
            oss_secret_plain: None,
            enabled: true,
            created_at: "2026-06-24T00:00:00Z".into(),
            updated_at: "2026-06-24T00:00:00Z".into(),
        }
    }
}
