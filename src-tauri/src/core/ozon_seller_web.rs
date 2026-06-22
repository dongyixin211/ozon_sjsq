use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use futures_util::{SinkExt, StreamExt};
use reqwest::Client;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration as StdDuration;
use tokio::net::TcpStream;
use tokio::time::{sleep, Duration};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

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
    browser: Option<ChromeFetchSession>,
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
            browser: None,
        })
    }

    pub async fn download_barcode_pdf(&mut self, posting_numbers: &[String]) -> Result<Vec<u8>> {
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

    pub async fn download_picking_list_pdf(
        &mut self,
        posting_numbers: &[String],
    ) -> Result<Vec<u8>> {
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

    pub async fn download_label_pdf(&mut self, posting_number: &str) -> Result<Vec<u8>> {
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

    async fn report_code(&mut self, endpoint: &str, payload: Value) -> Result<String> {
        let data = self.post_json(endpoint, payload).await?;
        data.get("code")
            .and_then(Value::as_str)
            .map(str::to_string)
            .context("Ozon 后台没有返回 report code")
    }

    async fn wait_report(&mut self, code: &str) -> Result<()> {
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

    async fn download_report(&mut self, code: &str) -> Result<Vec<u8>> {
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

    async fn post_json(&mut self, endpoint: &str, payload: Value) -> Result<Value> {
        if self.browser.is_some() {
            return self.post_json_browser(endpoint, payload).await;
        }

        match self.post_json_http(endpoint, payload.clone()).await {
            Ok(data) => Ok(data),
            Err(error) => {
                let http_error = format!("{error:#}");
                self.post_json_browser(endpoint, payload)
                    .await
                    .with_context(|| {
                        format!("Ozon 后台浏览器兜底请求失败；原始 HTTP 错误：{http_error}")
                    })
            }
        }
    }

    async fn post_json_http(&self, endpoint: &str, payload: Value) -> Result<Value> {
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

    async fn post_json_browser(&mut self, endpoint: &str, payload: Value) -> Result<Value> {
        if self.browser.is_none() {
            self.browser = Some(
                ChromeFetchSession::new(&self.config)
                    .await
                    .context("启动临时 Chrome 失败")?,
            );
        }

        let first = self
            .browser
            .as_mut()
            .expect("browser session initialized")
            .post_json(endpoint, payload.clone())
            .await;
        match first {
            Ok(data) => Ok(data),
            Err(first_error) => {
                self.browser = None;
                self.browser = Some(
                    ChromeFetchSession::new(&self.config)
                        .await
                        .context("重启临时 Chrome 失败")?,
                );
                self.browser
                    .as_mut()
                    .expect("browser session reinitialized")
                    .post_json(endpoint, payload)
                    .await
                    .with_context(|| format!("临时 Chrome 请求失败：{first_error:#}"))
            }
        }
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

type DevToolsSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct ChromeFetchSession {
    _chrome: ChromeProcess,
    cdp: CdpClient,
    config: SellerWebConfig,
}

impl ChromeFetchSession {
    async fn new(config: &SellerWebConfig) -> Result<Self> {
        let chrome = ChromeProcess::launch()?;
        let target_url = devtools_new_target_url(&chrome.browser_ws_url)?;
        let target: Value = Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()?
            .put(&target_url)
            .send()
            .await
            .context("创建 Chrome DevTools 标签页失败")?
            .json()
            .await
            .context("Chrome DevTools 标签页返回不是合法 JSON")?;
        let page_ws_url = target
            .get("webSocketDebuggerUrl")
            .and_then(Value::as_str)
            .context("Chrome DevTools 没有返回标签页 websocket")?;

        let mut cdp = CdpClient::connect(page_ws_url).await?;
        cdp.send("Page.enable", json!({})).await?;
        cdp.send("Runtime.enable", json!({})).await?;
        cdp.send("Network.enable", json!({})).await?;

        let cookies = cookie_params(&config.cookie);
        if !cookies.is_empty() {
            cdp.send("Network.setCookies", json!({ "cookies": cookies }))
                .await
                .context("写入临时 Chrome Cookie 失败")?;
        }
        cdp.send("Page.navigate", json!({ "url": SELLER_BASE }))
            .await
            .context("打开 Ozon 后台页面失败")?;
        sleep(Duration::from_secs(5)).await;

        Ok(Self {
            _chrome: chrome,
            cdp,
            config: config.clone(),
        })
    }

    async fn post_json(&mut self, endpoint: &str, payload: Value) -> Result<Value> {
        let headers = json!({
            "accept": "application/json, text/plain, */*",
            "content-type": "application/json",
            "x-o3-app-name": self.config.x_o3_app_name,
            "x-o3-company-id": self.config.company_id,
            "x-o3-language": self.config.x_o3_language,
            "x-o3-page-type": self.config.x_o3_page_type,
        });
        let endpoint_json = serde_json::to_string(endpoint)?;
        let payload_json = serde_json::to_string(&payload)?;
        let headers_json = serde_json::to_string(&headers)?;
        let expression = format!(
            r#"(async () => {{
                const res = await fetch({endpoint_json}, {{
                    method: "POST",
                    credentials: "same-origin",
                    headers: {headers_json},
                    body: JSON.stringify({payload_json})
                }});
                const text = await res.text();
                return {{ status: res.status, url: res.url, text }};
            }})()"#
        );
        let data = self
            .cdp
            .send(
                "Runtime.evaluate",
                json!({
                    "expression": expression,
                    "awaitPromise": true,
                    "returnByValue": true
                }),
            )
            .await
            .context("Chrome 执行 Ozon 请求失败")?;
        if let Some(exception) = data.get("exceptionDetails") {
            anyhow::bail!(
                "Chrome 执行 Ozon 请求异常：{}",
                text_excerpt(&exception.to_string())
            );
        }
        let value = data
            .pointer("/result/value")
            .context("Chrome 请求没有返回结果")?;
        let status = value.get("status").and_then(Value::as_i64).unwrap_or(0);
        let text = value.get("text").and_then(Value::as_str).unwrap_or("");
        if !(200..300).contains(&status) {
            anyhow::bail!("Ozon 后台浏览器 HTTP {status}: {}", text_excerpt(text));
        }
        serde_json::from_str(text).context("Ozon 后台浏览器返回不是合法 JSON")
    }
}

struct ChromeProcess {
    child: Child,
    profile_dir: PathBuf,
    browser_ws_url: String,
}

impl ChromeProcess {
    fn launch() -> Result<Self> {
        let chrome_path = find_chrome_binary()
            .context("找不到 Chrome。请安装 Google Chrome，或用 OZON_CHROME_PATH 指定浏览器路径")?;
        let profile_dir =
            std::env::temp_dir().join(format!("ozon-sjsq-chrome-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&profile_dir)
            .with_context(|| format!("创建临时 Chrome 配置目录失败：{}", profile_dir.display()))?;
        let mut child = Command::new(&chrome_path)
            .args([
                "--headless=new",
                "--disable-gpu",
                "--remote-debugging-port=0",
                "--no-first-run",
                "--no-default-browser-check",
                "about:blank",
            ])
            .arg(format!("--user-data-dir={}", profile_dir.display()))
            .stderr(Stdio::piped())
            .stdout(Stdio::null())
            .stdin(Stdio::null())
            .spawn()
            .with_context(|| format!("启动 Chrome 失败：{}", chrome_path.display()))?;

        let stderr = child.stderr.take().context("无法读取 Chrome 启动输出")?;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(std::result::Result::ok) {
                if let Some(url) = extract_devtools_ws_url(&line) {
                    let _ = tx.send(url);
                    break;
                }
            }
        });
        let browser_ws_url = rx
            .recv_timeout(StdDuration::from_secs(15))
            .context("等待 Chrome DevTools 地址超时")?;

        Ok(Self {
            child,
            profile_dir,
            browser_ws_url,
        })
    }
}

impl Drop for ChromeProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.profile_dir);
    }
}

struct CdpClient {
    socket: DevToolsSocket,
    next_id: i64,
}

impl CdpClient {
    async fn connect(ws_url: &str) -> Result<Self> {
        let (socket, _) = connect_async(ws_url)
            .await
            .context("连接 Chrome DevTools websocket 失败")?;
        Ok(Self { socket, next_id: 0 })
    }

    async fn send(&mut self, method: &str, params: Value) -> Result<Value> {
        self.next_id += 1;
        let id = self.next_id;
        let request = json!({
            "id": id,
            "method": method,
            "params": params,
        });
        self.socket
            .send(Message::Text(request.to_string().into()))
            .await
            .with_context(|| format!("发送 Chrome DevTools 命令失败：{method}"))?;
        while let Some(message) = self.socket.next().await {
            let message =
                message.with_context(|| format!("读取 Chrome DevTools 响应失败：{method}"))?;
            if !message.is_text() {
                continue;
            }
            let data: Value = serde_json::from_str(message.to_text()?)
                .context("Chrome DevTools 响应不是合法 JSON")?;
            if data.get("id").and_then(Value::as_i64) != Some(id) {
                continue;
            }
            if let Some(error) = data.get("error") {
                anyhow::bail!("Chrome DevTools 命令失败 {method}: {error}");
            }
            return Ok(data.get("result").cloned().unwrap_or(Value::Null));
        }
        anyhow::bail!("Chrome DevTools 连接已关闭：{method}")
    }
}

pub fn config_from_paths(
    company_id: String,
    har_path: Option<&Path>,
    cookie_input: Option<&str>,
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
        if let Some(input) = cookie_input
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let path = Path::new(input);
            let raw = if path.is_file() {
                std::fs::read_to_string(path).with_context(|| {
                    format!("读取 Ozon 后台 Cookie 文件失败：{}", path.display())
                })?
            } else {
                input.to_string()
            };
            if let Some(cookie) = parse_cookie_input(&raw) {
                config.cookie = cookie;
            } else {
                config.cookie = raw.trim().to_string();
            }
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
    let cookie = header(&headers, "cookie")
        .or_else(|| cookies_from_har_entry(entry))
        .unwrap_or_default();
    Ok(SellerWebConfig {
        company_id: header(&headers, "x-o3-company-id").unwrap_or_default(),
        cookie,
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

fn cookies_from_har_entry(entry: &Value) -> Option<String> {
    let cookies = entry
        .pointer("/request/cookies")
        .and_then(Value::as_array)?;
    let pairs = cookies
        .iter()
        .filter_map(|cookie| {
            let name = cookie.get("name").and_then(Value::as_str)?.trim();
            let value = cookie.get("value").and_then(Value::as_str)?.trim();
            (!name.is_empty()).then(|| format!("{name}={value}"))
        })
        .collect::<Vec<_>>();
    (!pairs.is_empty()).then(|| pairs.join("; "))
}

fn parse_cookie_input(raw: &str) -> Option<String> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    for line in text.lines() {
        let line = line.trim();
        if let Some(cookie) = line
            .strip_prefix("Cookie:")
            .or_else(|| line.strip_prefix("cookie:"))
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(clean_cookie_value(cookie));
        }
    }
    if let Some(cookie) = cookie_from_curl_header(text) {
        return Some(cookie);
    }
    Some(text.to_string())
}

fn cookie_from_curl_header(text: &str) -> Option<String> {
    for marker in ["Cookie:", "cookie:"] {
        let Some(start) = text.find(marker).map(|index| index + marker.len()) else {
            continue;
        };
        let rest = text[start..].trim_start();
        let quote = rest.chars().next().filter(|ch| *ch == '\'' || *ch == '"');
        if let Some(quote) = quote {
            let value = &rest[quote.len_utf8()..];
            let end = value.find(quote).unwrap_or(value.len());
            return Some(clean_cookie_value(&value[..end])).filter(|value| !value.is_empty());
        }
        let end = rest
            .find("\\\n")
            .or_else(|| rest.find('\n'))
            .unwrap_or(rest.len());
        return Some(clean_cookie_value(&rest[..end])).filter(|value| !value.is_empty());
    }
    None
}

fn clean_cookie_value(value: &str) -> String {
    value
        .trim()
        .trim_matches(|ch| ch == '\'' || ch == '"')
        .trim()
        .to_string()
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

fn find_chrome_binary() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("OZON_CHROME_PATH")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return Some(path);
    }
    [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|path| path.is_file())
}

fn extract_devtools_ws_url(line: &str) -> Option<String> {
    line.split_whitespace()
        .find(|part| part.starts_with("ws://127.0.0.1:") && part.contains("/devtools/browser/"))
        .map(str::to_string)
}

fn devtools_new_target_url(browser_ws_url: &str) -> Result<String> {
    let host = browser_ws_url
        .strip_prefix("ws://")
        .and_then(|rest| rest.split('/').next())
        .filter(|value| !value.is_empty())
        .context("Chrome DevTools 地址格式异常")?;
    Ok(format!("http://{host}/json/new"))
}

fn cookie_params(cookie: &str) -> Vec<Value> {
    parse_cookie_pairs(cookie)
        .into_iter()
        .map(|(name, value)| {
            json!({
                "name": name,
                "value": value,
                "url": SELLER_BASE,
            })
        })
        .collect()
}

fn parse_cookie_pairs(cookie: &str) -> Vec<(String, String)> {
    cookie
        .split(';')
        .filter_map(|part| {
            let (name, value) = part.split_once('=')?;
            let name = name.trim();
            if name.is_empty() {
                return None;
            }
            Some((name.to_string(), value.trim().to_string()))
        })
        .collect()
}

fn text_excerpt(text: &str) -> String {
    let mut excerpt = text.chars().take(1000).collect::<String>();
    if text.chars().count() > 1000 {
        excerpt.push_str("...");
    }
    excerpt
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

    #[test]
    fn builds_cookie_header_from_har_cookies() {
        let entry = json!({
            "request": {
                "cookies": [
                    {"name": "__Secure-a", "value": "1"},
                    {"name": "b", "value": "2"}
                ]
            }
        });
        assert_eq!(
            cookies_from_har_entry(&entry).as_deref(),
            Some("__Secure-a=1; b=2")
        );
    }

    #[test]
    fn parses_cookie_input_variants() {
        assert_eq!(
            parse_cookie_input("Cookie: a=1; b=2").as_deref(),
            Some("a=1; b=2")
        );
        assert_eq!(
            parse_cookie_input("curl 'https://seller.ozon.ru' -H 'Cookie: a=1; b=2'").as_deref(),
            Some("a=1; b=2")
        );
        assert_eq!(parse_cookie_input("a=1; b=2").as_deref(), Some("a=1; b=2"));
    }

    #[test]
    fn parses_cookie_pairs_without_losing_equals_in_values() {
        assert_eq!(
            parse_cookie_pairs("a=1; token=a=b=c; empty=; ignored"),
            vec![
                ("a".to_string(), "1".to_string()),
                ("token".to_string(), "a=b=c".to_string()),
                ("empty".to_string(), "".to_string()),
            ]
        );
    }

    #[test]
    fn builds_devtools_new_target_url() {
        assert_eq!(
            devtools_new_target_url("ws://127.0.0.1:49875/devtools/browser/8e544ac8-8127-49b1")
                .unwrap(),
            "http://127.0.0.1:49875/json/new"
        );
    }
}
