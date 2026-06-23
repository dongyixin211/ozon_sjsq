use anyhow::{Context, Result};
use reqwest::Client;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::fs;

const PAN_API: &str = "https://pan.baidu.com/api";
const PAN_HOME: &str = "https://pan.baidu.com/disk/home";
const PCS_UA: &str = "softxm;netdisk";
const LOCATE_DOWNLOAD_KEY: &str = "ebrcUYiuxaZv2XGu7KIYKxUrqfnOfpDF";
const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif", "svg", "heic", "ico",
];

#[derive(Debug, Clone)]
pub struct BaiduDownloadResult {
    pub succeeded: usize,
    pub skipped: usize,
    pub failed: usize,
    pub total: usize,
}

#[derive(Debug, Clone)]
pub struct BaiduPanOptions {
    pub cookie: String,
    pub search_dir: String,
    pub recursive: bool,
}

pub fn validate_cookie(cookie: &str) -> Result<()> {
    parse_cookies(cookie).map(|_| ())
}

pub async fn download_images(
    options: BaiduPanOptions,
    names: &[String],
    output_dir: &Path,
) -> Result<BaiduDownloadResult> {
    let client = BaiduPanClient::from_cookie_string(&options.cookie)?;
    client.bdstoken().await?;
    fs::create_dir_all(output_dir)
        .await
        .with_context(|| format!("创建素材目录失败：{}", output_dir.display()))?;

    let mut result = BaiduDownloadResult {
        succeeded: 0,
        skipped: 0,
        failed: 0,
        total: names.len(),
    };
    for name in names {
        match client
            .find_exact_image(name, &options.search_dir, options.recursive)
            .await
        {
            Ok(Some((item, dup_count))) => {
                let remote_path = item.path.clone();
                let local_path = output_dir.join(&item.filename);
                if local_path.exists() {
                    result.skipped += 1;
                    continue;
                }
                if dup_count > 1 {
                    eprintln!("发现多个同名素材，仅下载第一个：{}", remote_path);
                }
                match client.download_file(&remote_path, &local_path).await {
                    Ok(()) => result.succeeded += 1,
                    Err(_) => result.failed += 1,
                }
            }
            Ok(None) | Err(_) => result.failed += 1,
        }
    }
    Ok(result)
}

#[derive(Debug, Clone)]
struct PanItem {
    filename: String,
    path: String,
}

struct BaiduPanClient {
    http: Client,
    cookie_header: String,
    bduss: String,
}

impl BaiduPanClient {
    fn from_cookie_string(cookie: &str) -> Result<Self> {
        let cookies = parse_cookies(cookie)?;
        let bduss = cookies
            .get("BDUSS")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Cookie 中缺少 BDUSS"))?;
        Ok(Self {
            http: Client::builder()
                .timeout(std::time::Duration::from_secs(300))
                .build()?,
            cookie_header: cookies
                .iter()
                .map(|(key, value)| format!("{key}={value}"))
                .collect::<Vec<_>>()
                .join("; "),
            bduss,
        })
    }

    async fn bdstoken(&self) -> Result<String> {
        let text = self
            .http
            .get(PAN_HOME)
            .header("User-Agent", browser_ua())
            .header("Referer", PAN_HOME)
            .header("Cookie", &self.cookie_header)
            .send()
            .await?
            .error_for_status()?
            .text()
            .await?;
        extract_bdstoken(&text).context("无法获取 bdstoken，请检查百度网盘 Cookie 是否有效")
    }

    async fn search_files(
        &self,
        keyword: &str,
        search_dir: &str,
        recursive: bool,
    ) -> Result<Vec<Value>> {
        let mut all_items = Vec::new();
        let token = self.bdstoken().await?;
        let mut page = 1;
        loop {
            let response = self
                .http
                .get(format!("{PAN_API}/search"))
                .header("User-Agent", browser_ua())
                .header("Referer", PAN_HOME)
                .header("Cookie", &self.cookie_header)
                .query(&[
                    ("app_id", "250528".to_string()),
                    ("BDUSS", self.bduss.clone()),
                    ("bdstoken", token.clone()),
                    ("t", now_seconds().to_string()),
                    ("method", "search".to_string()),
                    ("dir", search_dir.to_string()),
                    ("key", keyword.to_string()),
                    ("recursion", if recursive { "1" } else { "0" }.to_string()),
                    ("page", page.to_string()),
                    ("num", "100".to_string()),
                ])
                .send()
                .await?
                .error_for_status()?;
            let data: Value = response.json().await?;
            if data.get("errno").and_then(Value::as_i64).unwrap_or(-1) != 0 {
                anyhow::bail!("百度网盘搜索失败：{}", data);
            }
            let items = data
                .get("list")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if items.is_empty() {
                break;
            }
            let is_last = items.len() < 100;
            all_items.extend(items);
            if is_last {
                break;
            }
            page += 1;
        }
        Ok(all_items)
    }

    async fn find_exact_image(
        &self,
        filename: &str,
        search_dir: &str,
        recursive: bool,
    ) -> Result<Option<(PanItem, usize)>> {
        let items = self.search_files(filename, search_dir, recursive).await?;
        let query_ext = Path::new(filename)
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase());
        let query_stem = Path::new(filename)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or(filename);
        let mut images = Vec::new();
        for item in items {
            if item.get("isdir").and_then(Value::as_i64).unwrap_or(0) == 1 {
                continue;
            }
            let Some(name) = item_filename(&item) else {
                continue;
            };
            if !is_image_file(&name) {
                continue;
            }
            let matches = if query_ext
                .as_deref()
                .is_some_and(|ext| IMAGE_EXTS.contains(&ext))
            {
                name == filename
            } else {
                Path::new(&name)
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .is_some_and(|stem| stem == query_stem)
            };
            if matches {
                let path = item
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if !path.is_empty() {
                    images.push(PanItem {
                        filename: name,
                        path,
                    });
                }
            }
        }
        Ok(images.first().cloned().map(|item| (item, images.len())))
    }

    async fn download_file(&self, remote_path: &str, local_path: &Path) -> Result<()> {
        if let Some(parent) = local_path.parent() {
            fs::create_dir_all(parent).await?;
        }
        let mut errors = Vec::new();
        if let Some(url) = self.locate_download_url(remote_path).await? {
            match self
                .stream_to_file(&url, local_path, Some(format!("BDUSS={}", self.bduss)))
                .await
            {
                Ok(()) => return Ok(()),
                Err(error) => errors.push(format!("locatedownload: {error}")),
            }
        }
        match self.dlink(remote_path).await {
            Ok(url) => match self.stream_to_file(&url, local_path, None).await {
                Ok(()) => return Ok(()),
                Err(error) => errors.push(format!("dlink: {error}")),
            },
            Err(error) => errors.push(format!("dlink: {error}")),
        }
        anyhow::bail!(errors.join("；"))
    }

    async fn dlink(&self, remote_path: &str) -> Result<String> {
        let token = self.bdstoken().await?;
        let response = self
            .http
            .post(format!("{PAN_API}/filemetas"))
            .header("User-Agent", browser_ua())
            .header("Referer", PAN_HOME)
            .header("Cookie", &self.cookie_header)
            .query(&[
                ("app_id", "250528".to_string()),
                ("BDUSS", self.bduss.clone()),
                ("bdstoken", token),
                ("t", now_seconds().to_string()),
                ("dlink", "1".to_string()),
            ])
            .form(&[("target", json!([remote_path]).to_string())])
            .send()
            .await?
            .error_for_status()?;
        let data: Value = response.json().await?;
        if data.get("errno").and_then(Value::as_i64).unwrap_or(-1) != 0 {
            anyhow::bail!("获取下载链接失败：{}", data);
        }
        data.get("info")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .and_then(|item| item.get("dlink"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .context("百度网盘没有返回下载链接")
    }

    async fn locate_download_url(&self, remote_path: &str) -> Result<Option<String>> {
        let uid = self.user_id().await.unwrap_or_default();
        let devuid = format!("{:x}|0", md5::compute(self.bduss.as_bytes())).to_uppercase();
        let enc = sha1_hex(&self.bduss);
        let timestamp = now_seconds().to_string();
        let rand = sha1_hex(&format!(
            "{enc}{uid}{LOCATE_DOWNLOAD_KEY}{timestamp}{devuid}"
        ));
        let response = self
            .http
            .get("https://pcs.baidu.com/rest/2.0/pcs/file")
            .header("User-Agent", PCS_UA)
            .header("Cookie", &self.cookie_header)
            .query(&[
                ("method", "locatedownload"),
                ("app_id", "250528"),
                ("path", remote_path),
                ("ver", "4.0"),
                ("clienttype", "17"),
                ("channel", "0"),
                ("time", &timestamp),
                ("rand", &rand),
                ("devuid", &devuid),
                ("cuid", &devuid),
                ("apn_id", "1_0"),
                ("check_blue", "1"),
                ("es", "1"),
                ("esl", "1"),
                ("freeisp", "0"),
                ("queryfree", "0"),
                ("use", "0"),
            ])
            .send()
            .await?;
        if !response.status().is_success() {
            return Ok(None);
        }
        let data: Value = response.json().await.unwrap_or(Value::Null);
        if data.get("host").and_then(Value::as_str) == Some("issuecdn.baidupcs.com") {
            return Ok(None);
        }
        Ok(data
            .get("urls")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .and_then(|item| item.get("url"))
            .and_then(Value::as_str)
            .map(str::to_string))
    }

    async fn user_id(&self) -> Result<String> {
        let response = self
            .http
            .get("https://pan.baidu.com/rest/2.0/membership/user")
            .header("User-Agent", browser_ua())
            .header("Cookie", &self.cookie_header)
            .query(&[("method", "query"), ("app_id", "250528"), ("web", "5")])
            .send()
            .await?
            .error_for_status()?;
        let data: Value = response.json().await?;
        Ok(data
            .pointer("/user/id")
            .or_else(|| data.pointer("/login_info/uid"))
            .and_then(Value::as_i64)
            .map(|id| id.to_string())
            .unwrap_or_default())
    }

    async fn stream_to_file(
        &self,
        url: &str,
        local_path: &Path,
        cookie: Option<String>,
    ) -> Result<()> {
        let header_sets = [
            ("pan.baidu.com", "https://pan.baidu.com/"),
            (
                "netdisk;7.0.0.6;PC;PC-Windows;10.0.22621;WindowsBaiduYun",
                PAN_HOME,
            ),
            (PCS_UA, PAN_HOME),
        ];
        let mut last_error = None;
        for (ua, referer) in header_sets {
            let mut request = self
                .http
                .get(url)
                .header("User-Agent", ua)
                .header("Referer", referer);
            if let Some(cookie) = &cookie {
                request = request.header("Cookie", cookie);
            }
            match request.send().await {
                Ok(response) if response.status().as_u16() == 403 => {
                    last_error = Some(anyhow::anyhow!("403 Forbidden"));
                }
                Ok(response) => {
                    let response = response.error_for_status()?;
                    if response.url().as_str().contains("wenxintishi") {
                        anyhow::bail!("下载被限速或需要验证，请稍后重试");
                    }
                    let bytes = response.bytes().await?;
                    fs::write(local_path, bytes).await?;
                    return Ok(());
                }
                Err(error) => last_error = Some(error.into()),
            }
        }
        Err(last_error.unwrap_or_else(|| anyhow::anyhow!("下载失败")))
    }
}

fn parse_cookies(cookie: &str) -> Result<HashMap<String, String>> {
    let mut cookies = HashMap::new();
    for part in cookie.split(';') {
        let Some((key, value)) = part.trim().split_once('=') else {
            continue;
        };
        cookies.insert(key.trim().to_string(), value.trim().to_string());
    }
    if !cookies
        .get("BDUSS")
        .is_some_and(|value| !value.trim().is_empty())
    {
        anyhow::bail!("Cookie 中缺少 BDUSS");
    }
    Ok(cookies)
}

fn item_filename(item: &Value) -> Option<String> {
    item.get("server_filename")
        .or_else(|| item.get("filename"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn is_image_file(filename: &str) -> bool {
    Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())
        .map(|ext| IMAGE_EXTS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn extract_bdstoken(text: &str) -> Option<String> {
    for marker in ["\"bdstoken\":\"", "\"bdstoken\" : \"", "\"bdstoken\": \""] {
        if let Some(start) = text.find(marker) {
            let rest = &text[start + marker.len()..];
            let token = rest
                .chars()
                .take_while(|ch| ch.is_ascii_hexdigit())
                .collect::<String>();
            if !token.is_empty() {
                return Some(token);
            }
        }
    }
    None
}

fn sha1_hex(value: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(value.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn browser_ua() -> &'static str {
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_bdstoken_from_home_script() {
        assert_eq!(
            extract_bdstoken(r#"window.locals={"bdstoken":"012345abcdef"};"#).as_deref(),
            Some("012345abcdef")
        );
    }

    #[test]
    fn matches_image_extensions_case_insensitively() {
        assert!(is_image_file("SKU001.JPG"));
        assert!(is_image_file("SKU001.png"));
        assert!(!is_image_file("SKU001.txt"));
    }

    #[test]
    fn reads_item_filename_variants() {
        assert_eq!(
            item_filename(&json!({"server_filename": "A.png"})).as_deref(),
            Some("A.png")
        );
        assert_eq!(
            item_filename(&json!({"filename": "B.jpg"})).as_deref(),
            Some("B.jpg")
        );
    }

    #[test]
    fn validates_required_baidu_cookie() {
        assert!(validate_cookie("BDUSS=token; STOKEN=other").is_ok());
        assert!(validate_cookie("STOKEN=other").is_err());
        assert!(validate_cookie("BDUSS= ; STOKEN=other").is_err());
    }
}
