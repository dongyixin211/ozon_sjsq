use crate::core::business::{
    self, build_oss_object_key, extract_image_urls, extract_task_id, list_sku_images,
};
use crate::core::excel::{
    read_content_rows, write_batch_results, write_status_to_source_excel, BatchResultRow,
    ContentRow,
};
use crate::core::jobs::JobRegistry;
use crate::core::models::{
    AttributeDictionaryValue, BatchUploadRequest, ImportPreviewInput, JobStatus,
    ListedUpdateRequest, Shop,
};
use crate::core::oss::AliyunOssClient;
use crate::core::ozon::{extract_items, OzonSellerClient};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::time::{sleep, Duration};

#[derive(Clone)]
pub struct RuntimeShopConfig {
    pub shop: Shop,
    pub ozon_api_key: String,
    pub oss_secret: Option<String>,
}

#[derive(Clone, Default)]
struct ColorDictionaryResolver {
    options: Vec<AttributeDictionaryValue>,
}

pub async fn run_batch_upload(
    jobs: JobRegistry,
    job_id: String,
    request: BatchUploadRequest,
    shops: Vec<RuntimeShopConfig>,
) {
    if let Err(error) = batch_upload_inner(&jobs, &job_id, request, shops).await {
        jobs.log(&job_id, "error", &error.to_string());
        jobs.fail(&job_id, error.to_string());
    }
}

pub async fn run_listed_update(
    jobs: JobRegistry,
    job_id: String,
    request: ListedUpdateRequest,
    shop: RuntimeShopConfig,
) {
    if let Err(error) = listed_update_inner(&jobs, &job_id, request, shop).await {
        jobs.log(&job_id, "error", &error.to_string());
        jobs.fail(&job_id, error.to_string());
    }
}

async fn batch_upload_inner(
    jobs: &JobRegistry,
    job_id: &str,
    request: BatchUploadRequest,
    shops: Vec<RuntimeShopConfig>,
) -> Result<()> {
    jobs.update(job_id, JobStatus::Running, 1, None);
    let portrait_root = PathBuf::from(&request.portrait_root);
    let excel_path = PathBuf::from(&request.excel_path);
    if !portrait_root.is_dir() {
        anyhow::bail!("3:4 输出目录不存在: {}", portrait_root.display());
    }
    if !excel_path.is_file() {
        anyhow::bail!("Excel 文件不存在: {}", excel_path.display());
    }
    let mut rows = read_content_rows(&excel_path)?;
    if let Some(max_items) = request.max_items.filter(|value| *value > 0) {
        rows.truncate(max_items as usize);
    }
    if rows.is_empty() {
        anyhow::bail!("Excel 没有可处理的货号");
    }
    jobs.log(job_id, "info", &format!("读取 Excel {} 个货号", rows.len()));

    let total = rows.len() * shops.len();
    let mut done = 0usize;
    let mut results = Vec::new();
    for runtime in shops {
        if jobs.is_cancelled(job_id) {
            jobs.log(job_id, "warn", "批量上架已取消");
            return Ok(());
        }
        jobs.log(job_id, "info", &format!("开始店铺: {}", runtime.shop.name));
        let ozon =
            OzonSellerClient::new(runtime.shop.client_id.clone(), runtime.ozon_api_key.clone())?;
        let oss = oss_client(&runtime)?;
        let color_resolver = load_color_dictionary_resolver(&ozon, request.template_product.as_ref())
            .await
            .unwrap_or_default();
        for row in &rows {
            if jobs.is_cancelled(job_id) {
                jobs.log(job_id, "warn", "批量上架已取消");
                return Ok(());
            }
            done += 1;
            let result = match process_upload_row(
                jobs,
                job_id,
                &ozon,
                &oss,
                &runtime.shop.client_id,
                &portrait_root,
                &request,
                &color_resolver,
                row,
            )
            .await
            {
                Ok(result) => result,
                Err(error) => result_row(row, 0, "失败", "", "", "", &error.to_string()),
            };
            results.push(result);
            let progress = ((done * 100) / total.max(1)).clamp(1, 99) as u8;
            jobs.update(job_id, JobStatus::Running, progress, None);
        }
    }
    let result_path = portrait_root.join("batch_upload_results.xlsx");
    write_batch_results(&result_path, &results)?;
    write_status_to_source_excel(&excel_path, &results)?;
    jobs.log(
        job_id,
        "info",
        &format!("结果表已保存: {}", result_path.display()),
    );
    jobs.log(
        job_id,
        "info",
        &format!("上传状态已写回: {}", excel_path.display()),
    );
    let success_count = results.iter().filter(|row| row.status == "已提交").count();
    let failed_count = results
        .iter()
        .filter(|row| row.status == "失败" || row.status == "跳过")
        .count();
    jobs.complete_with_result(
        job_id,
        Some(result_path.display().to_string()),
        success_count,
        failed_count,
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn process_upload_row(
    jobs: &JobRegistry,
    job_id: &str,
    ozon: &OzonSellerClient,
    oss: &AliyunOssClient,
    client_id: &str,
    portrait_root: &Path,
    request: &BatchUploadRequest,
    color_resolver: &ColorDictionaryResolver,
    row: &ContentRow,
) -> Result<BatchResultRow> {
    let template_product = request.template_product.clone().unwrap_or_default();
    let description = business::extract_template_description(&template_product);
    if row.title.trim().is_empty() {
        jobs.log(job_id, "warn", &format!("跳过 {}: 标题为空", row.sku));
        return Ok(result_row(row, 0, "跳过", "", "", "", "标题为空"));
    }
    let sku_folder = portrait_root.join(&row.sku);
    let images =
        list_sku_images(&sku_folder).with_context(|| format!("读取 {} 图片失败", row.sku))?;
    if images.is_empty() {
        jobs.log(job_id, "warn", &format!("跳过 {}: 未找到图片", row.sku));
        return Ok(result_row(row, 0, "跳过", "", "", "", "未找到图片"));
    }
    let image_count = images.len();

    let exists = product_exists(ozon, &row.sku).await?;
    if exists {
        jobs.log(
            job_id,
            "warn",
            &format!("跳过 {}: Ozon 已存在相同货号", row.sku),
        );
        return Ok(result_row(
            row,
            image_count,
            "已存在",
            "",
            "",
            "",
            "Ozon 已存在相同货号",
        ));
    }

    let mut image_urls = Vec::new();
    let oss_folder = business::build_oss_folder(client_id, &row.sku)?;
    for image in images {
        let filename = image
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("image.jpg");
        let object_key = build_oss_object_key(client_id, &row.sku, filename)?;
        jobs.log(
            job_id,
            "info",
            &format!("{} 上传 OSS: {}", row.sku, object_key),
        );
        image_urls.push(oss.upload_file(&image, &object_key).await?);
    }
    let uploaded_image_count = image_urls.len();
    let resolved_product_color_values =
        resolve_product_color_values(color_resolver, &row.product_color, &row.color_name);
    let item = business::build_import_item(ImportPreviewInput {
        template_product,
        offer_id: row.sku.clone(),
        title: row.title.clone(),
        product_color: row.product_color.clone(),
        product_color_dictionary_values: resolved_product_color_values,
        color_name: row.color_name.clone(),
        description,
        image_urls,
        video_links: if request.upload_template_video {
            clean_links(&request.template_video_links)
        } else {
            Vec::new()
        },
        rich_json: if row.rich_json.trim().is_empty() {
            None
        } else {
            Some(row.rich_json.clone())
        },
    });
    let response = ozon.import_products(vec![item]).await?;
    let task_id = extract_task_id(&response).unwrap_or_default();
    jobs.log(
        job_id,
        "info",
        &format!(
            "{} 已提交 Ozon，task_id: {}",
            row.sku,
            if task_id.is_empty() {
                "[未返回]"
            } else {
                &task_id
            }
        ),
    );
    let post_process_errors = if request.auto_generate_barcode
        || request.auto_update_stock
        || request.auto_add_to_action
    {
        match wait_for_product_id(ozon, &row.sku).await {
            Ok(product_id) => {
                run_upload_post_process(jobs, job_id, ozon, request, &row.sku, product_id).await
            }
            Err(error) => vec![format!("等待商品上架完成失败：{error}")],
        }
    } else {
        Vec::new()
    };
    for error in &post_process_errors {
        jobs.log(job_id, "warn", &format!("{} {error}", row.sku));
    }
    Ok(result_row(
        row,
        uploaded_image_count,
        "已提交",
        &row.sku,
        &task_id,
        &oss_folder,
        &post_process_errors.join("；"),
    ))
}

async fn wait_for_product_id(ozon: &OzonSellerClient, offer_id: &str) -> Result<i64> {
    let mut last_error = None;
    for _ in 0..40 {
        match ozon.product_info(vec![offer_id.to_string()]).await {
            Ok(data) => {
                if let Some(product_id) = extract_items(&data)
                    .first()
                    .and_then(|item| item.get("product_id").or_else(|| item.get("id")))
                    .and_then(value_as_i64)
                {
                    return Ok(product_id);
                }
            }
            Err(error) => last_error = Some(error),
        }
        sleep(Duration::from_secs(3)).await;
    }
    match last_error {
        Some(error) => Err(error).context("两分钟内未获取到商品 ID"),
        None => anyhow::bail!("两分钟内未获取到商品 ID"),
    }
}

async fn run_upload_post_process(
    jobs: &JobRegistry,
    job_id: &str,
    ozon: &OzonSellerClient,
    request: &BatchUploadRequest,
    offer_id: &str,
    product_id: i64,
) -> Vec<String> {
    let mut errors = Vec::new();

    if request.auto_generate_barcode {
        match retry_generate_barcode(ozon, product_id).await {
            Ok(_) => jobs.log(job_id, "info", &format!("{offer_id} 已自动生成条码")),
            Err(error) => errors.push(format!("自动生成条码失败：{error}")),
        }
    }

    if request.auto_update_stock {
        let warehouse_id = request.auto_warehouse_id.unwrap_or_default();
        let stock = request.auto_stock.unwrap_or_default();
        match retry_update_stock(ozon, product_id, warehouse_id, stock).await {
            Ok(_) => jobs.log(
                job_id,
                "info",
                &format!("{offer_id} 已自动补库存 {stock}"),
            ),
            Err(error) => errors.push(format!("自动补库存失败：{error}")),
        }
    }

    if request.auto_add_to_action {
        let action_id = request.auto_action_id.unwrap_or_default();
        let action_stock = request.auto_action_stock.unwrap_or(10);
        match retry_add_to_action(
            ozon,
            action_id,
            product_id,
            request.auto_action_price.as_deref(),
            action_stock,
        )
        .await
        {
            Ok(_) => jobs.log(
                job_id,
                "info",
                &format!("{offer_id} 已自动加入活动 {action_id}"),
            ),
            Err(error) => errors.push(format!("自动加入活动失败：{error}")),
        }
    }

    errors
}

async fn retry_generate_barcode(ozon: &OzonSellerClient, product_id: i64) -> Result<Value> {
    let mut last_error = None;
    for _ in 0..5 {
        match ozon.generate_barcodes(vec![product_id]).await {
            Ok(data) => return Ok(data),
            Err(error) => last_error = Some(error),
        }
        sleep(Duration::from_secs(3)).await;
    }
    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("Ozon 未返回结果")))
}

async fn retry_update_stock(
    ozon: &OzonSellerClient,
    product_id: i64,
    warehouse_id: i64,
    stock: i64,
) -> Result<Value> {
    let mut last_error = None;
    for _ in 0..8 {
        match ozon
            .update_stocks(vec![json!({
                "product_id": product_id,
                "warehouse_id": warehouse_id,
                "stock": stock
            })])
            .await
        {
            Ok(data) => return Ok(data),
            Err(error) => last_error = Some(error),
        }
        sleep(Duration::from_secs(3)).await;
    }
    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("Ozon 未返回结果")))
}

async fn retry_add_to_action(
    ozon: &OzonSellerClient,
    action_id: i64,
    product_id: i64,
    configured_price: Option<&str>,
    stock: i64,
) -> Result<Value> {
    let configured_price = configured_price.unwrap_or_default().trim();
    let mut last_error = None;
    for _ in 0..8 {
        let candidate = if configured_price.is_empty() {
            match find_action_candidate(ozon, action_id, product_id).await {
                Ok(candidate) => candidate,
                Err(error) => {
                    last_error = Some(error);
                    sleep(Duration::from_secs(3)).await;
                    continue;
                }
            }
        } else {
            None
        };
        let action_price = if !configured_price.is_empty() {
            configured_price.to_string()
        } else if let Some(price) = candidate.as_ref().and_then(candidate_action_price) {
            price
        } else {
            last_error = Some(anyhow::anyhow!("活动暂未返回该商品或建议活动价"));
            sleep(Duration::from_secs(3)).await;
            continue;
        };
        let discount = candidate
            .as_ref()
            .and_then(|item| candidate_discount(item, &action_price));
        let mut payload = json!({
            "product_id": product_id,
            "action_price": action_price,
            "stock": stock
        });
        if let Some(discount) = discount {
            payload["discount"] = json!(discount);
        }
        match ozon
            .activate_action_products(action_id, vec![payload])
            .await
        {
            Ok(data) => return Ok(data),
            Err(error) => last_error = Some(error),
        }
        sleep(Duration::from_secs(3)).await;
    }
    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("Ozon 未返回结果")))
}

async fn find_action_candidate(
    ozon: &OzonSellerClient,
    action_id: i64,
    product_id: i64,
) -> Result<Option<Value>> {
    let mut last_id = String::new();
    for _ in 0..20 {
        let data = ozon
            .action_candidates(action_id, 1000, last_id.clone())
            .await?;
        if let Some(candidate) = extract_items(&data).into_iter().find(|item| {
            item.get("product_id")
                .or_else(|| item.get("productId"))
                .or_else(|| item.get("id"))
                .and_then(value_as_i64)
                == Some(product_id)
        }) {
            return Ok(Some(candidate));
        }
        let next_last_id = data
            .pointer("/result/last_id")
            .or_else(|| data.get("last_id"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if next_last_id.is_empty() || next_last_id == last_id {
            break;
        }
        last_id = next_last_id;
    }
    Ok(None)
}

fn candidate_action_price(item: &Value) -> Option<String> {
    [
        "action_price",
        "max_action_price",
        "min_action_price",
        "price",
    ]
    .iter()
    .find_map(|key| item.get(*key).and_then(scalar_text))
}

fn candidate_discount(item: &Value, action_price: &str) -> Option<i64> {
    if let Some(discount) = item
        .get("discount")
        .or_else(|| item.get("discount_percent"))
        .and_then(value_as_i64)
    {
        return Some(discount.clamp(1, 99));
    }
    let base_price = item.get("price").and_then(scalar_text)?.parse::<f64>().ok()?;
    let action_price = action_price.parse::<f64>().ok()?;
    if base_price <= 0.0 || action_price <= 0.0 || action_price >= base_price {
        return None;
    }
    Some(
        ((((base_price - action_price) / base_price) * 100.0).round() as i64).clamp(1, 99),
    )
}

fn scalar_text(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(|text| text.replace(' ', "").replace(',', "."))
        .or_else(|| value.as_f64().map(|number| number.to_string()))
        .or_else(|| value.as_i64().map(|number| number.to_string()))
        .or_else(|| {
            value.as_object().and_then(|object| {
                ["value", "amount", "price"]
                    .iter()
                    .find_map(|key| object.get(*key).and_then(scalar_text))
            })
        })
}

fn value_as_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|text| text.parse::<i64>().ok()))
}

async fn listed_update_inner(
    jobs: &JobRegistry,
    job_id: &str,
    request: ListedUpdateRequest,
    runtime: RuntimeShopConfig,
) -> Result<()> {
    jobs.update(job_id, JobStatus::Running, 1, None);
    let portrait_root = PathBuf::from(&request.portrait_root);
    let excel_path = PathBuf::from(&request.excel_path);
    let mut rows = read_content_rows(&excel_path)?;
    if let Some(max_items) = request.max_items.filter(|value| *value > 0) {
        rows.truncate(max_items as usize);
    }
    let ozon = OzonSellerClient::new(runtime.shop.client_id.clone(), runtime.ozon_api_key.clone())?;
    let oss = if request.update_images {
        Some(oss_client(&runtime)?)
    } else {
        None
    };
    let mut results = Vec::new();
    let mut color_resolver_cache = HashMap::new();

    for (index, row) in rows.iter().enumerate() {
        if jobs.is_cancelled(job_id) {
            jobs.log(job_id, "warn", "已上架更新已取消");
            return Ok(());
        }
        let listed = match load_listed_product(&ozon, &row.sku).await {
            Ok(value) => value,
            Err(error) => {
                results.push(result_row(row, 0, "失败", "", "", "", &error.to_string()));
                continue;
            }
        };
        let image_urls = if request.update_images {
            let oss = oss.as_ref().context("缺少 OSS 配置")?;
            match upload_sku_images(
                jobs,
                job_id,
                oss,
                &runtime.shop.client_id,
                &portrait_root,
                &row.sku,
            )
            .await
            {
                Ok(urls) => urls,
                Err(error) => {
                    results.push(result_row(row, 0, "失败", "", "", "", &error.to_string()));
                    continue;
                }
            }
        } else {
            extract_image_urls(&listed)
        };
        if image_urls.is_empty() {
            results.push(result_row(row, 0, "失败", "", "", "", "没有可用图片 URL"));
            continue;
        }
        let source_product = listed.clone();
        let template_product = request.template_product.clone().unwrap_or(listed);
        let color_cache_key = color_cache_key(&template_product);
        if let std::collections::hash_map::Entry::Vacant(entry) =
            color_resolver_cache.entry(color_cache_key.clone())
        {
            let resolver = load_color_dictionary_resolver(&ozon, Some(&template_product))
                .await
                .unwrap_or_default();
            entry.insert(resolver);
        }
        let color_resolver = color_resolver_cache
            .get(&color_cache_key)
            .cloned()
            .unwrap_or_default();
        let description_source = if request.template_product.is_some() {
            &template_product
        } else {
            &source_product
        };
        let description = if request.update_description {
            business::content_description(&row.description, description_source)
        } else {
            listed_description(&source_product)
        };
        let uploaded_image_count = image_urls.len();
        let resolved_product_color_values =
            resolve_product_color_values(&color_resolver, &row.product_color, &row.color_name);
        let item = business::build_import_item(ImportPreviewInput {
            template_product,
            offer_id: row.sku.clone(),
            title: if request.update_title {
                row.title.clone()
            } else {
                listed_title(&row.sku, &source_product)
            },
            product_color: row.product_color.clone(),
            product_color_dictionary_values: resolved_product_color_values,
            color_name: row.color_name.clone(),
            description,
            image_urls,
            video_links: if request.update_video {
                clean_links(&request.template_video_links)
            } else {
                Vec::new()
            },
            rich_json: if request.update_rich_json && !row.rich_json.trim().is_empty() {
                Some(row.rich_json.clone())
            } else {
                None
            },
        });
        let response = match ozon.import_products(vec![item]).await {
            Ok(value) => value,
            Err(error) => {
                results.push(result_row(
                    row,
                    uploaded_image_count,
                    "失败",
                    "",
                    "",
                    "",
                    &error.to_string(),
                ));
                continue;
            }
        };
        let task_id = extract_task_id(&response).unwrap_or_default();
        jobs.log(
            job_id,
            "info",
            &format!(
                "{} 更新已提交，task_id: {}",
                row.sku,
                if task_id.is_empty() {
                    "[未返回]"
                } else {
                    &task_id
                }
            ),
        );
        results.push(result_row(
            row,
            uploaded_image_count,
            "已提交",
            &row.sku,
            &task_id,
            "",
            "",
        ));
        let progress = (((index + 1) * 100) / rows.len().max(1)).clamp(1, 99) as u8;
        jobs.update(job_id, JobStatus::Running, progress, None);
    }
    let result_path = PathBuf::from(&request.portrait_root).join("listed_update_results.xlsx");
    write_batch_results(&result_path, &results)?;
    write_status_to_source_excel(&excel_path, &results)?;
    jobs.log(
        job_id,
        "info",
        &format!("结果表已保存: {}", result_path.display()),
    );
    jobs.log(
        job_id,
        "info",
        &format!("更新状态已写回: {}", excel_path.display()),
    );
    let success_count = results.iter().filter(|row| row.status == "已提交").count();
    let failed_count = results
        .iter()
        .filter(|row| row.status == "失败" || row.status == "跳过")
        .count();
    jobs.complete_with_result(
        job_id,
        Some(result_path.display().to_string()),
        success_count,
        failed_count,
    );
    Ok(())
}

async fn upload_sku_images(
    jobs: &JobRegistry,
    job_id: &str,
    oss: &AliyunOssClient,
    client_id: &str,
    portrait_root: &Path,
    sku: &str,
) -> Result<Vec<String>> {
    let images = list_sku_images(&portrait_root.join(sku))?;
    let mut urls = Vec::new();
    for image in images {
        let filename = image
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("image.jpg");
        let object_key = build_oss_object_key(client_id, sku, filename)?;
        jobs.log(job_id, "info", &format!("{sku} 上传 OSS: {object_key}"));
        urls.push(oss.upload_file(&image, &object_key).await?);
    }
    Ok(urls)
}

async fn product_exists(ozon: &OzonSellerClient, offer_id: &str) -> Result<bool> {
    let data = ozon.product_info(vec![offer_id.to_string()]).await?;
    Ok(!extract_items(&data).is_empty())
}

async fn load_listed_product(ozon: &OzonSellerClient, offer_id: &str) -> Result<Value> {
    let info = ozon.product_info(vec![offer_id.to_string()]).await?;
    let mut items = extract_items(&info);
    let mut product = items
        .pop()
        .ok_or_else(|| anyhow::anyhow!("Ozon 上不存在货号: {offer_id}"))?;
    let attrs = ozon.product_attributes(vec![offer_id.to_string()]).await?;
    if let Some(attr) = extract_items(&attrs).into_iter().next() {
        merge_objects(&mut product, attr);
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

fn listed_title(fallback: &str, product: &Value) -> String {
    product
        .get("name")
        .or_else(|| product.get("title"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn listed_description(product: &Value) -> String {
    business::extract_template_description(product)
}

async fn load_color_dictionary_resolver(
    ozon: &OzonSellerClient,
    product: Option<&Value>,
) -> Result<ColorDictionaryResolver> {
    let Some((description_category_id, type_id)) = product_category_type(product) else {
        return Ok(ColorDictionaryResolver::default());
    };
    let options = ozon
        .attribute_values(description_category_id, type_id, 10096)
        .await?
        .into_iter()
        .filter_map(|item| {
            Some(AttributeDictionaryValue {
                dictionary_value_id: item.get("id")?.as_i64()?,
                value: item.get("value")?.as_str()?.trim().to_string(),
            })
        })
        .filter(|item| !item.value.is_empty())
        .collect();
    Ok(ColorDictionaryResolver { options })
}

fn product_category_type(product: Option<&Value>) -> Option<(i64, i64)> {
    let product = product?;
    Some((
        product
            .get("description_category_id")
            .or_else(|| product.get("category_id"))?
            .as_i64()?,
        product.get("type_id")?.as_i64()?,
    ))
}

fn color_cache_key(product: &Value) -> String {
    match product_category_type(Some(product)) {
        Some((category_id, type_id)) => format!("{category_id}:{type_id}"),
        None => "unknown".into(),
    }
}

fn resolve_product_color_values(
    resolver: &ColorDictionaryResolver,
    product_color: &str,
    color_name: &str,
) -> Vec<AttributeDictionaryValue> {
    if resolver.options.is_empty() {
        return Vec::new();
    }
    let options_by_normalized = resolver
        .options
        .iter()
        .map(|option| (normalize_color_text(&option.value), option))
        .collect::<HashMap<_, _>>();
    let normalized_color_name = normalize_color_text(color_name);
    if let Some(option) = options_by_normalized.get(&normalized_color_name) {
        return vec![(*option).clone()];
    }

    let mut tokens = color_tokens(product_color);
    for token in color_tokens(color_name) {
        if !tokens.contains(&token) {
            tokens.push(token);
        }
    }

    for token in tokens {
        let preferred = preferred_option_name(token);
        let option = options_by_normalized
            .get(&normalize_color_text(preferred))
            .copied()
            .or_else(|| {
                resolver
                    .options
                    .iter()
                    .find(|option| color_tokens(&option.value).contains(&token))
            });
        if let Some(option) = option {
            return vec![option.clone()];
        }
    }

    resolver
        .options
        .iter()
        .find(|option| {
            let option_normalized = normalize_color_text(&option.value);
            normalize_color_text(product_color).contains(&option_normalized)
                || normalize_color_text(color_name).contains(&option_normalized)
        })
        .cloned()
        .into_iter()
        .collect()
}

fn normalize_color_text(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .replace('ё', "е")
        .replace('—', "-")
        .replace('–', "-")
        .replace(' ', "")
}

fn color_tokens(value: &str) -> Vec<&'static str> {
    let normalized = normalize_color_text(value);
    let token_map = [
        ("orange", &["橙", "橘", "оранж", "персик", "коралл", "терракот"][..]),
        ("pink", &["粉", "роз", "пудр", "фукси", "малинов", "фламинго"][..]),
        ("red", &["红", "крас", "бордов", "алый", "вишнев"][..]),
        ("yellow", &["黄", "желт", "лимон", "горч", "золот"][..]),
        ("green", &["绿", "зелен", "олив", "хаки", "мят", "изумруд", "салат"][..]),
        ("blue", &["蓝", "син", "голуб", "лазур", "бирюз", "индиго", "васильк"][..]),
        ("purple", &["紫", "фиолет", "сирен", "лилов", "лаванд", "баклаж"][..]),
        ("brown", &["棕", "咖", "корич", "коф", "какао", "мокко", "шоколад", "карамел"][..]),
        ("gray", &["灰", "сер", "графит", "антрацит", "металлик", "серебр"][..]),
        ("black", &["黑", "черн"][..]),
        ("white", &["白", "бел", "молоч", "айвори", "слоноваякость", "кремово-бел"][..]),
        ("beige", &["米", "беж", "крем", "песоч", "телес", "нюдов"][..]),
        ("gold", &["金", "gold", "золот", "шампань", "розовозолот", "золотист"][..]),
        ("silver", &["银", "silver", "серебр", "хром", "зеркал"][..]),
        ("multicolor", &["混", "多色", "разноцвет"][..]),
    ];
    let mut tokens = Vec::new();
    for (token, needles) in token_map {
        if needles.iter().any(|needle| normalized.contains(needle)) {
            tokens.push(token);
        }
    }
    tokens
}

fn preferred_option_name(token: &str) -> &'static str {
    match token {
        "orange" => "оранжевый",
        "pink" => "розовый",
        "red" => "красный",
        "yellow" => "желтый",
        "green" => "зеленый",
        "blue" => "синий",
        "purple" => "фиолетовый",
        "brown" => "коричневый",
        "gray" => "серый",
        "black" => "черный",
        "white" => "белый",
        "beige" => "бежевый",
        "gold" => "золотой",
        "silver" => "серебристый",
        "multicolor" => "разноцветный",
        _ => "",
    }
}

fn oss_client(runtime: &RuntimeShopConfig) -> Result<AliyunOssClient> {
    AliyunOssClient::new(
        runtime.shop.oss_access_key_id.clone().unwrap_or_default(),
        runtime.oss_secret.clone().unwrap_or_default(),
        runtime.shop.oss_bucket.clone().unwrap_or_default(),
        runtime.shop.oss_endpoint.clone().unwrap_or_default(),
        runtime.shop.oss_public_domain.clone().unwrap_or_default(),
    )
}

fn clean_links(values: &[String]) -> Vec<String> {
    values
        .iter()
        .map(|value| value.trim().to_string())
        .filter(|value| value.starts_with("http://") || value.starts_with("https://"))
        .collect()
}

fn result_row(
    row: &ContentRow,
    image_count: usize,
    status: &str,
    uploaded_sku: &str,
    task_id: &str,
    oss_folder: &str,
    error: &str,
) -> BatchResultRow {
    BatchResultRow {
        sku: row.sku.clone(),
        title: row.title.clone(),
        image_count,
        status: status.into(),
        uploaded_sku: uploaded_sku.into(),
        task_id: task_id.into(),
        oss_folder: oss_folder.into(),
        error: error.into(),
    }
}
