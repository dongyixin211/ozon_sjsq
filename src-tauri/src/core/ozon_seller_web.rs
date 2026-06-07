use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use reqwest::Client;
use serde_json::{json, Value};
use std::path::Path;
use tokio::time::{sleep, Duration};

const SELLER_BASE: &str = "https://seller.ozon.ru";

#[derive(Debug, Clone)]
pub struct SellerWebConfig {
    pub company_id: String,
    pub cookie: String,
    pub user_agent: String,
    pub accept_language: String,
    pub referer: String,
    pub x_o3_app_name: String,
    pub x_o3_language: String,
    pub x_o3_page_type: String,
}

pub struct OzonSellerWebClient {
    http: Client,
    config: SellerWebConfig,
}

impl OzonSellerWebClient {
    pub fn new(config: SellerWebConfig) -> Result<Self> {
        if config.company_id.trim().is_empty() {
            anyhow::bail!("Ozon 后台 company_id 不能为空");
        }
        if config.cookie.trim().is_empty() {
            anyhow::bail!(
                "Ozon 后台 Cookie 不能为空。HAR 中没有 Cookie 时，请选择包含 Cookie 的文本文件"
            );
        }
        Ok(Self {
            http: Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()?,
            config,
        })
    }

    pub async fn download_barcode_pdf(&self, posting_numbers: &[String]) -> Result<Vec<u8>> {
        let code = self
            .report_code(
                "/api/ord-report-service/report/print-barcodes",
                json!({
                    "filter": self.report_filter(posting_numbers, None)
                }),
            )
            .await?;
        self.wait_report(&code).await?;
        self.download_report(&code).await
    }

    pub async fn download_picking_list_pdf(&self, posting_numbers: &[String]) -> Result<Vec<u8>> {
        let code = self
            .report_code(
                "/api/report/v2/report/assembly/list",
                json!({
                    "filter": self.report_filter(posting_numbers, Some("postings"))
                }),
            )
            .await?;
        self.wait_report(&code).await?;
        self.download_report(&code).await
    }

    pub async fn download_label_pdf(&self, posting_number: &str) -> Result<Vec<u8>> {
        let data = self
            .post_json(
                "/api/carriage-service/label/download",
                json!({
                    "company_id": self.config.company_id,
                    "posting_number": posting_number
                }),
            )
            .await?;
        decode_pdf_result(&data).context("Ozon 后台标签返回中没有 PDF")
    }

    async fn report_code(&self, endpoint: &str, payload: Value) -> Result<String> {
        let data = self.post_json(endpoint, payload).await?;
        data.get("code")
            .and_then(Value::as_str)
            .map(str::to_string)
            .context("Ozon 后台没有返回 report code")
    }

    async fn wait_report(&self, code: &str) -> Result<()> {
        for _ in 0..20 {
            let data = self
                .post_json("/api/report/status", json!({ "code": code }))
                .await?;
            let status = data.get("status").and_then(Value::as_str).unwrap_or("");
            if status == "success" {
                return Ok(());
            }
            let error_code = data.get("error_code").and_then(Value::as_i64).unwrap_or(0);
            if error_code != 0 || status == "error" || status == "failed" {
                anyhow::bail!("Ozon 后台报表生成失败：{}", data);
            }
            sleep(Duration::from_millis(500)).await;
        }
        anyhow::bail!("Ozon 后台报表生成超时：{code}")
    }

    async fn download_report(&self, code: &str) -> Result<Vec<u8>> {
        let data = self
            .post_json(
                "/api/report/download",
                json!({
                    "company_id": self.config.company_id,
                    "code": code
                }),
            )
            .await?;
        decode_pdf_result(&data).context("Ozon 后台报表返回中没有 PDF")
    }

    async fn post_json(&self, endpoint: &str, payload: Value) -> Result<Value> {
        let response = self
            .http
            .post(format!("{SELLER_BASE}{endpoint}"))
            .header("accept", "application/json, text/plain, */*")
            .header("accept-language", &self.config.accept_language)
            .header("content-type", "application/json")
            .header("origin", SELLER_BASE)
            .header("referer", &self.config.referer)
            .header("user-agent", &self.config.user_agent)
            .header("cookie", &self.config.cookie)
            .header("x-o3-app-name", &self.config.x_o3_app_name)
            .header("x-o3-company-id", &self.config.company_id)
            .header("x-o3-language", &self.config.x_o3_language)
            .header("x-o3-page-type", &self.config.x_o3_page_type)
            .json(&payload)
            .send()
            .await
            .context("Ozon 后台连接失败")?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            anyhow::bail!("Ozon 后台 HTTP {}: {}", status.as_u16(), text);
        }
        serde_json::from_str(&text).context("Ozon 后台返回不是合法 JSON")
    }

    fn report_filter(&self, posting_numbers: &[String], list_type: Option<&str>) -> Value {
        let mut filter = serde_json::Map::new();
        if let Some(list_type) = list_type {
            filter.insert("list_type".into(), json!(list_type));
        }
        filter.insert("company_id".into(), json!(self.config.company_id));
        filter.insert("status_aliases".into(), json!(["awaiting_deliver"]));
        filter.insert(
            "cutoff_from".into(),
            json!((chrono::Utc::now() - chrono::Duration::days(91)).to_rfc3339()),
        );
        filter.insert(
            "cutoff_to".into(),
            json!((chrono::Utc::now() + chrono::Duration::days(91)).to_rfc3339()),
        );
        filter.insert("posting_numbers".into(), json!(posting_numbers));
        filter.insert("delivery_groups".into(), json!(["all"]));
        Value::Object(filter)
    }
}

pub fn config_from_paths(
    company_id: String,
    har_path: Option<&Path>,
    cookie_path: Option<&Path>,
) -> Result<SellerWebConfig> {
    let mut config = har_path
        .filter(|path| path.is_file())
        .map(load_config_from_har)
        .transpose()?
        .unwrap_or_else(|| SellerWebConfig {
            company_id: String::new(),
            cookie: String::new(),
            user_agent: default_user_agent().into(),
            accept_language: "zh-Hans".into(),
            referer: "https://seller.ozon.ru/app/postings/crossborder/fbs".into(),
            x_o3_app_name: "seller-ui".into(),
            x_o3_language: "zh-Hans".into(),
            x_o3_page_type: "CbPostingsFbs".into(),
        });
    if !company_id.trim().is_empty() {
        config.company_id = company_id;
    }
    if config.cookie.trim().is_empty() {
        if let Some(path) = cookie_path.filter(|path| path.is_file()) {
            config.cookie = std::fs::read_to_string(path)
                .with_context(|| format!("读取 Ozon 后台 Cookie 文件失败：{}", path.display()))?
                .trim()
                .to_string();
        }
    }
    Ok(config)
}

fn load_config_from_har(path: &Path) -> Result<SellerWebConfig> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("读取 Ozon HAR 失败：{}", path.display()))?;
    let value: Value = serde_json::from_str(&text).context("Ozon HAR 不是合法 JSON")?;
    let entries = value
        .pointer("/log/entries")
        .and_then(Value::as_array)
        .context("Ozon HAR 中没有 log.entries")?;
    let entry = entries
        .iter()
        .find(|entry| {
            entry
                .pointer("/request/url")
                .and_then(Value::as_str)
                .is_some_and(|url| url.contains("seller.ozon.ru/api/"))
        })
        .context("Ozon HAR 中没有 seller.ozon.ru/api 请求")?;
    let headers = entry
        .pointer("/request/headers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(SellerWebConfig {
        company_id: header(&headers, "x-o3-company-id").unwrap_or_default(),
        cookie: header(&headers, "cookie").unwrap_or_default(),
        user_agent: header(&headers, "user-agent").unwrap_or_else(|| default_user_agent().into()),
        accept_language: header(&headers, "accept-language").unwrap_or_else(|| "zh-Hans".into()),
        referer: header(&headers, "referer")
            .unwrap_or_else(|| "https://seller.ozon.ru/app/postings/crossborder/fbs".into()),
        x_o3_app_name: header(&headers, "x-o3-app-name").unwrap_or_else(|| "seller-ui".into()),
        x_o3_language: header(&headers, "x-o3-language").unwrap_or_else(|| "zh-Hans".into()),
        x_o3_page_type: header(&headers, "x-o3-page-type")
            .unwrap_or_else(|| "CbPostingsFbs".into()),
    })
}

fn decode_pdf_result(data: &Value) -> Option<Vec<u8>> {
    let content_type = data
        .pointer("/result/content_type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let content = data
        .pointer("/result/file_content")
        .and_then(Value::as_str)?;
    if !(content_type.contains("pdf") || content.starts_with("JVBER")) {
        return None;
    }
    BASE64_STANDARD.decode(content).ok()
}

fn header(headers: &[Value], name: &str) -> Option<String> {
    headers.iter().find_map(|header| {
        let current = header.get("name").and_then(Value::as_str)?;
        current.eq_ignore_ascii_case(name).then(|| {
            header
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        })
    })
}

fn default_user_agent() -> &'static str {
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn decodes_pdf_result() {
        let encoded = BASE64_STANDARD.encode(b"%PDF-from-ozon");
        let decoded = decode_pdf_result(&json!({
            "result": {
                "content_type": "application/pdf",
                "file_content": encoded
            }
        }))
        .unwrap();
        assert_eq!(decoded, b"%PDF-from-ozon");
    }

    #[test]
    fn extracts_headers_case_insensitively() {
        let headers = vec![json!({"name": "X-O3-Company-Id", "value": "4481877"})];
        assert_eq!(
            header(&headers, "x-o3-company-id").as_deref(),
            Some("4481877")
        );
    }
}
