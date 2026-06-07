use crate::core::models::{ImportPreviewInput, SkuFolderReport, SkuFolderRow};
use anyhow::{Context, Result};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp"];
const IMPORT_ALLOWED_FIELDS: &[&str] = &[
    "attributes",
    "category_id",
    "color_image",
    "complex_attributes",
    "currency_code",
    "depth",
    "description",
    "description_category_id",
    "dimension_unit",
    "height",
    "images",
    "name",
    "offer_id",
    "old_price",
    "pdf_list",
    "premium_price",
    "price",
    "primary_image",
    "type_id",
    "vat",
    "weight",
    "weight_unit",
    "width",
];

pub fn build_oss_folder(shop_id: &str, sku: &str) -> Result<String> {
    let shop = shop_id.trim();
    if shop.is_empty() {
        anyhow::bail!("店铺 ID 不能为空");
    }
    let clean_sku = sku.trim().replace(['/', '\\'], "_");
    Ok(format!(
        "{shop}/{}",
        if clean_sku.is_empty() {
            "sku"
        } else {
            &clean_sku
        }
    ))
}

pub fn build_oss_object_key(shop_id: &str, sku: &str, image_name: &str) -> Result<String> {
    let folder = build_oss_folder(shop_id, sku)?;
    let safe_name = Path::new(image_name)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("image.jpg")
        .trim()
        .replace(['/', '\\'], "_");
    Ok(format!(
        "{folder}/{}",
        if safe_name.is_empty() {
            "image.jpg"
        } else {
            &safe_name
        }
    ))
}

pub fn list_sku_images(folder: &Path) -> Result<Vec<PathBuf>> {
    let mut images = folder
        .read_dir()
        .with_context(|| format!("无法读取目录 {}", folder.display()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_supported_image(path))
        .collect::<Vec<_>>();
    images.sort_by(|a, b| {
        let a_name = a
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or_default()
            .to_lowercase();
        let b_name = b
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or_default()
            .to_lowercase();
        let a_rank = if a
            .file_stem()
            .and_then(|v| v.to_str())
            .unwrap_or_default()
            .ends_with("_ai_portrait")
        {
            0
        } else {
            1
        };
        let b_rank = if b
            .file_stem()
            .and_then(|v| v.to_str())
            .unwrap_or_default()
            .ends_with("_ai_portrait")
        {
            0
        } else {
            1
        };
        (a_rank, a_name).cmp(&(b_rank, b_name))
    });
    Ok(images)
}

pub fn analyze_sku_folder(root: &Path) -> Result<SkuFolderReport> {
    if !root.is_dir() {
        anyhow::bail!("目录不存在: {}", root.display());
    }
    let mut rows = Vec::new();
    let mut image_count = 0;
    for entry in root.read_dir()? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let images = list_sku_images(&path)?;
        image_count += images.len();
        rows.push(SkuFolderRow {
            sku: entry.file_name().to_string_lossy().to_string(),
            image_count: images.len(),
            first_image: images.first().map(|path| path.display().to_string()),
        });
    }
    rows.sort_by(|a, b| a.sku.cmp(&b.sku));
    Ok(SkuFolderReport {
        root: root.display().to_string(),
        sku_count: rows.len(),
        image_count,
        rows,
    })
}

pub fn build_import_item(input: ImportPreviewInput) -> Value {
    let allowed: HashSet<&str> = IMPORT_ALLOWED_FIELDS.iter().copied().collect();
    let mut item = Map::new();
    if let Some(template) = input.template_product.as_object() {
        for (key, value) in template {
            if allowed.contains(key.as_str()) {
                item.insert(key.clone(), value.clone());
            }
        }
    }

    item.insert("offer_id".into(), json!(input.offer_id));
    item.insert("name".into(), json!(input.title));
    item.insert("description".into(), json!(input.description));
    item.insert("images".into(), json!(input.image_urls.clone()));

    if let Some(primary) = input.image_urls.first() {
        item.insert("primary_image".into(), json!(primary));
    }

    replace_description_attribute(&mut item, &input.description);
    replace_rich_json(&mut item, input.rich_json.as_deref(), &input.image_urls);
    merge_video_links(&mut item, &input.video_links);
    Value::Object(item)
}

pub fn extract_image_urls(product: &Value) -> Vec<String> {
    let mut urls = Vec::new();
    push_url(product.get("primary_image"), &mut urls);
    if let Some(images) = product.get("images").and_then(Value::as_array) {
        for image in images {
            push_url(Some(image), &mut urls);
        }
    }
    if let Some(images) = product.get("images360").and_then(Value::as_array) {
        for image in images {
            push_url(Some(image), &mut urls);
        }
    }
    urls.dedup();
    urls
}

pub fn extract_task_id(response: &Value) -> Option<String> {
    response
        .pointer("/result/task_id")
        .or_else(|| response.pointer("/result/id"))
        .or_else(|| response.get("task_id"))
        .or_else(|| response.get("id"))
        .and_then(|value| {
            value
                .as_str()
                .map(str::to_string)
                .or_else(|| value.as_i64().map(|id| id.to_string()))
        })
}

fn is_supported_image(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| IMAGE_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
        .unwrap_or(false)
}

fn push_url(value: Option<&Value>, urls: &mut Vec<String>) {
    match value {
        Some(Value::String(text))
            if text.starts_with("http://") || text.starts_with("https://") =>
        {
            urls.push(text.to_string())
        }
        Some(Value::Object(map)) => {
            for key in ["url", "file_name", "image", "image_url"] {
                if let Some(Value::String(text)) = map.get(key) {
                    if text.starts_with("http://") || text.starts_with("https://") {
                        urls.push(text.to_string());
                    }
                }
            }
        }
        _ => {}
    }
}

fn replace_description_attribute(item: &mut Map<String, Value>, description: &str) {
    let Some(attributes) = item.get_mut("attributes").and_then(Value::as_array_mut) else {
        return;
    };
    for attribute in attributes {
        let attr_id = attribute
            .get("id")
            .or_else(|| attribute.get("attribute_id"))
            .and_then(Value::as_i64);
        let name = attribute
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_lowercase();
        if attr_id == Some(4191)
            || name.contains("description")
            || name.contains("описание")
            || name.contains("描述")
        {
            attribute["values"] = json!([{ "value": description }]);
        }
    }
}

fn replace_rich_json(
    item: &mut Map<String, Value>,
    rich_json: Option<&str>,
    image_urls: &[String],
) {
    let Some(raw) = rich_json.map(str::trim).filter(|text| !text.is_empty()) else {
        return;
    };
    let Ok(mut value) = serde_json::from_str::<Value>(raw) else {
        return;
    };
    let mut cursor = 0usize;
    rewrite_image_urls(&mut value, image_urls, &mut cursor);
    item.insert("rich_content_json".into(), value);
}

fn rewrite_image_urls(value: &mut Value, image_urls: &[String], cursor: &mut usize) {
    match value {
        Value::Object(map) => {
            for (key, val) in map.iter_mut() {
                let is_image_key = matches!(
                    key.as_str(),
                    "image" | "image_url" | "src" | "url" | "pictures"
                );
                if is_image_key && val.is_string() && !image_urls.is_empty() {
                    *val = json!(image_urls[*cursor % image_urls.len()]);
                    *cursor += 1;
                } else {
                    rewrite_image_urls(val, image_urls, cursor);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                rewrite_image_urls(item, image_urls, cursor);
            }
        }
        _ => {}
    }
}

fn merge_video_links(item: &mut Map<String, Value>, video_links: &[String]) {
    if video_links.is_empty() {
        return;
    }
    let video_values: Vec<Value> = video_links
        .iter()
        .filter(|link| !link.trim().is_empty())
        .map(|link| json!({ "value": link.trim() }))
        .collect();
    if video_values.is_empty() {
        return;
    }

    let attributes = item.entry("attributes").or_insert_with(|| json!([]));
    let Some(attributes) = attributes.as_array_mut() else {
        return;
    };
    attributes.retain(|attr| {
        attr.get("id")
            .or_else(|| attr.get("attribute_id"))
            .and_then(Value::as_i64)
            != Some(21841)
    });
    attributes.push(json!({
        "id": 21841,
        "complex_id": 0,
        "values": video_values
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oss_key_keeps_shop_and_sku() {
        assert_eq!(
            build_oss_object_key("123", "SKU/1", "../a.jpg").unwrap(),
            "123/SKU_1/a.jpg"
        );
    }

    #[test]
    fn import_item_sets_core_fields() {
        let item = build_import_item(ImportPreviewInput {
            template_product: json!({"currency_code": "RUB", "name": "old", "ignored": true}),
            offer_id: "SKU001".into(),
            title: "Title".into(),
            description: "Desc".into(),
            image_urls: vec!["https://cdn/a.jpg".into()],
            video_links: vec!["https://video".into()],
            rich_json: None,
        });
        assert_eq!(item["offer_id"], "SKU001");
        assert_eq!(item["currency_code"], "RUB");
        assert!(item.get("ignored").is_none());
        assert_eq!(item["attributes"][0]["id"], 21841);
    }
}
