use crate::core::jobs::JobRegistry;
use crate::core::models::{
    JobStatus, LocalMockupProgress, LocalMockupProgressItem, LocalMockupRenderItemResult,
    LocalMockupRenderRequest, LocalMockupRenderResult,
};
use anyhow::{anyhow, Context, Result};
use futures_util::{stream, StreamExt};
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::imageops::{self, FilterType};
use image::{ColorType, DynamicImage, GenericImageView, ImageEncoder, Rgba, RgbaImage};
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

const DEFAULT_CLOUD_API_BASE_URL: &str = "https://api.dyxtoolai.cn";
const CLIENT_RENDERER: &str = "tauri-rust-background";
const MAX_MOCKUP_WORKERS: usize = 4;
const MOCKUP_ASSET_BATCH_SIZE: usize = 20;
const MOCKUP_UPLOADS_PER_ASSET: usize = 3;
const MAX_GLOBAL_MOCKUP_UPLOADS: usize = 12;
const MOCKUP_JPEG_QUALITY: u8 = 85;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TemplatePackage {
    id: String,
    name: String,
    #[serde(default)]
    scene_count: usize,
    #[serde(default)]
    output_width: u32,
    #[serde(default)]
    output_height: u32,
    #[serde(default)]
    output_format: Option<String>,
    #[serde(default)]
    output_quality: Option<u8>,
    #[serde(default)]
    template_json: TemplateJson,
    #[serde(default)]
    asset_urls: HashMap<String, String>,
    #[serde(default)]
    version: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TemplateJson {
    #[serde(default)]
    output_width: u32,
    #[serde(default)]
    output_height: u32,
    #[serde(default)]
    output_format: Option<String>,
    #[serde(default)]
    output_quality: Option<u8>,
    #[serde(default)]
    source_size: Option<u32>,
    #[serde(default)]
    source_width: Option<u32>,
    #[serde(default)]
    source_height: Option<u32>,
    #[serde(default)]
    source_fit: Option<String>,
    #[serde(default)]
    linear_light_strength: Option<f32>,
    #[serde(default)]
    scenes: Vec<TemplateScene>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TemplateScene {
    id: String,
    index: usize,
    width: u32,
    height: u32,
    #[serde(default)]
    pixel_offset_x: Option<f32>,
    #[serde(default)]
    pixel_offset_y: Option<f32>,
    #[serde(default)]
    output_offset_x: Option<f32>,
    #[serde(default)]
    output_offset_y: Option<f32>,
    #[serde(default)]
    linear_light_strength: Option<f32>,
    #[serde(default)]
    layers: Vec<TemplateLayer>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TemplateLayer {
    order: i64,
    left: f32,
    top: f32,
    width: f32,
    height: f32,
    #[serde(default)]
    opacity: Option<f32>,
    #[serde(default)]
    blend_mode: Option<String>,
    #[serde(default)]
    blend_strength: Option<f32>,
    kind: String,
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    mask: Option<String>,
    #[serde(default)]
    clip_mask: Option<String>,
    #[serde(default)]
    clip_mask_left: Option<f32>,
    #[serde(default)]
    clip_mask_top: Option<f32>,
    #[serde(default)]
    clip_mask_width: Option<f32>,
    #[serde(default)]
    clip_mask_height: Option<f32>,
    #[serde(default)]
    transform: Option<Vec<f32>>,
    #[serde(default)]
    perspective_mesh: Option<PerspectiveMesh>,
    #[serde(default)]
    uv_map_x: Option<String>,
    #[serde(default)]
    uv_map_y: Option<String>,
    #[serde(default)]
    sample_mode: Option<String>,
    #[serde(default)]
    interpolation: Option<String>,
    #[serde(default)]
    pixel_offset_x: Option<f32>,
    #[serde(default)]
    pixel_offset_y: Option<f32>,
    #[serde(default)]
    source_crop: Option<SourceCrop>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PerspectiveMesh {
    vertices: Vec<Point>,
    warped_vertices: Vec<Point>,
    quads: Vec<Vec<usize>>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
struct Point {
    x: f32,
    y: f32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct SourceCrop {
    left: f32,
    top: f32,
    width: f32,
    height: f32,
}

#[derive(Debug, Clone, Copy)]
struct VisibleArea {
    left: u32,
    top: u32,
    width: u32,
    height: u32,
    crop_left: u32,
    crop_top: u32,
}

#[derive(Debug, Clone, Copy)]
struct Homography {
    a: f32,
    b: f32,
    c: f32,
    d: f32,
    e: f32,
    f: f32,
    g: f32,
    h: f32,
}

#[derive(Debug, Clone, Copy)]
struct InverseHomography {
    m00: f32,
    m01: f32,
    m02: f32,
    m10: f32,
    m11: f32,
    m12: f32,
    m20: f32,
    m21: f32,
    m22: f32,
}

#[derive(Debug, Clone)]
struct RenderedScene {
    index: usize,
    filename: String,
    content_type: String,
    bytes: Vec<u8>,
}

#[derive(Clone)]
struct Runtime {
    client: reqwest::Client,
    base_url: String,
    token: Option<String>,
    cache_root: PathBuf,
    bundled_template_root: Option<PathBuf>,
    upload_slots: Arc<tokio::sync::Semaphore>,
}

#[derive(Debug)]
struct MockupProgressState {
    total: usize,
    worker_count: usize,
    started: usize,
    completed: usize,
    failed: usize,
    running: Vec<LocalMockupProgressItem>,
    completed_asset_ids: Vec<String>,
    failed_items: Vec<LocalMockupProgressItem>,
}

impl MockupProgressState {
    fn snapshot(&self) -> LocalMockupProgress {
        LocalMockupProgress {
            total: self.total,
            worker_count: self.worker_count,
            started: self.started,
            completed: self.completed,
            failed: self.failed,
            queued: self.total.saturating_sub(self.started),
            active: self.running.len(),
            running: self.running.clone(),
            completed_asset_ids: self.completed_asset_ids.clone(),
            failed_items: self.failed_items.clone(),
        }
    }
}

pub async fn run_local_mockup_render(
    jobs: JobRegistry,
    job_id: String,
    request: LocalMockupRenderRequest,
    cache_root: PathBuf,
    bundled_template_root: Option<PathBuf>,
) {
    jobs.log(
        &job_id,
        "info",
        "Local mockup job is queued; only one local mockup job runs at a time.",
    );
    let permit = match local_mockup_queue().clone().acquire_owned().await {
        Ok(permit) => permit,
        Err(_) => {
            let message = "Local mockup queue is unavailable".to_string();
            jobs.log(&job_id, "error", &message);
            jobs.fail(&job_id, message);
            return;
        }
    };
    if jobs.is_cancelled(&job_id) {
        jobs.log(
            &job_id,
            "warn",
            "Local mockup job was cancelled before it started.",
        );
        jobs.update(&job_id, JobStatus::Cancelled, 0, None);
        drop(permit);
        return;
    }
    jobs.log(&job_id, "info", "Local mockup job acquired the queue slot.");
    if let Err(error) = run_inner(&jobs, &job_id, request, cache_root, bundled_template_root).await
    {
        jobs.log(&job_id, "error", &error.to_string());
        jobs.fail(&job_id, error.to_string());
    }
    drop(permit);
}

fn local_mockup_queue() -> &'static Arc<tokio::sync::Semaphore> {
    static QUEUE: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    QUEUE.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1)))
}

async fn run_inner(
    jobs: &JobRegistry,
    job_id: &str,
    request: LocalMockupRenderRequest,
    cache_root: PathBuf,
    bundled_template_root: Option<PathBuf>,
) -> Result<()> {
    validate_request(&request)?;
    fs::create_dir_all(&cache_root)
        .context("闂佸搫鍟版慨鐢垫兜閸洖绀嗘繛鎴烆焽缁憋箓鏌￠崼顐㈠婵犫偓閹绢喖鍐€闂佸灝顑嗙花姘辩磽閸屾稒灏柣掳鍔戦幆鍕敊閼测晝协")?;
    jobs.update(job_id, JobStatus::Running, 1, None);
    jobs.log(
        job_id,
        "info",
        &format!(
            "Local mockup job started: {} assets, template {}",
            request.assets.len(),
            request
                .template_name
                .as_deref()
                .unwrap_or(request.template_id.as_str())
        ),
    );

    let runtime = Runtime {
        client: reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(180))
            .build()
            .context("Failed to initialize local HTTP client")?,
        base_url: request
            .cloud_api_base_url
            .clone()
            .unwrap_or_else(|| DEFAULT_CLOUD_API_BASE_URL.to_string())
            .trim_end_matches('/')
            .to_string(),
        token: request
            .cloud_auth_token
            .clone()
            .filter(|value| !value.trim().is_empty()),
        cache_root,
        bundled_template_root,
        upload_slots: Arc::new(tokio::sync::Semaphore::new(MAX_GLOBAL_MOCKUP_UPLOADS)),
    };
    let template = Arc::new(load_template_package(&runtime, &request.template_id).await?);
    warm_template_assets(&runtime, &template).await?;
    let worker_count = effective_worker_count(request.max_workers, request.assets.len());
    jobs.log(
        job_id,
        "info",
        &format!(
            "Local mockup worker pool started: fixed concurrency {worker_count}; batch size {MOCKUP_ASSET_BATCH_SIZE}; completed items immediately start the next queued item."
        ),
    );

    let total = request.assets.len();
    let progress_state = Arc::new(Mutex::new(MockupProgressState {
        total,
        worker_count,
        started: 0,
        completed: 0,
        failed: 0,
        running: Vec::new(),
        completed_asset_ids: Vec::new(),
        failed_items: Vec::new(),
    }));
    write_progress(
        &runtime.cache_root,
        job_id,
        &progress_state
            .lock()
            .expect("mockup progress poisoned")
            .snapshot(),
    )?;
    let mut items = Vec::with_capacity(total);
    let mut success_count = 0usize;
    let mut failed_count = 0usize;
    let mut generated = 0usize;
    let mut done = 0usize;
    let total_batches = mockup_batch_count(total);
    for (batch_index, batch) in request.assets.chunks(MOCKUP_ASSET_BATCH_SIZE).enumerate() {
        if jobs.is_cancelled(job_id) {
            jobs.log(
                job_id,
                "warn",
                "Local mockup job was cancelled before the next batch started.",
            );
            jobs.update(
                job_id,
                JobStatus::Cancelled,
                ((done * 96) / total.max(1)) as u8,
                None,
            );
            return Ok(());
        }
        jobs.log(
            job_id,
            "info",
            &format!(
                "Local mockup batch {}/{} started: {} assets.",
                batch_index + 1,
                total_batches,
                batch.len(),
            ),
        );
        let mut stream = stream::iter(batch.iter().cloned().map(|asset| {
            let runtime = runtime.clone();
            let template = template.clone();
            let jobs = jobs.clone();
            let job_id = job_id.to_string();
            let cache_root = runtime.cache_root.clone();
            let progress_state = progress_state.clone();
            async move {
                let source_asset_id = asset.id.clone();
                let source_sku = asset.sku.clone();
                let start_snapshot = {
                    let mut state = progress_state.lock().expect("mockup progress poisoned");
                    state.started += 1;
                    state.running.push(LocalMockupProgressItem {
                        source_asset_id: source_asset_id.clone(),
                        source_sku: source_sku.clone(),
                        error: None,
                    });
                    state.snapshot()
                };
                if let Err(error) = write_progress(&cache_root, &job_id, &start_snapshot) {
                    jobs.log(
                        &job_id,
                        "warn",
                        &format!("Failed to write mockup progress: {error}"),
                    );
                }
                jobs.log(
                    &job_id,
                    "info",
                    &format!(
                        "Mockup started: {}; active {}/{}; assigned {}/{}; queued {}.",
                        source_sku,
                        start_snapshot.active,
                        start_snapshot.worker_count,
                        start_snapshot.started,
                        start_snapshot.total,
                        start_snapshot.queued,
                    ),
                );
                match process_asset(&runtime, template, &asset).await {
                    Ok((assets, download_ms, render_ms, upload_ms)) => {
                        jobs.log(
                            &job_id,
                            "info",
                            &format!(
                                "Mockup timing: {}; download={}ms; render={}ms; upload={}ms; total={}ms.",
                                source_sku,
                                download_ms,
                                render_ms,
                                upload_ms,
                                download_ms + render_ms + upload_ms,
                            ),
                        );
                        LocalMockupRenderItemResult {
                            source_asset_id,
                            source_sku,
                            ok: true,
                            assets,
                            error: None,
                        }
                    }
                    Err(error) => LocalMockupRenderItemResult {
                        source_asset_id,
                        source_sku,
                        ok: false,
                        assets: Vec::new(),
                        error: Some(error.to_string()),
                    },
                }
            }
        }))
        .buffer_unordered(worker_count.min(batch.len().max(1)));

        while let Some(item) = stream.next().await {
            done += 1;
            let progress = ((done * 96) / total.max(1)).clamp(1, 96) as u8;
            if item.ok {
                success_count += 1;
                generated += item.assets.len();
                jobs.log(
                    job_id,
                    "info",
                    &format!(
                        "{} mockup complete: {} images ({done}/{total}).",
                        item.source_sku,
                        item.assets.len()
                    ),
                );
            } else {
                failed_count += 1;
                jobs.log(
                    job_id,
                    "error",
                    &format!(
                        "{} mockup failed: {}",
                        item.source_sku,
                        item.error.as_deref().unwrap_or("Unknown error")
                    ),
                );
            }
            let completion_snapshot = {
                let mut state = progress_state.lock().expect("mockup progress poisoned");
                state
                    .running
                    .retain(|entry| entry.source_asset_id != item.source_asset_id);
                state.completed += 1;
                if item.ok {
                    state.completed_asset_ids.push(item.source_asset_id.clone());
                } else {
                    state.failed += 1;
                    state.failed_items.push(LocalMockupProgressItem {
                        source_asset_id: item.source_asset_id.clone(),
                        source_sku: item.source_sku.clone(),
                        error: item.error.clone(),
                    });
                }
                state.snapshot()
            };
            write_progress(&runtime.cache_root, job_id, &completion_snapshot)?;
            jobs.log(
                job_id,
                "info",
                &format!(
                    "Mockup finished: {}; active {}/{}; completed {}/{}; queued {}.",
                    item.source_sku,
                    completion_snapshot.active,
                    completion_snapshot.worker_count,
                    completion_snapshot.completed,
                    completion_snapshot.total,
                    completion_snapshot.queued,
                ),
            );
            jobs.update_counts(job_id, success_count, failed_count);
            jobs.update(job_id, JobStatus::Running, progress, None);
            items.push(item);
        }
    }

    let result = LocalMockupRenderResult {
        ok: failed_count == 0,
        template_id: template.id.clone(),
        template_name: template.name.clone(),
        generated,
        success_count,
        failed_count,
        items,
    };
    let result_path = write_result(&runtime.cache_root, job_id, &result)?;
    if success_count == 0 && failed_count > 0 {
        anyhow::bail!("All local mockup items failed; see task logs.");
    }
    jobs.complete_with_result(
        job_id,
        Some(result_path.to_string_lossy().to_string()),
        success_count,
        failed_count,
    );
    Ok(())
}

async fn process_asset(
    runtime: &Runtime,
    template: Arc<TemplatePackage>,
    asset: &crate::core::models::LocalMockupRenderAssetInput,
) -> Result<(Vec<Value>, u128, u128, u128)> {
    let download_started = std::time::Instant::now();
    let source_bytes = download_source_asset(runtime, asset).await?;
    let download_ms = download_started.elapsed().as_millis();
    let template_for_render = template.clone();
    let sku = asset.sku.clone();
    let render_started = std::time::Instant::now();
    let rendered = tokio::task::spawn_blocking(move || {
        render_template_scenes(&template_for_render, &source_bytes, &sku)
    })
    .await
    .context("Local mockup render worker failed")??;

    let render_ms = render_started.elapsed().as_millis();

    let template_id = template.id.clone();
    let source_asset_id = asset.id.clone();
    let upload_started = std::time::Instant::now();
    let mut uploads = stream::iter(rendered.into_iter().map(|scene| {
        let template_id = template_id.clone();
        let source_asset_id = source_asset_id.clone();
        async move {
            let index = scene.index;
            let value =
                upload_rendered_scene(runtime, &template_id, &source_asset_id, scene).await?;
            Ok::<_, anyhow::Error>((index, value))
        }
    }))
    .buffer_unordered(MOCKUP_UPLOADS_PER_ASSET);
    let mut uploaded = Vec::new();
    while let Some(result) = uploads.next().await {
        uploaded.push(result?);
    }
    uploaded.sort_by_key(|(index, _)| *index);
    let upload_ms = upload_started.elapsed().as_millis();
    Ok((
        uploaded.into_iter().map(|(_, value)| value).collect(),
        download_ms,
        render_ms,
        upload_ms,
    ))
}

async fn load_template_package(runtime: &Runtime, template_id: &str) -> Result<TemplatePackage> {
    let cache_dir = runtime
        .cache_root
        .join("templates")
        .join(safe_path_segment(template_id));
    fs::create_dir_all(&cache_dir)?;
    let package_path = cache_dir.join("template-package.json");
    let cached = fs::read_to_string(&package_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<TemplatePackage>(&raw).ok());
    if let Some(package) = cached.as_ref() {
        if template_assets_are_cached(runtime, package) {
            return Ok(package.clone());
        }
    }
    if let Some(package) = load_bundled_template_package(runtime, template_id)? {
        return Ok(package);
    }
    if let Some(package) = cached {
        return Ok(package);
    }
    download_template_package(runtime, template_id, &package_path).await
}

fn template_assets_are_cached(runtime: &Runtime, template: &TemplatePackage) -> bool {
    let cache_dir = runtime
        .cache_root
        .join("templates")
        .join(safe_path_segment(&template.id))
        .join("assets")
        .join(template_version_segment(template));
    !template.asset_urls.is_empty()
        && template.asset_urls.keys().all(|file| {
            fs::metadata(cache_dir.join(safe_relative_path(file)))
                .map(|metadata| metadata.is_file() && metadata.len() > 0)
                .unwrap_or(false)
        })
}

fn load_bundled_template_package(
    runtime: &Runtime,
    template_id: &str,
) -> Result<Option<TemplatePackage>> {
    let Some(root) = runtime.bundled_template_root.as_ref() else {
        return Ok(None);
    };
    let template_root = root.join(safe_path_segment(template_id));
    let template_path = template_root.join("template.json");
    if !template_path.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&template_path)
        .with_context(|| format!("Bundled template definition is unavailable: {template_id}"))?;
    let template_json: TemplateJson = serde_json::from_str(&raw)
        .with_context(|| format!("Bundled template definition is invalid: {template_id}"))?;
    let metadata: Value = serde_json::from_str(&raw)?;
    let mut asset_urls = HashMap::new();
    collect_bundled_template_assets(&template_root, &template_root, &mut asset_urls)?;
    let version = format!("bundled-{:x}", Sha256::digest(raw.as_bytes()));
    Ok(Some(TemplatePackage {
        id: template_id.to_string(),
        name: metadata
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(template_id)
            .to_string(),
        scene_count: template_json.scenes.len(),
        output_width: template_json.output_width,
        output_height: template_json.output_height,
        output_format: template_json.output_format.clone(),
        output_quality: template_json.output_quality,
        template_json,
        asset_urls,
        version,
    }))
}

fn collect_bundled_template_assets(
    root: &Path,
    current: &Path,
    assets: &mut HashMap<String, String>,
) -> Result<()> {
    for entry in fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_bundled_template_assets(root, &path, assets)?;
            continue;
        }
        if path.file_name().and_then(|value| value.to_str()) == Some("template.json") {
            continue;
        }
        let relative = path
            .strip_prefix(root)?
            .to_string_lossy()
            .replace('\\', "/");
        assets.insert(relative, format!("bundled://{}", path.to_string_lossy()));
    }
    Ok(())
}

async fn download_template_package(
    runtime: &Runtime,
    template_id: &str,
    package_path: &Path,
) -> Result<TemplatePackage> {
    let url = format!(
        "{}/mockups/{}/package",
        runtime.base_url,
        url_encode(template_id)
    );
    let mut request = runtime.client.get(url);
    if let Some(token) = &runtime.token {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .context("Template package download failed")?;
    if !response.status().is_success() {
        anyhow::bail!(
            "Template package download failed: HTTP {}",
            response.status()
        );
    }
    let body = response
        .json::<Value>()
        .await
        .context("Template package parsing failed")?;
    let package = serde_json::from_value::<TemplatePackage>(
        body.get("template")
            .cloned()
            .ok_or_else(|| anyhow!("Template package response is missing template"))?,
    )
    .context("Template package structure is invalid")?;
    fs::write(package_path, serde_json::to_vec(&package)?)?;
    Ok(package)
}
async fn download_source_asset(
    runtime: &Runtime,
    asset: &crate::core::models::LocalMockupRenderAssetInput,
) -> Result<Vec<u8>> {
    let asset_id = asset.id.as_str();
    let cache_dir = runtime.cache_root.join("source-assets");
    fs::create_dir_all(&cache_dir)?;
    let path = cache_dir.join(format!("{}.img", safe_path_segment(asset_id)));
    if let Ok(bytes) = fs::read(&path) {
        if !bytes.is_empty() {
            return Ok(bytes);
        }
    }
    let url = asset
        .public_url
        .as_deref()
        .map(str::trim)
        .filter(|value| value.starts_with("http://") || value.starts_with("https://"))
        .map(str::to_string)
        .unwrap_or_else(|| {
            format!(
                "{}/gallery/assets/{}/original",
                runtime.base_url,
                url_encode(asset_id)
            )
        });
    let mut last_error = None;
    for (attempt, delay_seconds) in [1_u64, 2, 4].into_iter().enumerate() {
        let mut request = runtime.client.get(&url);
        if url.starts_with(&runtime.base_url) {
            if let Some(token) = &runtime.token {
                request = request.bearer_auth(token);
            }
        }
        match request.send().await {
            Ok(response) if response.status().is_success() => {
                let bytes = response
                    .bytes()
                    .await
                    .with_context(|| format!("商品原图读取失败：{asset_id}"))?
                    .to_vec();
                fs::write(&path, &bytes)?;
                return Ok(bytes);
            }
            Ok(response) => {
                last_error = Some(format!("HTTP {}", response.status()));
                if !response.status().is_server_error() && response.status().as_u16() != 429 {
                    break;
                }
            }
            Err(error) => last_error = Some(error.to_string()),
        }
        if attempt < 2 {
            tokio::time::sleep(std::time::Duration::from_secs(delay_seconds)).await;
        }
    }
    anyhow::bail!(
        "商品原图下载失败：{}（{}）",
        asset_id,
        last_error.unwrap_or_else(|| "未知错误".to_string())
    )
}

pub fn remove_source_asset_cache(cache_root: &Path, asset_id: &str) -> Result<bool> {
    let path = cache_root
        .join("source-assets")
        .join(format!("{}.img", safe_path_segment(asset_id)));
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).context("无法清理已上架商品的本地原图缓存"),
    }
}
async fn load_template_asset(
    runtime: &Runtime,
    template: &TemplatePackage,
    file: &str,
) -> Result<Vec<u8>> {
    let cache_dir = runtime
        .cache_root
        .join("templates")
        .join(safe_path_segment(&template.id))
        .join("assets")
        .join(template_version_segment(template));
    let path = cache_dir.join(safe_relative_path(file));
    if let Ok(bytes) = fs::read(&path) {
        if !bytes.is_empty() {
            return Ok(bytes);
        }
    }
    if let Some(bundled_path) = template
        .asset_urls
        .get(file)
        .and_then(|value| value.strip_prefix("bundled://"))
    {
        return fs::read(bundled_path)
            .with_context(|| format!("Bundled template resource is unavailable: {file}"));
    }
    let url = template
        .asset_urls
        .get(file)
        .ok_or_else(|| anyhow!("Template resource missing: {file}"))?;
    let resolved_url = if url.starts_with("http://") || url.starts_with("https://") {
        url.to_string()
    } else {
        format!("{}/{}", runtime.base_url, url.trim_start_matches('/'))
    };
    let mut request = runtime.client.get(resolved_url);
    if let Some(token) = &runtime.token {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .context("Template asset download failed")?;
    if !response.status().is_success() {
        anyhow::bail!("Template asset download failed: HTTP {}", response.status());
    }
    let bytes = response.bytes().await?.to_vec();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, &bytes)?;
    Ok(bytes)
}

fn render_template_scenes(
    template: &TemplatePackage,
    source_bytes: &[u8],
    sku: &str,
) -> Result<Vec<RenderedScene>> {
    if template.template_json.scenes.is_empty() {
        anyhow::bail!("Template has no renderable scenes.");
    }
    let source = image::load_from_memory(source_bytes).context("Source image decode failed")?;
    let prepared = prepare_source_image(&source, &template.template_json);
    let mut scenes = template.template_json.scenes.clone();
    scenes.sort_by_key(|scene| scene.index);
    let mut rendered = Vec::with_capacity(scenes.len());
    for scene in &scenes {
        let image = render_scene(template, scene, &prepared)?;
        let encoded = encode_scene_image(template, &image)?;
        rendered.push(RenderedScene {
            index: scene.index,
            filename: format!(
                "{}-{}-{:02}.{}",
                sku, template.id, scene.index, encoded.extension
            ),
            content_type: encoded.content_type,
            bytes: encoded.bytes,
        });
    }
    Ok(rendered)
}

fn render_scene(
    template: &TemplatePackage,
    scene: &TemplateScene,
    source: &RgbaImage,
) -> Result<RgbaImage> {
    let mut canvas = RgbaImage::from_pixel(
        scene.width.max(1),
        scene.height.max(1),
        Rgba([255, 255, 255, 255]),
    );
    let mut layers = scene.layers.clone();
    layers.sort_by_key(|layer| layer.order);
    for layer in &layers {
        let Some((mut layer_image, left, top)) = render_layer(template, scene, layer, source)?
        else {
            continue;
        };
        apply_opacity(&mut layer_image, layer.opacity.unwrap_or(1.0));
        let blend_mode = normalize_blend_mode(layer.blend_mode.as_deref());
        if blend_mode == "linear_light" {
            composite_linear_light(
                &mut canvas,
                &layer_image,
                left,
                top,
                resolve_linear_light_strength(layer, scene, &template.template_json),
            );
        } else {
            composite_blend(&mut canvas, &layer_image, left, top, blend_mode);
        }
    }
    Ok(apply_scene_output_offset(&canvas, scene))
}

fn apply_scene_output_offset(image: &RgbaImage, scene: &TemplateScene) -> RgbaImage {
    let offset_x = scene.output_offset_x.unwrap_or(0.0).round() as i32;
    let offset_y = scene.output_offset_y.unwrap_or(0.0).round() as i32;
    if offset_x == 0 && offset_y == 0 {
        return image.clone();
    }
    let mut output =
        RgbaImage::from_pixel(image.width(), image.height(), Rgba([255, 255, 255, 255]));
    for y in 0..image.height() {
        let source_y = y as i32 - offset_y;
        if source_y < 0 || source_y >= image.height() as i32 {
            continue;
        }
        for x in 0..image.width() {
            let source_x = x as i32 - offset_x;
            if source_x < 0 || source_x >= image.width() as i32 {
                continue;
            }
            output.put_pixel(x, y, *image.get_pixel(source_x as u32, source_y as u32));
        }
    }
    output
}

fn render_layer(
    template: &TemplatePackage,
    scene: &TemplateScene,
    layer: &TemplateLayer,
    source: &RgbaImage,
) -> Result<Option<(RgbaImage, i32, i32)>> {
    let Some(visible) = get_visible_area(layer, scene) else {
        return Ok(None);
    };
    if layer.kind == "replace" {
        if layer.uv_map_x.is_some() || layer.uv_map_y.is_some() {
            anyhow::bail!(
                "This template uses UV mapping, which is not supported by the local renderer."
            );
        }
        let full_scene = layer
            .transform
            .as_ref()
            .is_some_and(|values| values.len() == 8 && !is_axis_aligned_transform(values))
            || layer.perspective_mesh.is_some();
        let mut canvas = if full_scene {
            render_perspective_replacement(scene, layer, source)?
        } else {
            render_flat_replacement(layer, source, visible)
        };
        canvas = apply_layer_masks(template, scene, layer, canvas, visible, full_scene)?;
        return Ok(Some((
            canvas,
            if full_scene { 0 } else { visible.left as i32 },
            if full_scene { 0 } else { visible.top as i32 },
        )));
    }
    let Some(file) = layer.file.as_deref() else {
        return Ok(None);
    };
    let image = load_template_image_blocking(template, file)?;
    let resized = resize_exact(
        &DynamicImage::ImageRgba8(image),
        layer_width(layer),
        layer_height(layer),
    );
    let cropped = crop_rgba(
        &resized,
        visible.crop_left,
        visible.crop_top,
        visible.width,
        visible.height,
    );
    Ok(Some((cropped, visible.left as i32, visible.top as i32)))
}

fn load_template_image_blocking(template: &TemplatePackage, file: &str) -> Result<RgbaImage> {
    if let Some(bundled_path) = template
        .asset_urls
        .get(file)
        .and_then(|value| value.strip_prefix("bundled://"))
    {
        return Ok(image::open(bundled_path)
            .with_context(|| format!("Bundled template image is unavailable: {file}"))?
            .to_rgba8());
    }
    let base = std::env::temp_dir()
        .join("ozon-sjsq-local-mockup-runtime")
        .join(safe_path_segment(&template.id));
    let marker = base.join(safe_relative_path(file));
    if let Ok(bytes) = fs::read(&marker) {
        return Ok(image::load_from_memory(&bytes)?.to_rgba8());
    }
    anyhow::bail!("Template asset is not warmed: {file}");
}

fn render_flat_replacement(
    layer: &TemplateLayer,
    source: &RgbaImage,
    visible: VisibleArea,
) -> RgbaImage {
    let full_source = crop_source_for_layer(source, layer);
    let full = resize_exact(
        &DynamicImage::ImageRgba8(full_source),
        layer_width(layer),
        layer_height(layer),
    );
    crop_rgba(
        &full,
        visible.crop_left,
        visible.crop_top,
        visible.width,
        visible.height,
    )
}

fn render_perspective_replacement(
    scene: &TemplateScene,
    layer: &TemplateLayer,
    source: &RgbaImage,
) -> Result<RgbaImage> {
    let source_canvas = crop_source_for_layer(source, layer);
    let interpolation = layer.interpolation.as_deref().unwrap_or("bilinear");
    let pixel_offset_x = layer
        .pixel_offset_x
        .or(scene.pixel_offset_x)
        .unwrap_or(-0.1875);
    let pixel_offset_y = layer
        .pixel_offset_y
        .or(scene.pixel_offset_y)
        .unwrap_or(-0.5);
    let mut output =
        RgbaImage::from_pixel(scene.width.max(1), scene.height.max(1), Rgba([0, 0, 0, 0]));
    if let Some(mesh) = &layer.perspective_mesh {
        for quad in &mesh.quads {
            if quad.len() != 4
                || quad.iter().any(|index| {
                    *index >= mesh.vertices.len() || *index >= mesh.warped_vertices.len()
                })
            {
                continue;
            }
            let source_target = [
                mesh.vertices[quad[0]],
                mesh.vertices[quad[1]],
                mesh.vertices[quad[2]],
                mesh.vertices[quad[3]],
            ];
            let warped_target = [
                mesh.warped_vertices[quad[0]],
                mesh.warped_vertices[quad[1]],
                mesh.warped_vertices[quad[2]],
                mesh.warped_vertices[quad[3]],
            ];
            render_perspective_quad(
                &mut output,
                &source_canvas,
                source_target,
                warped_target,
                layer.sample_mode.as_deref().unwrap_or("edge"),
                interpolation,
                pixel_offset_x,
                pixel_offset_y,
            );
        }
        return Ok(output);
    }
    let Some(values) = layer.transform.as_ref().filter(|values| values.len() == 8) else {
        anyhow::bail!("Template perspective parameters are missing");
    };
    render_perspective_quad(
        &mut output,
        &source_canvas,
        [
            Point { x: 0.0, y: 0.0 },
            Point { x: 1.0, y: 0.0 },
            Point { x: 1.0, y: 1.0 },
            Point { x: 0.0, y: 1.0 },
        ],
        transform_to_points(values),
        layer.sample_mode.as_deref().unwrap_or("edge"),
        interpolation,
        pixel_offset_x,
        pixel_offset_y,
    );
    Ok(output)
}

fn apply_layer_masks(
    template: &TemplatePackage,
    scene: &TemplateScene,
    layer: &TemplateLayer,
    canvas: RgbaImage,
    visible: VisibleArea,
    full_scene_layer: bool,
) -> Result<RgbaImage> {
    let mut output = canvas;
    if let Some(mask) = layer.mask.as_deref() {
        let mask_image = load_template_image_blocking(template, mask)?;
        let mask_canvas = if full_scene_layer {
            build_mask_on_scene(&mask_image, scene, layer, true)
        } else {
            build_cropped_mask(&mask_image, layer, visible, "red")
        };
        multiply_alpha_by_mask(&mut output, &mask_canvas, "red");
    }
    if let Some(mask) = layer.clip_mask.as_deref() {
        let clip_image = load_template_image_blocking(template, mask)?;
        let clip_canvas = if full_scene_layer {
            build_clip_mask_on_scene(&clip_image, scene, layer)
        } else {
            build_clip_mask_for_visible_layer(&clip_image, visible, layer)
        };
        multiply_alpha_by_mask(&mut output, &clip_canvas, "red");
    }
    Ok(output)
}

async fn upload_rendered_scene(
    runtime: &Runtime,
    template_id: &str,
    source_asset_id: &str,
    scene: RenderedScene,
) -> Result<Value> {
    let _upload_permit = runtime
        .upload_slots
        .acquire()
        .await
        .context("Unable to acquire a local mockup upload slot")?;
    let part = Part::bytes(scene.bytes)
        .file_name(scene.filename.clone())
        .mime_str(&scene.content_type)?;
    let form = Form::new()
        .text("sceneIndex", scene.index.to_string())
        .text("filename", scene.filename)
        .text("clientRenderer", CLIENT_RENDERER)
        .part("file", part);
    let url = format!(
        "{}/mockups/{}/assets/{}/local-result",
        runtime.base_url,
        url_encode(template_id),
        url_encode(source_asset_id)
    );
    let mut request = runtime.client.post(url).multipart(form);
    if let Some(token) = &runtime.token {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.context("Local mockup upload failed")?;
    let status = response.status();
    let body = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        anyhow::bail!(
            "闂佸搫鐗滈崜娆忥耿鐎涙闄勬俊銈傚亾婵炲瓨蓱缁嬪绻濇担铏瑰€炴繝銏″劶缁墽鎲撮敃鍌涙櫖婵炲棛鐫扵P {} {}",
            status,
            body.get("message").and_then(Value::as_str).unwrap_or("")
        );
    }
    body.get("asset").cloned().ok_or_else(|| {
        anyhow!("闂佸搫鐗滈崜娆忥耿鐎涙闄勬俊銈傚亾婵炲瓨蓱缁嬪绻濇担铏瑰€為梺鍛婄箓缁夊鑺遍懠顒傜＝闁告繂瀚В?asset")
    })
}

fn prepare_source_image(source: &DynamicImage, template: &TemplateJson) -> RgbaImage {
    let width = template
        .source_width
        .or(template.source_size)
        .unwrap_or(1024)
        .clamp(256, 4096);
    let height = template
        .source_height
        .or(template.source_size)
        .unwrap_or(1024)
        .clamp(256, 4096);
    if template.source_fit.as_deref() == Some("fill") {
        return resize_exact(source, width, height);
    }
    cover_resize(source, width, height)
}

fn cover_resize(image: &DynamicImage, width: u32, height: u32) -> RgbaImage {
    let (source_width, source_height) = image.dimensions();
    let scale = (width as f32 / source_width.max(1) as f32)
        .max(height as f32 / source_height.max(1) as f32);
    let resized_width = ((source_width as f32 * scale).round() as u32).max(width);
    let resized_height = ((source_height as f32 * scale).round() as u32).max(height);
    let resized = image
        .resize_exact(resized_width, resized_height, FilterType::Triangle)
        .to_rgba8();
    let left = (resized_width - width) / 2;
    let top = (resized_height - height) / 2;
    crop_rgba(&resized, left, top, width, height)
}

fn resize_exact(image: &DynamicImage, width: u32, height: u32) -> RgbaImage {
    image
        .resize_exact(width.max(1), height.max(1), FilterType::Triangle)
        .to_rgba8()
}

fn crop_rgba(image: &RgbaImage, left: u32, top: u32, width: u32, height: u32) -> RgbaImage {
    imageops::crop_imm(
        image,
        left.min(image.width().saturating_sub(1)),
        top.min(image.height().saturating_sub(1)),
        width.min(image.width().saturating_sub(left)).max(1),
        height.min(image.height().saturating_sub(top)).max(1),
    )
    .to_image()
}

fn crop_source_for_layer(source: &RgbaImage, layer: &TemplateLayer) -> RgbaImage {
    let crop = normalize_source_crop(layer.source_crop, source.width(), source.height());
    crop_rgba(source, crop.0, crop.1, crop.2, crop.3)
}

fn normalize_source_crop(
    crop: Option<SourceCrop>,
    width: u32,
    height: u32,
) -> (u32, u32, u32, u32) {
    let Some(crop) = crop else {
        return (0, 0, width.max(1), height.max(1));
    };
    let left = clamp_i32(crop.left.round() as i32, 0, width.saturating_sub(1) as i32) as u32;
    let top = clamp_i32(crop.top.round() as i32, 0, height.saturating_sub(1) as i32) as u32;
    let right = clamp_i32(
        (crop.left + crop.width).round() as i32,
        left as i32 + 1,
        width as i32,
    ) as u32;
    let bottom = clamp_i32(
        (crop.top + crop.height).round() as i32,
        top as i32 + 1,
        height as i32,
    ) as u32;
    (left, top, right - left, bottom - top)
}

fn get_visible_area(layer: &TemplateLayer, scene: &TemplateScene) -> Option<VisibleArea> {
    let layer_left = layer.left.round() as i32;
    let layer_top = layer.top.round() as i32;
    let layer_width = layer_width(layer) as i32;
    let layer_height = layer_height(layer) as i32;
    let left = layer_left.max(0);
    let top = layer_top.max(0);
    let right = (layer_left + layer_width).min(scene.width as i32);
    let bottom = (layer_top + layer_height).min(scene.height as i32);
    let width = right - left;
    let height = bottom - top;
    if width <= 0 || height <= 0 {
        return None;
    }
    Some(VisibleArea {
        left: left as u32,
        top: top as u32,
        width: width as u32,
        height: height as u32,
        crop_left: (left - layer_left).max(0) as u32,
        crop_top: (top - layer_top).max(0) as u32,
    })
}

fn build_mask_on_scene(
    image: &RgbaImage,
    scene: &TemplateScene,
    layer: &TemplateLayer,
    use_red: bool,
) -> RgbaImage {
    let resized = resize_exact(
        &DynamicImage::ImageRgba8(image.clone()),
        layer_width(layer),
        layer_height(layer),
    );
    let mut mask =
        RgbaImage::from_pixel(scene.width.max(1), scene.height.max(1), Rgba([0, 0, 0, 0]));
    imageops::overlay(
        &mut mask,
        &resized,
        layer.left.round() as i64,
        layer.top.round() as i64,
    );
    channel_to_alpha_mask(mask, if use_red { "red" } else { "alpha" })
}

fn build_cropped_mask(
    image: &RgbaImage,
    layer: &TemplateLayer,
    visible: VisibleArea,
    channel: &str,
) -> RgbaImage {
    let resized = resize_exact(
        &DynamicImage::ImageRgba8(image.clone()),
        layer_width(layer),
        layer_height(layer),
    );
    let cropped = crop_rgba(
        &resized,
        visible.crop_left,
        visible.crop_top,
        visible.width,
        visible.height,
    );
    channel_to_alpha_mask(cropped, channel)
}

fn build_clip_mask_on_scene(
    image: &RgbaImage,
    scene: &TemplateScene,
    layer: &TemplateLayer,
) -> RgbaImage {
    let width = layer
        .clip_mask_width
        .unwrap_or(layer.width)
        .round()
        .max(1.0) as u32;
    let height = layer
        .clip_mask_height
        .unwrap_or(layer.height)
        .round()
        .max(1.0) as u32;
    let resized = resize_exact(&DynamicImage::ImageRgba8(image.clone()), width, height);
    let mut mask =
        RgbaImage::from_pixel(scene.width.max(1), scene.height.max(1), Rgba([0, 0, 0, 0]));
    imageops::overlay(
        &mut mask,
        &resized,
        layer.clip_mask_left.unwrap_or(layer.left).round() as i64,
        layer.clip_mask_top.unwrap_or(layer.top).round() as i64,
    );
    channel_to_alpha_mask(mask, "alpha")
}

fn build_clip_mask_for_visible_layer(
    image: &RgbaImage,
    visible: VisibleArea,
    layer: &TemplateLayer,
) -> RgbaImage {
    let width = layer
        .clip_mask_width
        .unwrap_or(layer.width)
        .round()
        .max(1.0) as u32;
    let height = layer
        .clip_mask_height
        .unwrap_or(layer.height)
        .round()
        .max(1.0) as u32;
    let resized = resize_exact(&DynamicImage::ImageRgba8(image.clone()), width, height);
    let mut full =
        RgbaImage::from_pixel(layer_width(layer), layer_height(layer), Rgba([0, 0, 0, 0]));
    let left = (layer.clip_mask_left.unwrap_or(layer.left) - layer.left).round() as i64;
    let top = (layer.clip_mask_top.unwrap_or(layer.top) - layer.top).round() as i64;
    imageops::overlay(&mut full, &resized, left, top);
    channel_to_alpha_mask(
        crop_rgba(
            &full,
            visible.crop_left,
            visible.crop_top,
            visible.width,
            visible.height,
        ),
        "alpha",
    )
}

fn channel_to_alpha_mask(mut image: RgbaImage, channel: &str) -> RgbaImage {
    for pixel in image.pixels_mut() {
        let value = if channel == "red" { pixel[0] } else { pixel[3] };
        *pixel = Rgba([value, value, value, 255]);
    }
    image
}

fn multiply_alpha_by_mask(layer: &mut RgbaImage, mask: &RgbaImage, channel: &str) {
    let mask = if mask.width() == layer.width() && mask.height() == layer.height() {
        mask.clone()
    } else {
        resize_exact(
            &DynamicImage::ImageRgba8(mask.clone()),
            layer.width(),
            layer.height(),
        )
    };
    for (pixel, mask_pixel) in layer.pixels_mut().zip(mask.pixels()) {
        let mask_value = if channel == "red" {
            mask_pixel[0]
        } else {
            mask_pixel[3]
        } as u16;
        pixel[3] = ((pixel[3] as u16 * mask_value) / 255) as u8;
    }
}

fn apply_opacity(image: &mut RgbaImage, opacity: f32) {
    let normalized = opacity.clamp(0.0, 1.0);
    if normalized >= 0.999 {
        return;
    }
    for pixel in image.pixels_mut() {
        pixel[3] = ((pixel[3] as f32 * normalized).round()).clamp(0.0, 255.0) as u8;
    }
}

fn composite_blend(base: &mut RgbaImage, layer: &RgbaImage, left: i32, top: i32, blend_mode: &str) {
    let start_x = left.max(0) as u32;
    let start_y = top.max(0) as u32;
    let end_x = (left + layer.width() as i32)
        .min(base.width() as i32)
        .max(0) as u32;
    let end_y = (top + layer.height() as i32)
        .min(base.height() as i32)
        .max(0) as u32;
    for y in start_y..end_y {
        for x in start_x..end_x {
            let lx = (x as i32 - left) as u32;
            let ly = (y as i32 - top) as u32;
            let src = layer.get_pixel(lx, ly);
            let alpha = src[3] as f32 / 255.0;
            if alpha <= 0.0 {
                continue;
            }
            let dst = base.get_pixel_mut(x, y);
            for channel in 0..3 {
                let blended = blend_channel(dst[channel], src[channel], blend_mode);
                dst[channel] =
                    (blended as f32 * alpha + dst[channel] as f32 * (1.0 - alpha)).round() as u8;
            }
            dst[3] = 255;
        }
    }
}

fn blend_channel(dst: u8, src: u8, blend_mode: &str) -> u8 {
    let d = dst as u16;
    let s = src as u16;
    match blend_mode {
        "multiply" => ((d * s + 127) / 255) as u8,
        "screen" => (255 - (((255 - d) * (255 - s) + 127) / 255)) as u8,
        "overlay" => {
            if d < 128 {
                ((2 * d * s + 127) / 255) as u8
            } else {
                (255 - ((2 * (255 - d) * (255 - s) + 127) / 255)) as u8
            }
        }
        "darken" => dst.min(src),
        "lighten" => dst.max(src),
        _ => src,
    }
}

fn composite_linear_light(
    base: &mut RgbaImage,
    layer: &RgbaImage,
    left: i32,
    top: i32,
    strength: f32,
) {
    let start_x = left.max(0) as u32;
    let start_y = top.max(0) as u32;
    let end_x = (left + layer.width() as i32)
        .min(base.width() as i32)
        .max(0) as u32;
    let end_y = (top + layer.height() as i32)
        .min(base.height() as i32)
        .max(0) as u32;
    for y in start_y..end_y {
        for x in start_x..end_x {
            let lx = (x as i32 - left) as u32;
            let ly = (y as i32 - top) as u32;
            let src = layer.get_pixel(lx, ly);
            let alpha = src[3] as f32 / 255.0;
            if alpha <= 0.0 {
                continue;
            }
            let dst = base.get_pixel_mut(x, y);
            for channel in 0..3 {
                let blended = (dst[channel] as f32
                    + (2.0 * src[channel] as f32 - 255.0) * strength)
                    .clamp(0.0, 255.0);
                dst[channel] =
                    (blended * alpha + dst[channel] as f32 * (1.0 - alpha)).round() as u8;
            }
            dst[3] = 255;
        }
    }
}

fn render_perspective_quad(
    output: &mut RgbaImage,
    source: &RgbaImage,
    source_target: [Point; 4],
    warped_target: [Point; 4],
    sample_mode: &str,
    interpolation: &str,
    pixel_offset_x: f32,
    pixel_offset_y: f32,
) {
    let source_homography = homography_from_unit_square(source_target);
    let warped_homography = homography_from_unit_square(warped_target);
    let Some(inverse) = invert_homography(warped_homography) else {
        return;
    };
    let (left, top, right, bottom) = target_bounds(warped_target, output.width(), output.height());
    for y in top..bottom {
        for x in left..right {
            let Some(uv) = map_target_to_unit(inverse, x as f32 + 0.5, y as f32 + 0.5) else {
                continue;
            };
            if uv.x < -0.001 || uv.x > 1.001 || uv.y < -0.001 || uv.y > 1.001 {
                continue;
            }
            let source_unit = map_unit_to_target(source_homography, uv.x, uv.y);
            let sx = map_coordinate_to_source_pixel(source_unit.x, source.width(), sample_mode);
            let sy = map_coordinate_to_source_pixel(source_unit.y, source.height(), sample_mode);
            let pixel = sample_image(
                source,
                sx + pixel_offset_x,
                sy + pixel_offset_y,
                interpolation,
            );
            output.put_pixel(x, y, pixel);
        }
    }
}

fn homography_from_unit_square(points: [Point; 4]) -> Homography {
    let [top_left, top_right, bottom_right, bottom_left] = points;
    let dx1 = top_right.x - bottom_right.x;
    let dy1 = top_right.y - bottom_right.y;
    let dx2 = bottom_left.x - bottom_right.x;
    let dy2 = bottom_left.y - bottom_right.y;
    let dx3 = top_left.x - top_right.x + bottom_right.x - bottom_left.x;
    let dy3 = top_left.y - top_right.y + bottom_right.y - bottom_left.y;
    let denominator = dx1 * dy2 - dx2 * dy1;
    if denominator.abs() < 0.000001 {
        return Homography {
            a: top_right.x - top_left.x,
            b: bottom_left.x - top_left.x,
            c: top_left.x,
            d: top_right.y - top_left.y,
            e: bottom_left.y - top_left.y,
            f: top_left.y,
            g: 0.0,
            h: 0.0,
        };
    }
    let g = (dx3 * dy2 - dx2 * dy3) / denominator;
    let h = (dx1 * dy3 - dx3 * dy1) / denominator;
    Homography {
        a: top_right.x - top_left.x + g * top_right.x,
        b: bottom_left.x - top_left.x + h * bottom_left.x,
        c: top_left.x,
        d: top_right.y - top_left.y + g * top_right.y,
        e: bottom_left.y - top_left.y + h * bottom_left.y,
        f: top_left.y,
        g,
        h,
    }
}

fn invert_homography(matrix: Homography) -> Option<InverseHomography> {
    let m00 = matrix.a;
    let m01 = matrix.b;
    let m02 = matrix.c;
    let m10 = matrix.d;
    let m11 = matrix.e;
    let m12 = matrix.f;
    let m20 = matrix.g;
    let m21 = matrix.h;
    let m22 = 1.0;
    let determinant = m00 * (m11 * m22 - m12 * m21) - m01 * (m10 * m22 - m12 * m20)
        + m02 * (m10 * m21 - m11 * m20);
    if determinant.abs() < 0.000001 {
        return None;
    }
    let inv = 1.0 / determinant;
    Some(InverseHomography {
        m00: (m11 * m22 - m12 * m21) * inv,
        m01: (m02 * m21 - m01 * m22) * inv,
        m02: (m01 * m12 - m02 * m11) * inv,
        m10: (m12 * m20 - m10 * m22) * inv,
        m11: (m00 * m22 - m02 * m20) * inv,
        m12: (m02 * m10 - m00 * m12) * inv,
        m20: (m10 * m21 - m11 * m20) * inv,
        m21: (m01 * m20 - m00 * m21) * inv,
        m22: (m00 * m11 - m01 * m10) * inv,
    })
}

fn map_target_to_unit(inverse: InverseHomography, x: f32, y: f32) -> Option<Point> {
    let denominator = inverse.m20 * x + inverse.m21 * y + inverse.m22;
    if denominator.abs() < 0.000001 {
        return None;
    }
    Some(Point {
        x: (inverse.m00 * x + inverse.m01 * y + inverse.m02) / denominator,
        y: (inverse.m10 * x + inverse.m11 * y + inverse.m12) / denominator,
    })
}

fn map_unit_to_target(homography: Homography, u: f32, v: f32) -> Point {
    let denominator = homography.g * u + homography.h * v + 1.0;
    if denominator.abs() < 0.000001 {
        return Point { x: 0.0, y: 0.0 };
    }
    Point {
        x: (homography.a * u + homography.b * v + homography.c) / denominator,
        y: (homography.d * u + homography.e * v + homography.f) / denominator,
    }
}

fn target_bounds(points: [Point; 4], width: u32, height: u32) -> (u32, u32, u32, u32) {
    let min_x = points
        .iter()
        .map(|point| point.x)
        .fold(f32::INFINITY, f32::min)
        .floor()
        .max(0.0) as u32;
    let min_y = points
        .iter()
        .map(|point| point.y)
        .fold(f32::INFINITY, f32::min)
        .floor()
        .max(0.0) as u32;
    let max_x = points
        .iter()
        .map(|point| point.x)
        .fold(f32::NEG_INFINITY, f32::max)
        .ceil()
        .min(width as f32) as u32;
    let max_y = points
        .iter()
        .map(|point| point.y)
        .fold(f32::NEG_INFINITY, f32::max)
        .ceil()
        .min(height as f32) as u32;
    (
        min_x.min(width),
        min_y.min(height),
        max_x.min(width),
        max_y.min(height),
    )
}

fn map_coordinate_to_source_pixel(value: f32, size: u32, sample_mode: &str) -> f32 {
    if sample_mode == "center" {
        return (value * size as f32 - 0.5).clamp(0.0, size.saturating_sub(1) as f32);
    }
    (value * size.saturating_sub(1) as f32).clamp(0.0, size.saturating_sub(1) as f32)
}

fn sample_image(image: &RgbaImage, x: f32, y: f32, interpolation: &str) -> Rgba<u8> {
    let x = x.clamp(0.0, image.width().saturating_sub(1) as f32);
    let y = y.clamp(0.0, image.height().saturating_sub(1) as f32);
    match interpolation {
        "nearest" => *image.get_pixel(x.round() as u32, y.round() as u32),
        "bicubic" => sample_cubic(image, x, y, -0.5),
        "bicubic-ps" => sample_cubic(image, x, y, -0.75),
        "bicubic-soft" => sample_cubic(image, x, y, -0.25),
        _ => sample_bilinear(image, x, y),
    }
}

fn sample_bilinear(image: &RgbaImage, x: f32, y: f32) -> Rgba<u8> {
    let x0 = x.floor().max(0.0) as u32;
    let y0 = y.floor().max(0.0) as u32;
    let x1 = (x0 + 1).min(image.width().saturating_sub(1));
    let y1 = (y0 + 1).min(image.height().saturating_sub(1));
    let tx = x - x0 as f32;
    let ty = y - y0 as f32;
    let p00 = image.get_pixel(x0, y0);
    let p10 = image.get_pixel(x1, y0);
    let p01 = image.get_pixel(x0, y1);
    let p11 = image.get_pixel(x1, y1);
    let mut out = [0u8; 4];
    for channel in 0..4 {
        let top = p00[channel] as f32 * (1.0 - tx) + p10[channel] as f32 * tx;
        let bottom = p01[channel] as f32 * (1.0 - tx) + p11[channel] as f32 * tx;
        out[channel] = (top * (1.0 - ty) + bottom * ty).round().clamp(0.0, 255.0) as u8;
    }
    Rgba(out)
}

fn sample_cubic(image: &RgbaImage, x: f32, y: f32, a: f32) -> Rgba<u8> {
    let base_x = x.floor() as i32;
    let base_y = y.floor() as i32;
    let tx = x - base_x as f32;
    let ty = y - base_y as f32;
    let mut out = [0.0f32; 4];

    for m in -1..=2 {
        let sample_y = clamp_i32(base_y + m, 0, image.height().saturating_sub(1) as i32) as u32;
        let weight_y = cubic_weight(m as f32 - ty, a);
        for n in -1..=2 {
            let sample_x = clamp_i32(base_x + n, 0, image.width().saturating_sub(1) as i32) as u32;
            let weight = cubic_weight(n as f32 - tx, a) * weight_y;
            let pixel = image.get_pixel(sample_x, sample_y);
            for channel in 0..4 {
                out[channel] += pixel[channel] as f32 * weight;
            }
        }
    }

    Rgba([
        out[0].round().clamp(0.0, 255.0) as u8,
        out[1].round().clamp(0.0, 255.0) as u8,
        out[2].round().clamp(0.0, 255.0) as u8,
        out[3].round().clamp(0.0, 255.0) as u8,
    ])
}

fn cubic_weight(value: f32, a: f32) -> f32 {
    let x = value.abs();
    if x <= 1.0 {
        return (a + 2.0) * x.powi(3) - (a + 3.0) * x.powi(2) + 1.0;
    }
    if x < 2.0 {
        return a * x.powi(3) - 5.0 * a * x.powi(2) + 8.0 * a * x - 4.0 * a;
    }
    0.0
}

fn transform_to_points(values: &[f32]) -> [Point; 4] {
    [
        Point {
            x: values[0],
            y: values[1],
        },
        Point {
            x: values[2],
            y: values[3],
        },
        Point {
            x: values[4],
            y: values[5],
        },
        Point {
            x: values[6],
            y: values[7],
        },
    ]
}

fn is_axis_aligned_transform(values: &[f32]) -> bool {
    if values.len() != 8 {
        return true;
    }
    let tolerance = 0.8;
    (values[1] - values[3]).abs() <= tolerance
        && (values[2] - values[4]).abs() <= tolerance
        && (values[5] - values[7]).abs() <= tolerance
        && (values[6] - values[0]).abs() <= tolerance
}

fn normalize_blend_mode(value: Option<&str>) -> &str {
    match value.unwrap_or("normal") {
        "linear_light" => "linear_light",
        "multiply" => "multiply",
        "screen" => "screen",
        "overlay" => "overlay",
        "darken" => "darken",
        "lighten" => "lighten",
        _ => "normal",
    }
}

fn resolve_linear_light_strength(
    layer: &TemplateLayer,
    scene: &TemplateScene,
    template: &TemplateJson,
) -> f32 {
    layer
        .blend_strength
        .or(scene.linear_light_strength)
        .or(template.linear_light_strength)
        .unwrap_or(1.0)
}

fn layer_width(layer: &TemplateLayer) -> u32 {
    layer.width.round().max(1.0) as u32
}

fn layer_height(layer: &TemplateLayer) -> u32 {
    layer.height.round().max(1.0) as u32
}

struct EncodedSceneImage {
    bytes: Vec<u8>,
    extension: &'static str,
    content_type: String,
}

fn encode_scene_image(template: &TemplatePackage, image: &RgbaImage) -> Result<EncodedSceneImage> {
    let format = template
        .template_json
        .output_format
        .as_deref()
        .or(template.output_format.as_deref())
        .unwrap_or("jpeg")
        .to_ascii_lowercase();
    if format == "png" {
        return Ok(EncodedSceneImage {
            bytes: encode_png(image)?,
            extension: "png",
            content_type: "image/png".to_string(),
        });
    }
    Ok(EncodedSceneImage {
        bytes: encode_jpeg(template, image)?,
        extension: "jpg",
        content_type: "image/jpeg".to_string(),
    })
}

fn encode_png(image: &RgbaImage) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    PngEncoder::new(&mut bytes).write_image(
        image.as_raw(),
        image.width(),
        image.height(),
        ColorType::Rgba8.into(),
    )?;
    Ok(bytes)
}

fn encode_jpeg(template: &TemplatePackage, image: &RgbaImage) -> Result<Vec<u8>> {
    let quality = template
        .template_json
        .output_quality
        .or(template.output_quality)
        .unwrap_or(MOCKUP_JPEG_QUALITY)
        .clamp(1, 100);
    let rgb = DynamicImage::ImageRgba8(image.clone()).to_rgb8();
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, quality).write_image(
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        ColorType::Rgb8.into(),
    )?;
    Ok(bytes)
}

fn write_result(
    cache_root: &Path,
    job_id: &str,
    result: &LocalMockupRenderResult,
) -> Result<PathBuf> {
    let dir = cache_root.join("jobs");
    fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.json", safe_path_segment(job_id)));
    fs::write(&path, serde_json::to_vec_pretty(result)?)?;
    Ok(path)
}

pub fn read_result(path: &Path) -> Result<LocalMockupRenderResult> {
    let raw = fs::read_to_string(path).context("Local mockup result is unavailable")?;
    serde_json::from_str(&raw).context("Local mockup result parsing failed")
}

async fn warm_template_assets(runtime: &Runtime, template: &TemplatePackage) -> Result<()> {
    let temp_dir = std::env::temp_dir()
        .join("ozon-sjsq-local-mockup-runtime")
        .join(safe_path_segment(&template.id));
    for file in template.asset_urls.keys() {
        if template
            .asset_urls
            .get(file)
            .is_some_and(|value| value.starts_with("bundled://"))
        {
            continue;
        }
        let bytes = load_template_asset(runtime, template, file).await?;
        let path = temp_dir.join(safe_relative_path(file));
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, bytes)?;
    }
    Ok(())
}
fn validate_request(request: &LocalMockupRenderRequest) -> Result<()> {
    if request.template_id.trim().is_empty() {
        anyhow::bail!("Template id is required");
    }
    if request.assets.is_empty() {
        anyhow::bail!("At least one asset is required");
    }
    Ok(())
}

fn effective_worker_count(requested: Option<usize>, asset_count: usize) -> usize {
    requested
        .unwrap_or(MAX_MOCKUP_WORKERS)
        .clamp(1, MAX_MOCKUP_WORKERS)
        .min(asset_count.max(1))
}

fn mockup_batch_count(asset_count: usize) -> usize {
    asset_count.saturating_add(MOCKUP_ASSET_BATCH_SIZE - 1) / MOCKUP_ASSET_BATCH_SIZE
}

fn progress_path(cache_root: &Path, job_id: &str) -> PathBuf {
    cache_root
        .join("jobs")
        .join(format!("{}.progress.json", safe_path_segment(job_id)))
}

fn write_progress(cache_root: &Path, job_id: &str, progress: &LocalMockupProgress) -> Result<()> {
    let path = progress_path(cache_root, job_id);
    let parent = path
        .parent()
        .context("Local mockup progress directory is unavailable")?;
    fs::create_dir_all(parent)?;
    fs::write(path, serde_json::to_vec(progress)?)?;
    Ok(())
}

pub fn read_progress(cache_root: &Path, job_id: &str) -> Result<LocalMockupProgress> {
    let path = progress_path(cache_root, job_id);
    let raw = fs::read_to_string(path).context("Local mockup progress is unavailable")?;
    serde_json::from_str(&raw).context("Local mockup progress parsing failed")
}

#[cfg(test)]
mod tests {
    use super::{
        effective_worker_count, load_bundled_template_package, mockup_batch_count,
        template_assets_are_cached, Runtime, TemplateJson, TemplatePackage, MAX_MOCKUP_WORKERS,
    };
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Arc;

    fn test_runtime(cache_root: PathBuf, bundled_template_root: Option<PathBuf>) -> Runtime {
        Runtime {
            client: reqwest::Client::new(),
            base_url: "http://127.0.0.1:1".to_string(),
            token: None,
            cache_root,
            bundled_template_root,
            upload_slots: Arc::new(tokio::sync::Semaphore::new(1)),
        }
    }

    fn unique_temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ozon-sjsq-{name}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn caps_workers_at_four_and_never_exceeds_asset_count() {
        assert_eq!(effective_worker_count(Some(10), 97), MAX_MOCKUP_WORKERS);
        assert_eq!(effective_worker_count(Some(20), 97), MAX_MOCKUP_WORKERS);
        assert_eq!(effective_worker_count(Some(10), 3), 3);
    }

    #[test]
    fn splits_mockup_assets_into_twenty_item_batches() {
        assert_eq!(mockup_batch_count(0), 0);
        assert_eq!(mockup_batch_count(1), 1);
        assert_eq!(mockup_batch_count(20), 1);
        assert_eq!(mockup_batch_count(21), 2);
        assert_eq!(mockup_batch_count(100), 5);
    }

    #[test]
    fn loads_every_bundled_template_from_packaged_source() {
        let bundled_root =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/mockup-templates");
        let runtime = test_runtime(unique_temp_dir("bundled-cache"), Some(bundled_root));

        for template_id in ["fangjin", "ganfamao", "huazhuangbao", "shukoudai", "zhuobu"] {
            let package = load_bundled_template_package(&runtime, template_id)
                .expect("bundled template should parse")
                .expect("bundled template should exist");
            assert_eq!(package.id, template_id);
            assert!(!package.template_json.scenes.is_empty());
            assert!(!package.asset_urls.is_empty());
            assert!(package
                .asset_urls
                .values()
                .all(|value| value.starts_with("bundled://")));
        }
    }

    #[test]
    fn accepts_cached_package_only_when_all_assets_are_complete() {
        let cache_root = unique_temp_dir("template-cache");
        let runtime = test_runtime(cache_root.clone(), None);
        let mut asset_urls = HashMap::new();
        asset_urls.insert(
            "scene/background.png".to_string(),
            "/asset/background".to_string(),
        );
        asset_urls.insert("scene/mask.png".to_string(), "/asset/mask".to_string());
        let package = TemplatePackage {
            id: "fangjin".to_string(),
            name: "fangjin".to_string(),
            scene_count: 0,
            output_width: 0,
            output_height: 0,
            output_format: None,
            output_quality: None,
            template_json: TemplateJson::default(),
            asset_urls,
            version: "v1".to_string(),
        };
        let asset_root = cache_root.join("templates/fangjin/assets/v1/scene");
        fs::create_dir_all(&asset_root).unwrap();
        fs::write(asset_root.join("background_png"), b"ready").unwrap();
        assert!(!template_assets_are_cached(&runtime, &package));

        fs::write(asset_root.join("mask_png"), b"ready").unwrap();
        assert!(template_assets_are_cached(&runtime, &package));
        let _ = fs::remove_dir_all(cache_root);
    }
}

fn safe_path_segment(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn template_version_segment(template: &TemplatePackage) -> String {
    let value = template.version.trim();
    if value.is_empty() {
        return "latest".to_string();
    }
    safe_path_segment(value)
}

fn safe_relative_path(value: &str) -> PathBuf {
    let mut path = PathBuf::new();
    for part in value.replace('\\', "/").split('/') {
        if part.is_empty() || part == "." || part == ".." {
            continue;
        }
        path.push(safe_path_segment(part));
    }
    path
}

fn url_encode(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

fn clamp_i32(value: i32, min: i32, max: i32) -> i32 {
    value.max(min).min(max)
}
