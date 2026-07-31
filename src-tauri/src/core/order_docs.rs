use crate::core::baidu_pan::{self, BaiduPanOptions};
use crate::core::db::Database;
use crate::core::jobs::JobRegistry;
use crate::core::models::{JobStatus, OrderDocumentsRequest, OrderShippingLabelDownloadRequest};
use crate::core::ozon::OzonSellerClient;
use crate::core::ozon_seller_web::{self, OzonSellerWebClient};
use anyhow::{Context, Result};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::fs;
use url::Url;

pub async fn run_order_documents_job(
    jobs: JobRegistry,
    job_id: String,
    request: OrderDocumentsRequest,
    client: OzonSellerClient,
    db_path: PathBuf,
) {
    jobs.update(&job_id, JobStatus::Running, 3, None);
    jobs.log(&job_id, "info", "订单文件下载任务已开始。");

    let result = run_inner(&jobs, &job_id, request, client, db_path).await;
    match result {
        Ok((output_root, success_count, failed_count)) => {
            jobs.log(
                &job_id,
                "info",
                &format!("任务完成：成功 {success_count} 个，失败 {failed_count} 个。"),
            );
            jobs.complete_with_result(&job_id, Some(output_root), success_count, failed_count);
        }
        Err(error) => {
            let message = format!("{error:#}");
            jobs.log(&job_id, "error", &message);
            jobs.fail(&job_id, message);
        }
    }
}

pub async fn download_shipping_labels(
    request: &OrderShippingLabelDownloadRequest,
    db_path: PathBuf,
) -> Result<()> {
    if request.assignments.is_empty() {
        anyhow::bail!("请至少提供一个物流贴单地址");
    }
    for assignment in &request.assignments {
        let shop_id = assignment.shop_id.trim();
        let order_number = assignment.order_number.trim();
        let raw_url = assignment.url.trim();
        if shop_id.is_empty() || order_number.is_empty() || raw_url.is_empty() {
            anyhow::bail!("物流贴单分配缺少店铺、订单号或 PDF 地址");
        }
        let parsed = Url::parse(raw_url).context("物流贴单地址格式不正确")?;
        if !matches!(parsed.scheme(), "http" | "https") {
            anyhow::bail!("物流贴单地址只支持 HTTP 或 HTTPS：{}", raw_url);
        }
        if !parsed.path().to_ascii_lowercase().ends_with(".pdf") {
            anyhow::bail!("物流贴单地址必须指向 PDF 文件：{}", raw_url);
        }
    }
    if request.output_root.trim().is_empty() {
        anyhow::bail!("请选择输出目录");
    }
    let output_root = PathBuf::from(request.output_root.trim());
    fs::create_dir_all(&output_root)
        .await
        .with_context(|| format!("创建输出目录失败：{}", output_root.display()))?;

    for assignment in &request.assignments {
        let shop_id = assignment.shop_id.trim();
        let order_number = assignment.order_number.trim();
        let (shop_name, offer_ids) = {
            let db = Database::open_at(db_path.clone())?;
            let shop_name = db.get_shop(shop_id)?.name;
            let offer_ids = db
                .get_saved_order_posting(shop_id, order_number)?
                .map(|posting| posting.offer_ids)
                .unwrap_or_default();
            (shop_name, offer_ids)
        };
        let order_dir = output_root.join(order_download_folder_name(
            &shop_name,
            &offer_ids,
            order_number,
        ));
        fs::create_dir_all(&order_dir)
            .await
            .with_context(|| format!("?????????{}", order_dir.display()))?;
        let pdf = download_shipping_label_pdf(assignment.url.trim()).await?;
        fs::write(order_dir.join("logistics-label.pdf"), pdf)
            .await
            .with_context(|| format!("???? {} ????? PDF ??", order_number))?;
        let db = Database::open_at(db_path.clone())?;
        db.mark_order_shipping_label_downloaded(
            shop_id,
            order_number,
            &order_dir.to_string_lossy(),
        )?;
    }
    Ok(())
}

pub fn validate_request(request: &OrderDocumentsRequest) -> Result<()> {
    let order_numbers = clean_order_numbers(&request.order_numbers);
    if order_numbers.is_empty() {
        anyhow::bail!("请至少输入一个订单/货件编号");
    }
    if let Some(order_number) = order_numbers.iter().find(|order_number| {
        Url::parse(order_number)
            .map(|parsed| matches!(parsed.scheme(), "http" | "https"))
            .unwrap_or(false)
    }) {
        anyhow::bail!("订单/货件编号不能是物流 PDF 地址：{}", order_number);
    }
    if request.output_root.trim().is_empty() {
        anyhow::bail!("请选择输出目录");
    }
    seller_web_client(request)?;
    if request.download_materials {
        let cookie = request
            .baidu_cookie
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("请先填写百度网盘 Cookie")?;
        baidu_pan::validate_cookie(cookie)?;
    }
    validate_shipping_labels(request)?;
    Ok(())
}

async fn run_inner(
    jobs: &JobRegistry,
    job_id: &str,
    request: OrderDocumentsRequest,
    client: OzonSellerClient,
    db_path: PathBuf,
) -> Result<(String, usize, usize)> {
    validate_request(&request)?;
    let order_numbers = clean_order_numbers(&request.order_numbers);
    let output_root = PathBuf::from(request.output_root.trim());
    let shop_name = Database::open_at(db_path.clone())?
        .get_shop(&request.shop_id)?
        .name;
    fs::create_dir_all(&output_root)
        .await
        .with_context(|| format!("创建输出目录失败：{}", output_root.display()))?;

    let mut success_count = 0;
    let mut failed_count = 0;
    let total = order_numbers.len().max(1);

    for (index, order_ref) in order_numbers.iter().enumerate() {
        if jobs.is_cancelled(job_id) {
            jobs.log(job_id, "warn", "任务已取消。");
            jobs.update(job_id, JobStatus::Cancelled, 100, None);
            break;
        }

        let progress = 5 + ((index as f32 / total as f32) * 90.0).round() as u8;
        jobs.update(job_id, JobStatus::Running, progress, None);
        jobs.log(job_id, "info", &format!("处理 {order_ref}"));

        match process_order_ref(
            jobs,
            job_id,
            &request,
            &client,
            &output_root,
            &shop_name,
            order_ref,
        )
        .await
        {
            Ok((posting_numbers, order_dir)) => {
                let db = Database::open_at(db_path.clone())?;
                db.mark_order_postings_downloaded(
                    &request.shop_id,
                    &posting_numbers,
                    &order_dir.to_string_lossy(),
                )?;
                if request
                    .shipping_labels
                    .iter()
                    .any(|label| label.order_number.trim() == order_ref)
                {
                    db.mark_order_shipping_label_downloaded(
                        &request.shop_id,
                        order_ref,
                        &order_dir.to_string_lossy(),
                    )?;
                }
                success_count += 1;
            }
            Err(error) => {
                failed_count += 1;
                jobs.log(job_id, "error", &format!("{order_ref} 失败：{error:#}"));
            }
        }
    }

    Ok((
        output_root.to_string_lossy().to_string(),
        success_count,
        failed_count,
    ))
}

async fn process_order_ref(
    jobs: &JobRegistry,
    job_id: &str,
    request: &OrderDocumentsRequest,
    client: &OzonSellerClient,
    output_root: &Path,
    shop_name: &str,
    order_ref: &str,
) -> Result<(Vec<String>, PathBuf)> {
    let postings = resolve_postings(client, order_ref).await?;
    if postings.is_empty() {
        anyhow::bail!("没有找到对应 Ozon 货件：{order_ref}");
    }
    let posting_numbers = postings
        .iter()
        .filter_map(posting_number_from_posting)
        .collect::<Vec<_>>();
    if posting_numbers.is_empty() {
        anyhow::bail!("Ozon 返回中缺少 posting_number：{order_ref}");
    }

    let products = merged_products(&postings);
    let offer_ids = products
        .iter()
        .filter_map(|item| item.get("offer_id").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    let order_dir = output_root.join(order_download_folder_name(shop_name, &offer_ids, order_ref));
    fs::create_dir_all(&order_dir)
        .await
        .with_context(|| format!("创建订单目录失败：{}", order_dir.display()))?;

    let mut seller_web = seller_web_client(request)?;
    let barcode_pdf = seller_web
        .download_barcode_pdf(&posting_numbers)
        .await
        .context("下载 Ozon 后台条形码 PDF 失败")?;
    fs::write(order_dir.join("ozon-barcodes.pdf"), barcode_pdf)
        .await
        .context("保存 Ozon 条形码 PDF 失败")?;

    let picking_pdf = seller_web
        .download_picking_list_pdf(&posting_numbers)
        .await
        .context("下载 Ozon 后台拣货单 PDF 失败")?;
    fs::write(order_dir.join("picking-list.pdf"), picking_pdf)
        .await
        .context("保存 Ozon 拣货单 PDF 失败")?;

    let label_pdf = seller_web
        .download_label_pdf(&posting_numbers[0])
        .await
        .context("下载 Ozon 后台标签 PDF 失败")?;
    fs::write(order_dir.join("ozon-label.pdf"), label_pdf)
        .await
        .context("保存 Ozon 标签 PDF 失败")?;
    if posting_numbers.len() > 1 {
        for posting_number in posting_numbers.iter().skip(1) {
            let label_pdf = seller_web
                .download_label_pdf(posting_number)
                .await
                .with_context(|| format!("下载 Ozon 后台标签 PDF 失败：{posting_number}"))?;
            fs::write(
                order_dir.join(format!("ozon-label-{}.pdf", safe_file_name(posting_number))),
                label_pdf,
            )
            .await
            .with_context(|| format!("保存 Ozon 标签 PDF 失败：{posting_number}"))?;
        }
    }

    let shipping_label_url = request
        .shipping_labels
        .iter()
        .find(|item| item.order_number.trim() == order_ref)
        .map(|item| item.url.trim())
        .context("当前订单缺少物流贴单 PDF 地址")?;
    let shipping_label_pdf = download_shipping_label_pdf(shipping_label_url).await?;
    fs::write(order_dir.join("logistics-label.pdf"), shipping_label_pdf)
        .await
        .context("保存物流贴单 PDF 失败")?;

    if request.download_materials && offer_ids.is_empty() {
        anyhow::bail!("订单商品没有返回货号 offer_id，无法下载百度网盘素材");
    }

    if request.download_materials {
        let result = download_baidu_materials(request, &order_dir, &offer_ids)
            .await
            .context("百度网盘素材下载失败")?;
        jobs.log(
            job_id,
            "info",
            &format!(
                "{order_ref} 百度网盘：成功 {}，跳过 {}，失败 {}，共 {}",
                result.succeeded, result.skipped, result.failed, result.total
            ),
        );
        ensure_baidu_download_complete(&result, offer_ids.len())?;
    }

    Ok((posting_numbers, order_dir))
}

fn validate_shipping_labels(request: &OrderDocumentsRequest) -> Result<()> {
    let order_numbers = clean_order_numbers(&request.order_numbers);
    if request.shipping_labels.len() != order_numbers.len() {
        anyhow::bail!(
            "物流贴单地址数量必须与订单数量一致：订单 {} 个，地址 {} 个",
            order_numbers.len(),
            request.shipping_labels.len()
        );
    }
    let order_set = order_numbers.iter().cloned().collect::<BTreeSet<_>>();
    let mut labels_by_order = BTreeMap::new();
    let mut urls = BTreeSet::new();
    for label in &request.shipping_labels {
        let order_number = label.order_number.trim();
        let raw_url = label.url.trim();
        if !order_set.contains(order_number) {
            anyhow::bail!("物流贴单对应了当前任务之外的订单：{}", order_number);
        }
        if labels_by_order
            .insert(order_number.to_string(), raw_url.to_string())
            .is_some()
        {
            anyhow::bail!("订单 {} 重复分配了物流贴单", order_number);
        }
        if !urls.insert(raw_url.to_string()) {
            anyhow::bail!("同一个物流贴单地址不能重复使用：{}", raw_url);
        }
        let parsed = Url::parse(raw_url).context("物流贴单地址格式不正确")?;
        if !matches!(parsed.scheme(), "http" | "https") {
            anyhow::bail!("物流贴单地址只支持 HTTP 或 HTTPS：{}", raw_url);
        }
        if !parsed.path().to_ascii_lowercase().ends_with(".pdf") {
            anyhow::bail!("物流贴单地址必须指向 PDF 文件：{}", raw_url);
        }
    }
    if labels_by_order.len() != order_set.len() {
        anyhow::bail!("每个订单都必须分配一个不同的物流贴单地址");
    }
    Ok(())
}

async fn download_shipping_label_pdf(url: &str) -> Result<Vec<u8>> {
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .context("创建物流贴单下载客户端失败")?
        .get(url)
        .send()
        .await
        .context("下载物流贴单 PDF 失败")?;
    let status = response.status();
    if !status.is_success() {
        anyhow::bail!("下载物流贴单 PDF 失败：HTTP {}", status);
    }
    let bytes = response.bytes().await.context("读取物流贴单 PDF 失败")?;
    if !bytes.starts_with(b"%PDF-") {
        anyhow::bail!("物流贴单地址返回的内容不是有效 PDF");
    }
    Ok(bytes.to_vec())
}

fn seller_web_client(request: &OrderDocumentsRequest) -> Result<OzonSellerWebClient> {
    let har_path = request
        .ozon_seller_har_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let config = ozon_seller_web::config_from_paths(
        request.ozon_company_id.clone().unwrap_or_default(),
        har_path.as_deref(),
        request.ozon_seller_cookie_path.as_deref(),
    )?;
    OzonSellerWebClient::new(config)
}

async fn resolve_postings(client: &OzonSellerClient, order_ref: &str) -> Result<Vec<Value>> {
    match client.fbs_posting(order_ref).await {
        Ok(data) => Ok(vec![data.get("result").cloned().unwrap_or(data)]),
        Err(direct_error) => {
            let data = client
                .fbs_postings_by_order_ref(order_ref)
                .await
                .with_context(|| {
                    format!(
                        "按 posting_number 和订单编号查询都失败；posting 查询错误：{direct_error}"
                    )
                })?;
            let items = data
                .pointer("/result/postings")
                .or_else(|| data.pointer("/result/items"))
                .or_else(|| data.get("postings"))
                .or_else(|| data.get("items"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            Ok(items)
        }
    }
}

fn posting_number_from_posting(posting: &Value) -> Option<String> {
    posting
        .get("posting_number")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn merged_products(postings: &[Value]) -> Vec<Value> {
    let mut rows = Vec::new();
    for posting in postings {
        let posting_number = posting_number_from_posting(posting).unwrap_or_default();
        if let Some(products) = posting.get("products").and_then(Value::as_array) {
            for product in products {
                let mut product = product.clone();
                if let Some(object) = product.as_object_mut() {
                    object.insert(
                        "posting_number".into(),
                        Value::String(posting_number.clone()),
                    );
                }
                rows.push(product);
            }
        }
    }
    rows
}

async fn download_baidu_materials(
    request: &OrderDocumentsRequest,
    order_dir: &Path,
    offer_ids: &[String],
) -> Result<baidu_pan::BaiduDownloadResult> {
    let cookie = request
        .baidu_cookie
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .context("请先填写百度网盘 Cookie")?
        .to_string();
    let options = BaiduPanOptions {
        cookie,
        search_dir: request
            .baidu_search_dir
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("/")
            .to_string(),
        recursive: request.baidu_recursive,
    };
    baidu_pan::download_images(options, offer_ids, order_dir).await
}

fn clean_order_numbers(order_numbers: &[String]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    order_numbers
        .iter()
        .flat_map(|line| {
            line.split(|ch: char| {
                ch == ',' || ch == '，' || ch == ';' || ch == '；' || ch.is_whitespace()
            })
            .map(str::to_string)
            .collect::<Vec<_>>()
        })
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && seen.insert(value.clone()))
        .collect()
}

fn order_download_folder_name(shop_name: &str, offer_ids: &[String], order_number: &str) -> String {
    let mut unique_offer_ids = Vec::new();
    for offer_id in offer_ids {
        let offer_id = offer_id.trim();
        if !offer_id.is_empty() && !unique_offer_ids.iter().any(|item| item == offer_id) {
            unique_offer_ids.push(offer_id.to_string());
        }
    }
    let offer_part = if unique_offer_ids.is_empty() {
        "未知货号".to_string()
    } else {
        unique_offer_ids
            .iter()
            .map(|offer_id| safe_file_name(offer_id))
            .collect::<Vec<_>>()
            .join("、")
    };
    format!(
        "{}+{}+{}",
        safe_file_name(shop_name),
        offer_part,
        safe_file_name(order_number)
    )
}

fn safe_file_name(value: &str) -> String {
    let cleaned = value
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => ch,
        })
        .collect::<String>();
    if cleaned.trim().is_empty() {
        "order".to_string()
    } else {
        cleaned
    }
}

fn ensure_baidu_download_complete(
    result: &baidu_pan::BaiduDownloadResult,
    expected_count: usize,
) -> Result<()> {
    if result.failed > 0 {
        anyhow::bail!(
            "百度网盘素材下载失败 {} 个，成功 {} 个，跳过 {} 个，共 {} 个",
            result.failed,
            result.succeeded,
            result.skipped,
            result.total
        );
    }
    if result.total != expected_count {
        anyhow::bail!(
            "百度网盘下载数量不一致：应下载 {} 个，工具汇总 {} 个",
            expected_count,
            result.total
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn order_download_folder_name_formats_shop_offers_and_order() {
        assert_eq!(
            order_download_folder_name("星空店", &["SKU001".into()], "123-1"),
            "星空店+SKU001+123-1"
        );
        assert_eq!(
            order_download_folder_name(
                "星空店",
                &["SKU002".into(), "SKU001".into(), "SKU002".into()],
                "123-2",
            ),
            "星空店+SKU002、SKU001+123-2"
        );
    }

    #[test]
    fn order_download_folder_name_sanitizes_components_and_handles_missing_offers() {
        assert_eq!(
            order_download_folder_name("店/铺", &["SKU:01".into()], "123?1"),
            "店_铺+SKU_01+123_1"
        );
        assert_eq!(
            order_download_folder_name("星空店", &[], "123-1"),
            "星空店+未知货号+123-1"
        );
    }

    #[test]
    fn cleans_order_numbers_from_pasted_text() {
        let rows = clean_order_numbers(&[" 123-1,123-1 ".into(), "456； 789\n456".into()]);
        assert_eq!(rows, vec!["123-1", "456", "789"]);
    }

    #[test]
    fn merges_products_with_posting_numbers() {
        let postings = vec![
            json!({ "posting_number": "A-1", "products": [{ "offer_id": "SKU1", "quantity": 2 }] }),
            json!({ "posting_number": "A-2", "products": [{ "offer_id": "SKU2", "quantity": 1 }] }),
        ];
        let products = merged_products(&postings);
        assert_eq!(products.len(), 2);
        assert_eq!(products[0]["posting_number"], "A-1");
        assert_eq!(products[1]["offer_id"], "SKU2");
    }

    #[test]
    fn rejects_incomplete_baidu_downloads() {
        let ok = baidu_pan::BaiduDownloadResult {
            succeeded: 2,
            skipped: 1,
            failed: 0,
            total: 3,
        };
        assert!(ensure_baidu_download_complete(&ok, 3).is_ok());

        let failed = baidu_pan::BaiduDownloadResult {
            failed: 1,
            ..ok.clone()
        };
        assert!(ensure_baidu_download_complete(&failed, 3).is_err());
        assert!(ensure_baidu_download_complete(&ok, 4).is_err());
    }

    #[test]
    fn rejects_logistics_url_as_order_number() {
        let mut request = valid_request();
        request.order_numbers =
            vec!["https://youla-gl.ilinexpress.com/gl/TYP_COLLECT_BAG_PDF/label.pdf".into()];
        request.shipping_labels[0].order_number = request.order_numbers[0].clone();

        assert_eq!(
            validate_request(&request).unwrap_err().to_string(),
            "订单/货件编号不能是物流 PDF 地址：https://youla-gl.ilinexpress.com/gl/TYP_COLLECT_BAG_PDF/label.pdf"
        );
    }

    #[test]
    fn validates_order_document_request_before_starting_job() {
        let mut request = valid_request();
        assert!(validate_request(&request).is_ok());

        request.order_numbers.clear();
        assert_eq!(
            validate_request(&request).unwrap_err().to_string(),
            "请至少输入一个订单/货件编号"
        );

        let mut request = valid_request();
        request.download_materials = true;
        request.baidu_cookie = Some("STOKEN=missing-bduss".into());
        assert_eq!(
            validate_request(&request).unwrap_err().to_string(),
            "Cookie 中缺少 BDUSS"
        );
    }

    fn valid_request() -> OrderDocumentsRequest {
        OrderDocumentsRequest {
            shop_id: "shop".into(),
            order_numbers: vec!["123-1".into()],
            output_root: "/tmp/orders".into(),
            ozon_company_id: Some("company".into()),
            ozon_seller_har_path: None,
            ozon_seller_cookie_path: Some("session=value".into()),
            baidu_cookie: None,
            baidu_search_dir: None,
            baidu_recursive: true,
            download_materials: false,
            shipping_labels: vec![crate::core::models::OrderShippingLabel {
                order_number: "123-1".into(),
                url: "https://example.test/label.pdf".into(),
            }],
        }
    }
}
