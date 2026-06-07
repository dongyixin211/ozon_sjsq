use anyhow::{Context, Result};
use base64::Engine;
use chrono::Utc;
use hmac::{Hmac, Mac};
use reqwest::Client;
use sha1::Sha1;
use std::path::Path;

type HmacSha1 = Hmac<Sha1>;

#[derive(Clone)]
pub struct AliyunOssClient {
    access_key_id: String,
    access_key_secret: String,
    bucket: String,
    endpoint: String,
    public_domain: String,
    http: Client,
}

impl AliyunOssClient {
    pub fn new(
        access_key_id: impl Into<String>,
        access_key_secret: impl Into<String>,
        bucket: impl Into<String>,
        endpoint: impl Into<String>,
        public_domain: impl Into<String>,
    ) -> Result<Self> {
        let access_key_id = access_key_id.into().trim().to_string();
        let access_key_secret = access_key_secret.into().trim().to_string();
        let bucket = bucket.into().trim().to_string();
        let endpoint = endpoint
            .into()
            .trim()
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .to_string();
        let public_domain = public_domain
            .into()
            .trim()
            .trim_end_matches('/')
            .to_string();
        if access_key_id.is_empty()
            || access_key_secret.is_empty()
            || bucket.is_empty()
            || endpoint.is_empty()
        {
            anyhow::bail!("OSS AccessKey、Bucket 和 Endpoint 不能为空");
        }
        Ok(Self {
            access_key_id,
            access_key_secret,
            bucket,
            endpoint,
            public_domain,
            http: Client::builder()
                .timeout(std::time::Duration::from_secs(180))
                .build()?,
        })
    }

    pub async fn upload_file(&self, path: &Path, object_key: &str) -> Result<String> {
        let bytes = tokio::fs::read(path)
            .await
            .with_context(|| format!("无法读取图片 {}", path.display()))?;
        let content_type = content_type(path);
        self.put_object(object_key, bytes, content_type).await
    }

    pub async fn put_object(
        &self,
        object_key: &str,
        bytes: Vec<u8>,
        content_type: &str,
    ) -> Result<String> {
        let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
        let canonical_resource = format!("/{}/{}", self.bucket, object_key);
        let string_to_sign = format!("PUT\n\n{content_type}\n{date}\n{canonical_resource}");
        let signature = sign(&self.access_key_secret, &string_to_sign)?;
        let host = format!("{}.{}", self.bucket, self.endpoint);
        let url = format!("https://{host}/{}", encode_object_key(object_key));

        let response = self
            .http
            .put(&url)
            .header("Date", date)
            .header("Content-Type", content_type)
            .header(
                "Authorization",
                format!("OSS {}:{}", self.access_key_id, signature),
            )
            .body(bytes)
            .send()
            .await
            .context("OSS 上传请求失败")?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            anyhow::bail!("OSS HTTP {}: {}", status.as_u16(), text);
        }
        Ok(format!(
            "{}/{}",
            self.public_domain,
            encode_object_key(object_key)
        ))
    }
}

fn sign(secret: &str, payload: &str) -> Result<String> {
    let mut mac = HmacSha1::new_from_slice(secret.as_bytes()).context("OSS Secret 无效")?;
    mac.update(payload.as_bytes());
    Ok(base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes()))
}

fn encode_object_key(object_key: &str) -> String {
    object_key
        .split('/')
        .map(|part| {
            part.bytes()
                .flat_map(|byte| match byte {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                        vec![byte as char]
                    }
                    _ => format!("%{byte:02X}").chars().collect(),
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_key_encoding_keeps_folders() {
        assert_eq!(
            encode_object_key("123/SKU 1/图.jpg"),
            "123/SKU%201/%E5%9B%BE.jpg"
        );
    }
}
