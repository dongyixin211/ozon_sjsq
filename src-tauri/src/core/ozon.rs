use crate::core::models::{CategoryOption, OzonProductRow, WarehouseOption};
use anyhow::{Context, Result};
use reqwest::Client;
use serde_json::{json, Value};

const OZON_BASE_URL: &str = "https://api-seller.ozon.ru";

#[derive(Clone)]
pub struct OzonSellerClient {
    client_id: String,
    api_key: String,
    http: Client,
}

impl OzonSellerClient {
    pub fn new(client_id: impl Into<String>, api_key: impl Into<String>) -> Result<Self> {
        let client_id = client_id.into().trim().to_string();
        let api_key = api_key.into().trim().to_string();
        if client_id.is_empty() || api_key.is_empty() {
            anyhow::bail!("Client-Id 和 Api-Key 不能为空");
        }
        Ok(Self {
            client_id,
            api_key,
            http: Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()?,
        })
    }

    pub async fn request_json(&self, endpoint: &str, payload: Value) -> Result<Value> {
        let url = format!("{OZON_BASE_URL}{endpoint}");
        let response = self
            .http
            .post(url)
            .header("Client-Id", &self.client_id)
            .header("Api-Key", &self.api_key)
            .header("Content-Type", "application/json")
            .header("Accept", "application/pdf")
            .json(&payload)
            .send()
            .await
            .context("Ozon 连接失败")?;

        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            anyhow::bail!(
                "Ozon HTTP {}: {}",
                status.as_u16(),
                humanize_ozon_error(&text)
            );
        }
        if text.trim().is_empty() {
            return Ok(json!({}));
        }
        serde_json::from_str(&text).context("Ozon 返回不是合法 JSON")
    }

    pub async fn get_json(&self, endpoint: &str) -> Result<Value> {
        let url = format!("{OZON_BASE_URL}{endpoint}");
        let response = self
            .http
            .get(url)
            .header("Client-Id", &self.client_id)
            .header("Api-Key", &self.api_key)
            .header("Content-Type", "application/json")
            .send()
            .await
            .context("Ozon 连接失败")?;

        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            anyhow::bail!(
                "Ozon HTTP {}: {}",
                status.as_u16(),
                humanize_ozon_error(&text)
            );
        }
        if text.trim().is_empty() {
            return Ok(json!({}));
        }
        serde_json::from_str(&text).context("Ozon 返回不是合法 JSON")
    }

    pub async fn test_connection(&self) -> Result<Value> {
        self.request_json("/v3/product/list", json!({"filter": {}, "limit": 1}))
            .await
    }

    pub async fn product_info(&self, offer_ids: Vec<String>) -> Result<Value> {
        self.request_json("/v3/product/info/list", json!({ "offer_id": offer_ids }))
            .await
    }

    pub async fn product_info_by_product_ids(&self, product_ids: Vec<i64>) -> Result<Value> {
        let ids = product_ids
            .into_iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>();
        self.request_json("/v3/product/info/list", json!({ "product_id": ids }))
            .await
    }

    pub async fn product_attributes(&self, offer_ids: Vec<String>) -> Result<Value> {
        self.request_json(
            "/v4/product/info/attributes",
            json!({"filter": {"offer_id": offer_ids}, "limit": 100, "sort_dir": "ASC"}),
        )
        .await
    }

    pub async fn list_products(&self, visibility: &str, limit: u32) -> Result<Vec<OzonProductRow>> {
        let data = self
            .request_json(
                "/v3/product/list",
                json!({"filter": {"visibility": visibility}, "last_id": "", "limit": limit.clamp(1, 1000)}),
            )
            .await?;
        Ok(extract_items(&data).into_iter().map(product_row).collect())
    }

    pub async fn list_categories(&self) -> Result<Vec<CategoryOption>> {
        let data = self
            .request_json(
                "/v1/description-category/tree",
                json!({"language": "ZH_HANS"}),
            )
            .await?;
        Ok(parse_categories(&data))
    }

    pub async fn list_products_by_category(
        &self,
        category_id: i64,
        type_id: Option<i64>,
        limit: u32,
    ) -> Result<Vec<OzonProductRow>> {
        let target_count = limit.clamp(1, 1000) as usize;
        let mut matched_rows = Vec::new();
        let mut last_id = String::new();

        loop {
            let data = self
                .request_json(
                    "/v3/product/list",
                    json!({"filter": {"visibility": "ALL"}, "last_id": last_id, "limit": 1000}),
                )
                .await?;
            let mut rows = extract_items(&data)
                .into_iter()
                .map(product_row)
                .collect::<Vec<_>>();
            if rows.is_empty() {
                break;
            }

            self.attach_product_attributes(&mut rows).await?;
            for row in rows {
                if row.category_id == Some(category_id)
                    && type_id.map_or(true, |id| row.type_id == Some(id))
                {
                    matched_rows.push(row);
                    if matched_rows.len() >= target_count {
                        break;
                    }
                }
            }

            let next_last_id = extract_last_id(&data).unwrap_or_default();
            if matched_rows.len() >= target_count
                || next_last_id.trim().is_empty()
                || next_last_id == last_id
            {
                break;
            }
            last_id = next_last_id;
        }

        self.enrich_prices(&mut matched_rows).await?;
        Ok(matched_rows)
    }

    async fn attach_product_attributes(&self, rows: &mut [OzonProductRow]) -> Result<()> {
        let offer_ids = rows
            .iter()
            .map(|row| row.offer_id.clone())
            .filter(|value| !value.trim().is_empty())
            .collect::<Vec<_>>();
        if offer_ids.is_empty() {
            return Ok(());
        }

        let mut attributes_by_offer = std::collections::HashMap::new();
        for chunk in offer_ids.chunks(100) {
            let data = self.product_attributes(chunk.to_vec()).await?;
            for item in extract_items(&data) {
                let offer_id = item
                    .get("offer_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if !offer_id.is_empty() {
                    attributes_by_offer.insert(offer_id, item);
                }
            }
        }

        for row in rows {
            if let Some(attrs) = attributes_by_offer.get(&row.offer_id) {
                row.category_id = product_category_id(attrs);
                row.category_name = attrs
                    .get("category_name")
                    .or_else(|| attrs.get("description_category_name"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                row.type_id = product_type_id(attrs);
                row.type_name = attrs
                    .get("type_name")
                    .or_else(|| attrs.get("type"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
        }
        Ok(())
    }

    pub async fn enrich_prices(&self, rows: &mut [OzonProductRow]) -> Result<()> {
        let product_ids = rows
            .iter()
            .filter_map(|row| row.product_id)
            .collect::<Vec<_>>();
        if product_ids.is_empty() {
            return Ok(());
        }
        let data = self
            .request_json(
                "/v5/product/info/prices",
                json!({"filter": {"product_id": product_ids}, "limit": product_ids.len().clamp(1, 1000)}),
            )
            .await?;
        let prices = extract_items(&data)
            .into_iter()
            .filter_map(|item| {
                let product_id = item
                    .get("product_id")
                    .or_else(|| item.get("id"))
                    .and_then(Value::as_i64)?;
                Some((product_id, item))
            })
            .collect::<std::collections::HashMap<_, _>>();
        for row in rows {
            let Some(product_id) = row.product_id else {
                continue;
            };
            let Some(item) = prices.get(&product_id) else {
                continue;
            };
            row.price = extract_price_value(item, "price");
            row.old_price = extract_price_value(item, "old_price");
            row.currency_code = item
                .get("currency_code")
                .or_else(|| item.pointer("/price/currency_code"))
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        Ok(())
    }

    pub async fn update_prices(&self, prices: Vec<Value>) -> Result<Value> {
        self.request_json("/v1/product/import/prices", json!({ "prices": prices }))
            .await
    }

    pub async fn list_warehouses(&self) -> Result<Vec<WarehouseOption>> {
        let data = self
            .request_json("/v2/warehouse/list", json!({"limit": 200, "offset": 0}))
            .await?;
        Ok(parse_warehouses(&data))
    }

    pub async fn import_info(&self, task_id: i64) -> Result<Value> {
        self.request_json("/v1/product/import/info", json!({ "task_id": task_id }))
            .await
    }

    pub async fn product_stocks(
        &self,
        offer_ids: Vec<String>,
        product_ids: Vec<i64>,
        visibility: String,
    ) -> Result<Value> {
        let mut filter = serde_json::Map::new();
        if !offer_ids.is_empty() {
            filter.insert("offer_id".into(), json!(offer_ids));
        }
        if !product_ids.is_empty() {
            filter.insert(
                "product_id".into(),
                json!(product_ids.iter().map(i64::to_string).collect::<Vec<_>>()),
            );
        }
        if !visibility.trim().is_empty() {
            filter.insert("visibility".into(), json!(visibility));
        }
        self.request_json(
            "/v4/product/info/stocks",
            json!({ "cursor": "", "filter": filter, "limit": 100 }),
        )
        .await
    }

    pub async fn update_stocks(&self, stocks: Vec<Value>) -> Result<Value> {
        self.request_json("/v2/products/stocks", json!({ "stocks": stocks }))
            .await
    }

    pub async fn generate_barcodes(&self, product_ids: Vec<i64>) -> Result<Value> {
        let ids: Vec<String> = product_ids.into_iter().map(|id| id.to_string()).collect();
        self.request_json("/v1/barcode/generate", json!({ "product_ids": ids }))
            .await
    }

    pub async fn fbs_posting(&self, posting_number: &str) -> Result<Value> {
        self.request_json(
            "/v3/posting/fbs/get",
            json!({
                "posting_number": posting_number,
                "with": {
                    "analytics_data": false,
                    "barcodes": true,
                    "financial_data": false,
                    "translit": false
                }
            }),
        )
        .await
    }

    pub async fn fbs_postings_by_order_ref(&self, order_ref: &str) -> Result<Value> {
        let trimmed = order_ref.trim();
        if let Ok(order_id) = trimmed.parse::<i64>() {
            return self
                .request_json(
                    "/v3/posting/fbs/list",
                    json!({
                        "dir": "ASC",
                        "filter": fbs_list_base_filter(Some(order_id)),
                        "limit": 1000,
                        "offset": 0,
                        "with": fbs_list_with_barcodes()
                    }),
                )
                .await;
        }

        let mut offset = 0;
        let mut matched = Vec::new();
        loop {
            let data = self
                .request_json(
                    "/v3/posting/fbs/list",
                    json!({
                        "dir": "ASC",
                        "filter": fbs_list_base_filter(None),
                        "limit": 1000,
                        "offset": offset,
                        "with": fbs_list_with_barcodes()
                    }),
                )
                .await?;
            let items = extract_fbs_postings(&data);
            matched.extend(items.into_iter().filter(|posting| {
                posting
                    .get("order_number")
                    .and_then(Value::as_str)
                    .is_some_and(|value| value == trimmed)
            }));
            if !matched.is_empty() || !fbs_list_has_next(&data) {
                break;
            }
            offset += 1000;
        }
        Ok(json!({ "result": { "postings": matched } }))
    }

    pub async fn import_products(&self, items: Vec<Value>) -> Result<Value> {
        self.request_json("/v3/product/import", json!({ "items": items }))
            .await
    }

    pub async fn list_actions(&self) -> Result<Value> {
        self.get_json("/v1/actions").await
    }

    pub async fn action_products(
        &self,
        action_id: i64,
        limit: u32,
        last_id: String,
    ) -> Result<Value> {
        self.request_json(
            "/v1/actions/products",
            json!({
                "action_id": action_id,
                "limit": limit.clamp(1, 1000),
                "last_id": last_id
            }),
        )
        .await
    }

    pub async fn activate_action_products(
        &self,
        action_id: i64,
        products: Vec<Value>,
    ) -> Result<Value> {
        self.request_json(
            "/v1/actions/products/activate",
            json!({ "action_id": action_id, "products": products }),
        )
        .await
    }

    pub async fn deactivate_action_products(
        &self,
        action_id: i64,
        product_ids: Vec<i64>,
    ) -> Result<Value> {
        self.request_json(
            "/v1/actions/products/deactivate",
            json!({ "action_id": action_id, "product_ids": product_ids }),
        )
        .await
    }
}

fn fbs_list_base_filter(order_id: Option<i64>) -> serde_json::Map<String, Value> {
    let mut filter = serde_json::Map::new();
    filter.insert(
        "since".into(),
        json!((chrono::Utc::now() - chrono::Duration::days(365)).to_rfc3339()),
    );
    filter.insert(
        "to".into(),
        json!((chrono::Utc::now() + chrono::Duration::days(1)).to_rfc3339()),
    );
    if let Some(order_id) = order_id {
        filter.insert("order_id".into(), json!(order_id));
    }
    filter
}

fn fbs_list_with_barcodes() -> Value {
    json!({
        "analytics_data": false,
        "barcodes": true,
        "financial_data": false,
        "legal_info": false,
        "translit": false
    })
}

fn extract_fbs_postings(data: &Value) -> Vec<Value> {
    data.pointer("/result/postings")
        .or_else(|| data.pointer("/result/items"))
        .or_else(|| data.get("postings"))
        .or_else(|| data.get("items"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn fbs_list_has_next(data: &Value) -> bool {
    data.pointer("/result/has_next")
        .or_else(|| data.get("has_next"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn parse_categories(data: &Value) -> Vec<CategoryOption> {
    let mut rows = Vec::new();
    push_category_roots(data, &mut rows);
    rows.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then(a.level.cmp(&b.level))
            .then(a.id.cmp(&b.id))
    });
    rows
}

fn push_category_roots(data: &Value, rows: &mut Vec<CategoryOption>) {
    if let Some(items) = data.pointer("/result").and_then(Value::as_array) {
        for item in items {
            push_category(item, 0, None, rows);
        }
        return;
    }
    for pointer in [
        "/result/categories",
        "/result/children",
        "/result/items",
        "/categories",
        "/children",
        "/items",
    ] {
        if let Some(items) = data.pointer(pointer).and_then(Value::as_array) {
            for item in items {
                push_category(item, 0, None, rows);
            }
            return;
        }
    }
    if is_category_node(data) {
        push_category(data, 0, None, rows);
    }
}

fn is_category_node(item: &Value) -> bool {
    item.get("description_category_id").is_some()
        || item.get("category_id").is_some()
        || item.get("id").is_some()
        || item.get("type_id").is_some()
}

fn push_category(
    item: &Value,
    level: usize,
    parent_id: Option<i64>,
    rows: &mut Vec<CategoryOption>,
) {
    let category_id = item
        .get("description_category_id")
        .or_else(|| item.get("category_id"))
        .and_then(value_as_i64);
    let fallback_id = item.get("id").and_then(value_as_i64);
    let type_id = item.get("type_id").and_then(value_as_i64);
    let is_type = type_id.is_some();
    let node_id = if is_type {
        type_id
    } else {
        category_id.or(fallback_id)
    };
    let name = item
        .get("category_name")
        .or_else(|| item.get("type_name"))
        .or_else(|| item.get("title"))
        .or_else(|| item.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("未命名分类")
        .to_string();
    if let Some(node_id) = node_id {
        let description_category_id = if is_type {
            category_id.or(parent_id)
        } else {
            category_id.or(Some(node_id))
        };
        rows.push(CategoryOption {
            id: node_id,
            name,
            level,
            parent_id,
            node_kind: if is_type { "type" } else { "category" }.into(),
            description_category_id,
            type_id,
        });
        let child_parent_id = description_category_id.unwrap_or(node_id);
        for key in ["children", "categories", "items"] {
            if let Some(children) = item.get(key).and_then(Value::as_array) {
                for child in children {
                    push_category(child, level + 1, Some(child_parent_id), rows);
                }
            }
        }
        if let Some(types) = item.get("types").and_then(Value::as_array) {
            for child in types {
                push_category(child, level + 1, Some(child_parent_id), rows);
            }
        }
    }
}

fn product_category_id(item: &Value) -> Option<i64> {
    item.get("description_category_id")
        .or_else(|| item.get("category_id"))
        .or_else(|| item.get("categoryId"))
        .or_else(|| item.pointer("/category/id"))
        .and_then(value_as_i64)
}

fn product_type_id(item: &Value) -> Option<i64> {
    item.get("type_id")
        .or_else(|| item.get("typeId"))
        .or_else(|| item.get("product_type_id"))
        .or_else(|| item.get("category_type_id"))
        .or_else(|| item.pointer("/type/id"))
        .and_then(value_as_i64)
}

fn value_as_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|text| text.parse::<i64>().ok()))
}

fn extract_last_id(data: &Value) -> Option<String> {
    data.pointer("/result/last_id")
        .or_else(|| data.get("last_id"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn extract_price_value(item: &Value, key: &str) -> Option<String> {
    item.get(key).and_then(scalar_to_string).or_else(|| {
        item.pointer(&format!("/price/{key}"))
            .and_then(scalar_to_string)
    })
}

fn scalar_to_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_string)
        .or_else(|| value.as_f64().map(|n| n.to_string()))
        .or_else(|| value.as_i64().map(|n| n.to_string()))
}

fn parse_warehouses(data: &Value) -> Vec<WarehouseOption> {
    let mut rows = Vec::new();
    let items = data
        .get("warehouses")
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| {
            data.pointer("/result/warehouses")
                .and_then(Value::as_array)
                .cloned()
        })
        .unwrap_or_else(|| extract_items(&data));
    for item in items {
        let warehouse_id = item
            .get("warehouse_id")
            .or_else(|| item.get("warehouseId"))
            .or_else(|| item.get("id"))
            .and_then(Value::as_i64);
        if let Some(warehouse_id) = warehouse_id {
            let name = item
                .get("name")
                .or_else(|| item.get("warehouse_name"))
                .and_then(Value::as_str)
                .unwrap_or("仓库")
                .to_string();
            rows.push(WarehouseOption { warehouse_id, name });
        }
    }
    rows.sort_by(|a, b| a.name.cmp(&b.name));
    rows
}

pub fn extract_items(data: &Value) -> Vec<Value> {
    if let Some(items) = data.pointer("/result/items").and_then(Value::as_array) {
        return items.clone();
    }
    if let Some(items) = data.pointer("/result/products").and_then(Value::as_array) {
        return items.clone();
    }
    if let Some(items) = data.get("items").and_then(Value::as_array) {
        return items.clone();
    }
    if let Some(result) = data.get("result").and_then(Value::as_array) {
        return result.clone();
    }
    Vec::new()
}

fn product_row(item: Value) -> OzonProductRow {
    let product_id = item
        .get("product_id")
        .or_else(|| item.get("id"))
        .and_then(Value::as_i64);
    let offer_id = item
        .get("offer_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let name = item
        .get("name")
        .or_else(|| item.get("title"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let visibility = item
        .get("visibility")
        .and_then(Value::as_str)
        .map(str::to_string);
    let has_barcode = item.get("barcodes").and_then(Value::as_array).map(|items| {
        items
            .iter()
            .any(|v| v.as_str().is_some_and(|s| !s.trim().is_empty()))
    });
    let stock_summary = item.get("stocks").and_then(Value::as_array).map(|stocks| {
        let parts: Vec<String> = stocks
            .iter()
            .filter_map(|stock| {
                let name = stock
                    .get("warehouse_name")
                    .or_else(|| stock.get("warehouseName"))
                    .or_else(|| stock.get("warehouse_id"))
                    .and_then(|v| {
                        v.as_str()
                            .map(str::to_string)
                            .or_else(|| v.as_i64().map(|n| n.to_string()))
                    })?;
                let present = stock
                    .get("present")
                    .or_else(|| stock.get("free_stock"))
                    .or_else(|| stock.get("stock"))
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                Some(format!("{name}:{present}"))
            })
            .collect();
        if parts.is_empty() {
            "全仓 0".into()
        } else {
            parts.join("；")
        }
    });
    OzonProductRow {
        product_id,
        offer_id,
        name,
        visibility,
        has_barcode,
        stock_summary,
        category_id: product_category_id(&item),
        category_name: item
            .get("category_name")
            .or_else(|| item.get("description_category_name"))
            .and_then(Value::as_str)
            .map(str::to_string),
        type_id: product_type_id(&item),
        type_name: item
            .get("type_name")
            .or_else(|| item.get("type"))
            .and_then(Value::as_str)
            .map(str::to_string),
        price: extract_price_value(&item, "price"),
        old_price: extract_price_value(&item, "old_price"),
        currency_code: item
            .get("currency_code")
            .or_else(|| item.pointer("/price/currency_code"))
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

fn humanize_ozon_error(text: &str) -> String {
    let lowered = text.to_lowercase();
    if lowered.contains("invalid api-key") || lowered.contains("unauthorized") {
        "鉴权失败，请检查 Client-Id 和 Api-Key".into()
    } else if lowered.contains("too many requests") || lowered.contains("rate") {
        "请求过于频繁，触发 Ozon 限流".into()
    } else if lowered.contains("blockurl") || lowered.contains("incidentid") {
        "Ozon 风控拦截了请求，请稍后重试或在浏览器中确认账号状态".into()
    } else {
        text.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_top_level_warehouses() {
        let rows = parse_warehouses(&json!({
            "warehouses": [
                {"warehouse_id": 2, "name": "B 仓"},
                {"warehouseId": 1, "warehouse_name": "A 仓"}
            ]
        }));

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].warehouse_id, 1);
        assert_eq!(rows[0].name, "A 仓");
        assert_eq!(rows[1].warehouse_id, 2);
        assert_eq!(rows[1].name, "B 仓");
    }

    #[test]
    fn parses_result_warehouses() {
        let rows = parse_warehouses(&json!({
            "result": {
                "warehouses": [
                    {"id": 9, "name": "主仓"}
                ]
            }
        }));

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].warehouse_id, 9);
        assert_eq!(rows[0].name, "主仓");
    }

    #[test]
    fn parses_result_array_and_items_array() {
        let result_rows = parse_warehouses(&json!({
            "result": [
                {"id": 3, "name": "Result 仓"}
            ]
        }));
        let item_rows = parse_warehouses(&json!({
            "items": [
                {"warehouse_id": 4, "warehouse_name": "Items 仓"}
            ]
        }));

        assert_eq!(result_rows[0].warehouse_id, 3);
        assert_eq!(result_rows[0].name, "Result 仓");
        assert_eq!(item_rows[0].warehouse_id, 4);
        assert_eq!(item_rows[0].name, "Items 仓");
    }

    #[test]
    fn parses_nested_description_categories() {
        let rows = parse_categories(&json!({
            "result": {
                "children": [
                    {
                        "description_category_id": 10,
                        "category_name": "发饰",
                        "children": [
                            {"description_category_id": 11, "category_name": "束发带"}
                        ]
                    }
                ]
            }
        }));

        let headband = rows.iter().find(|row| row.name == "束发带").unwrap();
        assert_eq!(headband.id, 11);
        assert_eq!(headband.level, 1);
        assert_eq!(headband.parent_id, Some(10));
    }

    #[test]
    fn parses_category_types_like_headbands() {
        let rows = parse_categories(&json!({
            "result": {
                "children": [
                    {
                        "description_category_id": 20,
                        "category_name": "发饰",
                        "types": [
                            {"type_id": 21, "type_name": "束发带"}
                        ]
                    }
                ]
            }
        }));

        let headband = rows.iter().find(|row| row.name == "束发带").unwrap();
        assert_eq!(headband.id, 21);
        assert_eq!(headband.node_kind, "type");
        assert_eq!(headband.description_category_id, Some(20));
        assert_eq!(headband.type_id, Some(21));
        assert_eq!(headband.parent_id, Some(20));
    }

    #[test]
    fn parses_category_type_with_separate_node_id() {
        let rows = parse_categories(&json!({
            "result": {
                "children": [
                    {
                        "description_category_id": 29183107,
                        "category_name": "发饰",
                        "types": [
                            {"id": 999, "type_id": 97575, "type_name": "束发带"}
                        ]
                    }
                ]
            }
        }));

        let headband = rows.iter().find(|row| row.name == "束发带").unwrap();
        assert_eq!(headband.id, 97575);
        assert_eq!(headband.description_category_id, Some(29183107));
        assert_eq!(headband.type_id, Some(97575));
    }

    #[test]
    fn parses_product_category_and_type_from_strings() {
        let item = json!({
            "description_category_id": "29183107",
            "product_type_id": "97575"
        });

        assert_eq!(product_category_id(&item), Some(29183107));
        assert_eq!(product_type_id(&item), Some(97575));
    }

    #[test]
    fn extracts_v5_price_fields() {
        let item = json!({
            "price": {
                "currency_code": "CNY",
                "old_price": 39.9,
                "price": 29.9
            }
        });

        assert_eq!(extract_price_value(&item, "price").as_deref(), Some("29.9"));
        assert_eq!(
            extract_price_value(&item, "old_price").as_deref(),
            Some("39.9")
        );
    }

    #[test]
    fn extracts_product_list_last_id() {
        let data = json!({"result": {"last_id": "next-page"}});

        assert_eq!(extract_last_id(&data).as_deref(), Some("next-page"));
    }

    #[test]
    fn extracts_fbs_postings_from_common_shapes() {
        let postings = extract_fbs_postings(&json!({
            "result": {
                "postings": [
                    {"posting_number": "P1"}
                ]
            }
        }));
        let items = extract_fbs_postings(&json!({
            "result": {
                "items": [
                    {"posting_number": "P2"}
                ]
            }
        }));

        assert_eq!(postings[0]["posting_number"], "P1");
        assert_eq!(items[0]["posting_number"], "P2");
    }

    #[test]
    fn parses_fbs_list_has_next() {
        assert!(fbs_list_has_next(&json!({"result": {"has_next": true}})));
        assert!(!fbs_list_has_next(&json!({"result": {"has_next": false}})));
        assert!(!fbs_list_has_next(&json!({})));
    }
}
