use sha2::{Digest, Sha256};
use tauri::Manager;

pub fn fingerprint(app: &tauri::AppHandle) -> String {
    let username = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_default();
    let hostname = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_default();
    let app_dir = app
        .path()
        .app_data_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_default();
    let raw = format!("ozon-sjsq|{username}|{hostname}|{app_dir}");
    let hash = Sha256::digest(raw.as_bytes());
    format!("{hash:x}")
}
