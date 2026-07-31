use crate::core::jobs::JobRegistry;
use crate::core::models::{GalleryUploadRequest, GalleryUploadSelection, JobStatus};
use crate::core::secrets;
use anyhow::{anyhow, Context, Result};
use base64::Engine;
use chrono::Utc;
use futures_util::{stream, StreamExt};
use image::codecs::webp::WebPEncoder;
use image::imageops::FilterType;
use image::{ExtendedColorType, GenericImageView, ImageEncoder};
use reqwest::StatusCode;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use tokio::time::{sleep, Duration};
use uuid::Uuid;

const MAX_BATCH_UPLOAD_FILES: usize = 50;
const DIRECT_UPLOAD_CONCURRENCY: usize = 6;
const POLL_INTERVAL_MS: u64 = 1200;
const CLOUD_TOKEN_SECRET_PREFIX: &str = "gallery_upload";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadTaskResponse {
    task: UploadTask,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadTask {
    id: String,
    status: String,
    total_files: usize,
    uploaded: usize,
    failed: usize,
    processed: usize,
    message: Option<String>,
    errors: Vec<UploadTaskError>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadTaskError {
    filename: String,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectUploadItem {
    client_item_id: String,
    filename: String,
    content_type: String,
    size_bytes: u64,
    sha256: String,
    width: u32,
    height: u32,
    sku: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirectUploadTarget {
    client_item_id: String,
    original_upload_url: String,
    thumbnail_upload_url: String,
}

#[derive(Debug, Deserialize)]
struct DirectUploadPrepareResponse {
    items: Vec<DirectUploadTarget>,
    #[serde(default)]
    skipped: Vec<DirectUploadSkipped>,
    #[serde(default)]
    errors: Vec<DirectUploadCompleteError>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirectUploadSkipped {
    client_item_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirectUploadCompleteResponse {
    uploaded: usize,
    failed: usize,
    errors: Vec<DirectUploadCompleteError>,
    #[serde(default, skip_deserializing)]
    skipped: usize,
    #[serde(default, skip_deserializing)]
    history_items: Vec<DirectUploadItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirectUploadCompleteError {
    client_item_id: String,
    filename: String,
    message: String,
}

#[derive(Debug, Clone)]
struct PersistedUploadJob {
    cloud_api_base_url: String,
    cloud_auth_secret_key: String,
    product_image_rule_id: String,
}

#[derive(Debug, Clone)]
struct PersistedUploadItem {
    id: String,
    path: PathBuf,
    cache_path: Option<PathBuf>,
    filename: String,
    size_bytes: u64,
}

impl PersistedUploadItem {
    fn upload_path(&self) -> &Path {
        self.cache_path.as_deref().unwrap_or(&self.path)
    }
}

#[derive(Debug, Clone, Default)]
struct UploadJobStats {
    total: usize,
    queued: usize,
    uploaded: usize,
    failed: usize,
    processed: usize,
}

pub fn scan_image_files(paths: Vec<String>) -> Result<GalleryUploadSelection> {
    let mut files = Vec::new();
    for raw in paths {
        let path = PathBuf::from(raw.trim());
        if path.is_file() {
            if is_supported_image_path(&path) {
                files.push(path);
            }
            continue;
        }
        if path.is_dir() {
            collect_images_in_dir(&path, &mut files)?;
        }
    }
    files.sort();
    files.dedup();
    selection_from_paths(files)
}

pub fn resume_pending_upload_jobs(db_path: PathBuf, jobs: JobRegistry) {
    let pending = match list_pending_upload_job_ids(&db_path) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("恢复云图库上传任务失败：{error}");
            return;
        }
    };
    for job_id in pending {
        jobs.resume(&job_id);
        let next_jobs = jobs.clone();
        let next_db_path = db_path.clone();
        tauri::async_runtime::spawn(async move {
            run_persisted_gallery_upload_job(next_jobs, next_db_path, job_id).await;
        });
    }
}

pub async fn run_persisted_gallery_upload_job(jobs: JobRegistry, db_path: PathBuf, job_id: String) {
    if let Err(error) = run_persisted_gallery_upload_job_inner(&jobs, &db_path, &job_id).await {
        let message = error.to_string();
        if jobs.is_cancelled(&job_id) {
            jobs.log(&job_id, "warn", "客户端后台上传任务已取消。");
            let _ = delete_upload_job_secret(&db_path, &job_id);
            let _ = cleanup_upload_job_cache_dir(&db_path, &job_id);
            let _ = update_upload_job_status(&db_path, &job_id, "cancelled");
            let current = upload_job_stats(&db_path, &job_id).unwrap_or_default();
            jobs.update(
                &job_id,
                JobStatus::Cancelled,
                progress(current.processed, current.total.max(1)),
                None,
            );
            return;
        }
        jobs.log(&job_id, "error", &message);
        jobs.fail(&job_id, message.clone());
        let permanent = is_permanent_upload_error(&message);
        let status = if permanent { "failed" } else { "queued" };
        if permanent {
            let _ = delete_upload_job_secret(&db_path, &job_id);
            let _ = cleanup_upload_job_cache_dir(&db_path, &job_id);
        }
        let _ = update_upload_job_status(&db_path, &job_id, status);
    }
}

pub fn persist_gallery_upload_job(
    db_path: &Path,
    job_id: &str,
    request: &GalleryUploadRequest,
) -> Result<GalleryUploadSelection> {
    let token = request
        .cloud_auth_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("请先登录会员账号，再启动客户端后台上传"))?
        .to_string();
    let base_url = normalize_base_url(&request.cloud_api_base_url)?;
    let product_image_rule_id = request
        .product_image_rule_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("请先选择商品类型和图片比例"))?
        .to_string();
    let selection = scan_image_files(request.paths.clone())?;
    if selection.paths.is_empty() {
        return Err(anyhow!(
            "没有找到可上传的图片，请选择 PNG、JPG、JPEG 或 WebP 文件"
        ));
    }
    let secret_key = cloud_token_secret_key(job_id);
    secrets::set_secret(&secret_key, &token)
        .context("无法保存云端登录凭证，后台上传不能断点恢复")?;
    save_upload_job(
        db_path,
        job_id,
        &base_url,
        &secret_key,
        &product_image_rule_id,
        request.source_label.as_deref(),
        &selection,
    )?;
    Ok(selection)
}

async fn run_persisted_gallery_upload_job_inner(
    jobs: &JobRegistry,
    db_path: &Path,
    job_id: &str,
) -> Result<()> {
    let upload_job =
        read_upload_job(db_path, job_id)?.ok_or_else(|| anyhow!("未找到本地上传任务记录"))?;
    let token = secrets::get_secret(&upload_job.cloud_auth_secret_key)
        .context("无法读取云端登录凭证，请重新登录后重新启动上传")?;
    let base_url = normalize_base_url(&upload_job.cloud_api_base_url)?;
    let account_key = cloud_account_key(&token);
    let initial_stats = upload_job_stats(db_path, job_id)?;
    if initial_stats.total == 0 {
        return Err(anyhow!("本地上传任务没有可处理文件"));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .context("无法创建上传客户端")?;
    let total = initial_stats.total.max(1);

    update_upload_job_status(db_path, job_id, "running")?;
    jobs.update(job_id, JobStatus::Running, 1, None);
    resume_running_server_tasks(jobs, job_id, db_path, &client, &base_url, &token, total).await?;
    let stats = upload_job_stats(db_path, job_id)?;
    let batches = queued_upload_batches(db_path, job_id)?;
    jobs.log(
        job_id,
        "info",
        &format!(
            "开始客户端后台上传：剩余 {} 张图片，共 {} 批。",
            stats.queued,
            batches.len(),
        ),
    );

    for (batch_index, batch) in batches.iter().enumerate() {
        if jobs.is_cancelled(job_id) {
            jobs.log(job_id, "warn", "用户已取消客户端后台上传任务。");
            update_upload_job_status(db_path, job_id, "cancelled")?;
            let _ = secrets::delete_secret(&upload_job.cloud_auth_secret_key);
            let _ = cleanup_upload_job_cache_dir(db_path, job_id);
            let current = upload_job_stats(db_path, job_id)?;
            jobs.update(
                job_id,
                JobStatus::Cancelled,
                progress(current.processed, total),
                None,
            );
            return Ok(());
        }

        let batch_bytes = batch.iter().map(|item| item.size_bytes).sum::<u64>();
        mark_upload_items(db_path, job_id, batch, "running", None, None)?;
        jobs.log(
            job_id,
            "info",
            &format!(
                "客户端直传第 {}/{} 批：{} 张，{}。",
                batch_index + 1,
                batches.len(),
                batch.len(),
                format_bytes(batch_bytes)
            ),
        );

        let finished = direct_upload_batch(
            &client,
            &base_url,
            &token,
            &upload_job.product_image_rule_id,
            db_path,
            batch,
        )
        .await;
        apply_direct_upload_batch(
            db_path,
            job_id,
            &base_url,
            &account_key,
            &upload_job.product_image_rule_id,
            batch,
            &finished,
        )?;
        jobs.log(
            job_id,
            "info",
            &format!(
                "第 {}/{} 批 OSS 直传完成：新上传 {} 张，跳过重复 {} 张，失败 {} 张。",
                batch_index + 1,
                batches.len(),
                finished.uploaded,
                finished.skipped,
                finished.failed,
            ),
        );
        let current = upload_job_stats(db_path, job_id)?;
        jobs.update_counts(job_id, current.uploaded, current.failed);
        jobs.update(
            job_id,
            JobStatus::Running,
            progress(current.processed, total),
            None,
        );
        for error in finished.errors.iter().take(10) {
            jobs.log(
                job_id,
                "warn",
                &format!("{} 上传失败：{}", error.filename, error.message),
            );
        }
    }

    let final_stats = upload_job_stats(db_path, job_id)?;
    jobs.update_counts(job_id, final_stats.uploaded, final_stats.failed);
    if final_stats.uploaded == 0 && final_stats.failed > 0 {
        update_upload_job_status(db_path, job_id, "failed")?;
        let _ = secrets::delete_secret(&upload_job.cloud_auth_secret_key);
        let _ = cleanup_upload_job_cache_dir(db_path, job_id);
        jobs.fail(
            job_id,
            "图片上传全部失败，请查看任务日志中的失败原因。".to_string(),
        );
        return Ok(());
    }
    update_upload_job_status(
        db_path,
        job_id,
        if final_stats.failed > 0 {
            "partial"
        } else {
            "succeeded"
        },
    )?;
    let _ = secrets::delete_secret(&upload_job.cloud_auth_secret_key);
    let _ = cleanup_upload_job_cache_dir(db_path, job_id);
    jobs.log(
        job_id,
        "info",
        &format!(
            "客户端后台上传完成：成功 {} 张，失败 {} 张。",
            final_stats.uploaded, final_stats.failed
        ),
    );
    jobs.complete_with_result(job_id, None, final_stats.uploaded, final_stats.failed);
    Ok(())
}

fn save_upload_job(
    db_path: &Path,
    job_id: &str,
    base_url: &str,
    secret_key: &str,
    product_image_rule_id: &str,
    source_label: Option<&str>,
    selection: &GalleryUploadSelection,
) -> Result<()> {
    let conn = Connection::open(db_path).context("无法打开本地上传队列数据库")?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        r#"
        INSERT INTO gallery_upload_jobs (
          job_id, cloud_api_base_url, cloud_auth_secret_key, product_image_rule_id, source_label,
          total_files, total_bytes, status, created_at, updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', ?8, ?8)
        ON CONFLICT(job_id) DO UPDATE SET
          cloud_api_base_url = excluded.cloud_api_base_url,
          cloud_auth_secret_key = excluded.cloud_auth_secret_key,
          product_image_rule_id = excluded.product_image_rule_id,
          source_label = excluded.source_label,
          total_files = excluded.total_files,
          total_bytes = excluded.total_bytes,
          status = 'queued',
          updated_at = excluded.updated_at
        "#,
        params![
            job_id,
            base_url,
            secret_key,
            product_image_rule_id,
            source_label,
            i64::try_from(selection.count).unwrap_or(i64::MAX),
            i64::try_from(selection.total_bytes).unwrap_or(i64::MAX),
            now,
        ],
    )?;
    conn.execute(
        "DELETE FROM gallery_upload_items WHERE job_id = ?1",
        params![job_id],
    )?;
    let mut stmt = conn.prepare(
        r#"
        INSERT INTO gallery_upload_items (
          id, job_id, path, filename, size_bytes, status, created_at, updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6, ?6)
        "#,
    )?;
    for path_text in &selection.paths {
        let path = PathBuf::from(path_text);
        let filename = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("image")
            .to_string();
        let size = fs::metadata(&path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        stmt.execute(params![
            Uuid::new_v4().to_string(),
            job_id,
            path_text,
            filename,
            i64::try_from(size).unwrap_or(i64::MAX),
            now,
        ])?;
    }
    Ok(())
}

fn read_upload_job(db_path: &Path, job_id: &str) -> Result<Option<PersistedUploadJob>> {
    let conn = Connection::open(db_path).context("无法打开本地上传队列数据库")?;
    conn.query_row(
        r#"
        SELECT cloud_api_base_url, cloud_auth_secret_key, product_image_rule_id
        FROM gallery_upload_jobs
        WHERE job_id = ?1
        "#,
        params![job_id],
        |row| {
            Ok(PersistedUploadJob {
                cloud_api_base_url: row.get(0)?,
                cloud_auth_secret_key: row.get(1)?,
                product_image_rule_id: row.get(2)?,
            })
        },
    )
    .optional()
    .context("无法读取本地上传任务")
}

fn list_pending_upload_job_ids(db_path: &Path) -> Result<Vec<String>> {
    let conn = Connection::open(db_path).context("无法打开本地上传队列数据库")?;
    let mut stmt = conn.prepare(
        r#"
        SELECT job_id
        FROM gallery_upload_jobs
        WHERE status IN ('queued', 'running')
        ORDER BY created_at ASC
        "#,
    )?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .context("无法读取待恢复上传任务")
}

async fn resume_running_server_tasks(
    jobs: &JobRegistry,
    job_id: &str,
    db_path: &Path,
    client: &reqwest::Client,
    base_url: &str,
    token: &str,
    total: usize,
) -> Result<()> {
    let groups = running_server_task_groups(db_path, job_id)?;
    for (task_id, items) in groups {
        if items.is_empty() {
            continue;
        }
        jobs.log(
            job_id,
            "info",
            &format!("继续查询上次已提交的云端上传任务：{task_id}。"),
        );
        let before = upload_job_stats(db_path, job_id)?;
        let finished = match wait_server_upload_task(
            jobs,
            job_id,
            client,
            base_url,
            token,
            task_id.clone(),
            before.processed,
            before.uploaded,
            before.failed,
            total,
        )
        .await
        {
            Ok(task) => task,
            Err(error) if error.to_string().contains("HTTP 404") => {
                jobs.log(
                    job_id,
                    "warn",
                    &format!("云端任务 {task_id} 不存在，已将本批图片重新排队上传。"),
                );
                requeue_upload_items(db_path, job_id, &items)?;
                continue;
            }
            Err(error) => return Err(error),
        };
        apply_finished_batch(db_path, job_id, &items, &finished)?;
        cleanup_cached_upload_items(db_path, job_id, &items)?;
        let current = upload_job_stats(db_path, job_id)?;
        jobs.update_counts(job_id, current.uploaded, current.failed);
    }
    Ok(())
}

fn running_server_task_groups(
    db_path: &Path,
    job_id: &str,
) -> Result<Vec<(String, Vec<PersistedUploadItem>)>> {
    let conn = Connection::open(db_path).context("无法打开本地上传队列数据库")?;
    let mut stmt = conn.prepare(
        r#"
        SELECT id, path, filename, size_bytes, cache_path, server_task_id
        FROM gallery_upload_items
        WHERE job_id = ?1
          AND status = 'running'
          AND server_task_id IS NOT NULL
          AND server_task_id <> ''
        ORDER BY updated_at ASC, id ASC
        "#,
    )?;
    let rows = stmt.query_map(params![job_id], |row| {
        let size: i64 = row.get(3)?;
        let cache_path = row
            .get::<_, Option<String>>(4)?
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);
        Ok((
            row.get::<_, String>(5)?,
            PersistedUploadItem {
                id: row.get(0)?,
                path: PathBuf::from(row.get::<_, String>(1)?),
                cache_path,
                filename: row.get(2)?,
                size_bytes: u64::try_from(size.max(0)).unwrap_or(0),
            },
        ))
    })?;
    let rows = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("无法读取已提交云端的上传任务")?;
    let mut groups: Vec<(String, Vec<PersistedUploadItem>)> = Vec::new();
    for (task_id, item) in rows {
        if let Some((_, items)) = groups.iter_mut().find(|(id, _)| id == &task_id) {
            items.push(item);
        } else {
            groups.push((task_id, vec![item]));
        }
    }
    Ok(groups)
}

fn queued_upload_batches(db_path: &Path, job_id: &str) -> Result<Vec<Vec<PersistedUploadItem>>> {
    let conn = Connection::open(db_path).context("无法打开本地上传队列数据库")?;
    conn.execute(
        "UPDATE gallery_upload_items SET status = 'queued' WHERE job_id = ?1 AND status = 'running' AND server_task_id IS NULL",
        params![job_id],
    )?;
    let mut stmt = conn.prepare(
        r#"
        SELECT id, path, filename, size_bytes, cache_path
        FROM gallery_upload_items
        WHERE job_id = ?1
          AND status = 'queued'
        ORDER BY created_at ASC, id ASC
        "#,
    )?;
    let rows = stmt.query_map(params![job_id], |row| {
        let size: i64 = row.get(3)?;
        let cache_path = row
            .get::<_, Option<String>>(4)?
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);
        Ok(PersistedUploadItem {
            id: row.get(0)?,
            path: PathBuf::from(row.get::<_, String>(1)?),
            cache_path,
            filename: row.get(2)?,
            size_bytes: u64::try_from(size.max(0)).unwrap_or(0),
        })
    })?;
    let items = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("无法读取待上传图片明细")?;
    Ok(chunk_upload_items(&items))
}

fn upload_job_stats(db_path: &Path, job_id: &str) -> Result<UploadJobStats> {
    let conn = Connection::open(db_path).context("无法打开本地上传队列数据库")?;
    let stats = conn.query_row(
        r#"
        SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END), 0) AS queued,
          COALESCE(SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END), 0) AS uploaded,
          COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
          COALESCE(SUM(CASE WHEN status IN ('succeeded', 'failed') THEN 1 ELSE 0 END), 0) AS processed
        FROM gallery_upload_items
        WHERE job_id = ?1
        "#,
        params![job_id],
        |row| {
            Ok(UploadJobStats {
                total: usize::try_from(row.get::<_, i64>(0)?.max(0)).unwrap_or(0),
                queued: usize::try_from(row.get::<_, i64>(1)?.max(0)).unwrap_or(0),
                uploaded: usize::try_from(row.get::<_, i64>(2)?.max(0)).unwrap_or(0),
                failed: usize::try_from(row.get::<_, i64>(3)?.max(0)).unwrap_or(0),
                processed: usize::try_from(row.get::<_, i64>(4)?.max(0)).unwrap_or(0),
            })
        },
    )?;
    Ok(stats)
}

fn update_upload_job_status(db_path: &Path, job_id: &str, status: &str) -> Result<()> {
    let conn = Connection::open(db_path).context("无法打开本地上传队列数据库")?;
    conn.execute(
        "UPDATE gallery_upload_jobs SET status = ?2, updated_at = ?3 WHERE job_id = ?1",
        params![job_id, status, Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

fn delete_upload_job_secret(db_path: &Path, job_id: &str) -> Result<()> {
    if let Some(job) = read_upload_job(db_path, job_id)? {
        let _ = secrets::delete_secret(&job.cloud_auth_secret_key);
    }
    Ok(())
}

fn mark_upload_items(
    db_path: &Path,
    job_id: &str,
    items: &[PersistedUploadItem],
    status: &str,
    server_task_id: Option<&str>,
    error: Option<&str>,
) -> Result<()> {
    let conn = Connection::open(db_path).context("无法打开本地上传队列数据库")?;
    let now = Utc::now().to_rfc3339();
    for item in items {
        conn.execute(
            r#"
            UPDATE gallery_upload_items
            SET status = ?3,
                server_task_id = COALESCE(?4, server_task_id),
                error = ?5,
                updated_at = ?6
            WHERE job_id = ?1
              AND id = ?2
            "#,
            params![job_id, item.id, status, server_task_id, error, now],
        )?;
    }
    Ok(())
}

fn requeue_upload_items(db_path: &Path, job_id: &str, items: &[PersistedUploadItem]) -> Result<()> {
    let conn = Connection::open(db_path).context("无法打开本地上传队列数据库")?;
    let now = Utc::now().to_rfc3339();
    for item in items {
        conn.execute(
            r#"
            UPDATE gallery_upload_items
            SET status = 'queued',
                server_task_id = NULL,
                error = NULL,
                updated_at = ?3
            WHERE job_id = ?1
              AND id = ?2
            "#,
            params![job_id, item.id, now],
        )?;
    }
    Ok(())
}

fn apply_finished_batch(
    db_path: &Path,
    job_id: &str,
    items: &[PersistedUploadItem],
    task: &UploadTask,
) -> Result<()> {
    let mut errors_by_name: HashMap<String, Vec<String>> = HashMap::new();
    for error in &task.errors {
        errors_by_name
            .entry(error.filename.clone())
            .or_default()
            .push(error.message.clone());
    }
    let conn = Connection::open(db_path).context("无法打开本地上传队列数据库")?;
    let now = Utc::now().to_rfc3339();
    for item in items {
        let error_message = errors_by_name.get_mut(&item.filename).and_then(|messages| {
            if messages.is_empty() {
                None
            } else {
                Some(messages.remove(0))
            }
        });
        let status = if error_message.is_some() {
            "failed"
        } else {
            "succeeded"
        };
        conn.execute(
            r#"
            UPDATE gallery_upload_items
            SET status = ?3,
                server_task_id = ?4,
                error = ?5,
                updated_at = ?6
            WHERE job_id = ?1
              AND id = ?2
            "#,
            params![job_id, item.id, status, task.id, error_message, now],
        )?;
    }
    Ok(())
}

fn cleanup_cached_upload_items(
    db_path: &Path,
    job_id: &str,
    items: &[PersistedUploadItem],
) -> Result<()> {
    let conn = Connection::open(db_path).context("无法打开本地上传队列数据库")?;
    let now = Utc::now().to_rfc3339();
    for item in items {
        if let Some(cache_path) = &item.cache_path {
            let _ = remove_cached_file(db_path, cache_path);
            conn.execute(
                r#"
                UPDATE gallery_upload_items
                SET cache_path = NULL,
                    updated_at = ?3
                WHERE job_id = ?1
                  AND id = ?2
                "#,
                params![job_id, item.id, now],
            )?;
        }
    }
    Ok(())
}

fn cleanup_upload_job_cache_dir(db_path: &Path, job_id: &str) -> Result<()> {
    let dir = upload_job_cache_dir(db_path, job_id);
    if !dir.exists() {
        return Ok(());
    }
    let root = upload_cache_root(db_path);
    let canonical_root = match fs::canonicalize(&root) {
        Ok(value) => value,
        Err(_) => return Ok(()),
    };
    let canonical_dir = match fs::canonicalize(&dir) {
        Ok(value) => value,
        Err(_) => return Ok(()),
    };
    if canonical_dir.starts_with(&canonical_root) {
        let _ = fs::remove_dir_all(canonical_dir);
    }
    Ok(())
}

fn remove_cached_file(db_path: &Path, cache_path: &Path) -> Result<()> {
    if !cache_path.exists() {
        return Ok(());
    }
    let root = upload_cache_root(db_path);
    let canonical_root = match fs::canonicalize(&root) {
        Ok(value) => value,
        Err(_) => return Ok(()),
    };
    let canonical_file = match fs::canonicalize(cache_path) {
        Ok(value) => value,
        Err(_) => return Ok(()),
    };
    if canonical_file.starts_with(&canonical_root) {
        let _ = fs::remove_file(canonical_file);
    }
    Ok(())
}

fn upload_cache_root(db_path: &Path) -> PathBuf {
    db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("gallery-upload-cache")
}

fn upload_job_cache_dir(db_path: &Path, job_id: &str) -> PathBuf {
    upload_cache_root(db_path).join(sanitize_cache_filename(job_id))
}

fn sanitize_cache_filename(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "image".to_string()
    } else if sanitized.len() > 180 {
        sanitized.chars().take(180).collect()
    } else {
        sanitized
    }
}

fn cloud_token_secret_key(job_id: &str) -> String {
    format!("{CLOUD_TOKEN_SECRET_PREFIX}:{job_id}:cloud_token")
}

fn cloud_account_key(token: &str) -> String {
    if let Some(payload) = token.split('.').nth(1) {
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(payload)
            .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(payload));
        if let Ok(bytes) = decoded {
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                for key in ["sub", "userId", "id"] {
                    if let Some(account) = value.get(key).and_then(|item| item.as_str()) {
                        if !account.trim().is_empty() {
                            return account.to_string();
                        }
                    }
                }
            }
        }
    }
    format!("token-{:x}", Sha256::digest(token.as_bytes()))
}

fn upload_history_contains(
    db_path: &Path,
    base_url: &str,
    account_key: &str,
    product_image_rule_id: &str,
    sha256: &str,
) -> Result<bool> {
    let conn = Connection::open(db_path).context("无法打开本地上传历史数据库")?;
    let exists = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM gallery_upload_history WHERE cloud_api_base_url = ?1 AND cloud_account_key = ?2 AND product_image_rule_id = ?3 AND sha256 = ?4)",
        params![base_url, account_key, product_image_rule_id, sha256],
        |row| row.get::<_, i64>(0),
    )?;
    Ok(exists != 0)
}

fn save_upload_history(
    conn: &Connection,
    base_url: &str,
    account_key: &str,
    product_image_rule_id: &str,
    item: &DirectUploadItem,
    uploaded_at: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO gallery_upload_history (cloud_api_base_url, cloud_account_key, product_image_rule_id, sha256, sku, source_filename, uploaded_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(cloud_api_base_url, cloud_account_key, product_image_rule_id, sha256) DO UPDATE SET sku = excluded.sku, source_filename = excluded.source_filename, uploaded_at = excluded.uploaded_at",
        params![base_url, account_key, product_image_rule_id, item.sha256, item.sku, item.filename, uploaded_at],
    )?;
    Ok(())
}

async fn direct_upload_batch(
    client: &reqwest::Client,
    base_url: &str,
    token: &str,
    product_image_rule_id: &str,
    db_path: &Path,
    items: &[PersistedUploadItem],
) -> DirectUploadCompleteResponse {
    let prepared_results = stream::iter(
        items
            .iter()
            .cloned()
            .map(|item| async move { prepare_direct_upload_item(item).await }),
    )
    .buffer_unordered(DIRECT_UPLOAD_CONCURRENCY)
    .collect::<Vec<_>>()
    .await;

    let account_key = cloud_account_key(token);
    let mut prepared = Vec::new();
    let mut history_items = Vec::new();
    let mut errors = Vec::new();
    for result in prepared_results {
        match result {
            Ok((item, meta)) => {
                if upload_history_contains(
                    db_path,
                    base_url,
                    &account_key,
                    product_image_rule_id,
                    &meta.sha256,
                )
                .unwrap_or(false)
                {
                    history_items.push(meta);
                } else {
                    prepared.push((item, meta));
                }
            }
            Err((item, error)) => errors.push(DirectUploadCompleteError {
                client_item_id: item.id,
                filename: item.filename,
                message: error.to_string(),
            }),
        }
    }
    let mut skipped = history_items.len();
    if prepared.is_empty() {
        return DirectUploadCompleteResponse {
            uploaded: 0,
            failed: errors.len(),
            errors,
            skipped,
            history_items,
        };
    }

    let direct_items = prepared
        .iter()
        .map(|(_, meta)| meta.clone())
        .collect::<Vec<_>>();
    let prepare_response = match client
        .post(format!("{base_url}/gallery/assets/direct-upload/prepare"))
        .bearer_auth(token)
        .json(&serde_json::json!({
            "productImageRuleId": product_image_rule_id,
            "items": direct_items,
        }))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => {
            match response.json::<DirectUploadPrepareResponse>().await {
                Ok(value) => value,
                Err(error) => {
                    errors.extend(direct_upload_errors(
                        &prepared,
                        format!("直传地址响应解析失败：{error}"),
                    ));
                    return DirectUploadCompleteResponse {
                        uploaded: 0,
                        failed: errors.len(),
                        errors,
                        skipped,
                        history_items,
                    };
                }
            }
        }
        Ok(response) => {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            errors.extend(direct_upload_errors(
                &prepared,
                format!("申请 OSS 直传地址失败：HTTP {status} {body}"),
            ));
            return DirectUploadCompleteResponse {
                uploaded: 0,
                failed: errors.len(),
                errors,
                skipped,
                history_items,
            };
        }
        Err(error) => {
            errors.extend(direct_upload_errors(
                &prepared,
                format!("申请 OSS 直传地址失败：{error}"),
            ));
            return DirectUploadCompleteResponse {
                uploaded: 0,
                failed: errors.len(),
                errors,
                skipped,
                history_items,
            };
        }
    };
    errors.extend(prepare_response.errors);
    let skipped_ids = prepare_response
        .skipped
        .into_iter()
        .map(|item| item.client_item_id)
        .collect::<HashSet<_>>();
    for (_, meta) in &prepared {
        if skipped_ids.contains(&meta.client_item_id) {
            history_items.push(meta.clone());
            skipped += 1;
        }
    }
    let target_by_id = prepare_response
        .items
        .into_iter()
        .map(|target| (target.client_item_id.clone(), target))
        .collect::<HashMap<_, _>>();
    for (_, meta) in &prepared {
        if !target_by_id.contains_key(&meta.client_item_id)
            && !skipped_ids.contains(&meta.client_item_id)
            && !errors
                .iter()
                .any(|error| error.client_item_id == meta.client_item_id)
        {
            errors.push(DirectUploadCompleteError {
                client_item_id: meta.client_item_id.clone(),
                filename: meta.filename.clone(),
                message: "服务器未返回该图片的 OSS 上传地址".to_string(),
            });
        }
    }

    let uploads = stream::iter(
        prepared
            .into_iter()
            .filter_map(|(item, meta)| {
                target_by_id
                    .get(&meta.client_item_id)
                    .cloned()
                    .map(|target| (item, meta, target))
            })
            .map(|(item, meta, target)| {
                let client = client.clone();
                async move { upload_direct_item(&client, item, meta, target).await }
            }),
    )
    .buffer_unordered(DIRECT_UPLOAD_CONCURRENCY)
    .collect::<Vec<_>>()
    .await;

    let mut uploaded_items = Vec::new();
    for result in uploads {
        match result {
            Ok(meta) => uploaded_items.push(meta),
            Err(error) => errors.push(error),
        }
    }
    if uploaded_items.is_empty() {
        return DirectUploadCompleteResponse {
            uploaded: 0,
            failed: errors.len(),
            errors,
            skipped,
            history_items,
        };
    }

    let response = match client
        .post(format!("{base_url}/gallery/assets/direct-upload/complete"))
        .bearer_auth(token)
        .json(&serde_json::json!({
            "productImageRuleId": product_image_rule_id,
            "items": &uploaded_items,
        }))
        .send()
        .await
    {
        Ok(value) => value,
        Err(error) => {
            errors.extend(uploaded_items.iter().map(|meta| DirectUploadCompleteError {
                client_item_id: meta.client_item_id.clone(),
                filename: meta.filename.clone(),
                message: format!("保存图片记录失败：{error}"),
            }));
            return DirectUploadCompleteResponse {
                uploaded: 0,
                failed: errors.len(),
                errors,
                skipped,
                history_items,
            };
        }
    };
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        errors.extend(uploaded_items.iter().map(|meta| DirectUploadCompleteError {
            client_item_id: meta.client_item_id.clone(),
            filename: meta.filename.clone(),
            message: format!("保存图片记录失败：HTTP {status} {body}"),
        }));
        return DirectUploadCompleteResponse {
            uploaded: 0,
            failed: errors.len(),
            errors,
            skipped,
            history_items,
        };
    }
    match response.json::<DirectUploadCompleteResponse>().await {
        Ok(mut completed) => {
            let server_error_ids = completed
                .errors
                .iter()
                .map(|error| error.client_item_id.as_str())
                .collect::<HashSet<_>>();
            history_items.extend(
                uploaded_items
                    .into_iter()
                    .filter(|meta| !server_error_ids.contains(meta.client_item_id.as_str())),
            );
            completed.errors.extend(errors);
            completed.failed = completed.errors.len();
            completed.skipped = skipped;
            completed.history_items = history_items;
            completed
        }
        Err(error) => {
            errors.extend(uploaded_items.iter().map(|meta| DirectUploadCompleteError {
                client_item_id: meta.client_item_id.clone(),
                filename: meta.filename.clone(),
                message: format!("保存图片记录响应解析失败：{error}"),
            }));
            DirectUploadCompleteResponse {
                uploaded: 0,
                failed: errors.len(),
                errors,
                skipped,
                history_items,
            }
        }
    }
}

fn direct_upload_errors(
    items: &[(PersistedUploadItem, DirectUploadItem)],
    message: String,
) -> Vec<DirectUploadCompleteError> {
    items
        .iter()
        .map(|(item, _)| DirectUploadCompleteError {
            client_item_id: item.id.clone(),
            filename: item.filename.clone(),
            message: message.clone(),
        })
        .collect()
}

async fn prepare_direct_upload_item(
    item: PersistedUploadItem,
) -> std::result::Result<
    (PersistedUploadItem, DirectUploadItem),
    (PersistedUploadItem, anyhow::Error),
> {
    let path = item.upload_path();
    let bytes = match tokio::fs::read(path).await {
        Ok(value) => value,
        Err(error) => return Err((item, anyhow!("无法读取图片：{error}"))),
    };
    let image = match image::load_from_memory(&bytes) {
        Ok(value) => value,
        Err(error) => return Err((item, anyhow!("图片格式无效：{error}"))),
    };
    let (width, height) = image.dimensions();
    let sku = Path::new(&item.filename)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image")
        .to_string();
    let meta = DirectUploadItem {
        client_item_id: item.id.clone(),
        filename: item.filename.clone(),
        content_type: content_type_for_path(Path::new(&item.filename)).to_string(),
        size_bytes: bytes.len() as u64,
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        width,
        height,
        sku,
    };
    Ok((item, meta))
}

async fn upload_direct_item(
    client: &reqwest::Client,
    item: PersistedUploadItem,
    meta: DirectUploadItem,
    target: DirectUploadTarget,
) -> std::result::Result<DirectUploadItem, DirectUploadCompleteError> {
    let result = async {
        let bytes = tokio::fs::read(item.upload_path())
            .await
            .context("无法重新读取原图")?;
        let thumbnail = create_thumbnail(&bytes)?;
        upload_bytes_with_retry(
            client,
            &target.original_upload_url,
            bytes,
            &meta.content_type,
        )
        .await?;
        upload_bytes_with_retry(
            client,
            &target.thumbnail_upload_url,
            thumbnail,
            "image/webp",
        )
        .await?;
        Ok::<_, anyhow::Error>(())
    }
    .await;
    match result {
        Ok(()) => Ok(meta),
        Err(error) => Err(DirectUploadCompleteError {
            client_item_id: item.id,
            filename: item.filename,
            message: error.to_string(),
        }),
    }
}

fn create_thumbnail(bytes: &[u8]) -> Result<Vec<u8>> {
    let image = image::load_from_memory(bytes).context("无法生成缩略图")?;
    let thumbnail = image.resize(360, 360, FilterType::Triangle).to_rgba8();
    let mut output = Vec::new();
    WebPEncoder::new_lossless(&mut output).write_image(
        thumbnail.as_raw(),
        thumbnail.width(),
        thumbnail.height(),
        ExtendedColorType::Rgba8,
    )?;
    Ok(output)
}

async fn upload_bytes_with_retry(
    client: &reqwest::Client,
    url: &str,
    bytes: Vec<u8>,
    content_type: &str,
) -> Result<()> {
    let mut last_error = String::new();
    for (attempt, delay) in [1_u64, 2, 4].into_iter().enumerate() {
        match client
            .put(url)
            .header("Content-Type", content_type)
            .header("Cache-Control", "public, max-age=31536000, immutable")
            .body(bytes.clone())
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => return Ok(()),
            Ok(response) => {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                last_error = format!("OSS HTTP {status} {body}");
                if status.is_client_error()
                    && status != StatusCode::REQUEST_TIMEOUT
                    && status != StatusCode::TOO_MANY_REQUESTS
                {
                    break;
                }
            }
            Err(error) => last_error = error.to_string(),
        }
        if attempt < 2 {
            sleep(Duration::from_secs(delay)).await;
        }
    }
    Err(anyhow!("OSS 直传失败：{last_error}"))
}

fn apply_direct_upload_batch(
    db_path: &Path,
    job_id: &str,
    base_url: &str,
    account_key: &str,
    product_image_rule_id: &str,
    items: &[PersistedUploadItem],
    result: &DirectUploadCompleteResponse,
) -> Result<()> {
    let errors = result
        .errors
        .iter()
        .map(|error| (error.client_item_id.as_str(), error.message.as_str()))
        .collect::<HashMap<_, _>>();
    let conn = Connection::open(db_path).context("无法打开本地上传队列数据库")?;
    let now = Utc::now().to_rfc3339();
    for item in items {
        let error = errors.get(item.id.as_str()).copied();
        conn.execute(
            "UPDATE gallery_upload_items SET status = ?3, server_task_id = NULL, error = ?4, updated_at = ?5 WHERE job_id = ?1 AND id = ?2",
            params![job_id, item.id, if error.is_some() { "failed" } else { "succeeded" }, error, now],
        )?;
    }
    for item in &result.history_items {
        save_upload_history(
            &conn,
            base_url,
            account_key,
            product_image_rule_id,
            item,
            &now,
        )?;
    }
    Ok(())
}

async fn wait_server_upload_task(
    jobs: &JobRegistry,
    job_id: &str,
    client: &reqwest::Client,
    base_url: &str,
    token: &str,
    task_id: String,
    completed_before: usize,
    uploaded_before: usize,
    failed_before: usize,
    total: usize,
) -> Result<UploadTask> {
    let mut last_logged_processed = usize::MAX;
    loop {
        if jobs.is_cancelled(job_id) {
            return Err(anyhow!("用户已取消客户端后台上传任务"));
        }
        let response = client
            .get(format!("{base_url}/gallery/upload-tasks/{task_id}"))
            .bearer_auth(token)
            .send()
            .await
            .context("查询云端上传任务失败")?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(anyhow!("查询云端上传任务失败：HTTP {} {}", status, body));
        }
        let body = response
            .json::<UploadTaskResponse>()
            .await
            .context("云端上传任务进度响应格式不正确")?;
        let task = body.task;
        jobs.update(
            job_id,
            JobStatus::Running,
            progress(completed_before + task.processed, total),
            None,
        );
        jobs.update_counts(
            job_id,
            uploaded_before + task.uploaded,
            failed_before + task.failed,
        );
        let finished = matches!(task.status.as_str(), "succeeded" | "partial" | "failed");
        if task.processed != last_logged_processed || finished {
            last_logged_processed = task.processed;
        } else {
            sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
            continue;
        }
        if let Some(message) = task.message.as_deref().filter(|value| !value.is_empty()) {
            jobs.log(
                job_id,
                "info",
                &format!(
                    "云端处理进度：{}（{} / {}）",
                    message, task.processed, task.total_files
                ),
            );
        }
        if finished {
            return Ok(task);
        }
        sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
    }
}

fn chunk_upload_items(items: &[PersistedUploadItem]) -> Vec<Vec<PersistedUploadItem>> {
    let mut chunks = Vec::new();
    let mut current = Vec::new();
    for item in items {
        if !current.is_empty() && current.len() >= MAX_BATCH_UPLOAD_FILES {
            chunks.push(current);
            current = Vec::new();
        }
        current.push(item.clone());
    }

    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn selection_from_paths(files: Vec<PathBuf>) -> Result<GalleryUploadSelection> {
    let mut total_bytes = 0u64;
    let mut paths = Vec::with_capacity(files.len());
    let mut sample_names = Vec::new();

    for path in files {
        total_bytes =
            total_bytes.saturating_add(fs::metadata(&path).map(|item| item.len()).unwrap_or(0));
        if sample_names.len() < 12 {
            sample_names.push(
                path.file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_string(),
            );
        }
        paths.push(path.to_string_lossy().to_string());
    }

    Ok(GalleryUploadSelection {
        count: paths.len(),
        total_bytes,
        sample_names,
        paths,
    })
}

fn collect_images_in_dir(root: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(root).with_context(|| format!("无法读取目录：{}", root.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_images_in_dir(&path, files)?;
        } else if path.is_file() && is_supported_image_path(&path) {
            files.push(path);
        }
    }
    Ok(())
}

fn is_supported_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "webp"
            )
        })
        .unwrap_or(false)
}

fn content_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        _ => "image/jpeg",
    }
}

fn normalize_base_url(value: &str) -> Result<String> {
    let trimmed = value.trim().trim_end_matches('/');
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err(anyhow!("云服务地址不正确"));
    }
    Ok(trimmed.to_string())
}

fn is_permanent_upload_error(message: &str) -> bool {
    message.contains("请先登录")
        || message.contains("登录凭证")
        || message.contains("HTTP 401")
        || message.contains("HTTP 403")
        || message.contains("没有可处理文件")
        || message.contains("云服务地址不正确")
}

fn progress(done: usize, total: usize) -> u8 {
    (((done.min(total) as f64 / total.max(1) as f64) * 100.0).round() as u8).clamp(1, 99)
}

fn format_bytes(bytes: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / MB)
    } else if bytes >= 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{} B", bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageFormat, RgbaImage};
    use std::io::Cursor;

    #[test]
    fn direct_upload_batches_use_fifty_items() {
        let items = (0..101)
            .map(|index| PersistedUploadItem {
                id: index.to_string(),
                path: PathBuf::from(format!("{index}.png")),
                cache_path: None,
                filename: format!("{index}.png"),
                size_bytes: 1024,
            })
            .collect::<Vec<_>>();
        let batches = chunk_upload_items(&items);
        assert_eq!(
            batches.iter().map(Vec::len).collect::<Vec<_>>(),
            vec![50, 50, 1]
        );
    }

    #[test]
    fn upload_history_is_scoped_by_account_and_product_rule() {
        let db_path =
            std::env::temp_dir().join(format!("ozon-upload-history-{}.db", Uuid::new_v4()));
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE gallery_upload_history (cloud_api_base_url TEXT NOT NULL, cloud_account_key TEXT NOT NULL, product_image_rule_id TEXT NOT NULL, sha256 TEXT NOT NULL, sku TEXT NOT NULL, source_filename TEXT NOT NULL, uploaded_at TEXT NOT NULL, PRIMARY KEY (cloud_api_base_url, cloud_account_key, product_image_rule_id, sha256));",
        ).unwrap();
        let item = DirectUploadItem {
            client_item_id: "item-1".into(),
            filename: "SKU1.png".into(),
            content_type: "image/png".into(),
            size_bytes: 4,
            sha256: "a".repeat(64),
            width: 3,
            height: 4,
            sku: "SKU1".into(),
        };
        save_upload_history(
            &conn,
            "https://api.example.com",
            "user-a",
            "rule-a",
            &item,
            "now",
        )
        .unwrap();
        assert!(upload_history_contains(
            &db_path,
            "https://api.example.com",
            "user-a",
            "rule-a",
            &item.sha256
        )
        .unwrap());
        assert!(!upload_history_contains(
            &db_path,
            "https://api.example.com",
            "user-b",
            "rule-a",
            &item.sha256
        )
        .unwrap());
        assert!(!upload_history_contains(
            &db_path,
            "https://api.example.com",
            "user-a",
            "rule-b",
            &item.sha256
        )
        .unwrap());
        drop(conn);
        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn cloud_account_key_reads_stable_jwt_subject() {
        let payload =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"sub":"user-123"}"#);
        assert_eq!(
            cloud_account_key(&format!("header.{payload}.signature")),
            "user-123"
        );
    }

    #[test]
    fn creates_decodable_webp_thumbnail_with_bounded_dimensions() {
        let source = DynamicImage::ImageRgba8(RgbaImage::new(800, 400));
        let mut png = Cursor::new(Vec::new());
        source.write_to(&mut png, ImageFormat::Png).unwrap();
        let thumbnail = create_thumbnail(png.get_ref()).unwrap();
        let decoded = image::load_from_memory(&thumbnail).unwrap();
        assert_eq!(decoded.dimensions(), (360, 180));
    }
}
