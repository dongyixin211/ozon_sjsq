use crate::core::batch::RuntimeShopConfig;
use crate::core::jobs::JobRegistry;
use crate::core::models::{
    JobKind, JobStatus, ListingMaintenanceActionConfig, ListingMaintenanceRequest, OzonProductRow,
};
use crate::core::ozon::{extract_items, OzonSellerClient};
use anyhow::Result;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use tokio::time::{sleep, Duration};

pub const LISTING_MAINTENANCE_INTERVAL_MINUTES: i64 = 120;
const BATCH_SIZE: usize = 100;

static SCHEDULED_SHOPS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

pub async fn run_listing_maintenance(
    jobs: JobRegistry,
    job_id: String,
    request: ListingMaintenanceRequest,
    shop: RuntimeShopConfig,
) {
    let result = listing_maintenance_inner(&jobs, &job_id, request.clone(), shop.clone()).await;
    if jobs.is_cancelled(&job_id) {
        return;
    }
    match result {
        Ok(()) => {
            jobs.complete_with_output(&job_id, None);
            jobs.log(&job_id, "info", "本轮店铺自动运维已完成，任务已结束；下一轮将在 2 小时后创建新的任务。
");
        }
        Err(error) => {
            jobs.log(&job_id, "error", &format!("店铺自动运维失败：{error:#}"));
            jobs.fail(&job_id, format!("{error:#}"));
        }
    }
    schedule_next_cycle(jobs, request, shop);
}

fn schedule_next_cycle(
    jobs: JobRegistry,
    request: ListingMaintenanceRequest,
    shop: RuntimeShopConfig,
) {
    let shop_id = shop.shop.id.clone();
    let registry = SCHEDULED_SHOPS.get_or_init(|| Mutex::new(HashSet::new()));
    let should_schedule = registry
        .lock()
        .map(|mut shops| shops.insert(shop_id.clone()))
        .unwrap_or(false);
    if !should_schedule {
        return;
    }

    tauri::async_runtime::spawn(async move {
        sleep(Duration::from_secs((LISTING_MAINTENANCE_INTERVAL_MINUTES * 60) as u64)).await;
        if let Some(registry) = SCHEDULED_SHOPS.get() {
            if let Ok(mut shops) = registry.lock() {
                shops.remove(&shop_id);
            }
        }
        let next_job = jobs.create_job(
            JobKind::ListingMaintenance,
            "店铺自动运维".to_string(),
            Some(shop_id),
        );
        run_listing_maintenance(jobs, next_job.id, request, shop).await;
    });
}

async fn listing_maintenance_inner(
    jobs: &JobRegistry,
    job_id: &str,
    request: ListingMaintenanceRequest,
    shop: RuntimeShopConfig,
) -> Result<()> {
    let client = OzonSellerClient::new(shop.shop.client_id.clone(), shop.ozon_api_key.clone())?;
    let mut total_success = 0usize;
    let mut total_failed = 0usize;

    jobs.update(job_id, JobStatus::Running, 1, None);
    jobs.log(job_id, "info", &format!("{} 店铺自动运维开始本轮检查。", shop.shop.name));
    if jobs.is_cancelled(job_id) {
        return Ok(());
    }

    jobs.update(job_id, JobStatus::Running, 10, None);
    if request.auto_update_stock {
        match update_zero_stock_products(jobs, job_id, &client, &shop, &request).await {
            Ok(count) => total_success += count,
            Err(error) => {
                total_failed += 1;
                jobs.log(job_id, "error", &format!("自动补库存失败：{error:#}"));
            }
        }
    }
    if jobs.is_cancelled(job_id) {
        return Ok(());
    }

    if request.auto_generate_barcode {
        match generate_missing_barcodes(jobs, job_id, &client, &shop.shop.name).await {
            Ok(count) => total_success += count,
            Err(error) => {
                total_failed += 1;
                jobs.log(job_id, "error", &format!("自动生成条码失败：{error:#}"));
            }
        }
    }
    if jobs.is_cancelled(job_id) {
        return Ok(());
    }

    if request.auto_add_to_action {
        match add_action_candidates_by_category(jobs, job_id, &client, &shop.shop.name, &request).await {
            Ok(count) => total_success += count,
            Err(error) => {
                total_failed += 1;
                jobs.log(job_id, "error", &format!("自动参加活动失败：{error:#}"));
            }
        }
    }

    jobs.update_counts(job_id, total_success, total_failed);
    jobs.update(job_id, JobStatus::Running, 95, None);
    jobs.log(
        job_id,
        "info",
        &format!("本轮完成：处理 {} 个，失败 {} 个。", total_success, total_failed),
    );
    Ok(())
}
async fn update_zero_stock_products(
    jobs: &JobRegistry,
    job_id: &str,
    client: &OzonSellerClient,
    shop: &RuntimeShopConfig,
    request: &ListingMaintenanceRequest,
) -> Result<usize> {
    let warehouse_id = resolve_warehouse_id(client, request.warehouse_id).await?;
    let stock_value = request.stock.unwrap_or(50).max(0);
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
            &format!("{} 没有库存为 0 的商品，跳过库存更新。", shop.shop.name),
        );
        return Ok(0);
    }

    for (index, chunk) in stocks.chunks(BATCH_SIZE).enumerate() {
        if jobs.is_cancelled(job_id) {
            return Ok(index * BATCH_SIZE);
        }
        client.update_stocks(chunk.to_vec()).await?;
        jobs.log(
            job_id,
            "info",
            &format!(
                "{} 补库存批次 {}：{} 个商品，仓库 {}，库存 {}。",
                shop.shop.name,
                index + 1,
                chunk.len(),
                warehouse_id,
                stock_value
            ),
        );
    }
    Ok(stocks.len())
}

async fn resolve_warehouse_id(
    client: &OzonSellerClient,
    configured_warehouse_id: Option<i64>,
) -> Result<i64> {
    if let Some(warehouse_id) = configured_warehouse_id.filter(|value| *value > 0) {
        return Ok(warehouse_id);
    }
    let warehouses = client.list_warehouses().await?;
    match warehouses.as_slice() {
        [warehouse] => Ok(warehouse.warehouse_id),
        [] => anyhow::bail!("未配置仓库，且 Ozon 没有返回可用仓库"),
        _ => anyhow::bail!("未配置仓库，且 Ozon 返回了多个仓库，请先在店铺运维配置中选择仓库"),
    }
}

async fn generate_missing_barcodes(
    jobs: &JobRegistry,
    job_id: &str,
    client: &OzonSellerClient,
    shop_name: &str,
) -> Result<usize> {
    let products = client.list_all_products_by_visibility("ALL", true).await?;
    let product_ids = products
        .iter()
        .filter(|product| product.has_barcode != Some(true))
        .filter_map(|product| product.product_id)
        .collect::<Vec<_>>();
    if product_ids.is_empty() {
        jobs.log(
            job_id,
            "info",
            &format!("{shop_name} 没有缺少条码的商品，跳过条码更新。"),
        );
        return Ok(0);
    }

    for (index, chunk) in product_ids.chunks(BATCH_SIZE).enumerate() {
        if jobs.is_cancelled(job_id) {
            return Ok(index * BATCH_SIZE);
        }
        client.generate_barcodes(chunk.to_vec()).await?;
        jobs.log(
            job_id,
            "info",
            &format!(
                "{shop_name} 生成条码批次 {}：{} 个商品。",
                index + 1,
                chunk.len()
            ),
        );
    }
    Ok(product_ids.len())
}

async fn add_action_candidates_by_category(
    jobs: &JobRegistry,
    job_id: &str,
    client: &OzonSellerClient,
    shop_name: &str,
    request: &ListingMaintenanceRequest,
) -> Result<usize> {
    let configs = request
        .action_configs
        .iter()
        .filter(|config| {
            config.category_id > 0
                && config.action_id > 0
                && !config.action_price.trim().is_empty()
                && config.action_stock > 0
        })
        .cloned()
        .collect::<Vec<_>>();
    if configs.is_empty() {
        jobs.log(job_id, "info", "未配置类目活动规则，跳过活动更新。");
        return Ok(0);
    }

    let all_products = match client
        .list_all_products_with_attributes_by_visibility("ALL")
        .await
    {
        Ok(products) => products,
        Err(error) => {
            jobs.log(
                job_id,
                "warn",
                &format!(
                    "{shop_name} 获取商品类目属性失败，将只使用活动候选商品自带类目匹配：{error:#}"
                ),
            );
            client
                .list_all_products_by_visibility("ALL", false)
                .await
                .unwrap_or_default()
        }
    };
    let products_by_id = all_products
        .iter()
        .filter_map(|product| product.product_id.map(|id| (id, product.clone())))
        .collect::<HashMap<_, _>>();
    let products_by_offer = all_products
        .iter()
        .filter(|product| !product.offer_id.trim().is_empty())
        .map(|product| (product.offer_id.clone(), product.clone()))
        .collect::<HashMap<_, _>>();
    jobs.log(
        job_id,
        "info",
        &format!(
            "{shop_name} 活动规则已加载 {} 条，商品类目缓存 {} 个。",
            configs.len(),
            all_products.len()
        ),
    );

    let mut total = 0usize;
    for config in configs {
        if jobs.is_cancelled(job_id) {
            return Ok(total);
        }
        let candidates = collect_action_candidates(client, config.action_id).await?;
        let mut payloads = Vec::new();
        let mut missing_product_id = 0usize;
        let mut missing_product_cache = 0usize;
        let mut unmatched_category = 0usize;
        let mut matched_category = 0usize;
        for candidate in &candidates {
            let direct_product_id = action_product_id(candidate);
            let offer_id = action_offer_id(candidate);
            let product_by_id = direct_product_id.and_then(|id| products_by_id.get(&id));
            let product_by_offer = offer_id
                .as_deref()
                .and_then(|offer| products_by_offer.get(offer));
            let product = product_by_id.or(product_by_offer);
            let Some(product_id) =
                direct_product_id.or_else(|| product.and_then(|row| row.product_id))
            else {
                missing_product_id += 1;
                continue;
            };
            if product.is_none() {
                missing_product_cache += 1;
            }
            if !candidate_matches_category(candidate, product, config.category_id) {
                unmatched_category += 1;
                continue;
            }
            matched_category += 1;
            payloads.push(
                build_action_payload(candidate, &config, product_id).map_err(|error| {
                    anyhow::anyhow!("商品 {product_id} 活动参数构造失败：{error:#}")
                })?,
            );
        }

        jobs.log(
            job_id,
            "info",
            &format!(
                "{} 活动 {} 类目 {}：可参加候选 {} 个，类目匹配 {} 个，缺少商品 ID {} 个，未拉到商品缓存 {} 个，类目不匹配 {} 个。",
                shop_name,
                config.action_id,
                config.category_id,
                candidates.len(),
                matched_category,
                missing_product_id,
                missing_product_cache,
                unmatched_category
            ),
        );

        if payloads.is_empty() {
            jobs.log(
                job_id,
                "info",
                &format!(
                    "{} 活动 {} 在类目 {} 下没有可参加商品。",
                    shop_name, config.action_id, config.category_id
                ),
            );
            continue;
        }

        for (index, chunk) in payloads.chunks(BATCH_SIZE).enumerate() {
            if jobs.is_cancelled(job_id) {
                return Ok(total);
            }
            client
                .activate_action_products(config.action_id, chunk.to_vec())
                .await?;
            total += chunk.len();
            jobs.log(
                job_id,
                "info",
                &format!(
                    "{} 活动 {} 类目 {} 批次 {}：加入 {} 个商品，活动库存 {}，活动价 {}。",
                    shop_name,
                    config.action_id,
                    config.category_id,
                    index + 1,
                    chunk.len(),
                    config.action_stock,
                    config.action_price
                ),
            );
        }
    }
    Ok(total)
}

async fn collect_action_candidates(
    client: &OzonSellerClient,
    action_id: i64,
) -> Result<Vec<Value>> {
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
    Ok(products)
}

fn build_action_payload(
    candidate: &Value,
    config: &ListingMaintenanceActionConfig,
    product_id: i64,
) -> Result<Value> {
    let action_price = config.action_price.trim().to_string();
    let discount = candidate
        .get("discount")
        .and_then(value_as_i64)
        .map(|value| value.clamp(1, 99))
        .or_else(|| {
            discount_percent(
                scalar_text(
                    candidate
                        .get("price")
                        .or_else(|| candidate.pointer("/price/price")),
                )
                .as_deref(),
                &action_price,
            )
        });

    let mut payload = json!({
        "product_id": product_id,
        "action_price": action_price,
        "stock": config.action_stock,
    });
    if let (Some(discount), Some(object)) = (discount, payload.as_object_mut()) {
        object.insert("discount".into(), json!(discount));
    }
    Ok(payload)
}

fn candidate_matches_category(
    candidate: &Value,
    product: Option<&OzonProductRow>,
    category_id: i64,
) -> bool {
    candidate_category_id(candidate) == Some(category_id)
        || product.and_then(|row| row.category_id) == Some(category_id)
        || product.and_then(|row| row.type_id) == Some(category_id)
}

fn candidate_category_id(item: &Value) -> Option<i64> {
    [
        "description_category_id",
        "descriptionCategoryId",
        "category_id",
        "categoryId",
        "type_id",
        "typeId",
        "product_type_id",
        "productTypeId",
        "category_type_id",
    ]
    .iter()
    .find_map(|key| item.get(*key).and_then(value_as_i64))
    .or_else(|| {
        item.pointer("/product/description_category_id")
            .and_then(value_as_i64)
    })
    .or_else(|| {
        item.pointer("/product/descriptionCategoryId")
            .and_then(value_as_i64)
    })
    .or_else(|| item.pointer("/product/category_id").and_then(value_as_i64))
    .or_else(|| item.pointer("/product/categoryId").and_then(value_as_i64))
    .or_else(|| item.pointer("/product/type_id").and_then(value_as_i64))
    .or_else(|| item.pointer("/product/typeId").and_then(value_as_i64))
    .or_else(|| {
        item.pointer("/product/product_type_id")
            .and_then(value_as_i64)
    })
    .or_else(|| {
        item.pointer("/product/productTypeId")
            .and_then(value_as_i64)
    })
    .or_else(|| item.pointer("/product/category/id").and_then(value_as_i64))
    .or_else(|| item.pointer("/product/type/id").and_then(value_as_i64))
    .or_else(|| {
        item.pointer("/category/description_category_id")
            .and_then(value_as_i64)
    })
    .or_else(|| {
        item.pointer("/category/descriptionCategoryId")
            .and_then(value_as_i64)
    })
    .or_else(|| item.pointer("/category/category_id").and_then(value_as_i64))
    .or_else(|| item.pointer("/category/categoryId").and_then(value_as_i64))
    .or_else(|| item.pointer("/category/id").and_then(value_as_i64))
    .or_else(|| item.pointer("/type/id").and_then(value_as_i64))
}

fn action_product_id(item: &Value) -> Option<i64> {
    item.get("product_id")
        .or_else(|| item.get("productId"))
        .or_else(|| item.get("id"))
        .and_then(value_as_i64)
        .or_else(|| item.pointer("/product/product_id").and_then(value_as_i64))
        .or_else(|| item.pointer("/product/productId").and_then(value_as_i64))
        .or_else(|| item.pointer("/product/id").and_then(value_as_i64))
        .or_else(|| item.pointer("/item/product_id").and_then(value_as_i64))
        .or_else(|| item.pointer("/item/productId").and_then(value_as_i64))
        .or_else(|| item.pointer("/item/id").and_then(value_as_i64))
}

fn action_offer_id(item: &Value) -> Option<String> {
    [
        item.get("offer_id"),
        item.get("offerId"),
        item.pointer("/product/offer_id"),
        item.pointer("/product/offerId"),
        item.pointer("/item/offer_id"),
        item.pointer("/item/offerId"),
    ]
    .into_iter()
    .flatten()
    .find_map(|value| {
        value
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    })
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

fn value_as_i64(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| {
        value
            .as_str()
            .and_then(|text| text.trim().parse::<i64>().ok())
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
    Some((((base - action) / base * 100.0).round() as i64).clamp(1, 99))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn product_row(
        product_id: i64,
        offer_id: &str,
        category_id: Option<i64>,
        type_id: Option<i64>,
    ) -> OzonProductRow {
        OzonProductRow {
            product_id: Some(product_id),
            offer_id: offer_id.into(),
            name: String::new(),
            visibility: None,
            has_barcode: None,
            stock_summary: None,
            category_id,
            category_name: None,
            type_id,
            type_name: None,
            price: None,
            old_price: None,
            currency_code: None,
        }
    }

    #[test]
    fn extracts_nested_action_candidate_fields() {
        let candidate = json!({
            "product": {
                "product_id": "123",
                "offer_id": "SKU-123",
                "description_category_id": "456"
            }
        });

        assert_eq!(action_product_id(&candidate), Some(123));
        assert_eq!(action_offer_id(&candidate).as_deref(), Some("SKU-123"));
        assert_eq!(candidate_category_id(&candidate), Some(456));
    }

    #[test]
    fn matches_category_from_enriched_product_cache() {
        let candidate = json!({ "product_id": 123 });
        let product = product_row(123, "SKU-123", Some(456), Some(789));

        assert!(candidate_matches_category(&candidate, Some(&product), 456));
        assert!(candidate_matches_category(&candidate, Some(&product), 789));
        assert!(!candidate_matches_category(&candidate, Some(&product), 999));
    }

    #[test]
    fn builds_action_payload_with_resolved_product_id() {
        let candidate = json!({ "price": "1000" });
        let config = ListingMaintenanceActionConfig {
            category_id: 456,
            category_name: None,
            action_id: 777,
            action_title: None,
            action_price: "800".into(),
            action_stock: 50,
        };

        let payload = build_action_payload(&candidate, &config, 123).unwrap();

        assert_eq!(payload["product_id"], 123);
        assert_eq!(payload["action_price"], "800");
        assert_eq!(payload["stock"], 50);
        assert_eq!(payload["discount"], 20);
    }
}

#[cfg(test)]
mod schedule_contract_tests {
    use super::LISTING_MAINTENANCE_INTERVAL_MINUTES;

    #[test]
    fn maintenance_schedule_runs_every_two_hours() {
        assert_eq!(LISTING_MAINTENANCE_INTERVAL_MINUTES, 120);
    }
}