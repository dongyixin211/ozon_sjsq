use crate::core::auto_listing_scheduler::AutoListingScheduler;
use crate::core::db::Database;
use crate::core::excel;
use crate::core::excel::ContentRow;
use crate::core::models::{
    AppSettings, AppSnapshot, AutoListingRequest, BatchUploadRequest, CategoryOption,
    FollowAutomationRequest, GalleryUploadRequest, GalleryUploadSelection, ImageRenameRequest,
    ImageRenameResult, ImportPreviewInput, JobKind, JobLog, JobSummary, ListedUpdateRequest,
    ListingImageRepairRequest, ListingMaintenanceRequest, LocalMockupRenderRequest,
    LocalMockupRenderResult, LocalSceneRequest, MaterialsRequest, OrderDocumentsRequest,
    OrderListRequest, OrderPostingRow, OrderShippingLabelAssignment,
    OrderShippingLabelDownloadRequest, OzonProductRow, PreflightIssue, ProductAnalyticsRow,
    ProviderSecretDraft, ProviderSecretStatus, Shop, ShopDraft, SkuFolderReport, SkuFolderRow,
    StoredOrderQuery, TemplateDraft, TemplateSummary, WarehouseOption,
};
use crate::core::oss::AliyunOssClient;
use crate::core::ozon::{OzonSellerClient, OzonUploadQuota};
use crate::core::secrets;
use crate::core::{
    ai, auto_listing, auto_listing_scheduler, batch, business, device, follow, gallery_upload,
    listing_image_repair, listing_maintenance, local_mockup, media, order_docs,
};
use crate::AppState;
use chrono::{Offset, TimeZone};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::{Manager, State};

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
pub fn get_device_fingerprint(app: tauri::AppHandle) -> Result<String, String> {
    Ok(device::fingerprint(&app))
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
pub async fn get_shop_upload_quota(
    state: State<'_, AppState>,
    shop_id: String,
) -> Result<OzonUploadQuota, String> {
    ozon_client(&state, &shop_id)?
        .product_upload_quota()
        .await
        .map_err(to_string)
}

#[tauri::command]
pub fn scheduler_status(
    scheduler: State<'_, AutoListingScheduler>,
    request: auto_listing_scheduler::SchedulerStatusRequest,
) -> Result<auto_listing_scheduler::SchedulerStatus, String> {
    scheduler.status(&request.account_id).map_err(to_string)
}

#[tauri::command]
pub async fn run_auto_listing_plan_now(
    app: tauri::AppHandle,
    scheduler: State<'_, AutoListingScheduler>,
    request: auto_listing_scheduler::RunSchedulerRequest,
) -> Result<auto_listing_scheduler::SchedulerStatus, String> {
    scheduler.tick(app, request).await
}

#[tauri::command]
pub fn pause_auto_listing_plan(
    scheduler: State<'_, AutoListingScheduler>,
    request: auto_listing_scheduler::PauseSchedulerRequest,
) -> Result<auto_listing_scheduler::SchedulerStatus, String> {
    scheduler.pause(request)
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
    cached_products: Option<Vec<OzonProductRow>>,
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
    let products = cached_products
        .filter(|items| !items.is_empty())
        .unwrap_or_else(Vec::new);
    let products = if products.is_empty() {
        client
            .list_all_products_by_category(category_id, type_id)
            .await
            .map_err(to_string)?
    } else {
        products
    };
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
                Ok(batch::RuntimeShopConfig {
                    shop,
                    ozon_api_key,
                    oss_secret: None,
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
pub fn start_auto_listing(
    state: State<'_, AppState>,
    request: AutoListingRequest,
) -> Result<JobSummary, String> {
    validate_auto_listing_request(&request)?;
    let shop_ids = request
        .shop_configs
        .iter()
        .map(|config| config.shop_id.clone())
        .collect::<HashSet<_>>();
    let (shops, cache_root) = {
        let db = state
            .db
            .lock()
            .map_err(|_| "数据库状态锁定失败".to_string())?;
        let shops = shop_ids
            .iter()
            .map(|shop_id| {
                let shop = db.get_shop(shop_id).map_err(to_string)?;
                let ozon_api_key = db.shop_api_key(shop_id).map_err(to_string)?;
                let (shop, oss_secret) = db
                    .shop_with_effective_oss(shop_id)
                    .map(|(effective_shop, secret)| (effective_shop, Some(secret)))
                    .unwrap_or((shop, None));
                Ok(batch::RuntimeShopConfig {
                    shop,
                    ozon_api_key,
                    oss_secret,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let cache_root = db
            .path()
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("local-mockup-cache");
        (shops, cache_root)
    };
    let job = state.jobs.create_job(
        JobKind::AutoListing,
        "云图库自动上架".into(),
        request.batch_id.clone(),
    );
    let jobs = state.jobs.clone();
    let job_id = job.id.clone();
    tauri::async_runtime::spawn(auto_listing::run_auto_listing(
        jobs, job_id, request, shops, cache_root,
    ));
    Ok(job)
}

#[tauri::command]
pub fn start_local_mockup_render(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: LocalMockupRenderRequest,
) -> Result<JobSummary, String> {
    if request.template_id.trim().is_empty() {
        return Err("请选择要使用的样机".into());
    }
    if request.assets.is_empty() {
        return Err("请选择要套图的图片".into());
    }
    let cache_root = {
        let db = state
            .db
            .lock()
            .map_err(|_| "数据库状态锁定失败".to_string())?;
        db.path()
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("local-mockup-cache")
    };
    let bundled_template_root = app
        .path()
        .resource_dir()
        .ok()
        .map(|path| path.join("mockup-templates"));
    let job = state.jobs.create_job(
        JobKind::LocalMockup,
        format!(
            "本地后台套图：{} 张 / {}",
            request.assets.len(),
            request
                .template_name
                .as_deref()
                .unwrap_or(request.template_id.as_str())
        ),
        Some(request.template_id.clone()),
    );
    let jobs = state.jobs.clone();
    let job_id = job.id.clone();
    tauri::async_runtime::spawn(local_mockup::run_local_mockup_render(
        jobs,
        job_id,
        request,
        cache_root,
        bundled_template_root,
    ));
    Ok(job)
}

#[tauri::command]
pub fn read_local_mockup_result(result_path: String) -> Result<LocalMockupRenderResult, String> {
    local_mockup::read_result(Path::new(&result_path)).map_err(to_string)
}

#[tauri::command]
pub fn start_listing_image_repair(
    state: State<'_, AppState>,
    request: ListingImageRepairRequest,
) -> Result<JobSummary, String> {
    validate_listing_image_repair_request(&request)?;
    let shop_ids = request
        .items
        .iter()
        .map(|item| item.external_shop_id.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<HashSet<_>>();
    let shops = {
        let db = state
            .db
            .lock()
            .map_err(|_| "数据库状态锁定失败".to_string())?;
        shop_ids
            .iter()
            .map(|shop_id| {
                let shop = db.get_shop(shop_id).map_err(to_string)?;
                let ozon_api_key = db.shop_api_key(shop_id).map_err(to_string)?;
                Ok(batch::RuntimeShopConfig {
                    shop,
                    ozon_api_key,
                    oss_secret: None,
                })
            })
            .collect::<Result<Vec<_>, String>>()?
    };
    let job = state.jobs.create_job(
        JobKind::ListingImageRepair,
        "历史商品图片修复".into(),
        Some(format!("{} items", request.items.len())),
    );
    let jobs = state.jobs.clone();
    let job_id = job.id.clone();
    tauri::async_runtime::spawn(listing_image_repair::run_listing_image_repair(
        jobs, job_id, request, shops,
    ));
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
                &if request.generate_ai_images
                    && !request.convert_originals
                    && !request.generate_copy
                {
                    format!("将处理 {} 个 SKU 的首张图片", report.sku_count)
                } else {
                    format!(
                        "将处理 {} 个 SKU、{} 张图片",
                        report.sku_count, report.image_count
                    )
                },
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
    if request.generate_ai_images
        && !provider_secret_exists("image", &request.image_provider, &request)
    {
        issues.push(issue(
            "error",
            "AI 图片",
            &ai_key_missing_message(&request.image_provider),
            "",
            "",
        ));
    }
    if request.generate_copy && !text_provider_secret_exists(&request) {
        issues.push(issue(
            "error",
            "AI 文案",
            &ai_key_missing_message(&request.text_provider),
            "",
            "",
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
    let shops = shops_for_preflight(&state, &request.shop_ids, false, &mut issues)?;
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
    check_shop_watermarks(&shops, &mut issues);
    if request
        .cloud_api_base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
        || request
            .cloud_auth_token
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
    {
        issues.push(issue(
            "error",
            "统一 OSS",
            "请先登录云端会员账号后使用统一 OSS 上架",
            "登录会员账号",
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

fn validate_auto_listing_request(request: &AutoListingRequest) -> Result<(), String> {
    if request.items.is_empty() {
        return Err("请先选择要自动上架的图片".into());
    }
    if request.shop_configs.is_empty() {
        return Err("请至少配置一个店铺的自动上架参数".into());
    }
    let shop_ids = request
        .shop_configs
        .iter()
        .map(|config| config.shop_id.as_str())
        .collect::<HashSet<_>>();
    for config in &request.shop_configs {
        if config.shop_id.trim().is_empty() {
            return Err("店铺不能为空".into());
        }
        if config.template_product.is_none() {
            return Err("请先为每个店铺选择本地 Ozon 商品模板".into());
        }
        if config.auto_update_stock {
            if config.auto_warehouse_id.is_none() {
                return Err("启用自动补库存后，请先选择仓库".into());
            }
            if config.auto_stock.unwrap_or_default() < 0 {
                return Err("自动库存数量不能小于 0".into());
            }
        }
        if config.auto_add_to_action {
            if config.auto_action_id.is_none() {
                return Err("启用自动参加活动后，请先选择活动".into());
            }
            if config.auto_action_stock.unwrap_or_default() <= 0 {
                return Err("活动库存必须大于 0".into());
            }
            if config.action_retry_count.unwrap_or(6) <= 0 {
                return Err("活动重试次数必须大于 0".into());
            }
            if config.action_retry_interval_minutes.unwrap_or(30) <= 0 {
                return Err("活动重试间隔必须大于 0 分钟".into());
            }
        }
    }
    for item in &request.items {
        if item.source_sku.trim().is_empty() {
            return Err("存在空货号，不能自动上架".into());
        }
        if item.title.trim().is_empty() {
            return Err(format!("{} 还没有标题，请先生成标题", item.source_sku));
        }
        if item.image_urls.is_empty() {
            return Err(format!("{} 还没有套图图片", item.source_sku));
        }
        if !shop_ids.contains(item.shop_id.as_str()) {
            return Err(format!("{} 分配的店铺没有自动上架配置", item.source_sku));
        }
    }
    Ok(())
}

fn validate_listing_image_repair_request(
    request: &ListingImageRepairRequest,
) -> Result<(), String> {
    if request.items.is_empty() {
        return Err("没有可修复图片链接的历史商品".into());
    }
    if request.items.len() > 2000 {
        return Err("单次历史图片修复最多处理 2000 个商品，请分批执行".into());
    }
    for item in &request.items {
        if item.external_shop_id.trim().is_empty() {
            return Err("历史图片修复存在空店铺 ID".into());
        }
        if item.source_sku.trim().is_empty() {
            return Err("历史图片修复存在空货号".into());
        }
        if item.image_urls.iter().all(|url| url.trim().is_empty()) {
            return Err(format!("{} 没有可提交给 Ozon 的图片链接", item.source_sku));
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
    let update_selected = request.update_title
        || request.update_description
        || request.update_images
        || request.update_video
        || request.update_rich_json;
    let shops = shops_for_preflight(
        &state,
        std::slice::from_ref(&request.shop_id),
        false,
        &mut issues,
    )?;
    if let Some(category) = request.category_update.as_ref() {
        if category.category_id <= 0 {
            issues.push(issue(
                "error",
                "商品分类",
                "请先选择要更新的商品分类",
                "选择分类",
                "ozon",
            ));
        }
    } else {
        check_listed_update_excel(
            &request.excel_path,
            request.max_items,
            update_requires_full_excel(&request),
            &mut issues,
        );
        if request.update_images {
            check_update_image_directory(
                &request.excel_path,
                &request.portrait_root,
                request.max_items,
                &mut issues,
            );
        }
    }
    if !update_selected {
        issues.push(issue(
            "error",
            "更新项",
            "至少选择一个更新项",
            "选择更新项",
            "ozon",
        ));
    }
    if request.update_video && clean_strings(request.template_video_links.clone()).is_empty() {
        issues.push(issue(
            "error",
            "视频链接",
            "更新视频时请至少填写一个 http/https 视频链接",
            "填写视频链接",
            "ozon",
        ));
    }
    if let Some((shop, api_key)) = shops.first() {
        match OzonSellerClient::new(shop.client_id.clone(), api_key.clone()) {
            Ok(client) => {
                if let Some(category) = request.category_update.as_ref() {
                    match client
                        .list_products_by_category(category.category_id, category.type_id, 1)
                        .await
                    {
                        Ok(rows) if rows.is_empty() => issues.push(issue(
                            "warn",
                            "商品分类",
                            "所选分类当前没有查询到商品，提交后可能不会更新任何商品",
                            "检查分类",
                            "ozon",
                        )),
                        Ok(_) => {}
                        Err(error) => issues.push(issue(
                            "warn",
                            "商品分类",
                            &format!("抽样拉取类目商品失败：{}", error),
                            "测试 Ozon",
                            "ozon",
                        )),
                    }
                } else if let Ok(rows) = read_listed_update_rows(&request) {
                    let offer_ids = rows
                        .into_iter()
                        .take(20)
                        .map(|row| row.sku)
                        .filter(|sku| !sku.trim().is_empty())
                        .collect::<Vec<_>>();
                    if !offer_ids.is_empty() {
                        if let Err(error) = client.product_info(offer_ids).await {
                            issues.push(issue(
                                "warn",
                                "线上商品",
                                &format!("抽样拉取线上商品失败：{}", error),
                                "测试 Ozon",
                                "ozon",
                            ));
                        }
                    }
                }
            }
            Err(error) => issues.push(issue(
                "error",
                "Ozon",
                &error.to_string(),
                "去店铺管理",
                "ozon",
            )),
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
        db.shop_with_effective_oss(&shop_id).map_err(to_string)?
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
        let (shop, oss_secret) = db
            .shop_with_effective_oss(&request.shop_id)
            .map(|(effective_shop, secret)| (effective_shop, Some(secret)))
            .unwrap_or((shop, None));
        batch::RuntimeShopConfig {
            shop,
            ozon_api_key,
            oss_secret,
        }
    };
    let task_title = listed_update_job_title(&request, &runtime.shop.name);
    let task_input = listed_update_job_input(&request, &runtime.shop.name);
    let job = state
        .jobs
        .create_job(JobKind::ListedUpdate, task_title, task_input);
    let jobs = state.jobs.clone();
    let job_id = job.id.clone();
    tauri::async_runtime::spawn(batch::run_listed_update(jobs, job_id, request, runtime));
    Ok(job)
}

fn listed_update_job_title(request: &ListedUpdateRequest, shop_name: &str) -> String {
    if let Some(category) = request.category_update.as_ref() {
        let action = if request.update_video
            && !request.update_title
            && !request.update_description
            && !request.update_images
            && !request.update_rich_json
        {
            "全类目视频更新"
        } else {
            "全类目商品更新"
        };
        return format!(
            "{} - {} - {}",
            action,
            shop_name,
            category.category_name.as_deref().unwrap_or("未命名类目")
        );
    }
    format!("按货号更新已上架商品 - {shop_name}")
}

fn listed_update_job_input(request: &ListedUpdateRequest, shop_name: &str) -> Option<String> {
    request.category_update.as_ref().map_or_else(
        || Some(request.excel_path.clone()),
        |category| {
            Some(format!(
                "{} / 类目:{} / 类型:{}",
                shop_name,
                category.category_id,
                category
                    .type_id
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "-".into())
            ))
        },
    )
}

#[tauri::command]
pub fn reserve_order_shipping_labels(
    state: State<'_, AppState>,
    assignments: Vec<OrderShippingLabelAssignment>,
) -> Result<(), String> {
    if assignments.is_empty() {
        return Err("请至少提供一个物流贴单地址".into());
    }
    let db = state
        .db
        .lock()
        .map_err(|_| "数据库状态锁定失败".to_string())?;
    db.reserve_order_shipping_labels(&assignments)
        .map_err(to_string)
}

#[tauri::command]
pub async fn download_order_shipping_labels(
    state: State<'_, AppState>,
    request: OrderShippingLabelDownloadRequest,
) -> Result<(), String> {
    let db_path = state
        .db
        .lock()
        .map_err(|_| "数据库状态锁定失败".to_string())?
        .path();
    order_docs::download_shipping_labels(&request, db_path)
        .await
        .map_err(to_string)
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
    if request
        .ozon_seller_har_path
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .is_empty()
        && request
            .ozon_seller_cookie_path
            .as_deref()
            .map(str::trim)
            .unwrap_or_default()
            .is_empty()
    {
        let db = state
            .db
            .lock()
            .map_err(|_| "数据库状态锁定失败".to_string())?;
        if let Ok(cookie) = db.shop_seller_cookie(&request.shop_id) {
            request.ozon_seller_cookie_path = Some(cookie);
        }
    }
    order_docs::validate_request(&request).map_err(to_string)?;
    {
        let assignments = request
            .shipping_labels
            .iter()
            .map(|label| OrderShippingLabelAssignment {
                shop_id: request.shop_id.clone(),
                order_number: label.order_number.clone(),
                url: label.url.clone(),
            })
            .collect::<Vec<_>>();
        let db = state
            .db
            .lock()
            .map_err(|_| "数据库状态锁定失败".to_string())?;
        db.reserve_order_shipping_labels(&assignments)
            .map_err(to_string)?;
    }
    let job = state.jobs.create_job(
        JobKind::OrderDocuments,
        "订单文件下载".into(),
        Some(request.order_numbers.join(",")),
    );
    let jobs = state.jobs.clone();
    let db_path = state
        .db
        .lock()
        .map_err(|_| "数据库状态锁定失败".to_string())?
        .path();
    let job_id = job.id.clone();
    tauri::async_runtime::spawn(order_docs::run_order_documents_job(
        jobs, job_id, request, client, db_path,
    ));
    Ok(job)
}

#[tauri::command]
pub fn save_shop_seller_cookie(
    state: State<'_, AppState>,
    shop_id: String,
    cookie: String,
) -> Result<Shop, String> {
    if shop_id.trim().is_empty() {
        return Err("请先选择店铺".into());
    }
    let normalized = crate::core::ozon_seller_web::normalize_cookie_input(&cookie)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "请粘贴 Ozon 后台 Cookie".to_string())?;
    let db = state
        .db
        .lock()
        .map_err(|_| "数据库状态锁定失败".to_string())?;
    db.save_shop_seller_cookie(&shop_id, &normalized)
        .map_err(to_string)
}

#[tauri::command]
pub async fn list_order_postings(
    state: State<'_, AppState>,
    request: OrderListRequest,
) -> Result<Vec<OrderPostingRow>, String> {
    if request.shop_id.trim().is_empty() {
        return Err("请先选择店铺".into());
    }
    let shop = {
        let db = state
            .db
            .lock()
            .map_err(|_| "数据库状态锁定失败".to_string())?;
        db.get_shop(&request.shop_id).map_err(to_string)?
    };
    let ranges = order_date_ranges(&request.date_from, &request.date_to)?;
    let status = request.status.clone().unwrap_or_default();
    let limit = request.limit.unwrap_or(100).clamp(1, 5000);
    let client = ozon_client(&state, &request.shop_id)?;
    let mut rows_by_key: HashMap<String, OrderPostingRow> = HashMap::new();
    let mut errors = Vec::new();
    for (since, to) in ranges {
        match client
            .fbs_posting_list(since.clone(), to.clone(), status.clone(), limit)
            .await
        {
            Ok(rows) => {
                for row in rows {
                    rows_by_key.insert(
                        format!(
                            "{}::{}",
                            row.posting_kind.as_deref().unwrap_or("fbs"),
                            row.posting_number
                        ),
                        row,
                    );
                }
            }
            Err(error) => errors.push(format!("FBS {since} - {to}: {error}")),
        }
        match client
            .fbo_posting_list(since.clone(), to.clone(), status.clone(), limit)
            .await
        {
            Ok(rows) => {
                for row in rows {
                    rows_by_key.insert(
                        format!(
                            "{}::{}",
                            row.posting_kind.as_deref().unwrap_or("fbo"),
                            row.posting_number
                        ),
                        row,
                    );
                }
            }
            Err(error) => errors.push(format!("FBO {since} - {to}: {error}")),
        }
        if rows_by_key.len() >= limit as usize {
            break;
        }
    }
    if rows_by_key.is_empty() && !errors.is_empty() {
        return Err(format!("订单同步失败：{}", errors.join("；")).into());
    }
    let mut rows = rows_by_key.into_values().collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        let left_time = left
            .in_process_at
            .as_deref()
            .or(left.shipment_date.as_deref())
            .unwrap_or_default();
        let right_time = right
            .in_process_at
            .as_deref()
            .or(right.shipment_date.as_deref())
            .unwrap_or_default();
        right_time.cmp(left_time)
    });
    rows.truncate(limit as usize);
    if let Err(error) = client.enrich_order_posting_images(&mut rows).await {
        eprintln!("订单商品主图补齐失败: {error:#}");
    }
    let synced_at = chrono::Utc::now().to_rfc3339();
    for row in &mut rows {
        row.shop_id = Some(shop.id.clone());
        row.shop_name = Some(shop.name.clone());
        row.synced_at = Some(synced_at.clone());
    }
    {
        let db = state
            .db
            .lock()
            .map_err(|_| "数据库状态锁定失败".to_string())?;
        db.save_order_postings(&rows).map_err(to_string)?;
    }
    Ok(rows)
}

#[tauri::command]
pub fn list_saved_order_postings(
    state: State<'_, AppState>,
    query: StoredOrderQuery,
) -> Result<Vec<OrderPostingRow>, String> {
    let db = state
        .db
        .lock()
        .map_err(|_| "数据库状态锁定失败".to_string())?;
    db.list_saved_order_postings(query).map_err(to_string)
}

#[tauri::command]
pub async fn ship_order_posting(
    state: State<'_, AppState>,
    shop_id: String,
    posting_number: String,
) -> Result<OrderPostingRow, String> {
    if shop_id.trim().is_empty() {
        return Err("请先选择店铺".into());
    }
    let posting_number = posting_number.trim().to_string();
    if posting_number.is_empty() {
        return Err("请先选择要备货的货件".into());
    }
    let shop = {
        let db = state
            .db
            .lock()
            .map_err(|_| "数据库状态锁定失败".to_string())?;
        db.get_shop(&shop_id).map_err(to_string)?
    };
    let client = ozon_client(&state, &shop_id)?;
    client
        .ship_fbs_posting(&posting_number)
        .await
        .map_err(to_string)?;
    let mut row = client
        .fbs_posting_row(&posting_number)
        .await
        .map_err(to_string)?;
    row.shop_id = Some(shop.id.clone());
    row.shop_name = Some(shop.name.clone());
    row.synced_at = Some(chrono::Utc::now().to_rfc3339());
    {
        let db = state
            .db
            .lock()
            .map_err(|_| "数据库状态锁定失败".to_string())?;
        db.save_order_posting(&row).map_err(to_string)?;
    }
    Ok(row)
}

#[tauri::command]
pub fn start_follow_sync(
    state: State<'_, AppState>,
    shop_id: String,
    price_multiplier: Option<f64>,
) -> Result<JobSummary, String> {
    if shop_id.trim().is_empty() {
        return Err("请先选择店铺".into());
    }
    let price_multiplier = validate_follow_price_multiplier(price_multiplier)?;
    let pairs = {
        let db = state
            .db
            .lock()
            .map_err(|_| "数据库状态锁定失败".to_string())?;
        follow_pairs_for_shop(&db, &shop_id)?
    };

    let job = state
        .jobs
        .create_job(JobKind::FollowSync, "跟卖商品同步".into(), Some(shop_id));
    let jobs = state.jobs.clone();
    let job_id = job.id.clone();
    tauri::async_runtime::spawn(follow::run_follow_sync(
        jobs,
        job_id,
        pairs,
        price_multiplier,
    ));
    Ok(job)
}

#[tauri::command]
pub fn start_follow_automation(
    state: State<'_, AppState>,
    request: FollowAutomationRequest,
) -> Result<JobSummary, String> {
    if request.shop_id.trim().is_empty() {
        return Err("请先选择店铺".into());
    }
    let pairs = {
        let db = state
            .db
            .lock()
            .map_err(|_| "数据库状态锁定失败".to_string())?;
        follow_pairs_for_shop(&db, &request.shop_id)?
    };
    validate_follow_automation_request(&request)?;

    let job = state.jobs.create_job(
        JobKind::FollowAutomation,
        "跟卖自动化".into(),
        Some(request.shop_id.clone()),
    );
    let jobs = state.jobs.clone();
    let job_id = job.id.clone();
    tauri::async_runtime::spawn(follow::run_follow_automation(jobs, job_id, pairs, request));
    Ok(job)
}

#[tauri::command]
pub fn start_listing_maintenance(
    state: State<'_, AppState>,
    request: ListingMaintenanceRequest,
) -> Result<JobSummary, String> {
    if request.shop_id.trim().is_empty() {
        return Err("请先选择店铺".into());
    }
    if let Some(job) = state.jobs.list_jobs().into_iter().find(|job| {
        job.kind == JobKind::ListingMaintenance
            && matches!(
                job.status,
                crate::core::models::JobStatus::Queued | crate::core::models::JobStatus::Running
            )
            && job.input_path.as_deref() == Some(request.shop_id.as_str())
    }) {
        state.jobs.log(
            &job.id,
            "warn",
            "收到新的店铺自动运维启动请求，旧任务将停止，并使用最新配置重新启动。",
        );
        state.jobs.cancel(&job.id);
    }
    let (runtime_shop, effective_request) = {
        let db = state
            .db
            .lock()
            .map_err(|_| "数据库状态锁定失败".to_string())?;
        let shop = db.get_shop(&request.shop_id).map_err(to_string)?;
        let ozon_api_key = db.shop_api_key(&shop.id).map_err(to_string)?;
        let configured_action_enabled =
            shop.maintenance_action_enabled || !shop.maintenance_action_configs.is_empty();
        let request_has_enabled_module = request.auto_update_stock
            || request.auto_generate_barcode
            || request.auto_add_to_action;
        let effective_request = ListingMaintenanceRequest {
            interval_minutes: if request.interval_minutes > 0 {
                request.interval_minutes
            } else {
                shop.maintenance_interval_minutes.unwrap_or(5)
            },
            auto_update_stock: if request_has_enabled_module {
                request.auto_update_stock
            } else {
                shop.maintenance_stock_enabled
            },
            auto_generate_barcode: if request_has_enabled_module {
                request.auto_generate_barcode
            } else {
                shop.maintenance_barcode_enabled
            },
            auto_add_to_action: if request_has_enabled_module {
                request.auto_add_to_action
            } else {
                configured_action_enabled
            },
            warehouse_id: request.warehouse_id.or(shop.maintenance_warehouse_id),
            stock: request.stock.or(shop.maintenance_stock).or(Some(50)),
            action_configs: if request.action_configs.is_empty() {
                shop.maintenance_action_configs.clone()
            } else {
                request.action_configs.clone()
            },
            ..request.clone()
        };
        (
            batch::RuntimeShopConfig {
                shop,
                ozon_api_key,
                oss_secret: None,
            },
            effective_request,
        )
    };
    validate_listing_maintenance_request(&effective_request)?;

    let job = state.jobs.create_job(
        JobKind::ListingMaintenance,
        "店铺自动运维".into(),
        Some(effective_request.shop_id.clone()),
    );
    let jobs = state.jobs.clone();
    let job_id = job.id.clone();
    tauri::async_runtime::spawn(listing_maintenance::run_listing_maintenance(
        jobs,
        job_id,
        effective_request,
        runtime_shop,
    ));
    Ok(job)
}

fn follow_pairs_for_shop(
    db: &Database,
    shop_id: &str,
) -> Result<Vec<follow::FollowSyncPair>, String> {
    let shops = db.list_shops().map_err(to_string)?;
    let selected = shops
        .iter()
        .find(|shop| shop.id == shop_id)
        .cloned()
        .ok_or_else(|| "未找到店铺".to_string())?;
    let runtime_for = |shop: &Shop| -> Result<follow::RuntimeOzonShop, String> {
        let (effective_shop, oss_secret) = db
            .shop_with_effective_oss(&shop.id)
            .unwrap_or_else(|_| (shop.clone(), String::new()));
        Ok(follow::RuntimeOzonShop {
            shop: effective_shop,
            ozon_api_key: db.shop_api_key(&shop.id).map_err(to_string)?,
            oss_secret: (!oss_secret.is_empty()).then_some(oss_secret),
        })
    };

    if selected.shop_role.as_deref() == Some("follower") {
        let main_id = selected
            .follows_shop_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "当前跟卖店铺未选择主店".to_string())?;
        let main = shops
            .iter()
            .find(|shop| shop.id == main_id)
            .ok_or_else(|| "未找到跟卖店铺关联的主店".to_string())?;
        return Ok(vec![follow::FollowSyncPair {
            main: runtime_for(main)?,
            follower: runtime_for(&selected)?,
        }]);
    }

    let followers = shops
        .iter()
        .filter(|shop| {
            shop.shop_role.as_deref() == Some("follower")
                && shop.follows_shop_id.as_deref() == Some(selected.id.as_str())
        })
        .collect::<Vec<_>>();
    if followers.is_empty() {
        return Err("当前主店下没有跟卖店铺".into());
    }
    followers
        .into_iter()
        .map(|follower| {
            Ok(follow::FollowSyncPair {
                main: runtime_for(&selected)?,
                follower: runtime_for(follower)?,
            })
        })
        .collect()
}

fn validate_follow_automation_request(request: &FollowAutomationRequest) -> Result<(), String> {
    if !(request.auto_follow_sync
        || request.auto_update_stock
        || request.auto_generate_barcode
        || request.auto_add_to_action)
    {
        return Err("请至少选择一个自动执行任务".into());
    }
    if request.interval_minutes <= 0 {
        return Err("定时间隔必须大于 0 分钟".into());
    }
    if request.max_follow_items.is_some_and(|value| value < 0) {
        return Err("跟卖上架上限不能小于 0".into());
    }
    validate_follow_price_multiplier(Some(request.price_multiplier))?;
    if request.auto_update_stock {
        if request.stock.unwrap_or_default() < 0 {
            return Err("自动补库存数量不能小于 0".into());
        }
    }
    if request.auto_add_to_action {
        if request.action_id.is_none() {
            return Err("启用自动添加活动后，请先选择活动".into());
        }
        if request.action_stock.unwrap_or_default() <= 0 {
            return Err("活动库存必须大于 0".into());
        }
    }
    Ok(())
}

fn validate_listing_maintenance_request(request: &ListingMaintenanceRequest) -> Result<(), String> {
    if request.shop_id.trim().is_empty() {
        return Err("请先选择店铺".into());
    }
    if !(request.auto_update_stock || request.auto_generate_barcode || request.auto_add_to_action) {
        return Err("请至少选择库存、条码或活动中的一个自动运维任务".into());
    }
    if request.interval_minutes <= 0 {
        return Err("定时执行间隔必须大于 0 分钟".into());
    }
    if request.auto_update_stock && request.stock.unwrap_or(50) < 0 {
        return Err("自动补库存数量不能小于 0".into());
    }
    if request.auto_add_to_action {
        if request.action_configs.is_empty() {
            return Err("启用自动参加活动后，请至少配置一条类目活动规则".into());
        }
        for config in &request.action_configs {
            if config.category_id <= 0 {
                return Err("活动规则缺少类目".into());
            }
            if config.action_id <= 0 {
                return Err("活动规则缺少活动".into());
            }
            if config.action_price.trim().is_empty() {
                return Err("活动规则缺少活动价格".into());
            }
            if config.action_stock <= 0 {
                return Err("活动库存必须大于 0".into());
            }
        }
    }
    Ok(())
}

fn validate_follow_price_multiplier(value: Option<f64>) -> Result<f64, String> {
    let multiplier = value.unwrap_or(follow::DEFAULT_FOLLOW_PRICE_MULTIPLIER);
    if !multiplier.is_finite() {
        return Err("跟卖价格倍率不是有效数字".into());
    }
    if !(2.0..=10.0).contains(&multiplier) {
        return Err("跟卖价格倍率只能设置为 2 到 10 倍".into());
    }
    Ok(multiplier)
}

#[tauri::command]
pub fn start_materials_job(
    state: State<'_, AppState>,
    request: MaterialsRequest,
) -> Result<JobSummary, String> {
    let title = if request.generate_ai_images
        && !request.convert_originals
        && !request.generate_copy
    {
        "GPT 图片生成"
    } else if request.convert_originals && !request.generate_copy && !request.generate_ai_images {
        "转 3:4 + 水印"
    } else if request.generate_copy && !request.convert_originals && !request.generate_ai_images {
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
pub fn scan_gallery_upload_files(paths: Vec<String>) -> Result<GalleryUploadSelection, String> {
    gallery_upload::scan_image_files(paths).map_err(to_string)
}

#[tauri::command]
pub fn start_gallery_upload_job(
    state: State<'_, AppState>,
    request: GalleryUploadRequest,
) -> Result<JobSummary, String> {
    if request.paths.is_empty() {
        return Err("请先选择要上传的图片或文件夹".into());
    }
    let source = request
        .source_label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("客户端选择图片");
    let job = state.jobs.create_job(
        JobKind::GalleryUpload,
        format!("云图库图片上传 - {source}"),
        Some(source.to_string()),
    );
    let db_path = state
        .db
        .lock()
        .map_err(|_| "数据库状态锁定失败".to_string())?
        .path();
    if let Err(error) = gallery_upload::persist_gallery_upload_job(&db_path, &job.id, &request) {
        state.jobs.fail(&job.id, error.to_string());
        return Err(error.to_string());
    }
    let jobs = state.jobs.clone();
    let job_id = job.id.clone();
    tauri::async_runtime::spawn(gallery_upload::run_persisted_gallery_upload_job(
        jobs, db_path, job_id,
    ));
    Ok(job)
}

#[tauri::command]
pub async fn list_ai_models(
    base_url: String,
    provider: String,
    cloud_auth_token: Option<String>,
    kind: Option<String>,
) -> Result<Vec<String>, String> {
    if ai::is_cloud_proxy_provider(&provider) {
        let token = cloud_auth_token
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "请先登录会员账号，再刷新云端 AI 模型".to_string())?;
        return ai::OpenAiCompatibleClient::new_cloud_proxy(
            base_url,
            token,
            kind.unwrap_or_else(|| "text".to_string()),
        )
        .map_err(to_string)?
        .list_models()
        .await
        .map_err(to_string);
    }
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
    let input_path = request
        .single_image
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .or_else(|| Some(request.source_root.clone()));
    let job = state
        .jobs
        .create_job(JobKind::SceneLocal, "本地场景图合成".into(), input_path);
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
    let persisted = state
        .db
        .lock()
        .map_err(|_| "数据库状态锁定失败".to_string())?
        .list_job_logs(&job_id)
        .map_err(to_string)?;
    if !persisted.is_empty() {
        return Ok(persisted);
    }
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
    #[cfg(target_os = "macos")]
    return pick_with_osascript(r#"POSIX path of (choose folder)"#);

    #[cfg(target_os = "windows")]
    return pick_with_powershell(
        r#"
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '请选择目录'
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::WriteLine($dialog.SelectedPath)
}
"#,
    );

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    Err("目录选择功能暂不支持当前系统，请手动输入路径".into())
}

#[tauri::command]
pub fn pick_file() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    return pick_with_osascript(r#"POSIX path of (choose file)"#);

    #[cfg(target_os = "windows")]
    return pick_with_powershell(
        r#"
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.CheckFileExists = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::WriteLine($dialog.FileName)
}
"#,
    );

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    Err("文件选择功能暂不支持当前系统，请手动输入路径".into())
}

#[tauri::command]
pub fn pick_image_files() -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    return pick_images_with_powershell();

    #[cfg(target_os = "macos")]
    return pick_images_with_osascript();

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    Err("多图片选择功能暂不支持当前系统，请选择文件夹上传".into())
}

#[cfg(target_os = "macos")]
fn pick_with_osascript(script: &str) -> Result<String, String> {
    let output = std::process::Command::new("osascript")
        .args(["-e", script])
        .output()
        .map_err(|e| format!("无法打开文件对话框: {}", e))?;
    pick_output_to_path(output)
}

#[cfg(target_os = "windows")]
fn pick_with_powershell(script: &str) -> Result<String, String> {
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-STA", "-Command", script])
        .output()
        .map_err(|e| format!("无法打开文件对话框: {}", e))?;
    pick_output_to_path(output)
}

#[cfg(target_os = "windows")]
fn pick_images_with_powershell() -> Result<Vec<String>, String> {
    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-STA",
            "-Command",
            r#"
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.CheckFileExists = $true
$dialog.Multiselect = $true
$dialog.Filter = '图片文件|*.png;*.jpg;*.jpeg;*.webp|所有文件|*.*'
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  foreach ($file in $dialog.FileNames) {
    [Console]::WriteLine($file)
  }
}
"#,
        ])
        .output()
        .map_err(|e| format!("无法打开图片选择对话框: {}", e))?;
    pick_output_to_paths(output)
}

#[cfg(target_os = "macos")]
fn pick_images_with_osascript() -> Result<Vec<String>, String> {
    let output = std::process::Command::new("osascript")
        .args([
            "-e",
            r#"set pickedFiles to choose file of type {"public.png", "public.jpeg", "org.webmproject.webp"} with multiple selections allowed"#,
            "-e",
            r#"set output to "" "#,
            "-e",
            r#"repeat with pickedFile in pickedFiles"#,
            "-e",
            r#"set output to output & POSIX path of pickedFile & linefeed"#,
            "-e",
            r#"end repeat"#,
            "-e",
            r#"return output"#,
        ])
        .output()
        .map_err(|e| format!("无法打开图片选择对话框: {}", e))?;
    pick_output_to_paths(output)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn pick_output_to_path(output: std::process::Output) -> Result<String, String> {
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            return Err("无法打开文件对话框".into());
        }
        return Err(format!("无法打开文件对话框: {stderr}"));
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        Err("用户取消了选择".into())
    } else {
        Ok(path)
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn pick_output_to_paths(output: std::process::Output) -> Result<Vec<String>, String> {
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            return Err("无法打开图片选择对话框".into());
        }
        return Err(format!("无法打开图片选择对话框: {stderr}"));
    }
    let paths = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    if paths.is_empty() {
        Err("用户取消了选择".into())
    } else {
        Ok(paths)
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

fn order_date_ranges(date_from: &str, date_to: &str) -> Result<Vec<(String, String)>, String> {
    order_date_ranges_with_offset(date_from, date_to, chrono::Local::now().offset().fix())
}

fn order_date_ranges_with_offset(
    date_from: &str,
    date_to: &str,
    offset: chrono::FixedOffset,
) -> Result<Vec<(String, String)>, String> {
    let from = chrono::NaiveDate::parse_from_str(date_from.trim(), "%Y-%m-%d")
        .map_err(|_| "订单开始日期格式不正确".to_string())?;
    let to = chrono::NaiveDate::parse_from_str(date_to.trim(), "%Y-%m-%d")
        .map_err(|_| "订单结束日期格式不正确".to_string())?;
    if from > to {
        return Err("订单开始日期不能晚于结束日期".into());
    }
    let mut ranges = Vec::new();
    let mut cursor = from;
    while cursor <= to {
        let range_to = std::cmp::min(cursor + chrono::Duration::days(364), to);
        let since = local_order_boundary_to_utc(
            cursor
                .and_hms_milli_opt(0, 0, 0, 0)
                .ok_or_else(|| "订单开始日期无效".to_string())?,
            offset,
        )?;
        let until = local_order_boundary_to_utc(
            range_to
                .and_hms_milli_opt(23, 59, 59, 999)
                .ok_or_else(|| "订单结束日期无效".to_string())?,
            offset,
        )?;
        ranges.push((since, until));
        cursor = range_to + chrono::Duration::days(1);
    }
    Ok(ranges)
}

fn local_order_boundary_to_utc(
    value: chrono::NaiveDateTime,
    offset: chrono::FixedOffset,
) -> Result<String, String> {
    offset
        .from_local_datetime(&value)
        .single()
        .ok_or_else(|| "订单日期时区转换失败".to_string())
        .map(|date| date.with_timezone(&chrono::Utc).to_rfc3339())
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

fn provider_secret_exists(kind: &str, provider: &str, request: &MaterialsRequest) -> bool {
    if ai::is_cloud_proxy_provider(provider) {
        return request
            .cloud_auth_token
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty());
    }
    secrets::get_secret(&secrets::provider_api_key_id(kind, provider)).is_ok()
}

fn text_provider_secret_exists(request: &MaterialsRequest) -> bool {
    if ai::is_ollama_provider(&request.text_provider) {
        return true;
    }
    provider_secret_exists("text", &request.text_provider, request)
        || (request.text_provider == request.image_provider
            && provider_secret_exists("image", &request.image_provider, request))
}

fn ai_key_missing_message(provider: &str) -> String {
    if ai::is_cloud_proxy_provider(provider) {
        "请先登录会员账号，再使用云端 AI 功能".to_string()
    } else {
        "AI Key 未保存".to_string()
    }
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
                        "去店铺管理",
                        "ozon",
                    )),
                }
                if require_oss {
                    let missing_oss = db.shop_with_effective_oss(shop_id).is_err();
                    if missing_oss {
                        issues.push(issue(
                            "error",
                            &shop.name,
                            "OSS 配置不完整，请先在主店配置 OSS",
                            "去店铺管理",
                            "ozon",
                        ));
                    }
                }
            }
            Err(error) => issues.push(issue(
                "error",
                "店铺",
                &error.to_string(),
                "去店铺管理",
                "ozon",
            )),
        }
    }
    Ok(shops)
}

fn check_shop_watermarks(shops: &[(Shop, String)], issues: &mut Vec<PreflightIssue>) {
    for (shop, _) in shops {
        let Some(path) = shop
            .watermark_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            issues.push(issue(
                "error",
                &shop.name,
                "店铺水印图片未配置，上架前必须先设置每店水印",
                "去店铺管理",
                "ozon",
            ));
            continue;
        };
        if !PathBuf::from(path).is_file() {
            issues.push(issue(
                "error",
                &shop.name,
                &format!("店铺水印图片不存在: {path}"),
                "去店铺管理",
                "ozon",
            ));
        }
    }
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
            &format!(
                "{} 个 Excel SKU 没有对应图片文件夹，开始后会自动跳过",
                missing_images
            ),
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

fn update_requires_full_excel(request: &ListedUpdateRequest) -> bool {
    request.update_title || request.update_description || request.update_rich_json
}

fn read_listed_update_rows(request: &ListedUpdateRequest) -> anyhow::Result<Vec<ContentRow>> {
    if update_requires_full_excel(request) {
        excel::read_content_rows(Path::new(&request.excel_path))
    } else {
        excel::read_sku_rows(Path::new(&request.excel_path))
    }
}

fn check_listed_update_excel(
    excel_path: &str,
    max_items: Option<i64>,
    require_full_excel: bool,
    issues: &mut Vec<PreflightIssue>,
) {
    let excel_path = PathBuf::from(excel_path);
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
    let mut rows = match if require_full_excel {
        excel::read_content_rows(&excel_path)
    } else {
        excel::read_sku_rows(&excel_path)
    } {
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
    let empty_title = rows
        .iter()
        .filter(|row| row.title.trim().is_empty())
        .count();
    issues.push(issue(
        "info",
        "Excel",
        &format!(
            "Excel {} 个 SKU{}",
            rows.len(),
            if require_full_excel {
                "，将读取标题/简介等内容"
            } else {
                "，本次只需要货号列"
            }
        ),
        "",
        "",
    ));
    if require_full_excel && empty_title > 0 {
        issues.push(issue(
            "warn",
            "Excel 文案",
            &format!("{} 个 SKU 缺少标题，更新标题时会沿用线上标题", empty_title),
            "检查 Excel",
            "ozon",
        ));
    }
}

fn check_update_image_directory(
    excel_path: &str,
    portrait_root: &str,
    max_items: Option<i64>,
    issues: &mut Vec<PreflightIssue>,
) {
    let excel_path = PathBuf::from(excel_path);
    let portrait_root = PathBuf::from(portrait_root);
    if !excel_path.is_file() {
        return;
    }
    if !portrait_root.is_dir() {
        issues.push(issue(
            "error",
            "图片目录",
            "勾选更新图片时必须选择图片目录",
            "选择目录",
            "ozon",
        ));
        return;
    }
    let mut rows = match excel::read_sku_rows(&excel_path) {
        Ok(rows) => rows,
        Err(_) => return,
    };
    if let Some(max_items) = max_items.filter(|value| *value > 0) {
        rows.truncate(max_items as usize);
    }
    if rows.is_empty() {
        return;
    }
    let sku_set = rows
        .iter()
        .map(|row| row.sku.trim().to_string())
        .collect::<HashSet<_>>();
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
    issues.push(issue(
        "info",
        "图片目录",
        &format!(
            "图片目录 {} 个 SKU、{} 张图片；本次只有勾选更新图片时才会使用",
            report.sku_count, report.image_count
        ),
        "",
        "",
    ));
    if missing_images > 0 {
        issues.push(issue(
            "warn",
            "SKU 匹配",
            &format!("{} 个 Excel SKU 没有对应图片文件夹", missing_images),
            "检查图片目录",
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

    #[test]
    fn order_date_ranges_use_local_day_boundaries() {
        let offset = chrono::FixedOffset::east_opt(8 * 60 * 60).unwrap();
        let ranges = order_date_ranges_with_offset("2026-07-11", "2026-07-11", offset).unwrap();

        assert_eq!(
            ranges,
            vec![(
                "2026-07-10T16:00:00+00:00".to_string(),
                "2026-07-11T15:59:59.999+00:00".to_string(),
            )]
        );
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
