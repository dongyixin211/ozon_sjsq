use anyhow::{Context, Result};
use keyring::Entry;

const SERVICE: &str = "com.codex.ozon-sjsq";

pub fn set_secret(key: &str, value: &str) -> Result<()> {
    Entry::new(SERVICE, key)
        .context("无法打开系统密钥库")?
        .set_password(value)
        .context("无法保存密钥")
}

pub fn get_secret(key: &str) -> Result<String> {
    Entry::new(SERVICE, key)
        .context("无法打开系统密钥库")?
        .get_password()
        .context("未找到密钥")
}

pub fn delete_secret(key: &str) -> Result<()> {
    let entry = Entry::new(SERVICE, key).context("无法打开系统密钥库")?;
    let _ = entry.delete_credential();
    Ok(())
}

pub fn ozon_api_key_id(shop_id: &str) -> String {
    format!("shop:{shop_id}:ozon_api_key")
}

pub fn oss_secret_key_id(shop_id: &str) -> String {
    format!("shop:{shop_id}:oss_secret")
}

pub fn provider_api_key_id(provider_kind: &str, provider_id: &str) -> String {
    format!("provider:{provider_kind}:{provider_id}:api_key")
}
