use anyhow::{Context, Result};
use base64::Engine;
use reqwest::{multipart, Client};
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

impl OpenAiCompatibleClient {
    pub fn new(base_url: impl Into<String>, api_key: impl Into<String>) -> Result<Self> {
        let base_url = base_url.into().trim().trim_end_matches('/').to_string();
        let api_key = api_key.into().trim().to_string();
        if base_url.is_empty() || api_key.is_empty() {
            anyhow::bail!("AI 接口地址和 API Key 不能为空");
        }
        Ok(Self {
            base_url,
            api_key,
            http: Client::builder()
                .timeout(std::time::Duration::from_secs(180))
                .build()?,
        })
    }

    pub async fn generate_title(&self, model: &str, prompt: &str) -> Result<String> {
        let text = self.chat(model, prompt).await?;
        Ok(parse_title(&text))
    }

    pub async fn generate_copy(&self, model: &str, prompt: &str) -> Result<CopyPayload> {
        let text = self.chat(model, prompt).await?;
        Ok(parse_copy(&text))
    }

    pub async fn generate_image_from_reference(
        &self,
        model: &str,
        prompt: &str,
        reference_image: Option<&Path>,
        output_path: &Path,
    ) -> Result<()> {
        if let Some(reference_image) = reference_image {
            match self
                .edit_image(model, prompt, reference_image, output_path)
                .await
            {
                Ok(()) => return Ok(()),
                Err(edit_error) => {
                    eprintln!("图片编辑失败，回退文生图: {edit_error}");
                }
            }
        }
        self.generate_image_without_reference(model, prompt, output_path)
            .await
    }

    async fn generate_image_without_reference(
        &self,
        model: &str,
        prompt: &str,
        output_path: &Path,
    ) -> Result<()> {
        let response = self
            .http
            .post(format!("{}/images/generations", self.base_url))
            .bearer_auth(&self.api_key)
            .json(&json!({
                "model": model,
                "prompt": prompt,
                "size": "1024x1536"
            }))
            .send()
            .await
            .context("图片接口请求失败")?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            anyhow::bail!("图片接口 HTTP {}: {}", status.as_u16(), body);
        }
        let data: Value = serde_json::from_str(&body).context("图片接口返回不是合法 JSON")?;
        if let Some(url) = data.pointer("/data/0/url").and_then(Value::as_str) {
            download_file(&self.http, url, output_path).await?;
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

    async fn edit_image(
        &self,
        model: &str,
        prompt: &str,
        reference_image: &Path,
        output_path: &Path,
    ) -> Result<()> {
        let bytes = tokio::fs::read(reference_image)
            .await
            .with_context(|| format!("无法读取参考图 {}", reference_image.display()))?;
        let filename = reference_image
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("reference.png")
            .to_string();
        let part = multipart::Part::bytes(bytes)
            .file_name(filename)
            .mime_str(image_mime(reference_image))?;
        let form = multipart::Form::new()
            .text("model", model.to_string())
            .text("prompt", prompt.to_string())
            .text("size", "1024x1536")
            .part("image", part);
        let response = self
            .http
            .post(format!("{}/images/edits", self.base_url))
            .bearer_auth(&self.api_key)
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
        let response = self
            .http
            .post(format!("{}/chat/completions", self.base_url))
            .bearer_auth(&self.api_key)
            .json(&json!({
                "model": model,
                "messages": [
                    {"role": "system", "content": "你是 Ozon 电商商品内容助手。"},
                    {"role": "user", "content": prompt}
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
        data.pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| anyhow::anyhow!("文案接口未返回 message.content"))
    }
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

fn image_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        _ => "application/octet-stream",
    }
}

fn parse_title(text: &str) -> String {
    let cleaned = sanitize_json_text(text);
    if let Ok(data) = serde_json::from_str::<Value>(&cleaned) {
        if let Some(title) = data.get("title").and_then(Value::as_str) {
            return title.trim().to_string();
        }
    }
    cleaned.trim().to_string()
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
}
