use crate::core::excel;
use crate::core::models::{
    AppSettings, AppSnapshot, BatchUploadRequest, CategoryOption, ImageRenameRequest,
    ImageRenameResult, ImportPreviewInput, JobKind, JobLog, JobSummary, ListedUpdateRequest,
    LocalSceneRequest, MaterialsRequest, OrderDocumentsRequest, OzonProductRow, PreflightIssue,
    ProductAnalyticsRow, ProviderSecretDraft, ProviderSecretStatus, Shop, ShopDraft,
    SkuFolderReport, SkuFolderRow, TemplateDraft, TemplateSummary, WarehouseOption,
};
use crate::core::oss::AliyunOssClient;
use crate::core::ozon::OzonSellerClient;
use crate::core::secrets;
use crate::core::{ai, batch, business, media, order_docs};
use crate::AppState;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::State;

#[tauri::command]
pub fn load_app_state(state: State<'_, AppState>) -> Result<AppSnapshot, String> {
    let db = state
        .db
        .lock()
        .map_err(|_| "数据库状态锁定失败".to_string())?;
    let settings = db.load_settings().map_err(to_string)?;
    let shops = db.list_shops().map_err(to_string)?;
    let jobs = state.jobs.list_jobs();
    let provider_secrets = provider_secret_status(&settings);
    Ok(AppSnapshot {
        settings,
        shops,
        jobs,
        provider_secrets,
    })
}

#[tauri::command]
pub fn save_settings(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    state
        .db
        .lock()
        .map_err(|_| "数据库状态锁定失败".to_string())?
        .save_settings(settings)
        .map_err(to_string)
}

#[tauri::command]
pub fn save_provider_secrets(
    settings: AppSettings,
    draft: ProviderSecretDraft,
) -> Result<ProviderSecretStatus, String> {
    if let Some(value) = draft
        .image_api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        secrets::set_secret(
            &secrets::provider_api_key_id("image", &settings.image_provider),
            value,
        )
        .map_err(to_string)?;
    }
    if let Some(value) = draft
        .text_api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        secrets::set_secret(
            &secrets::provider_api_key_id("text", &settings.text_provider),
            value,
        )
        .map_err(to_string)?;
    }
    Ok(provider_secret_status(&settings))
}

#[tauri::command]
pub fn save_xiaoqian_api_key(api_key: String) -> Result<ProviderSecretStatus, String> {
    let value = api_key.trim();
    if value.is_empty() {
        return Err("请先填写小千 API Key".into());
    }
    secrets::set_secret(&secrets::provider_api_key_id("text", "xiaoqian"), value)
        .map_err(to_string)?;
    secrets::set_secret(&secrets::provider_api_key_id("image", "xiaoqian"), value)
        .map_err(to_string)?;
    secrets::get_secret(&secrets::provider_api_key_id("text", "xiaoqian")).map_err(to_string)?;
    let settings = AppSettings {
        text_provider: "xiaoqian".into(),
        image_provider: "xiaoqian".into(),
        ..AppSettings::default()
    };
    Ok(provider_secret_status(&settings))
}

#[tauri::command]
pub fn save_shop(state: State<'_, AppState>, draft: ShopDraft) -> Result<Shop, String> {
    state
        .db
        .lock()
        .map_err(|_| "数据库状态锁定失败".to_string())?
        .save_shop(draft)
        .map_err(to_string)
}

#[tauri::command]
pub fn delete_shop(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state
        .db
        .lock()
        .map_err(|_| "数据库状态锁定失败".to_string())?
        .delete_shop(&id)
        .map_err(to_string)
}

#[tauri::command]
pub fn list_templates(
    state: State<'_, AppState>,
    kind: String,
) -> Result<Vec<TemplateSummary>, String> {
    state
        .db
        .lock()
        .map_err(|_| "数据库状态锁定失败".to_string())?
        .list_templates(&kind)
        .map_err(to_string)
}

#[tauri::command]
pub fn save_template(
    state: State<'_, AppState>,
    draft: TemplateDraft,
) -> Result<TemplateSummary, String> {
    state
        .db
        .lock()
        .map_err(|_| "数据库状态锁定失败".to_string())?
        .save_template(draft)
        .map_err(to_string)
}

#[tauri::command]
pub fn delete_template(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state
        .db
        .lock()
        .map_err(|_| "数据库状态锁定失败".to_string())?
        .delete_template(&id)
        .map_err(to_string)
}

#[tauri::command]
pub async fn test_ozon_connection(
    state: State<'_, AppState>,
    shop_id: String,
) -> Result<Value, String> {
    let (client_id, api_key) = {
        let db = state
            .db
            .lock()
            .map_err(|_| "数据库状态锁定失败".to_string())?;
        let shop = db.get_shop(&shop_id).map_err(to_string)?;
        let api_key = db.shop_api_key(&shop_id).map_err(to_string)?;
        (shop.client_id, api_key)
    };
    OzonSellerClient::new(client_id, api_key)
        .map_err(to_string)?
        .test_connection()
        .await
        .map_err(to_string)
}

#[tauri::command]
pub async fn list_ozon_products(
    state: State<'_, AppState>,
    shop_id: String,
    visibility: String,
    limit: u32,
) -> Result<Vec<OzonProductRow>, String> {
    ozon_client(&state, &shop_id)?
        .list_products(&visibility, limit)
        .await
        .map_err(to_string)
}

#[tauri::command]
pub async fn list_categories(
    state: State<'_, AppState>,
    shop_id: String,
) -> Result<Vec<CategoryOption>, String> {
    ozon_client(&state, &shop_id)?
        .list_categories()
        .await
        .map_err(to_string)
}

#[tauri::command]
pub async fn list_products_by_category(
    state: State<'_, AppState>,
    shop_id: String,
    category_id: i64,
    type_id: Option<i64>,
    limit: u32,
) -> Result<Vec<OzonProductRow>, String> {
    ozon_client(&state, &shop_id)?
        .list_products_by_category(category_id, type_id, limit)
        .await
        .map_err(to_string)
}

#[tauri::command]
pub async fn list_product_analytics(
    state: State<'_, AppState>,
    shop_id: String,
    date_from: String,
    date_to: String,
    limit: u32,
) -> Result<Vec<ProductAnalyticsRow>, String> {
    if date_from.trim().is_empty() || date_to.trim().is_empty() {
        return Err("请选择浏览量统计日期".to_string());
    }
    let date_from_value = chrono::NaiveDate::parse_from_str(date_from.trim(), "%Y-%m-%d")
        .map_err(|_| "浏览量开始日期格式不正确".to_string())?;
    let date_to_value = chrono::NaiveDate::parse_from_str(date_to.trim(), "%Y-%m-%d")
        .map_err(|_| "浏览量结束日期格式不正确".to_string())?;
    if date_from_value > date_to_value {
        return Err("浏览量开始日期不能晚于结束日期".to_string());
    }
    let current_utc_date = chrono::Utc::now().date_naive();
    if date_to_value > current_utc_date {
        return Err(format!(
            "Ozon 当前最多只能查询到 {}（按 UTC 日期）",
            current_utc_date.format("%Y-%m-%d")
        ));
    }
    ozon_client(&state, &shop_id)?
        .product_analytics(date_from, date_to, limit)
        .await
        .map_err(to_string)
}

#[tauri::command]
pub async fn merge_product_cards(
    state: State<'_, AppState>,
    shop_id: String,
    product_ids: Vec<i64>,
) -> Result<Value, String> {
    let product_ids = clean_product_ids(product_ids);
    if product_ids.len() < 2 {
        return Err("请至少选择 2 个商品进行合并".to_string());
    }
    ozon_client(&state, &shop_id)?
        .merge_product_cards(product_ids, 20)
        .await
        .map_err(to_string)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_category_products(
    state: State<'_, AppState>,
    shop_id: String,
    category_id: i64,
    type_id: Option<i64>,
    warehouse_id: Option<i64>,
    stock: Option<i64>,
    price: Option<String>,
    old_price: Option<String>,
    currency_code: Option<String>,
    update_stock: bool,
    update_price: bool,
) -> Result<Value, String> {
    if !update_stock && !update_price {
        return Err("请至少选择更新库存或价格".to_string());
    }
    if update_stock && warehouse_id.is_none() {
        return Err("请先选择仓库".to_string());
    }
    let stock_value = stock.unwrap_or_default();
    if update_stock && stock_value < 0 {
        return Err("库存数量不能小于 0".to_string());
    }
    let price_value = price.unwrap_or_default().trim().to_string();
    if update_price && price_value.is_empty() {
        return Err("请先填写新售价".to_string());
    }
    let old_price_value = old_price.unwrap_or_default().trim().to_string();
    let fallback_currency = currency_code.unwrap_or_default().trim().to_string();

    let client = ozon_client(&state, &shop_id)?;
    let products = client
        .list_all_products_by_category(category_id, type_id)
        .await
        .map_err(to_string)?;
    if products.is_empty() {
        return Err("所选类目没有匹配商品".to_string());
    }
    let prices = if update_price {
        build_category_price_payloads(
            &products,
            &price_value,
            &old_price_value,
            &fallback_currency,
        )?
    } else {
        Vec::new()
    };

    let mut stock_results = Vec::new();
    if update_stock {
        let stocks = products
            .iter()
            .filter_map(|product| {
                product.product_id.map(|product_id| {
                    json!({
                        "product_id": product_id,
                        "stock": stock_value,
                        "warehouse_id": warehouse_id.unwrap_or_default(),
                    })
                })
            })
            .collect::<Vec<_>>();
        if stocks.is_empty() {
            return Err("所选类目商品缺少 product_id，无法更新库存".to_string());
        }
        for (index, chunk) in stocks.chunks(100).enumerate() {
            let data = client
                .update_stocks(chunk.to_vec())
                .await
                .map_err(to_string)?;
            stock_results.push(json!({ "batch": index + 1, "count": chunk.len(), "data": data }));
        }
    }

    let mut price_results = Vec::new();
    if update_price {
        for (index, chunk) in prices.chunks(100).enumerate() {
            let data = client
                .update_prices(chunk.to_vec())
                .await
                .map_err(to_string)?;
            price_results.push(json!({ "batch": index + 1, "count": chunk.len(), "data": data }));
        }
    }

    Ok(json!({
        "total": products.len(),
        "stockUpdated": update_stock,
        "priceUpdated": update_price,
        "stockBatches": stock_results.len(),
        "priceBatches": price_results.len(),
        "stockResults": stock_results,
        "priceResults": price_results,
    }))
}

#[tauri::command]
pub async fn get_product_info(
    state: State<'_, AppState>,
    shop_id: String,
    offer_ids: Vec<String>,
) -> Result<Value, String> {
    ozon_client(&state, &shop_id)?
        .product_info(clean_strings(offer_ids))
        .await
        .map_err(to_string)
}

#[tauri::command]
pub async fn get_product_info_by_product_ids(
    state: State<'_, AppState>,
    shop_id: String,
    product_ids: Vec<i64>,
) -> Result<Value, String> {
    ozon_client(&state, &shop_id)?
        .product_info_by_product_ids(product_ids)
        .await
        .map_err(to_string)
}

#[tauri::command]
pub async fn get_product_attributes(
    state: State<'_, AppState>,
    shop_id: String,
    offer_ids: Vec<String>,
) -> Result<Value, String> {
    ozon_client(&state, &shop_id)?
        .product_attributes(clean_strings(offer_ids))
        .await
        .map_err(to_string)
}

#[tauri::command]
pub async fn get_product_description(
    state: State<'_, AppState>,
    shop_id: String,
    offer_id: String,
) -> Result<Value, String> {
    ozon_client(&state, &shop_id)?
        .product_description(offer_id.trim().to_string())
        .await
        .map_err(to_string)
}

#[tauri::command]
pub async fn get_product_stocks(
    state: State<'_, AppState>,
    shop_id: String,
    offer_ids: Vec<String>,
    product_ids: Vec<i64>,
    visibility: String,
) -> Result<Value, String> {
    ozon_client(&state, &shop_id)?
        .product_stocks(clean_strings(offer_ids), product_ids, visibility)
        .await
        .map_err(to_string)
}

#[tauri::command]
pub async fn list_warehouses(
    state: State<'_, AppState>,
    shop_id: String,
) -> Result<Vec<WarehouseOption>, String> {
    ozon_client(&state, &shop_id)?
        .list_warehouses()
        .await
        .map_err(to_string)
}

#[tauri::command]
pub async fn get_import_info(
    state: State<'_, AppState>,
    shop_id: String,
    task_id: i64,
) -> Result<Value, String> {
    ozon_client(&state, &shop_id)?
        .import_info(task_id)
        .await
        .map_err(to_string)
}

#[tauri::command]
pub async fn import_products(
    state: State<'_, AppState>,
    shop_id: String,
    items: Vec<Value>,
) -> Result<Value, String> {
    ozon_client(&state, &shop_id)?
        .import_products(items)
        .await
        .map_err(to_string)
}

#[tauri::command]
pub async fn list_actions(state: State<'_, AppState>, shop_id: String) -> Result<Value, String> {
    ozon_client(&state, &shop_id)?
        .list_actions()
        .await
        .map_err(to_string)
}

#[tauri::command]
pub async fn list_action_products(
    state: State<'_, AppState>,
    shop_id: String,
    action_id: i64,
    limit: u32,
    last_id: String,
) -> Result<Value, String> {
    ozon_client(&state, &shop_id)?
        .action_products(action_id, limit, last_id)
        .await
        .map_err(to_string)
}

#[tauri::command]
pub async fn list_action_candidates(
    state: State<'_, AppState>,
    shop_id: String,
    action_id: i64,
    limit: u32,
    last_id: String,
) -> Result<Value, String> {
    ozon_client(&state, &shop_id)?
        .action_candidates(action_id, limit, last_id)
        .await
        .map_err(to_string)
}

#[tauri::command]
pub async fn activate_action_products(
    state: State<'_, AppState>,
    shop_id: String,
    action_id: i64,
    products: Vec<Value>,
) -> Result<Value, String> {
    ozon_client(&state, &shop_id)?
        .activate_action_products(action_id, products)
        .await
        .map_err(to_string)
}

#[tauri::command]
pub async fn deactivate_action_products(
    state: State<'_, AppState>,
    shop_id: String,
    action_id: i64,
    product_ids: Vec<i64>,
) -> Result<Value, String> {
    ozon_client(&state, &shop_id)?
        .deactivate_action_products(action_id, product_ids)
        .await
        .map_err(to_string)
}

#[tauri::command]
pub async fn deactivate_all_action_products(
    state: State<'_, AppState>,
    shop_id: String,
    action_id: i64,
) -> Result<Value, String> {
    ozon_client(&state, &shop_id)?
        .deactivate_all_action_products(action_id)
        .await
        .map_err(to_string)
}

#[tauri::command]
pub async fn update_stocks(
    state: State<'_, AppState>,
    shop_id: String,
    stocks: Vec<Value>,
) -> Result<Value, String> {
    ozon_client(&state, &shop_id)?
        .update_stocks(stocks)
        .await
        .map_err(to_string)
}

#[tauri::command]
pub async fn update_prices(
    state: State<'_, AppState>,
    shop_id: String,
    prices: Vec<Value>,
) -> Result<Value, String> {
    ozon_client(&state, &shop_id)?
        .update_prices(prices)
        .await
        .map_err(to_string)
}

#[tauri::command]
pub async fn generate_barcodes(
    state: State<'_, AppState>,
    shop_id: String,
    product_ids: Vec<i64>,
) -> Result<Value, String> {
    let product_ids = clean_product_ids(product_ids);
    if product_ids.is_empty() {
        return Err("请至少选择 1 个商品生成条码".to_string());
    }
    ozon_client(&state, &shop_id)?
        .generate_barcodes(product_ids)
        .await
        .map_err(to_string)
}

#[tauri::command]
pub fn start_batch_upload(
    state: State<'_, AppState>,
    request: BatchUploadRequest,
) -> Result<JobSummary, String> {
    if request.shop_ids.is_empty() {
        return Err("请选择至少一个店铺".into());
    }
    validate_auto_upload_options(&request)?;
    let shops = {
        let db = state
            .db
            .lock()
            .map_err(|_| "数据库状态锁定失败".to_string())?;
        request
            .shop_ids
            .iter()
            .map(|shop_id| {
                let shop = db.get_shop(shop_id).map_err(to_string)?;
                let ozon_api_key = db.shop_api_key(shop_id).map_err(to_string)?;
                let oss_secret = db.shop_oss_secret(shop_id).ok();
                Ok(batch::RuntimeShopConfig {
                    shop,
                    ozon_api_key,
                    oss_secret,
                })
            })
            .collect::<Result<Vec<_>, String>>()?
    };
    let job = state.jobs.create_job(
        JobKind::BatchUpload,
        "多店铺批量上架".into(),
        Some(request.excel_path.clone()),
    );
    let jobs = state.jobs.clone();
    let job_id = job.id.clone();
    tauri::async_runtime::spawn(batch::run_batch_upload(jobs, job_id, request, shops));
    Ok(job)
}

#[tauri::command]
pub fn preflight_materials(
    _state: State<'_, AppState>,
    request: MaterialsRequest,
) -> Result<Vec<PreflightIssue>, String> {
    let mut issues = Vec::new();
    let source_root = PathBuf::from(&request.source_root);
    let output_root = PathBuf::from(&request.portrait_root);
    if !source_root.is_dir() {
        issues.push(issue(
            "error",
            "源目录",
            "源目录不存在或未选择",
            "选择目录",
            "materials",
        ));
    } else {
        match analyze_material_source(&source_root) {
            Ok(report) if report.image_count == 0 => issues.push(issue(
                "error",
                "源目录",
                "源目录下没有可处理图片",
                "检查源目录",
                "materials",
            )),
            Ok(report) => issues.push(issue(
                "info",
                "源目录",
                &format!(
                    "将处理 {} 个 SKU、{} 张图片",
                    report.sku_count, report.image_count
                ),
                "",
                "",
            )),
            Err(error) => issues.push(issue(
                "error",
                "源目录",
                &error.to_string(),
                "检查源目录",
                "materials",
            )),
        }
    }
    if (request.convert_originals || request.generate_ai_images)
        && request.portrait_root.trim().is_empty()
    {
        issues.push(issue(
            "error",
            "输出目录",
            "请先选择输出目录",
            "选择目录",
            "materials",
        ));
    } else if let Some(parent) = output_root.parent() {
        if !parent.exists() {
            issues.push(issue(
                "warn",
                "输出目录",
                "输出目录的上级目录不存在，任务会尝试创建",
                "",
                "",
            ));
        }
    }
    if request.generate_copy
        && request
            .content_root
            .as_deref()
            .unwrap_or_default()
            .trim()
            .is_empty()
    {
        issues.push(issue(
            "error",
            "文案输出目录",
            "请先选择标题输出目录",
            "选择目录",
            "materials",
        ));
    }
    if request.generate_ai_images && !provider_secret_exists("image", &request.image_provider) {
        issues.push(issue(
            "error",
            "AI 图片",
            "图片 API Key 未保存",
            "去设置",
            "settings",
        ));
    }
    if request.generate_copy && !text_provider_secret_exists(&request) {
        issues.push(issue(
            "error",
            "AI 文案",
            "文案 API Key 未保存",
            "去设置",
            "settings",
        ));
    }
    if issues.is_empty() {
        issues.push(issue("info", "预检查", "检查通过，可以开始处理", "", ""));
    }
    Ok(issues)
}

#[tauri::command]
pub fn preflight_batch_upload(
    state: State<'_, AppState>,
    request: BatchUploadRequest,
) -> Result<Vec<PreflightIssue>, String> {
    let mut issues = Vec::new();
    let shops = shops_for_preflight(&state, &request.shop_ids, true, &mut issues)?;
    check_excel_and_images(
        &request.excel_path,
        &request.portrait_root,
        request.max_items,
        true,
        &mut issues,
    );
    if shops.is_empty() {
        issues.push(issue(
            "error",
            "店铺",
            "请选择至少一个店铺",
            "选择店铺",
            "ozon",
        ));
    }
    if let Err(message) = validate_auto_upload_options(&request) {
        issues.push(issue(
            "error",
            "上架后自动处理",
            &message,
            "补充自动处理配置",
            "ozon",
        ));
    }
    if issues.is_empty() {
        issues.push(issue(
            "info",
            "预检查",
            "检查通过，可以提交批量上架",
            "",
            "",
        ));
    }
    Ok(issues)
}

fn validate_auto_upload_options(request: &BatchUploadRequest) -> Result<(), String> {
    if request.auto_update_stock {
        if request.auto_warehouse_id.is_none() {
            return Err("启用自动补库存后，请先选择仓库".to_string());
        }
        if request.auto_stock.unwrap_or_default() < 0 {
            return Err("自动库存数量不能小于 0".to_string());
        }
    }
    if request.auto_add_to_action {
        if request.auto_action_id.is_none() {
            return Err("启用自动加入促销后，请先选择活动".to_string());
        }
        if request.auto_action_stock.unwrap_or_default() <= 0 {
            return Err("活动库存必须大于 0".to_string());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn preflight_listed_update(
    state: State<'_, AppState>,
    request: ListedUpdateRequest,
) -> Result<Vec<PreflightIssue>, String> {
    let mut issues = Vec::new();
    let shops = shops_for_preflight(
        &state,
        std::slice::from_ref(&request.shop_id),
        false,
        &mut issues,
    )?;
    check_excel_and_images(
        &request.excel_path,
        &request.portrait_root,
        request.max_items,
        false,
        &mut issues,
    );
    if !(request.update_title
        || request.update_description
        || request.update_images
        || request.update_video
        || request.update_rich_json)
    {
        issues.push(issue(
            "error",
            "更新项",
            "至少选择一个更新项",
            "选择更新项",
            "ozon",
        ));
    }
    if let Some((shop, api_key)) = shops.first() {
        if let Ok(rows) = excel::read_content_rows(Path::new(&request.excel_path)) {
            let offer_ids = rows
                .into_iter()
                .take(20)
                .map(|row| row.sku)
                .filter(|sku| !sku.trim().is_empty())
                .collect::<Vec<_>>();
            if !offer_ids.is_empty() {
                match OzonSellerClient::new(shop.client_id.clone(), api_key.clone()) {
                    Ok(client) => {
                        if let Err(error) = client.product_info(offer_ids).await {
                            issues.push(issue(
                                "warn",
                                "线上商品",
                                &format!("抽样拉取线上商品失败：{}", error),
                                "测试 Ozon",
                                "settings",
                            ));
                        }
                    }
                    Err(error) => issues.push(issue(
                        "error",
                        "Ozon",
                        &error.to_string(),
                        "去设置",
                        "settings",
                    )),
                }
            }
        }
    }
    if issues.is_empty() {
        issues.push(issue("info", "预检查", "检查通过，可以提交更新", "", ""));
    }
    Ok(issues)
}

#[tauri::command]
pub async fn test_oss_upload(
    state: State<'_, AppState>,
    shop_id: String,
) -> Result<String, String> {
    let runtime = {
        let db = state
            .db
            .lock()
            .map_err(|_| "数据库状态锁定失败".to_string())?;
        let shop = db.get_shop(&shop_id).map_err(to_string)?;
        let oss_secret = db.shop_oss_secret(&shop_id).map_err(to_string)?;
        (shop, oss_secret)
    };
    let client = AliyunOssClient::new(
        runtime.0.oss_access_key_id.unwrap_or_default(),
        runtime.1,
        runtime.0.oss_bucket.unwrap_or_default(),
        runtime.0.oss_endpoint.unwrap_or_default(),
        runtime.0.oss_public_domain.unwrap_or_default(),
    )
    .map_err(to_string)?;
    client
        .put_object(
            &format!("healthcheck/{}.txt", chrono::Utc::now().timestamp()),
            b"ozon-sjsq oss check".to_vec(),
            "text/plain",
        )
        .await
        .map_err(to_string)
}

#[tauri::command]
pub fn start_listed_update(
    state: State<'_, AppState>,
    request: ListedUpdateRequest,
) -> Result<JobSummary, String> {
    let runtime = {
        let db = state
            .db
            .lock()
            .map_err(|_| "数据库状态锁定失败".to_string())?;
        let shop = db.get_shop(&request.shop_id).map_err(to_string)?;
        let ozon_api_key = db.shop_api_key(&request.shop_id).map_err(to_string)?;
        let oss_secret = db.shop_oss_secret(&request.shop_id).ok();
        batch::RuntimeShopConfig {
            shop,
            ozon_api_key,
            oss_secret,
        }
    };
    let job = state.jobs.create_job(
        JobKind::ListedUpdate,
        "按货号更新已上架商品".into(),
        Some(request.excel_path.clone()),
    );
    let jobs = state.jobs.clone();
    let job_id = job.id.clone();
    tauri::async_runtime::spawn(batch::run_listed_update(jobs, job_id, request, runtime));
    Ok(job)
}

#[tauri::command]
pub fn start_order_documents(
    state: State<'_, AppState>,
    mut request: OrderDocumentsRequest,
) -> Result<JobSummary, String> {
    let client = ozon_client(&state, &request.shop_id)?;
    if request
        .ozon_company_id
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .is_empty()
    {
        let db = state
            .db
            .lock()
            .map_err(|_| "数据库状态锁定失败".to_string())?;
        request.ozon_company_id = Some(db.get_shop(&request.shop_id).map_err(to_string)?.client_id);
    }
    order_docs::validate_request(&request).map_err(to_string)?;
    let job = state.jobs.create_job(
        JobKind::OrderDocuments,
        "订单文件下载".into(),
        Some(request.order_numbers.join(",")),
    );
    let jobs = state.jobs.clone();
    let job_id = job.id.clone();
    tauri::async_runtime::spawn(order_docs::run_order_documents_job(
        jobs, job_id, request, client,
    ));
    Ok(job)
}

#[tauri::command]
pub fn start_materials_job(
    state: State<'_, AppState>,
    request: MaterialsRequest,
) -> Result<JobSummary, String> {
    let title =
        if request.convert_originals && !request.generate_copy && !request.generate_ai_images {
            "转 3:4 + 水印"
        } else if request.generate_copy && !request.convert_originals && !request.generate_ai_images
        {
            "AI 生成标题"
        } else {
            "素材生成与 3:4 转图"
        };
    let job = state.jobs.create_job(
        JobKind::Materials,
        title.into(),
        Some(request.source_root.clone()),
    );
    let jobs = state.jobs.clone();
    let job_id = job.id.clone();
    tauri::async_runtime::spawn(media::run_materials_job(jobs, job_id, request));
    Ok(job)
}

#[tauri::command]
pub async fn list_ai_models(base_url: String, provider: String) -> Result<Vec<String>, String> {
    let key = provider_secret_for_models(&provider)
        .map_err(|_| format!("未找到 {provider} 密钥，请先保存 API Key"))?;
    ai::OpenAiCompatibleClient::new(base_url, key)
        .map_err(to_string)?
        .list_models()
        .await
        .map_err(to_string)
}

#[tauri::command]
pub fn rename_material_images(request: ImageRenameRequest) -> Result<ImageRenameResult, String> {
    let source_root = PathBuf::from(request.source_root.trim());
    let output_root = PathBuf::from(request.output_root.trim());
    let prefix = request.prefix.trim();

    if !source_root.is_dir() {
        return Err("原素材文件夹不存在或未选择".into());
    }
    if output_root.as_os_str().is_empty() {
        return Err("请先选择生成后存放目录".into());
    }
    if prefix.is_empty() {
        return Err("请填写重命名前缀".into());
    }

    std::fs::create_dir_all(&output_root).map_err(to_string)?;

    let mut images = std::fs::read_dir(&source_root)
        .map_err(to_string)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_rename_image(path))
        .collect::<Vec<_>>();
    images.sort_by_key(|path| {
        path.file_name()
            .map(|value| value.to_string_lossy().to_lowercase())
            .unwrap_or_default()
    });

    if images.is_empty() {
        return Err("原素材文件夹下没有可重命名的图片".into());
    }

    for (index, image_path) in images.iter().enumerate() {
        let extension = image_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_lowercase();
        let output = output_root.join(format!("{prefix}{:03}.{extension}", index + 1));
        if output.exists() {
            return Err(format!("目标文件已存在：{}", output.display()));
        }
        std::fs::copy(image_path, &output).map_err(to_string)?;
    }

    Ok(ImageRenameResult {
        count: images.len(),
        output_root: output_root.display().to_string(),
    })
}

#[tauri::command]
pub fn start_local_scene_job(
    state: State<'_, AppState>,
    request: LocalSceneRequest,
) -> Result<JobSummary, String> {
    let job = state.jobs.create_job(
        JobKind::SceneLocal,
        "本地场景图合成".into(),
        Some(request.source_root.clone()),
    );
    let jobs = state.jobs.clone();
    let job_id = job.id.clone();
    tauri::async_runtime::spawn(media::run_local_scene_job(jobs, job_id, request));
    Ok(job)
}

#[tauri::command]
pub fn start_demo_job(
    state: State<'_, AppState>,
    kind: JobKind,
    title: String,
) -> Result<JobSummary, String> {
    Ok(state.jobs.start_demo_job(kind, title))
}

#[tauri::command]
pub fn list_jobs(state: State<'_, AppState>) -> Result<Vec<JobSummary>, String> {
    Ok(state.jobs.list_jobs())
}

#[tauri::command]
pub fn list_job_logs(state: State<'_, AppState>, job_id: String) -> Result<Vec<JobLog>, String> {
    Ok(state.jobs.list_logs(&job_id))
}

#[tauri::command]
pub fn cancel_job(state: State<'_, AppState>, job_id: String) -> Result<bool, String> {
    Ok(state.jobs.cancel(&job_id))
}

#[tauri::command]
pub fn create_upload_template(path: String) -> Result<(), String> {
    excel::create_upload_template(&PathBuf::from(path)).map_err(to_string)
}

#[tauri::command]
pub fn analyze_sku_folder(path: String) -> Result<SkuFolderReport, String> {
    business::analyze_sku_folder(&PathBuf::from(path)).map_err(to_string)
}

#[tauri::command]
pub fn build_import_preview(input: ImportPreviewInput) -> Result<Value, String> {
    Ok(business::build_import_item(input))
}

#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("路径为空".into());
    }
    let target = PathBuf::from(path);
    let open_target = if target.is_file() || target.is_dir() {
        target
    } else if let Some(parent) = target.parent().filter(|parent| parent.exists()) {
        parent.to_path_buf()
    } else {
        return Err(format!("路径不存在: {}", path));
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(open_target);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", "start", "", &open_target.display().to_string()]);
        command
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(open_target);
        command
    };
    command.spawn().map_err(to_string)?;
    Ok(())
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    let url = url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("只支持打开 http/https 链接".into());
    }
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(url);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", "start", "", url]);
        command
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(url);
        command
    };
    command.spawn().map_err(to_string)?;
    Ok(())
}

#[tauri::command]
pub fn pick_directory() -> Result<String, String> {
    let output = std::process::Command::new("osascript")
        .args(["-e", r#"POSIX path of (choose folder)"#])
        .output()
        .map_err(|e| format!("无法打开文件对话框: {}", e))?;
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        Err("用户取消了选择".into())
    } else {
        Ok(path)
    }
}

#[tauri::command]
pub fn pick_file() -> Result<String, String> {
    let output = std::process::Command::new("osascript")
        .args(["-e", r#"POSIX path of (choose file)"#])
        .output()
        .map_err(|e| format!("无法打开文件对话框: {}", e))?;
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        Err("用户取消了选择".into())
    } else {
        Ok(path)
    }
}

fn to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn ozon_client(state: &State<'_, AppState>, shop_id: &str) -> Result<OzonSellerClient, String> {
    let db = state
        .db
        .lock()
        .map_err(|_| "数据库状态锁定失败".to_string())?;
    let shop = db.get_shop(shop_id).map_err(to_string)?;
    let api_key = db.shop_api_key(shop_id).map_err(to_string)?;
    OzonSellerClient::new(shop.client_id, api_key).map_err(to_string)
}

fn clean_strings(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

fn clean_product_ids(values: Vec<i64>) -> Vec<i64> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| *value > 0 && seen.insert(*value))
        .collect()
}

fn build_category_price_payloads(
    products: &[OzonProductRow],
    price: &str,
    old_price: &str,
    fallback_currency: &str,
) -> Result<Vec<Value>, String> {
    products
        .iter()
        .map(|product| {
            let currency = product.currency_code.as_deref().unwrap_or("").trim();
            let currency = if currency.is_empty() {
                fallback_currency
            } else {
                currency
            };
            if currency.is_empty() {
                return Err(format!(
                    "{} 缺少商品原币种，请填写备用币种后再更新价格",
                    product.offer_id
                ));
            }
            Ok(json!({
                "offer_id": product.offer_id,
                "price": price,
                "old_price": old_price,
                "currency_code": currency,
            }))
        })
        .collect()
}

fn is_rename_image(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "jpg" | "jpeg" | "png" | "webp" | "bmp" | "gif" | "tif" | "tiff"
            )
        })
        .unwrap_or(false)
}

fn analyze_material_source(root: &Path) -> anyhow::Result<SkuFolderReport> {
    let report = business::analyze_sku_folder(root)?;
    if report.image_count > 0 {
        return Ok(report);
    }

    let direct_images = business::list_sku_images(root)?;
    if direct_images.is_empty() {
        return Ok(report);
    }

    let rows = direct_images
        .iter()
        .map(|path| SkuFolderRow {
            sku: path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("sku")
                .to_string(),
            image_count: 1,
            first_image: Some(path.display().to_string()),
        })
        .collect::<Vec<_>>();

    Ok(SkuFolderReport {
        root: root.display().to_string(),
        sku_count: rows.len(),
        image_count: rows.len(),
        rows,
    })
}

fn provider_secret_exists(kind: &str, provider: &str) -> bool {
    secrets::get_secret(&secrets::provider_api_key_id(kind, provider)).is_ok()
}

fn text_provider_secret_exists(request: &MaterialsRequest) -> bool {
    if ai::is_ollama_provider(&request.text_provider) {
        return true;
    }
    provider_secret_exists("text", &request.text_provider)
        || (request.text_provider == request.image_provider
            && provider_secret_exists("image", &request.image_provider))
}

fn provider_secret_for_models(provider: &str) -> Result<String, anyhow::Error> {
    if ai::is_ollama_provider(provider) {
        return Ok(String::new());
    }
    secrets::get_secret(&secrets::provider_api_key_id("text", provider))
        .or_else(|_| secrets::get_secret(&secrets::provider_api_key_id("image", provider)))
}

fn shops_for_preflight(
    state: &State<'_, AppState>,
    shop_ids: &[String],
    require_oss: bool,
    issues: &mut Vec<PreflightIssue>,
) -> Result<Vec<(Shop, String)>, String> {
    if shop_ids.is_empty() {
        return Ok(Vec::new());
    }
    let db = state
        .db
        .lock()
        .map_err(|_| "数据库状态锁定失败".to_string())?;
    let mut shops = Vec::new();
    for shop_id in shop_ids {
        match db.get_shop(shop_id) {
            Ok(shop) => {
                match db.shop_api_key(shop_id) {
                    Ok(api_key) => shops.push((shop.clone(), api_key)),
                    Err(error) => issues.push(issue(
                        "error",
                        &shop.name,
                        &format!("Ozon API Key 未保存：{}", error),
                        "去设置",
                        "settings",
                    )),
                }
                if require_oss {
                    let missing_oss = shop
                        .oss_access_key_id
                        .as_deref()
                        .unwrap_or("")
                        .trim()
                        .is_empty()
                        || shop.oss_bucket.as_deref().unwrap_or("").trim().is_empty()
                        || shop.oss_endpoint.as_deref().unwrap_or("").trim().is_empty()
                        || shop
                            .oss_public_domain
                            .as_deref()
                            .unwrap_or("")
                            .trim()
                            .is_empty()
                        || db.shop_oss_secret(shop_id).is_err();
                    if missing_oss {
                        issues.push(issue(
                            "error",
                            &shop.name,
                            "OSS 配置不完整，无法上传图片",
                            "去设置",
                            "settings",
                        ));
                    }
                }
            }
            Err(error) => issues.push(issue(
                "error",
                "店铺",
                &error.to_string(),
                "去设置",
                "settings",
            )),
        }
    }
    Ok(shops)
}

fn check_excel_and_images(
    excel_path: &str,
    portrait_root: &str,
    max_items: Option<i64>,
    require_title_desc: bool,
    issues: &mut Vec<PreflightIssue>,
) {
    let excel_path = PathBuf::from(excel_path);
    let portrait_root = PathBuf::from(portrait_root);
    if !excel_path.is_file() {
        issues.push(issue(
            "error",
            "Excel",
            "Excel 文件不存在或未选择",
            "选择 Excel",
            "ozon",
        ));
        return;
    }
    if !portrait_root.is_dir() {
        issues.push(issue(
            "error",
            "图片目录",
            "图片目录不存在或未选择",
            "选择目录",
            "ozon",
        ));
        return;
    }
    let mut rows = match excel::read_content_rows(&excel_path) {
        Ok(rows) => rows,
        Err(error) => {
            issues.push(issue(
                "error",
                "Excel",
                &error.to_string(),
                "检查 Excel",
                "ozon",
            ));
            return;
        }
    };
    if let Some(max_items) = max_items.filter(|value| *value > 0) {
        rows.truncate(max_items as usize);
    }
    if rows.is_empty() {
        issues.push(issue(
            "error",
            "Excel",
            "Excel 没有可处理货号",
            "检查 Excel",
            "ozon",
        ));
        return;
    }
    let sku_set = rows
        .iter()
        .map(|row| row.sku.trim().to_string())
        .collect::<HashSet<_>>();
    let empty_copy = rows
        .iter()
        .filter(|row| row.title.trim().is_empty())
        .count();
    let report = match business::analyze_sku_folder(&portrait_root) {
        Ok(report) => report,
        Err(error) => {
            issues.push(issue(
                "error",
                "图片目录",
                &error.to_string(),
                "检查图片目录",
                "ozon",
            ));
            return;
        }
    };
    let image_skus = report
        .rows
        .iter()
        .map(|row| row.sku.trim().to_string())
        .collect::<HashSet<_>>();
    let missing_images = sku_set
        .iter()
        .filter(|sku| !image_skus.contains(*sku))
        .count();
    let zero_image_folders = report
        .rows
        .iter()
        .filter(|row| row.image_count == 0)
        .count();
    issues.push(issue(
        "info",
        "数据量",
        &format!(
            "Excel {} 个 SKU，图片目录 {} 个 SKU、{} 张图片",
            rows.len(),
            report.sku_count,
            report.image_count
        ),
        "",
        "",
    ));
    if missing_images > 0 {
        issues.push(issue(
            "warn",
            "SKU 匹配",
            &format!("{} 个 Excel SKU 没有对应图片文件夹，开始后会自动跳过", missing_images),
            "检查图片目录",
            "ozon",
        ));
    }
    if zero_image_folders > 0 {
        issues.push(issue(
            "warn",
            "图片目录",
            &format!("{} 个 SKU 文件夹没有图片", zero_image_folders),
            "检查图片目录",
            "ozon",
        ));
    }
    if require_title_desc && empty_copy > 0 {
        issues.push(issue(
            "warn",
            "Excel 文案",
            &format!("{} 个 SKU 缺少标题，会被跳过", empty_copy),
            "检查 Excel",
            "ozon",
        ));
    }
}

fn issue(
    level: &str,
    scope: &str,
    message: &str,
    action_label: &str,
    action_target: &str,
) -> PreflightIssue {
    PreflightIssue {
        level: level.to_string(),
        scope: scope.to_string(),
        message: message.to_string(),
        action_label: (!action_label.is_empty()).then(|| action_label.to_string()),
        action_target: (!action_target.is_empty()).then(|| action_target.to_string()),
    }
}

fn provider_secret_status(settings: &AppSettings) -> ProviderSecretStatus {
    ProviderSecretStatus {
        image_api_key_stored: secrets::get_secret(&secrets::provider_api_key_id(
            "image",
            &settings.image_provider,
        ))
        .is_ok(),
        text_api_key_stored: ai::is_ollama_provider(&settings.text_provider)
            || secrets::get_secret(&secrets::provider_api_key_id(
                "text",
                &settings.text_provider,
            ))
            .is_ok(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn material_source_accepts_images_directly_under_root() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "ozon-sjsq-material-source-test-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("sku-001.jpg"), b"not-opened-by-preflight").unwrap();

        let report = analyze_material_source(&root).unwrap();
        assert_eq!(report.sku_count, 1);
        assert_eq!(report.image_count, 1);
        assert_eq!(report.rows[0].sku, "sku-001");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn category_price_payloads_validate_all_currencies_before_updates() {
        let products = vec![
            product_row_for_price("SKU-1", Some("RUB")),
            product_row_for_price("SKU-2", None),
        ];

        let error = build_category_price_payloads(&products, "100", "", "").unwrap_err();

        assert_eq!(error, "SKU-2 缺少商品原币种，请填写备用币种后再更新价格");
    }

    #[test]
    fn category_price_payloads_use_fallback_currency() {
        let products = vec![product_row_for_price("SKU-1", None)];

        let payloads = build_category_price_payloads(&products, "100", "120", "RUB").unwrap();

        assert_eq!(payloads[0]["offer_id"], "SKU-1");
        assert_eq!(payloads[0]["currency_code"], "RUB");
    }

    #[test]
    fn product_ids_remove_invalid_values_and_duplicates() {
        assert_eq!(clean_product_ids(vec![2, 0, 1, 2, -1, 1]), vec![2, 1]);
    }

    fn product_row_for_price(offer_id: &str, currency_code: Option<&str>) -> OzonProductRow {
        OzonProductRow {
            product_id: Some(1),
            offer_id: offer_id.to_string(),
            name: String::new(),
            visibility: None,
            has_barcode: None,
            stock_summary: None,
            category_id: None,
            category_name: None,
            type_id: None,
            type_name: None,
            price: None,
            old_price: None,
            currency_code: currency_code.map(str::to_string),
        }
    }
}
