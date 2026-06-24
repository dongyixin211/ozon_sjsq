use crate::core::models::{
    CategoryOption, OrderPostingRow, OzonProductRow, ProductAnalyticsRow, WarehouseOption,
};
use anyhow::{Context, Result};
use reqwest::Client;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};

const OZON_BASE_URL: &str = "https://api-seller.ozon.ru";
const MERGE_CARD_ATTRIBUTE_IDS: &[i64] = &[8292, 9048];

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

    pub async fn product_analytics(
        &self,
        date_from: String,
        date_to: String,
        limit: u32,
    ) -> Result<Vec<ProductAnalyticsRow>> {
        let data = self
            .request_json(
                "/v1/analytics/data",
                json!({
                    "date_from": date_from,
                    "date_to": date_to,
                    "dimension": ["sku"],
                    "metrics": ["hits_view_search", "hits_view_pdp"],
                    "filters": [],
                    "sort": [{"key": "hits_view_pdp", "order": "DESC"}],
                    "limit": limit.clamp(1, 1000),
                    "offset": 0
                }),
            )
            .await?;
        self.enrich_analytics_rows(parse_analytics_rows(&data))
            .await
    }

    async fn enrich_analytics_rows(
        &self,
        mut rows: Vec<ProductAnalyticsRow>,
    ) -> Result<Vec<ProductAnalyticsRow>> {
        let product_ids = rows
            .iter()
            .filter_map(|row| row.product_id)
            .collect::<Vec<_>>();
        if product_ids.is_empty() {
            return Ok(rows);
        }

        let mut details_by_id = HashMap::new();
        for chunk in product_ids.chunks(100) {
            let data = self.product_info_by_product_ids(chunk.to_vec()).await?;
            for item in extract_items(&data) {
                if let Some(product_id) = item
                    .get("product_id")
                    .or_else(|| item.get("id"))
                    .and_then(value_as_i64)
                {
                    details_by_id.insert(product_id, item);
                }
            }
        }

        let offer_ids = details_by_id
            .values()
            .filter_map(|item| item.get("offer_id").and_then(Value::as_str))
            .map(str::to_string)
            .collect::<Vec<_>>();
        let mut attributes_by_offer = HashMap::new();
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

        for row in &mut rows {
            let Some(product_id) = row.product_id else {
                continue;
            };
            let Some(detail) = details_by_id.get(&product_id) else {
                continue;
            };
            row.offer_id = detail
                .get("offer_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            row.name = detail
                .get("name")
                .or_else(|| detail.get("title"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
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
        Ok(rows)
    }

    pub async fn product_attributes(&self, offer_ids: Vec<String>) -> Result<Value> {
        self.request_json(
            "/v4/product/info/attributes",
            json!({"filter": {"offer_id": offer_ids}, "limit": 100, "sort_dir": "ASC"}),
        )
        .await
    }

    pub async fn product_description(&self, offer_id: String) -> Result<Value> {
        self.request_json(
            "/v1/product/info/description",
            json!({ "offer_id": offer_id }),
        )
        .await
    }

    pub async fn attribute_values(
        &self,
        description_category_id: i64,
        type_id: i64,
        attribute_id: i64,
    ) -> Result<Vec<Value>> {
        let mut items = Vec::new();
        let mut last_value_id = 0i64;
        loop {
            let data = self
                .request_json(
                    "/v1/description-category/attribute/values",
                    json!({
                        "description_category_id": description_category_id,
                        "type_id": type_id,
                        "attribute_id": attribute_id,
                        "language": "DEFAULT",
                        "limit": 100,
                        "last_value_id": last_value_id,
                    }),
                )
                .await?;
            let batch = data
                .get("result")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if batch.is_empty() {
                break;
            }
            last_value_id = batch
                .last()
                .and_then(|value| value.get("id"))
                .and_then(Value::as_i64)
                .unwrap_or(last_value_id);
            items.extend(batch);
            if !data
                .get("has_next")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                break;
            }
        }
        Ok(items)
    }

    pub async fn list_products(&self, visibility: &str, limit: u32) -> Result<Vec<OzonProductRow>> {
        let data = self
            .request_json(
                "/v3/product/list",
                json!({"filter": {"visibility": visibility}, "last_id": "", "limit": limit.clamp(1, 1000)}),
            )
            .await?;
        let mut rows = extract_items(&data)
            .into_iter()
            .map(product_row)
            .collect::<Vec<_>>();
        self.attach_product_barcodes(&mut rows).await?;
        Ok(rows)
    }

    pub async fn list_all_products_by_visibility(
        &self,
        visibility: &str,
        include_barcodes: bool,
    ) -> Result<Vec<OzonProductRow>> {
        let mut rows = Vec::new();
        let mut last_id = String::new();

        loop {
            let data = self
                .request_json(
                    "/v3/product/list",
                    json!({"filter": {"visibility": visibility}, "last_id": last_id, "limit": 1000}),
                )
                .await?;
            let batch = extract_items(&data)
                .into_iter()
                .map(product_row)
                .collect::<Vec<_>>();
            if batch.is_empty() {
                break;
            }
            rows.extend(batch);

            let next_last_id = extract_last_id(&data).unwrap_or_default();
            if next_last_id.trim().is_empty() || next_last_id == last_id {
                break;
            }
            last_id = next_last_id;
        }

        if include_barcodes {
            self.attach_product_barcodes(&mut rows).await?;
        }
        Ok(rows)
    }

    pub async fn list_all_products(&self) -> Result<Vec<OzonProductRow>> {
        let mut rows = Vec::new();
        let mut last_id = String::new();

        loop {
            let data = self
                .request_json(
                    "/v3/product/list",
                    json!({"filter": {"visibility": "ALL"}, "last_id": last_id, "limit": 1000}),
                )
                .await?;
            let batch = extract_items(&data)
                .into_iter()
                .map(product_row)
                .collect::<Vec<_>>();
            if batch.is_empty() {
                break;
            }
            rows.extend(batch);

            let next_last_id = extract_last_id(&data).unwrap_or_default();
            if next_last_id.trim().is_empty() || next_last_id == last_id {
                break;
            }
            last_id = next_last_id;
        }

        self.enrich_prices(&mut rows).await?;
        Ok(rows)
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
        self.collect_products_by_category(category_id, type_id, Some(limit.clamp(1, 1000) as usize))
            .await
    }

    pub async fn list_all_products_by_category(
        &self,
        category_id: i64,
        type_id: Option<i64>,
    ) -> Result<Vec<OzonProductRow>> {
        self.collect_products_by_category(category_id, type_id, None)
            .await
    }

    async fn collect_products_by_category(
        &self,
        category_id: i64,
        type_id: Option<i64>,
        target_count: Option<usize>,
    ) -> Result<Vec<OzonProductRow>> {
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
                    && type_id.is_none_or(|id| row.type_id == Some(id))
                {
                    matched_rows.push(row);
                    if target_count.is_some_and(|count| matched_rows.len() >= count) {
                        break;
                    }
                }
            }

            let next_last_id = extract_last_id(&data).unwrap_or_default();
            if target_count.is_some_and(|count| matched_rows.len() >= count)
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

    async fn attach_product_barcodes(&self, rows: &mut [OzonProductRow]) -> Result<()> {
        let offer_ids = rows
            .iter()
            .map(|row| row.offer_id.clone())
            .filter(|value| !value.trim().is_empty())
            .collect::<Vec<_>>();
        if offer_ids.is_empty() {
            return Ok(());
        }

        let mut barcodes_by_offer = std::collections::HashMap::new();
        for chunk in offer_ids.chunks(100) {
            let data = self.product_info(chunk.to_vec()).await?;
            for item in extract_items(&data) {
                let offer_id = item
                    .get("offer_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if offer_id.is_empty() {
                    continue;
                }
                let has_barcode =
                    item.get("barcodes")
                        .and_then(Value::as_array)
                        .is_some_and(|items| {
                            items.iter().any(|value| {
                                value.as_str().is_some_and(|text| !text.trim().is_empty())
                            })
                        });
                barcodes_by_offer.insert(offer_id, has_barcode);
            }
        }

        for row in rows {
            if let Some(has_barcode) = barcodes_by_offer.get(&row.offer_id) {
                row.has_barcode = Some(*has_barcode);
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

    pub async fn update_product_attributes(&self, items: Vec<Value>) -> Result<Value> {
        self.request_json("/v1/product/attributes/update", json!({ "items": items }))
            .await
    }

    pub async fn merge_product_cards(
        &self,
        product_ids: Vec<i64>,
        group_size: usize,
    ) -> Result<Value> {
        let group_size = group_size.clamp(2, 20);
        let mut details_by_id = HashMap::new();
        for chunk in product_ids.chunks(100) {
            let data = self.product_info_by_product_ids(chunk.to_vec()).await?;
            for item in extract_items(&data) {
                if let Some(product_id) = item
                    .get("product_id")
                    .or_else(|| item.get("id"))
                    .and_then(value_as_i64)
                {
                    details_by_id.insert(product_id, item);
                }
            }
        }

        let offer_ids = product_ids
            .iter()
            .filter_map(|product_id| details_by_id.get(product_id))
            .filter_map(|item| item.get("offer_id").and_then(Value::as_str))
            .map(str::to_string)
            .collect::<Vec<_>>();
        let mut attributes_by_offer = HashMap::new();
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

        let mut category_groups: BTreeMap<(i64, i64), Vec<(i64, String, Value)>> = BTreeMap::new();
        let mut skipped = Vec::new();
        for product_id in product_ids {
            let Some(detail) = details_by_id.get(&product_id) else {
                skipped.push(json!({ "productId": product_id, "reason": "未找到商品详情" }));
                continue;
            };
            let offer_id = detail
                .get("offer_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let Some(attrs) = attributes_by_offer.get(&offer_id) else {
                skipped.push(json!({ "productId": product_id, "offerId": offer_id, "reason": "未找到商品属性" }));
                continue;
            };
            let Some(category_id) = product_category_id(attrs) else {
                skipped.push(json!({ "productId": product_id, "offerId": offer_id, "reason": "缺少类目 ID" }));
                continue;
            };
            let Some(type_id) = product_type_id(attrs) else {
                skipped.push(json!({ "productId": product_id, "offerId": offer_id, "reason": "缺少类型 ID" }));
                continue;
            };
            category_groups
                .entry((category_id, type_id))
                .or_default()
                .push((product_id, offer_id, attrs.clone()));
        }

        let timestamp = chrono::Utc::now().timestamp();
        let mut update_items = Vec::new();
        let mut groups = Vec::new();
        for ((category_id, type_id), products) in category_groups {
            for (index, chunk) in products.chunks(group_size).enumerate() {
                if chunk.len() < 2 {
                    let (product_id, offer_id, _) = &chunk[0];
                    skipped.push(json!({
                        "productId": product_id,
                        "offerId": offer_id,
                        "reason": "同类目剩余商品不足 2 个"
                    }));
                    continue;
                }
                let group_value = format!("AUTO-{category_id}-{type_id}-{timestamp}-{}", index + 1);
                let mut group_product_ids = Vec::new();
                let mut group_update_items = Vec::new();
                for (product_id, offer_id, attrs) in chunk {
                    let attributes = merge_card_attribute_updates(attrs, &group_value);
                    if attributes.is_empty() {
                        skipped.push(json!({
                            "productId": product_id,
                            "offerId": offer_id,
                            "reason": "该类目没有可更新的型号属性"
                        }));
                        continue;
                    }
                    group_update_items.push(json!({
                        "offer_id": offer_id,
                        "attributes": attributes
                    }));
                    group_product_ids.push(*product_id);
                }
                if group_product_ids.len() >= 2 {
                    update_items.extend(group_update_items);
                    groups.push(json!({
                        "categoryId": category_id,
                        "typeId": type_id,
                        "groupValue": group_value,
                        "productIds": group_product_ids
                    }));
                } else {
                    for (product_id, offer_id, _) in chunk {
                        if group_product_ids.contains(product_id) {
                            skipped.push(json!({
                                "productId": product_id,
                                "offerId": offer_id,
                                "reason": "同组可更新商品不足 2 个"
                            }));
                        }
                    }
                }
            }
        }

        let mut results = Vec::new();
        for (index, chunk) in update_items.chunks(100).enumerate() {
            let data = self.update_product_attributes(chunk.to_vec()).await?;
            results.push(json!({
                "batch": index + 1,
                "count": chunk.len(),
                "data": data
            }));
        }

        Ok(json!({
            "selected": details_by_id.len(),
            "updated": update_items.len(),
            "groupCount": groups.len(),
            "groups": groups,
            "skipped": skipped,
            "results": results
        }))
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

    pub async fn fbs_posting_list(
        &self,
        since: String,
        to: String,
        status: String,
        limit: u32,
    ) -> Result<Vec<OrderPostingRow>> {
        let mut filter = serde_json::Map::new();
        filter.insert("since".into(), json!(since));
        filter.insert("to".into(), json!(to));
        if !status.trim().is_empty() {
            filter.insert("status".into(), json!(status.trim()));
        }

        let data = self
            .request_json(
                "/v3/posting/fbs/list",
                json!({
                    "dir": "DESC",
                    "filter": filter,
                    "limit": limit.clamp(1, 1000),
                    "offset": 0,
                    "with": fbs_list_with_barcodes()
                }),
            )
            .await?;
        Ok(extract_fbs_postings(&data)
            .into_iter()
            .filter_map(order_posting_row)
            .collect())
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

    pub async fn action_candidates(
        &self,
        action_id: i64,
        limit: u32,
        last_id: String,
    ) -> Result<Value> {
        self.request_json(
            "/v1/actions/candidates",
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

    pub async fn deactivate_all_action_products(&self, action_id: i64) -> Result<Value> {
        let mut product_ids = Vec::new();
        let mut last_id = String::new();

        loop {
            let data = self
                .action_products(action_id, 1000, last_id.clone())
                .await?;
            let ids = extract_items(&data)
                .iter()
                .filter_map(action_product_id)
                .collect::<Vec<_>>();
            product_ids.extend(ids);

            let next_last_id = extract_last_id(&data).unwrap_or_default();
            if next_last_id.trim().is_empty() || next_last_id == last_id {
                break;
            }
            last_id = next_last_id;
        }

        product_ids.sort_unstable();
        product_ids.dedup();
        if product_ids.is_empty() {
            return Ok(json!({
                "total": 0,
                "batches": 0,
                "results": [],
            }));
        }

        let mut results = Vec::new();
        for (index, chunk) in product_ids.chunks(100).enumerate() {
            let data = self
                .deactivate_action_products(action_id, chunk.to_vec())
                .await?;
            results.push(json!({ "batch": index + 1, "count": chunk.len(), "data": data }));
        }

        Ok(json!({
            "total": product_ids.len(),
            "batches": results.len(),
            "results": results,
        }))
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
        "financial_data": true,
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

fn order_posting_row(item: Value) -> Option<OrderPostingRow> {
    let posting_number = item
        .get("posting_number")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if posting_number.is_empty() {
        return None;
    }
    let products = item
        .get("products")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let offer_ids = products
        .iter()
        .filter_map(|product| product.get("offer_id").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    Some(OrderPostingRow {
        shop_id: None,
        shop_name: None,
        posting_number,
        order_number: item
            .get("order_number")
            .and_then(Value::as_str)
            .map(str::to_string),
        order_id: item.get("order_id").and_then(value_as_i64),
        status: item
            .get("status")
            .and_then(Value::as_str)
            .map(str::to_string),
        in_process_at: item
            .get("in_process_at")
            .and_then(Value::as_str)
            .map(str::to_string),
        shipment_date: item
            .get("shipment_date")
            .and_then(Value::as_str)
            .map(str::to_string),
        products_count: products.len(),
        offer_ids,
        sales_amount: posting_sales_amount(&item),
        currency_code: posting_currency_code(&item),
    })
}

fn posting_sales_amount(item: &Value) -> Option<f64> {
    let products = item.get("products").and_then(Value::as_array)?;
    let mut total = 0.0;
    let mut found = false;
    for product in products {
        if let Some(price) = product
            .get("price")
            .or_else(|| product.get("offer_price"))
            .or_else(|| product.get("total_price"))
            .and_then(value_as_f64)
        {
            total += price;
            found = true;
        }
    }
    found.then_some(total)
}

fn posting_currency_code(item: &Value) -> Option<String> {
    item.get("products")
        .and_then(Value::as_array)
        .and_then(|products| {
            products.iter().find_map(|product| {
                product
                    .get("currency_code")
                    .or_else(|| product.get("currencyCode"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
        })
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

fn value_as_f64(value: &Value) -> Option<f64> {
    value.as_f64().or_else(|| {
        value
            .as_str()
            .and_then(|text| text.trim().replace(',', ".").parse::<f64>().ok())
    })
}

fn extract_last_id(data: &Value) -> Option<String> {
    data.pointer("/result/last_id")
        .or_else(|| data.get("last_id"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn action_product_id(item: &Value) -> Option<i64> {
    item.get("product_id")
        .or_else(|| item.get("productId"))
        .or_else(|| item.get("id"))
        .and_then(value_as_i64)
}

fn extract_price_value(item: &Value, key: &str) -> Option<String> {
    item.get(key).and_then(scalar_to_string).or_else(|| {
        item.pointer(&format!("/price/{key}"))
            .and_then(scalar_to_string)
    })
}

fn parse_analytics_rows(data: &Value) -> Vec<ProductAnalyticsRow> {
    data.pointer("/result/data")
        .or_else(|| data.get("data"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let product_id = item
                .get("dimensions")
                .and_then(Value::as_array)
                .and_then(|dimensions| dimensions.first())
                .and_then(|dimension| {
                    dimension
                        .get("id")
                        .or_else(|| dimension.get("value"))
                        .and_then(value_as_i64)
                });
            product_id.map(|product_id| ProductAnalyticsRow {
                product_id: Some(product_id),
                offer_id: String::new(),
                name: String::new(),
                category_id: None,
                category_name: None,
                type_id: None,
                type_name: None,
                search_views: analytics_metric(item, "hits_view_search", 0),
                card_views: analytics_metric(item, "hits_view_pdp", 1),
            })
        })
        .collect()
}

fn analytics_metric(item: &Value, key: &str, index: usize) -> i64 {
    item.get(key)
        .and_then(metric_as_i64)
        .or_else(|| {
            item.get("metrics")
                .and_then(Value::as_array)
                .and_then(|metrics| metrics.get(index))
                .and_then(metric_as_i64)
        })
        .unwrap_or_default()
}

fn metric_as_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_f64().map(|number| number.round() as i64))
        .or_else(|| {
            value
                .as_str()
                .and_then(|text| text.parse::<f64>().ok())
                .map(|number| number.round() as i64)
        })
}

fn merge_card_attribute_updates(item: &Value, group_value: &str) -> Vec<Value> {
    item.get("attributes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|attribute| is_merge_card_attribute(attribute))
        .filter_map(|attribute| {
            let id = attribute
                .get("id")
                .or_else(|| attribute.get("attribute_id"))
                .and_then(value_as_i64)?;
            let mut update = serde_json::Map::new();
            update.insert("id".into(), json!(id));
            if let Some(complex_id) = attribute.get("complex_id").and_then(value_as_i64) {
                update.insert("complex_id".into(), json!(complex_id));
            }
            update.insert(
                "values".into(),
                json!([{ "dictionary_value_id": 0, "value": group_value }]),
            );
            Some(Value::Object(update))
        })
        .collect()
}

fn is_merge_card_attribute(attribute: &Value) -> bool {
    let attr_id = attribute
        .get("id")
        .or_else(|| attribute.get("attribute_id"))
        .and_then(value_as_i64);
    if attr_id.is_some_and(|id| MERGE_CARD_ATTRIBUTE_IDS.contains(&id)) {
        return true;
    }
    let names = ["name", "attribute_name", "title"]
        .iter()
        .filter_map(|key| attribute.get(*key).and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    ["merge", "combine", "объедин", "合并", "型号", "модель"]
        .iter()
        .any(|marker| names.contains(marker))
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
        .unwrap_or_else(|| extract_items(data));
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
    fn parses_analytics_metrics_and_product_id() {
        let rows = parse_analytics_rows(&json!({
            "result": {
                "data": [{
                    "dimensions": [{"id": "12345", "name": "商品"}],
                    "metrics": [17, 42]
                }]
            }
        }));

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].product_id, Some(12345));
        assert_eq!(rows[0].search_views, 17);
        assert_eq!(rows[0].card_views, 42);
    }

    #[test]
    fn builds_only_merge_card_attribute_updates() {
        let updates = merge_card_attribute_updates(
            &json!({
                "attributes": [
                    {"id": 9048, "name": "Название модели", "values": [{"value": "OLD"}]},
                    {"id": 10096, "name": "Цвет", "values": [{"value": "black"}]}
                ]
            }),
            "AUTO-GROUP",
        );

        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0]["id"], 9048);
        assert_eq!(updates[0]["values"][0]["value"], "AUTO-GROUP");
        assert!(updates[0].get("name").is_none());
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
