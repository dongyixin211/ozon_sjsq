use anyhow::{anyhow, Context, Result};
use keyring::Entry;
use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;

const SERVICE: &str = "com.codex.ozon-sjsq";

pub fn set_secret(key: &str, value: &str) -> Result<()> {
    let keyring_result = Entry::new(SERVICE, key)
        .context("无法打开系统密钥库")
        .and_then(|entry| entry.set_password(value).context("无法保存密钥"));
    let fallback_result = set_fallback_secret(key, value);

    match (keyring_result, fallback_result) {
        (Ok(()), _) | (_, Ok(())) => Ok(()),
        (Err(keyring_error), Err(fallback_error)) => Err(anyhow!(
            "无法保存密钥：系统密钥库：{keyring_error}；备用存储：{fallback_error}"
        )),
    }
}

pub fn get_secret(key: &str) -> Result<String> {
    let keyring_result = Entry::new(SERVICE, key)
        .context("无法打开系统密钥库")
        .and_then(|entry| entry.get_password().context("未找到密钥"));

    match keyring_result {
        Ok(value) => Ok(value),
        Err(keyring_error) => match get_fallback_secret(key) {
            Ok(value) => Ok(value),
            Err(fallback_error) if fallback_error.to_string().contains("未找到密钥") => {
                Err(anyhow!("未找到密钥"))
            }
            Err(fallback_error) => Err(anyhow!(
                "未找到密钥：系统密钥库：{keyring_error}；备用存储：{fallback_error}"
            )),
        },
    }
}

pub fn delete_secret(key: &str) -> Result<()> {
    if let Ok(entry) = Entry::new(SERVICE, key) {
        let _ = entry.delete_credential();
    }
    let _ = delete_fallback_secret(key);
    Ok(())
}

pub fn ozon_api_key_id(shop_id: &str) -> String {
    format!("shop:{shop_id}:ozon_api_key")
}

pub fn oss_secret_key_id(shop_id: &str) -> String {
    format!("shop:{shop_id}:oss_secret")
}

pub fn ozon_seller_cookie_id(shop_id: &str) -> String {
    format!("shop:{shop_id}:ozon_seller_cookie")
}

pub fn provider_api_key_id(provider_kind: &str, provider_id: &str) -> String {
    format!("provider:{provider_kind}:{provider_id}:api_key")
}

fn fallback_path() -> Result<PathBuf> {
    Ok(fallback_base_dir()?.join(SERVICE).join("secrets.json"))
}

#[cfg(target_os = "macos")]
fn fallback_base_dir() -> Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("无法定位用户目录"))?;
    Ok(home.join("Library").join("Application Support"))
}

#[cfg(target_os = "windows")]
fn fallback_base_dir() -> Result<PathBuf> {
    std::env::var_os("APPDATA")
        .or_else(|| std::env::var_os("LOCALAPPDATA"))
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("无法定位 Windows 应用数据目录"))
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn fallback_base_dir() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from) {
        return Ok(path);
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("无法定位用户目录"))?;
    Ok(home.join(".local").join("share"))
}

fn read_fallback_secrets() -> Result<BTreeMap<String, String>> {
    let path = fallback_path()?;
    match fs::read_to_string(&path) {
        Ok(content) if content.trim().is_empty() => Ok(BTreeMap::new()),
        Ok(content) => serde_json::from_str(&content).context("无法读取备用密钥文件"),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(error) => Err(error).context("无法打开备用密钥文件"),
    }
}

fn write_fallback_secrets(secrets: &BTreeMap<String, String>) -> Result<()> {
    let path = fallback_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).context("无法创建备用密钥目录")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(parent)
                .context("无法读取备用密钥目录权限")?
                .permissions();
            permissions.set_mode(0o700);
            fs::set_permissions(parent, permissions).context("无法设置备用密钥目录权限")?;
        }
    }

    let content = serde_json::to_vec_pretty(secrets).context("无法序列化备用密钥")?;
    fs::write(&path, content).context("无法写入备用密钥文件")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&path)
            .context("无法读取备用密钥文件权限")?
            .permissions();
        permissions.set_mode(0o600);
        fs::set_permissions(&path, permissions).context("无法设置备用密钥文件权限")?;
    }
    Ok(())
}

fn set_fallback_secret(key: &str, value: &str) -> Result<()> {
    let mut secrets = read_fallback_secrets().unwrap_or_default();
    secrets.insert(key.to_string(), value.to_string());
    write_fallback_secrets(&secrets)
}

fn get_fallback_secret(key: &str) -> Result<String> {
    read_fallback_secrets()?
        .get(key)
        .filter(|value| !value.is_empty())
        .cloned()
        .ok_or_else(|| anyhow!("未找到密钥"))
}

fn delete_fallback_secret(key: &str) -> Result<()> {
    let mut secrets = read_fallback_secrets()?;
    if secrets.remove(key).is_some() {
        write_fallback_secrets(&secrets)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn fallback_secret_roundtrip() {
        let _guard = ENV_LOCK.lock().unwrap();
        let original_home = std::env::var_os("HOME");
        let original_appdata = std::env::var_os("APPDATA");
        let original_localappdata = std::env::var_os("LOCALAPPDATA");
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let test_home = std::env::temp_dir().join(format!(
            "ozon-sjsq-secret-test-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir_all(&test_home).unwrap();
        std::env::set_var("HOME", &test_home);
        std::env::set_var("APPDATA", &test_home);
        std::env::set_var("LOCALAPPDATA", &test_home);

        let key = "provider:text:test-provider:api_key";
        set_fallback_secret(key, "test-secret").unwrap();
        assert_eq!(get_fallback_secret(key).unwrap(), "test-secret");
        delete_fallback_secret(key).unwrap();
        assert!(get_fallback_secret(key).is_err());

        if let Some(home) = original_home {
            std::env::set_var("HOME", home);
        } else {
            std::env::remove_var("HOME");
        }
        if let Some(appdata) = original_appdata {
            std::env::set_var("APPDATA", appdata);
        } else {
            std::env::remove_var("APPDATA");
        }
        if let Some(localappdata) = original_localappdata {
            std::env::set_var("LOCALAPPDATA", localappdata);
        } else {
            std::env::remove_var("LOCALAPPDATA");
        }
        let _ = fs::remove_dir_all(test_home);
    }
}
