use crate::core::business::{
    self, build_oss_object_key, extract_image_urls, extract_task_id, list_sku_images,
};
use crate::core::excel::{
    read_content_rows, write_batch_results, write_status_to_source_excel, BatchResultRow,
    ContentRow,
};
use crate::core::jobs::JobRegistry;
use crate::core::models::{
    BatchUploadRequest, ImportPreviewInput, JobStatus, ListedUpdateRequest, Shop,
};
use crate::core::oss::AliyunOssClient;
use crate::core::ozon::{extract_items, OzonSellerClient};
use anyhow::{Context, Result};
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub struct RuntimeShopConfig {
    pub shop: Shop,
    pub ozon_api_key: String,
    pub oss_secret: Option<String>,
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

async fn process_upload_row(
    jobs: &JobRegistry,
    job_id: &str,
    ozon: &OzonSellerClient,
    oss: &AliyunOssClient,
    client_id: &str,
    portrait_root: &Path,
    request: &BatchUploadRequest,
    row: &ContentRow,
) -> Result<BatchResultRow> {
    if row.title.trim().is_empty() || row.description.trim().is_empty() {
        jobs.log(job_id, "warn", &format!("跳过 {}: 标题或简介为空", row.sku));
        return Ok(result_row(row, 0, "跳过", "", "", "", "标题或简介为空"));
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
    let item = business::build_import_item(ImportPreviewInput {
        template_product: request.template_product.clone().unwrap_or_default(),
        offer_id: row.sku.clone(),
        title: row.title.clone(),
        description: row.description.clone(),
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
    Ok(result_row(
        row,
        uploaded_image_count,
        "已提交",
        &row.sku,
        &task_id,
        &oss_folder,
        "",
    ))
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
        let uploaded_image_count = image_urls.len();
        let item = business::build_import_item(ImportPreviewInput {
            template_product,
            offer_id: row.sku.clone(),
            title: if request.update_title {
                row.title.clone()
            } else {
                listed_title(&row.sku, &source_product)
            },
            description: if request.update_description {
                row.description.clone()
            } else {
                listed_description(&source_product)
            },
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
    if let Some(text) = product.get("description").and_then(Value::as_str) {
        return text.to_string();
    }
    product
        .get("attributes")
        .and_then(Value::as_array)
        .and_then(|attrs| {
            attrs.iter().find_map(|attr| {
                let attr_id = attr
                    .get("id")
                    .or_else(|| attr.get("attribute_id"))
                    .and_then(Value::as_i64);
                let name = attr
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_lowercase();
                if attr_id != Some(4191)
                    && !name.contains("description")
                    && !name.contains("описание")
                    && !name.contains("描述")
                {
                    return None;
                }
                attr.get("values")
                    .and_then(Value::as_array)
                    .and_then(|values| values.first())
                    .and_then(|value| value.get("value").or_else(|| value.get("text")))
                    .and_then(Value::as_str)
            })
        })
        .unwrap_or_default()
        .to_string()
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
