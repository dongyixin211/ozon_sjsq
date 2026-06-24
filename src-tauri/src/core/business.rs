use crate::core::models::{
    AttributeDictionaryValue, ImportPreviewInput, SkuFolderReport, SkuFolderRow,
};
use anyhow::{Context, Result};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp"];
const IMPORT_ALLOWED_TEMPLATE_FIELDS: &[&str] = &[
    "attributes",
    "category_id",
    "complex_attributes",
    "currency_code",
    "depth",
    "description",
    "description_category_id",
    "dimension_unit",
    "height",
    "old_price",
    "pdf_list",
    "premium_price",
    "price",
    "rich_content_json",
    "type_id",
    "vat",
    "weight",
    "weight_unit",
    "width",
];
const MERGE_CARD_ATTRIBUTE_IDS: &[i64] = &[8292, 9048];
const PRODUCT_COLOR_ATTRIBUTE_IDS: &[i64] = &[10096];
const COLOR_NAME_ATTRIBUTE_IDS: &[i64] = &[10097];
const MERGE_CARD_NAME_MARKERS: &[&str] = &["merge", "combine", "объедин", "合并"];
const PRODUCT_COLOR_NAME_MARKERS: &[&str] = &[
    "product color",
    "color of product",
    "товарный цвет",
    "цвет товара",
    "商品颜色",
];
const COLOR_NAME_MARKERS: &[&str] = &[
    "color name",
    "name of color",
    "название цвета",
    "颜色名称",
    "俄语颜色",
];
const RICH_IMG_URL_KEYS: &[&str] = &[
    "src",
    "srcMobile",
    "src_mobile",
    "url",
    "image_url",
    "imageUrl",
];
const VIDEO_ATTR_ID_NAME: i64 = 21837;
const VIDEO_ATTR_ID_URL: i64 = 21841;
const VIDEO_COMPLEX_ID: i64 = 100001;

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
        let a_rank = if is_ai_generated_image(a) { 0 } else { 1 };
        let b_rank = if is_ai_generated_image(b) { 0 } else { 1 };
        (a_rank, a_name).cmp(&(b_rank, b_name))
    });
    Ok(images)
}

pub fn is_ai_generated_image(path: &Path) -> bool {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();
    stem.ends_with("_ai_portrait") || stem.ends_with("_ai_vertical")
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
    let allowed = IMPORT_ALLOWED_TEMPLATE_FIELDS
        .iter()
        .copied()
        .collect::<HashSet<_>>();
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

    let template_offer_id = input
        .template_product
        .get("offer_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    replace_merge_card_attributes(&mut item, &input.offer_id, &template_offer_id);
    replace_description_attribute(&mut item, &input.description);
    replace_color_attributes(
        &mut item,
        &input.product_color,
        &input.product_color_dictionary_values,
        &input.color_name,
    );
    replace_rich_json(&mut item, input.rich_json.as_deref(), &input.image_urls);
    merge_video_links(&mut item, &input.video_links, &input.offer_id);
    move_template_video_to_attributes(&mut item, &input.offer_id);
    sanitize_import_item(&mut item);
    normalize_import_payload(&mut item);
    Value::Object(item)
}

fn sanitize_import_item(item: &mut Map<String, Value>) {
    item.remove("color_image");
}

fn normalize_import_payload(item: &mut Map<String, Value>) {
    if let Some(attributes) = item.get_mut("attributes") {
        normalize_attribute_list(attributes);
    }
    if let Some(complex_attributes) = item.get_mut("complex_attributes") {
        normalize_attribute_list(complex_attributes);
    }
}

fn normalize_attribute_list(value: &mut Value) {
    let Some(items) = value.as_array_mut() else {
        return;
    };
    for item in items {
        normalize_attribute_object(item);
    }
}

fn normalize_attribute_object(value: &mut Value) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    if !object.contains_key("id") {
        if let Some(attribute_id) = object.remove("attribute_id") {
            object.insert("id".into(), attribute_id);
        }
    } else {
        object.remove("attribute_id");
    }
    if let Some(attributes) = object.get_mut("attributes") {
        normalize_attribute_list(attributes);
    }
}

pub fn extract_template_description(product: &Value) -> String {
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

pub fn content_description(row_description: &str, template_product: &Value) -> String {
    let row_description = row_description.trim();
    if row_description.is_empty() {
        extract_template_description(template_product)
    } else {
        row_description.to_string()
    }
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
    let source = rich_json
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .or_else(|| item.get("rich_content_json").and_then(json_value))
        .or_else(|| find_rich_content_in_attributes(item));

    if let Some(mut value) = source {
        replace_rich_image_urls(&mut value, image_urls);
        replace_rich_content_attributes(item, &value);
        item.insert("rich_content_json".into(), value);
    }
}

fn replace_color_attributes(
    item: &mut Map<String, Value>,
    product_color: &str,
    product_color_dictionary_values: &[AttributeDictionaryValue],
    color_name: &str,
) {
    let product_color = product_color.trim();
    let color_name = color_name.trim();
    if product_color.is_empty()
        && color_name.is_empty()
        && product_color_dictionary_values.is_empty()
    {
        return;
    }
    for field_name in ["attributes", "complex_attributes"] {
        let Some(attributes) = item.get_mut(field_name).and_then(Value::as_array_mut) else {
            continue;
        };
        for attribute in attributes {
            let attr_id = attribute_id(attribute);
            let names = attribute_names(attribute);
            if !color_name.is_empty()
                && (COLOR_NAME_ATTRIBUTE_IDS.contains(&attr_id.unwrap_or_default())
                    || COLOR_NAME_MARKERS
                        .iter()
                        .any(|marker| names.contains(marker)))
            {
                set_attribute_value(attribute, color_name);
                continue;
            }
            if !product_color.is_empty()
                && (PRODUCT_COLOR_ATTRIBUTE_IDS.contains(&attr_id.unwrap_or_default())
                    || PRODUCT_COLOR_NAME_MARKERS
                        .iter()
                        .any(|marker| names.contains(marker)))
            {
                set_dictionary_attribute_values(
                    attribute,
                    product_color_dictionary_values,
                    product_color,
                );
            }
        }
    }
}

fn attribute_id(attribute: &Value) -> Option<i64> {
    attribute
        .get("id")
        .or_else(|| attribute.get("attribute_id"))
        .and_then(Value::as_i64)
}

fn attribute_names(attribute: &Value) -> String {
    let Some(attribute) = attribute.as_object() else {
        return String::new();
    };
    ["name", "attribute_name", "title"]
        .iter()
        .filter_map(|key| attribute.get(*key).and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn parse_rich_content_json(text: &str) -> Option<Value> {
    let value = serde_json::from_str::<Value>(text).ok()?;
    rich_content_value(&value)
}

fn json_value(value: &Value) -> Option<Value> {
    match value {
        Value::String(text) => serde_json::from_str::<Value>(text).ok(),
        _ => Some(value.clone()),
    }
}

fn rich_content_value(value: &Value) -> Option<Value> {
    match value {
        Value::Object(map) if map.get("content").is_some_and(Value::is_array) => {
            Some(value.clone())
        }
        Value::String(text) => parse_rich_content_json(text),
        _ => None,
    }
}

fn find_rich_content_in_attributes(item: &Map<String, Value>) -> Option<Value> {
    ["attributes", "complex_attributes"]
        .iter()
        .filter_map(|field_name| item.get(*field_name).and_then(Value::as_array))
        .flat_map(|attributes| attributes.iter())
        .find_map(find_rich_content_in_value)
}

fn find_rich_content_in_value(value: &Value) -> Option<Value> {
    if let Some(value) = rich_content_value(value) {
        return Some(value);
    }
    match value {
        Value::Object(map) => map.values().find_map(find_rich_content_in_value),
        Value::Array(items) => items.iter().find_map(find_rich_content_in_value),
        _ => None,
    }
}

fn replace_rich_content_attributes(item: &mut Map<String, Value>, rich_content: &Value) {
    let Ok(text) = serde_json::to_string(rich_content) else {
        return;
    };
    for field_name in ["attributes", "complex_attributes"] {
        let Some(attributes) = item.get_mut(field_name).and_then(Value::as_array_mut) else {
            continue;
        };
        for attribute in attributes {
            replace_rich_content_in_value(attribute, &text);
        }
    }
}

fn replace_rich_content_in_value(value: &mut Value, rich_content_text: &str) -> bool {
    if rich_content_value(value).is_some() {
        *value = json!(rich_content_text);
        return true;
    }
    match value {
        Value::Object(map) => {
            let mut changed = false;
            for child in map.values_mut() {
                changed |= replace_rich_content_in_value(child, rich_content_text);
            }
            changed
        }
        Value::Array(items) => {
            let mut changed = false;
            for child in items {
                changed |= replace_rich_content_in_value(child, rich_content_text);
            }
            changed
        }
        _ => false,
    }
}

fn replace_rich_image_urls(value: &mut Value, image_urls: &[String]) {
    if !replace_rich_content_images(value, image_urls) {
        let mut cursor = 0usize;
        rewrite_image_urls(value, image_urls, &mut cursor, false);
    }
}

fn replace_rich_content_images(value: &mut Value, image_urls: &[String]) -> bool {
    if image_urls.is_empty() {
        return false;
    }
    let Some(content) = value.get_mut("content").and_then(Value::as_array_mut) else {
        return false;
    };

    let mut slot_index = 0usize;
    let mut changed = false;
    for widget in content {
        let Some(widget) = widget.as_object_mut() else {
            continue;
        };
        if let Some(blocks) = widget.get_mut("blocks").and_then(Value::as_array_mut) {
            for block in blocks {
                let Some(block) = block.as_object_mut() else {
                    continue;
                };
                if let Some(img) = block.get_mut("img").and_then(Value::as_object_mut) {
                    let url = next_clamped_image_url(image_urls, &mut slot_index);
                    changed |= assign_rich_img_dict(img, url);
                }
            }
            continue;
        }
        if let Some(img) = widget.get_mut("img").and_then(Value::as_object_mut) {
            let url = next_clamped_image_url(image_urls, &mut slot_index);
            changed |= assign_rich_img_dict(img, url);
            continue;
        }
        if widget.get("src").is_some_and(is_http_url) {
            let url = next_clamped_image_url(image_urls, &mut slot_index);
            widget.insert("src".into(), json!(url));
            changed = true;
            continue;
        }
        if let Some(images) = widget.get_mut("images").and_then(Value::as_array_mut) {
            for entry in images {
                let Some(entry) = entry.as_object_mut() else {
                    continue;
                };
                if let Some(img) = entry.get_mut("img").and_then(Value::as_object_mut) {
                    let url = next_clamped_image_url(image_urls, &mut slot_index);
                    changed |= assign_rich_img_dict(img, url);
                } else if entry.get("src").is_some_and(is_http_url) {
                    let url = next_clamped_image_url(image_urls, &mut slot_index);
                    entry.insert("src".into(), json!(url));
                    changed = true;
                }
            }
        }
    }
    changed
}

fn next_clamped_image_url<'a>(image_urls: &'a [String], cursor: &mut usize) -> &'a str {
    let url = &image_urls[(*cursor).min(image_urls.len() - 1)];
    *cursor += 1;
    url
}

fn assign_rich_img_dict(img: &mut Map<String, Value>, url: &str) -> bool {
    let mut changed = false;
    for key in RICH_IMG_URL_KEYS {
        if img.get(*key).is_some_and(is_http_url) {
            img.insert((*key).into(), json!(url));
            changed = true;
        }
    }
    changed
}

fn is_http_url(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|text| text.starts_with("http://") || text.starts_with("https://"))
}

fn rewrite_image_urls(
    value: &mut Value,
    image_urls: &[String],
    cursor: &mut usize,
    image_context: bool,
) {
    if image_urls.is_empty() {
        return;
    }
    match value {
        Value::Object(map) => {
            for (key, val) in map.iter_mut() {
                let is_image_key = is_rich_image_key(key);
                if is_image_key && val.is_string() {
                    replace_next_image_url(val, image_urls, cursor);
                } else {
                    rewrite_image_urls(val, image_urls, cursor, image_context || is_image_key);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                rewrite_image_urls(item, image_urls, cursor, image_context);
            }
        }
        Value::String(_) if image_context => replace_next_image_url(value, image_urls, cursor),
        _ => {}
    }
}

fn is_rich_image_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|ch| *ch != '_' && *ch != '-')
        .collect::<String>()
        .to_lowercase();
    matches!(
        normalized.as_str(),
        "image"
            | "images"
            | "imageurl"
            | "imageurls"
            | "src"
            | "source"
            | "sources"
            | "url"
            | "urls"
            | "picture"
            | "pictures"
            | "photo"
            | "photos"
    )
}

fn replace_next_image_url(value: &mut Value, image_urls: &[String], cursor: &mut usize) {
    *value = json!(image_urls[*cursor % image_urls.len()]);
    *cursor += 1;
}

fn replace_merge_card_attributes(
    item: &mut Map<String, Value>,
    offer_id: &str,
    template_offer_id: &str,
) {
    let model_name = model_name_from_offer_id(offer_id);
    for field_name in ["attributes", "complex_attributes"] {
        let Some(attributes) = item.get_mut(field_name).and_then(Value::as_array_mut) else {
            continue;
        };
        for attribute in attributes {
            if is_merge_card_attribute(attribute, template_offer_id)
                || is_merge_card_named_attribute(attribute)
            {
                set_attribute_value(attribute, &model_name);
            }
        }
    }
}

fn model_name_from_offer_id(offer_id: &str) -> String {
    offer_id
        .rsplit_once('_')
        .map(|(_, tail)| tail)
        .unwrap_or(offer_id)
        .trim()
        .to_string()
}

fn is_merge_card_attribute(attribute: &Value, template_offer_id: &str) -> bool {
    let Some(attribute) = attribute.as_object() else {
        return false;
    };
    let attr_id = attribute
        .get("id")
        .or_else(|| attribute.get("attribute_id"))
        .and_then(Value::as_i64);
    if attr_id.is_some_and(|id| MERGE_CARD_ATTRIBUTE_IDS.contains(&id)) {
        return true;
    }
    !template_offer_id.is_empty() && attribute_values_equal(attribute, template_offer_id)
}

fn attribute_values_equal(attribute: &Map<String, Value>, expected: &str) -> bool {
    attribute
        .get("values")
        .and_then(Value::as_array)
        .is_some_and(|values| {
            values.iter().any(|value| {
                value
                    .get("value")
                    .and_then(Value::as_str)
                    .is_some_and(|text| text.trim() == expected)
            })
        })
}

fn is_merge_card_named_attribute(attribute: &Value) -> bool {
    let Some(attribute) = attribute.as_object() else {
        return false;
    };
    let names = ["name", "attribute_name", "title"]
        .iter()
        .filter_map(|key| attribute.get(*key).and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    MERGE_CARD_NAME_MARKERS
        .iter()
        .any(|marker| names.contains(marker))
}

fn set_attribute_value(attribute: &mut Value, value: &str) {
    let Some(attribute) = attribute.as_object_mut() else {
        return;
    };
    let Some(values) = attribute.get_mut("values").and_then(Value::as_array_mut) else {
        attribute.insert(
            "values".into(),
            json!([{ "dictionary_value_id": 0, "value": value }]),
        );
        return;
    };
    if values.is_empty() {
        values.push(json!({ "dictionary_value_id": 0, "value": value }));
        return;
    }
    for item in values {
        if let Some(object) = item.as_object_mut() {
            object.insert("dictionary_value_id".into(), json!(0));
            object.insert("value".into(), json!(value));
        } else {
            *item = json!(value);
        }
    }
}

fn set_dictionary_attribute_values(
    attribute: &mut Value,
    values: &[AttributeDictionaryValue],
    fallback_value: &str,
) {
    if values.is_empty() {
        set_attribute_value(attribute, fallback_value);
        return;
    }
    let Some(attribute) = attribute.as_object_mut() else {
        return;
    };
    attribute.insert(
        "values".into(),
        Value::Array(
            values
                .iter()
                .map(|value| {
                    json!({
                        "dictionary_value_id": value.dictionary_value_id,
                        "value": value.value,
                    })
                })
                .collect(),
        ),
    );
}

fn merge_video_links(item: &mut Map<String, Value>, video_links: &[String], offer_id: &str) {
    if video_links.is_empty() {
        return;
    }
    let video_values: Vec<Value> = video_links
        .iter()
        .filter(|link| !link.trim().is_empty())
        .map(|link| json!({ "dictionary_value_id": 0, "value": link.trim() }))
        .collect();
    if video_values.is_empty() {
        return;
    }
    let video_name = extract_video_name(item, offer_id);
    strip_video_attributes(item);

    let attributes = item.entry("attributes").or_insert_with(|| json!([]));
    let Some(attributes) = attributes.as_array_mut() else {
        return;
    };
    attributes.push(json!({
        "id": VIDEO_ATTR_ID_NAME,
        "complex_id": VIDEO_COMPLEX_ID,
        "values": [{ "dictionary_value_id": 0, "value": video_name }]
    }));
    attributes.push(json!({
        "id": VIDEO_ATTR_ID_URL,
        "complex_id": VIDEO_COMPLEX_ID,
        "values": video_values
    }));
}

fn move_template_video_to_attributes(item: &mut Map<String, Value>, offer_id: &str) {
    let video_attributes = collect_video_attributes(item, offer_id);
    if video_attributes.is_empty() {
        return;
    }
    strip_video_attributes(item);
    let attributes = item.entry("attributes").or_insert_with(|| json!([]));
    let Some(attributes) = attributes.as_array_mut() else {
        return;
    };
    attributes.extend(video_attributes);
}

fn collect_video_attributes(item: &Map<String, Value>, offer_id: &str) -> Vec<Value> {
    let mut copied = Vec::new();
    let mut seen = HashSet::new();
    for field_name in ["attributes", "complex_attributes"] {
        let Some(attributes) = item.get(field_name).and_then(Value::as_array) else {
            continue;
        };
        for attribute in attributes {
            let Some(attr_id) = video_attr_id(attribute) else {
                continue;
            };
            if !seen.insert(attr_id) {
                continue;
            }
            let mut attribute = attribute.clone();
            if let Some(object) = attribute.as_object_mut() {
                object.insert("id".into(), json!(attr_id));
                object.remove("attribute_id");
                object.insert("complex_id".into(), json!(VIDEO_COMPLEX_ID));
                if attr_id == VIDEO_ATTR_ID_NAME {
                    object.insert(
                        "values".into(),
                        json!([{ "dictionary_value_id": 0, "value": extract_video_name(item, offer_id) }]),
                    );
                }
            }
            copied.push(attribute);
        }
    }
    copied
}

fn strip_video_attributes(item: &mut Map<String, Value>) {
    for field_name in ["attributes", "complex_attributes"] {
        if let Some(attributes) = item.get_mut(field_name).and_then(Value::as_array_mut) {
            attributes.retain(|attr| video_attr_id(attr).is_none());
        }
    }
}

fn video_attr_id(attribute: &Value) -> Option<i64> {
    let id = attribute
        .get("id")
        .or_else(|| attribute.get("attribute_id"))
        .and_then(Value::as_i64)?;
    matches!(id, VIDEO_ATTR_ID_NAME | VIDEO_ATTR_ID_URL).then_some(id)
}

fn extract_video_name(item: &Map<String, Value>, offer_id: &str) -> String {
    for field_name in ["attributes", "complex_attributes"] {
        let Some(attributes) = item.get(field_name).and_then(Value::as_array) else {
            continue;
        };
        for attribute in attributes {
            if video_attr_id(attribute) != Some(VIDEO_ATTR_ID_NAME) {
                continue;
            }
            let Some(values) = attribute.get("values").and_then(Value::as_array) else {
                continue;
            };
            for value in values {
                let text = value
                    .get("value")
                    .and_then(Value::as_str)
                    .or_else(|| value.as_str())
                    .unwrap_or_default()
                    .trim();
                if !text.is_empty() {
                    return text.to_string();
                }
            }
        }
    }
    let offer_id = offer_id.trim();
    if offer_id.is_empty() {
        "product_video.mp4".into()
    } else {
        format!("{offer_id}_video.mp4")
    }
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
            product_color: String::new(),
            product_color_dictionary_values: Vec::new(),
            color_name: String::new(),
            description: "Desc".into(),
            image_urls: vec!["https://cdn/a.jpg".into()],
            video_links: vec!["https://video".into()],
            rich_json: None,
        });
        assert_eq!(item["offer_id"], "SKU001");
        assert_eq!(item["currency_code"], "RUB");
        assert!(item.get("ignored").is_none());
        assert_eq!(item["attributes"][0]["id"], 21837);
        assert_eq!(item["attributes"][1]["id"], 21841);
        assert_eq!(item["attributes"][1]["values"][0]["value"], "https://video");
    }

    #[test]
    fn keeps_template_content_but_replaces_identity_and_images() {
        let item = build_import_item(ImportPreviewInput {
            template_product: json!({
                "product_id": 1001,
                "offer_id": "OLD",
                "name": "Old title",
                "price": "999",
                "currency_code": "RUB",
                "description_category_id": 10,
                "type_id": 20,
                "attributes": [{"attribute_id": 4191, "values": [{"value": "Old desc"}]}],
                "primary_image": "https://old/main.jpg",
                "images": ["https://old/main.jpg"],
                "color_image": "https://old/color.jpg",
                "rich_content_json": {"blocks": [{"image": "https://old/rich.jpg"}]},
                "status": {"state": "processed"},
                "unknown_from_info": true
            }),
            offer_id: "NEW".into(),
            title: "New title".into(),
            product_color: String::new(),
            product_color_dictionary_values: Vec::new(),
            color_name: String::new(),
            description: "New desc".into(),
            image_urls: vec!["https://new/1.jpg".into(), "https://new/2.jpg".into()],
            video_links: vec![],
            rich_json: None,
        });
        assert_eq!(item["offer_id"], "NEW");
        assert_eq!(item["name"], "New title");
        assert_eq!(item["price"], "999");
        assert_eq!(item["description_category_id"], 10);
        assert_eq!(item["type_id"], 20);
        assert_eq!(item["primary_image"], "https://new/1.jpg");
        assert_eq!(item["images"][0], "https://new/1.jpg");
        assert_eq!(item["attributes"][0]["id"], 4191);
        assert!(item["attributes"][0].get("attribute_id").is_none());
        assert_eq!(
            item["rich_content_json"]["blocks"][0]["image"],
            "https://new/1.jpg"
        );
        assert!(item.get("product_id").is_none());
        assert!(item.get("color_image").is_none());
        assert!(item.get("status").is_none());
        assert!(item.get("unknown_from_info").is_none());
    }

    #[test]
    fn uses_template_description_when_row_description_is_empty() {
        let template = json!({
            "description": "Template description",
            "attributes": [{"id": 4191, "values": [{"value": "Attribute description"}]}]
        });
        assert_eq!(
            content_description("", &template),
            "Template description".to_string()
        );
        assert_eq!(
            content_description("Row description", &template),
            "Row description".to_string()
        );
    }

    #[test]
    fn drops_invalid_color_image_from_template() {
        let item = build_import_item(ImportPreviewInput {
            template_product: json!({"color_image": [], "currency_code": "RUB"}),
            offer_id: "SKU001".into(),
            title: "Title".into(),
            product_color: String::new(),
            product_color_dictionary_values: Vec::new(),
            color_name: String::new(),
            description: "Desc".into(),
            image_urls: vec!["https://cdn/a.jpg".into()],
            video_links: vec![],
            rich_json: None,
        });
        assert!(item.get("color_image").is_none());
        assert_eq!(item["currency_code"], "RUB");
    }

    #[test]
    fn explicit_rich_json_overrides_template_rich_json() {
        let item = build_import_item(ImportPreviewInput {
            template_product: json!({
                "rich_content_json": {"blocks": [{"image": "https://old/template.jpg"}]}
            }),
            offer_id: "SKU001".into(),
            title: "Title".into(),
            product_color: String::new(),
            product_color_dictionary_values: Vec::new(),
            color_name: String::new(),
            description: "Desc".into(),
            image_urls: vec!["https://new/a.jpg".into()],
            video_links: vec![],
            rich_json: Some(r#"{"blocks":[{"image":"https://old/excel.jpg"}]}"#.into()),
        });
        assert_eq!(
            item["rich_content_json"]["blocks"][0]["image"],
            "https://new/a.jpg"
        );
    }

    #[test]
    fn rich_json_uses_product_images_in_order() {
        let item = build_import_item(ImportPreviewInput {
            template_product: json!({
                "rich_content_json": {
                    "content": [
                        {"blocks": [
                            {"img": {"src": "https://old/1.jpg", "srcMobile": "https://old/1m.jpg"}},
                            {"img": {"src": "https://old/2.jpg", "srcMobile": "https://old/2m.jpg"}}
                        ]},
                        {"images": [
                            {"img": {"src": "https://old/3.jpg", "srcMobile": "https://old/3m.jpg"}}
                        ]}
                    ]
                }
            }),
            offer_id: "SKU001".into(),
            title: "Title".into(),
            product_color: String::new(),
            product_color_dictionary_values: Vec::new(),
            color_name: String::new(),
            description: "Desc".into(),
            image_urls: vec![
                "https://new/1.jpg".into(),
                "https://new/2.jpg".into(),
                "https://new/3.jpg".into(),
            ],
            video_links: vec![],
            rich_json: None,
        });
        let content = &item["rich_content_json"]["content"];
        let blocks = &content[0]["blocks"];
        assert_eq!(blocks[0]["img"]["src"], "https://new/1.jpg");
        assert_eq!(blocks[0]["img"]["srcMobile"], "https://new/1.jpg");
        assert_eq!(blocks[1]["img"]["src"], "https://new/2.jpg");
        assert_eq!(blocks[1]["img"]["srcMobile"], "https://new/2.jpg");
        assert_eq!(content[1]["images"][0]["img"]["src"], "https://new/3.jpg");
        assert_eq!(
            content[1]["images"][0]["img"]["srcMobile"],
            "https://new/3.jpg"
        );
    }

    #[test]
    fn rich_json_found_in_attribute_values_uses_product_images() {
        let item = build_import_item(ImportPreviewInput {
            template_product: json!({
                "attributes": [{
                    "id": 999999,
                    "name": "JSON rich content",
                    "values": [{
                        "value": r#"{"content":[{"blocks":[{"img":{"src":"https://old/1.jpg","srcMobile":"https://old/1m.jpg"}},{"img":{"src":"https://old/2.jpg","srcMobile":"https://old/2m.jpg"}}]}]}"#
                    }]
                }]
            }),
            offer_id: "SKU001".into(),
            title: "Title".into(),
            product_color: String::new(),
            product_color_dictionary_values: Vec::new(),
            color_name: String::new(),
            description: "Desc".into(),
            image_urls: vec!["https://new/1.jpg".into(), "https://new/2.jpg".into()],
            video_links: vec![],
            rich_json: None,
        });
        assert_eq!(
            item["rich_content_json"]["content"][0]["blocks"][0]["img"]["src"],
            "https://new/1.jpg"
        );
        assert_eq!(
            item["rich_content_json"]["content"][0]["blocks"][1]["img"]["src"],
            "https://new/2.jpg"
        );
        let attr_value = item["attributes"][0]["values"][0]["value"]
            .as_str()
            .unwrap();
        assert!(attr_value.contains("https://new/1.jpg"));
        assert!(attr_value.contains("https://new/2.jpg"));
        assert!(!attr_value.contains("https://old/1.jpg"));
    }

    #[test]
    fn rich_json_text_containing_model_word_is_not_replaced_by_offer_id() {
        let item = build_import_item(ImportPreviewInput {
            template_product: json!({
                "offer_id": "TM20251110001271",
                "attributes": [
                    {"id": 8292, "values": [{"value": "template-model-id"}]},
                    {"id": 11254, "values": [{
                        "value": r#"{"content":[{"blocks":[{"img":{"src":"https://old/rich.jpg"},"title":{"items":[{"type":"text","content":"Модель можно носить на голове"}]}}]}]}"#
                    }]}
                ]
            }),
            offer_id: "NEW-SKU-001".into(),
            title: "Title".into(),
            product_color: String::new(),
            product_color_dictionary_values: Vec::new(),
            color_name: String::new(),
            description: "Desc".into(),
            image_urls: vec!["https://new/rich.jpg".into()],
            video_links: vec![],
            rich_json: None,
        });

        assert_eq!(item["attributes"][0]["values"][0]["value"], "NEW-SKU-001");
        let rich_value = item["attributes"][1]["values"][0]["value"]
            .as_str()
            .unwrap();
        assert!(rich_value.contains("Модель можно носить на голове"));
        assert!(rich_value.contains("https://new/rich.jpg"));
        assert_ne!(rich_value, "NEW-SKU-001");
        assert_eq!(
            item["rich_content_json"]["content"][0]["blocks"][0]["img"]["src"],
            "https://new/rich.jpg"
        );
    }

    #[test]
    fn merge_card_model_name_uses_offer_suffix() {
        let item = build_import_item(ImportPreviewInput {
            template_product: json!({
                "offer_id": "TEMPLATE",
                "attributes": [
                    {"id": 8292, "name": "型号名称", "values": [{"value": "TEMPLATE"}]},
                    {"id": 9048, "name": "merge card", "values": [{"value": "TEMPLATE"}]}
                ]
            }),
            offer_id: "SFD202603072753_hGJ9yhthnL".into(),
            title: "Title".into(),
            product_color: String::new(),
            product_color_dictionary_values: Vec::new(),
            color_name: String::new(),
            description: "Desc".into(),
            image_urls: vec!["https://cdn/a.jpg".into()],
            video_links: vec![],
            rich_json: None,
        });
        assert_eq!(item["attributes"][0]["values"][0]["value"], "hGJ9yhthnL");
        assert_eq!(item["attributes"][1]["values"][0]["value"], "hGJ9yhthnL");
    }

    #[test]
    fn template_video_is_kept_in_attributes() {
        let item = build_import_item(ImportPreviewInput {
            template_product: json!({
                "complex_attributes": [
                    {"id": 21837, "values": [{"value": "template_video.mp4"}]},
                    {"id": 21841, "values": [{"value": "https://video/template.mp4"}]}
                ]
            }),
            offer_id: "SKU001".into(),
            title: "Title".into(),
            product_color: String::new(),
            product_color_dictionary_values: Vec::new(),
            color_name: String::new(),
            description: "Desc".into(),
            image_urls: vec!["https://cdn/a.jpg".into()],
            video_links: vec![],
            rich_json: None,
        });
        assert_eq!(item["attributes"][0]["id"], 21837);
        assert_eq!(item["attributes"][0]["complex_id"], 100001);
        assert_eq!(
            item["attributes"][0]["values"][0]["value"],
            "template_video.mp4"
        );
        assert_eq!(item["attributes"][1]["id"], 21841);
        assert_eq!(
            item["attributes"][1]["values"][0]["value"],
            "https://video/template.mp4"
        );
        assert!(item["complex_attributes"].as_array().unwrap().is_empty());
    }

    #[test]
    fn explicit_video_links_override_template_video() {
        let item = build_import_item(ImportPreviewInput {
            template_product: json!({
                "attributes": [
                    {"id": 21837, "values": [{"value": "template_video.mp4"}]},
                    {"id": 21841, "values": [{"value": "https://video/template.mp4"}]}
                ]
            }),
            offer_id: "SKU001".into(),
            title: "Title".into(),
            product_color: String::new(),
            product_color_dictionary_values: Vec::new(),
            color_name: String::new(),
            description: "Desc".into(),
            image_urls: vec!["https://cdn/a.jpg".into()],
            video_links: vec!["https://video/new.mp4".into()],
            rich_json: None,
        });
        assert_eq!(item["attributes"][0]["id"], 21837);
        assert_eq!(
            item["attributes"][0]["values"][0]["value"],
            "template_video.mp4"
        );
        assert_eq!(item["attributes"][1]["id"], 21841);
        assert_eq!(item["attributes"][1]["complex_id"], 100001);
        assert_eq!(
            item["attributes"][1]["values"][0]["value"],
            "https://video/new.mp4"
        );
    }

    #[test]
    fn normalizes_complex_attribute_ids_from_template() {
        let item = build_import_item(ImportPreviewInput {
            template_product: json!({
                "complex_attributes": [{
                    "attributes": [{
                        "attribute_id": 100,
                        "values": [{"value": "nested"}]
                    }]
                }]
            }),
            offer_id: "SKU001".into(),
            title: "Title".into(),
            product_color: String::new(),
            product_color_dictionary_values: Vec::new(),
            color_name: String::new(),
            description: "Desc".into(),
            image_urls: vec!["https://cdn/a.jpg".into()],
            video_links: vec![],
            rich_json: None,
        });
        assert_eq!(item["complex_attributes"][0]["attributes"][0]["id"], 100);
        assert!(item["complex_attributes"][0]["attributes"][0]
            .get("attribute_id")
            .is_none());
    }

    #[test]
    fn replaces_color_attributes_from_excel_columns() {
        let item = build_import_item(ImportPreviewInput {
            template_product: json!({
                "attributes": [
                    {"id": 10096, "values": [{"dictionary_value_id": 61573, "value": "бежевый"}]},
                    {"id": 10097, "values": [{"dictionary_value_id": 0, "value": "кремово-бежевый"}]}
                ]
            }),
            offer_id: "SKU001".into(),
            title: "Title".into(),
            product_color: "米色".into(),
            product_color_dictionary_values: vec![AttributeDictionaryValue {
                dictionary_value_id: 61585,
                value: "оранжевый".into(),
            }],
            color_name: "бежевый".into(),
            description: "Desc".into(),
            image_urls: vec!["https://cdn/a.jpg".into()],
            video_links: vec![],
            rich_json: None,
        });
        assert_eq!(item["attributes"][0]["values"][0]["value"], "оранжевый");
        assert_eq!(
            item["attributes"][0]["values"][0]["dictionary_value_id"],
            61585
        );
        assert_eq!(item["attributes"][1]["values"][0]["value"], "бежевый");
    }
}
