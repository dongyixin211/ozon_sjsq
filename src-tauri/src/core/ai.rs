use anyhow::{Context, Result};
use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::GenericImageView;
use reqwest::{multipart, Client, RequestBuilder};
use serde_json::{json, Value};
use std::path::Path;

#[derive(Clone)]
pub struct OpenAiCompatibleClient {
    base_url: String,
    api_key: String,
    http: Client,
}

#[derive(Debug, Clone)]
pub struct CopyPayload {
    pub title: String,
    pub description: String,
    pub bullets: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct TitlePayload {
    pub title: String,
    pub product_color: String,
    pub color_name: String,
}

impl OpenAiCompatibleClient {
    pub fn new(base_url: impl Into<String>, api_key: impl Into<String>) -> Result<Self> {
        let base_url = base_url.into().trim().trim_end_matches('/').to_string();
        let api_key = api_key.into().trim().to_string();
        if base_url.is_empty() {
            anyhow::bail!("AI 接口地址不能为空");
        }
        Ok(Self {
            base_url,
            api_key,
            http: Client::builder()
                .timeout(std::time::Duration::from_secs(180))
                .build()?,
        })
    }

    fn with_auth(&self, request: RequestBuilder) -> RequestBuilder {
        if self.api_key.is_empty() {
            request
        } else {
            request.bearer_auth(&self.api_key)
        }
    }

    pub async fn generate_title_from_images(
        &self,
        model: &str,
        prompt: &str,
        images: &[&Path],
    ) -> Result<String> {
        Ok(self
            .generate_title_bundle_from_images(model, prompt, images)
            .await?
            .title)
    }

    pub async fn generate_title_bundle_from_images(
        &self,
        model: &str,
        prompt: &str,
        images: &[&Path],
    ) -> Result<TitlePayload> {
        let text = self
            .chat_title_bundle_with_images(model, prompt, images)
            .await?;
        Ok(parse_title_payload(&text))
    }

    pub async fn generate_title_bundle_from_text(
        &self,
        model: &str,
        prompt: &str,
    ) -> Result<TitlePayload> {
        let text = self.chat_title_bundle(model, prompt).await?;
        Ok(parse_title_payload(&text))
    }

    pub async fn generate_copy(&self, model: &str, prompt: &str) -> Result<CopyPayload> {
        let text = self.chat(model, prompt).await?;
        Ok(parse_copy(&text))
    }

    pub async fn list_models(&self) -> Result<Vec<String>> {
        let models_url =
            if self.api_key.is_empty() && !self.base_url.trim_end_matches('/').ends_with("/v1") {
                format!("{}/api/tags", self.ollama_base_url())
            } else {
                format!("{}/models", self.base_url)
            };
        let response = self
            .with_auth(self.http.get(models_url))
            .send()
            .await
            .context("模型列表接口请求失败")?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            anyhow::bail!("模型列表接口 HTTP {}: {}", status.as_u16(), body);
        }
        let data: Value = serde_json::from_str(&body).context("模型列表接口返回不是合法 JSON")?;
        let mut models = Vec::new();
        if let Some(items) = data.get("data").and_then(Value::as_array) {
            for item in items {
                if let Some(id) = item
                    .get("id")
                    .or_else(|| item.get("name"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    models.push(id.to_string());
                }
            }
        } else if let Some(items) = data.get("models").and_then(Value::as_array) {
            for item in items {
                match item {
                    Value::String(value) if !value.trim().is_empty() => {
                        models.push(value.trim().to_string());
                    }
                    Value::Object(_) => {
                        if let Some(id) = item
                            .get("id")
                            .or_else(|| item.get("name"))
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                        {
                            models.push(id.to_string());
                        }
                    }
                    _ => {}
                }
            }
        }
        models.sort();
        models.dedup();
        if models.is_empty() {
            anyhow::bail!("模型列表为空或格式不支持");
        }
        Ok(models)
    }

    pub async fn edit_image_from_reference(
        &self,
        model: &str,
        prompt: &str,
        reference_image: &Path,
        output_path: &Path,
    ) -> Result<()> {
        self.edit_image(model, prompt, reference_image, output_path)
            .await
    }

    async fn edit_image(
        &self,
        model: &str,
        prompt: &str,
        reference_image: &Path,
        output_path: &Path,
    ) -> Result<()> {
        let reference_image = reference_image.to_path_buf();
        let (bytes, filename, mime) = tauri::async_runtime::spawn_blocking(move || {
            edit_reference_image_part(&reference_image)
        })
        .await
        .context("图片编辑参考图压缩任务异常退出")??;
        let part = multipart::Part::bytes(bytes)
            .file_name(filename)
            .mime_str(mime)?;
        let form = multipart::Form::new()
            .text("model", model.to_string())
            .text("prompt", prompt.to_string())
            .text("size", "1024x1536")
            .part("image", part);
        let response = self
            .with_auth(self.http.post(format!("{}/images/edits", self.base_url)))
            .multipart(form)
            .send()
            .await
            .context("图片编辑接口请求失败")?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            anyhow::bail!("图片编辑接口 HTTP {}: {}", status.as_u16(), body);
        }
        let data: Value = serde_json::from_str(&body).context("图片编辑接口返回不是合法 JSON")?;
        save_image_response(&self.http, &data, output_path).await
    }

    async fn chat(&self, model: &str, prompt: &str) -> Result<String> {
        let payload = self.chat_title_bundle(model, prompt).await?;
        Ok(parse_title_payload(&payload).title)
    }

    async fn chat_title_bundle(&self, model: &str, prompt: &str) -> Result<String> {
        if self.api_key.is_empty() {
            return self
                .ollama_chat(
                    model,
                    title_bundle_system_prompt(),
                    &title_bundle_user_prompt(prompt),
                    &[],
                    128,
                )
                .await;
        }
        let response = self
            .with_auth(
                self.http
                    .post(format!("{}/chat/completions", self.base_url)),
            )
            .json(&json!({
                "model": model,
                "messages": [
                    {"role": "system", "content": title_bundle_system_prompt()},
                    {"role": "user", "content": title_bundle_user_prompt(prompt)}
                ],
                "temperature": 0.4
            }))
            .send()
            .await
            .context("文案接口请求失败")?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            anyhow::bail!("文案接口 HTTP {}: {}", status.as_u16(), body);
        }
        let data: Value = serde_json::from_str(&body).context("文案接口返回不是合法 JSON")?;
        chat_message_content(&data, "文案接口")
    }

    async fn chat_title_bundle_with_images(
        &self,
        model: &str,
        prompt: &str,
        images: &[&Path],
    ) -> Result<String> {
        if images.is_empty() {
            return self.chat_title_bundle(model, prompt).await;
        }

        let title_prompt = title_bundle_user_prompt(prompt);
        if self.api_key.is_empty() {
            return self
                .ollama_chat(
                    model,
                    title_bundle_system_prompt(),
                    &title_prompt,
                    images,
                    96,
                )
                .await;
        }

        let mut content = vec![json!({
            "type": "text",
            "text": title_prompt
        })];
        for image in images {
            let image = image.to_path_buf();
            let data_url =
                tauri::async_runtime::spawn_blocking(move || title_image_data_url(&image))
                    .await
                    .context("标题参考图压缩任务异常退出")??;
            content.push(json!({
                "type": "image_url",
                "image_url": {
                    "url": data_url
                }
            }));
        }

        let response = self
            .with_auth(
                self.http
                    .post(format!("{}/chat/completions", self.base_url)),
            )
            .json(&json!({
                "model": model,
                "messages": [
                    {"role": "system", "content": title_bundle_system_prompt()},
                    {"role": "user", "content": content}
                ],
                "temperature": 0.4
            }))
            .send()
            .await
            .context("文案图片接口请求失败")?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            anyhow::bail!("文案图片接口 HTTP {}: {}", status.as_u16(), body);
        }
        let data: Value = serde_json::from_str(&body).context("文案图片接口返回不是合法 JSON")?;
        chat_message_content(&data, "文案图片接口")
    }

    async fn ollama_chat(
        &self,
        model: &str,
        system_prompt: &str,
        prompt: &str,
        images: &[&Path],
        num_predict: i64,
    ) -> Result<String> {
        let mut user_message = json!({
            "role": "user",
            "content": format!("/no_think\n{prompt}")
        });
        if !images.is_empty() {
            let mut encoded_images = Vec::new();
            for image in images {
                let image = image.to_path_buf();
                let b64 = tauri::async_runtime::spawn_blocking(move || title_image_base64(&image))
                    .await
                    .context("标题参考图压缩任务异常退出")??;
                encoded_images.push(Value::String(b64));
            }
            user_message["images"] = Value::Array(encoded_images);
        }

        let response = self
            .http
            .post(format!("{}/api/chat", self.ollama_base_url()))
            .json(&json!({
                "model": model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    user_message
                ],
                "stream": false,
                "think": false,
                "options": {
                    "temperature": 0.4,
                    "num_predict": num_predict
                }
            }))
            .send()
            .await
            .context("Ollama 文案接口请求失败")?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            anyhow::bail!("Ollama 文案接口 HTTP {}: {}", status.as_u16(), body);
        }
        let data: Value =
            serde_json::from_str(&body).context("Ollama 文案接口返回不是合法 JSON")?;
        let content = data
            .pointer("/message/content")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if content.is_empty() {
            anyhow::bail!("Ollama 文案接口返回空 content");
        }
        Ok(content.to_string())
    }

    fn ollama_base_url(&self) -> String {
        self.base_url
            .trim_end_matches('/')
            .strip_suffix("/v1")
            .unwrap_or(self.base_url.as_str())
            .to_string()
    }
}

pub fn is_ollama_provider(provider: &str) -> bool {
    provider.trim().eq_ignore_ascii_case("ollama")
}

pub fn is_pixel_provider(provider: &str) -> bool {
    provider.trim().eq_ignore_ascii_case("pixel")
}

pub fn is_missing_chat_content_error(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.to_string().contains("未返回 message.content"))
}

pub fn is_retryable_image_error(error: &anyhow::Error) -> bool {
    let message = error_chain(error).to_lowercase();
    message.contains("请求失败")
        || message.contains("connection")
        || message.contains("timeout")
        || message.contains("sendrequest")
        || message.contains("http 408")
        || message.contains("http 409")
        || message.contains("http 429")
        || message.contains("http 500")
        || message.contains("http 502")
        || message.contains("http 503")
        || message.contains("http 504")
}

fn error_chain(error: &anyhow::Error) -> String {
    error
        .chain()
        .map(|cause| cause.to_string())
        .collect::<Vec<_>>()
        .join(": ")
}

fn chat_message_content(data: &Value, endpoint: &str) -> Result<String> {
    if let Some(content) = data
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
    {
        return Ok(content.to_string());
    }
    anyhow::bail!(
        "{endpoint}未返回 message.content；响应摘要：{}",
        sanitized_response_summary(data)
    )
}

fn sanitized_response_summary(data: &Value) -> String {
    let mut sanitized = data.clone();
    sanitize_response_value(&mut sanitized);
    let summary = serde_json::to_string(&sanitized).unwrap_or_else(|_| "<无法序列化>".to_string());
    truncate_chars(&summary, 1200)
}

fn sanitize_response_value(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                let normalized = key.to_ascii_lowercase();
                if ["authorization", "api_key", "apikey", "token", "secret"]
                    .iter()
                    .any(|sensitive| normalized.contains(sensitive))
                {
                    *value = Value::String("<已隐藏>".to_string());
                } else {
                    sanitize_response_value(value);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                sanitize_response_value(item);
            }
        }
        Value::String(text) if text.starts_with("data:image/") => {
            *text = "<图片数据已隐藏>".to_string();
        }
        Value::String(text) if text.chars().count() > 300 => {
            *text = truncate_chars(text, 300);
        }
        _ => {}
    }
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut truncated = value.chars().take(max_chars).collect::<String>();
    truncated.push_str("…<已截断>");
    truncated
}

async fn save_image_response(http: &Client, data: &Value, output_path: &Path) -> Result<()> {
    if let Some(url) = data.pointer("/data/0/url").and_then(Value::as_str) {
        download_file(http, url, output_path).await?;
        return Ok(());
    }
    if let Some(b64) = data.pointer("/data/0/b64_json").and_then(Value::as_str) {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .context("图片 base64 解码失败")?;
        write_bytes(output_path, &bytes)?;
        return Ok(());
    }
    anyhow::bail!("图片接口未返回 url 或 b64_json")
}

fn edit_reference_image_part(path: &Path) -> Result<(Vec<u8>, String, &'static str)> {
    let image = image::open(path).with_context(|| format!("无法读取参考图 {}", path.display()))?;
    let (width, height) = image.dimensions();
    let max_side = width.max(height).max(1);
    let image = if max_side > 1536 {
        let ratio = 1536.0 / max_side as f32;
        let next_width = (width as f32 * ratio).round().max(1.0) as u32;
        let next_height = (height as f32 * ratio).round().max(1.0) as u32;
        image.resize(next_width, next_height, FilterType::Triangle)
    } else {
        image
    };
    let rgb = image.to_rgb8();
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, 88)
        .encode_image(&rgb)
        .with_context(|| format!("无法压缩图片编辑参考图 {}", path.display()))?;
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("reference");
    Ok((bytes, format!("{stem}_reference.jpg"), "image/jpeg"))
}

fn title_image_base64(path: &Path) -> Result<String> {
    let image =
        image::open(path).with_context(|| format!("无法读取标题参考图 {}", path.display()))?;
    let (width, height) = image.dimensions();
    let max_side = width.max(height).max(1);
    let image = if max_side > 1280 {
        let ratio = 1280.0 / max_side as f32;
        let next_width = (width as f32 * ratio).round().max(1.0) as u32;
        let next_height = (height as f32 * ratio).round().max(1.0) as u32;
        image.resize(next_width, next_height, FilterType::Triangle)
    } else {
        image
    };
    let rgb = image.to_rgb8();
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, 85)
        .encode_image(&rgb)
        .with_context(|| format!("无法压缩标题参考图 {}", path.display()))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn title_image_data_url(path: &Path) -> Result<String> {
    Ok(format!(
        "data:image/jpeg;base64,{}",
        title_image_base64(path)?
    ))
}

fn parse_copy(text: &str) -> CopyPayload {
    let cleaned = sanitize_json_text(text);
    if let Ok(data) = serde_json::from_str::<Value>(&cleaned) {
        let title = data
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let description = data
            .get("description")
            .or_else(|| data.get("简介"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let bullets = data
            .get("bullets")
            .or_else(|| data.get("卖点"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        return CopyPayload {
            title,
            description,
            bullets,
        };
    }
    CopyPayload {
        title: String::new(),
        description: cleaned.trim().to_string(),
        bullets: Vec::new(),
    }
}

fn parse_title_payload(text: &str) -> TitlePayload {
    let cleaned = sanitize_json_text(text);
    if let Ok(data) = serde_json::from_str::<Value>(&cleaned) {
        let title = scalar_text(&data, &["title", "标题"]);
        let product_color = scalar_text(
            &data,
            &["product_color", "productColor", "商品颜色", "颜色"],
        );
        let color_name = scalar_text(
            &data,
            &[
                "color_name",
                "colorName",
                "color_name_ru",
                "俄语颜色",
                "颜色名称",
            ],
        );
        if !title.is_empty() || !product_color.is_empty() || !color_name.is_empty() {
            return TitlePayload {
                title,
                product_color,
                color_name,
            };
        }
    }
    TitlePayload {
        title: cleaned.trim().to_string(),
        product_color: String::new(),
        color_name: String::new(),
    }
}

fn scalar_text(data: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| data.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_default()
        .to_string()
}

fn title_bundle_system_prompt() -> &'static str {
    "你是 Ozon 电商商品识别助手。请根据图片和提示词识别商品信息，并严格输出 JSON，不要输出 JSON 以外的任何内容。"
}

fn title_bundle_user_prompt(prompt: &str) -> String {
    format!(
        "{prompt}\n\n请根据随附商品图片返回 JSON：{{\"title\":\"\",\"product_color\":\"\",\"color_name\":\"\"}}。\n要求：1. title 必须严格遵循上方提示词指定的语言、结构和格式，不要擅自更改语言。2. product_color 必须只用中文回答，表示适合 Ozon 商品颜色字段的中文颜色描述，尽量简短，如 米色、乳白色、中等粉红色、中灰色混色、云杉林，不能写俄语、不能中俄混写。3. color_name 必须只用俄罗斯语回答，只写俄语颜色名称，尽量使用西里尔字母，不带中文、不带英文、不带解释。4. 如果颜色不确定，选择图片主色。5. 只返回单个 JSON 对象。"
    )
}

fn sanitize_json_text(text: &str) -> String {
    let mut value = text.trim().to_string();
    if value.starts_with("```") {
        value = value
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .to_string();
        value = value.trim_end_matches("```").trim().to_string();
    }
    value
}

async fn download_file(http: &Client, url: &str, output_path: &Path) -> Result<()> {
    let response = http.get(url).send().await.context("下载图片失败")?;
    if !response.status().is_success() {
        anyhow::bail!("下载图片 HTTP {}", response.status().as_u16());
    }
    let bytes = response.bytes().await?;
    write_bytes(output_path, &bytes)
}

fn write_bytes(output_path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(output_path, bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_copy_json() {
        let payload = parse_copy(r#"{"title":"T","description":"D","bullets":["A","B"]}"#);
        assert_eq!(payload.title, "T");
        assert_eq!(payload.bullets.len(), 2);
    }

    #[test]
    fn parses_title_payload_json() {
        let payload = parse_title_payload(
            r#"{"title":"法式发箍","product_color":"米色","color_name":"бежевый"}"#,
        );
        assert_eq!(payload.title, "法式发箍");
        assert_eq!(payload.product_color, "米色");
        assert_eq!(payload.color_name, "бежевый");
    }

    #[test]
    fn allows_empty_api_key_for_local_provider() {
        assert!(OpenAiCompatibleClient::new("http://localhost:11434/v1", "").is_ok());
    }

    #[test]
    fn detects_ollama_provider_case_insensitively() {
        assert!(is_ollama_provider(" Ollama "));
        assert!(!is_ollama_provider("xiaoqian"));
    }

    #[test]
    fn detects_missing_chat_content_error() {
        let error = chat_message_content(
            &json!({"choices": [{"message": {"role": "assistant"}}]}),
            "文案图片接口",
        )
        .unwrap_err();
        assert!(is_missing_chat_content_error(&error));
    }

    #[test]
    fn missing_chat_content_reports_sanitized_response() {
        let data = json!({
            "error": {
                "message": "temporary overload",
                "api_key": "secret-value",
                "detail": "x".repeat(400)
            }
        });
        let error = chat_message_content(&data, "文案图片接口")
            .unwrap_err()
            .to_string();
        assert!(error.contains("temporary overload"));
        assert!(error.contains("<已隐藏>"));
        assert!(error.contains("<已截断>"));
        assert!(!error.contains("secret-value"));
    }

    #[test]
    fn title_prompt_preserves_requested_language() {
        let prompt = title_bundle_user_prompt("标题只能是俄罗斯语言。");
        assert!(prompt.contains("严格遵循上方提示词指定的语言"));
        assert!(!prompt.contains("中文商品标题"));
    }

    #[test]
    fn strips_v1_suffix_for_ollama_native_api() {
        let client = OpenAiCompatibleClient::new("http://localhost:11434/v1", "").unwrap();
        assert_eq!(client.ollama_base_url(), "http://localhost:11434");
    }
}
