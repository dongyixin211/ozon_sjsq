use crate::core::ai::{
    is_missing_chat_content_error, is_ollama_provider, is_pixel_provider, CopyPayload,
    OpenAiCompatibleClient, TitlePayload,
};
use crate::core::business::list_sku_images;
use crate::core::excel::{self, ContentRow};
use crate::core::jobs::JobRegistry;
use crate::core::models::{JobStatus, LocalSceneRequest, MaterialsRequest};
use crate::core::secrets;
use anyhow::{Context, Result};
use image::codecs::png::{CompressionType, FilterType as PngFilterType, PngEncoder};
use image::imageops::{self, FilterType};
use image::{
    DynamicImage, ExtendedColorType, GenericImageView, ImageBuffer, ImageEncoder, Rgba, RgbaImage,
};
use rayon::prelude::*;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::task::JoinSet;

const DEFAULT_PORTRAIT_SIZE: (u32, u32) = (1200, 1600);
const TITLE_CONCURRENCY_LIMIT: usize = 5;
const OLLAMA_TITLE_CONCURRENCY_LIMIT: usize = 8;
const PIXEL_TITLE_CONCURRENCY_LIMIT: usize = 20;
const TITLE_RETRY_LIMIT: usize = 3;
const OLLAMA_TITLE_RETRY_LIMIT: usize = 2;
const PIXEL_TITLE_RETRY_LIMIT: usize = 3;
const TITLE_RETRY_BASE_DELAY_MS: u64 = 800;
const PIXEL_VISION_FALLBACK_MODEL: &str = "gpt-5.4-mini";
const PIXEL_VISION_FALLBACK_RETRY_LIMIT: usize = 2;

pub async fn run_materials_job(jobs: JobRegistry, job_id: String, request: MaterialsRequest) {
    if let Err(error) = materials_inner(&jobs, &job_id, request).await {
        let message = error_chain(&error);
        jobs.log(&job_id, "error", &message);
        jobs.fail(&job_id, message);
    }
}

pub async fn run_local_scene_job(jobs: JobRegistry, job_id: String, request: LocalSceneRequest) {
    if let Err(error) = local_scene_inner(&jobs, &job_id, request).await {
        let message = error_chain(&error);
        jobs.log(&job_id, "error", &message);
        jobs.fail(&job_id, message);
    }
}

async fn materials_inner(
    jobs: &JobRegistry,
    job_id: &str,
    request: MaterialsRequest,
) -> Result<()> {
    jobs.update(job_id, JobStatus::Running, 1, None);
    let source_root = PathBuf::from(&request.source_root);
    let portrait_root = PathBuf::from(&request.portrait_root);
    if !source_root.is_dir() {
        anyhow::bail!("源目录不存在: {}", source_root.display());
    }
    if (request.convert_originals || request.generate_ai_images)
        && portrait_root.as_os_str().is_empty()
    {
        anyhow::bail!("3:4 输出目录不能为空");
    }
    let mut items = collect_sku_images(&source_root)?;
    if let Some(max_items) = request.max_items.filter(|value| *value > 0) {
        items.truncate(max_items as usize);
    }
    if items.is_empty() {
        anyhow::bail!("源目录下没有可处理图片");
    }
    jobs.log(job_id, "info", &format!("发现 {} 张图片", items.len()));

    let watermark = request
        .watermark_path
        .as_ref()
        .map(PathBuf::from)
        .filter(|path| path.is_file());
    let watermark_image = watermark
        .as_deref()
        .map(|path| load_watermark(path, DEFAULT_PORTRAIT_SIZE))
        .transpose()?
        .map(Arc::new);
    let image_client = if request.generate_ai_images {
        let key = secrets::get_secret(&secrets::provider_api_key_id(
            "image",
            &request.image_provider,
        ))
        .context("未找到图片 provider API Key，请先在设置中保存")?;
        Some(OpenAiCompatibleClient::new(&request.image_base_url, key)?)
    } else {
        None
    };
    let text_client = if request.generate_copy {
        let key =
            text_provider_key(&request).context("未找到文案 provider API Key，请先在设置中保存")?;
        Some(OpenAiCompatibleClient::new(&request.text_base_url, key)?)
    } else {
        None
    };
    let mut converted_success = 0usize;
    let mut converted_failed = 0usize;
    let title_excel_only =
        request.generate_copy && request.description_prompt_template.trim().is_empty();
    if request.convert_originals {
        let (success, failed) = convert_originals_batch(
            jobs,
            job_id,
            &items,
            &portrait_root,
            watermark_image.clone(),
        )
        .await?;
        converted_success = success;
        converted_failed = failed;
        if converted_success == 0 && converted_failed > 0 {
            anyhow::bail!("所有图片都处理失败，请检查源图片是否损坏或为空文件");
        }
        if image_client.is_none() && text_client.is_none() && !request.generate_copy {
            jobs.complete_with_result(
                job_id,
                Some(request.portrait_root),
                converted_success,
                converted_failed,
            );
            return Ok(());
        }
    }

    if title_excel_only {
        let client = text_client
            .as_ref()
            .context("未初始化文案 provider，无法生成标题")?;
        let Some(title_rows) =
            generate_title_rows_batch(jobs, job_id, client, &request, &items).await?
        else {
            return Ok(());
        };
        let result_path = write_title_excel(request.content_root.as_deref(), &title_rows)?;
        jobs.log(
            job_id,
            "info",
            &format!("标题 Excel 已生成: {}", result_path.display()),
        );
        jobs.complete_with_output(job_id, Some(result_path.display().to_string()));
        return Ok(());
    }

    for (index, (sku, image_path)) in items.iter().enumerate() {
        if jobs.is_cancelled(job_id) {
            jobs.log(job_id, "warn", "素材生成已取消");
            return Ok(());
        }
        if let Some(client) = &image_client {
            let output = portrait_root.join(sku).join(format!(
                "{}_ai_vertical.png",
                image_path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or("image")
            ));
            let prompt =
                render_prompt(&request.image_prompt_template, sku, &[image_path.as_path()]);
            client
                .generate_image_from_reference(
                    &request.image_model,
                    &prompt,
                    Some(image_path),
                    &output,
                )
                .await?;
            jobs.log(
                job_id,
                "info",
                &format!("已生成 AI 图片: {}", output.display()),
            );
        }
        if let Some(client) = &text_client {
            let title_sku = image_file_stem(image_path);
            let title_prompt = render_prompt(
                &request.title_prompt_template,
                &title_sku,
                &[image_path.as_path()],
            );
            let title = client
                .generate_title_from_images(
                    &request.text_model,
                    &title_prompt,
                    &[image_path.as_path()],
                )
                .await
                .with_context(|| format!("AI 标题生成失败: {title_sku}"))?;
            let mut copy = if request.description_prompt_template.trim().is_empty() {
                CopyPayload {
                    title,
                    description: String::new(),
                    bullets: Vec::new(),
                }
            } else {
                let description_prompt = render_prompt(
                    &request.description_prompt_template,
                    &title_sku,
                    &[image_path.as_path()],
                );
                let mut copy = client
                    .generate_copy(&request.text_model, &description_prompt)
                    .await?;
                if copy.title.trim().is_empty() {
                    copy.title = title;
                }
                copy
            };
            if copy.title.trim().is_empty() {
                copy.title = title_sku.clone();
            }
            write_copy_files(request.content_root.as_deref(), &title_sku, &copy)?;
            jobs.log(job_id, "info", &format!("已生成文案: {title_sku}"));
        } else if request.generate_copy {
            write_copy_stub(request.content_root.as_deref(), sku)?;
        }
        let progress = (((index + 1) * 100) / items.len()).clamp(1, 99) as u8;
        jobs.update(job_id, JobStatus::Running, progress, None);
    }
    if request.convert_originals {
        jobs.complete_with_result(
            job_id,
            Some(request.portrait_root),
            converted_success,
            converted_failed,
        );
    } else {
        let output_path = request
            .content_root
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                (!request.portrait_root.trim().is_empty()).then_some(request.portrait_root)
            });
        jobs.complete_with_output(job_id, output_path);
    }
    Ok(())
}

async fn convert_originals_batch(
    jobs: &JobRegistry,
    job_id: &str,
    items: &[(String, PathBuf)],
    portrait_root: &Path,
    watermark: Option<Arc<RgbaImage>>,
) -> Result<(usize, usize)> {
    let jobs = jobs.clone();
    let job_id = job_id.to_string();
    let items = items.to_vec();
    let portrait_root = portrait_root.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let total = items.len().max(1);
        let processed = AtomicUsize::new(0);
        let success = AtomicUsize::new(0);
        let failed = AtomicUsize::new(0);
        jobs.log(
            &job_id,
            "info",
            &format!("开始并发生成 3:4 图片，共 {} 张", items.len()),
        );
        items.par_iter().for_each(|(sku, image_path)| {
            if jobs.is_cancelled(&job_id) {
                return;
            }
            let output = portrait_root.join(sku).join(format!(
                "{}_3x4.png",
                image_path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or("image")
            ));
            match create_portrait_variant_with_watermark(
                image_path,
                &output,
                DEFAULT_PORTRAIT_SIZE,
                watermark.as_deref(),
            ) {
                Ok(()) => {
                    success.fetch_add(1, Ordering::Relaxed);
                }
                Err(error) => {
                    failed.fetch_add(1, Ordering::Relaxed);
                    jobs.log(
                        &job_id,
                        "error",
                        &format!("跳过无法处理的图片 {}：{error}", image_path.display()),
                    );
                }
            }
            let done = processed.fetch_add(1, Ordering::Relaxed) + 1;
            if done == 1 || done == total || done.is_multiple_of(50) {
                let progress = ((done * 95) / total).clamp(1, 95) as u8;
                jobs.update(&job_id, JobStatus::Running, progress, None);
                jobs.log(&job_id, "info", &format!("已生成 3:4 图片 {done}/{total}"));
            }
        });
        if jobs.is_cancelled(&job_id) {
            jobs.log(&job_id, "warn", "素材生成已取消");
        } else {
            jobs.log(
                &job_id,
                "info",
                &format!(
                    "3:4 图片批量生成完成，成功 {} 张，失败 {} 张",
                    success.load(Ordering::Relaxed),
                    failed.load(Ordering::Relaxed)
                ),
            );
        }
        Ok((
            success.load(Ordering::Relaxed),
            failed.load(Ordering::Relaxed),
        ))
    })
    .await
    .context("3:4 图片生成线程失败")?
}

async fn generate_title_rows_batch(
    jobs: &JobRegistry,
    job_id: &str,
    client: &OpenAiCompatibleClient,
    request: &MaterialsRequest,
    items: &[(String, PathBuf)],
) -> Result<Option<Vec<ContentRow>>> {
    let total = items.len().max(1);
    let mut processed = 0usize;
    let mut success_count = 0usize;
    let mut failed_count = 0usize;
    let mut rows = vec![None; items.len()];
    let concurrency_limit = title_concurrency_limit(request).min(items.len().max(1));
    let retry_limit = title_retry_limit(request);
    jobs.log(
        job_id,
        "info",
        &format!(
            "开始并发生成标题，共 {} 张图片，最多 {} 个并发",
            items.len(),
            concurrency_limit
        ),
    );

    let mut next_index = 0usize;
    let mut pending = JoinSet::new();

    while next_index < items.len() && pending.len() < concurrency_limit {
        spawn_title_task(
            &mut pending,
            next_index,
            client,
            request,
            &items[next_index].1,
            retry_limit,
        );
        next_index += 1;
    }

    while let Some(joined) = pending.join_next().await {
        let (index, row, warning) = joined.context("AI 标题生成任务异常退出")??;
        if jobs.is_cancelled(job_id) {
            jobs.log(job_id, "warn", "AI 标题生成已取消");
            return Ok(None);
        }
        processed += 1;
        if let Some(warning) = warning {
            jobs.log(job_id, "warn", &warning);
        }
        if let Some(row) = row {
            jobs.log(job_id, "info", &format!("已生成标题: {}", row.sku));
            rows[index] = Some(row);
            success_count += 1;
        } else {
            failed_count += 1;
        }
        let progress = ((processed * 99) / total).clamp(1, 99) as u8;
        jobs.update(job_id, JobStatus::Running, progress, None);

        if next_index < items.len() && !jobs.is_cancelled(job_id) {
            spawn_title_task(
                &mut pending,
                next_index,
                client,
                request,
                &items[next_index].1,
                retry_limit,
            );
            next_index += 1;
        }
    }

    if success_count == 0 {
        anyhow::bail!("标题生成全部失败，请检查所选模型和 API 配置");
    }

    if failed_count > 0 {
        jobs.log(
            job_id,
            "warn",
            &format!("标题生成完成，成功 {} 条，跳过失败 {} 条", success_count, failed_count),
        );
    }

    Ok(Some(rows.into_iter().flatten().collect()))
}

async fn generate_title_row_with_retry(
    client: OpenAiCompatibleClient,
    model: String,
    pixel_vision_fallback: bool,
    title_template: String,
    image_path: PathBuf,
    retry_limit: usize,
) -> Result<(ContentRow, Option<String>)> {
    let title_sku = image_file_stem(&image_path);
    let title_prompt = render_prompt(&title_template, &title_sku, &[image_path.as_path()]);
    let image_refs = [image_path.as_path()];
    let mut last_error = String::new();
    let mut switch_to_pixel_fallback = false;

    for attempt in 1..=retry_limit {
        match client
            .generate_title_bundle_from_images(&model, &title_prompt, &image_refs)
            .await
        {
            Ok(payload) if !payload.title.trim().is_empty() => {
                return Ok((
                    title_row(title_sku, payload),
                    (attempt > 1).then(|| {
                        format!(
                            "{} 第 {} 次重试后成功",
                            image_file_stem(&image_path),
                            attempt - 1
                        )
                    }),
                ));
            }
            Ok(_) => {
                last_error = "接口返回空标题".to_string();
            }
            Err(error) => {
                last_error = error_chain(&error);
                if pixel_vision_fallback && is_missing_chat_content_error(&error) {
                    switch_to_pixel_fallback = true;
                    break;
                }
            }
        }
        if attempt < retry_limit {
            let delay_ms = title_retry_delay_ms(&title_sku, attempt);
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        }
    }

    if pixel_vision_fallback && (switch_to_pixel_fallback || !last_error.is_empty()) {
        let primary_error = last_error.clone();
        for attempt in 1..=PIXEL_VISION_FALLBACK_RETRY_LIMIT {
            match client
                .generate_title_bundle_from_images(
                    PIXEL_VISION_FALLBACK_MODEL,
                    &title_prompt,
                    &image_refs,
                )
                .await
            {
                Ok(payload) if !payload.title.trim().is_empty() => {
                    return Ok((
                        title_row(title_sku.clone(), payload),
                        Some(format!(
                            "{title_sku} 主模型图片识别失败，已用 {PIXEL_VISION_FALLBACK_MODEL} 图片兜底并保留颜色。原始错误：{primary_error}"
                        )),
                    ));
                }
                Ok(_) => {
                    last_error =
                        format!("{PIXEL_VISION_FALLBACK_MODEL} 图片兜底返回空标题");
                }
                Err(error) => {
                    last_error = format!(
                        "{PIXEL_VISION_FALLBACK_MODEL} 图片兜底失败：{}",
                        error_chain(&error)
                    );
                }
            }
            if attempt < PIXEL_VISION_FALLBACK_RETRY_LIMIT {
                let delay_ms = title_retry_delay_ms(&title_sku, attempt);
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            }
        }
        last_error = format!("{primary_error}；{last_error}");
    }

    let fallback_prompt = format!(
        "{title_prompt}\n\n注意：图片识别接口多次失败，请根据货号和图片文件名尽量生成一个可用商品标题，只输出标题。"
    );
    match client
        .generate_title_bundle_from_text(&model, &fallback_prompt)
        .await
    {
        Ok(mut payload) if !payload.title.trim().is_empty() => {
            payload.product_color.clear();
            payload.color_name.clear();
            Ok((
                title_row(title_sku.clone(), payload),
                Some(format!(
                    "{title_sku} 图片识别失败，已用文本兜底生成标题。颜色列留空。原始错误：{last_error}"
                )),
            ))
        }
        Ok(_) => Err(anyhow::anyhow!(
            "AI 标题生成失败: {title_sku}: 图片识别重试失败：{last_error}；文本兜底返回空标题"
        )),
        Err(error) => Err(anyhow::anyhow!(
            "AI 标题生成失败: {title_sku}: 图片识别重试失败：{last_error}；文本兜底失败：{}",
            error_chain(&error)
        )),
    }
}

fn spawn_title_task(
    pending: &mut JoinSet<Result<(usize, Option<ContentRow>, Option<String>)>>,
    index: usize,
    client: &OpenAiCompatibleClient,
    request: &MaterialsRequest,
    image_path: &Path,
    retry_limit: usize,
) {
    let client = client.clone();
    let model = request.text_model.clone();
    let pixel_vision_fallback = is_pixel_provider(&request.text_provider)
        && !model.eq_ignore_ascii_case(PIXEL_VISION_FALLBACK_MODEL);
    let title_template = request.title_prompt_template.clone();
    let image_path = image_path.to_path_buf();
    pending.spawn(async move {
        match generate_title_row_with_retry(
            client,
            model,
            pixel_vision_fallback,
            title_template,
            image_path,
            retry_limit,
        )
        .await
        {
            Ok((row, warning)) => Ok::<_, anyhow::Error>((index, Some(row), warning)),
            Err(error) => Ok::<_, anyhow::Error>((index, None, Some(error_chain(&error)))),
        }
    });
}

fn title_concurrency_limit(request: &MaterialsRequest) -> usize {
    if is_ollama_provider(&request.text_provider) {
        std::thread::available_parallelism()
            .map(|parallelism| parallelism.get().min(OLLAMA_TITLE_CONCURRENCY_LIMIT))
            .unwrap_or(OLLAMA_TITLE_CONCURRENCY_LIMIT)
            .max(2)
    } else if is_pixel_provider(&request.text_provider) {
        PIXEL_TITLE_CONCURRENCY_LIMIT
    } else {
        TITLE_CONCURRENCY_LIMIT
    }
}

fn title_retry_delay_ms(sku: &str, attempt: usize) -> u64 {
    let jitter = sku.bytes().fold(0u64, |sum, byte| sum + byte as u64) % 700;
    TITLE_RETRY_BASE_DELAY_MS * 2u64.pow(attempt.saturating_sub(1) as u32) + jitter
}

fn title_retry_limit(request: &MaterialsRequest) -> usize {
    if is_ollama_provider(&request.text_provider) {
        OLLAMA_TITLE_RETRY_LIMIT
    } else if is_pixel_provider(&request.text_provider) {
        PIXEL_TITLE_RETRY_LIMIT
    } else {
        TITLE_RETRY_LIMIT
    }
}

async fn local_scene_inner(
    jobs: &JobRegistry,
    job_id: &str,
    request: LocalSceneRequest,
) -> Result<()> {
    jobs.update(job_id, JobStatus::Running, 1, None);
    let source_root = PathBuf::from(&request.source_root);
    let output_root = PathBuf::from(&request.output_root);
    if !source_root.is_dir() {
        anyhow::bail!("源目录不存在: {}", source_root.display());
    }
    let mut items = collect_sku_images(&source_root)?;
    if let Some(max_items) = request.max_items.filter(|value| *value > 0) {
        items.truncate(max_items as usize);
    }
    if items.is_empty() {
        anyhow::bail!("源目录下没有可处理图片");
    }
    let scenes = if request.scene_ids.is_empty() {
        vec!["flat_full".to_string()]
    } else {
        request.scene_ids.clone()
    };
    let mockup_root = request
        .mockup_root
        .as_ref()
        .map(PathBuf::from)
        .filter(|path| path.is_dir());
    let canvas_size = parse_canvas_size(&request.aspect_ratio);
    let total = items.len() * scenes.len();
    let mut done = 0usize;
    for (sku, image_path) in &items {
        if jobs.is_cancelled(job_id) {
            jobs.log(job_id, "warn", "本地场景图任务已取消");
            return Ok(());
        }
        let product = image::open(image_path)
            .with_context(|| format!("无法打开图片 {}", image_path.display()))?;
        for scene_id in &scenes {
            let scene = render_scene(
                &product,
                canvas_size,
                scene_id,
                mockup_root.as_deref(),
                request.size_label.as_deref().unwrap_or(""),
            )?;
            let output = output_root.join(sku).join(format!(
                "{}_{}.png",
                image_path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or("image"),
                scene_id
            ));
            save_png(&scene, &output)?;
            jobs.log(
                job_id,
                "info",
                &format!("已生成场景图: {}", output.display()),
            );
            done += 1;
            let progress = ((done * 100) / total.max(1)).clamp(1, 99) as u8;
            jobs.update(job_id, JobStatus::Running, progress, None);
        }
    }
    jobs.complete_with_output(job_id, Some(request.output_root));
    Ok(())
}

fn create_portrait_variant_with_watermark(
    source_path: &Path,
    destination_path: &Path,
    size: (u32, u32),
    watermark: Option<&RgbaImage>,
) -> Result<()> {
    let original = image::open(source_path)
        .with_context(|| format!("无法打开图片 {}", source_path.display()))?;
    let foreground = original
        .resize(size.0, size.1, FilterType::Triangle)
        .to_rgba8();
    let background = fast_blurred_background(&original, size).to_rgba8();
    let mut canvas = background;
    let x = ((size.0 as i64 - foreground.width() as i64) / 2).max(0) as i64;
    let y = ((size.1 as i64 - foreground.height() as i64) / 2).max(0) as i64;
    imageops::overlay(&mut canvas, &foreground, x, y);
    if let Some(watermark) = watermark {
        apply_watermark(&mut canvas, watermark);
    }
    save_png(&DynamicImage::ImageRgba8(canvas), destination_path)
}

fn render_scene(
    product: &DynamicImage,
    canvas_size: (u32, u32),
    scene_id: &str,
    mockup_root: Option<&Path>,
    size_label: &str,
) -> Result<DynamicImage> {
    let mut canvas = if let Some(mockup) = find_mockup(mockup_root, scene_id) {
        cover_resize(
            &image::open(&mockup).with_context(|| format!("无法打开模板 {}", mockup.display()))?,
            canvas_size,
        )
        .to_rgba8()
    } else {
        white_canvas(canvas_size)
    };
    match scene_id {
        "dual" | "headscarf_side" | "headscarf_back" => {
            paste_fit(
                &mut canvas,
                product,
                rect(canvas_size, 0.05, 0.14, 0.46, 0.84),
                -10.0,
            );
            paste_fit(
                &mut canvas,
                product,
                rect(canvas_size, 0.50, 0.08, 0.95, 0.92),
                5.0,
            );
        }
        "stack" | "bow_and_fold" => {
            paste_fit(
                &mut canvas,
                product,
                rect(canvas_size, 0.08, 0.20, 0.64, 0.82),
                -12.0,
            );
            paste_fit(
                &mut canvas,
                product,
                rect(canvas_size, 0.32, 0.12, 0.94, 0.88),
                7.0,
            );
        }
        "size_chart" => {
            paste_fit(
                &mut canvas,
                product,
                rect(canvas_size, 0.10, 0.08, 0.90, 0.76),
                0.0,
            );
            draw_simple_label(&mut canvas, size_label);
        }
        _ => {
            paste_fit(
                &mut canvas,
                product,
                rect(canvas_size, 0.08, 0.08, 0.92, 0.92),
                0.0,
            );
        }
    }
    Ok(DynamicImage::ImageRgba8(canvas))
}

fn collect_sku_images(root: &Path) -> Result<Vec<(String, PathBuf)>> {
    let mut result = Vec::new();
    for entry in root.read_dir()? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            let sku = entry.file_name().to_string_lossy().to_string();
            for image in list_sku_images(&path)? {
                result.push((sku.clone(), image));
            }
        }
    }
    if result.is_empty() {
        for image in list_sku_images(root)? {
            let sku = image
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("sku")
                .to_string();
            result.push((sku, image));
        }
    }
    result.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    Ok(result)
}

fn text_provider_key(request: &MaterialsRequest) -> Result<String> {
    if is_ollama_provider(&request.text_provider) {
        return Ok(String::new());
    }
    match secrets::get_secret(&secrets::provider_api_key_id(
        "text",
        &request.text_provider,
    )) {
        Ok(key) => Ok(key),
        Err(error) if request.text_provider == request.image_provider => secrets::get_secret(
            &secrets::provider_api_key_id("image", &request.image_provider),
        )
        .or(Err(error)),
        Err(error) => Err(error),
    }
}

fn cover_resize(image: &DynamicImage, size: (u32, u32)) -> DynamicImage {
    let (target_w, target_h) = size;
    let (w, h) = image.dimensions();
    let scale = (target_w as f32 / w as f32).max(target_h as f32 / h as f32);
    let resized_w = (w as f32 * scale).ceil() as u32;
    let resized_h = (h as f32 * scale).ceil() as u32;
    let resized = image.resize(resized_w, resized_h, FilterType::Triangle);
    let x = resized_w.saturating_sub(target_w) / 2;
    let y = resized_h.saturating_sub(target_h) / 2;
    resized.crop_imm(x, y, target_w, target_h)
}

fn fast_blurred_background(image: &DynamicImage, size: (u32, u32)) -> DynamicImage {
    let small = (size.0 / 4, size.1 / 4);
    cover_resize(image, small)
        .blur(6.0)
        .grayscale()
        .resize_exact(size.0, size.1, FilterType::Triangle)
}

fn paste_fit(
    canvas: &mut RgbaImage,
    product: &DynamicImage,
    area: (u32, u32, u32, u32),
    rotate_deg: f32,
) {
    let (x0, y0, x1, y1) = area;
    let max_w = x1.saturating_sub(x0).max(1);
    let max_h = y1.saturating_sub(y0).max(1);
    let mut layer = product.resize(max_w, max_h, FilterType::Lanczos3);
    if rotate_deg.abs() > f32::EPSILON {
        layer = rotate_nearest_90(layer, rotate_deg);
    }
    let rgba = layer.to_rgba8();
    let x = x0 as i64 + ((max_w as i64 - rgba.width() as i64) / 2).max(0);
    let y = y0 as i64 + ((max_h as i64 - rgba.height() as i64) / 2).max(0);
    imageops::overlay(canvas, &rgba, x, y);
}

fn rotate_nearest_90(image: DynamicImage, rotate_deg: f32) -> DynamicImage {
    if rotate_deg > 45.0 {
        image.rotate90()
    } else if rotate_deg < -45.0 {
        image.rotate270()
    } else {
        image
    }
}

fn load_watermark(watermark_path: &Path, canvas_size: (u32, u32)) -> Result<RgbaImage> {
    let watermark = image::open(watermark_path)
        .with_context(|| format!("无法打开水印 {}", watermark_path.display()))?
        .to_rgba8();
    let max_width = (canvas_size.0 as f32 * 0.18).max(1.0) as u32;
    let watermark = if watermark.width() > max_width {
        let ratio = max_width as f32 / watermark.width() as f32;
        imageops::resize(
            &watermark,
            max_width,
            (watermark.height() as f32 * ratio).max(1.0) as u32,
            FilterType::Triangle,
        )
    } else {
        watermark
    };
    Ok(watermark)
}

fn apply_watermark(canvas: &mut RgbaImage, watermark: &RgbaImage) {
    let margin = 36u32;
    let x = canvas
        .width()
        .saturating_sub(watermark.width())
        .saturating_sub(margin) as i64;
    let y = canvas
        .height()
        .saturating_sub(watermark.height())
        .saturating_sub(margin) as i64;
    imageops::overlay(canvas, watermark, x, y);
}

fn white_canvas(size: (u32, u32)) -> RgbaImage {
    ImageBuffer::from_pixel(size.0, size.1, Rgba([255, 255, 255, 255]))
}

fn rect(size: (u32, u32), x0: f32, y0: f32, x1: f32, y1: f32) -> (u32, u32, u32, u32) {
    (
        (size.0 as f32 * x0) as u32,
        (size.1 as f32 * y0) as u32,
        (size.0 as f32 * x1) as u32,
        (size.1 as f32 * y1) as u32,
    )
}

fn draw_simple_label(canvas: &mut RgbaImage, label: &str) {
    if label.trim().is_empty() {
        return;
    }
    let y = (canvas.height() as f32 * 0.84) as u32;
    let x0 = (canvas.width() as f32 * 0.16) as u32;
    let x1 = (canvas.width() as f32 * 0.84) as u32;
    for x in x0..x1 {
        for dy in 0..3 {
            if y + dy < canvas.height() {
                canvas.put_pixel(x, y + dy, Rgba([60, 70, 82, 255]));
            }
        }
    }
}

fn find_mockup(mockup_root: Option<&Path>, scene_id: &str) -> Option<PathBuf> {
    let root = mockup_root?;
    [
        root.join(format!("{scene_id}.jpg")),
        root.join(format!("{scene_id}.png")),
        root.join(format!("{scene_id}.jpeg")),
        root.join(format!("{scene_id}.webp")),
        root.join(scene_id).join("base.jpg"),
        root.join(scene_id).join("base.png"),
        root.join(scene_id).join("mockup.jpg"),
        root.join(scene_id).join("mockup.png"),
        root.join(scene_id).join("left.jpg"),
        root.join(scene_id).join("left.png"),
        root.join("_default.jpg"),
        root.join("_default.png"),
    ]
    .into_iter()
    .find(|path| path.is_file())
}

fn parse_canvas_size(aspect_ratio: &str) -> (u32, u32) {
    match aspect_ratio.trim().replace('：', ":").as_str() {
        "1:1" => (1200, 1200),
        "4:3" => (1600, 1200),
        "16:9" => (1600, 900),
        "2:3" => (1200, 1800),
        "9:16" => (1080, 1920),
        _ => DEFAULT_PORTRAIT_SIZE,
    }
}

fn save_png(image: &DynamicImage, path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let rgba = image.to_rgba8();
    let file =
        std::fs::File::create(path).with_context(|| format!("无法写入图片 {}", path.display()))?;
    let writer = std::io::BufWriter::new(file);
    PngEncoder::new_with_quality(writer, CompressionType::Fast, PngFilterType::NoFilter)
        .write_image(
            rgba.as_raw(),
            rgba.width(),
            rgba.height(),
            ExtendedColorType::Rgba8,
        )?;
    Ok(())
}

fn write_copy_stub(content_root: Option<&str>, sku: &str) -> Result<()> {
    let Some(content_root) = content_root.filter(|value| !value.trim().is_empty()) else {
        return Ok(());
    };
    let dir = PathBuf::from(content_root).join(sku);
    std::fs::create_dir_all(&dir)?;
    let json = serde_json::json!({
        "sku": sku,
        "title": "",
        "description": "",
        "bullets": []
    });
    std::fs::write(
        dir.join(format!("{sku}_content.json")),
        serde_json::to_string_pretty(&json)?,
    )?;
    std::fs::write(
        dir.join(format!("{sku}_content.txt")),
        "标题：\n\n描述：\n\n卖点：\n",
    )?;
    Ok(())
}

fn write_copy_files(content_root: Option<&str>, sku: &str, payload: &CopyPayload) -> Result<()> {
    let Some(content_root) = content_root.filter(|value| !value.trim().is_empty()) else {
        anyhow::bail!("文案输出目录不能为空");
    };
    let dir = PathBuf::from(content_root).join(sku);
    std::fs::create_dir_all(&dir)?;
    let json = serde_json::json!({
        "sku": sku,
        "title": payload.title,
        "description": payload.description,
        "bullets": payload.bullets
    });
    std::fs::write(
        dir.join(format!("{sku}_content.json")),
        serde_json::to_string_pretty(&json)?,
    )?;
    let mut lines = vec![
        format!("标题：{}", payload.title),
        String::new(),
        "描述：".into(),
        payload.description.clone(),
        String::new(),
        "卖点：".into(),
    ];
    for (index, bullet) in payload.bullets.iter().enumerate() {
        lines.push(format!("{}. {}", index + 1, bullet));
    }
    std::fs::write(dir.join(format!("{sku}_content.txt")), lines.join("\n"))?;
    Ok(())
}

fn write_title_excel(content_root: Option<&str>, rows: &[ContentRow]) -> Result<PathBuf> {
    let Some(content_root) = content_root.filter(|value| !value.trim().is_empty()) else {
        anyhow::bail!("标题输出目录不能为空");
    };
    if rows.is_empty() {
        anyhow::bail!("没有生成任何标题，无法写入 Excel");
    }
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let output = PathBuf::from(content_root).join(format!("ozon_titles_{timestamp}.xlsx"));
    excel::write_upload_rows(&output, rows)?;
    Ok(output)
}

fn image_file_stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("sku")
        .to_string()
}

fn title_row(sku: String, payload: TitlePayload) -> ContentRow {
    ContentRow {
        sku,
        title: payload.title.trim().to_string(),
        product_color: payload.product_color.trim().to_string(),
        color_name: payload.color_name.trim().to_string(),
        description: String::new(),
        rich_json: String::new(),
    }
}

fn error_chain(error: &anyhow::Error) -> String {
    error
        .chain()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(": ")
}

fn render_prompt(template: &str, sku: &str, images: &[&Path]) -> String {
    let image_names = images
        .iter()
        .filter_map(|path| path.file_name().and_then(|s| s.to_str()))
        .collect::<Vec<_>>()
        .join(", ");
    template
        .replace("{sku}", sku)
        .replace("{folder_name}", sku)
        .replace("{image_count}", &images.len().to_string())
        .replace("{image_names}", &image_names)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_canvas_sizes() {
        assert_eq!(parse_canvas_size("1:1"), (1200, 1200));
        assert_eq!(parse_canvas_size("3:4"), (1200, 1600));
    }

    #[test]
    fn no_mockup_without_root() {
        assert!(find_mockup(None, "flat_full").is_none());
    }

    #[test]
    fn title_retry_delay_uses_backoff_and_sku_jitter() {
        let first = title_retry_delay_ms("SKU-A", 1);
        let second = title_retry_delay_ms("SKU-A", 2);
        assert!((TITLE_RETRY_BASE_DELAY_MS..TITLE_RETRY_BASE_DELAY_MS + 700).contains(&first));
        assert_eq!(second - first, TITLE_RETRY_BASE_DELAY_MS);
        assert_ne!(first, title_retry_delay_ms("SKU-B", 1));
    }
}
